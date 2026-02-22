# Feature: Browser History Navigation
> Browser back/forward buttons navigate between app views via React Router.

## Overview

The app uses `react-router-dom` (BrowserRouter) to map its three main views to URL paths. This means the browser's back and forward buttons work naturally — users can go back from the player to the chunk menu, or from the chunk menu to the input screen.

### Routes

| Route | View | Description |
|-------|------|-------------|
| `/` | `input` | URL input + demo buttons |
| `/chunks` | `chunk-menu` | Chunk selection menu |
| `/player` | `player` | Video/audio player with transcript |

### Transient States

`analyzing` and `loading-chunk` are loading overlays managed by React state (`transientView`), not by the router. They don't create history entries — pressing back during analysis does nothing (URL is still `/`), which is correct UX.

The `transientView` is cleared automatically whenever `location.pathname` changes (e.g., on browser back/forward).

### Route Guards

If a user navigates forward (via browser button) to `/chunks` or `/player` after session data was cleared (e.g., after reset), a `useEffect` guard redirects them to `/` with `replace: true`.

Guards check:
- `/chunks` requires `sessionId` or non-empty `sessionChunks`
- `/player` requires `transcript`, `videoUrl`, or `audioUrl`

### How `setView()` Was Replaced

Each former `setView()` call maps to either `navigate()` (URL change) or `setTransientView()` (overlay):

- `setView('analyzing')` → `setTransientView('analyzing')`
- `setView('loading-chunk')` → `setTransientView('loading-chunk')`
- `setView('chunk-menu')` → `navigate('/chunks')` (forward) or `setTransientView(null)` (error recovery on `/chunks`)
- `setView('player')` → `navigate('/player')`
- `setView('input')` → `navigate('/')` or `setTransientView(null)` (error recovery on `/`)

Error fallbacks use `replace: true` to avoid polluting the history stack.

## Resources

- [React Router docs](https://reactrouter.com/)
- `ARCHITECTURE.md` — overall app flow diagrams

## Assets

| File | Role |
|------|------|
| `src/main.tsx` | Wraps `<App>` in `<BrowserRouter>` |
| `src/App.tsx` | URL-derived view, transient overlays, route guards, all `navigate()` calls |
| `tests/app.test.tsx` | Unit tests with `MemoryRouter` wrapper + 4 browser history tests |
| `e2e/tests/browser-history.spec.ts` | 4 Playwright E2E tests for back/forward behavior |
