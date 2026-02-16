import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ReviewPanel } from '../src/components/ReviewPanel';
import type { SRSCard } from '../src/types';

// Mock speechSynthesis
Object.defineProperty(window, 'speechSynthesis', {
  value: { speak: vi.fn(), cancel: vi.fn() },
});

function makeCard(overrides: Partial<SRSCard> = {}): SRSCard {
  return {
    id: 'test',
    word: 'hello',
    translation: 'привет',
    sourceLanguage: 'ru',
    easeFactor: 2.5,
    interval: 0,
    repetition: 0,
    nextReviewDate: new Date(0).toISOString(),
    addedAt: new Date().toISOString(),
    lastReviewedAt: null,
    ...overrides,
  };
}

function getFrontWord(container: HTMLElement): string {
  const el = container.querySelector('.text-3xl');
  return el?.textContent ?? '';
}

function getBackWord(container: HTMLElement): string {
  // The back word is in the border-t section (revealed after Show Answer)
  const el = container.querySelector('.border-t .text-xl');
  return el?.textContent ?? '';
}

describe('ReviewPanel flashcard direction', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onReview: vi.fn(),
    onRemove: vi.fn(),
  };

  it('shows Russian on the front when card.word is English and card.translation is Russian', () => {
    const card = makeCard({ word: 'hello', translation: 'привет' });
    const { container } = render(<ReviewPanel {...defaultProps} dueCards={[card]} />);

    expect(getFrontWord(container)).toBe('привет');
  });

  it('shows Russian on the front when card.word is Russian and card.translation is English', () => {
    const card = makeCard({ word: 'привет', translation: 'hello' });
    const { container } = render(<ReviewPanel {...defaultProps} dueCards={[card]} />);

    expect(getFrontWord(container)).toBe('привет');
  });

  it('shows English on the back after clicking Show Answer (swapped fields)', () => {
    const card = makeCard({ word: 'hello', translation: 'привет' });
    const { container } = render(<ReviewPanel {...defaultProps} dueCards={[card]} />);

    fireEvent.click(screen.getByText('Show Answer'));

    expect(getBackWord(container)).toBe('hello');
  });

  it('shows English on the back after clicking Show Answer (normal fields)', () => {
    const card = makeCard({ word: 'привет', translation: 'hello' });
    const { container } = render(<ReviewPanel {...defaultProps} dueCards={[card]} />);

    fireEvent.click(screen.getByText('Show Answer'));

    expect(getBackWord(container)).toBe('hello');
  });

  it('shows Russian sentence on front and English sentence on back when fields are swapped', () => {
    const card = makeCard({
      word: 'hello',
      translation: 'привет',
      context: 'Say hello to everyone.',
      contextTranslation: 'Скажи привет всем.',
    });
    const { container } = render(<ReviewPanel {...defaultProps} dueCards={[card]} />);

    // Russian sentence visible on front
    expect(container.textContent).toContain('Скажи');
    // English sentence NOT visible before reveal
    expect(container.textContent).not.toContain('Say hello');

    fireEvent.click(screen.getByText('Show Answer'));

    // English sentence visible after reveal
    expect(container.textContent).toContain('Say hello');
  });

  it('shows Russian sentence on front and English sentence on back when fields are normal', () => {
    const card = makeCard({
      word: 'привет',
      translation: 'hello',
      context: 'Скажи привет всем.',
      contextTranslation: 'Say hello to everyone.',
    });
    const { container } = render(<ReviewPanel {...defaultProps} dueCards={[card]} />);

    // Russian sentence visible on front
    expect(container.textContent).toContain('Скажи');
    // English sentence NOT visible before reveal
    expect(container.textContent).not.toContain('Say hello');

    fireEvent.click(screen.getByText('Show Answer'));

    // English sentence visible after reveal
    expect(container.textContent).toContain('Say hello');
  });
});
