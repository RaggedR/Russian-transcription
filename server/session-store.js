/**
 * Session storage: CRUD operations, caching, and GCS persistence.
 * Extracted from index.js for separation of concerns.
 */
import fs from 'fs';
import { LRUCache } from 'lru-cache';

// Initialized by init() from index.js
let bucket = null;
let IS_LOCAL = true;

/**
 * Initialize the session store with GCS config.
 * Must be called before using any storage functions.
 */
export function init({ bucket: b, isLocal }) {
  bucket = b;
  IS_LOCAL = isLocal;
}

// In-memory session storage for local development
export const localSessions = new Map();

// Analysis sessions (for chunking workflow) — LRU-bounded to prevent memory leaks
export const analysisSessions = new LRUCache({ max: 50 });

// URL to session ID cache (for reusing existing analysis)
// Maps normalized URL -> { sessionId, timestamp }
export const urlSessionCache = new Map();
const URL_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Translation cache — LRU-bounded to prevent unbounded growth
export const translationCache = new LRUCache({ max: 10000 });

// Extraction cache TTL (stream URLs expire after ~2-4 hours on ok.ru)
const EXTRACTION_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Generate a signed URL for a GCS file (24h expiry).
 * Requires the service account to have roles/iam.serviceAccountTokenCreator.
 */
export async function getSignedMediaUrl(gcsFileName) {
  const [signedUrl] = await bucket.file(gcsFileName).getSignedUrl({
    action: 'read',
    expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });
  return signedUrl;
}

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

/**
 * Get cached yt-dlp extraction info from GCS
 * Returns the info.json content if cached and not expired
 */
export async function getCachedExtraction(url) {
  const videoId = extractVideoId(url);
  if (!videoId || IS_LOCAL) return null;

  try {
    const file = bucket.file(`cache/extraction_${videoId}.json`);
    const [exists] = await file.exists();
    if (!exists) return null;

    const [metadata] = await file.getMetadata();
    const created = new Date(metadata.timeCreated);
    if (Date.now() - created.getTime() > EXTRACTION_CACHE_TTL) {
      // Expired, delete it
      await file.delete().catch(() => {});
      return null;
    }

    const [contents] = await file.download();
    console.log(`[Cache] Using cached extraction for ${videoId}`);
    return JSON.parse(contents.toString());
  } catch (err) {
    console.log(`[Cache] Extraction cache miss for ${videoId}:`, err.message);
    return null;
  }
}

/**
 * Save yt-dlp extraction info to GCS cache (minimal version)
 */
export async function cacheExtraction(url, infoJson) {
  const videoId = extractVideoId(url);
  if (!videoId || IS_LOCAL || !infoJson) return;

  try {
    // Only cache essential fields that yt-dlp needs for --load-info-json
    const minimalInfo = {
      id: infoJson.id,
      title: infoJson.title,
      duration: infoJson.duration,
      extractor: infoJson.extractor,
      extractor_key: infoJson.extractor_key,
      webpage_url: infoJson.webpage_url,
      original_url: infoJson.original_url,
      formats: infoJson.formats,  // Required for stream selection
      requested_formats: infoJson.requested_formats,
      // Skip: thumbnails, description, comments, subtitles, etc.
    };

    const file = bucket.file(`cache/extraction_${videoId}.json`);
    await file.save(JSON.stringify(minimalInfo), {
      contentType: 'application/json',
      metadata: { cacheControl: 'no-cache' },
    });

    const originalSize = JSON.stringify(infoJson).length;
    const minimalSize = JSON.stringify(minimalInfo).length;
    console.log(`[Cache] Saved extraction cache for ${videoId} (${Math.round(minimalSize/1024)}KB, was ${Math.round(originalSize/1024)}KB)`);
  } catch (err) {
    console.error(`[Cache] Failed to cache extraction:`, err.message);
  }
}

/**
 * Check if we have a cached session for this URL and user
 */
export async function getCachedSession(url, uid) {
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

/**
 * Session storage - uses GCS in production, in-memory locally
 */
export async function saveSession(sessionId, data) {
  if (IS_LOCAL) {
    localSessions.set(sessionId, data);
    return;
  }
  const file = bucket.file(`sessions/${sessionId}.json`);
  await file.save(JSON.stringify(data), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache' },
  });
  console.log(`[GCS] Session ${sessionId} saved`);
}

export async function getSession(sessionId) {
  if (IS_LOCAL) {
    return localSessions.get(sessionId) || null;
  }
  try {
    const file = bucket.file(`sessions/${sessionId}.json`);
    const [contents] = await file.download();
    return JSON.parse(contents.toString());
  } catch (err) {
    if (err.code === 404) return null;
    console.error(`[GCS] Error getting session ${sessionId}:`, err.message);
    return null;
  }
}

/**
 * Delete a file from GCS
 */
export async function deleteGcsFile(filePath) {
  if (IS_LOCAL) return;
  try {
    await bucket.file(filePath).delete();
    console.log(`[GCS] Deleted: ${filePath}`);
  } catch (err) {
    if (err.code !== 404) {
      console.error(`[GCS] Error deleting ${filePath}:`, err.message);
    }
  }
}

/**
 * Delete a session and all its associated videos from GCS
 */
export async function deleteSessionAndVideos(sessionId) {
  const session = await getAnalysisSession(sessionId);

  if (!IS_LOCAL && bucket && session) {
    // Delete all chunk videos
    if (session.chunks) {
      for (const chunk of session.chunks) {
        if (chunk.status === 'ready') {
          await deleteGcsFile(`videos/${sessionId}_${chunk.id}.mp4`);
        }
      }
    }
    // Delete session JSON
    await deleteGcsFile(`sessions/${sessionId}.json`);
  }

  // Clean up memory cache
  analysisSessions.delete(sessionId);

  if (IS_LOCAL) {
    // Clean up local files
    if (session?.chunks) {
      for (const chunk of session.chunks) {
        const videoKey = `video_${sessionId}_${chunk.id}`;
        const videoPath = localSessions.get(videoKey);
        if (videoPath && fs.existsSync(videoPath)) {
          fs.unlinkSync(videoPath);
        }
        localSessions.delete(videoKey);
      }
    }
    localSessions.delete(sessionId);
  }

  console.log(`[Session] Deleted session ${sessionId} and all associated videos`);
}

/**
 * Get session from memory cache first, then GCS
 * Also populates memory cache from GCS for faster subsequent access
 */
export async function getAnalysisSession(sessionId) {
  // Check memory cache first
  if (analysisSessions.has(sessionId)) {
    return analysisSessions.get(sessionId);
  }

  // Try loading from GCS
  const session = await getSession(sessionId);
  if (session) {
    // Restore Map objects that were serialized as arrays
    if (session.chunkTranscripts && Array.isArray(session.chunkTranscripts)) {
      session.chunkTranscripts = new Map(session.chunkTranscripts);
    } else if (!session.chunkTranscripts) {
      session.chunkTranscripts = new Map();
    }
    if (session.chunkTexts && Array.isArray(session.chunkTexts)) {
      session.chunkTexts = new Map(session.chunkTexts);
    }
    // Cache in memory for faster access
    analysisSessions.set(sessionId, session);
    console.log(`[Session] Restored session ${sessionId} from GCS`);
  }
  return session;
}

/**
 * Save session to both memory and GCS
 */
export async function setAnalysisSession(sessionId, session) {
  // Save to memory
  analysisSessions.set(sessionId, session);

  // Save to GCS (serialize Map to array for JSON)
  const sessionToSave = {
    ...session,
    chunkTranscripts: session.chunkTranscripts instanceof Map
      ? Array.from(session.chunkTranscripts.entries())
      : session.chunkTranscripts,
    chunkTexts: session.chunkTexts instanceof Map
      ? Array.from(session.chunkTexts.entries())
      : session.chunkTexts,
  };
  await saveSession(sessionId, sessionToSave);
}

/**
 * Clean up old sessions and videos from GCS (older than 7 days)
 * GCS lifecycle policy handles most cleanup, but this runs on startup as a backup
 */
export async function cleanupOldSessions() {
  if (IS_LOCAL || !bucket) {
    console.log('[Cleanup] Skipping cleanup in local mode');
    return;
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(Date.now() - SEVEN_DAYS_MS);

  try {
    console.log(`[Cleanup] Looking for sessions older than ${cutoffDate.toISOString()}`);

    // List all session files
    const [sessionFiles] = await bucket.getFiles({ prefix: 'sessions/' });
    let deletedCount = 0;

    for (const file of sessionFiles) {
      const [metadata] = await file.getMetadata();
      const created = new Date(metadata.timeCreated);

      if (created < cutoffDate) {
        // Extract sessionId from filename (sessions/1234567890.json -> 1234567890)
        const sessionId = file.name.replace('sessions/', '').replace('.json', '');

        // Delete associated videos
        const [videoFiles] = await bucket.getFiles({ prefix: `videos/${sessionId}_` });
        for (const videoFile of videoFiles) {
          await videoFile.delete().catch(() => {});
        }

        // Delete session file
        await file.delete().catch(() => {});
        deletedCount++;
        console.log(`[Cleanup] Deleted old session: ${sessionId}`);
      }
    }

    console.log(`[Cleanup] Complete. Deleted ${deletedCount} old sessions.`);
  } catch (err) {
    console.error('[Cleanup] Error during cleanup:', err.message);
  }
}

/**
 * Rebuild the in-memory URL → sessionId cache from GCS sessions.
 * Called on startup so that cached sessions survive cold starts and deploys.
 */
export async function rebuildUrlCache() {
  if (IS_LOCAL || !bucket) return;

  try {
    const [sessionFiles] = await bucket.getFiles({ prefix: 'sessions/' });
    let cached = 0;

    for (const file of sessionFiles) {
      try {
        const [contents] = await file.download();
        const session = JSON.parse(contents.toString());
        if (session.status === 'ready' && session.url && session.uid) {
          const sessionId = file.name.replace('sessions/', '').replace('.json', '');
          cacheSessionUrl(session.url, sessionId, session.uid);
          cached++;
        }
      } catch {
        // Skip unreadable sessions
      }
    }

    console.log(`[Startup] Rebuilt URL cache: ${cached} sessions`);
  } catch (err) {
    console.error('[Startup] Failed to rebuild URL cache:', err.message);
  }
}
