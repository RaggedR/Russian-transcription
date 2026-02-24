import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { SRSCard, SRSRating, DictionaryEntry } from '../types';
import { createCard, sm2, getDueCards as getDueCardsFromAll, normalizeCardId } from '../utils/sm2';
import { loadLocalDeck, loadFromFirestore, createDebouncedSave } from '../services/deck-persistence';
import {
  enrichMissingDictionary,
  enrichMissingExamples,
  enrichSingleCardExample,
} from '../services/deck-enrichment';

export function useDeck(userId: string | null) {
  const [cards, setCards] = useState<SRSCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Track whether we've done the initial Firestore load for this userId
  const loadedUserRef = useRef<string | null>(null);
  // Debounced saver ref — recreated when userId changes
  const saverRef = useRef<{ save: (cards: SRSCard[]) => void; cleanup: () => void } | null>(null);

  const clearSaveError = useCallback(() => setSaveError(null), []);

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

  // Persist cards to Firestore (debounced) — stable reference via ref
  const saveToFirestore = useCallback((nextCards: SRSCard[]) => {
    saverRef.current?.save(nextCards);
  }, []);

  // Load from Firestore when userId becomes available
  useEffect(() => {
    if (!userId || loadedUserRef.current === userId) return;

    const signal = { cancelled: false };

    async function load() {
      let loadedCards: SRSCard[] = [];
      try {
        loadedCards = await loadFromFirestore(userId!);
        if (signal.cancelled) return;
        if (loadedCards.length > 0) {
          setCards(loadedCards);
        }
      } catch {
        // Firestore unavailable — fall back to localStorage
        if (!signal.cancelled) {
          loadedCards = loadLocalDeck();
          setCards(loadedCards);
        }
      }
      if (!signal.cancelled) {
        loadedUserRef.current = userId;
        setLoaded(true);
        // Enrich cards: (1) free dictionary lookup, then (2) GPT example generation
        const afterDict = await enrichMissingDictionary(loadedCards, signal);
        if (signal.cancelled) return;
        if (afterDict !== loadedCards) {
          setCards(afterDict);
          saveToFirestore(afterDict);
        }
        const afterExamples = await enrichMissingExamples(afterDict, signal);
        if (signal.cancelled) return;
        if (afterExamples !== afterDict) {
          setCards(afterExamples);
          saveToFirestore(afterExamples);
        }
      }
    }

    load();
    return () => { signal.cancelled = true; };
  }, [userId, saveToFirestore]);

  const dueCards = useMemo(() => getDueCardsFromAll(cards), [cards]);
  const dueCount = dueCards.length;

  const addCard = useCallback(async (word: string, translation: string, sourceLanguage: string, dictionary?: DictionaryEntry): Promise<void> => {
    const id = normalizeCardId(word);

    // Enrich BEFORE adding — await the API call so the card enters state with an example
    let enrichedDictionary = dictionary;
    if (!dictionary?.example) {
      try {
        const result = await enrichSingleCardExample(word, dictionary, translation);
        if (result) enrichedDictionary = result;
      } catch {
        // Graceful degradation — add card without example
      }
    }

    setCards(prev => {
      if (prev.some(c => c.id === id)) return prev; // duplicate
      const newCard = createCard(word, translation, sourceLanguage, enrichedDictionary);
      const next = [...prev, newCard];
      saveToFirestore(next);
      return next;
    });
  }, [saveToFirestore]);

  const removeCard = useCallback((id: string) => {
    setCards(prev => {
      const next = prev.filter(c => c.id !== id);
      saveToFirestore(next);
      return next;
    });
  }, [saveToFirestore]);

  const reviewCard = useCallback((id: string, rating: SRSRating) => {
    setCards(prev => {
      const next = prev.map(c => c.id === id ? sm2(c, rating) : c);
      saveToFirestore(next);
      return next;
    });
  }, [saveToFirestore]);

  const isWordInDeck = useCallback((word: string): boolean => {
    const id = normalizeCardId(word);
    return cards.some(c => c.id === id);
  }, [cards]);

  return { cards, dueCards, dueCount, addCard, removeCard, reviewCard, isWordInDeck, loaded, saveError, clearSaveError };
}
