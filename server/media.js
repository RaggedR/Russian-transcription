/**
 * Media processing barrel — re-exports all functions from server/media/ sub-modules.
 * Consumers (index.js, media.test.js, generate-demo.js) continue importing from './media.js'.
 */

// Pure text utilities
export { stripPunctuation, editDistance, isFuzzyMatch, estimateWordTimestamps, alignWhisperToOriginal } from './media/text-utils.js';

// Progress/heartbeat helpers and constants
export { BROWSER_UA, ESTIMATED_EXTRACTION_TIME, YTDLP_TIMEOUT_MS, mapProgress, computeRanges, createHeartbeat } from './media/progress-utils.js';

// Download (yt-dlp, ffmpeg)
export { getOkRuVideoInfo, downloadAudioChunk, downloadVideoChunk, getAudioDuration } from './media/download.js';

// Transcription (Whisper, GPT-4o)
export { transcribeAudioChunk, addPunctuation, lemmatizeWords } from './media/transcription.js';

// Text extraction (lib.ru)
export { isLibRuUrl, fetchLibRuText } from './media/text-extraction.js';

// TTS + alignment
export { generateTtsAudio, transcribeAndAlignTTS } from './media/tts.js';
