import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { WordPopup } from '../src/components/WordPopup';
import type { Translation } from '../src/types';

const MOCK_TRANSLATION: Translation = {
  word: 'привет',
  translation: 'hello',
  sourceLanguage: 'ru',
  dictionary: {
    stressedForm: 'приве́т',
    pos: 'other',
    translations: ['hello', 'hi'],
  },
};

const DEFAULT_POSITION = { x: 100, y: 200 };

function renderPopup(overrides: Partial<Parameters<typeof WordPopup>[0]> = {}) {
  return render(
    <WordPopup
      translation={'translation' in overrides ? overrides.translation! : MOCK_TRANSLATION}
      isLoading={overrides.isLoading ?? false}
      error={'error' in overrides ? overrides.error! : null}
      position={'position' in overrides ? overrides.position! : DEFAULT_POSITION}
      onClose={overrides.onClose ?? vi.fn()}
      onAddToDeck={overrides.onAddToDeck}
      isInDeck={overrides.isInDeck}
    />
  );
}

describe('WordPopup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Null rendering ────────────────────────────────────────

  it('returns null when position is null', () => {
    const { container } = renderPopup({ position: null });
    expect(container.innerHTML).toBe('');
  });

  it('returns null when no loading, no error, and no translation', () => {
    const { container } = renderPopup({
      translation: null,
      isLoading: false,
      error: null,
    });
    expect(container.innerHTML).toBe('');
  });

  // ─── Loading state ────────────────────────────────────────

  it('shows "Translating..." spinner when isLoading', () => {
    renderPopup({ isLoading: true, translation: null });
    expect(screen.getByText('Translating...')).toBeInTheDocument();
  });

  // ─── Error state ──────────────────────────────────────────

  it('shows error message in red', () => {
    renderPopup({ error: 'Network timeout', translation: null });
    expect(screen.getByText('Error:')).toBeInTheDocument();
    expect(screen.getByText('Network timeout')).toBeInTheDocument();
  });

  // ─── Translation display ──────────────────────────────────

  it('shows word and translation when loaded', () => {
    renderPopup();
    expect(screen.getByText('привет')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('hides translation while still loading', () => {
    renderPopup({ isLoading: true, translation: MOCK_TRANSLATION });
    // Should show loading state, not translation
    expect(screen.getByText('Translating...')).toBeInTheDocument();
  });

  // ─── Close button ─────────────────────────────────────────

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    renderPopup({ onClose });
    fireEvent.click(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Add to deck ──────────────────────────────────────────

  it('shows "Add to deck" button when onAddToDeck provided and not in deck', () => {
    renderPopup({ onAddToDeck: vi.fn(), isInDeck: false });
    expect(screen.getByText('Add to deck')).toBeInTheDocument();
  });

  it('shows "In deck" when isInDeck is true', () => {
    renderPopup({ onAddToDeck: vi.fn(), isInDeck: true });
    expect(screen.getByText('In deck')).toBeInTheDocument();
    expect(screen.queryByText('Add to deck')).not.toBeInTheDocument();
  });

  it('does not show deck section when onAddToDeck is not provided', () => {
    renderPopup({ isInDeck: false });
    expect(screen.queryByText('Add to deck')).not.toBeInTheDocument();
    expect(screen.queryByText('In deck')).not.toBeInTheDocument();
  });

  it('calls onAddToDeck with word, translation, and dictionary', async () => {
    const onAddToDeck = vi.fn().mockResolvedValue(undefined);
    renderPopup({ onAddToDeck, isInDeck: false });

    await act(async () => {
      fireEvent.click(screen.getByText('Add to deck'));
    });

    expect(onAddToDeck).toHaveBeenCalledTimes(1);
    expect(onAddToDeck).toHaveBeenCalledWith(
      'привет',
      'hello',
      'ru',
      MOCK_TRANSLATION.dictionary,
    );
  });

  it('calls onAddToDeck with undefined dictionary when no dictionary data', async () => {
    const noDictTranslation: Translation = {
      word: 'привет',
      translation: 'hello',
      sourceLanguage: 'ru',
    };
    const onAddToDeck = vi.fn().mockResolvedValue(undefined);
    renderPopup({
      onAddToDeck,
      isInDeck: false,
      translation: noDictTranslation,
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Add to deck'));
    });

    expect(onAddToDeck).toHaveBeenCalledWith('привет', 'hello', 'ru', undefined);
  });

  it('shows "Adding..." spinner while onAddToDeck promise is pending', async () => {
    let resolveAdd!: () => void;
    const addPromise = new Promise<void>(resolve => { resolveAdd = resolve; });
    const onAddToDeck = vi.fn().mockReturnValue(addPromise);

    renderPopup({ onAddToDeck, isInDeck: false });

    // Click "Add to deck"
    fireEvent.click(screen.getByText('Add to deck'));

    // Should show "Adding..." spinner
    expect(screen.getByText('Adding...')).toBeInTheDocument();
    expect(screen.queryByText('Add to deck')).not.toBeInTheDocument();

    // Resolve the promise
    await act(async () => { resolveAdd(); });

    // Should go back to showing "Add to deck" (not "In deck" — that depends on isInDeck prop)
    expect(screen.queryByText('Adding...')).not.toBeInTheDocument();
    expect(screen.getByText('Add to deck')).toBeInTheDocument();
  });
});
