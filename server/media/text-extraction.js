/**
 * Text extraction from lib.ru literary pages.
 * Handles encoding detection (KOI8-R, windows-1251) and GPT-powered content boundary detection.
 */
import OpenAI from 'openai';
import http from 'http';
import https from 'https';
import { BROWSER_UA } from './progress-utils.js';

/**
 * Check if a URL is a lib.ru text URL
 * @param {string} url
 * @returns {boolean}
 */
export function isLibRuUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'lib.ru' || u.hostname.endsWith('.lib.ru');
  } catch {
    return false;
  }
}

/**
 * Fetch and extract Russian text from a lib.ru page.
 * lib.ru pages have varying encodings (KOI8-R, windows-1251) and messy HTML.
 * We strip tags, then use GPT-4o to identify where the literary prose begins.
 * @param {string} url - lib.ru URL
 * @param {object} options
 * @param {string} options.apiKey - OpenAI API key
 * @returns {Promise<{title: string, author: string, text: string}>}
 */
export async function fetchLibRuText(url, options = {}) {
  const { apiKey = process.env.OPENAI_API_KEY } = options;

  // Use http/https.get with insecureHTTPParser because lib.ru sends malformed
  // HTTP chunked encoding that Node's strict parser rejects (HPE_INVALID_CHUNK_SIZE).
  // lib.ru serves over plain HTTP, so we pick the right module based on protocol.
  const httpModule = url.startsWith('https') ? https : http;
  const { status, buffer, contentType } = await new Promise((resolve, reject) => {
    httpModule.get(url, {
      insecureHTTPParser: true,
      headers: { 'User-Agent': BROWSER_UA },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        buffer: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || '',
      }));
      res.on('error', reject);
    }).on('error', reject);
  });

  if (status !== 200) {
    throw new Error(`Failed to fetch lib.ru page: ${status}`);
  }

  // Detect encoding: prefer Content-Type charset header, fall back to heuristic.
  // Both KOI8-R and windows-1251 map bytes to Cyrillic Unicode, so counting
  // Cyrillic chars can't distinguish them — we must use the declared charset.
  const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
  const declaredCharset = charsetMatch ? charsetMatch[1].toLowerCase() : null;

  let html;
  if (declaredCharset && (declaredCharset.includes('koi8') || declaredCharset.includes('1251'))) {
    html = new TextDecoder(declaredCharset).decode(buffer);
  } else {
    // No charset declared — try both and pick the one with more lowercase Cyrillic
    // (real Russian text has mostly lowercase; wrong encoding produces mostly uppercase)
    const koi8 = new TextDecoder('koi8-r').decode(buffer);
    const win1251 = new TextDecoder('windows-1251').decode(buffer);
    const countLower = (s) => (s.slice(0, 2000).match(/[а-я]/g) || []).length;
    html = countLower(koi8) >= countLower(win1251) ? koi8 : win1251;
  }

  // Extract title from <title> tag
  let title = 'Untitled';
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Strip all HTML tags to get raw text
  let rawText = html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&copy;/g, '(c)')
    .trim();

  // Use GPT-4o to find where the literary prose begins.
  // We send the first ~200 numbered lines and ask for just the line number.
  // This handles the wide variety of lib.ru page layouts (metadata, ratings,
  // chapter headings, OCR credits, etc.) without brittle heuristics.
  const lines = rawText.split('\n');
  const headerLines = lines.slice(0, 200);
  const numberedHeader = headerLines.map((l, i) => `${i}: ${l}`).join('\n');

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `Below are the first 200 numbered lines of a Russian literary text from lib.ru, after HTML tags were stripped. The page starts with metadata (title, author, navigation, ratings, OCR credits, publisher info, dashed separators) followed by the actual literary prose (novel, story, poem, etc).

Reply with ONLY the line number where the actual literary prose begins. Not chapter headings, not epigraphs — the first sentence of narrative text. Just the number, nothing else.

${numberedHeader}`
      }],
    });

    const lineNum = parseInt(response.choices[0].message.content.trim(), 10);
    if (!isNaN(lineNum) && lineNum > 0 && lineNum < lines.length) {
      rawText = lines.slice(lineNum).join('\n').trim();
      console.log(`[LibRu] GPT-4o-mini: content starts at line ${lineNum}: "${rawText.slice(0, 80)}..."`);
    } else {
      console.log(`[LibRu] GPT-4o-mini returned invalid line number: ${response.choices[0].message.content}, using full text`);
    }
  } catch (err) {
    // Quota/auth errors mean ALL subsequent OpenAI calls (TTS, lemmatization) will also fail.
    // Fail fast rather than proceeding with garbage text.
    if (err.status === 429 || err.code === 'insufficient_quota' || err.status === 401) {
      throw new Error('OpenAI API quota exceeded. Add credits at https://platform.openai.com/settings/organization/billing');
    }
    console.error(`[LibRu] GPT-4o-mini content extraction failed, using full text:`, err.message);
  }

  // Strip common lib.ru title prefixes like "Lib.ru/Классика: " or "Lib.ru: "
  title = title.replace(/^Lib\.ru\/[^:]*:\s*/i, '').replace(/^Lib\.ru:\s*/i, '').trim();

  // Extract author from title (lib.ru titles are often "Author. Title" or "Author Full Name. Title")
  // Match author: sequence of capitalized words ending with a period, before the title
  let author = '';
  const authorMatch = title.match(/^([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)*)\.\s+/);
  if (authorMatch) {
    author = authorMatch[1].trim();
    title = title.slice(authorMatch[0].length).trim();
  }

  if (!rawText || rawText.length < 50) {
    throw new Error('Extracted text is too short — page may not contain readable content');
  }

  console.log(`[LibRu] Fetched "${title}" by ${author || 'unknown'} (${rawText.length} chars)`);
  return { title, author, text: rawText };
}
