import fs from 'fs';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import ytdlpBase from 'yt-dlp-exec';
import { formatTime } from './chunking.js';

// Use system yt-dlp binary instead of bundled one
const ytdlp = ytdlpBase.create('yt-dlp');

// ok.ru extraction typically takes 90-120 seconds due to their anti-bot JS protection
const ESTIMATED_EXTRACTION_TIME = 100; // seconds

/**
 * Fast info fetch for ok.ru videos by scraping OG meta tags (~4-5s vs yt-dlp's ~15s)
 * @param {string} url - ok.ru video URL
 * @returns {Promise<{title: string, duration: number}>}
 */
export async function getOkRuVideoInfo(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ok.ru page: ${response.status}`);
  }

  const html = await response.text();

  // Extract from Open Graph meta tags
  const titleMatch = html.match(/<meta property="og:title" content="([^"]*)"/);
  const durationMatch = html.match(/<meta property="og:video:duration" content="([^"]*)"/);

  return {
    title: titleMatch ? titleMatch[1] : 'Untitled Video',
    duration: durationMatch ? parseInt(durationMatch[1]) : 0,
  };
}

/**
 * Create a heartbeat interval that calls onProgress with incrementing seconds.
 * Returns an object with stop() method and isStopped() check.
 * @param {function} onProgress - Progress callback (type, percent, status, message)
 * @param {string} type - Progress type ('audio', 'video', 'transcription')
 * @param {function} messageBuilder - Function that takes seconds and returns {percent, message} or just message string
 * @param {number} intervalMs - Interval in milliseconds (default: 1000)
 * @returns {{stop: function, isStopped: function, getSeconds: function}}
 */
export function createHeartbeat(onProgress, type, messageBuilder, intervalMs = 1000) {
  let seconds = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (!stopped) {
      seconds++;
      const result = messageBuilder(seconds);
      // Support both string (old style) and {percent, message} (new style)
      if (typeof result === 'object' && result !== null) {
        onProgress(type, result.percent || 0, 'active', result.message);
      } else if (result) {
        onProgress(type, 0, 'active', result);
      }
    }
  }, intervalMs);

  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        clearInterval(interval);
      }
    },
    isStopped: () => stopped,
    getSeconds: () => seconds,
  };
}

/**
 * Download audio chunk using yt-dlp
 * @param {string} url - Video URL
 * @param {string} outputPath - Output file path
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {object} options - Options
 * @param {function} options.onProgress - Progress callback (type, percent, status, message)
 * @returns {Promise<{size: number}>} - File size in bytes
 */
export async function downloadAudioChunk(url, outputPath, startTime, endTime, options = {}) {
  const { onProgress = () => {}, fetchInfo = false, cachedInfoPath = null } = options;
  const duration = endTime - startTime;
  const sectionSpec = `*${formatTime(startTime)}-${formatTime(endTime)}`;
  const targetDuration = formatTime(duration);

  // Heartbeat with phase-aware messages and estimated progress during extraction
  let phase = 'connecting';
  const heartbeat = createHeartbeat(
    onProgress,
    'audio',
    (s) => {
      if (phase === 'connecting' || phase === 'extracting') {
        // Show estimated progress during extraction (cap at 45% to leave room for download)
        const estimatedPercent = Math.min(45, Math.round((s / ESTIMATED_EXTRACTION_TIME) * 50));
        const remaining = Math.max(0, ESTIMATED_EXTRACTION_TIME - s);
        const msg = `Step 1/3: Finding video stream... ${s}s (~${remaining}s remaining)`;
        return { percent: estimatedPercent, message: msg };
      }
      if (phase === 'starting') {
        return { percent: 50, message: `Step 2/3: Starting download... (${s}s)` };
      }
      return { percent: 50, message: `Processing... (${s}s)` };
    }
  );

  onProgress('audio', 0, 'active', `Step 1/3: Finding video stream...`);

  // Build args - optionally include --write-info-json to get metadata during download
  const infoJsonPath = fetchInfo ? outputPath + '.info.json' : null;
  const cacheDir = '/tmp/yt-dlp-cache';
  const args = [
    url,
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '8',  // Low quality is fine for speech transcription
    '--concurrent-fragments', '4',
    '--output', outputPath,
    '--no-warnings',
    '--download-sections', sectionSpec,
    '--newline',
    '--cache-dir', cacheDir,  // Cache extraction data for faster repeated access
  ];

  if (fetchInfo) {
    // --write-info-json writes metadata BEFORE download starts (saves ~15s separate call)
    args.push('--write-info-json');
  }

  // Use cached extraction info to skip the slow extraction phase
  if (cachedInfoPath && fs.existsSync(cachedInfoPath)) {
    args.push('--load-info-json', cachedInfoPath);
    // Using cached extraction - progress will show in sendProgress
    // Skip directly to download phase since extraction is cached
    phase = 'starting';
    onProgress('audio', 50, 'active', 'Step 1/3: Using cached video info...');
  }

  let videoInfo = null;

  await new Promise((resolve, reject) => {
    const ytdlpProc = spawn('yt-dlp', args);

    let lastProgress = 0;
    let lastAudioSize = 0;

    // Monitor file size during download (check for partial files too)
    const audioMonitor = setInterval(() => {
      try {
        // yt-dlp may use .part files or temp files during download
        const possiblePaths = [
          outputPath,
          outputPath + '.part',
          outputPath.replace('.mp3', '.m4a'),
          outputPath.replace('.mp3', '.m4a.part'),
          outputPath.replace('.mp3', '.webm'),
          outputPath.replace('.mp3', '.webm.part'),
        ];

        for (const checkPath of possiblePaths) {
          if (fs.existsSync(checkPath)) {
            const stats = fs.statSync(checkPath);
            if (stats.size > 0 && stats.size !== lastAudioSize) {
              lastAudioSize = stats.size;
              const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
              // Only show size if we're past the extraction phase
              if (phase === 'starting' || phase === 'downloading') {
                phase = 'downloading';
                heartbeat.stop();
                onProgress('audio', Math.max(lastProgress, 10), 'active',
                  `Step 2/3: Downloading audio... (${sizeMB} MB)`);
              }
            }
            break;
          }
        }
      } catch (e) {
        // Ignore file access errors
      }
    }, 1000);

    // Parse stdout for phase info (yt-dlp outputs status messages here)
    ytdlpProc.stdout.on('data', (data) => {
      const line = data.toString();
      if (line.includes('Extracting URL') || line.includes('Downloading webpage')) {
        phase = 'extracting';
      } else if (line.includes('Downloading') && (line.includes('m3u8') || line.includes('MPD'))) {
        phase = 'extracting';
      } else if (line.includes('Destination:') || line.includes('format(s)')) {
        phase = 'starting';
        heartbeat.stop();
        onProgress('audio', 5, 'active', 'Step 2/3: Starting download...');
      }
    });

    ytdlpProc.stderr.on('data', (data) => {
      const line = data.toString();

      // Try to read info.json as soon as it's written (before download starts)
      if (fetchInfo && !videoInfo && infoJsonPath && fs.existsSync(infoJsonPath)) {
        try {
          const infoJson = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
          videoInfo = {
            title: infoJson.title || 'Untitled Video',
            duration: infoJson.duration || 0,
          };
        } catch (e) {
          // Info file not ready yet, will try again
        }
      }

      // Detect finalization phase (after download, during ffmpeg conversion)
      if (line.includes('Deleting original file') || line.includes('Post-process')) {
        heartbeat.stop();
        onProgress('audio', 99, 'active', 'Step 2/3: Finalizing audio...');
        return;
      }

      const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        // Stop heartbeat on first real progress
        heartbeat.stop();
        phase = 'downloading';
        const hours = parseInt(timeMatch[1]);
        const mins = parseInt(timeMatch[2]);
        const secs = parseInt(timeMatch[3]);
        const currentSecs = hours * 3600 + mins * 60 + secs;
        // Cap at 95% to leave room for finalization message
        const percent = Math.min(95, Math.round((currentSecs / duration) * 100));
        if (percent > lastProgress) {
          lastProgress = percent;
          const timeMsg = `${formatTime(currentSecs)} / ${targetDuration}`;
          const sizeMsg = lastAudioSize > 0 ? ` (${(lastAudioSize / 1024 / 1024).toFixed(1)} MB)` : '';
          onProgress('audio', percent, 'active', `Step 2/3: Downloading audio... ${timeMsg}${sizeMsg}`);
        }
      }
    });

    ytdlpProc.on('close', (code) => {
      heartbeat.stop();
      clearInterval(audioMonitor);
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });

    ytdlpProc.on('error', (err) => {
      heartbeat.stop();
      clearInterval(audioMonitor);
      reject(err);
    });
  });

  // Final attempt to read info if not yet read
  if (fetchInfo && !videoInfo && infoJsonPath && fs.existsSync(infoJsonPath)) {
    try {
      const infoJson = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
      videoInfo = {
        title: infoJson.title || 'Untitled Video',
        duration: infoJson.duration || 0,
      };
      // Clean up info file
      fs.unlinkSync(infoJsonPath);
    } catch (e) {
      // Ignore
    }
  } else if (infoJsonPath && fs.existsSync(infoJsonPath)) {
    // Clean up info file even if we didn't need it
    fs.unlinkSync(infoJsonPath);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Audio download failed - file not found');
  }

  const stats = fs.statSync(outputPath);
  if (stats.size < 1000) {
    throw new Error(`Audio file too small (${stats.size} bytes) - download may have failed`);
  }

  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  onProgress('audio', 100, 'complete', `Step 2/3 complete: Audio ready (${sizeMB} MB)`);

  return { size: stats.size, info: videoInfo };
}

/**
 * Download video chunk using yt-dlp
 * @param {string} url - Video URL
 * @param {string} outputPath - Output file path
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {object} options - Options
 * @param {function} options.onProgress - Progress callback (type, percent, status, message)
 * @param {number} options.partNum - Part number for display (default: 1)
 * @returns {Promise<{size: number}>} - File size in bytes
 */
export async function downloadVideoChunk(url, outputPath, startTime, endTime, options = {}) {
  const { onProgress = () => {}, partNum = 1, cachedInfoPath = null } = options;
  const sectionSpec = `*${formatTime(startTime)}-${formatTime(endTime)}`;

  let phase = cachedInfoPath && fs.existsSync(cachedInfoPath) ? 'starting' : 'extracting';

  // Heartbeat with estimated progress during extraction
  const heartbeat = createHeartbeat(
    onProgress,
    'video',
    (s) => {
      if (phase === 'extracting') {
        const estimatedPercent = Math.min(45, Math.round((s / ESTIMATED_EXTRACTION_TIME) * 50));
        const remaining = Math.max(0, ESTIMATED_EXTRACTION_TIME - s);
        const msg = `Part ${partNum}: Finding stream... ${s}s (~${remaining}s remaining)`;
        return { percent: estimatedPercent, message: msg };
      }
      if (phase === 'starting') {
        return { percent: 50, message: `Part ${partNum}: Starting download... (${s}s)` };
      }
      return { percent: 55, message: `Part ${partNum}: Downloading... (${s}s)` };
    }
  );

  if (phase === 'extracting') {
    onProgress('video', 0, 'active', `Part ${partNum}: Finding stream...`);
  } else {
    onProgress('video', 50, 'active', `Part ${partNum}: Using cached info...`);
  }

  let lastVideoSize = 0;
  const videoMonitor = setInterval(() => {
    try {
      const partPath = outputPath + '.part';
      const checkPath = fs.existsSync(partPath) ? partPath : (fs.existsSync(outputPath) ? outputPath : null);
      if (checkPath) {
        const stats = fs.statSync(checkPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        // Stop heartbeat once download actually starts
        if (stats.size > 0) {
          heartbeat.stop();
          phase = 'downloading';
        }
        if (stats.size !== lastVideoSize) {
          lastVideoSize = stats.size;
          onProgress('video', 60, 'active', `Part ${partNum}: Downloading... (${sizeMB} MB)`);
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }, 1000);

  // Build yt-dlp options
  const ytdlpOptions = {
    format: 'worst[ext=mp4]/worst',
    output: outputPath,
    noWarnings: true,
    downloadSections: sectionSpec,
    forceKeyframesAtCuts: true,
    cacheDir: '/tmp/yt-dlp-cache',
    concurrentFragments: 4,
  };

  // Use cached extraction info to skip slow extraction phase
  if (cachedInfoPath && fs.existsSync(cachedInfoPath)) {
    ytdlpOptions.loadInfoJson = cachedInfoPath;
    // Using cached extraction - progress will show in sendProgress
  }

  try {
    await ytdlp(url, ytdlpOptions);
  } finally {
    heartbeat.stop();
    clearInterval(videoMonitor);
  }

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  const sizeMB = (size / 1024 / 1024).toFixed(1);
  onProgress('video', 100, 'complete', `Video ready (${sizeMB} MB)`);

  return { size };
}

/**
 * Transcribe audio chunk using OpenAI Whisper
 * @param {string} audioPath - Path to audio file
 * @param {object} options - Options
 * @param {function} options.onProgress - Progress callback (type, percent, status, message)
 * @param {string} options.apiKey - OpenAI API key (defaults to env var)
 * @param {string} options.language - Language code (default: 'ru')
 * @returns {Promise<{words: Array, segments: Array, language: string, duration: number}>}
 */
export async function transcribeAudioChunk(audioPath, options = {}) {
  const {
    onProgress = () => {},
    apiKey = process.env.OPENAI_API_KEY,
    language = 'ru',
  } = options;

  if (!apiKey) {
    throw new Error('OpenAI API key is required');
  }

  const stats = fs.statSync(audioPath);
  const sizeMB = stats.size / 1024 / 1024;
  const sizeMBStr = sizeMB.toFixed(1);

  // Generous estimate: ~7 seconds per MB of audio
  // This ensures progress bar jumps from ~80% to complete rather than hanging at 95%
  const estimatedSeconds = Math.max(Math.round(sizeMB * 7), 45);

  const startTime = Date.now();
  onProgress('transcription', 0, 'active',
    `Step 3/3: Transcribing ${sizeMBStr} MB... (estimated ~${estimatedSeconds}s)`);

  const transcribeInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, estimatedSeconds - elapsed);
    // Cap at 85% so there's a visible jump to 100% when complete
    const percent = Math.min(85, Math.round((elapsed / estimatedSeconds) * 100));
    onProgress('transcription', percent, 'active',
      `Step 3/3: Transcribing... ${elapsed}s elapsed, ~${remaining}s remaining`);
  }, 2000);

  const openai = new OpenAI({ apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.log(`[Transcribe] Aborting after 5 minutes`);
    controller.abort();
  }, 5 * 60 * 1000);

  let transcription;
  try {
    transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      language,
    }, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    clearInterval(transcribeInterval);
  }

  const actualTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Transcribe] Complete in ${actualTime}s`);
  onProgress('transcription', 100, 'complete', `Step 3/3 complete: Transcribed in ${actualTime}s`);

  return {
    words: transcription.words || [],
    segments: transcription.segments || [],
    language: transcription.language || language,
    duration: transcription.duration || 0,
  };
}

/**
 * Strip punctuation from the edges of a word (for matching purposes)
 * Handles Russian and common punctuation: . , ! ? ; : — – - « » " ' ( ) …
 */
export function stripPunctuation(word) {
  return word.replace(/^[.,!?;:—–\-«»""''()…\s]+|[.,!?;:—–\-«»""''()…\s]+$/g, '');
}

/**
 * Levenshtein edit distance between two strings (O(min(n,m)) space).
 * Uses a rolling 2-row approach instead of a full matrix.
 */
export function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for O(min(n,m)) space
  if (a.length > b.length) [a, b] = [b, a];

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let curr = new Array(a.length + 1);

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

/**
 * Check if two words are a fuzzy match (likely a spelling correction).
 * Allows up to ~30% character difference for words of 4+ characters.
 */
export function isFuzzyMatch(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  const dist = editDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return dist <= Math.max(2, Math.floor(maxLen * 0.3));
}

/**
 * Add punctuation and fix spelling errors in a Whisper transcript using GPT-4o.
 * Takes the raw words, sends text to the LLM, and maps corrected words back
 * to the original WordTimestamp array using fuzzy matching.
 *
 * @param {Object} transcript - Whisper transcript { words, segments, language, duration }
 * @param {Object} options
 * @param {string} options.apiKey - OpenAI API key
 * @param {function} options.onProgress - Progress callback
 * @returns {Promise<Object>} - Transcript with punctuated words and segments
 */
export async function addPunctuation(transcript, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    onProgress = () => {},
  } = options;

  if (!apiKey || !transcript.words || transcript.words.length === 0) {
    return transcript;
  }

  const startTime = Date.now();
  const totalWords = transcript.words.length;
  onProgress('punctuation', 0, 'active', `Adding punctuation to ${totalWords} words...`);

  const openai = new OpenAI({ apiKey });

  // Process in batches of ~500 words to stay within token limits
  const BATCH_SIZE = 500;
  const punctuatedWords = [];

  for (let i = 0; i < transcript.words.length; i += BATCH_SIZE) {
    const batchWords = transcript.words.slice(i, i + BATCH_SIZE);
    // Whisper words have leading spaces (e.g. " привет") — trim before joining
    const batchText = batchWords.map(w => w.word.trim()).join(' ');

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(transcript.words.length / BATCH_SIZE);
    const percent = Math.round((i / transcript.words.length) * 80);
    onProgress('punctuation', percent, 'active',
      `Adding punctuation... (batch ${batchNum}/${totalBatches})`);

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `You are a punctuation and spelling restoration tool for transcribed spoken Russian. The text comes from speech recognition (Whisper) and has no punctuation. It may also contain transcription errors.

This is spoken dialogue, so expect short sentences, questions, exclamations, and commands. Err on the side of MORE punctuation — prefer splitting into shorter sentences over long run-on sentences.

Rules:
- Add punctuation marks to words (. , ! ? : ; — «»)
- Capitalize the first word of each sentence
- Add periods at natural sentence boundaries — spoken Russian has many short sentences
- Use commas generously for pauses, vocatives, and subordinate clauses
- Use dashes (—) to separate abrupt shifts or consequences within a sentence
- Use ! for commands, exclamations, and urgent speech
- Use ? for questions
- Fix obvious transcription/spelling errors (e.g. "пограмма" → "программа", "скажым" → "скажем")
- Do NOT add, remove, or reorder words — only correct misspellings of existing words
- Do NOT change words that are already correctly spelled, even if unusual
- Return ONLY the corrected and punctuated text, nothing else`,
          },
          {
            role: 'user',
            content: batchText,
          },
        ],
      });

      const punctuatedText = response.choices[0].message.content.trim();
      const punctuatedBatch = punctuatedText.split(/\s+/);

      console.log(`[Punctuation] Batch ${batchNum}: sent ${batchWords.length} words, got ${punctuatedBatch.length} back`);
      console.log(`[Punctuation] First 5 original: ${batchWords.slice(0, 5).map(w => `"${w.word.trim()}"`).join(', ')}`);
      console.log(`[Punctuation] First 5 returned: ${punctuatedBatch.slice(0, 5).map(w => `"${w}"`).join(', ')}`);

      // Two-pointer alignment: walk through both arrays matching by base word.
      // Tolerates the LLM occasionally splitting or merging words.
      let oi = 0; // original index
      let pi = 0; // punctuated index
      let matched = 0;

      while (oi < batchWords.length) {
        const original = batchWords[oi];
        const leadingSpace = original.word.match(/^\s*/)[0];
        const origBase = stripPunctuation(original.word).toLowerCase();

        if (pi < punctuatedBatch.length) {
          const punctBase = stripPunctuation(punctuatedBatch[pi]).toLowerCase();

          if (origBase === punctBase || isFuzzyMatch(origBase, punctBase)) {
            // Direct or fuzzy match (spelling correction) — use punctuated version
            punctuatedWords.push({
              ...original,
              word: leadingSpace + punctuatedBatch[pi],
            });
            matched++;
            oi++;
            pi++;
          } else {
            // Try to re-align: check if LLM inserted extra token(s)
            let found = false;
            for (let lookahead = 1; lookahead <= 3 && pi + lookahead < punctuatedBatch.length; lookahead++) {
              const lookaheadBase = stripPunctuation(punctuatedBatch[pi + lookahead]).toLowerCase();
              if (lookaheadBase === origBase || isFuzzyMatch(lookaheadBase, origBase)) {
                // LLM added extra token(s) — skip them
                pi += lookahead;
                punctuatedWords.push({
                  ...original,
                  word: leadingSpace + punctuatedBatch[pi],
                });
                matched++;
                oi++;
                pi++;
                found = true;
                break;
              }
            }
            // Try reverse: check if LLM merged tokens (punctuated is shorter)
            if (!found) {
              for (let lookahead = 1; lookahead <= 3 && oi + lookahead < batchWords.length; lookahead++) {
                const futureBase = stripPunctuation(batchWords[oi + lookahead].word).toLowerCase();
                if (futureBase === punctBase || isFuzzyMatch(futureBase, punctBase)) {
                  // LLM merged word(s) — keep skipped originals as-is
                  for (let skip = 0; skip < lookahead; skip++) {
                    punctuatedWords.push(batchWords[oi + skip]);
                  }
                  oi += lookahead;
                  // Don't advance pi — the match will happen on next iteration
                  found = true;
                  break;
                }
              }
            }
            if (!found) {
              // Can't align — keep original word, only advance oi (not pi)
              // pi stays put so we can try matching the next original against the same punctuated word
              punctuatedWords.push(original);
              oi++;
            }
          }
        } else {
          // Ran out of punctuated words — keep remaining originals
          punctuatedWords.push(original);
          oi++;
        }
      }

      console.log(`[Punctuation] Batch ${batchNum}: aligned ${matched}/${batchWords.length} words`);

    } catch (err) {
      console.error(`[Punctuation] Error in batch ${batchNum}:`, err.message);
      // Fall back to original words for this batch
      punctuatedWords.push(...batchWords);
    }
  }

  // Rebuild segments from punctuated words
  // Whisper words have leading spaces (e.g. " привет"), so join with '' and trim
  const punctuatedSegments = transcript.segments.map(segment => {
    const segmentWords = punctuatedWords.filter(
      w => w.start >= segment.start && w.end <= segment.end
    );
    return {
      ...segment,
      text: segmentWords.map(w => w.word).join('').trim() || segment.text,
    };
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Punctuation] Complete in ${elapsed}s for ${totalWords} words`);
  onProgress('punctuation', 100, 'complete', `Punctuation added in ${elapsed}s`);

  return {
    ...transcript,
    words: punctuatedWords,
    segments: punctuatedSegments,
  };
}
