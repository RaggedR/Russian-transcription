# Feature: Design Patterns for Architectural Rewrite
> Catalog of design patterns applicable to the Russian Video & Text codebase, with current-state analysis, target-state design, and interface sketches.

## Overview

This document identifies structural problems in the current codebase and maps each to a well-known design pattern that would solve it. Each section contains a concrete before/after interface sketch in TypeScript to guide the rewrite.

The patterns are ordered from backend to frontend, from foundational (patterns others depend on) to compositional (patterns that build on earlier ones).

## Resources

- [CLAUDE_DOCS/openrussian-dictionary.md](openrussian-dictionary.md) -- Dictionary service
- [CLAUDE_DOCS/whisper-tts-timestamps.md](whisper-tts-timestamps.md) -- TTS alignment
- [CLAUDE_DOCS/code-splitting.md](code-splitting.md) -- Frontend lazy loading

---

## Pattern: Strategy (Content Mode)
> Replace video/text branching with polymorphic content strategies so new content types don't require editing every handler.

### Current State

`server/index.js` uses `if (isLibRuUrl(url))` / `if (session.contentType === 'text')` branches in at least 4 places:
- `/api/analyze` (lines 1237-1287 for text, 1289-1425 for video)
- `/api/download-chunk` (lines 1779-1853 for text, 1855-1956 for video)
- `prefetchNextChunk` (lines 1986-2025 for text, 2027-2078 for video)
- Frontend `App.tsx` duplicates `handleAnalyzeVideo` and `handleAnalyzeText` with ~95% identical logic

Each branch shares the same lifecycle (analyze, chunk, download, serve) but differs in the concrete steps. Adding a third content type (e.g., YouTube with native subtitles) would require editing every branching point.

### Target State

Define a `ContentStrategy` interface. Each mode (`VideoStrategy`, `TextStrategy`) implements its own analyze/download/serve pipeline. Route handlers delegate to `strategyFor(url)` without branching.

### Interface Sketch

```typescript
// server/strategies/types.ts
interface AnalyzeResult {
  title: string;
  contentType: ContentType;
  chunks: ChunkDescriptor[];
  totalDuration: number;
  hasMoreChunks: boolean;
  /** Strategy-specific session state (chunkTexts for text, transcript for video) */
  sessionExtras: Record<string, unknown>;
}

interface ChunkResult {
  mediaUrl: string;            // videoUrl or audioUrl
  transcript: Transcript;
  title: string;
}

interface ContentStrategy {
  readonly contentType: ContentType;

  /** Detect whether this strategy handles the given URL */
  matches(url: string): boolean;

  /** Full analysis pipeline: fetch content, chunk, return chunk descriptors */
  analyze(url: string, opts: AnalyzeOpts): Promise<AnalyzeResult>;

  /** Download/generate media + transcript for one chunk */
  downloadChunk(session: Session, chunk: ChunkDescriptor, opts: DownloadOpts): Promise<ChunkResult>;

  /** Return the progress event types this strategy emits (for frontend filtering) */
  progressTypes(): string[];
}

// server/strategies/video-strategy.ts
class VideoStrategy implements ContentStrategy {
  readonly contentType = 'video';
  matches(url: string) { return /ok\.ru/.test(url); }
  progressTypes() { return ['audio', 'transcription', 'punctuation', 'video', 'lemmatization']; }
  // ...
}

// server/strategies/text-strategy.ts
class TextStrategy implements ContentStrategy {
  readonly contentType = 'text';
  matches(url: string) { return isLibRuUrl(url); }
  progressTypes() { return ['audio', 'tts', 'transcription', 'lemmatization']; }
  // ...
}

// server/strategies/index.ts
const strategies: ContentStrategy[] = [new TextStrategy(), new VideoStrategy()];
function strategyFor(url: string): ContentStrategy {
  const s = strategies.find(s => s.matches(url));
  if (!s) throw new Error('Unsupported URL');
  return s;
}
```

**Frontend counterpart:**

```typescript
// src/strategies/content-strategy.ts
interface FrontendContentStrategy {
  contentType: ContentType;
  analyzeLabel: string;           // "Analyzing Video" / "Loading Text"
  chunkLabel: string;             // "Part" / "Section"
  progressFilter: string[];       // which SSE types to show
  renderPlayer(props: PlayerProps): React.ReactNode;
}

// Eliminates handleAnalyzeVideo/handleAnalyzeText duplication in App.tsx
function handleAnalyze(url: string, strategy: FrontendContentStrategy) { ... }
```

### Files Affected

| File | Change |
|------|--------|
| `server/index.js` | Remove all `isLibRuUrl` / `contentType === 'text'` branches from handlers |
| `server/strategies/video-strategy.ts` | **New** -- video pipeline |
| `server/strategies/text-strategy.ts` | **New** -- text pipeline |
| `server/strategies/types.ts` | **New** -- shared interfaces |
| `src/App.tsx` | Merge `handleAnalyzeVideo`/`handleAnalyzeText` into single `handleAnalyze` |
| `src/strategies/` | **New** -- frontend strategy definitions |

---

## Pattern: Pipeline (Ingestion)
> Model the ingestion flow as an explicit, composable pipeline of stages instead of a deeply nested imperative blob.

### Current State

`server/index.js` `/api/analyze` handler (lines 1166-1441) is a 275-line async function with inline orchestration:

```
scrapeInfo → downloadAudio → transcribe → addPunctuation → createChunks → setSession
```

Each step is called sequentially with manual progress wiring, error cleanup (`fs.unlinkSync`), and cost tracking interleaved. The same pipeline is partially duplicated in `/api/load-more-chunks` and `prefetchNextChunk`.

`server/media.js` (1346 lines) contains all six pipeline stages plus utility functions, progress rendering, and external service calls. It is the largest file in the codebase.

### Target State

Each stage is a self-contained `PipelineStage` that takes a context bag, does its work, updates the bag, and returns it. A `Pipeline` runner composes stages, handles errors, and manages temp file cleanup.

### Interface Sketch

```typescript
// server/pipeline/types.ts
interface PipelineContext {
  url: string;
  sessionId: string;
  uid: string;
  tempDir: string;
  onProgress: ProgressCallback;

  // Accumulated by stages:
  title?: string;
  totalDuration?: number;
  audioPath?: string;
  transcript?: Transcript;
  chunks?: ChunkDescriptor[];
  tempFiles: string[];          // tracked for cleanup on error
}

interface PipelineStage {
  readonly name: string;
  execute(ctx: PipelineContext): Promise<PipelineContext>;
}

// server/pipeline/runner.ts
class Pipeline {
  private stages: PipelineStage[] = [];

  add(stage: PipelineStage): this { this.stages.push(stage); return this; }

  async run(ctx: PipelineContext): Promise<PipelineContext> {
    try {
      for (const stage of this.stages) {
        ctx = await stage.execute(ctx);
      }
      return ctx;
    } catch (err) {
      // Clean up all temp files registered by stages
      for (const f of ctx.tempFiles) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      throw err;
    }
  }
}

// Usage in video strategy:
const videoPipeline = new Pipeline()
  .add(new ScrapeInfoStage())
  .add(new DownloadAudioStage())
  .add(new TranscribeStage())
  .add(new PunctuateStage())
  .add(new ChunkStage());

// Usage in text strategy:
const textPipeline = new Pipeline()
  .add(new FetchTextStage())
  .add(new ChunkTextStage());

// Per-chunk download pipeline:
const videoChunkPipeline = new Pipeline()
  .add(new DownloadVideoStage())
  .add(new LemmatizeStage())
  .add(new UploadMediaStage());

const textChunkPipeline = new Pipeline()
  .add(new GenerateTtsStage())
  .add(new TranscribeAlignStage())
  .add(new LemmatizeStage())
  .add(new UploadMediaStage());
```

### Files Affected

| File | Change |
|------|--------|
| `server/media.js` | Split into `server/pipeline/stages/` -- one file per stage |
| `server/index.js` | Replace inline orchestration with `pipeline.run(ctx)` |
| `server/pipeline/runner.ts` | **New** -- pipeline executor with cleanup |
| `server/pipeline/stages/*.ts` | **New** -- individual stages |

---

## Pattern: Observer (Progress Broadcasting)
> Formalize the progress notification system as a typed event emitter instead of passing raw callbacks through 4 layers.

### Current State

`server/progress.js` exports `sendProgress(sessionId, type, progress, status, message, extra)` -- a 6-parameter function. Progress callbacks are threaded manually through every function signature:

```
index.js → createProgressCallback(sessionId) → downloadAudioChunk(opts.onProgress) → createHeartbeat(onProgress)
```

This creates tight coupling: `media.js` functions must accept `onProgress` even though they shouldn't know about SSE. The frontend subscribes to SSE via `subscribeToProgress()` in `api.ts`, then manually filters event types in `App.tsx` callbacks.

### Target State

A session-scoped `EventEmitter` that stages publish to and SSE handlers subscribe to. Stages don't know about SSE; they just emit typed events.

### Interface Sketch

```typescript
// server/progress/types.ts
type ProgressEventType = 'audio' | 'transcription' | 'punctuation' | 'lemmatization'
                       | 'tts' | 'video' | 'complete' | 'error';

interface ProgressEvent {
  type: ProgressEventType;
  progress: number;          // 0-100
  status: 'active' | 'complete' | 'error';
  message: string;
  extra?: Record<string, unknown>;
}

// server/progress/emitter.ts
import { EventEmitter } from 'events';

class SessionProgress extends EventEmitter {
  constructor(public readonly sessionId: string) { super(); }

  emit(event: 'progress', data: ProgressEvent): boolean;
  on(event: 'progress', listener: (data: ProgressEvent) => void): this;

  /** Convenience: emit a progress update */
  update(type: ProgressEventType, progress: number, status: string, message: string) {
    this.emit('progress', { type, progress, status, message } as ProgressEvent);
  }

  /** Convenience: emit terminal completion with extra data */
  complete(message: string, extra?: Record<string, unknown>) {
    this.emit('progress', { type: 'complete', progress: 100, status: 'complete', message, extra });
  }
}

// server/progress/registry.ts
const sessions = new Map<string, SessionProgress>();

function getOrCreate(sessionId: string): SessionProgress {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new SessionProgress(sessionId));
  }
  return sessions.get(sessionId)!;
}

// Pipeline stages use it directly:
class TranscribeStage implements PipelineStage {
  async execute(ctx: PipelineContext) {
    const progress = getOrCreate(ctx.sessionId);
    progress.update('transcription', 0, 'active', 'Transcribing...');
    // ... work ...
    progress.update('transcription', 100, 'complete', 'Done');
    return ctx;
  }
}

// SSE handler subscribes:
app.get('/api/progress/:sessionId', (req, res) => {
  const emitter = getOrCreate(req.params.sessionId);
  const handler = (data: ProgressEvent) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  emitter.on('progress', handler);
  req.on('close', () => emitter.off('progress', handler));
});
```

### Files Affected

| File | Change |
|------|--------|
| `server/progress.js` | Replace with `server/progress/emitter.ts` + `registry.ts` |
| `server/media.js` | Remove all `onProgress` parameters from function signatures |
| `server/index.js` | Remove `createProgressCallback` plumbing; SSE handler subscribes to emitter |

---

## Pattern: Repository (Session Storage)
> Clean separation between session domain logic and persistence mechanics (in-memory vs GCS).

### Current State

`server/session-store.js` is already halfway to a Repository pattern -- it has `getAnalysisSession`, `setAnalysisSession`, and handles GCS vs in-memory. However:

1. **Leaking internals**: `analysisSessions` (the LRU cache), `localSessions`, `urlSessionCache`, and `translationCache` are all exported as raw Maps/LRUCaches and mutated directly by `index.js` (e.g., `analysisSessions.set(sessionId, ...)` in the demo handler, `localSessions.set(...)` for local file tracking).
2. **Serialization concerns leak**: Callers must know that `chunkTranscripts` is a `Map` that needs `Array.from(entries)` for JSON; `setAnalysisSession` handles this but `loadDemoData` in `index.js` does `new Map(demoData.chunkTranscripts)` manually.
3. **Mixed responsibilities**: URL caching, extraction caching, translation caching, and signed URL generation all live in the same module.

### Target State

A `SessionRepository` class with a clean interface. Callers never touch the cache or storage backend directly. Separate repositories for translations and extractions.

### Interface Sketch

```typescript
// server/repositories/session-repository.ts
interface SessionRepository {
  get(sessionId: string): Promise<Session | null>;
  save(sessionId: string, session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;

  /** Find a cached session for this URL + user */
  findByUrl(url: string, uid: string): Promise<{ sessionId: string; session: Session } | null>;

  /** Cache a URL -> session mapping */
  cacheUrl(url: string, sessionId: string, uid: string): void;

  /** Get a signed media URL for a GCS file */
  getMediaUrl(gcsKey: string): Promise<string>;

  /** Store a local media file reference */
  setLocalMedia(key: string, filePath: string): void;
  getLocalMedia(key: string): string | null;

  /** List all sessions for a user (for account deletion) */
  listByUser(uid: string): Promise<string[]>;
}

// Concrete implementation hides LRU, GCS, Map internals
class GcsSessionRepository implements SessionRepository {
  private cache = new LRUCache<string, Session>({ max: 50 });
  private urlCache = new Map<string, { sessionId: string; timestamp: number }>();
  private localFiles = new Map<string, string>();

  async get(sessionId: string): Promise<Session | null> {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId)!;
    const raw = await this.loadFromGcs(sessionId);
    if (raw) {
      const session = this.deserialize(raw);
      this.cache.set(sessionId, session);
      return session;
    }
    return null;
  }

  private deserialize(raw: RawSession): Session {
    // Handle Map serialization internally -- callers never see arrays
    return {
      ...raw,
      chunkTranscripts: new Map(raw.chunkTranscripts || []),
      chunkTexts: raw.chunkTexts ? new Map(raw.chunkTexts) : undefined,
    };
  }
  // ...
}

// server/repositories/translation-repository.ts
interface TranslationRepository {
  get(word: string, sourceLang: string): Translation | null;
  set(word: string, sourceLang: string, translation: Translation): void;
}

// server/repositories/extraction-cache.ts
interface ExtractionCache {
  get(url: string): Promise<ExtractionInfo | null>;
  set(url: string, info: ExtractionInfo): Promise<void>;
}
```

### Files Affected

| File | Change |
|------|--------|
| `server/session-store.js` | Replace with `server/repositories/session-repository.ts` |
| `server/index.js` | Stop importing raw Maps; use repository methods |
| `server/repositories/translation-repository.ts` | **New** -- extracted from session-store |
| `server/repositories/extraction-cache.ts` | **New** -- extracted from session-store |

---

## Pattern: Facade (External Service Wrappers)
> Wrap each external service behind a thin interface so the pipeline stages don't couple to SDK details.

### Current State

`server/media.js` directly instantiates `new OpenAI({ apiKey })` in 4 separate functions (`transcribeAudioChunk`, `addPunctuation`, `lemmatizeWords`, `fetchLibRuText`). Each function manages its own:
- API key lookup (`process.env.OPENAI_API_KEY`)
- Client construction
- Timeout/abort logic
- Cost estimation

Similarly, Google Translate is called via raw `fetch()` in `index.js`'s `/api/translate` handler with inline key management. `yt-dlp` is invoked via both `spawn('yt-dlp', ...)` and `ytdlpBase.create('yt-dlp')` in separate places.

### Target State

One facade per external service. Each facade owns client construction, retries, timeouts, and cost constants. Pipeline stages depend on the facade interface, not on SDK classes.

### Interface Sketch

```typescript
// server/services/openai-service.ts
interface OpenAIService {
  transcribe(audioPath: string, opts?: { language?: string }): Promise<WhisperResult>;
  punctuate(text: string): Promise<string>;
  lemmatize(words: string[]): Promise<Map<string, string>>;
  generateTts(text: string, outputPath: string): Promise<{ size: number }>;
  extractSentence(text: string, word: string): Promise<{ sentence: string; translation: string }>;
  generateExamples(words: string[]): Promise<Record<string, { russian: string; english: string }>>;
  chat(opts: ChatOpts): Promise<string>;
}

class OpenAIServiceImpl implements OpenAIService {
  private client: OpenAI;
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }
  // All timeout, abort, retry logic lives here
}

// server/services/translate-service.ts
interface TranslateService {
  translate(word: string, from: string, to: string): Promise<string>;
}

class GoogleTranslateService implements TranslateService {
  constructor(private apiKey: string) {}
  // API call + error handling
}

// server/services/media-downloader.ts
interface MediaDownloader {
  downloadAudio(url: string, output: string, timeRange: TimeRange, opts?: DownloadOpts): Promise<DownloadResult>;
  downloadVideo(url: string, output: string, timeRange: TimeRange, opts?: DownloadOpts): Promise<DownloadResult>;
  getVideoInfo(url: string): Promise<VideoInfo>;
}

class YtDlpDownloader implements MediaDownloader {
  // All yt-dlp spawn logic, process-level timeouts, info.json parsing
}

// server/services/storage-service.ts
interface StorageService {
  upload(localPath: string, remotePath: string, contentType: string): Promise<void>;
  getSignedUrl(remotePath: string): Promise<string>;
  delete(remotePath: string): Promise<void>;
  exists(remotePath: string): Promise<boolean>;
}

class GcsStorageService implements StorageService { /* ... */ }
class LocalStorageService implements StorageService { /* ... */ }
```

### Files Affected

| File | Change |
|------|--------|
| `server/media.js` | Break into `server/services/openai-service.ts`, `server/services/media-downloader.ts` |
| `server/index.js` | Extract Google Translate call to `server/services/translate-service.ts` |
| `server/session-store.js` | Extract GCS operations to `server/services/storage-service.ts` |

---

## Pattern: State Machine (App.tsx View Transitions)
> Replace the implicit state machine in App.tsx with an explicit, predictable state chart.

### Current State

`src/App.tsx` (1137 lines) manages a state machine via `useState<AppView>('input')` where `AppView = 'input' | 'analyzing' | 'chunk-menu' | 'loading-chunk' | 'player'`. Transitions are scattered across 10+ callback functions (`handleAnalyzeVideo`, `handleAnalyzeText`, `handleSelectVideoChunk`, `handleSelectTextChunk`, `handleBackToChunks`, `handleReset`, `handleLoadDemo`, etc.), each calling `setView(...)` along with 5-10 other state setters.

Problems:
1. **No guard rails**: Any callback can transition to any view. Invalid transitions aren't prevented.
2. **State proliferation**: 20+ `useState` calls for session, playback, progress, UI, and auth state.
3. **Duplicated transitions**: `handleAnalyzeVideo` and `handleAnalyzeText` are near-identical 80-line functions.
4. **Cleanup scattered**: SSE cleanup, progress reset, URL clearing happen in multiple callbacks.

### Target State

An explicit state machine where each state declares its allowed transitions and the data it carries. A `useReducer` (or a library like XState/Zag) enforces valid transitions.

### Interface Sketch

```typescript
// src/state/types.ts
type AppState =
  | { view: 'input' }
  | { view: 'analyzing'; url: string; contentType: ContentType; sessionId: string | null }
  | { view: 'chunk-menu'; sessionId: string; title: string; chunks: VideoChunk[];
      totalDuration: number; hasMoreChunks: boolean; contentType: ContentType }
  | { view: 'loading-chunk'; sessionId: string; chunkIndex: number; contentType: ContentType }
  | { view: 'player'; sessionId: string; chunkIndex: number; contentType: ContentType;
      mediaUrl: string; transcript: Transcript; title: string };

type AppAction =
  | { type: 'ANALYZE_START'; url: string; contentType: ContentType }
  | { type: 'ANALYZE_CACHED'; sessionId: string; title: string; chunks: VideoChunk[];
      totalDuration: number; hasMoreChunks: boolean; contentType: ContentType }
  | { type: 'ANALYZE_COMPLETE'; sessionId: string; title: string; chunks: VideoChunk[];
      totalDuration: number; hasMoreChunks: boolean }
  | { type: 'ANALYZE_ERROR'; error: string }
  | { type: 'SELECT_CHUNK'; chunk: VideoChunk }
  | { type: 'CHUNK_READY'; mediaUrl: string; transcript: Transcript; title: string }
  | { type: 'CHUNK_ERROR'; error: string }
  | { type: 'BACK_TO_CHUNKS'; updatedChunks?: VideoChunk[] }
  | { type: 'LOAD_MORE_COMPLETE'; newChunks: VideoChunk[]; hasMoreChunks: boolean }
  | { type: 'RESET' };

// src/state/reducer.ts
function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'ANALYZE_START':
      // Only valid from 'input'
      if (state.view !== 'input') return state;
      return { view: 'analyzing', url: action.url, contentType: action.contentType, sessionId: null };

    case 'ANALYZE_COMPLETE':
      if (state.view !== 'analyzing') return state;
      return {
        view: 'chunk-menu',
        sessionId: action.sessionId,
        title: action.title,
        chunks: action.chunks,
        totalDuration: action.totalDuration,
        hasMoreChunks: action.hasMoreChunks,
        contentType: state.contentType,
      };

    case 'SELECT_CHUNK':
      if (state.view !== 'chunk-menu') return state;
      if (action.chunk.status === 'ready') {
        // Transition directly to player (data fetched by effect)
        return { ...state, view: 'loading-chunk', chunkIndex: action.chunk.index } as AppState;
      }
      return { ...state, view: 'loading-chunk', chunkIndex: action.chunk.index } as AppState;

    case 'CHUNK_READY':
      if (state.view !== 'loading-chunk') return state;
      return {
        view: 'player',
        sessionId: state.sessionId,
        chunkIndex: state.chunkIndex,
        contentType: state.contentType,
        mediaUrl: action.mediaUrl,
        transcript: action.transcript,
        title: action.title,
      };

    case 'RESET':
      return { view: 'input' };

    default:
      return state;
  }
}

// src/App.tsx -- shrinks from 1137 lines to ~300
function App() {
  const [state, dispatch] = useReducer(appReducer, { view: 'input' });
  // Side effects in useEffect based on state.view
  // Render by switching on state.view (each branch gets typed context)
}
```

### Files Affected

| File | Change |
|------|--------|
| `src/App.tsx` | Replace 20+ useState + 10 callbacks with `useReducer` + effect hooks |
| `src/state/types.ts` | **New** -- state and action types |
| `src/state/reducer.ts` | **New** -- pure reducer with transition guards |
| `src/types/index.ts` | `AppView` type becomes part of discriminated union |

---

## Pattern: Adapter (Media Playback)
> Normalize YouTube, Vimeo, HLS, and HTML5 video behind a uniform playback interface.

### Current State

`src/components/VideoPlayer.tsx` (339 lines) contains:
- A `getVideoSource()` function that pattern-matches URLs into `{ type: 'youtube' | 'vimeo' | 'direct' }`
- 7 separate `useEffect` hooks for initializing YouTube, Vimeo, HLS.js, and HTML5 players
- A 70-line `useEffect` for keyboard shortcuts with a 3-way `if/else` chain duplicating play/pause/seek for each player type
- `AudioPlayer.tsx` (80 lines) duplicates the HTML5 playback + keyboard logic

The component violates open/closed -- adding a new source (e.g., Dailymotion) requires editing the switch in `getVideoSource`, adding new `useEffect` hooks, and extending the keyboard handler.

### Target State

A `PlaybackAdapter` interface that each source implements. The `VideoPlayer` component receives an adapter and delegates all operations to it.

### Interface Sketch

```typescript
// src/adapters/types.ts
interface PlaybackAdapter {
  readonly type: string;

  /** Attach to a DOM container and start the player */
  attach(container: HTMLElement): void;

  /** Detach and clean up (remove iframes, clear intervals) */
  detach(): void;

  play(): void;
  pause(): void;
  seek(time: number): void;
  getCurrentTime(): number;
  isPaused(): boolean | Promise<boolean>;

  /** Subscribe to time updates (100ms polling or native events) */
  onTimeUpdate(cb: (time: number) => void): () => void;
}

// src/adapters/html5-video-adapter.ts
class Html5VideoAdapter implements PlaybackAdapter {
  readonly type = 'html5-video';
  private video: HTMLVideoElement | null = null;
  private interval: number | null = null;

  constructor(private url: string) {}

  attach(container: HTMLElement) {
    this.video = document.createElement('video');
    this.video.src = this.url;
    this.video.controls = true;
    this.video.className = 'w-full aspect-video';
    container.appendChild(this.video);
  }

  detach() {
    if (this.interval) clearInterval(this.interval);
    this.video?.remove();
  }

  play() { this.video?.play(); }
  pause() { this.video?.pause(); }
  seek(t: number) { if (this.video) this.video.currentTime = t; }
  getCurrentTime() { return this.video?.currentTime ?? 0; }
  isPaused() { return this.video?.paused ?? true; }

  onTimeUpdate(cb: (t: number) => void) {
    this.interval = window.setInterval(() => {
      if (this.video && !this.video.paused) cb(this.video.currentTime);
    }, 100);
    return () => { if (this.interval) clearInterval(this.interval); };
  }
}

// src/adapters/html5-audio-adapter.ts
class Html5AudioAdapter implements PlaybackAdapter {
  // Same interface, backed by <audio> instead of <video>
}

// src/adapters/hls-adapter.ts
class HlsAdapter implements PlaybackAdapter {
  // Wraps hls.js initialization + HTML5 video element
}

// src/adapters/youtube-adapter.ts
class YouTubeAdapter implements PlaybackAdapter {
  // Wraps YT.Player API
}

// src/adapters/vimeo-adapter.ts
class VimeoAdapter implements PlaybackAdapter {
  // Wraps @vimeo/player
}

// src/adapters/factory.ts
function createAdapter(url: string, originalUrl?: string): PlaybackAdapter {
  if (originalUrl?.includes('youtube.com') || originalUrl?.includes('youtu.be')) {
    return new YouTubeAdapter(extractYouTubeId(originalUrl));
  }
  if (originalUrl?.includes('vimeo.com')) {
    return new VimeoAdapter(extractVimeoId(originalUrl));
  }
  if (url.includes('.m3u8')) {
    return new HlsAdapter(url);
  }
  return new Html5VideoAdapter(url);
}

// src/components/MediaPlayer.tsx -- unified component (~60 lines)
function MediaPlayer({ url, originalUrl, onTimeUpdate }: MediaPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<PlaybackAdapter | null>(null);

  useEffect(() => {
    const adapter = createAdapter(url, originalUrl);
    adapterRef.current = adapter;
    if (containerRef.current) adapter.attach(containerRef.current);
    const unsub = adapter.onTimeUpdate(onTimeUpdate);
    return () => { unsub(); adapter.detach(); };
  }, [url, originalUrl, onTimeUpdate]);

  // One keyboard handler, no branching
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const a = adapterRef.current;
      if (!a) return;
      switch (e.code) {
        case 'Space': e.preventDefault(); a.isPaused() ? a.play() : a.pause(); break;
        case 'ArrowLeft': e.preventDefault(); a.seek(Math.max(0, a.getCurrentTime() - 5)); break;
        case 'ArrowRight': e.preventDefault(); a.seek(a.getCurrentTime() + 5); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return <div ref={containerRef} className="relative bg-black rounded-lg overflow-hidden" />;
}
```

### Files Affected

| File | Change |
|------|--------|
| `src/components/VideoPlayer.tsx` | Replace with `src/components/MediaPlayer.tsx` (~60 lines) |
| `src/components/AudioPlayer.tsx` | Remove -- absorbed into `Html5AudioAdapter` |
| `src/adapters/*.ts` | **New** -- one file per adapter |
| `src/adapters/factory.ts` | **New** -- adapter selection logic |
| `src/App.tsx` | Replace `<VideoPlayer>` and `<AudioPlayer>` with `<MediaPlayer>` |

---

## Pattern: Mediator (Transcript Coordination)
> Centralize the word-click flow (translate, show popup, add to deck) instead of threading callbacks through 4 component layers.

### Current State

`TranscriptPanel.tsx` manages its own translation state (`selectedWord`, `translation`, `isTranslating`, `translationError`, `selectedContext`) and calls `apiRequest('/api/translate')` directly. It receives `onAddToDeck` and `isWordInDeck` callbacks from `App.tsx`, which forwards them from `useDeck`. The `WordPopup` component receives 7 props to coordinate the translate-then-add flow.

This works today but creates a coupling chain: `App → TranscriptPanel → WordPopup → useDeck`, where adding a new interaction (e.g., "hear pronunciation") requires plumbing through every layer.

### Target State

A `useWordInteraction` hook acts as a mediator, owning the selected word, translation, and popup state. Components subscribe to it via context rather than prop drilling.

### Interface Sketch

```typescript
// src/hooks/useWordInteraction.ts
interface WordInteractionState {
  selectedWord: WordTimestamp | null;
  translation: Translation | null;
  isTranslating: boolean;
  error: string | null;
  context: string | undefined;
}

interface WordInteractionActions {
  selectWord(word: WordTimestamp, surroundingWords: WordTimestamp[]): void;
  closePopup(): void;
  addToDeck(): void;
  isInDeck(word: string): boolean;
}

const WordInteractionContext = createContext<WordInteractionState & WordInteractionActions>(/* ... */);

function useWordInteraction(): WordInteractionState & WordInteractionActions {
  return useContext(WordInteractionContext);
}

// Provider wraps the player view
function WordInteractionProvider({ children, deck }: { children: ReactNode; deck: DeckHook }) {
  const [state, setState] = useState<WordInteractionState>({ ... });

  const selectWord = useCallback(async (word, surrounding) => {
    setState(s => ({ ...s, selectedWord: word, isTranslating: true }));
    const translation = await apiRequest('/api/translate', ...);
    setState(s => ({ ...s, translation, isTranslating: false }));
  }, []);

  // ... addToDeck calls deck.addCard internally

  return (
    <WordInteractionContext.Provider value={{ ...state, selectWord, closePopup, addToDeck, isInDeck }}>
      {children}
    </WordInteractionContext.Provider>
  );
}

// TranscriptPanel becomes simpler -- no translation state, no API calls
function TranscriptPanel({ transcript, currentTime, config, wordFrequencies }) {
  const { selectWord } = useWordInteraction();
  // Just renders words, calls selectWord on click
}

// WordPopup reads from context
function WordPopup() {
  const { selectedWord, translation, isTranslating, error, closePopup, addToDeck, isInDeck } = useWordInteraction();
  if (!selectedWord) return null;
  // Render popup
}
```

### Files Affected

| File | Change |
|------|--------|
| `src/components/TranscriptPanel.tsx` | Remove all translation state + API calls |
| `src/components/WordPopup.tsx` | Read from context instead of props |
| `src/hooks/useWordInteraction.ts` | **New** -- mediator hook |
| `src/App.tsx` | Remove `onAddToDeck`/`isWordInDeck` prop drilling |

---

## Pattern: Command (Cost Tracking)
> Encapsulate each billable operation as a command object with its cost metadata, instead of scattering `trackCost()` calls.

### Current State

Cost tracking is manual and error-prone. After each API call, the caller must remember to insert the right `trackCost(uid, costs.xxx())` line:

```javascript
// In index.js /api/analyze handler:
trackCost(uid, costs.whisper(audioDurationSec));    // line 1361
// ... 3 lines later ...
trackCost(uid, costs.gpt4o());                      // line 1365

// In download-chunk text mode:
trackCost(req.uid, costs.tts(chunkText.length));    // line 1799
trackCost(req.uid, costs.whisper(duration));         // line 1804
trackCost(req.uid, costs.gpt4o());                   // line 1808
```

It's easy to forget a `trackCost` call or use the wrong cost constant. The same cost tracking is duplicated in `prefetchNextChunk`.

### Target State

Each pipeline stage or service facade method returns a `CostRecord` alongside its result. The pipeline runner aggregates costs and tracks them once at the end.

### Interface Sketch

```typescript
// server/costs/types.ts
interface CostRecord {
  service: 'whisper' | 'gpt4o' | 'gpt4o-mini' | 'tts' | 'translate';
  amount: number;       // USD
  metadata?: Record<string, number>;  // e.g., { durationSec: 180 } or { chars: 3500 }
}

// Pipeline context accumulates costs
interface PipelineContext {
  // ... existing fields ...
  costs: CostRecord[];
}

// Each stage appends its costs
class TranscribeStage implements PipelineStage {
  async execute(ctx: PipelineContext) {
    const result = await this.openai.transcribe(ctx.audioPath);
    ctx.costs.push({ service: 'whisper', amount: estimateWhisperCost(result.duration) });
    ctx.transcript = result;
    return ctx;
  }
}

// Pipeline runner tracks all costs at the end
class Pipeline {
  async run(ctx: PipelineContext) {
    for (const stage of this.stages) {
      ctx = await stage.execute(ctx);
    }
    // Single place for cost tracking
    for (const cost of ctx.costs) {
      trackCost(ctx.uid, cost.amount);
    }
    return ctx;
  }
}
```

### Files Affected

| File | Change |
|------|--------|
| `server/usage.js` | Keep `trackCost` but remove scattered calls from index.js |
| `server/index.js` | Remove all `trackCost` calls -- pipeline runner handles them |
| `server/pipeline/runner.ts` | Add cost aggregation |
| `server/costs/types.ts` | **New** -- cost record type |

---

## Summary: Dependency Graph

The patterns have dependencies. Implement in this order:

```
1. Facade (services/)        -- no dependencies, enables everything else
2. Repository (repositories/) -- no dependencies
3. Observer (progress/)       -- no dependencies
4. Pipeline (pipeline/)       -- depends on Facade, Observer
5. Strategy (strategies/)     -- depends on Pipeline
6. Command (costs/)           -- depends on Pipeline
7. Adapter (adapters/)        -- frontend, independent
8. State Machine (state/)     -- frontend, independent
9. Mediator (hooks/)          -- frontend, depends on Adapter/State Machine
```

Phases 1-3 are foundational extractions (pure refactoring, no behavior change).
Phases 4-6 restructure the backend flow.
Phases 7-9 restructure the frontend.

## Assets

Backend files analyzed:
- `/Users/robin/git/russian/server/media.js` (1346 lines)
- `/Users/robin/git/russian/server/index.js` (2157 lines)
- `/Users/robin/git/russian/server/session-store.js` (399 lines)
- `/Users/robin/git/russian/server/progress.js` (116 lines)
- `/Users/robin/git/russian/server/chunking.js` (316 lines)

Frontend files analyzed:
- `/Users/robin/git/russian/src/App.tsx` (1137 lines)
- `/Users/robin/git/russian/src/components/VideoPlayer.tsx` (339 lines)
- `/Users/robin/git/russian/src/components/TranscriptPanel.tsx` (242 lines)
- `/Users/robin/git/russian/src/components/AudioPlayer.tsx` (80 lines)
- `/Users/robin/git/russian/src/types/index.ts` (148 lines)
