/**
 * URL-to-session cache: maps normalized URLs (per-user) to session IDs.
 * 6-hour TTL prevents stale sessions from being reused.
 */
import { normalizeUrl } from './url-utils.js';

// URL to session ID cache (for reusing existing analysis)
// Maps "uid:normalizedUrl" -> { sessionId, timestamp }
export const urlSessionCache = new Map();
const URL_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Check if we have a cached session for this URL and user.
 * @param {string} url - The URL to look up
 * @param {string} uid - User ID
 * @param {function} getAnalysisSession - Session lookup function (avoids circular dep)
 * @returns {Promise<{sessionId: string, session: object}|null>}
 */
export async function getCachedSession(url, uid, getAnalysisSession) {
  const normalizedUrl = normalizeUrl(url);
  const cacheKey = `${uid}:${normalizedUrl}`;
  const cached = urlSessionCache.get(cacheKey);

  if (!cached) return null;

  // Check if cache entry is expired
  if (Date.now() - cached.timestamp > URL_CACHE_TTL) {
    urlSessionCache.delete(cacheKey);
    return null;
  }

  // Verify session still exists
  const session = await getAnalysisSession(cached.sessionId);
  if (!session || session.status !== 'ready') {
    urlSessionCache.delete(cacheKey);
    return null;
  }

  console.log(`[Cache] Found cached session ${cached.sessionId} for ${cacheKey}`);
  return { sessionId: cached.sessionId, session };
}

/**
 * Cache a session for a URL + user combination
 */
export function cacheSessionUrl(url, sessionId, uid) {
  const normalizedUrl = normalizeUrl(url);
  const cacheKey = `${uid}:${normalizedUrl}`;
  urlSessionCache.set(cacheKey, {
    sessionId,
    timestamp: Date.now(),
  });
  console.log(`[Cache] Cached session ${sessionId} for ${cacheKey}`);
}
