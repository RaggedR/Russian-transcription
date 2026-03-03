/**
 * Streak persistence layer.
 *
 * Handles Firestore load/save + localStorage fallback.
 * Follows the same pattern as deck-persistence.ts.
 */
import * as Sentry from '@sentry/react';
import type { StreakData } from '../types';

const STREAK_KEY = 'streak_data';
const DEBOUNCE_MS = 500;

const DEFAULT_STREAK: StreakData = {
  currentStreak: 0,
  longestStreak: 0,
  completionDates: [],
  freezesUsedThisWeek: 0,
  freezeWeekStart: '',
  lastCompletionDate: null,
};

async function getFirestoreHelpers() {
  const [firestoreModule, { db }] = await Promise.all([
    import('firebase/firestore'),
    import('../firebase-db'),
  ]);
  return {
    doc: firestoreModule.doc,
    getDoc: firestoreModule.getDoc,
    setDoc: firestoreModule.setDoc,
    serverTimestamp: firestoreModule.serverTimestamp,
    db,
  };
}

/** Load streak from localStorage (best-effort, ignores corrupt data). */
export function loadLocalStreak(): StreakData {
  try {
    const saved = localStorage.getItem(STREAK_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // Ignore corrupt data
  }
  return { ...DEFAULT_STREAK };
}

/** Save streak to localStorage as a backup. */
export function saveLocalBackup(data: StreakData): void {
  try {
    localStorage.setItem(STREAK_KEY, JSON.stringify(data));
  } catch (err) {
    Sentry.captureException(err, { tags: { operation: 'streak_local_backup' } });
  }
}

/**
 * Load streak from Firestore. If Firestore is empty, migrates localStorage data.
 * Falls back to localStorage if Firestore is unavailable.
 */
export async function loadFromFirestore(userId: string): Promise<StreakData> {
  const { doc, getDoc, setDoc, serverTimestamp, db } = await getFirestoreHelpers();
  const streakRef = doc(db, 'streaks', userId);
  const snap = await getDoc(streakRef);

  if (snap.exists()) {
    const data = snap.data();
    return {
      currentStreak: data.currentStreak ?? 0,
      longestStreak: data.longestStreak ?? 0,
      completionDates: data.completionDates ?? [],
      freezesUsedThisWeek: data.freezesUsedThisWeek ?? 0,
      freezeWeekStart: data.freezeWeekStart ?? '',
      lastCompletionDate: data.lastCompletionDate ?? null,
    };
  }

  // Firestore empty — check localStorage for migration
  const local = loadLocalStreak();
  if (local.completionDates.length > 0) {
    await setDoc(streakRef, { ...local, updatedAt: serverTimestamp() });
    localStorage.removeItem(STREAK_KEY);
    return local;
  }

  return { ...DEFAULT_STREAK };
}

/**
 * Create a debounced Firestore saver for streak data.
 * Returns `{ save, cleanup }` — call `save(data)` after each mutation,
 * and `cleanup()` on unmount to clear the pending timer.
 */
export function createDebouncedSave(
  userId: string,
  onSuccess: () => void,
  onError: (msg: string) => void,
): { save: (data: StreakData) => void; cleanup: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function save(data: StreakData) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const { doc, setDoc, serverTimestamp, db } = await getFirestoreHelpers();
        const streakRef = doc(db, 'streaks', userId);
        await setDoc(streakRef, { ...data, updatedAt: serverTimestamp() });
        onSuccess();
      } catch (err) {
        console.error('[streak-persistence] Firestore save failed:', err);
        Sentry.captureException(err, { tags: { operation: 'streak_save' } });
        onError('Streak data may not be saved — check your connection');
        saveLocalBackup(data);
      }
    }, DEBOUNCE_MS);
  }

  function cleanup() {
    if (timer) clearTimeout(timer);
  }

  return { save, cleanup };
}
