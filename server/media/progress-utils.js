/**
 * Progress reporting utilities and shared constants for media processing.
 * No external dependencies — used by download.js, transcription.js, tts.js, and others.
 */

// Shared browser User-Agent string for proxy and scraping requests
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ok.ru extraction typically takes 90-120 seconds due to their anti-bot JS protection
export const ESTIMATED_EXTRACTION_TIME = 100; // seconds

// Process-level timeout: kills yt-dlp if it hangs (ok.ru CDN can be unreachable)
// 240s leaves a 60s buffer before Cloud Run's 300s request timeout
export const YTDLP_TIMEOUT_MS = 240_000;

/**
 * Map a substage's 0-100 progress into its allocated range within the overall bar.
 * @param {number} substageProgress - Progress within the substage (0-100)
 * @param {number} rangeStart - Start of the substage's range in the overall bar (0-100)
 * @param {number} rangeEnd - End of the substage's range in the overall bar (0-100)
 * @returns {number} Overall progress percentage
 */
export function mapProgress(substageProgress, rangeStart, rangeEnd) {
  return Math.round(rangeStart + (substageProgress / 100) * (rangeEnd - rangeStart));
}

/**
 * Compute range boundaries from an array of substage weights.
 * E.g. weights [60, 45, 5] → ranges [[0, 55], [55, 96], [96, 100]]
 * @param {number[]} weights - Estimated durations for each substage
 * @returns {number[][]} Array of [rangeStart, rangeEnd] pairs
 */
export function computeRanges(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const ranges = [];
  let cursor = 0;
  for (const w of weights) {
    const rangeEnd = cursor + (w / total) * 100;
    ranges.push([Math.round(cursor), Math.round(rangeEnd)]);
    cursor = rangeEnd;
  }
  // Ensure last range ends at exactly 100
  if (ranges.length > 0) ranges[ranges.length - 1][1] = 100;
  return ranges;
}

/**
 * Create a heartbeat interval that calls onProgress with incrementing seconds.
 * Returns an object with stop() method and isStopped() check.
 * @param {function} onProgress - Progress callback (type, percent, status, message)
 * @param {string} type - Progress type ('audio', 'video', 'transcription')
 * @param {function} messageBuilder - Function that takes seconds and returns {percent, message} or just message string
 * @param {number} intervalMs - Interval in milliseconds (default: 1000)
 * @returns {{stop: function, isStopped: function, getSeconds: function}}
 */
export function createHeartbeat(onProgress, type, messageBuilder, intervalMs = 1000) {
  let seconds = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (!stopped) {
      seconds++;
      const result = messageBuilder(seconds);
      // Support both string (old style) and {percent, message} (new style)
      if (typeof result === 'object' && result !== null) {
        onProgress(type, result.percent || 0, 'active', result.message);
      } else if (result) {
        onProgress(type, 0, 'active', result);
      }
    }
  }, intervalMs);

  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        clearInterval(interval);
      }
    },
    isStopped: () => stopped,
    getSeconds: () => seconds,
  };
}
