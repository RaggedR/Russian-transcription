/**
 * Regression test: run the TypeScript compiler to catch type errors.
 *
 * Added after a bug where a `cleanup` variable was referenced outside
 * its closure scope in App.tsx, causing TS2304/TS2349 build failures
 * that weren't caught until the frontend stopped loading.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Frontend TypeScript', () => {
  it('passes type checking (tsc -b)', () => {
    const projectRoot = resolve(__dirname, '..');
    const result = execSync('npx tsc -b 2>&1', {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.trim()).toBe('');
  });
});
