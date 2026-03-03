/**
 * In-memory library index — a browseable catalog of all sessions across all users.
 * Deduplicated by normalized URL (most recent session wins).
 * Rebuilt from GCS on startup; updated incrementally on session save/delete.
 */
import { normalizeUrl } from './url-utils.js';

// Map<normalizedUrl, LibraryEntry>
const libraryByUrl = new Map();

// Reverse lookup: sessionId → normalizedUrl (for efficient removal)
const sessionToUrl = new Map();

// Cached sorted array — invalidated on add/remove
let sortedCache = null;

/**
 * Add or update a library entry for a session.
 * Only keeps the most recent session per URL.
 */
export function addToLibrary(sessionId, session, createdAt) {
  if (!session.url || !session.title || session.status !== 'ready') return;

  const normalized = normalizeUrl(session.url);
  const entry = {
    sessionId,
    title: session.title,
    contentType: session.contentType || 'video',
    url: session.url,
    chunkCount: session.chunks?.length || 0,
    totalDuration: session.totalDuration || 0,
    hasMoreChunks: session.hasMoreChunks || false,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };

  const existing = libraryByUrl.get(normalized);
  if (existing && new Date(existing.createdAt) > new Date(entry.createdAt)) {
    // Existing entry is newer — only update the reverse lookup
    sessionToUrl.set(sessionId, normalized);
    return;
  }

  // Remove old session's reverse lookup if replacing
  if (existing) {
    sessionToUrl.delete(existing.sessionId);
  }

  libraryByUrl.set(normalized, entry);
  sessionToUrl.set(sessionId, normalized);
  sortedCache = null; // Invalidate
}

/**
 * Remove a session from the library.
 * If this was the canonical entry for its URL, the URL is removed from the index.
 */
export function removeFromLibrary(sessionId) {
  const normalized = sessionToUrl.get(sessionId);
  if (!normalized) return;

  sessionToUrl.delete(sessionId);

  const entry = libraryByUrl.get(normalized);
  if (entry && entry.sessionId === sessionId) {
    libraryByUrl.delete(normalized);
    sortedCache = null; // Invalidate
  }
}

/**
 * Get all library entries, sorted by createdAt descending (most recent first).
 * Caches the sorted result until the next add/remove.
 */
export function getLibraryEntries() {
  if (!sortedCache) {
    sortedCache = Array.from(libraryByUrl.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return sortedCache;
}
