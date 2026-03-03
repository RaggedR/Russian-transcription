import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock streak persistence
const mockLoadFromFirestore = vi.fn();
const mockCreateDebouncedSave = vi.fn();
const mockLoadLocalStreak = vi.fn();

vi.mock('../src/services/streak-persistence', () => ({
  loadFromFirestore: (...args: unknown[]) => mockLoadFromFirestore(...args),
  createDebouncedSave: (...args: unknown[]) => mockCreateDebouncedSave(...args),
  loadLocalStreak: () => mockLoadLocalStreak(),
}));

// Mock streak utils — keep real implementation but allow controlling getLocalDateString
vi.mock('../src/utils/streak', async () => {
  const actual = await vi.importActual('../src/utils/streak');
  return {
    ...actual,
    getLocalDateString: vi.fn(() => '2026-03-03'),
  };
});

import { useStreak } from '../src/hooks/useStreak';

describe('useStreak', () => {
  const mockSave = vi.fn();
  const mockCleanup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateDebouncedSave.mockReturnValue({ save: mockSave, cleanup: mockCleanup });
    mockLoadFromFirestore.mockResolvedValue({
      currentStreak: 0,
      longestStreak: 0,
      completionDates: [],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '',
      lastCompletionDate: null,
    });
    mockLoadLocalStreak.mockReturnValue({
      currentStreak: 0,
      longestStreak: 0,
      completionDates: [],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '',
      lastCompletionDate: null,
    });
  });

  it('initializes with zero streak', () => {
    const { result } = renderHook(() => useStreak(null));
    expect(result.current.currentStreak).toBe(0);
    expect(result.current.completedToday).toBe(false);
    expect(result.current.freezesRemaining).toBe(2);
  });

  it('loads from Firestore when userId is provided', async () => {
    mockLoadFromFirestore.mockResolvedValue({
      currentStreak: 5,
      longestStreak: 10,
      completionDates: ['2026-03-02', '2026-03-03'],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '2026-03-02',
      lastCompletionDate: '2026-03-03',
    });

    const { result } = renderHook(() => useStreak('user-123'));

    // Wait for async load
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });

    expect(result.current.completedToday).toBe(true);
    expect(result.current.loaded).toBe(true);
  });

  it('records completion idempotently', async () => {
    const { result } = renderHook(() => useStreak('user-123'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });

    // Record completion
    act(() => {
      result.current.recordCompletion();
    });

    expect(result.current.completedToday).toBe(true);
    expect(result.current.currentStreak).toBe(1);
    expect(mockSave).toHaveBeenCalledTimes(1);

    // Record again — should be idempotent (no extra save)
    act(() => {
      result.current.recordCompletion();
    });

    expect(mockSave).toHaveBeenCalledTimes(1); // still 1
  });

  it('falls back to localStorage when Firestore fails', async () => {
    mockLoadFromFirestore.mockRejectedValue(new Error('Network error'));
    mockLoadLocalStreak.mockReturnValue({
      currentStreak: 2,
      longestStreak: 5,
      completionDates: ['2026-03-02'],
      freezesUsedThisWeek: 0,
      freezeWeekStart: '2026-03-02',
      lastCompletionDate: '2026-03-02',
    });

    const { result } = renderHook(() => useStreak('user-123'));

    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });

    expect(result.current.loaded).toBe(true);
    // Should have loaded from localStorage — recomputed: Mar 2 only
    expect(result.current.currentStreak).toBe(1);
  });

  it('cleans up saver on unmount', () => {
    const { unmount } = renderHook(() => useStreak('user-123'));
    unmount();
    expect(mockCleanup).toHaveBeenCalled();
  });
});
