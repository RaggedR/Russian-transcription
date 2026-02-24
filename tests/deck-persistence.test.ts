import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Firebase mock ──────────────────────────────────────────────
const mockGetDoc = vi.fn();
const mockSetDoc = vi.fn();

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, collection: string, id: string) => ({ path: `${collection}/${id}` })),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  getFirestore: vi.fn(),
}));

vi.mock('../src/firebase-db', () => ({
  db: {},
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/react', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  loadLocalDeck,
  saveLocalBackup,
  loadFromFirestore,
  createDebouncedSave,
} from '../src/services/deck-persistence';
import type { SRSCard } from '../src/types';

// ── Helpers ────────────────────────────────────────────────────
function makeCard(word = 'тест'): SRSCard {
  return {
    id: word,
    word,
    translation: 'test',
    sourceLanguage: 'ru',
    easeFactor: 2.5,
    interval: 0,
    repetition: 0,
    nextReviewDate: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    lastReviewedAt: null,
  };
}

function firestoreSnap(data: object | null) {
  return {
    exists: () => data !== null,
    data: () => data,
  };
}

// localStorage mock
const localStorageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { localStorageStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete localStorageStore[key]; }),
  clear: vi.fn(() => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); }),
  length: 0,
  key: vi.fn(() => null),
};
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
});

// ── loadLocalDeck ──────────────────────────────────────────────
describe('loadLocalDeck', () => {
  it('returns empty array when nothing in localStorage', () => {
    expect(loadLocalDeck()).toEqual([]);
  });

  it('returns parsed cards from localStorage', () => {
    const cards = [makeCard()];
    localStorageStore['srs_deck'] = JSON.stringify(cards);
    expect(loadLocalDeck()).toEqual(cards);
  });

  it('returns empty array on corrupt JSON', () => {
    localStorageStore['srs_deck'] = 'not-valid-json{{{';
    expect(loadLocalDeck()).toEqual([]);
  });
});

// ── saveLocalBackup ────────────────────────────────────────────
describe('saveLocalBackup', () => {
  it('saves cards to localStorage', () => {
    const cards = [makeCard()];
    saveLocalBackup(cards);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('srs_deck', JSON.stringify(cards));
  });

  it('reports to Sentry on localStorage error', () => {
    mockLocalStorage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceeded'); });
    saveLocalBackup([makeCard()]);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { operation: 'deck_local_backup' } }),
    );
  });
});

// ── loadFromFirestore ──────────────────────────────────────────
describe('loadFromFirestore', () => {
  it('returns cards from Firestore when available', async () => {
    const cards = [makeCard()];
    mockGetDoc.mockResolvedValue(firestoreSnap({ cards }));
    const result = await loadFromFirestore('user-1');
    expect(result).toEqual(cards);
  });

  it('migrates localStorage to Firestore when Firestore is empty', async () => {
    const cards = [makeCard()];
    localStorageStore['srs_deck'] = JSON.stringify(cards);
    mockGetDoc.mockResolvedValue(firestoreSnap(null));
    mockSetDoc.mockResolvedValue(undefined);

    const result = await loadFromFirestore('user-1');

    expect(result).toEqual(cards);
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.anything(),
      { cards, updatedAt: 'SERVER_TIMESTAMP' },
    );
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('srs_deck');
  });

  it('returns empty array when both Firestore and localStorage are empty', async () => {
    mockGetDoc.mockResolvedValue(firestoreSnap(null));
    const result = await loadFromFirestore('user-1');
    expect(result).toEqual([]);
  });

  it('returns empty array when Firestore has empty cards array', async () => {
    mockGetDoc.mockResolvedValue(firestoreSnap({ cards: [] }));
    const result = await loadFromFirestore('user-1');
    expect(result).toEqual([]);
  });
});

// ── createDebouncedSave ────────────────────────────────────────
describe('createDebouncedSave', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onSuccess after successful save', async () => {
    vi.useFakeTimers();
    mockSetDoc.mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { save, cleanup } = createDebouncedSave('user-1', onSuccess, onError);
    save([makeCard()]);

    // Advance past debounce
    vi.advanceTimersByTime(600);
    // Wait for the async save to complete
    await vi.runAllTimersAsync();

    expect(mockSetDoc).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    cleanup();
    vi.useRealTimers();
  });

  it('calls onError and saves local backup on Firestore failure', async () => {
    vi.useFakeTimers();
    mockSetDoc.mockRejectedValue(new Error('Firestore down'));
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { save, cleanup } = createDebouncedSave('user-1', onSuccess, onError);
    save([makeCard()]);

    vi.advanceTimersByTime(600);
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledWith('Deck changes may not be saved — check your connection');
    expect(onSuccess).not.toHaveBeenCalled();
    // Should have saved local backup
    expect(mockLocalStorage.setItem).toHaveBeenCalled();

    cleanup();
    vi.useRealTimers();
  });

  it('debounces multiple saves', async () => {
    vi.useFakeTimers();
    mockSetDoc.mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { save, cleanup } = createDebouncedSave('user-1', onSuccess, onError);

    // Rapid-fire saves
    save([makeCard('а')]);
    vi.advanceTimersByTime(100);
    save([makeCard('б')]);
    vi.advanceTimersByTime(100);
    save([makeCard('в')]);

    // Only the last save should fire after debounce
    vi.advanceTimersByTime(600);
    await vi.runAllTimersAsync();

    expect(mockSetDoc).toHaveBeenCalledTimes(1);

    cleanup();
    vi.useRealTimers();
  });

  it('cleanup clears pending timer', async () => {
    vi.useFakeTimers();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { save, cleanup } = createDebouncedSave('user-1', onSuccess, onError);
    save([makeCard()]);

    // Cleanup before debounce fires
    cleanup();
    vi.advanceTimersByTime(600);
    await vi.runAllTimersAsync();

    expect(mockSetDoc).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
