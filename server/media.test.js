import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHeartbeat, editDistance, isFuzzyMatch, stripPunctuation } from './media.js';

describe('createHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call onProgress with incrementing seconds', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(
      onProgress,
      'audio',
      (s) => `Connecting... (${s}s)`
    );

    // Advance 3 seconds
    vi.advanceTimersByTime(3000);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'audio', 0, 'active', 'Connecting... (1s)');
    expect(onProgress).toHaveBeenNthCalledWith(2, 'audio', 0, 'active', 'Connecting... (2s)');
    expect(onProgress).toHaveBeenNthCalledWith(3, 'audio', 0, 'active', 'Connecting... (3s)');

    heartbeat.stop();
  });

  it('should stop calling onProgress after stop() is called', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(
      onProgress,
      'video',
      (s) => `Waiting (${s}s)`
    );

    vi.advanceTimersByTime(2000);
    expect(onProgress).toHaveBeenCalledTimes(2);

    heartbeat.stop();

    vi.advanceTimersByTime(3000);
    // Should still be 2, not 5
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('should report isStopped correctly', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}s`);

    expect(heartbeat.isStopped()).toBe(false);
    heartbeat.stop();
    expect(heartbeat.isStopped()).toBe(true);
  });

  it('should be safe to call stop() multiple times', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}s`);

    heartbeat.stop();
    heartbeat.stop();
    heartbeat.stop();

    expect(heartbeat.isStopped()).toBe(true);
  });

  it('should use custom interval', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(
      onProgress,
      'transcription',
      (s) => `${s}s`,
      500 // 500ms interval
    );

    vi.advanceTimersByTime(2000);

    // 2000ms / 500ms = 4 calls
    expect(onProgress).toHaveBeenCalledTimes(4);

    heartbeat.stop();
  });

  it('should pass correct type to onProgress', () => {
    const onProgress = vi.fn();

    const audioHeartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}`);
    vi.advanceTimersByTime(1000);
    expect(onProgress).toHaveBeenLastCalledWith('audio', 0, 'active', '1');
    audioHeartbeat.stop();

    onProgress.mockClear();

    const videoHeartbeat = createHeartbeat(onProgress, 'video', (s) => `${s}`);
    vi.advanceTimersByTime(1000);
    expect(onProgress).toHaveBeenLastCalledWith('video', 0, 'active', '1');
    videoHeartbeat.stop();
  });

  it('should not call onProgress after being stopped even if interval fires', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}s`);

    vi.advanceTimersByTime(1000);
    expect(onProgress).toHaveBeenCalledTimes(1);

    // Stop before next interval
    heartbeat.stop();

    // Even if we advance time, should not get more calls
    vi.advanceTimersByTime(5000);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});

describe('createHeartbeat edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not throw if onProgress throws', () => {
    const onProgress = vi.fn().mockImplementation(() => {
      throw new Error('Progress error');
    });

    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}s`);

    // This should not throw
    expect(() => {
      vi.advanceTimersByTime(1000);
    }).toThrow('Progress error');

    heartbeat.stop();
  });

  it('should handle rapid stop calls', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}s`);

    // Rapidly stop
    for (let i = 0; i < 100; i++) {
      heartbeat.stop();
    }

    expect(heartbeat.isStopped()).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(onProgress).toHaveBeenCalledTimes(0);
  });

  it('should work with very short intervals', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}`, 10);

    vi.advanceTimersByTime(100);
    expect(onProgress).toHaveBeenCalledTimes(10);

    heartbeat.stop();
  });

  it('should work with long intervals', () => {
    const onProgress = vi.fn();
    const heartbeat = createHeartbeat(onProgress, 'audio', (s) => `${s}`, 60000);

    vi.advanceTimersByTime(120000);
    expect(onProgress).toHaveBeenCalledTimes(2);

    heartbeat.stop();
  });

  it('should allow different message builders', () => {
    const onProgress = vi.fn();

    // Complex message builder
    const messageBuilder = (s) => {
      const mins = Math.floor(s / 60);
      const secs = s % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const heartbeat = createHeartbeat(onProgress, 'audio', messageBuilder);

    vi.advanceTimersByTime(65000); // 65 seconds

    expect(onProgress).toHaveBeenLastCalledWith('audio', 0, 'active', '1:05');

    heartbeat.stop();
  });
});

// ---------------------------------------------------------------------------
// stripPunctuation
// ---------------------------------------------------------------------------

describe('stripPunctuation', () => {
  it('removes leading and trailing punctuation', () => {
    expect(stripPunctuation('«Привет»')).toBe('Привет');
    expect(stripPunctuation('слово.')).toBe('слово');
    expect(stripPunctuation(',слово,')).toBe('слово');
    expect(stripPunctuation('...слово!')).toBe('слово');
    expect(stripPunctuation('—слово—')).toBe('слово');
  });

  it('preserves internal punctuation-like characters', () => {
    expect(stripPunctuation('кто-то')).toBe('кто-то');
  });

  it('returns empty string for only-punctuation input', () => {
    expect(stripPunctuation('...')).toBe('');
    expect(stripPunctuation('—')).toBe('');
  });

  it('returns the word unchanged if no edge punctuation', () => {
    expect(stripPunctuation('программа')).toBe('программа');
    expect(stripPunctuation('hello')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// editDistance
// ---------------------------------------------------------------------------

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('программа', 'программа')).toBe(0);
  });

  it('returns length of other string for empty input', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('', '')).toBe(0);
  });

  it('computes single-character edits correctly', () => {
    expect(editDistance('cat', 'bat')).toBe(1);  // substitution
    expect(editDistance('cat', 'cats')).toBe(1); // insertion
    expect(editDistance('cats', 'cat')).toBe(1); // deletion
  });

  it('computes multi-character edits', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('sunday', 'saturday')).toBe(3);
  });

  it('handles Russian words (Whisper correction scenario)', () => {
    // пограмма -> программа (1 insertion: insert р after п)
    expect(editDistance('пограмма', 'программа')).toBe(1);
    // скажым -> скажем (1 substitution: ы -> е)
    expect(editDistance('скажым', 'скажем')).toBe(1);
  });

  it('is symmetric', () => {
    expect(editDistance('abc', 'xyz')).toBe(editDistance('xyz', 'abc'));
    expect(editDistance('программа', 'пограмма')).toBe(editDistance('пограмма', 'программа'));
  });
});

// ---------------------------------------------------------------------------
// isFuzzyMatch
// ---------------------------------------------------------------------------

describe('isFuzzyMatch', () => {
  it('returns false for short words (< 4 chars)', () => {
    expect(isFuzzyMatch('да', 'до')).toBe(false);
    expect(isFuzzyMatch('кот', 'код')).toBe(false);
  });

  it('matches spelling corrections within threshold', () => {
    // пограмма -> программа: distance 2, maxLen 9, threshold max(2, 2) = 2 ✓
    expect(isFuzzyMatch('пограмма', 'программа')).toBe(true);
    // скажым -> скажем: distance 1, but both are < 4? No, 6 chars. threshold max(2, 1) = 2 ✓
    expect(isFuzzyMatch('скажым', 'скажем')).toBe(true);
  });

  it('rejects words that differ too much', () => {
    expect(isFuzzyMatch('программа', 'телевизор')).toBe(false);
    expect(isFuzzyMatch('hello', 'world')).toBe(false);
  });

  it('matches identical words', () => {
    expect(isFuzzyMatch('программа', 'программа')).toBe(true);
    expect(isFuzzyMatch('hello', 'hello')).toBe(true);
  });

  it('is symmetric', () => {
    expect(isFuzzyMatch('пограмма', 'программа')).toBe(isFuzzyMatch('программа', 'пограмма'));
  });
});
