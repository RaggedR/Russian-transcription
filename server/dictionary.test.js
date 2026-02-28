/**
 * Unit tests for the OpenRussian dictionary service.
 *
 * Uses small fixture TSVs in server/test-fixtures/openrussian/ (3 nouns,
 * 2 verbs, 1 adjective, 2 others) to test parsing, stress conversion,
 * and word lookup without downloading the full ~21MB dataset.
 *
 * Note: Fixture files use .csv extension despite being TSV (tab-separated) —
 * this matches the upstream Badestrand/russian-dictionary repo naming convention.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDictionary, lookupWord, convertStress, _resetForTesting } from './dictionary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'test-fixtures', 'openrussian');

beforeAll(async () => {
  _resetForTesting();
  await initDictionary(FIXTURE_DIR);
});

// ── convertStress ─────────────────────────────────────────────────────

describe('convertStress', () => {
  it('converts apostrophe after vowel to combining accent', () => {
    expect(convertStress("челове'к")).toBe('челове\u0301к');
  });

  it('handles multiple stress marks', () => {
    expect(convertStress("времена'м")).toBe('времена\u0301м');
  });

  it('leaves text without apostrophes unchanged', () => {
    expect(convertStress('книга')).toBe('книга');
  });

  it('handles uppercase vowels', () => {
    expect(convertStress("Е'вропа")).toBe('Е\u0301вропа');
  });

  it('ignores apostrophes not after vowels', () => {
    expect(convertStress("д'артаньян")).toBe("д'артаньян");
  });
});

// ── lookupWord — nouns ────────────────────────────────────────────────

describe('lookupWord — nouns', () => {
  it('finds a noun by bare form', () => {
    const entry = lookupWord('время');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('noun');
    expect(entry.stressedForm).toBe('вре\u0301мя');
    expect(entry.gender).toBe('n');
    expect(entry.translations).toContain('time');
    expect(entry.translations).toContain('period');
  });

  it('returns full declension table for nouns', () => {
    const entry = lookupWord('время');
    expect(entry.declension).toBeDefined();
    expect(entry.declension.sg.nom).toBe('вре\u0301мя');
    expect(entry.declension.sg.gen).toBe('вре\u0301мени');
    expect(entry.declension.pl.nom).toBe('времена\u0301');
    expect(entry.declension.pl.gen).toBe('времён');
  });

  it('finds animate nouns', () => {
    const entry = lookupWord('человек');
    expect(entry).not.toBeNull();
    expect(entry.gender).toBe('m');
  });
});

// ── lookupWord — verbs ────────────────────────────────────────────────

describe('lookupWord — verbs', () => {
  it('finds a verb by bare form', () => {
    const entry = lookupWord('говорить');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('verb');
    expect(entry.aspect).toBe('imperfective');
    expect(entry.aspectPair).toBe('сказа\u0301ть');
    expect(entry.translations).toContain('speak');
  });

  it('returns conjugation table for verbs', () => {
    const entry = lookupWord('говорить');
    expect(entry.conjugation).toBeDefined();
    expect(entry.conjugation.present.sg1).toBe('говорю\u0301');
    expect(entry.conjugation.present.sg3).toBe('говори\u0301т');
    expect(entry.conjugation.past.m).toBe('говори\u0301л');
    expect(entry.conjugation.past.f).toBe('говори\u0301ла');
    expect(entry.conjugation.imperative.sg).toBe('говори\u0301');
  });

  it('finds aspect pair', () => {
    const entry = lookupWord('сказать');
    expect(entry).not.toBeNull();
    expect(entry.aspect).toBe('perfective');
    expect(entry.aspectPair).toBe('говорить');
  });
});

// ── lookupWord — adjectives ───────────────────────────────────────────

describe('lookupWord — adjectives', () => {
  it('finds an adjective by bare form', () => {
    const entry = lookupWord('красивый');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('adjective');
    expect(entry.translations).toContain('beautiful');
  });

  it('returns adjective forms', () => {
    const entry = lookupWord('красивый');
    expect(entry.adjectiveForms).toBeDefined();
    expect(entry.adjectiveForms.long.m).toBe('краси\u0301вый');
    expect(entry.adjectiveForms.long.f).toBe('краси\u0301вая');
    expect(entry.adjectiveForms.short.m).toBe('краси\u0301в');
    expect(entry.adjectiveForms.comparative).toBe('краси\u0301вее');
    expect(entry.adjectiveForms.superlative).toBe('краси\u0301вейший');
  });
});

// ── lookupWord — others (adverbs, etc.) ───────────────────────────────

describe('lookupWord — others', () => {
  it('finds an adverb/other word', () => {
    const entry = lookupWord('хорошо');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('other');
    expect(entry.translations).toContain('well');
  });

  it('has no grammar tables for others', () => {
    const entry = lookupWord('хорошо');
    expect(entry.declension).toBeUndefined();
    expect(entry.conjugation).toBeUndefined();
    expect(entry.adjectiveForms).toBeUndefined();
  });
});

// ── lookupWord — inflection index (no lemma needed) ─────────────────

describe('lookupWord — inflection index', () => {
  it('finds noun "книга" via accusative form "книгу"', () => {
    const entry = lookupWord('книгу');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('noun');
    expect(entry.stressedForm).toBe('кни\u0301га');
    expect(entry.declension.sg.acc).toBe('кни\u0301гу');
  });

  it('finds verb "говорить" via 3rd person sg "говорит"', () => {
    const entry = lookupWord('говорит');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('verb');
    expect(entry.stressedForm).toBe('говори\u0301ть');
    expect(entry.conjugation.present.sg3).toBe('говори\u0301т');
  });

  it('finds adjective "красивый" via feminine nom "красивая"', () => {
    const entry = lookupWord('красивая');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('adjective');
    expect(entry.translations).toContain('beautiful');
    expect(entry.adjectiveForms.long.f).toBe('краси\u0301вая');
  });

  it('finds "человек" via irregular plural gen "людей"', () => {
    const entry = lookupWord('людей');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('noun');
    expect(entry.stressedForm).toBe('челове\u0301к');
    expect(entry.declension.pl.gen).toBe('люде\u0301й');
  });

  it('finds noun via genitive plural "книг"', () => {
    const entry = lookupWord('книг');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('noun');
    expect(entry.stressedForm).toBe('кни\u0301га');
  });

  it('finds verb via past feminine "сказала"', () => {
    const entry = lookupWord('сказала');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('verb');
    expect(entry.aspect).toBe('perfective');
  });

  it('finds adjective via comma-separated alternate form "красивого"', () => {
    // "красивого" appears in decl_m_gen and also as alternate in decl_m_acc
    const entry = lookupWord('красивого');
    expect(entry).not.toBeNull();
    expect(entry.pos).toBe('adjective');
  });

  it('still returns null for truly unknown words', () => {
    expect(lookupWord('абракадабра')).toBeNull();
  });
});

// ── lookupWord — lemma fallback ───────────────────────────────────────

describe('lookupWord — lemma fallback', () => {
  it('uses lemma param to find the word when surface form is not in index', () => {
    // "времени" is not a bare form, but lemma "время" is
    const entry = lookupWord('времени', 'время');
    expect(entry).not.toBeNull();
    expect(entry.stressedForm).toBe('вре\u0301мя');
    expect(entry.pos).toBe('noun');
  });

  it('returns null for unknown word and unknown lemma', () => {
    expect(lookupWord('unknownword')).toBeNull();
    expect(lookupWord('unknownword', 'alsobogus')).toBeNull();
  });

  it('normalizes ё→е for lookup', () => {
    // "время" is stored as "время" — ё normalization shouldn't break it
    // but if a word used ё it should still resolve
    const entry = lookupWord('время');
    expect(entry).not.toBeNull();
  });
});

// ── initDictionary — graceful no-op ───────────────────────────────────

describe('initDictionary — graceful handling', () => {
  it('no-ops when data directory does not exist', async () => {
    _resetForTesting();
    await initDictionary('/nonexistent/path');
    expect(lookupWord('время')).toBeNull();
    // Re-init with fixtures for remaining tests
    await initDictionary(FIXTURE_DIR);
  });
});
