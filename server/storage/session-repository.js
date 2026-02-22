/**
 * Session CRUD operations with LRU memory cache and GCS persistence.
 * Owns the analysisSessions LRU cache and localSessions Map.
 */
import fs from 'fs';
import { LRUCache } from 'lru-cache';
import { isLocal, getBucket, deleteGcsFile } from './gcs.js';
import { cacheSessionUrl } from './url-cache.js';

// In-memory session storage for local development
export const localSessions = new Map();

// Analysis sessions (for chunking workflow) — LRU-bounded to prevent memory leaks
export const analysisSessions = new LRUCache({ max: 50 });

/**
 * Session storage - uses GCS in production, in-memory locally
 */
export async function saveSession(sessionId, data) {
  if (isLocal()) {
    localSessions.set(sessionId, data);
    return;
  }
  const bucket = getBucket();
  const file = bucket.file(`sessions/${sessionId}.json`);
  await file.save(JSON.stringify(data), {
    contentType: 'application/json',
    metadata: { cacheControl: 'no-cache' },
  });
  console.log(`[GCS] Session ${sessionId} saved`);
}

export async function getSession(sessionId) {
  if (isLocal()) {
    return localSessions.get(sessionId) || null;
  }
  try {
    const bucket = getBucket();
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
 * Delete a session and all its associated videos from GCS
 */
export async function deleteSessionAndVideos(sessionId) {
  const session = await getAnalysisSession(sessionId);
  const bucket = getBucket();

  if (!isLocal() && bucket && session) {
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

  if (isLocal()) {
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
  if (isLocal() || !getBucket()) {
    console.log('[Cleanup] Skipping cleanup in local mode');
    return;
  }

  const bucket = getBucket();
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
  if (isLocal() || !getBucket()) return;

  const bucket = getBucket();
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
