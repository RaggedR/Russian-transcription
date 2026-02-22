/**
 * URL normalization and video ID extraction utilities.
 * Pure functions with no external dependencies.
 */

/**
 * Extract video ID from URL
 */
export function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('ok.ru')) {
      const match = u.pathname.match(/\/video\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize URL for cache lookup (strip tracking params, etc.)
 */
export function normalizeUrl(url) {
  const videoId = extractVideoId(url);
  if (videoId) return `ok.ru/video/${videoId}`;
  try {
    const u = new URL(url);
    // For lib.ru, normalize to hostname + path
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}
