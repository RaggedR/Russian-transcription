import { useRef, useCallback } from 'react';
import type { Transcript } from '../types';

/**
 * Tracks cumulative play time via delta accumulation.
 * Fires `onComplete` once when playedTime >= 50% of transcript duration.
 *
 * Delta-based: only normal forward playback (small positive deltas) accumulates.
 * Seeks (large jumps), pauses (no ticks), and backward seeks are all rejected.
 */
export function useCompletionDetector(
  transcript: Transcript | null,
  onComplete: () => void,
): { handleTimeUpdate: (time: number) => void; reset: () => void } {
  const lastTimeRef = useRef<number | null>(null);
  const playedTimeRef = useRef(0);
  const firedRef = useRef(false);

  const handleTimeUpdate = useCallback((time: number) => {
    if (!transcript || firedRef.current) return;

    const lastTime = lastTimeRef.current;
    lastTimeRef.current = time;

    if (lastTime === null) return;

    const delta = time - lastTime;

    // Only count normal forward playback: 0 < delta < 0.5s
    // Player ticks every 100ms, so normal delta ≈ 0.1s
    // Rejects: seeks (delta > 0.5), backward seeks (delta < 0), pauses (delta ≈ 0)
    if (delta > 0 && delta < 0.5) {
      playedTimeRef.current += delta;

      if (playedTimeRef.current >= transcript.duration * 0.5) {
        firedRef.current = true;
        onComplete();
      }
    }
  }, [transcript, onComplete]);

  const reset = useCallback(() => {
    lastTimeRef.current = null;
    playedTimeRef.current = 0;
    firedRef.current = false;
  }, []);

  return { handleTimeUpdate, reset };
}
