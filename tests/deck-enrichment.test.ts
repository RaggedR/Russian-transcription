import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SRSCard, DictionaryEntry } from '../src/types';

// ── Mocks ─────────────────────────────────────────────────────
const mockApiRequest = vi.fn();
vi.mock('../src/services/api', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/react', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  enrichMissingDictionary,
  enrichMissingExamples,
  enrichSingleCardExample,
} from '../src/services/deck-enrichment';

// ── Helpers ───────────────────────────────────────────────────
function makeCard(overrides: Partial<SRSCard> = {}): SRSCard {
  return {
    id: 'тест',
    word: 'Тест',
    translation: 'test',
    sourceLanguage: 'ru',
    easeFactor: 2.5,
    interval: 0,
    repetition: 0,
    nextReviewDate: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    lastReviewedAt: null,
    ...overrides,
  };
}

describe('enrichMissingDictionary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cards unchanged when all have dictionary data', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const cards = [makeCard({ dictionary: dict })];
    const result = await enrichMissingDictionary(cards);
    expect(result).toBe(cards); // same reference — no enrichment needed
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('enriches cards missing dictionary data', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    mockApiRequest.mockResolvedValue({ entries: { 'Тест': dict } });

    const cards = [makeCard()];
    const result = await enrichMissingDictionary(cards);

    expect(result[0].dictionary).toEqual(dict);
    expect(mockApiRequest).toHaveBeenCalledWith('/api/enrich-deck', expect.anything());
  });

  it('respects cancellation signal', async () => {
    mockApiRequest.mockResolvedValue({ entries: { 'Тест': { stressedForm: 'т', pos: '', translations: [] } } });
    const signal = { cancelled: true };
    const cards = [makeCard()];
    const result = await enrichMissingDictionary(cards, signal);
    expect(result).toBe(cards); // returns original on cancellation
  });

  it('reports errors to Sentry and returns original cards', async () => {
    const error = new Error('Network error');
    mockApiRequest.mockRejectedValue(error);

    const cards = [makeCard()];
    const result = await enrichMissingDictionary(cards);

    expect(result).toBe(cards);
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { operation: 'deck_enrich_dictionary' } }),
    );
  });
});

describe('enrichMissingExamples', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cards unchanged when all have examples', async () => {
    const dict: DictionaryEntry = {
      stressedForm: 'те́ст', pos: 'noun', translations: ['test'],
      example: { russian: 'Это тест.', english: 'This is a test.' },
    };
    const cards = [makeCard({ dictionary: dict })];
    const result = await enrichMissingExamples(cards);
    expect(result).toBe(cards);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('generates examples for cards without dictionary data', async () => {
    const example = { russian: 'Это тест.', english: 'This is a test.' };
    mockApiRequest.mockResolvedValue({ examples: { 'Тест': example } });

    const cards = [makeCard()]; // no dictionary
    const result = await enrichMissingExamples(cards);

    expect(mockApiRequest).toHaveBeenCalled();
    expect(result[0].dictionary).toEqual({
      stressedForm: 'Тест',
      pos: '',
      translations: ['test'],
      example,
    });
  });

  it('enriches cards with dictionary but no example', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const example = { russian: 'Это тест.', english: 'This is a test.' };
    mockApiRequest.mockResolvedValue({ examples: { 'Тест': example } });

    const cards = [makeCard({ dictionary: dict })];
    const result = await enrichMissingExamples(cards);

    expect(result[0].dictionary?.example).toEqual(example);
  });

  it('batches requests in chunks of 50', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const cards = Array.from({ length: 75 }, (_, i) =>
      makeCard({ id: `word${i}`, word: `Word${i}`, dictionary: dict })
    );
    mockApiRequest.mockResolvedValue({ examples: {} });

    await enrichMissingExamples(cards);

    expect(mockApiRequest).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((mockApiRequest.mock.calls[0][1] as { body: string }).body);
    expect(firstBody.words).toHaveLength(50);
    const secondBody = JSON.parse((mockApiRequest.mock.calls[1][1] as { body: string }).body);
    expect(secondBody.words).toHaveLength(25);
  });

  it('respects cancellation signal between batches', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const cards = Array.from({ length: 75 }, (_, i) =>
      makeCard({ id: `word${i}`, word: `Word${i}`, dictionary: dict })
    );

    const signal = { cancelled: false };
    mockApiRequest.mockImplementation(async () => {
      signal.cancelled = true; // Cancel after first batch
      return { examples: {} };
    });

    const result = await enrichMissingExamples(cards, signal);
    expect(result).toBe(cards); // Returns original on cancellation
    expect(mockApiRequest).toHaveBeenCalledTimes(1); // Only one batch
  });

  it('reports errors to Sentry and returns original cards', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const error = new Error('GPT error');
    mockApiRequest.mockRejectedValue(error);

    const cards = [makeCard({ dictionary: dict })];
    const result = await enrichMissingExamples(cards);

    expect(result).toBe(cards);
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { operation: 'deck_enrich_examples' } }),
    );
  });
});

describe('enrichSingleCardExample', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates example and creates minimal dictionary when no dictionary provided', async () => {
    const example = { russian: 'Это тест.', english: 'This is a test.' };
    mockApiRequest.mockResolvedValue({ examples: { 'тест': example } });

    const result = await enrichSingleCardExample('тест', undefined, 'test');

    expect(mockApiRequest).toHaveBeenCalledWith('/api/generate-examples', expect.anything());
    expect(result).toEqual({
      stressedForm: 'тест',
      pos: '',
      translations: ['test'],
      example,
    });
  });

  it('returns undefined when no dictionary and API returns no example', async () => {
    mockApiRequest.mockResolvedValue({ examples: {} });

    const result = await enrichSingleCardExample('тест');
    expect(result).toBeUndefined();
  });

  it('enriches dictionary with example', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const example = { russian: 'Это тест.', english: 'This is a test.' };
    mockApiRequest.mockResolvedValue({ examples: { 'Тест': example } });

    const result = await enrichSingleCardExample('Тест', dict);

    expect(result).toEqual({ ...dict, example });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/generate-examples', expect.anything());
  });

  it('returns original dictionary when API returns no example', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    mockApiRequest.mockResolvedValue({ examples: {} });

    const result = await enrichSingleCardExample('Тест', dict);
    expect(result).toBe(dict);
  });

  it('reports errors to Sentry and returns original dictionary', async () => {
    const dict: DictionaryEntry = { stressedForm: 'те́ст', pos: 'noun', translations: ['test'] };
    const error = new Error('API error');
    mockApiRequest.mockRejectedValue(error);

    const result = await enrichSingleCardExample('Тест', dict);

    expect(result).toBe(dict);
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { operation: 'deck_enrich_single_example' } }),
    );
  });

  it('returns undefined on error when no dictionary provided', async () => {
    const error = new Error('API error');
    mockApiRequest.mockRejectedValue(error);

    const result = await enrichSingleCardExample('тест');
    expect(result).toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalled();
  });
});
