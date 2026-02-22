/**
 * Text-to-Speech generation and Whisper alignment.
 * Generates audio from text and aligns timestamps back to original words.
 */
import fs from 'fs';
import OpenAI from 'openai';
import { pipeline } from 'stream/promises';
import { createHeartbeat } from './progress-utils.js';
import { transcribeAudioChunk } from './transcription.js';
import { alignWhisperToOriginal } from './text-utils.js';

/**
 * Generate TTS audio from text using OpenAI TTS API.
 * @param {string} text - Text to convert to speech
 * @param {string} outputPath - Output file path (MP3)
 * @param {object} options
 * @param {string} options.apiKey - OpenAI API key
 * @param {function} options.onProgress - Progress callback
 * @returns {Promise<{size: number}>}
 */
export async function generateTtsAudio(text, outputPath, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    onProgress = () => {},
  } = options;

  if (!apiKey) {
    throw new Error('OpenAI API key is required');
  }

  // Over-estimate TTS time: ~1s per 70 chars (empirical: 2477 chars = 30s, 3432 chars = 48s)
  // Better to reach ~70% and jump to 100% than hang at 95%
  const estimatedSeconds = Math.max(5, Math.round(text.length / 70));
  console.log(`[TTS] Generating speech for ${text.length} chars (est. ${estimatedSeconds}s)...`);

  const heartbeat = createHeartbeat(
    onProgress,
    'tts',
    (ticks) => {
      const elapsed = ticks / 2; // 500ms ticks
      const pct = Math.min(95, Math.round((elapsed / estimatedSeconds) * 100));
      return { percent: pct, message: `Generating speech... ${elapsed.toFixed(0)}s / ~${estimatedSeconds}s` };
    },
    500, // tick every 500ms for smooth progress
  );

  const openai = new OpenAI({ apiKey });
  const ttsStart = Date.now();
  try {
    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      response_format: 'mp3',
    });

    // Stream response body to file
    // OpenAI SDK returns a Node.js PassThrough stream, not a web ReadableStream
    const fileStream = fs.createWriteStream(outputPath);
    await pipeline(response.body, fileStream);
  } finally {
    heartbeat.stop();
  }

  const elapsed = ((Date.now() - ttsStart) / 1000).toFixed(1);
  const stats = fs.statSync(outputPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  console.log(`[TTS] Done: ${sizeMB} MB in ${elapsed}s`);
  onProgress('tts', 100, 'complete', `Speech generated (${sizeMB} MB)`);

  return { size: stats.size };
}

/**
 * Transcribe TTS audio with Whisper and align back to original text.
 * Produces accurate word-level timestamps instead of character-proportional estimates.
 *
 * @param {string} text - Original text that was synthesized to audio
 * @param {string} audioPath - Path to the TTS audio file
 * @param {object} options - Passed through to transcribeAudioChunk (onProgress, apiKey, language)
 * @returns {Promise<{words: Array<{word: string, start: number, end: number}>, segments: Array, language: string, duration: number}>}
 */
export async function transcribeAndAlignTTS(text, audioPath, options = {}) {
  const whisperResult = await transcribeAudioChunk(audioPath, options);

  const originalWords = text.split(/\s+/).filter(w => w.length > 0);
  const alignedWords = alignWhisperToOriginal(whisperResult.words, originalWords);

  // Build segments (~20 words each), same shape as estimateWordTimestamps
  const segments = [];
  for (let i = 0; i < alignedWords.length; i += 20) {
    const segWords = alignedWords.slice(i, i + 20);
    segments.push({
      text: segWords.map(w => w.word).join('').trim(),
      start: segWords[0].start,
      end: segWords[segWords.length - 1].end,
    });
  }

  return {
    words: alignedWords,
    segments,
    language: whisperResult.language || 'ru',
    duration: whisperResult.duration,
  };
}
