/**
 * Pure text utility functions for transcript processing.
 * No external dependencies — used by transcription.js, tts.js, and others.
 */

/**
 * Strip punctuation from the edges of a word (for matching purposes)
 * Handles Russian and common punctuation: . , ! ? ; : — – - « » " ' ( ) …
 */
export function stripPunctuation(word) {
  return word.replace(/^[.,!?;:—–\-«»""''()…\s]+|[.,!?;:—–\-«»""''()…\s]+$/g, '');
}

/**
 * Levenshtein edit distance between two strings (O(min(n,m)) space).
 * Uses a rolling 2-row approach instead of a full matrix.
 */
export function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for O(min(n,m)) space
  if (a.length > b.length) [a, b] = [b, a];

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let curr = new Array(a.length + 1);

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

/**
 * Check if two words are a fuzzy match (likely a spelling correction).
 * Allows up to ~30% character difference for words of 4+ characters.
 */
export function isFuzzyMatch(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  const dist = editDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return dist <= Math.max(2, Math.floor(maxLen * 0.3));
}

/**
 * Estimate word-level timestamps by distributing audio duration proportionally
 * across words based on character length.
 * @param {string} text - Original text
 * @param {number} duration - Audio duration in seconds
 * @returns {{words: Array<{word: string, start: number, end: number}>, segments: Array, duration: number}}
 */
export function estimateWordTimestamps(text, duration) {
  const rawWords = text.split(/\s+/).filter(w => w.length > 0);
  const totalChars = rawWords.reduce((sum, w) => sum + w.length, 0);

  const words = [];
  let cursor = 0;
  for (let i = 0; i < rawWords.length; i++) {
    const wordDuration = (rawWords[i].length / totalChars) * duration;
    const start = cursor;
    const end = cursor + wordDuration;
    words.push({
      word: (i > 0 ? ' ' : '') + rawWords[i],
      start,
      end,
    });
    cursor = end;
  }

  // Build segments (~20 words each)
  const segments = [];
  for (let i = 0; i < words.length; i += 20) {
    const segWords = words.slice(i, i + 20);
    segments.push({
      text: segWords.map(w => w.word).join('').trim(),
      start: segWords[0].start,
      end: segWords[segWords.length - 1].end,
    });
  }

  return { words, segments, language: 'ru', duration };
}

/**
 * Align Whisper-transcribed words back to original text words.
 * Uses two-pointer fuzzy matching (same approach as addPunctuation).
 * For matched words: use Whisper timestamps with original word text.
 * For unmatched: interpolate timestamps from neighbors.
 *
 * @param {Array<{word: string, start: number, end: number}>} whisperWords - From Whisper transcription
 * @param {string[]} originalWords - Original text split into words
 * @returns {Array<{word: string, start: number, end: number}>}
 */
export function alignWhisperToOriginal(whisperWords, originalWords) {
  if (!whisperWords.length || !originalWords.length) {
    return originalWords.map((w, i) => ({
      word: (i > 0 ? ' ' : '') + w,
      start: 0,
      end: 0,
    }));
  }

  const result = [];
  let wi = 0; // whisper index
  let oi = 0; // original index

  while (oi < originalWords.length) {
    const origWord = originalWords[oi];
    const origBase = stripPunctuation(origWord).toLowerCase();
    const leadingSpace = oi > 0 ? ' ' : '';

    if (wi < whisperWords.length) {
      const whisperBase = stripPunctuation(whisperWords[wi].word).toLowerCase();

      if (origBase === whisperBase || isFuzzyMatch(origBase, whisperBase)) {
        // Direct match — use original word text with Whisper timing
        result.push({
          word: leadingSpace + origWord,
          start: whisperWords[wi].start,
          end: whisperWords[wi].end,
        });
        wi++;
        oi++;
      } else {
        // Try lookahead in whisper words (TTS may have added/skipped words)
        let found = false;
        for (let la = 1; la <= 3 && wi + la < whisperWords.length; la++) {
          const laBase = stripPunctuation(whisperWords[wi + la].word).toLowerCase();
          if (laBase === origBase || isFuzzyMatch(laBase, origBase)) {
            wi += la;
            result.push({
              word: leadingSpace + origWord,
              start: whisperWords[wi].start,
              end: whisperWords[wi].end,
            });
            wi++;
            oi++;
            found = true;
            break;
          }
        }

        if (!found) {
          // Try lookahead in original words
          for (let la = 1; la <= 3 && oi + la < originalWords.length; la++) {
            const futureBase = stripPunctuation(originalWords[oi + la]).toLowerCase();
            if (futureBase === whisperBase || isFuzzyMatch(futureBase, whisperBase)) {
              // Original has extra words — interpolate timestamps
              for (let skip = 0; skip < la; skip++) {
                result.push({
                  word: (oi + skip > 0 ? ' ' : '') + originalWords[oi + skip],
                  start: -1, // will be interpolated
                  end: -1,
                });
              }
              oi += la;
              found = true;
              break;
            }
          }
        }

        if (!found) {
          // No match — mark for interpolation
          result.push({
            word: leadingSpace + origWord,
            start: -1,
            end: -1,
          });
          oi++;
        }
      }
    } else {
      // No more whisper words — mark remaining for interpolation
      result.push({
        word: leadingSpace + origWord,
        start: -1,
        end: -1,
      });
      oi++;
    }
  }

  // Interpolate timestamps for unmatched words
  const totalDuration = whisperWords[whisperWords.length - 1].end;
  for (let i = 0; i < result.length; i++) {
    if (result[i].start === -1) {
      // Find nearest known timestamps before and after
      let prevEnd = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (result[j].end !== -1) {
          prevEnd = result[j].end;
          break;
        }
      }
      let nextStart = totalDuration;
      let gapCount = 1; // count of consecutive unmatched words including this one
      for (let j = i + 1; j < result.length; j++) {
        if (result[j].start !== -1) {
          nextStart = result[j].start;
          break;
        }
        gapCount++;
      }

      // Distribute the gap evenly
      const step = (nextStart - prevEnd) / (gapCount + 1);
      let pos = 0;
      for (let j = i; j < result.length && result[j].start === -1; j++) {
        pos++;
        result[j].start = prevEnd + step * pos;
        result[j].end = prevEnd + step * (pos + 0.8);
      }
    }
  }

  return result;
}
