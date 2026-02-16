import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WordPopup } from '../src/components/WordPopup';

describe('WordPopup positioning', () => {
  it('uses position:absolute with top:100% so it scrolls with its parent', () => {
    const { container } = render(
      <WordPopup
        translation={{ word: 'привет', translation: 'hello', sourceLanguage: 'ru' }}
        isLoading={false}
        error={null}
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
      />
    );

    const popup = container.querySelector('.absolute.z-50') as HTMLElement;
    expect(popup).not.toBeNull();
    expect(popup.style.position).not.toBe('fixed');
    expect(popup.style.top).toBe('100%');
  });

  it('does NOT use position:fixed', () => {
    const { container } = render(
      <WordPopup
        translation={{ word: 'привет', translation: 'hello', sourceLanguage: 'ru' }}
        isLoading={false}
        error={null}
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
      />
    );

    const popup = container.querySelector('.z-50') as HTMLElement;
    expect(popup).not.toBeNull();
    // Must never be fixed — fixed position doesn't scroll with content
    expect(popup.className).not.toContain('fixed');
    expect(popup.style.position).not.toBe('fixed');
  });
});
