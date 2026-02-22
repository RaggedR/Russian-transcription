import { test, expect } from '@playwright/test';
import { setupMockRoutes } from '../fixtures/mock-routes';
import { MOCK_CHUNKS } from '../fixtures/mock-data';

test.describe('Browser history (back/forward buttons)', () => {
  test('back from chunk-menu returns to input view', async ({ page }) => {
    await setupMockRoutes(page, { chunks: MOCK_CHUNKS, cached: true });

    await page.goto('/');
    const urlInput = page.locator('input[placeholder*="ok.ru"]');
    await urlInput.fill('https://ok.ru/video/123456');
    await urlInput.press('Enter');

    // Wait for chunk menu
    await expect(page.locator('text=Part 1')).toBeVisible({ timeout: 5000 });

    // Press browser back
    await page.goBack();

    // Should return to input view
    await expect(page.locator('input[placeholder*="ok.ru"]')).toBeVisible({ timeout: 5000 });
  });

  test('back from player returns to chunk-menu', async ({ page }) => {
    await setupMockRoutes(page, { chunks: MOCK_CHUNKS, cached: true });

    await page.goto('/');
    const urlInput = page.locator('input[placeholder*="ok.ru"]');
    await urlInput.fill('https://ok.ru/video/123456');
    await urlInput.press('Enter');

    // Wait for chunk menu
    await expect(page.locator('text=Part 1')).toBeVisible({ timeout: 5000 });

    // Click Part 1 to go to player
    await page.locator('text=Part 1').click();
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Press browser back
    await page.goBack();

    // Should return to chunk menu
    await expect(page.locator('text=Part 1')).toBeVisible({ timeout: 5000 });
  });

  test('forward after back restores view', async ({ page }) => {
    await setupMockRoutes(page, { chunks: MOCK_CHUNKS, cached: true });

    await page.goto('/');
    const urlInput = page.locator('input[placeholder*="ok.ru"]');
    await urlInput.fill('https://ok.ru/video/123456');
    await urlInput.press('Enter');

    // Wait for chunk menu
    await expect(page.locator('text=Part 1')).toBeVisible({ timeout: 5000 });

    // Click Part 1 to go to player
    await page.locator('text=Part 1').click();
    await expect(page.locator('text=Привет,')).toBeVisible({ timeout: 5000 });

    // Back to chunk-menu
    await page.goBack();
    await expect(page.locator('text=Part 1')).toBeVisible({ timeout: 5000 });

    // Forward should return to player or redirect to input (if route guard fires)
    await page.goForward();
    const playerOrInput = page.locator('text=Привет,').or(page.locator('input[placeholder*="ok.ru"]'));
    await expect(playerOrInput.first()).toBeVisible({ timeout: 5000 });
  });

  test('back after reset lands at input', async ({ page }) => {
    await setupMockRoutes(page, { chunks: MOCK_CHUNKS, cached: true });

    await page.goto('/');
    const urlInput = page.locator('input[placeholder*="ok.ru"]');
    await urlInput.fill('https://ok.ru/video/123456');
    await urlInput.press('Enter');

    // Wait for chunk menu
    await expect(page.locator('text=Part 1')).toBeVisible({ timeout: 5000 });

    // Click reset to go back to input
    await page.locator('text=Load different video or text').click();
    await expect(page.locator('input[placeholder*="ok.ru"]')).toBeVisible({ timeout: 5000 });

    // Back from reset: route guard should redirect to / since session was cleared
    await page.goBack();
    await expect(page.locator('input[placeholder*="ok.ru"]')).toBeVisible({ timeout: 5000 });
  });
});
