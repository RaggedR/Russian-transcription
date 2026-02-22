import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WordPopup } from '../src/components/WordPopup';
import type { Translation } from '../src/types';

// Mock the API module
vi.mock('../src/services/api', () => ({
  apiRequest: vi.fn().mockResolvedValue({
    examples: { 'привет': { russian: 'Привет, как дела?', english: 'Hello, how are you?' } },
  }),
}));

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

  it('calls generate-examples then onAddToDeck with enriched dictionary', async () => {
    const { apiRequest } = await import('../src/services/api');
    const onAddToDeck = vi.fn();
    renderPopup({ onAddToDeck, isInDeck: false });

    fireEvent.click(screen.getByText('Add to deck'));

    await waitFor(() => {
      expect(onAddToDeck).toHaveBeenCalledWith(
        'привет',
        'hello',
        'ru',
        expect.objectContaining({
          stressedForm: 'приве́т',
          example: { russian: 'Привет, как дела?', english: 'Hello, how are you?' },
        }),
      );
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/generate-examples', {
      method: 'POST',
      body: JSON.stringify({ words: ['привет'] }),
    });
  });

  it('still calls onAddToDeck without example if generate-examples fails', async () => {
    const { apiRequest } = await import('../src/services/api');
    (apiRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API down'));

    const onAddToDeck = vi.fn();
    renderPopup({ onAddToDeck, isInDeck: false });

    fireEvent.click(screen.getByText('Add to deck'));

    await waitFor(() => {
      // Should fall back to calling with original dictionary (no example)
      expect(onAddToDeck).toHaveBeenCalledWith(
        'привет',
        'hello',
        'ru',
        MOCK_TRANSLATION.dictionary,
      );
    });
  });

  it('skips generate-examples call when no dictionary data', async () => {
    const { apiRequest } = await import('../src/services/api');
    const noDictTranslation: Translation = {
      word: 'привет',
      translation: 'hello',
      sourceLanguage: 'ru',
    };
    const onAddToDeck = vi.fn();
    renderPopup({
      onAddToDeck,
      isInDeck: false,
      translation: noDictTranslation,
    });

    fireEvent.click(screen.getByText('Add to deck'));

    await waitFor(() => {
      expect(onAddToDeck).toHaveBeenCalledWith('привет', 'hello', 'ru', undefined);
    });

    // generate-examples should NOT be called
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
