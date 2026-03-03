import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCompletionDetector } from '../src/hooks/useCompletionDetector';
import type { Transcript } from '../src/types';

function makeTranscript(duration: number): Transcript {
  return {
    words: [],
    segments: [],
    language: 'ru',
    duration,
  };
}

/** Simulate playback ticks using integer math to avoid floating-point drift. */
function simulateTicks(
  handler: (time: number) => void,
  fromSec: number,
  toSec: number,
) {
  const fromMs = Math.round(fromSec * 10);
  const toMs = Math.round(toSec * 10);
  for (let i = fromMs; i <= toMs; i++) {
    handler(i / 10);
  }
}

describe('useCompletionDetector', () => {
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onComplete = vi.fn();
  });

  it('fires onComplete when cumulative play reaches 50%', () => {
    const transcript = makeTranscript(100); // 100 seconds, threshold = 50s
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      simulateTicks(result.current.handleTimeUpdate, 0, 51);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not fire before 50% threshold', () => {
    const transcript = makeTranscript(100);
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      simulateTicks(result.current.handleTimeUpdate, 0, 40);
    });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rejects seek (large positive jump)', () => {
    const transcript = makeTranscript(100);
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      // Play 10 seconds normally
      simulateTicks(result.current.handleTimeUpdate, 0, 10);
      // Seek to 80s (jump of 70s — rejected)
      result.current.handleTimeUpdate(80);
      // Continue from 80 for 5 seconds
      simulateTicks(result.current.handleTimeUpdate, 80.1, 85);
    });

    // Only ~15s of cumulative play, not 50%
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('rejects backward seek', () => {
    const transcript = makeTranscript(100);
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      simulateTicks(result.current.handleTimeUpdate, 0, 20);
      // Seek backward to 5s
      result.current.handleTimeUpdate(5);
      // Continue from 5s for 15s
      simulateTicks(result.current.handleTimeUpdate, 5.1, 20);
    });

    // ~35s cumulative, not 50% of 100s
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('accumulates across pause/resume', () => {
    const transcript = makeTranscript(60); // 60s, need 30s
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      // Play 20 seconds
      simulateTicks(result.current.handleTimeUpdate, 0, 20);
    });

    // Simulate pause (no ticks)

    act(() => {
      // Resume — player position hasn't changed during pause
      simulateTicks(result.current.handleTimeUpdate, 20.1, 35);
    });

    // ~35s cumulative > 30s threshold
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires only once', () => {
    const transcript = makeTranscript(20);
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      simulateTicks(result.current.handleTimeUpdate, 0, 20);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('reset clears state for new chunk', () => {
    const transcript = makeTranscript(20); // need 10s
    const { result } = renderHook(() => useCompletionDetector(transcript, onComplete));

    act(() => {
      // Play 8 seconds (not enough)
      simulateTicks(result.current.handleTimeUpdate, 0, 8);
    });

    expect(onComplete).not.toHaveBeenCalled();

    // Reset for new chunk
    act(() => {
      result.current.reset();
    });

    act(() => {
      // Play 8 more seconds — should NOT carry over previous 8s
      simulateTicks(result.current.handleTimeUpdate, 0, 8);
    });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does nothing when transcript is null', () => {
    const { result } = renderHook(() => useCompletionDetector(null, onComplete));

    act(() => {
      simulateTicks(result.current.handleTimeUpdate, 0, 100);
    });

    expect(onComplete).not.toHaveBeenCalled();
  });
});
