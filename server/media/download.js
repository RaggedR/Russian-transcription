/**
 * Video/audio download functions using yt-dlp and ffmpeg.
 * Handles ok.ru video info scraping, audio/video chunk downloads, and audio duration.
 */
import fs from 'fs';
import { spawn } from 'child_process';
import ytdlpBase from 'yt-dlp-exec';
import { formatTime } from '../chunking.js';
import {
  BROWSER_UA,
  YTDLP_TIMEOUT_MS,
  mapProgress,
  computeRanges,
  createHeartbeat,
} from './progress-utils.js';

// Use system yt-dlp binary instead of bundled one
const ytdlp = ytdlpBase.create('yt-dlp');

/**
 * Fast info fetch for ok.ru videos by scraping OG meta tags (~4-5s vs yt-dlp's ~15s)
 * @param {string} url - ok.ru video URL
 * @returns {Promise<{title: string, duration: number}>}
 */
export async function getOkRuVideoInfo(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
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

  // Substage weights: [extraction, download, finalization] in estimated seconds
  const hasCachedInfo = cachedInfoPath && fs.existsSync(cachedInfoPath);
  const weights = hasCachedInfo ? [2, 45, 5] : [60, 45, 5];
  const ranges = computeRanges(weights);
  const [extractionRange, downloadRange, finalizationRange] = ranges;
  const extractionEstimate = weights[0];

  // Heartbeat with phase-aware messages using substage ranges
  let phase = 'connecting';
  const heartbeat = createHeartbeat(
    onProgress,
    'audio',
    (s) => {
      if (phase === 'connecting' || phase === 'extracting') {
        // Smooth fill over 1.5x the estimated extraction time (never reaches 100% of range)
        const subPct = Math.min(95, Math.round((s / (extractionEstimate * 1.5)) * 100));
        const pct = mapProgress(subPct, extractionRange[0], extractionRange[1]);
        const remaining = Math.max(0, extractionEstimate - s);
        return { percent: pct, message: `Step 1/3: Finding video stream... ${s}s (~${remaining}s remaining)` };
      }
      if (phase === 'starting') {
        return { percent: downloadRange[0], message: `Step 2/3: Starting download... (${s}s)` };
      }
      return { percent: downloadRange[0], message: `Processing... (${s}s)` };
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
  if (hasCachedInfo) {
    args.push('--load-info-json', cachedInfoPath);
    phase = 'starting';
    onProgress('audio', downloadRange[0], 'active', 'Step 1/3: Using cached video info...');
  }

  let videoInfo = null;

  await new Promise((resolve, reject) => {
    const ytdlpProc = spawn('yt-dlp', args);
    let settled = false;

    // Kill yt-dlp if it hangs (ok.ru CDN can become unreachable)
    const processTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        heartbeat.stop();
        clearInterval(audioMonitor);
        ytdlpProc.kill('SIGTERM');
        reject(new Error(`Audio download timed out after ${YTDLP_TIMEOUT_MS / 1000}s — ok.ru may be unreachable. Try again later.`));
      }
    }, YTDLP_TIMEOUT_MS);

    let lastProgress = 0;
    let lastAudioSize = 0;
    let finalizationStart = 0;

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
                const pct = Math.max(lastProgress, downloadRange[0]);
                onProgress('audio', pct, 'active',
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
        onProgress('audio', downloadRange[0], 'active', 'Step 2/3: Starting download...');
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
        phase = 'finalizing';
        finalizationStart = Date.now();
        onProgress('audio', finalizationRange[0], 'active', 'Step 3/3: Finalizing audio...');
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
        // Map download progress into its allocated range
        const subPct = Math.min(100, Math.round((currentSecs / duration) * 100));
        const percent = mapProgress(subPct, downloadRange[0], downloadRange[1]);
        if (percent > lastProgress) {
          lastProgress = percent;
          const timeMsg = `${formatTime(currentSecs)} / ${targetDuration}`;
          const sizeMsg = lastAudioSize > 0 ? ` (${(lastAudioSize / 1024 / 1024).toFixed(1)} MB)` : '';
          onProgress('audio', percent, 'active', `Step 2/3: Downloading audio... ${timeMsg}${sizeMsg}`);
        }
      }
    });

    ytdlpProc.on('close', (code) => {
      clearTimeout(processTimer);
      if (settled) return;
      settled = true;
      heartbeat.stop();
      clearInterval(audioMonitor);
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });

    ytdlpProc.on('error', (err) => {
      clearTimeout(processTimer);
      if (settled) return;
      settled = true;
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

  // Substage weights: [extraction, download, upload] in estimated seconds
  // Upload range is reserved for index.js to use when uploading to GCS
  const hasCachedInfo = cachedInfoPath && fs.existsSync(cachedInfoPath);
  const weights = hasCachedInfo ? [2, 25, 10] : [60, 25, 10];
  const ranges = computeRanges(weights);
  const [extractionRange, downloadRange, uploadRange] = ranges;
  const extractionEstimate = weights[0];

  let phase = hasCachedInfo ? 'starting' : 'extracting';
  let downloadStart = Date.now();

  // Heartbeat with estimated progress during extraction
  const heartbeat = createHeartbeat(
    onProgress,
    'video',
    (s) => {
      if (phase === 'extracting') {
        const subPct = Math.min(95, Math.round((s / (extractionEstimate * 1.5)) * 100));
        const pct = mapProgress(subPct, extractionRange[0], extractionRange[1]);
        const remaining = Math.max(0, extractionEstimate - s);
        return { percent: pct, message: `Part ${partNum}: Finding stream... ${s}s (~${remaining}s remaining)` };
      }
      if (phase === 'starting' || phase === 'downloading') {
        // Time-estimate within download range (no real file-size progress available)
        const elapsed = (Date.now() - downloadStart) / 1000;
        const subPct = Math.min(95, Math.round((elapsed / (weights[1] * 1.5)) * 100));
        const pct = mapProgress(subPct, downloadRange[0], downloadRange[1]);
        return { percent: pct, message: `Part ${partNum}: Downloading... (${s}s)` };
      }
      return { percent: downloadRange[0], message: `Part ${partNum}: Processing... (${s}s)` };
    }
  );

  if (phase === 'extracting') {
    onProgress('video', 0, 'active', `Part ${partNum}: Finding stream...`);
  } else {
    onProgress('video', downloadRange[0], 'active', `Part ${partNum}: Using cached info...`);
  }

  let lastVideoSize = 0;
  const videoMonitor = setInterval(() => {
    try {
      const partPath = outputPath + '.part';
      const checkPath = fs.existsSync(partPath) ? partPath : (fs.existsSync(outputPath) ? outputPath : null);
      if (checkPath) {
        const stats = fs.statSync(checkPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        // Transition to download phase once file appears
        if (stats.size > 0 && phase === 'extracting') {
          heartbeat.stop();
          phase = 'downloading';
          downloadStart = Date.now();
        }
        if (stats.size !== lastVideoSize) {
          lastVideoSize = stats.size;
          // Let heartbeat handle progress (it time-estimates within download range)
          // Just update the size in the message
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

  // Launch yt-dlp with a process-level timeout
  const ytdlpProcess = ytdlp(url, ytdlpOptions);
  const processTimer = setTimeout(() => {
    if (ytdlpProcess.kill) ytdlpProcess.kill('SIGTERM');
  }, YTDLP_TIMEOUT_MS);

  try {
    await ytdlpProcess;
  } catch (err) {
    // Provide a clear message if killed by our timeout
    if (err.killed || err.signal === 'SIGTERM') {
      throw new Error(`Video download timed out after ${YTDLP_TIMEOUT_MS / 1000}s — ok.ru may be unreachable. Try again later.`);
    }
    throw err;
  } finally {
    clearTimeout(processTimer);
    heartbeat.stop();
    clearInterval(videoMonitor);
  }

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  const sizeMB = (size / 1024 / 1024).toFixed(1);
  // Report download complete at upload range start — index.js handles upload progress and final 100%
  onProgress('video', uploadRange[0], 'active', `Part ${partNum}: Download complete (${sizeMB} MB)`);

  return { size };
}

/**
 * Get audio duration in seconds using ffprobe.
 * @param {string} audioPath - Path to audio file
 * @returns {Promise<number>} Duration in seconds
 */
export function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      audioPath,
    ]);
    let output = '';
    proc.stdout.on('data', (data) => { output += data; });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffprobe exited with code ${code}`));
      else resolve(parseFloat(output.trim()));
    });
    proc.on('error', reject);
  });
}
