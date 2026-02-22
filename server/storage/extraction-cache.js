/**
 * yt-dlp extraction info cache in GCS.
 * Caches video stream metadata to skip the slow extraction phase on repeat downloads.
 * 2-hour TTL (ok.ru stream URLs expire after ~2-4 hours).
 */
import { extractVideoId } from './url-utils.js';
import { isLocal, getBucket } from './gcs.js';

// Extraction cache TTL (stream URLs expire after ~2-4 hours on ok.ru)
const EXTRACTION_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Get cached yt-dlp extraction info from GCS
 * Returns the info.json content if cached and not expired
 */
export async function getCachedExtraction(url) {
  const videoId = extractVideoId(url);
  if (!videoId || isLocal()) return null;

  const bucket = getBucket();
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
  if (!videoId || isLocal() || !infoJson) return;

  const bucket = getBucket();
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
