import { describe, it, expect } from 'vitest';
import {
  getLocalDateString,
  previousDay,
  getMondayOfWeek,
  computeStreakState,
} from '../src/utils/streak';

describe('getLocalDateString', () => {
  it('formats a specific date', () => {
    const date = new Date(2026, 2, 3, 15, 0); // March 3, 2026
    expect(getLocalDateString(date)).toBe('2026-03-03');
  });

  it('pads single-digit months and days', () => {
    const date = new Date(2026, 0, 5, 12, 0); // Jan 5, 2026
    expect(getLocalDateString(date)).toBe('2026-01-05');
  });
});

describe('previousDay', () => {
  it('subtracts one day', () => {
    expect(previousDay('2026-03-03')).toBe('2026-03-02');
  });

  it('crosses month boundary', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('crosses year boundary', () => {
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  it('handles leap year', () => {
    expect(previousDay('2024-03-01')).toBe('2024-02-29');
  });
});

describe('getMondayOfWeek', () => {
  it('returns Monday for a Monday', () => {
    // 2026-03-02 is a Monday
    expect(getMondayOfWeek('2026-03-02')).toBe('2026-03-02');
  });

  it('returns Monday for a Wednesday', () => {
    // 2026-03-04 is a Wednesday
    expect(getMondayOfWeek('2026-03-04')).toBe('2026-03-02');
  });

  it('returns Monday for a Sunday', () => {
    // 2026-03-08 is a Sunday
    expect(getMondayOfWeek('2026-03-08')).toBe('2026-03-02');
  });

  it('returns Monday for a Saturday', () => {
    // 2026-03-07 is a Saturday
    expect(getMondayOfWeek('2026-03-07')).toBe('2026-03-02');
  });

  it('crosses month boundary', () => {
    // 2026-03-01 is a Sunday, its Monday is Feb 23
    expect(getMondayOfWeek('2026-03-01')).toBe('2026-02-23');
  });
});

describe('computeStreakState', () => {
  const TODAY = '2026-03-03'; // Tuesday

  it('returns 0 streak with no completion dates', () => {
    const result = computeStreakState([], 0, TODAY);
    expect(result.currentStreak).toBe(0);
    expect(result.completedToday).toBe(false);
    expect(result.freezesUsedThisWeek).toBe(0);
  });

  it('returns 1 streak if only today is completed', () => {
    const result = computeStreakState([TODAY], 0, TODAY);
    expect(result.currentStreak).toBe(1);
    expect(result.completedToday).toBe(true);
  });

  it('counts consecutive days', () => {
    const dates = ['2026-03-01', '2026-03-02', '2026-03-03'];
    const result = computeStreakState(dates, 0, TODAY);
    expect(result.currentStreak).toBe(3);
    expect(result.completedToday).toBe(true);
  });

  it('breaks streak on gap in previous week without freeze', () => {
    // Gap on 2026-02-28 (Saturday) — different week from today (Mon Mar 2)
    // Today is Tue Mar 3, so current week starts Mon Mar 2
    // Feb 28 is Saturday, its Monday is Feb 23 — different week, no freeze
    const dates = ['2026-02-27', '2026-03-01', '2026-03-02', '2026-03-03'];
    const result = computeStreakState(dates, 0, TODAY);
    // Walking back: Mar 2 (yes, streak=1), Mar 1 (yes, streak=2)
    // Feb 28 is NOT in set. Feb 28's Monday = Feb 23 ≠ Mar 2 (current week). No freeze. Stop.
    // Plus today: streak = 3
    expect(result.currentStreak).toBe(3); // Mar 3 + Mar 2 + Mar 1
  });

  it('uses freeze for gap within current week', () => {
    // Today is 2026-03-03 (Tuesday), week starts Mar 2 (Monday)
    // Mar 2 is NOT in dates — gap within current week, consume 1 freeze
    // Mar 1 is Sunday — different week (Feb 23), so stop
    const dates = ['2026-03-03'];
    const result = computeStreakState(dates, 0, TODAY);
    // Walk back: Mar 2 gap, same week (Mar 2), freeze #1. Mar 1 gap, week Feb 23, stop.
    expect(result.currentStreak).toBe(1); // just today
    expect(result.freezesUsedThisWeek).toBe(1);
  });

  it('uses up to 2 freezes within the same week', () => {
    // Today is 2026-03-05 (Thursday), week starts Mar 2
    const thursday = '2026-03-05';
    // No completions on Mar 4 (Wed) or Mar 3 (Tue) — both same week
    // Mar 2 (Mon) is completed
    const dates = ['2026-03-02', '2026-03-05'];
    const result = computeStreakState(dates, 0, thursday);
    // Walk back: Mar 4 gap (same week, freeze #1), Mar 3 gap (same week, freeze #2), Mar 2 (yes, streak=1)
    // Plus today: streak = 2
    expect(result.currentStreak).toBe(2);
    expect(result.freezesUsedThisWeek).toBe(2);
  });

  it('breaks streak when 3 gaps in same week (only 2 freezes)', () => {
    // Today is 2026-03-06 (Friday), week starts Mar 2
    const friday = '2026-03-06';
    // No completions on Mar 5, 4, 3 — 3 gaps in same week, only 2 freezes
    const dates = ['2026-03-02', '2026-03-06'];
    const result = computeStreakState(dates, 0, friday);
    // Walk back: Mar 5 gap (freeze #1), Mar 4 gap (freeze #2), Mar 3 gap (no freeze), stop
    expect(result.currentStreak).toBe(1); // just today
    expect(result.freezesUsedThisWeek).toBe(2);
  });

  it('tracks longest streak', () => {
    const dates = ['2026-03-02', '2026-03-03'];
    const result = computeStreakState(dates, 10, TODAY);
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(10); // stored was higher
  });

  it('updates longest streak when current exceeds stored', () => {
    const dates = ['2026-03-01', '2026-03-02', '2026-03-03'];
    const result = computeStreakState(dates, 2, TODAY);
    expect(result.currentStreak).toBe(3);
    expect(result.longestStreak).toBe(3);
  });

  it('handles today not completed but yesterday was', () => {
    const dates = ['2026-03-02'];
    const result = computeStreakState(dates, 0, TODAY);
    // Walk back: Mar 2 (yes, streak=1), Mar 1 gap (week Feb 23, diff week, stop)
    // Today not completed: streak stays 1
    expect(result.currentStreak).toBe(1);
    expect(result.completedToday).toBe(false);
  });

  it('returns freezeWeekStart as Monday of current week', () => {
    const result = computeStreakState([], 0, TODAY);
    expect(result.freezeWeekStart).toBe('2026-03-02');
  });

  it('handles empty dates with stored longest', () => {
    const result = computeStreakState([], 5, TODAY);
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(5);
  });

  it('does not count duplicates twice', () => {
    const dates = ['2026-03-02', '2026-03-02', '2026-03-03'];
    const result = computeStreakState(dates, 0, TODAY);
    expect(result.currentStreak).toBe(2);
  });
});
