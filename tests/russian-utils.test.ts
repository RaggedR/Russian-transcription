import { describe, it, expect } from 'vitest';
import { cleanWord, normalizeRussianWord } from '../src/utils/russian';

describe('cleanWord', () => {
  it('strips leading spaces', () => {
    expect(cleanWord(' неожиданно')).toBe('неожиданно');
  });

  it('strips trailing period', () => {
    expect(cleanWord('ответа.')).toBe('ответа');
  });

  it('strips trailing comma', () => {
    expect(cleanWord('привычною,')).toBe('привычною');
  });

  it('strips leading space and trailing punctuation', () => {
    expect(cleanWord(' мозга","')).toBe('мозга');
  });

  it('strips multiple types of punctuation', () => {
    expect(cleanWord('  «слово»  ')).toBe('слово');
  });

  it('preserves clean words', () => {
    expect(cleanWord('приятелем')).toBe('приятелем');
  });

  it('preserves Latin words', () => {
    expect(cleanWord('Fallback')).toBe('Fallback');
  });

  it('preserves internal punctuation (hyphenated words)', () => {
    expect(cleanWord('по-русски')).toBe('по-русски');
  });

  it('handles empty string', () => {
    expect(cleanWord('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(cleanWord('   ')).toBe('');
  });
});

describe('normalizeRussianWord', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeRussianWord('Привет!')).toBe('привет');
  });

  it('normalizes ё to е', () => {
    expect(normalizeRussianWord('ёлка')).toBe('елка');
  });
});
