# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Decision Flow Viewer — a browser-based viewer for local Claude Code, Codex, and Cherry Studio session history. Supports Claude JSONL sessions in `~/.claude/projects/**/*.jsonl`, Codex rollout sessions in `~/.codex/sessions/**/*.jsonl`, and server-backed Cherry Studio sessions from the resolved local user-data store: agent sessions from `Data/agents.db` plus recovered regular chats from the same IndexedDB/Local Storage-backed app data.

## Commands

```bash
npm run dev       # Start the integrated local app server: Vite frontend + Node middleware APIs + SQLite search service
npm run build     # tsc -b && vite build
npm run lint      # eslint .
npm run preview   # Preview the production build with the same local API middleware mounted
npx vitest        # Run all tests
npx vitest run src/lib/__tests__/parser.test.ts
npx vitest run src/lib/__tests__/codex-parser.test.ts
npx vitest run src/lib/__tests__/vite-plugin-claude-data.test.ts
npx vitest run server/search/sqlite-search-service.test.ts
npx vitest run src/components/search/SearchResultsPanel.test.tsx
npx vitest run src/components/sidebar/Sidebar.test.tsx
```

## Local Runtime

- There is no separate backend process to start. `npm run dev` and `npm run preview` both run the frontend and the local Node-side API in one process.
- The local API is mounted by `vite-plugin-claude-data.ts`; it serves scan/session/tool-result endpoints and the SQLite-backed search endpoints.
- Transcript search requires this local server mode. Opening static built files without the Vite/preview server will not provide `/api/search` or any other local API routes.
- Browser-only file access mode is still supported for browsing Claude Code and Codex session files, but not for transcript search or Cherry Studio sessions. Cherry Studio support is currently local-server-only because the browser/manual store does not read the app's local user-data stores or recover Cherry regular chats; manual/browser loading must surface that boundary instead of pretending it is a normal folder scan.

## Architecture

### Data Flow

```
~/.claude/projects/{encodedProjectName}/{sessionId}.jsonl
~/.codex/sessions/YYYY/MM/DD/{rolloutId}.jsonl + ~/.codex/session_index.jsonl
~/.cherrystudio/config/config.json (optional `userData` override)
~/Library/Application Support/CherryStudio*/Data/agents.db
~/Library/Application Support/CherryStudio*/IndexedDB/**
    ↓
FileStore (3 implementations, source-aware)
    ↓
parser.ts: source detection + dispatch
    ↓
providers/claude.ts | codex-parser.ts | providers/cherrystudio.ts → SessionData { source, messages, prompts, heatmap, markers }
    ↓
useSessionStore (useReducer) → AppContext
    ↓
AppShell → Sidebar (with marker filter) + SessionView + Timeline
```

### FileStore Abstraction (`src/lib/fs-access.ts`)

Three implementations behind one `FileStore` interface, tried in order:
1. **APIFileStore** — Dev mode: Vite server plugin (`vite-plugin-claude-data.ts`) serves source-aware endpoints for `~/.claude` and `~/.codex`
2. **FSAccessStore** — Production: File System Access API (`showDirectoryPicker`), user picks home directory, `.claude`, or `.codex`
3. **InputFallbackStore** — Drag-and-drop file input fallback

**API Endpoints** (served by `vite-plugin-claude-data.ts` in local server mode, including both `dev` and `preview`):
- `/api/scan` — Scan all projects, return `ProjectMeta[]` with session markers
- `/api/scan-project/:source/:projectEncoded` — Scan all sessions for one project
- `/api/session/:source/:project/:session` — Read full session content for parsing
- `/api/tool-result/:source/:project/:session/:path` — Read tool result overflow files (`claude` only)
- `/api/search/status` — Report local SQLite search availability and index stats
- `/api/search` — Query the local SQLite-backed transcript index
- `/api/skill-recommendations/status` — Report whether local Claude-backed skill analysis is ready to run
- `/api/skill-recommendations` — Run the on-demand Claude-backed skill analysis flow

**Scanning strategy differs by store**:
- **APIFileStore (dev)**: source-aware Vite plugin scans both roots, persists quick-scan metadata to a local cache under the user's cache directory, and reuses the first `/api/scan` response instead of fetching it twice on boot. Initial `Codex` project payloads are root-first; full per-project session lists are fetched on demand.
- **FSAccessStore / InputFallbackStore (production)**: source-aware browser scans use lightweight reads only. Claude uses `quickScanMetadata()`. Codex uses `quickScanCodexMetadata()`, groups sessions by `session_meta.cwd`, extracts primary/subagent thread metadata from `session_meta`, and uses batched concurrent head reads instead of fully serial scanning.
- Cherry Studio stays local-server-only. The browser store should show an explicit unsupported notice for Cherry inputs and never misclassify them as Claude data.

### JSONL Parsing Pipeline (`src/lib/parser.ts`)

`parseSessionContent(content, source?)` is the shared entry point:

1. **Detect source** when not provided
2. **Dispatch to provider-specific parser**
3. **Normalize into shared `SessionData`** so UI/state stay source-agnostic

Provider details:
- `src/lib/providers/claude.ts` keeps Claude-specific tree parsing, compaction, `/clear`, and marker logic
- `src/lib/codex-parser.ts` handles Codex `response_item` / `event_msg` normalization, task lifecycle, tool calls/results, rollback markers, and thread metadata extraction (`primary` vs `subagent`)
- `src/lib/providers/cherrystudio.ts` parses serialized Cherry Studio payloads for both `agents.db` agent sessions and recovered regular-chat topics

**Exports from `parser.ts`**:
- `parseSessionContent(content, source?)` → `SessionData`
- `quickScanMetadata(head, sessionId, fileSize)` → Claude lightweight scan entry
- `quickScanCodexMetadata(head, sessionId, fileSize, threadName?)` → Codex lightweight scan entry
- `decodeProjectName()`, `extractShortName()`, `disambiguateShortNames()` — project name utilities (used by fs-access.ts)

**Note**: Claude and Codex no longer share a single monolithic parser implementation. Keep provider-specific logic in their own modules and preserve `parser.ts` as the dispatch boundary.

### Conversation Tree (`src/lib/tree-parser.ts`)

Handles Claude Code's tree-structured conversations:

- **Active path**: Traced from tip (last record) to root via `parentUuid` chain. Multiple disconnected trees arise from `/clear` commands — each tree gets its own tip trace.
- **`logicalParentUuid`**: `compact_boundary` records have `parentUuid: null` but `logicalParentUuid` connecting them to pre-compact records. The tree parser uses this to bridge the gap.
- **Fork detection**: Parent nodes with >1 child where some children are off the active path → abandoned branches collected via BFS subtree traversal.
- **Tool result siblings**: Leaf tool_result children of active nodes are added to the active path to prevent false fork detection when multiple tool calls are chained in a single assistant turn.

**Fork Reason Classification**:
- `'user-decision'`: User actively rewound the conversation or interrupted Claude
- `'tool-error'`: Automatic retry after tool failure (hidden from display to match CLI behavior)

### Session Markers (`SessionMarkers` in `src/types/session.ts`)

Counts of special events in a session: `{ compacts, plans, clears, forks }`.

**Two-tier collection**:
1. **Scan-time** (API mode, Claude only): Vite plugin counts `compacts`, `plans`, `clears` via regex on raw file content. `forks` is always 0 (requires tree analysis).
2. **Parse-time**: `parseSessionContent()` computes exact counts from parsed messages, including `forks`, and is the only marker source for Codex sessions. The `LOAD_SESSION` reducer writes these back to `SessionMeta` in the project list.

### Shared UI Components (`src/components/shared/`)

**HoverCard** (`HoverCard.tsx`): Reusable hover popover used by PromptIndex and Timeline.
- `useHoverCard<T>()` hook — debounced show (300ms) / hide (150ms), tracks `hoveredId` + `anchorRect`
- `HoverCard` component — rendered via `createPortal(document.body)` with `position: fixed` to escape `overflow` clipping
- `placement: 'below' | 'left'` — PromptIndex uses `below`, Timeline uses `left`
- Dynamic width: `<80 chars → 240px`, `<200 chars → 360px`, `else → 480px`, `max-height: 400px` with scroll
- Renders markdown via `react-markdown` + `remark-gfm`

### Supporting Modules

- `src/lib/decision-detector.ts` — Classifies user prompt decisions: `'interrupt'` (contains `[Request interrupted by user]`), `'correction'` (promptNum > 1 + keywords like "no", "wrong", "stop", "instead"), or `'none'`
- `src/lib/heatmap.ts` — Per-prompt intensity scoring (0–1) for sidebar heatmap. Weights: tool calls +1, errors +3, forks +5, thinking +length/1000, compact +2
- `src/lib/timeline.ts` — Extracts `TimelineEvent[]` from messages, computes time gaps, formats tokens/durations
- `src/lib/codex-navigation.ts` — SSOT for the `Codex` sidebar task tree: builds root/delegated hierarchy, filters whole task paths, preserves active lineage, and selects the latest root tasks for scan-time display
- `src/lib/codex-learning.ts` — Extracts learning-oriented `Codex` branch summaries: key moments, decision points, hidden-noise buckets, and role/status labels for the current active rollout
- `src/lib/providers/cherrystudio.ts` — Parses serialized Cherry Studio agent-session and recovered regular-chat payloads into the shared session model. Also exports shared Cherry Studio text utilities (`collectText`, `sanitizeCherryStudioText`) used by the server catalog — keep these as the SSOT for Cherry Studio text processing
- `src/lib/source-metadata.ts` — Source label/badge/section registry used by the sidebar, header, and search results
- `src/lib/skill-recommendations.ts` — Shared types plus compact recent-session dossiers for the Claude-backed skill recommendation flow
- `server/cherrystudio/catalog.ts` — Resolves Cherry Studio user-data paths, loads agent sessions from `agents.db`, recovers regular chats from IndexedDB-backed app data, and serializes per-session content for API/search consumers. Regular-chat recovery is cached with a 30s TTL to avoid rescanning IndexedDB on every session load
- `server/recommendations/claude-skill-recommendation-service.ts` — Runs an on-demand local Claude Code custom-agent team (`scout` → `skeptic` → `writer`) over recent session dossiers and returns structured skill ideas, launched through the user’s real shell environment (`zsh` / `bash` startup files) rather than a clean process env
- `src/lib/search/` — Local chunk-based search core. `extract.ts` converts `SessionMeta + SessionData` into searchable chunks, `search-engine.ts` supports chunk hydration/replacement plus hybrid ranking hooks (`bm25` / `embedding` external signals), and `semantic.ts` keeps the lightweight corpus-driven scorer used alongside server signals
- `server/search/` — Node-side SQLite search service. `session-catalog.ts` discovers session files + quick-scan metadata, `sqlite-search-service.ts` persists chunk rows to `~/.claude-flow-viewer/search.sqlite`, maintains the FTS5/BM25 and embedding tables, and incrementally refreshes them, while `embedding-provider.ts` provides the local model-backed embedding runtime
- `server/scan/session-scan-cache.ts` — Persistent dev-server quick-scan cache for `~/.claude` and `~/.codex`. Reuses unchanged session metadata across server restarts so `/api/scan` stays fast on large local histories.

### Search Flow

Search is now a two-layer system:

1. `useSessionStore` still owns the raw input string (`searchQuery`)
2. `src/hooks/useSearchController.ts` owns the live search workflow: server availability check, ranked results, and the active jump target

When the user enters a non-empty query and the local server API is available:

- `useSearchController` calls `FileStore.getSearchBackendStatus()` and `FileStore.searchSessions()`
- `server/search/sqlite-search-service.ts` refreshes `~/.claude-flow-viewer/search.sqlite` against the current session file set
- full session content is parsed server-side with `parseSessionContent()`
- SQLite `FTS5` produces lexical candidates with `BM25`, while persisted local embeddings contribute vector candidates
- `src/lib/search/SearchEngine` hydrates from persisted chunk rows and fuses lexical/token/trigram/co-occurrence ranking with external `bm25` and `embedding` signals
- `src/components/search/SearchResultsPanel.tsx` renders ranked hits with snippets
- selecting a hit loads the target session and jumps to the exact message block or prompt anchor in `SessionView`

Current behavior is intentionally local-only:

- lexical recall: SQLite `FTS5` + `BM25`, plus exact/token/trigram signals in `SearchEngine`
- semantic recall: local model-backed embeddings via `server/search/embedding-provider.ts` and `@xenova/transformers`
- default embedding model: `Xenova/multilingual-e5-small`
- default cache/model paths: `~/.claude-flow-viewer/model-cache` and `~/.claude-flow-viewer/models`
- embedding failure mode: search degrades to lexical-only instead of crashing
- browser-only file access mode: browsing still works, but transcript search is unavailable without the local server API

### Timeline Minimap (`src/components/session/Timeline.tsx`)

The timeline is a **fixed-height minimap** that fills the viewport height and never scrolls itself. All events are absolutely positioned by their actual DOM location in the content area.

**Data flow**: `SessionView` measures, `Timeline` renders.

| Prop | Source | Description |
|------|--------|-------------|
| `scrollFraction` | `scrollTop / scrollHeight` | Where the viewport top is (0–1) |
| `viewportFraction` | `clientHeight / scrollHeight` | How much content is visible (0–1) |
| `promptPositions` | `getBoundingClientRect()` per `[data-prompt]` | Each prompt's position ratio (0–1) |
| `onScrollTo(fraction)` | Sets `el.scrollTop = fraction * scrollHeight` | Direct scroll control |
| `onJump(promptNum)` | `scrollIntoView({ behavior: 'smooth' })` | Smooth scroll to specific prompt |

**SessionView responsibilities** (scroll tracking):
1. RAF-throttled scroll listener → `scrollFraction` + `viewportFraction`
2. `ResizeObserver` on scroll container → re-measure on resize
3. Prompt position measurement after render (`[data-prompt]` elements via `getBoundingClientRect`)
4. `IntersectionObserver` → `activePromptNums` (which prompts are currently visible)

**Timeline rendering**:
- **Coordinate mapping**: `toPercent(fraction)` applies 1.2% edge padding to prevent dot clipping at extremes
- **Viewport indicator**: Semi-transparent amber band showing currently visible portion. Draggable (mousedown → mousemove) to scroll main content. Click anywhere on track to jump.
- **Prompt dots**: `position: absolute; top: X%` based on measured DOM position. Active dots show time labels.
- **Smart time labels**: Active dots + evenly spaced interval (`ceil(promptCount / 12)`) + start/end time anchors
- **Event marker shapes**: Each non-prompt event type has a distinct shape + 3-letter label:
  - Compact → diamond + `CMP`
  - Clear → horizontal line + `CLR`
  - Fork → hollow circle + `FRK`
  - Plan start → filled square + `PLN`
  - Plan end → hollow square + `END`
- **Position interpolation**: Non-prompt events positioned by linear interpolation between surrounding prompt positions

### State Management (`src/hooks/useSessionStore.ts`)

Single `useReducer` with `AppContext`. Key actions:
- `LOAD_PROJECTS` — Store projects and fileStore
- `LOAD_SESSION` — Store session data + **enrich session markers** in project list
- `LOAD_SESSION_START` — Set loading state
- `TOGGLE_FILTER` — Toggle message type visibility
- `SET_SEARCH` — Update the raw search input string; search execution/progress/results live in `useSearchController`
- `EXPAND_PROJECT_SESSIONS` — Replace truncated session list with full list
- `SET_ERROR` / `RESET` — Error handling and state reset

### Sidebar UX

- Sidebar is source-aware and split into `Claude conversations` / `Codex tasks` / `Cherry Studio sessions`
- Source filter chips (`All sources`, `Claude`, `Codex`, `Cherry Studio`) are the primary way to narrow navigation
- Codex projects render a task map summary plus `Main tasks` and `Unlinked delegated work` sections
- `Codex` delegated runs are nested under their parent task rather than dumped flat, and filters keep the full parent-child path visible
- Search results now come from the server-backed SQLite index in `SearchResultsPanel`; sidebar tree filtering remains metadata-driven when used on its own
- When the search box is empty, `AppShell` shows `src/components/recommendations/SkillRecommendationsPanel.tsx`, driven by `src/hooks/useClaudeSkillRecommendations.ts`; it uses the local Node/Vite API to run an on-demand local Claude Code analysis instead of heuristic matching, with user-selectable scopes (`Smart`, `This project`, `Recent all`) so cost and breadth stay explicit
- Marker filters still auto-expand matching `Codex` delegated chains so users do not have to re-open branches just to see a hit
- The currently active project may be manually collapsed; it should stay collapsed until the user deliberately selects a session in another project

### Header Context

- `AppShell` keeps source identity visible for every active session
- `Codex` selections use the same `src/lib/codex-navigation.ts` lineage rules as the sidebar, so the header shows the main task plus delegated-work context for the active rollout
- If the active `Codex` rollout is detached from its parent in the loaded file set, the header must say so explicitly instead of pretending it is a main task

### Codex Workspace View

- `Codex` no longer opens straight into the raw transcript in the main content area
- `src/components/codex/CodexWorkspaceView.tsx` is the progressive-disclosure learning surface for `Codex`
- `src/lib/codex-navigation.ts` is the SSOT for project-level thread structure
- `src/lib/codex-learning.ts` is the SSOT for task summaries, key moments, and hidden-noise counts
- Initial `Codex` project lists are root-first for faster startup. `AppShell` hydrates the full project session list after the first screen is already visible.
- Default reading order is:
  `Overview` first,
  `Structure` second,
  `Raw transcript` last
- `Overview` must show all delegated branches in one screen before any branch is expanded
- Expanding a delegated branch must reveal that branch's own key messages inline, without forcing the user to jump to another panel
- `Raw transcript` still uses the shared `SessionView`; the overview/structure panels are `Codex`-specific and must stay driven by `src/lib/codex-learning.ts`

### URL Routing

Hash-based: `#/{projectEncoded}/{sessionId}`. No react-router — just `encodeHash`/`decodeHash` helpers in `useFileLoader.ts`. On initial load, tries URL hash first; for `Codex` it falls back to the root session of the latest task, not the newest delegated child rollout.

### Message Types (`src/types/session.ts`)

Discriminated union `SessionMessage` with `kind`:
`user-prompt` | `ai-text` | `ai-thinking` | `ai-tool-use` | `tool-result` | `delegation-update` | `team-message` | `task-event` | `fork-indicator` | `rollback-marker` | `clear-divider` | `compact-boundary` | `plan-start` | `plan-end`

`delegation-update` is the parsed form of `<subagent_notification>...</subagent_notification>` in `Codex` sessions. It is not a user prompt and must stay available to the learning view because it marks delegated work returning to the main thread.

### Key Data Types

```
SessionMeta    — Sidebar metadata (source, id, startTime, preview, counts, markers, optional thread hierarchy)
SessionData    — Full parsed session (source, messages, prompts, heatmap, markers)
SessionMarkers — { compacts, plans, clears, forks }
FilterState    — Toggle visibility of message types + timeline
```

## Design Constraints

- **Light theme only** — background `#FAFAF8`, no dark mode
- **Typography**: IBM Plex Sans (body) + JetBrains Mono (code/timestamps), loaded via Google Fonts in `index.html`, configured in `@theme` block in `index.css`
- **Accent color**: Amber (logo gradient, focus rings, active states, loading spinners, sidebar highlights). No violet/purple in UI chrome.
- **Neutral color**: Stone (filter toggles, inactive text, timeline track, event marker labels)
- **Functional colors**: Blue=prompts, Teal=compact, Amber=forks, Gray=clear/auto-retry, Indigo=plan, Rose=interrupts
- **Team messages**: Emerald/Sky/Purple assigned per team member (data-driven, in `TEAM_COLORS` in MessageRenderers.tsx)
- **User prompts**: Rendered as right-aligned chat bubbles (not left-border cards)
- **CSS Requirements**: `min-h-0` on flex column children for scroll; `whitespace-nowrap` on `<summary>` with flex
- **Animations**: `promptSlideIn` (slide-in for prompt bubbles), `detailsReveal` (expand for `<details>`), `branchReveal` (fork branch expand)

## Tech Stack

React 19, Tailwind CSS v4 (`@tailwindcss/vite`), Vite 7, TypeScript 5.9 (strict), react-markdown + remark-gfm

## Common Tasks

### Adding a New Message Type

1. Add the type to `SessionMessage` union in `src/types/session.ts`
2. Add provider-specific classification logic in `src/lib/providers/claude.ts` or `src/lib/codex-parser.ts`
3. Add rendering component in `src/components/session/MessageRenderers.tsx`
4. Add case in `MessageBlock` switch in `src/components/session/SessionView.tsx`
5. (Optional) Add timeline event in `src/lib/timeline.ts`
6. (Optional) If it's a marker type, add counting in the relevant provider parser and update Claude scan-time marker extraction if needed
7. Add tests in `src/lib/__tests__/parser.test.ts`, `src/lib/__tests__/codex-parser.test.ts`, or another relevant focused test file

### Modifying the Tree Analysis

**CRITICAL**: `src/lib/tree-parser.ts` is complex and fragile. Changes affect fork detection, active path tracing, and message ordering.

Key invariants:
- Active path must include all user prompts and their responses
- Leaf tool_result siblings must be included to prevent false forks
- Disconnected trees (from /clear) must each have their own tip trace
- Fork detection must distinguish user decisions from auto-retries

### Modifying the Timeline

The Timeline is a minimap with two coupled components:
1. **SessionView** (data source) — scroll tracking + DOM measurement
2. **Timeline** (renderer) — positioned dots + viewport indicator

When modifying:
- **Adding a new event type to timeline**: Add extraction in `timeline.ts` → add shape in `getEventMarkerStyle()` → add label in `getEventLabel()`
- **Changing position logic**: Edit `computeEventPositions()`. Known positions come from DOM measurement; unknown positions are interpolated. Never use time-based positioning (breaks minimap-to-scroll correspondence).
- **Changing scroll tracking**: Edit the `useEffect` with scroll listener in SessionView. Must use RAF throttling. The `scrollFraction`/`viewportFraction` math must stay consistent with `toPercent()`/`fromPercent()` in Timeline.
- **Testing**: No unit tests for Timeline (DOM-dependent). Test visually with sessions containing: many prompts (density), few prompts (spacing), /clear (disconnected trees), compact boundaries.

### Modifying the Scan Pipeline

The scan pipeline has **two separate implementations** that must stay in sync, and both are source-aware:

| | **Vite plugin** (`vite-plugin-claude-data.ts`) | **FSAccessStore** (`src/lib/fs-access.ts`) |
|---|---|---|
| Runs in | Node.js (server-side) | Browser |
| Source roots | `~/.claude/projects` + `~/.codex/sessions` | Picked home dir, `.claude`, or `.codex` |
| Claude scan | Full file + scan-time markers, cached across dev-server restarts | `quickScanMetadata()` head scan |
| Codex scan | `quickScanCodexMetadata()` head scan + optional `session_index.jsonl` previews + batched concurrency + persistent scan cache | Same, from picked handles/files |
| Grouping | Claude by encoded project folder. Codex by `session_meta.cwd` with primary/subagent metadata; initial display returns latest root tasks first, and full project sessions are hydrated on demand | Same root-first initial behavior, then full project load on demand |
| Markers | Claude markers at scan-time; Codex on full parse | Enriched on full session load |

**When adding a new scan field**: Update the relevant scan path in both the Vite plugin and browser store, and extend `SessionMeta` in types. Claude-only scan-time fields can be populated in the plugin; Codex preview fields may also depend on `session_index.jsonl`.

## Known Issues

- No dark mode (design constraint)
- No virtualization for large sessions
- Vite plugin duplicates some helper functions from parser.ts (intentional: plugin is self-contained server module)

## Correct Steps

When changing scan, parse, sidebar, or routing behavior, follow this order:

1. Update the code in the provider-specific module first. Do not patch shared entrypoints with source-specific hacks.
2. If the behavior changes user-facing workflows or navigation, update `README.md` and this file in the same change.
3. Run `npm run lint`.
4. Run `npx tsc --noEmit`.
5. Run `npx vitest run`.
6. Run `npm run build`.
7. If you changed source navigation or scan behavior, smoke the app with `npm run dev` and confirm:
   both `Claude` and `Codex` load,
   the first boot path only issues one `/api/scan`,
   session switching updates the URL hash,
   current projects can still be manually collapsed,
   `Codex` delegated runs remain nested instead of flat,
   search/filter keeps the full `Codex` task path visible,
   first-load selection for a `Codex` project lands on the main task root instead of a delegated child rollout,
   and a large local history still reaches the first screen quickly because the root-first list appears before full `Codex` hydration.

## Git Workflow

1. Make changes
2. `npx vitest run` — keep the full suite green
3. `npx tsc --noEmit` — type check must pass
4. `npm run lint` — lint must pass
5. Commit with format: `<Type>: <summary>` (Types: Fix, Feat, Refactor, Docs, Test, Chore)
