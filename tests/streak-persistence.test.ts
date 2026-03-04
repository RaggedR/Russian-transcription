import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreakData } from '../src/types';

// Mock Firebase modules
const mockGetDoc = vi.fn();
const mockSetDoc = vi.fn();
const mockDoc = vi.fn(() => 'mock-ref');
const mockServerTimestamp = vi.fn(() => 'mock-timestamp');

vi.mock('firebase/firestore', () => ({
  doc: (...args: unknown[]) => mockDoc(...args),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  serverTimestamp: () => mockServerTimestamp(),
}));

vi.mock('../src/firebase-db', () => ({
  db: 'mock-db',
}));

// Mock Sentry
vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

import {
  loadLocalStreak,
  saveLocalBackup,
  loadFromFirestore,
  createDebouncedSave,
} from '../src/services/streak-persistence';

const STREAK_KEY = 'streak_data';

describe('loadLocalStreak', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('returns default streak when nothing stored', () => {
    const result = loadLocalStreak();
    expect(result.currentStreak).toBe(0);
    expect(result.completionDates).toEqual([]);
  });

  it('parses stored streak data', () => {
    const data: StreakData = {
      currentStreak: 5,
      longestStreak: 10,
      completionDates: ['2026-03-01', '2026-03-02'],
      freezesUsedThisWeek: 1,
      freezeWeekStart: '2026-02-23',
      lastCompletionDate: '2026-03-02',
    };
    localStorageMock.setItem(STREAK_KEY, JSON.stringify(data));
    const result = loadLocalStreak();
    expect(result.currentStreak).toBe(5);
    expect(result.completionDates).toEqual(['2026-03-01', '2026-03-02']);
  });

  it('returns default on corrupt data', () => {
    localStorageMock.setItem(STREAK_KEY, 'not-json');
    const result = loadLocalStreak();
    expect(result.currentStreak).toBe(0);
  });
});

describe('saveLocalBackup', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('saves streak data to localStorage', () => {
    const data: StreakData = {
      currentStreak: 3,
      longestStreak: 3,
      completionDates: ['2026-03-01'],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '2026-02-23',
      lastCompletionDate: '2026-03-01',
    };
    saveLocalBackup(data);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      STREAK_KEY,
      JSON.stringify(data),
    );
  });
});

describe('loadFromFirestore', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('loads existing data from Firestore', async () => {
    const firestoreData = {
      currentStreak: 7,
      longestStreak: 14,
      completionDates: ['2026-03-01', '2026-03-02'],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '2026-02-23',
      lastCompletionDate: '2026-03-02',
    };
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => firestoreData,
    });

    const result = await loadFromFirestore('user-123');
    expect(result.currentStreak).toBe(7);
    expect(result.completionDates).toEqual(['2026-03-01', '2026-03-02']);
  });

  it('migrates localStorage data when Firestore is empty', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => false,
      data: () => null,
    });

    const localData: StreakData = {
      currentStreak: 3,
      longestStreak: 5,
      completionDates: ['2026-03-01'],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '2026-02-23',
      lastCompletionDate: '2026-03-01',
    };
    localStorageMock.setItem(STREAK_KEY, JSON.stringify(localData));

    const result = await loadFromFirestore('user-123');
    expect(result.completionDates).toEqual(['2026-03-01']);
    expect(mockSetDoc).toHaveBeenCalled();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(STREAK_KEY);
  });

  it('returns default when both Firestore and localStorage are empty', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => false,
      data: () => null,
    });

    const result = await loadFromFirestore('user-123');
    expect(result.currentStreak).toBe(0);
    expect(result.completionDates).toEqual([]);
  });
});

describe('createDebouncedSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces saves by 500ms', async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    mockSetDoc.mockResolvedValue(undefined);

    const { save, cleanup } = createDebouncedSave('user-123', onSuccess, onError);

    const data: StreakData = {
      currentStreak: 1,
      longestStreak: 1,
      completionDates: ['2026-03-03'],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '2026-03-02',
      lastCompletionDate: '2026-03-03',
    };

    save(data);
    expect(mockSetDoc).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(mockSetDoc).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('only saves the latest data when called multiple times', async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    mockSetDoc.mockResolvedValue(undefined);

    const { save, cleanup } = createDebouncedSave('user-123', onSuccess, onError);

    const data1: StreakData = {
      currentStreak: 1, longestStreak: 1, completionDates: ['2026-03-01'],
      freezesUsedThisWeek: 0, freezeWeekStart: '2026-02-23', lastCompletionDate: '2026-03-01',
    };
    const data2: StreakData = {
      currentStreak: 2, longestStreak: 2, completionDates: ['2026-03-01', '2026-03-02'],
      freezesUsedThisWeek: 0, freezeWeekStart: '2026-02-23', lastCompletionDate: '2026-03-02',
    };

    save(data1);
    save(data2); // should cancel first

    await vi.advanceTimersByTimeAsync(500);
    expect(mockSetDoc).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('cleans up pending timer', () => {
    const { save, cleanup } = createDebouncedSave('user-123', vi.fn(), vi.fn());

    save({
      currentStreak: 1, longestStreak: 1, completionDates: [],
      freezesUsedThisWeek: 0, freezeWeekStart: '', lastCompletionDate: null,
    });

    cleanup();
    // If cleanup works, no Firestore call should happen
    vi.advanceTimersByTime(1000);
    expect(mockSetDoc).not.toHaveBeenCalled();
  });
});
