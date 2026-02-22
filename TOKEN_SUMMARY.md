# Token Summary: Modular Extraction of media.js and session-store.js

**Date**: 2026-02-22
**Model**: Claude Opus 4.6
**Task**: Extract two backend monoliths into clean sub-modules using Facade and Repository patterns

## Estimated Token Usage

| Category | Tokens | Notes |
|----------|--------|-------|
| System prompt + CLAUDE.md | ~10K | Loaded every turn |
| Plan (user message) | ~3K | Detailed plan with exact line ranges |
| Reading source files | ~32K | media.js (25K) + session-store.js (7K) |
| Writing 12 new files | ~30K | Bulk of output cost |
| Writing 2 barrels | ~1K | Thin re-export files |
| Test output (3 runs) | ~3K | Verified at each barrel stage |
| Tool calls + commentary | ~6K | Task management, git stash verification |
| **Total estimate** | **~85-100K** | Across ~10 API turns |

## Cost Breakdown (at Opus pricing)

| | Tokens | Cost |
|--|--------|------|
| Input | ~55K | ~$0.83 |
| Output | ~36K | ~$0.54 |
| **Total** | **~91K** | **~$1.37** |

*Prices based on $15/M input, $15/M output (cached input would be cheaper).*

## What Was Efficient

- **Pre-reading both files in parallel** (single turn) — avoided re-reading across rounds
- **Sequential in-context extraction** turned out cheaper than sub-agent parallelization because:
  - Files were already in context (no need to re-send to each agent)
  - Each agent would have needed its own system prompt (~10K overhead × 12 agents = ~120K wasted)
  - The extraction was mostly mechanical copy-paste, not deep reasoning
- **Testing at barrel boundaries only** (rounds 3 and 5) — avoided running tests after each individual file
- **git stash verification** — cheap way to confirm pre-existing failures vs regressions

## What Was Wasteful

- **Task management overhead**: Created 10 TaskCreate + 20 TaskUpdate calls. For a sequential workflow this added ~2K tokens of ceremony with no parallelization benefit. A simple checklist in commentary would have sufficed.
- **Full file writes**: Each extracted module is a verbatim copy of the original functions. A diff-based approach (if one existed) would have been ~5x cheaper for output tokens.
- **System prompt repetition**: ~10K tokens re-sent on every turn. With 10 turns, that's ~100K input tokens just for context — roughly equal to the actual work.

## Recommendations for Similar Tasks

1. **Skip sub-agents for mechanical extraction** — when source files fit in context (<2K lines), sequential in-context is cheaper than spawning agents with their own system prompt overhead.
2. **Batch file writes** — writing 4 files in one turn (Round 2) was efficient; could have batched Round 4's 6 files similarly.
3. **Test less during extraction** — could have skipped the Round 3 test and only tested once after both barrels were done. Risk: harder to debug which barrel broke things.
4. **Plan was worth the cost** — the detailed plan with exact line ranges meant zero false starts or rework. The planning session (separate conversation) likely saved 2-3x its cost in avoided mistakes.
