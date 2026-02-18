import { test, expect } from '@playwright/test';
import { TEST_SESSION_ID, MOCK_TRANSCRIPT } from '../fixtures/mock-data';

/**
 * Set up mock routes for demo flow tests.
 * Mocks /api/demo, chunk data, translate, and media files.
 */
async function setupDemoRoutes(page: any, options: { contentType?: 'video' | 'text' } = {}) {
  const contentType = options.contentType ?? 'video';
  const isText = contentType === 'text';

  // Block Firebase
  await page.route('**/*firebaseapp.com*/**', (route: any) => route.abort());
  await page.route('**/*googleapis.com/identitytoolkit/**', (route: any) => route.abort());
  await page.route('**/*firestore.googleapis.com/**', (route: any) => route.abort());
  await page.route('**/russian-word-frequencies.json', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );

  const chunks = [
    {
      id: 'chunk-0',
      index: 0,
      startTime: 0,
      endTime: isText ? 0 : 180,
      duration: isText ? 0 : 180,
      previewText: 'Привет, как дела? Я хочу рассказать...',
      wordCount: 50,
      status: 'ready',
      videoUrl: isText ? undefined : '/mock-video.mp4',
      audioUrl: isText ? '/mock-audio.mp3' : undefined,
    },
  ];

  // POST /api/demo → cached-style response
  await page.route('**/api/demo', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: TEST_SESSION_ID,
        status: 'cached',
        title: isText ? 'Толстой — Детство' : 'Demo Russian Video',
        contentType,
        totalDuration: isText ? 0 : 180,
        chunks,
        hasMoreChunks: false,
      }),
    });
  });

  // GET /api/session/:id/chunk/:chunkId
  await page.route('**/api/session/*/chunk/*', async (route: any) => {
    const response: any = {
      transcript: MOCK_TRANSCRIPT,
      title: isText ? 'Толстой — Детство — Section 1' : 'Demo Russian Video — Part 1',
    };
    if (isText) {
      response.audioUrl = '/mock-audio.mp3';
    } else {
      response.videoUrl = '/mock-video.mp4';
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });

  // GET /api/session/:id
  await page.route('**/api/session/*', async (route: any) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        title: isText ? 'Толстой — Детство' : 'Demo Russian Video',
        contentType,
        totalDuration: isText ? 0 : 180,
        chunks,
        hasMoreChunks: false,
      }),
    });
  });

  // POST /api/translate
  await page.route('**/api/translate', async (route: any) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        word: body?.word || 'привет',
        translation: 'hello',
        sourceLanguage: 'ru',
      }),
    });
  });

  // POST /api/extract-sentence
  await page.route('**/api/extract-sentence', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sentence: 'Привет, как дела?', translation: 'Hello, how are you?' }),
    });
  });

  // Mock media files
  await page.route('**/mock-video.mp4', async (route: any) => {
    const minimalMp4 = Buffer.from(
      'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAABxtZGF0AAAB' +
      'sGFuAQABtAAAABjm/+HkAAADPWmoYf//ow67JAoK+QAAC7gAAAAIAAAAAmQAAAABAAAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAA//8AAAALAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'base64'
    );
    await route.fulfill({ status: 200, contentType: 'video/mp4', body: minimalMp4 });
  });

  await page.route('**/mock-audio.mp3', async (route: any) => {
    await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(100) });
  });
}

test.describe('Demo flow', () => {
  test('demo video button is visible on input page', async ({ page }) => {
    await setupDemoRoutes(page);
    await page.goto('/');
    await expect(page.getByTestId('demo-video-btn')).toBeVisible();
    await expect(page.getByTestId('demo-text-btn')).toBeVisible();
    await expect(page.locator('text=or try a demo')).toBeVisible();
  });

  test('clicking demo video loads player with transcript', async ({ page }) => {
    await setupDemoRoutes(page, { contentType: 'video' });
    await page.goto('/');

    await page.getByTestId('demo-video-btn').click();

    // Should go directly to player (single chunk auto-select)
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Should have video element
    await expect(page.locator('video')).toBeAttached();
  });

  test('clicking demo text loads audio player with transcript', async ({ page }) => {
    await setupDemoRoutes(page, { contentType: 'text' });
    await page.goto('/');

    await page.getByTestId('demo-text-btn').click();

    // Should go to text player
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Should have audio element, not video
    await expect(page.locator('audio')).toBeAttached();
    await expect(page.locator('video')).not.toBeAttached();
  });

  test('word click works in demo mode (translation popup)', async ({ page }) => {
    await setupDemoRoutes(page, { contentType: 'video' });
    await page.goto('/');

    await page.getByTestId('demo-video-btn').click();
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Click a word — should show translation popup
    await page.locator('text=хочу').click();
    await expect(page.locator('.shadow-lg')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=hello')).toBeVisible();
  });

  test('"Load different video or text" returns to input with demo buttons', async ({ page }) => {
    await setupDemoRoutes(page, { contentType: 'video' });
    await page.goto('/');

    await page.getByTestId('demo-video-btn').click();
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Go back to input
    await page.locator('text=Load different video or text').click();

    // Demo buttons should be visible again
    await expect(page.getByTestId('demo-video-btn')).toBeVisible();
    await expect(page.getByTestId('demo-text-btn')).toBeVisible();
  });

  test('demo sends POST /api/demo with correct type', async ({ page }) => {
    let capturedBody: any = null;

    await setupDemoRoutes(page, { contentType: 'text' });

    // Override to capture the request body
    await page.route('**/api/demo', async (route: any) => {
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: TEST_SESSION_ID,
          status: 'cached',
          title: 'Толстой — Детство',
          contentType: 'text',
          totalDuration: 0,
          chunks: [{
            id: 'chunk-0', index: 0, startTime: 0, endTime: 0, duration: 0,
            previewText: 'Текст...', wordCount: 50, status: 'ready', audioUrl: '/mock-audio.mp3',
          }],
          hasMoreChunks: false,
        }),
      });
    });

    await page.goto('/');
    await page.getByTestId('demo-text-btn').click();

    // Wait for player to load
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Verify the request body
    expect(capturedBody).toEqual({ type: 'text' });
  });
});
