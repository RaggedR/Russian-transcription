/**
 * Regression test for POST /api/extract-sentence.
 *
 * Verifies the endpoint:
 * 1. Returns a SINGLE sentence (not multiple) containing the target word
 * 2. Returns an English translation of that sentence
 * 3. Rejects requests missing required fields
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';

// Mock media.js so the server can start without real dependencies
vi.mock('./media.js', () => ({
  getOkRuVideoInfo: vi.fn(),
  downloadAudioChunk: vi.fn(),
  downloadVideoChunk: vi.fn(),
  transcribeAudioChunk: vi.fn(),
  addPunctuation: vi.fn(),
  lemmatizeWords: vi.fn(),
  createHeartbeat: vi.fn(() => ({ stop: () => {}, isStopped: () => true, getSeconds: () => 0 })),
  isLibRuUrl: vi.fn(() => false),
  fetchLibRuText: vi.fn(),
  generateTtsAudio: vi.fn(),
  getAudioDuration: vi.fn(() => 30),
  estimateWordTimestamps: vi.fn(),
}));

// Mock global fetch to simulate OpenAI API
const originalFetch = globalThis.fetch;
let mockOpenAIResponse;

beforeAll(async () => {
  // Mock fetch to intercept OpenAI calls
  globalThis.fetch = vi.fn(async (url, opts) => {
    if (typeof url === 'string' && url.includes('openai.com')) {
      return {
        ok: true,
        json: async () => mockOpenAIResponse,
      };
    }
    // Fall through for other URLs
    return originalFetch(url, opts);
  });

  // Set required env vars
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';

  // Import server (starts Express)
  const mod = await import('./index.js');
  global.__server = mod.default;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (global.__server?.close) global.__server.close();
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: 3001, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('POST /api/extract-sentence', () => {
  it('returns 400 when text is missing', async () => {
    const res = await post('/api/extract-sentence', { word: 'привет' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when word is missing', async () => {
    const res = await post('/api/extract-sentence', { text: 'Привет мир.' });
    expect(res.status).toBe(400);
  });

  it('returns a single Russian sentence and its English translation', async () => {
    // Mock OpenAI to return a clean single sentence
    mockOpenAIResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            sentence: 'Она сказала привет и ушла.',
            translation: 'She said hello and left.',
          }),
        },
      }],
    };

    const res = await post('/api/extract-sentence', {
      text: 'Вчера было холодно. Она сказала привет и ушла. Потом пошёл дождь.',
      word: 'привет',
    });

    expect(res.status).toBe(200);
    expect(res.body.sentence).toBe('Она сказала привет и ушла.');
    expect(res.body.translation).toBe('She said hello and left.');

    // Verify OpenAI was called with the right prompt structure
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('openai.com')
    );
    expect(fetchCall).toBeDefined();
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.model).toBe('gpt-4o-mini');
    // The system prompt must ask for a SINGLE sentence
    const systemMsg = requestBody.messages.find((m) => m.role === 'system');
    expect(systemMsg.content).toContain('single');
  });
});
