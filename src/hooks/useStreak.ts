import { useState, useCallback, useEffect, useRef } from 'react';
import type { StreakData } from '../types';
import { getLocalDateString, computeStreakState } from '../utils/streak';
import {
  loadLocalStreak,
  loadFromFirestore,
  createDebouncedSave,
} from '../services/streak-persistence';

const MAX_COMPLETION_DATES = 90;

export function useStreak(userId: string | null) {
  const [streakData, setStreakData] = useState<StreakData>({
    currentStreak: 0,
    longestStreak: 0,
    completionDates: [],
    freezesUsedThisWeek: 0,
    freezeWeekStart: '',
    lastCompletionDate: null,
  });
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loadedUserRef = useRef<string | null>(null);
  const saverRef = useRef<{ save: (data: StreakData) => void; cleanup: () => void } | null>(null);

  // Create/replace debounced saver when userId changes
  useEffect(() => {
    if (saverRef.current) saverRef.current.cleanup();
    if (!userId) {
      saverRef.current = null;
      return;
    }
    saverRef.current = createDebouncedSave(
      userId,
      () => setSaveError(null),
      (msg) => setSaveError(msg),
    );
    return () => {
      if (saverRef.current) saverRef.current.cleanup();
    };
  }, [userId]);

  const saveToFirestore = useCallback((data: StreakData) => {
    saverRef.current?.save(data);
  }, []);

  // Load from Firestore when userId becomes available
  useEffect(() => {
    if (!userId || loadedUserRef.current === userId) return;

    const signal = { cancelled: false };

    async function load() {
      let data: StreakData;
      try {
        data = await loadFromFirestore(userId!);
      } catch {
        data = loadLocalStreak();
      }
      if (!signal.cancelled) {
        setStreakData(data);
        loadedUserRef.current = userId;
        setLoaded(true);
      }
    }

    load();
    return () => { signal.cancelled = true; };
  }, [userId]);

  // Compute derived state on every render
  const today = getLocalDateString();
  const state = computeStreakState(
    streakData.completionDates,
    streakData.longestStreak,
    today,
  );

  const recordCompletion = useCallback(() => {
    const todayStr = getLocalDateString();

    setStreakData(prev => {
      // Idempotent: no-op if today already recorded
      if (prev.completionDates.includes(todayStr)) return prev;

      const updatedDates = [...prev.completionDates, todayStr]
        .slice(-MAX_COMPLETION_DATES); // trim to last 90

      const newState = computeStreakState(updatedDates, prev.longestStreak, todayStr);

      const next: StreakData = {
        currentStreak: newState.currentStreak,
        longestStreak: newState.longestStreak,
        completionDates: updatedDates,
        freezesUsedThisWeek: newState.freezesUsedThisWeek,
        freezeWeekStart: newState.freezeWeekStart,
        lastCompletionDate: todayStr,
      };

      saveToFirestore(next);
      return next;
    });
  }, [saveToFirestore]);

  return {
    currentStreak: state.currentStreak,
    longestStreak: state.longestStreak,
    completedToday: state.completedToday,
    freezesRemaining: 2 - state.freezesUsedThisWeek,
    recordCompletion,
    loaded,
    saveError,
  };
}
