# Feature: Content Library
> Browse and instantly open previously analyzed content from all users.

## Overview
The Content Library is an in-memory index of all sessions across all users, deduplicated by normalized URL (most recent session wins). Users can browse available content on the landing page and click to open — cloning the source session gives instant access to existing chunks without re-analyzing.

No subscription required to browse. Auth required (global middleware).

## How It Works

### Library Index (`server/storage/library-index.js`)
- `Map<normalizedUrl, LibraryEntry>` — deduplicated by URL
- Rebuilt from GCS on startup via `rebuildUrlCache()`
- Updated incrementally on `setAnalysisSession()` and `deleteSessionAndVideos()`

### Session Cloning (`POST /api/library/open`)
When a user opens a library item, `cloneSession()` creates a new session owned by the current user. Media files are NOT copied — fresh signed URLs are generated pointing to the original session's GCS objects (signed URLs are bucket-scoped, not user-scoped).

### Frontend (`src/components/Library.tsx`)
Card grid rendered below demo buttons on the landing page. Shows title, content type badge, chunk count, duration, and relative date.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/library` | GET | Yes | Returns `{ items: LibraryItem[] }` sorted by createdAt desc |
| `/api/library/open` | POST | Yes | Body: `{ sourceSessionId }`. Clones session for current user |

## Resources
- [Demo Load More](demo-load-more.md) — related feature for extending demo content

## Assets
- `server/storage/library-index.js` — In-memory library index
- `server/storage/session-repository.js` — `cloneSession()`, library integration
- `server/session-store.js` — Barrel exports
- `server/index.js` — Library endpoints
- `src/components/Library.tsx` — Frontend component
- `src/services/api.ts` — `fetchLibrary()`, `openLibraryItem()`
- `src/App.tsx` — Library state, fetch, handler
