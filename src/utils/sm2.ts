import type { SRSCard, SRSRating, DictionaryEntry } from '../types';
import { normalizeRussianWord, cleanWord } from './russian';

// Delegate to shared normalizeRussianWord for card ID deduplication.
export function normalizeCardId(word: string): string {
  return normalizeRussianWord(word);
}

export function createCard(word: string, translation: string, sourceLanguage: string, dictionary?: DictionaryEntry): SRSCard {
  const cleaned = cleanWord(word);
  return {
    id: normalizeCardId(word),
    word: cleaned,
    translation,
    sourceLanguage,
    dictionary,
    easeFactor: 2.5,
    interval: 0,
    repetition: 0,
    nextReviewDate: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    lastReviewedAt: null,
  };
}

function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// Anki-like SM2 with learning steps.
//
// Learning phase (repetition === 0): short intervals, not yet graduated.
//   Again → 1 min,  Hard → 5 min,  Good → graduate (1 day),  Easy → graduate (5 days)
//
// Review phase (repetition > 0): day-based intervals that grow with easeFactor.
//   Again → lapse back to learning (1 min)
//   Hard  → interval * 1.2
//   Good  → interval * easeFactor
//   Easy  → interval * easeFactor * 1.3
export function sm2(card: SRSCard, rating: SRSRating): SRSCard {
  let { easeFactor, interval, repetition } = card;

  const now = new Date().toISOString();
  let nextReviewDate: string;

  if (repetition === 0) {
    // Learning phase — EF stays unchanged (only scheduling changes)
    switch (rating) {
      case 0: // Again — 1 minute
        nextReviewDate = addMinutes(1);
        interval = 0;
        break;
      case 2: // Hard — 5 minutes
        nextReviewDate = addMinutes(5);
        interval = 0;
        break;
      case 4: // Good — graduate, 1 day
        repetition = 1;
        interval = 1;
        nextReviewDate = addDays(1);
        break;
      case 5: // Easy — graduate, 5 days
        repetition = 1;
        interval = 5;
        nextReviewDate = addDays(5);
        break;
    }
  } else {
    // Review phase — update ease factor (never below 1.3)
    easeFactor = easeFactor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02));
    if (easeFactor < 1.3) easeFactor = 1.3;

    switch (rating) {
      case 0: // Again — lapse back to learning
        repetition = 0;
        interval = 0;
        nextReviewDate = addMinutes(1);
        break;
      case 2: // Hard — small increase
        interval = Math.max(Math.round(interval * 1.2), interval + 1);
        repetition += 1;
        nextReviewDate = addDays(interval);
        break;
      case 4: // Good — normal increase
        interval = Math.max(Math.round(interval * easeFactor), interval + 1);
        repetition += 1;
        nextReviewDate = addDays(interval);
        break;
      case 5: // Easy — large increase
        interval = Math.max(Math.round(interval * easeFactor * 1.3), interval + 1);
        repetition += 1;
        nextReviewDate = addDays(interval);
        break;
    }
  }

  return {
    ...card,
    easeFactor,
    interval,
    repetition,
    nextReviewDate,
    lastReviewedAt: now,
  };
}

// Return cards due for review (nextReviewDate <= now), sorted oldest-first.
export function getDueCards(cards: SRSCard[]): SRSCard[] {
  const now = new Date().toISOString();
  return cards
    .filter(c => c.nextReviewDate <= now)
    .sort((a, b) => a.nextReviewDate.localeCompare(b.nextReviewDate));
}

// Preview the interval for a given rating (for button labels).
export interface IntervalPreview {
  value: number;
  unit: 'min' | 'day';
}

export function previewInterval(card: SRSCard, rating: SRSRating): IntervalPreview {
  if (card.repetition === 0) {
    // Learning phase — fixed steps
    switch (rating) {
      case 0: return { value: 1, unit: 'min' };
      case 2: return { value: 5, unit: 'min' };
      case 4: return { value: 1, unit: 'day' };
      case 5: return { value: 5, unit: 'day' };
    }
  }
  // Review phase — compute from SM2
  if (rating === 0) return { value: 1, unit: 'min' }; // lapse
  const updated = sm2(card, rating);
  return { value: updated.interval, unit: 'day' };
}
