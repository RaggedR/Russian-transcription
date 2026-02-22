/**
 * Google Cloud Storage primitives.
 * Owns bucket reference and IS_LOCAL state. All other storage modules import from here.
 */
// Initialized by init() from index.js
let bucket = null;
let IS_LOCAL = true;

/**
 * Initialize the storage layer with GCS config.
 * Must be called before using any storage functions.
 */
export function init({ bucket: b, isLocal }) {
  bucket = b;
  IS_LOCAL = isLocal;
}

/** @returns {boolean} Whether running in local (non-GCS) mode */
export function isLocal() {
  return IS_LOCAL;
}

/** @returns {object|null} The GCS bucket reference */
export function getBucket() {
  return bucket;
}

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
