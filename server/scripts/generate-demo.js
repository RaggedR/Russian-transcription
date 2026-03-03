#!/usr/bin/env node

/**
 * Generate pre-processed demo content for first-time users.
 *
 * This script runs the normal transcription/TTS pipeline against two demo URLs,
 * saves the transcript JSON to server/demo/, and stores media files locally
 * (server/demo/media/) and optionally uploads them to GCS (demo/ prefix).
 *
 * Usage:
 *   cd server && node scripts/generate-demo.js [--video] [--text] [--upload-gcs]
 *                                               [--max-chunks N] [--resume]
 *
 * Flags:
 *   --video         Generate video demo (default if neither --video nor --text)
 *   --text          Generate text demo (default if neither --video nor --text)
 *   --upload-gcs    Upload media files to GCS after generation
 *   --max-chunks N  Limit to first N chunks (default: no limit, process everything)
 *   --resume        Resume from partial progress (skip already-processed chunks)
 *
 * Requires:
 *   - OPENAI_API_KEY in ../.env
 *   - Network access to ok.ru and lib.ru
 *   - yt-dlp and ffmpeg installed
 *   - (optional) GCS_BUCKET env var for --upload-gcs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Storage } from '@google-cloud/storage';
import {
  downloadAudioChunk,
  downloadVideoChunk,
  transcribeAudioChunk,
  addPunctuation,
  lemmatizeWords,
  getOkRuVideoInfo,
  isLibRuUrl,
  fetchLibRuText,
  generateTtsAudio,
  transcribeAndAlignTTS,
} from '../media.js';
import { createChunks, createTextChunks, getChunkTranscript } from '../chunking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..');
const demoDir = path.join(serverDir, 'demo');
const mediaDir = path.join(demoDir, 'media');
const tempDir = path.join(serverDir, 'temp');

dotenv.config({ path: path.join(serverDir, '..', '.env') });

const DEMO_VIDEO_URL = 'https://ok.ru/video/400776431053';
const DEMO_TEXT_URL = 'http://az.lib.ru/t/tolstoj_lew_nikolaewich/text_0080.shtml';

// Whisper API has a 25MB file limit; 10-min MP3 segments stay well under that
const SEGMENT_DURATION = 10 * 60;

const args = process.argv.slice(2);
const doVideo = args.includes('--video') || (!args.includes('--text'));
const doText = args.includes('--text') || (!args.includes('--video'));
const uploadGcs = args.includes('--upload-gcs');
const doResume = args.includes('--resume');

// Parse --max-chunks N
const maxChunksIdx = args.indexOf('--max-chunks');
const maxChunks = maxChunksIdx >= 0 ? parseInt(args[maxChunksIdx + 1], 10) : Infinity;
if (maxChunksIdx >= 0 && (!Number.isFinite(maxChunks) || maxChunks < 1)) {
  console.error('Error: --max-chunks requires a positive integer');
  process.exit(1);
}

// Ensure directories exist
for (const dir of [demoDir, mediaDir, tempDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// No-op progress callback for pipeline functions
const silentProgress = () => {};

async function generateVideoDemo() {
  console.log('\n=== Generating Video Demo ===');
  console.log(`URL: ${DEMO_VIDEO_URL}`);
  if (maxChunks < Infinity) console.log(`Max chunks: ${maxChunks}`);

  const partialPath = path.join(demoDir, 'demo-video.partial.json');
  let partial = null;

  if (doResume && fs.existsSync(partialPath)) {
    partial = JSON.parse(fs.readFileSync(partialPath, 'utf-8'));
    console.log(`  Resuming: ${partial.completedChunks.length}/${partial.demoChunks.length} chunks done`);
  }

  let info, transcript, demoChunks;
  // Persists across audio segments + video chunks for yt-dlp performance
  let cachedInfoPath = null;

  if (partial?.transcript) {
    // Resume: reuse saved transcript and chunks
    info = { title: partial.title, duration: partial.totalDuration };
    transcript = partial.transcript;
    demoChunks = partial.demoChunks;
  } else {
    // Step 1: Get video info
    console.log('[1/5] Fetching video info...');
    info = await getOkRuVideoInfo(DEMO_VIDEO_URL);
    const totalMin = Math.round(info.duration / 60);
    const numSegments = Math.ceil(info.duration / SEGMENT_DURATION);
    console.log(`  Title: ${info.title} (${totalMin} min, ${numSegments} segments)`);

    // Step 2: Download + transcribe audio in 10-min segments
    console.log(`[2/5] Downloading + transcribing audio (${numSegments} × ${SEGMENT_DURATION / 60} min)...`);
    const allWords = [];
    const allSegments = [];

    for (let start = 0; start < info.duration; start += SEGMENT_DURATION) {
      const end = Math.min(start + SEGMENT_DURATION, info.duration);
      const segPath = path.join(tempDir, `demo_video_seg_${start}.mp3`);
      const segNum = Math.floor(start / SEGMENT_DURATION) + 1;

      console.log(`  Segment ${segNum}/${numSegments}: ${Math.round(start / 60)}-${Math.round(end / 60)} min`);

      const isFirst = start === 0;
      await downloadAudioChunk(DEMO_VIDEO_URL, segPath, start, end, {
        onProgress: silentProgress,
        fetchInfo: isFirst,
        cachedInfoPath: isFirst ? null : cachedInfoPath,
      });

      // After first segment, grab the info JSON for subsequent downloads
      if (isFirst) {
        const infoJsonPath = segPath + '.info.json';
        if (fs.existsSync(infoJsonPath)) {
          cachedInfoPath = infoJsonPath;
          console.log('  Cached extraction info for subsequent downloads');
        }
      }

      console.log('  Transcribing segment...');
      const seg = await transcribeAudioChunk(segPath, { onProgress: silentProgress });

      // Offset timestamps to global timeline
      for (const w of seg.words) {
        allWords.push({ ...w, start: w.start + start, end: w.end + start });
      }
      for (const s of seg.segments) {
        allSegments.push({ ...s, start: s.start + start, end: s.end + start });
      }

      fs.unlinkSync(segPath);
      console.log(`  Segment ${segNum} done (${seg.words.length} words)`);
    }

    console.log(`  Total: ${allWords.length} words, ${allSegments.length} segments`);

    const rawTranscript = {
      words: allWords,
      segments: allSegments,
      language: 'ru',
      duration: info.duration,
    };

    // Step 3: Punctuate
    console.log('[3/5] Adding punctuation with GPT-4o...');
    transcript = await addPunctuation(rawTranscript, { onProgress: silentProgress });

    // Step 4: Create chunks
    console.log('[4/5] Creating chunks...');
    const allChunks = createChunks(transcript);
    demoChunks = maxChunks < Infinity ? allChunks.slice(0, maxChunks) : allChunks;
    console.log(`  ${allChunks.length} total chunks, keeping ${demoChunks.length}`);

    // Save partial progress (transcript + chunks, before expensive per-chunk work)
    const partialData = {
      title: info.title,
      totalDuration: info.duration,
      transcript,
      demoChunks,
      completedChunks: [],
      chunkTranscripts: [],
      gcsMediaKeys: {},
      localMediaFiles: {},
    };
    fs.writeFileSync(partialPath, JSON.stringify(partialData));
    console.log('  Saved partial progress (transcript + chunks)');
  }

  // Step 5: Download video for each chunk + lemmatize
  console.log(`[5/5] Downloading video chunks + lemmatizing (${demoChunks.length} chunks)...`);
  const gcsMediaKeys = partial?.gcsMediaKeys || {};
  const localMediaFiles = partial?.localMediaFiles || {};
  const chunkTranscripts = partial?.chunkTranscripts || [];
  const completedChunkIds = new Set(partial?.completedChunks || []);

  for (const chunk of demoChunks) {
    if (completedChunkIds.has(chunk.id)) {
      console.log(`  Chunk ${chunk.id}: already done (resuming)`);
      continue;
    }

    const videoFilename = `demo-video-${chunk.id}.mp4`;
    const videoPath = path.join(mediaDir, videoFilename);

    console.log(`  Chunk ${chunk.id} [${chunk.index + 1}/${demoChunks.length}]: ${Math.round(chunk.startTime)}s - ${Math.round(chunk.endTime)}s`);

    // Download video segment (reuse cached info from audio download if available)
    await downloadVideoChunk(DEMO_VIDEO_URL, videoPath, chunk.startTime, chunk.endTime, {
      onProgress: silentProgress,
      partNum: chunk.index + 1,
      cachedInfoPath,
    });

    // Get chunk transcript and lemmatize
    const rawChunkTranscript = getChunkTranscript(transcript, chunk.startTime, chunk.endTime);
    const chunkTranscript = await lemmatizeWords(rawChunkTranscript, { onProgress: silentProgress });

    chunkTranscripts.push([chunk.id, chunkTranscript]);
    gcsMediaKeys[chunk.id] = `demo/${videoFilename}`;
    localMediaFiles[chunk.id] = videoFilename;
    completedChunkIds.add(chunk.id);

    // Save partial progress after each chunk
    const partialData = {
      title: info.title,
      totalDuration: info.duration,
      transcript,
      demoChunks,
      completedChunks: [...completedChunkIds],
      chunkTranscripts,
      gcsMediaKeys,
      localMediaFiles,
    };
    fs.writeFileSync(partialPath, JSON.stringify(partialData));
    console.log(`  Progress saved (${completedChunkIds.size}/${demoChunks.length} chunks)`);
  }

  // Clean up cached extraction info
  if (cachedInfoPath && fs.existsSync(cachedInfoPath)) {
    fs.unlinkSync(cachedInfoPath);
  }

  const lastChunk = demoChunks[demoChunks.length - 1];
  const lastChunkEndTime = lastChunk ? lastChunk.endTime : 0;
  const moreAvailable = lastChunkEndTime < info.duration;

  const demoData = {
    title: info.title,
    contentType: 'video',
    totalDuration: info.duration,
    originalUrl: DEMO_VIDEO_URL,
    hasMoreChunks: moreAvailable,
    nextBatchStartTime: moreAvailable ? lastChunkEndTime : null,
    transcript,
    chunks: demoChunks.map(c => ({
      id: c.id,
      index: c.index,
      startTime: c.startTime,
      endTime: c.endTime,
      duration: c.duration,
      previewText: c.previewText,
      wordCount: c.wordCount,
      status: 'ready',
    })),
    chunkTranscripts,
    gcsMediaKeys,
    localMediaFiles,
  };

  const jsonPath = path.join(demoDir, 'demo-video.json');
  fs.writeFileSync(jsonPath, JSON.stringify(demoData, null, 2));
  console.log(`\nSaved: ${jsonPath}`);
  console.log(`Media files in: ${mediaDir}`);

  // Clean up partial file
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);

  return demoData;
}

async function generateTextDemo() {
  console.log('\n=== Generating Text Demo ===');
  console.log(`URL: ${DEMO_TEXT_URL}`);
  if (maxChunks < Infinity) console.log(`Max chunks: ${maxChunks}`);

  const partialPath = path.join(demoDir, 'demo-text.partial.json');
  let partial = null;

  if (doResume && fs.existsSync(partialPath)) {
    partial = JSON.parse(fs.readFileSync(partialPath, 'utf-8'));
    console.log(`  Resuming: ${partial.completedChunks.length}/${partial.demoTextChunks.length} chunks done`);
  }

  let displayTitle, demoTextChunks, rawText;

  if (partial?.demoTextChunks) {
    // Resume: reuse saved chunks
    displayTitle = partial.title;
    demoTextChunks = partial.demoTextChunks;
    rawText = partial.rawText;
  } else {
    // Step 1: Fetch text
    console.log('[1/3] Fetching text from lib.ru...');
    const { title, author, text } = await fetchLibRuText(DEMO_TEXT_URL);
    displayTitle = author ? `${author} — ${title}` : title;
    rawText = text;
    console.log(`  Title: ${displayTitle} (${text.length} chars)`);

    // Step 2: Create text chunks
    console.log('[2/3] Creating text chunks...');
    const allTextChunks = createTextChunks(text);
    demoTextChunks = maxChunks < Infinity ? allTextChunks.slice(0, maxChunks) : allTextChunks;
    console.log(`  ${allTextChunks.length} total chunks, keeping ${demoTextChunks.length}`);

    // Save partial progress
    const partialData = {
      title: displayTitle,
      rawText,
      demoTextChunks,
      completedChunks: [],
      chunkTranscripts: [],
      chunkTexts: [],
      gcsMediaKeys: {},
      localMediaFiles: {},
    };
    fs.writeFileSync(partialPath, JSON.stringify(partialData));
  }

  // Step 3: Generate TTS + timestamps for each chunk
  console.log(`[3/3] Generating TTS + timestamps + lemmatization (${demoTextChunks.length} chunks)...`);
  const gcsMediaKeys = partial?.gcsMediaKeys || {};
  const localMediaFiles = partial?.localMediaFiles || {};
  const chunkTranscripts = partial?.chunkTranscripts || [];
  const chunkTexts = partial?.chunkTexts || [];
  const completedChunkIds = new Set(partial?.completedChunks || []);

  for (const chunk of demoTextChunks) {
    if (completedChunkIds.has(chunk.id)) {
      console.log(`  Chunk ${chunk.id}: already done (resuming)`);
      continue;
    }

    const audioFilename = `demo-text-${chunk.id}.mp3`;
    const audioPath = path.join(mediaDir, audioFilename);

    console.log(`  Chunk ${chunk.id} [${chunk.index + 1}/${demoTextChunks.length}]: ${chunk.text.length} chars`);

    // Generate TTS
    await generateTtsAudio(chunk.text, audioPath, { onProgress: silentProgress });

    // Transcribe TTS audio with Whisper for real word timestamps (costs ~$0.006/min)
    const rawChunkTranscript = await transcribeAndAlignTTS(chunk.text, audioPath);

    // Lemmatize
    const chunkTranscript = await lemmatizeWords(rawChunkTranscript, { onProgress: silentProgress });

    chunkTranscripts.push([chunk.id, chunkTranscript]);
    chunkTexts.push([chunk.id, chunk.text]);
    gcsMediaKeys[chunk.id] = `demo/${audioFilename}`;
    localMediaFiles[chunk.id] = audioFilename;
    completedChunkIds.add(chunk.id);

    // Save partial progress after each chunk
    const partialData = {
      title: displayTitle,
      demoTextChunks,
      completedChunks: [...completedChunkIds],
      chunkTranscripts,
      chunkTexts,
      gcsMediaKeys,
      localMediaFiles,
    };
    fs.writeFileSync(partialPath, JSON.stringify(partialData));
    console.log(`  Progress saved (${completedChunkIds.size}/${demoTextChunks.length} chunks)`);
  }

  const demoData = {
    title: displayTitle,
    contentType: 'text',
    totalDuration: 0,
    originalUrl: DEMO_TEXT_URL,
    hasMoreChunks: false,
    rawText,
    chunks: demoTextChunks.map(c => ({
      id: c.id,
      index: c.index,
      startTime: 0,
      endTime: 0,
      duration: 0,
      previewText: c.previewText,
      wordCount: c.wordCount,
      status: 'ready',
    })),
    chunkTranscripts,
    chunkTexts,
    gcsMediaKeys,
    localMediaFiles,
  };

  const jsonPath = path.join(demoDir, 'demo-text.json');
  fs.writeFileSync(jsonPath, JSON.stringify(demoData, null, 2));
  console.log(`\nSaved: ${jsonPath}`);
  console.log(`Media files in: ${mediaDir}`);

  // Clean up partial file
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);

  return demoData;
}

async function uploadToGcs(demoData) {
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    console.log('Skipping GCS upload (no GCS_BUCKET env var)');
    return;
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  for (const [chunkId, gcsKey] of Object.entries(demoData.gcsMediaKeys)) {
    const localFile = demoData.localMediaFiles[chunkId];
    const localPath = path.join(mediaDir, localFile);

    if (!fs.existsSync(localPath)) {
      console.log(`  Skipping ${localFile} (not found locally)`);
      continue;
    }

    const contentType = gcsKey.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
    console.log(`  Uploading ${localFile} → gs://${bucketName}/${gcsKey}`);
    await bucket.upload(localPath, {
      destination: gcsKey,
      metadata: { contentType, cacheControl: 'public, max-age=604800' },
    });
  }

  console.log('GCS upload complete');
}

async function main() {
  console.log('Demo Content Generator');
  console.log('======================');
  if (maxChunks < Infinity) console.log(`Chunk limit: ${maxChunks}`);
  if (doResume) console.log('Resume mode: ON');

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not set in .env');
    process.exit(1);
  }

  if (doVideo) {
    const videoData = await generateVideoDemo();
    if (uploadGcs) await uploadToGcs(videoData);
  }

  if (doText) {
    const textData = await generateTextDemo();
    if (uploadGcs) await uploadToGcs(textData);
  }

  console.log('\nDone! Commit server/demo/demo-*.json (media files are gitignored).');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
