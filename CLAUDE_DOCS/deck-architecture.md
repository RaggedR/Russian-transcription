# Feature: Deck Architecture
> Flashcard/SRS system split into layered modules: orchestration, persistence, enrichment, and algorithm.

## Overview

The deck system manages flashcard state, Firestore persistence, and background enrichment (dictionary lookup + GPT example sentences). It was refactored from a single "god hook" into four layers:

```
App.tsx
  └── useDeck(userId)            ← thin orchestrator (state + coordination)
        ├── deck-persistence.ts  ← Firestore/localStorage IO
        ├── deck-enrichment.ts   ← dictionary + example API calls
        └── sm2.ts               ← pure scheduling algorithm
              └── russian.ts     ← shared normalizeRussianWord, speak
```

### Layer Responsibilities

| Layer | File | Responsibility |
|-------|------|----------------|
| **Orchestrator** | `src/hooks/useDeck.ts` | React state, card CRUD, coordinates persistence and enrichment |
| **Persistence** | `src/services/deck-persistence.ts` | Firestore load/save, localStorage fallback/migration, debounced writes |
| **Enrichment** | `src/services/deck-enrichment.ts` | Batch dictionary lookup (`/api/enrich-deck`), batch example generation (`/api/generate-examples`), single-card example at add time |
| **Algorithm** | `src/utils/sm2.ts` | SM-2 spaced repetition scheduling, card creation, due card filtering |
| **Utilities** | `src/utils/russian.ts` | `normalizeRussianWord()` (dedup/frequency lookup), `speak()` (Web Speech API) |

### Key Design Decisions

1. **WordPopup is pure presentation** — clicking "Add to deck" synchronously calls `onAddToDeck`. Example sentence generation happens asynchronously in `useDeck` via fire-and-forget `enrichSingleCardExample()`.

2. **SM-2 ease factor only changes during review phase** — learning phase (repetition === 0) uses fixed intervals without modifying EF. This prevents new cards from being penalized by early struggles.

3. **Enrichment is best-effort** — all enrichment functions catch errors, report to Sentry, and return the original data unchanged. The deck always loads successfully.

4. **Persistence uses factory pattern** — `createDebouncedSave()` returns a `{ save, cleanup }` object. The `useDeck` hook recreates it when `userId` changes.

### Testing

Each layer has dedicated tests. Enrichment and persistence are tested in isolation with mocked API/Firestore; the orchestrator (`use-deck.test.tsx`) tests integration across layers. See the test files in [Assets](#assets) and `CLAUDE.md` for testing patterns (mock boundaries, E2E auth bypass, test isolation).

## Resources

- [OpenRussian Dictionary](./openrussian-dictionary.md) — dictionary data source for enrichment

## Assets

- `src/hooks/useDeck.ts` — orchestrator hook
- `src/services/deck-persistence.ts` — Firestore IO
- `src/services/deck-enrichment.ts` — enrichment service
- `src/utils/sm2.ts` — SM-2 algorithm
- `src/utils/russian.ts` — shared Russian language utilities
- `src/components/WordPopup.tsx` — translation popup (pure presentation)
- `src/components/ReviewPanel.tsx` — flashcard review UI
- `tests/deck-persistence.test.ts` — persistence tests
- `tests/deck-enrichment.test.ts` — enrichment tests
- `tests/sm2.test.ts` — algorithm tests
- `tests/word-popup.test.tsx` — popup tests
- `tests/use-deck.test.tsx` — orchestrator tests
