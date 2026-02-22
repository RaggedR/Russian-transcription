/**
 * Session store barrel — re-exports all functions from server/storage/ sub-modules.
 * Consumers (index.js, integration.test.js) continue importing from './session-store.js'.
 */

// GCS primitives
export { init, getSignedMediaUrl, deleteGcsFile } from './storage/gcs.js';

// URL utilities
export { extractVideoId, normalizeUrl } from './storage/url-utils.js';

// Caches
export { urlSessionCache, cacheSessionUrl } from './storage/url-cache.js';
export { getCachedExtraction, cacheExtraction } from './storage/extraction-cache.js';
export { translationCache } from './storage/translation-cache.js';

// Session CRUD
export {
  localSessions,
  analysisSessions,
  saveSession,
  getSession,
  deleteSessionAndVideos,
  getAnalysisSession,
  setAnalysisSession,
  cleanupOldSessions,
  rebuildUrlCache,
} from './storage/session-repository.js';

// Wrap getCachedSession to inject getAnalysisSession (breaks circular dependency
// between url-cache.js and session-repository.js)
import { getCachedSession as _getCachedSession } from './storage/url-cache.js';
import { getAnalysisSession } from './storage/session-repository.js';

export async function getCachedSession(url, uid) {
  return _getCachedSession(url, uid, getAnalysisSession);
}
