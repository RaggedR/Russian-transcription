/**
 * Deck persistence layer.
 *
 * Handles Firestore load/save + localStorage fallback, extracted from useDeck.ts.
 * Pure IO module — no React state or hooks.
 */
import * as Sentry from '@sentry/react';
import type { SRSCard } from '../types';

const DECK_KEY = 'srs_deck';
const DEBOUNCE_MS = 500;

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

/** Load deck from localStorage (best-effort, ignores corrupt data). */
export function loadLocalDeck(): SRSCard[] {
  try {
    const saved = localStorage.getItem(DECK_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // Ignore corrupt data
  }
  return [];
}

/** Save deck to localStorage as a backup. */
export function saveLocalBackup(cards: SRSCard[]): void {
  try {
    localStorage.setItem(DECK_KEY, JSON.stringify(cards));
  } catch (err) {
    Sentry.captureException(err, { tags: { operation: 'deck_local_backup' } });
  }
}

/**
 * Load deck from Firestore. If Firestore is empty, migrates localStorage data.
 * Falls back to localStorage if Firestore is unavailable.
 */
export async function loadFromFirestore(userId: string): Promise<SRSCard[]> {
  const { doc, getDoc, setDoc, serverTimestamp, db } = await getFirestoreHelpers();
  const deckRef = doc(db, 'decks', userId);
  const snap = await getDoc(deckRef);

  if (snap.exists() && snap.data().cards?.length > 0) {
    return snap.data().cards;
  }

  // Firestore empty — check localStorage for migration
  const local = loadLocalDeck();
  if (local.length > 0) {
    await setDoc(deckRef, { cards: local, updatedAt: serverTimestamp() });
    localStorage.removeItem(DECK_KEY);
    return local;
  }

  return [];
}

/**
 * Create a debounced Firestore saver.
 * Returns `{ save, cleanup }` — call `save(cards)` after each mutation,
 * and `cleanup()` on unmount to clear the pending timer.
 */
export function createDebouncedSave(
  userId: string,
  onSuccess: () => void,
  onError: (msg: string) => void,
): { save: (cards: SRSCard[]) => void; cleanup: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function save(cards: SRSCard[]) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const { doc, setDoc, serverTimestamp, db } = await getFirestoreHelpers();
        const deckRef = doc(db, 'decks', userId);
        await setDoc(deckRef, { cards, updatedAt: serverTimestamp() });
        onSuccess();
      } catch (err) {
        console.error('[deck-persistence] Firestore save failed:', err);
        Sentry.captureException(err, { tags: { operation: 'deck_save' } });
        onError('Deck changes may not be saved — check your connection');
        saveLocalBackup(cards);
      }
    }, DEBOUNCE_MS);
  }

  function cleanup() {
    if (timer) clearTimeout(timer);
  }

  return { save, cleanup };
}
