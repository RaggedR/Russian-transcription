/**
 * Deck enrichment service.
 *
 * Handles dictionary lookup and example sentence generation for flashcards.
 * Extracted from useDeck.ts and WordPopup.tsx.
 */
import * as Sentry from '@sentry/react';
import type { SRSCard, DictionaryEntry } from '../types';
import { apiRequest } from './api';

/**
 * Batch dictionary lookup for cards missing dictionary data.
 * Returns updated cards array (unchanged cards are returned as-is).
 */
export async function enrichMissingDictionary(
  cards: SRSCard[],
  signal?: { cancelled: boolean },
): Promise<SRSCard[]> {
  const needsEnrichment = cards.filter(c => !c.dictionary);
  if (needsEnrichment.length === 0) return cards;

  try {
    const words = needsEnrichment.map(c => ({ word: c.word }));
    const { entries } = await apiRequest<{ entries: Record<string, DictionaryEntry | null> }>(
      '/api/enrich-deck',
      { method: 'POST', body: JSON.stringify({ words }) },
    );
    if (signal?.cancelled) return cards;

    return cards.map(c => {
      if (!c.dictionary && entries[c.word]) {
        return { ...c, dictionary: entries[c.word]! };
      }
      return c;
    });
  } catch (err) {
    console.warn('[deck-enrichment] Dictionary enrichment failed:', err);
    Sentry.captureException(err, { tags: { operation: 'deck_enrich_dictionary' } });
    return cards;
  }
}

/** Create a minimal DictionaryEntry to hold an example when dictionary lookup failed. */
function createMinimalDictionary(
  word: string,
  translation: string,
  example: { russian: string; english: string },
): DictionaryEntry {
  return { stressedForm: word, pos: '', translations: [translation], example };
}

/**
 * Batch example sentence generation for cards missing examples.
 * Works regardless of whether cards have dictionary data — creates minimal
 * DictionaryEntry to hold the example when dictionary is absent.
 * Batches in chunks of 50 to respect server limits.
 * Returns updated cards array.
 */
export async function enrichMissingExamples(
  cards: SRSCard[],
  signal?: { cancelled: boolean },
): Promise<SRSCard[]> {
  const needsExamples = cards.filter(c => !c.dictionary?.example);
  if (needsExamples.length === 0) return cards;

  try {
    const BATCH_SIZE = 50;
    const allExamples: Record<string, { russian: string; english: string } | null> = {};
    for (let i = 0; i < needsExamples.length; i += BATCH_SIZE) {
      if (signal?.cancelled) return cards;
      const batch = needsExamples.slice(i, i + BATCH_SIZE);
      const words = batch.map(c => c.word);
      const { examples } = await apiRequest<{ examples: Record<string, { russian: string; english: string } | null> }>(
        '/api/generate-examples',
        { method: 'POST', body: JSON.stringify({ words }) },
      );
      Object.assign(allExamples, examples);
    }
    if (signal?.cancelled) return cards;

    // Build a lowercase-keyed lookup so GPT's key casing doesn't matter
    const examplesLower: Record<string, { russian: string; english: string }> = {};
    for (const [k, v] of Object.entries(allExamples)) {
      if (v) examplesLower[k.toLowerCase()] = v;
    }

    return cards.map(c => {
      const example = examplesLower[c.word.toLowerCase()];
      if (!c.dictionary?.example && example) {
        if (c.dictionary) {
          return { ...c, dictionary: { ...c.dictionary, example } };
        }
        return { ...c, dictionary: createMinimalDictionary(c.word, c.translation, example) };
      }
      return c;
    });
  } catch (err) {
    console.warn('[deck-enrichment] Example generation failed:', err);
    Sentry.captureException(err, { tags: { operation: 'deck_enrich_examples' } });
    return cards;
  }
}

/**
 * Generate an example sentence for a single word at card-add time.
 * Returns the enriched dictionary entry, or the original on failure.
 */
export async function enrichSingleCardExample(
  word: string,
  dictionary?: DictionaryEntry,
  translation?: string,
): Promise<DictionaryEntry | undefined> {
  try {
    const { examples } = await apiRequest<{ examples: Record<string, { russian: string; english: string } | null> }>(
      '/api/generate-examples',
      { method: 'POST', body: JSON.stringify({ words: [word] }) },
    );
    // GPT may return keys in different casing than sent — do case-insensitive lookup
    const wordLower = word.toLowerCase();
    const example = examples[word] ?? Object.entries(examples).find(([k]) => k.toLowerCase() === wordLower)?.[1] ?? null;
    if (example) {
      if (dictionary) {
        return { ...dictionary, example };
      }
      return createMinimalDictionary(word, translation ?? '', example);
    }
    return dictionary;
  } catch (err) {
    console.warn('[deck-enrichment] Example generation failed:', word, err);
    Sentry.captureException(err, { tags: { operation: 'deck_enrich_single_example' } });
    return dictionary;
  }
}
