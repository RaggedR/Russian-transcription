# Feature: Demo Load More
> Demo sessions now support "Load More Parts" for video, and show all text sections upfront.

## Overview
Previously, demo sessions were in-memory only with `hasMoreChunks: false`. Now:

- **Video demo**: Pre-bakes first N chunks. Stores full `transcript` and `nextBatchStartTime` so the existing load-more pipeline can download more audio from ok.ru in real-time.
- **Text demo**: Stores `rawText`. On demo load, ALL text chunks are created via `createTextChunks()` — pre-baked chunks are `status: 'ready'` (with TTS audio), remaining are `status: 'pending'` (TTS generated on-demand when clicked).

## Key Changes

### generate-demo.js
- Video output now includes: `transcript`, `nextBatchStartTime`, `hasMoreChunks`
- Text output now includes: `rawText` (full book text for on-demand chunking)

### Demo Endpoint (`POST /api/demo`)
- Sessions persisted to GCS via `setAnalysisSession()` (required for load-more to find the session)
- Video: sets `session.transcript` and `session.nextBatchStartTime` from demo JSON
- Text: calls `createTextChunks(rawText)` to create all chunks; marks pre-baked as ready, rest as pending

### No Changes to Load-More Endpoint
The existing `POST /api/load-more-chunks` already handles any session with `hasMoreChunks: true` and `nextBatchStartTime`. Demo sessions just need the right fields set.

## Resources
- [Content Library](content-library.md) — library uses the same persisted sessions

## Assets
- `server/scripts/generate-demo.js` — Demo generator with new fields
- `server/index.js` — Modified demo endpoint
- `server/demo/demo-video.json` — Pre-baked video demo (re-generate to get new fields)
- `server/demo/demo-text.json` — Pre-baked text demo (re-generate to get rawText)
