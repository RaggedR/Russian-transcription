# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Russian Video & Text — a web app for watching Russian videos (ok.ru) and reading Russian texts (lib.ru) with synced transcripts, click-to-translate, and SRS flashcard review. Users paste URLs; the backend downloads, transcribes (Whisper), punctuates (GPT-4o), and chunks the content. Words highlight in sync with playback. Users build a flashcard deck by clicking words, which persists to Firestore via anonymous auth.

## Commands

```bash
npm run dev           # Start both frontend and backend (kills stale servers first)
npm run dev:frontend  # Start Vite dev server only
npm run dev:backend   # Start Express backend only (uses --watch)
npm run build         # TypeScript check + production build
npm run lint          # Run ESLint
npm run test          # Run ALL tests (frontend typecheck + server unit + integration)
npm run server:install # Install backend dependencies
```

### Testing

```bash
# Run all tests (frontend + backend)
npm test

# Server unit tests only
cd server && npx vitest run

# Server tests in watch mode
cd server && npx vitest

# Run a single test file
cd server && npx vitest run media.test.js
cd server && npx vitest run integration.test.js

# Run tests matching a pattern
cd server && npx vitest run -t "editDistance"

# Integration tests against real APIs (requires network + API keys)
cd server && npm run test:integration
```

```bash
# E2E tests (Playwright — frontend only, all APIs mocked)
npm run test:e2e            # Run all E2E tests (headless)
npm run test:e2e:headed     # Run with visible browser
npm run test:e2e:ui         # Run with Playwright UI inspector

# Install Playwright browsers (first time only)
cd e2e && npx playwright install chromium
```

**Test files:**
- `tests/typecheck.test.js` — Runs `tsc -b` to catch TypeScript errors (30s timeout)
- `server/media.test.js` — Unit tests for heartbeat, stripPunctuation, editDistance, isFuzzyMatch
- `server/integration.test.js` — Mocks `media.js`, tests all Express endpoints, SSE, session lifecycle
- `e2e/tests/*.spec.ts` — Playwright E2E tests: app loading, video flow, word popup, flashcard review, add-to-deck, edge cases

## Setup

1. `npm install && npm run server:install`
2. `brew install yt-dlp ffmpeg`
3. Create `.env` in project root:
   ```
   OPENAI_API_KEY=sk-...
   GOOGLE_TRANSLATE_API_KEY=AIza...
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   ```
4. Deploy Firestore security rules: `firebase deploy --only firestore:rules`

## Architecture

### Thin Client Design

The frontend is a **thin client** — the backend owns all session state. The frontend only manages view state (`input` | `analyzing` | `chunk-menu` | `loading-chunk` | `player`), current playback state, and UI errors.

### Core Flow (Video Mode)
```
1. User pastes ok.ru URL
2. POST /api/analyze → scrape metadata (fast) → download audio → transcribe → punctuate → chunk
3. SSE /api/progress/:sessionId → real-time progress updates
4. Backend creates chunks (3-5 min segments at natural pauses)
5. If 1 chunk → auto-download; else → show chunk menu
6. POST /api/download-chunk → yt-dlp extracts video segment
7. GET /api/session/:sessionId/chunk/:chunkId → fetch chunk data
8. Video plays with synced transcript highlighting, click-to-translate
```

### Core Flow (Text Mode)
```
1. User pastes lib.ru URL (detected by url.includes('lib.ru'))
2. POST /api/analyze → fetch text → split into ~3500-char chunks → generate TTS audio (OpenAI)
3. AudioPlayer.tsx for playback, full-width transcript view (no side-by-side video)
4. Word timestamps estimated from character offsets + audio duration
```

### SSE Architecture

SSE for progress updates has a special setup to avoid Vite proxy buffering in dev:
- `api.ts` connects SSE directly to `http://localhost:3001` (not through Vite proxy)
- `vite.config.ts` disables caching on `/progress/` proxy requests as a fallback
- In production, SSE connects to the same origin (frontend served from Cloud Run)

### Session Persistence

- **Local dev** (`IS_LOCAL=true`): In-memory Maps, videos in `server/temp/`, lost on restart. Controlled by absence of `GCS_BUCKET` env var or `NODE_ENV=development`.
- **Production**: Sessions in `gs://russian-transcription-videos/sessions/`, videos in `videos/`, extraction cache in `cache/`
- `chunkTranscripts` is a Map — serialized as `Array.from(map.entries())` for JSON/GCS storage, restored with `new Map(array)`
- URL session cache (6h TTL), extraction cache (2h TTL), translation cache (in-memory)

### Backend (`server/`)

Express.js on port 3001 (local) / `PORT` env var (Cloud Run). Three main files:
- `index.js` — Routing, session management, SSE, chunk prefetching
- `media.js` — External tool integration (yt-dlp, Whisper, GPT-4o, Google Translate, TTS)
- `chunking.js` — Splits transcripts at natural pauses (>0.5s gaps), targets ~3min chunks

**Key patterns in `media.js`:**
- `addPunctuation()` uses a two-pointer algorithm to align GPT-4o's punctuated output back to original Whisper word timestamps
- `createHeartbeat()` sends periodic SSE updates during long-running operations (extraction, download, transcription)
- `estimateWordTimestamps()` generates synthetic timestamps for TTS text mode (no Whisper timestamps available)

**API Endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/analyze` | Start analysis (returns cached if URL seen before) |
| GET | `/api/session/:sessionId` | Get session data + chunk statuses |
| GET | `/api/session/:sessionId/chunk/:chunkId` | Get ready chunk's video URL + transcript |
| POST | `/api/download-chunk` | Download a chunk (waits if prefetch in progress) |
| POST | `/api/load-more-chunks` | Load next batch for long videos |
| DELETE | `/api/session/:sessionId` | Delete session + all videos |
| POST | `/api/translate` | Google Translate proxy with caching |
| GET | `/api/progress/:sessionId` | SSE stream for progress events |

### Frontend

- `App.tsx` — State machine managing view transitions, SSE subscriptions. Two content modes: `video` (ok.ru) and `text` (lib.ru)
- `src/services/api.ts` — API client with SSE + polling fallback
- `src/types/index.ts` — Shared types: `WordTimestamp`, `Transcript`, `VideoChunk`, `SessionResponse`, `ProgressState`, `SRSCard`

### SRS Flashcard System

- `src/hooks/useDeck.ts` — Deck state with Firestore persistence (debounced 500ms writes). Accepts `userId` from `useAuth`. Falls back to localStorage if Firestore is unavailable. Migrates existing localStorage data to Firestore on first load.
- `src/hooks/useAuth.ts` — Firebase Anonymous Auth. Calls `signInAnonymously()` on mount, tracks state via `onAuthStateChanged`. Returns `{ userId, isLoading }`.
- `src/firebase.ts` — Firebase app/auth/firestore initialization. Config from `VITE_FIREBASE_*` env vars.
- `src/utils/sm2.ts` — SM-2 spaced repetition algorithm with Anki-like learning steps (1min/5min) and graduated review intervals.
- `src/components/ReviewPanel.tsx` — Flashcard review UI with keyboard shortcuts (1-4 for ratings, Space/Enter for show/good).
- `firestore.rules` — Security rules: `decks/{userId}` writable only by matching `auth.uid`. Deploy with `firebase deploy --only firestore:rules`.
- Sentence extraction: scans the words array for sentence-ending punctuation (`.!?…`) to extract only the containing sentence as flashcard context, not the full Whisper segment.

### Word Frequency Highlighting

- `public/russian-word-frequencies.json` — 92K Russian words sorted by frequency rank
- `TranscriptPanel` underlines words in a configurable frequency rank range (e.g., rank 500–1000)
- Normalization: ё→е for both frequency lookup and card deduplication (`normalizeCardId` in `sm2.ts`)

### Deployment

GCP project: `book-friend-finder`, Cloud Run service: `russian-transcription`, region: `us-central1`.

- `./deploy.sh` — Full deploy with secrets, GCS bucket setup, lifecycle policies
- `./quick-deploy.sh` — Fast local Docker build + push (`npm run build` → copy dist to server → docker build → push → `gcloud run deploy`)
- `server/Dockerfile` — Extends `russian-base:latest` (node:20-slim + ffmpeg + yt-dlp, built by `build-base.sh`)
- Frontend hosted from Cloud Run (dist copied into Docker image), not Firebase Hosting in production

## Tech Stack

- React 19 + TypeScript + Vite 7, Tailwind CSS v4
- Express.js with Server-Sent Events
- Firebase Anonymous Auth + Firestore (flashcard persistence)
- OpenAI Whisper API (transcription) + GPT-4o (punctuation/spelling) + TTS (text mode audio)
- Google Translate API, Google Cloud Storage
- yt-dlp + ffmpeg (video/audio processing)

## Important Behavioral Rules

- **Word click = translate only, NOT seek.** Clicking a word in the transcript shows a translation popup. It must NOT seek/jump the video to that word's timestamp. The video continues playing normally.

## Known Limitations

- **ok.ru focus**: Optimized for ok.ru videos (IP-locked URLs require full download)
- **Long videos**: Split into 3-5 min chunks, loaded in batches
- **Local sessions**: In-memory only, lost on restart (production persists to GCS)
- **ok.ru extraction**: Takes 90-120s due to anti-bot JS protection (`ESTIMATED_EXTRACTION_TIME = 100`)

## Production Roadmap

### Authentication & Payment (Priority: HIGH)
- Migrate from Firebase Anonymous Auth to email/password + Google OAuth
- Add Stripe subscription: $10/month, first month free
- Android app planned (React Native or PWA wrapper)
- Track per-user API usage (Whisper minutes, translations, TTS calls)
- Enforce usage quotas per tier (free trial vs paid)

### Rate Limiting (Priority: HIGH)
- Add express-rate-limit middleware to server/index.js
- Per-IP: 10 req/min on /api/analyze (expensive: Whisper + yt-dlp)
- Per-IP: 60 req/min on /api/translate
- Per-IP: 5 req/min on /api/extract-sentence (GPT calls)
- Global: budget cap on OpenAI API spend

### Session Security
- Replace timestamp-based session IDs with crypto.randomUUID()
- Add session ownership (tie sessions to authenticated user)
- Validate session access (users can only access their own sessions)

### Monitoring & Error Tracking
- Add Sentry or equivalent for error alerting
- Cloud Run error rate alerts via GCP Monitoring
- Track API costs per user for billing decisions

### Data Persistence
- Server-side deck backup (currently localStorage + Firestore)
- Export/import deck functionality

### CI/CD
- Add `node --check server/index.js` to deploy.sh (prevent syntax crashes)
- Add `npm test` to deploy.sh before deploying
- Consider GitHub Actions for automated testing on push
