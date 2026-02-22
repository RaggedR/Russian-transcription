/**
 * Audio transcription and text processing using OpenAI Whisper and GPT-4o.
 * Handles transcription, punctuation restoration, and lemmatization.
 */
import fs from 'fs';
import OpenAI from 'openai';
import { stripPunctuation, isFuzzyMatch } from './text-utils.js';
import { mapProgress, createHeartbeat } from './progress-utils.js';

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

  // Over-estimate: ~10 seconds per MB — better to reach 70% and jump to 100%
  // than hang at 95% for a long time
  const estimatedSeconds = Math.max(Math.round(sizeMB * 10), 45);

  const startTime = Date.now();
  onProgress('transcription', 0, 'active',
    `Step 3/3: Transcribing ${sizeMBStr} MB... (estimated ~${estimatedSeconds}s)`);

  const transcribeInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, estimatedSeconds - elapsed);
    // Cap at 95% so progress reaches near-completion before the jump to 100%
    const percent = Math.min(95, Math.round((elapsed / estimatedSeconds) * 100));
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
    const percent = Math.round((i / transcript.words.length) * 95);
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

/**
 * Lemmatize transcript words using GPT-4o.
 * Extracts unique words, sends them in batches to GPT-4o for lemmatization,
 * and attaches a `lemma` field to each WordTimestamp.
 *
 * @param {Object} transcript - Transcript { words, segments, language, duration }
 * @param {Object} options
 * @param {string} options.apiKey - OpenAI API key
 * @param {function} options.onProgress - Progress callback
 * @returns {Promise<Object>} - Transcript with lemma fields on words
 */
export async function lemmatizeWords(transcript, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    onProgress = () => {},
  } = options;

  if (!apiKey || !transcript.words || transcript.words.length === 0) {
    return transcript;
  }

  const startTime = Date.now();

  // Extract unique normalized words
  const wordSet = new Set();
  for (const w of transcript.words) {
    const normalized = stripPunctuation(w.word).toLowerCase();
    if (normalized) wordSet.add(normalized);
  }

  const uniqueWords = Array.from(wordSet);
  console.log(`[Lemmatize] ${uniqueWords.length} unique words from ${transcript.words.length} total`);
  onProgress('lemmatization', 0, 'active', `Lemmatizing ${uniqueWords.length} unique words...`);

  const openai = new OpenAI({ apiKey });
  const BATCH_SIZE = 300;
  const lemmaMap = new Map();

  // Estimate ~5s per batch of 300 words for time-based progress during API calls
  const totalBatches = Math.ceil(uniqueWords.length / BATCH_SIZE);
  const estimatedSecsPerBatch = 12;

  for (let i = 0; i < uniqueWords.length; i += BATCH_SIZE) {
    const batch = uniqueWords.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchRangeStart = Math.round((i / uniqueWords.length) * 95);
    const batchRangeEnd = Math.round(((i + batch.length) / uniqueWords.length) * 95);
    onProgress('lemmatization', batchRangeStart, 'active',
      `Lemmatizing... (batch ${batchNum}/${totalBatches})`);

    // Heartbeat within each batch so single-batch runs don't show 0% → 100%
    const batchStart = Date.now();
    const batchHeartbeat = setInterval(() => {
      const elapsed = (Date.now() - batchStart) / 1000;
      const subPct = Math.min(90, Math.round((elapsed / (estimatedSecsPerBatch * 1.5)) * 100));
      const pct = mapProgress(subPct, batchRangeStart, batchRangeEnd);
      onProgress('lemmatization', pct, 'active',
        `Lemmatizing... (batch ${batchNum}/${totalBatches}, ${Math.round(elapsed)}s)`);
    }, 1500);

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `You are a Russian morphology tool. For each word, return its most commonly used dictionary lemma (nominative singular for nouns, masculine nominative singular for adjectives, infinitive for verbs). Prefer the everyday form over literary forms (e.g. маленький over малый, большой over великий). For short-form adjectives (мал, мала, велик, велика, etc.), return the common full-form adjective. Return ONLY a JSON object mapping each input word to its lemma. No explanation.`,
          },
          {
            role: 'user',
            content: JSON.stringify(batch),
          },
        ],
      });

      const content = response.choices[0].message.content.trim();
      // Strip markdown code fences if present
      const jsonStr = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(jsonStr);

      for (const [word, lemma] of Object.entries(parsed)) {
        if (typeof lemma === 'string' && lemma.length > 0) {
          lemmaMap.set(word.toLowerCase(), lemma.toLowerCase());
        }
      }

      console.log(`[Lemmatize] Batch ${batchNum}: got ${Object.keys(parsed).length} lemmas`);
    } catch (err) {
      console.error(`[Lemmatize] Error in batch ${batchNum}:`, err.message);
      // Skip this batch — words will just have no lemma
    } finally {
      clearInterval(batchHeartbeat);
    }
  }

  // Attach lemma to each word
  const lemmatizedWords = transcript.words.map(w => {
    const normalized = stripPunctuation(w.word).toLowerCase();
    const lemma = lemmaMap.get(normalized);
    return lemma ? { ...w, lemma } : w;
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const coverage = lemmatizedWords.filter(w => w.lemma).length;
  console.log(`[Lemmatize] Complete in ${elapsed}s: ${coverage}/${transcript.words.length} words lemmatized`);
  onProgress('lemmatization', 100, 'complete', `Lemmatized in ${elapsed}s`);

  return {
    ...transcript,
    words: lemmatizedWords,
  };
}
