# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Decision Flow Viewer — a browser-based viewer for Claude Code session JSONL files (`~/.claude/projects/**/*.jsonl`). Renders conversation trees with forks, compactions, /clear boundaries, plan mode transitions, team messages, and timeline visualization.

## Commands

```bash
npm run dev       # Start Vite dev server (auto-loads sessions from ~/.claude via server plugin)
npm run build     # tsc -b && vite build
npm run lint      # eslint .
npm run preview   # Preview production build
npx vitest        # Run all tests (vitest not in package.json — available globally)
npx vitest run src/lib/__tests__/parser.test.ts  # Run single test file
```

## Architecture

### Data Flow

```
~/.claude/projects/{encodedProjectName}/{sessionId}.jsonl
    ↓
FileStore (3 implementations)
    ↓
parser.ts: parseSessionContent() → SessionData { messages, prompts, heatmap, markers }
    ↓
useSessionStore (useReducer) → AppContext
    ↓
AppShell → Sidebar (with marker filter) + SessionView + Timeline
```

### FileStore Abstraction (`src/lib/fs-access.ts`)

Three implementations behind one `FileStore` interface, tried in order:
1. **APIFileStore** — Dev mode: Vite server plugin (`vite-plugin-claude-data.ts`) serves endpoints reading `~/.claude` directly via Node fs
2. **FSAccessStore** — Production: File System Access API (`showDirectoryPicker`), user picks `.claude` directory
3. **InputFallbackStore** — Drag-and-drop file input fallback

**API Endpoints** (dev mode only, served by `vite-plugin-claude-data.ts`):
- `/api/scan` — Scan all projects, return `ProjectMeta[]` with session markers
- `/api/scan-project/:projectEncoded` — Scan all sessions for one project (used by "Load all" button)
- `/api/session/:project/:session` — Read full JSONL content for parsing
- `/api/tool-result/:project/:session/:path` — Read tool result overflow files

**Scanning strategy differs by store**:
- **APIFileStore (dev)**: Vite plugin reads **full file** per session — extracts metadata from first 4KB, counts markers via regex on full content. Trade-off: slower initial scan (~5-10s for 200 sessions), but all marker badges visible immediately.
- **FSAccessStore / InputFallbackStore (production)**: Reads only **first 4KB** per session via `quickScanMetadata()` in parser.ts. Markers are only populated when a session is fully loaded (via `parseSessionContent()`).

### JSONL Parsing Pipeline (`src/lib/parser.ts`)

`parseSessionContent(content)` is the core entry point:

1. **Parse all lines into records**
2. **Pre-scan for compact boundaries** - Index `compact_boundary` and `isCompactSummary` records by uuid
3. **Analyze conversation tree** (`analyzeConversationTree()` in tree-parser.ts)
4. **Reorder records for display** - Pair each tool_use with its tool_result (matches CLI behavior)
5. **Iterate records and build messages** - Emit `SessionMessage[]` for active path only, inject fork-indicators, plan markers, clear dividers, compact boundaries
6. **Count markers** - Tally compacts, plans, clears, forks from the final message list

**Exports from `parser.ts`**:
- `parseSessionContent(content)` → `SessionData` (full parse with tree analysis)
- `quickScanMetadata(head, sessionId, fileSize)` → `SessionMeta | null` (4KB lightweight scan, used by FSAccessStore)
- `decodeProjectName()`, `extractShortName()`, `disambiguateShortNames()` — project name utilities (used by fs-access.ts)

**Note**: The Vite plugin (`vite-plugin-claude-data.ts`) has its own `quickScanFile()` and helper functions that duplicate some logic from parser.ts. This is intentional — the plugin runs server-side and is self-contained. The SSOT for parsing logic is `parser.ts`; the plugin only does lightweight metadata extraction.

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
1. **Scan-time** (API mode): Vite plugin counts `compacts`, `plans`, `clears` via regex on raw file content. `forks` is always 0 (requires tree analysis).
2. **Parse-time**: `parseSessionContent()` computes exact counts from parsed messages, including `forks`. The `LOAD_SESSION` reducer writes these back to `SessionMeta` in the project list.

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
- `SET_SEARCH` — Update search query
- `EXPAND_PROJECT_SESSIONS` — Replace truncated session list with full list
- `SET_ERROR` / `RESET` — Error handling and state reset

### URL Routing

Hash-based: `#/{projectEncoded}/{sessionId}`. No react-router — just `encodeHash`/`decodeHash` helpers in `useFileLoader.ts`. On initial load, tries URL hash first, falls back to most recent session.

### Message Types (`src/types/session.ts`)

Discriminated union `SessionMessage` with `kind`:
`user-prompt` | `ai-text` | `ai-thinking` | `ai-tool-use` | `tool-result` | `team-message` | `task-event` | `fork-indicator` | `clear-divider` | `compact-boundary` | `plan-start` | `plan-end`

### Key Data Types

```
SessionMeta    — Sidebar metadata (id, startTime, preview, counts, markers?)
SessionData    — Full parsed session (messages, prompts, heatmap, markers)
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
2. Add classification logic in `classifyRecord()` in `src/lib/parser.ts`
3. Add rendering component in `src/components/session/MessageRenderers.tsx`
4. Add case in `MessageBlock` switch in `src/components/session/SessionView.tsx`
5. (Optional) Add timeline event in `src/lib/timeline.ts`
6. (Optional) If it's a marker type, add counting in `parseSessionContent()` marker tally and update vite plugin regex
7. Add tests in `src/lib/__tests__/parser.test.ts`

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

The scan pipeline has **two separate implementations** that must stay in sync:

| | **Vite plugin** (`vite-plugin-claude-data.ts`) | **FSAccessStore** (`src/lib/fs-access.ts`) |
|---|---|---|
| Runs in | Node.js (server-side) | Browser |
| Reads | Full file | First 4KB |
| Metadata | Own `quickScanFile()` | `quickScanMetadata()` from parser.ts |
| Markers | Inline regex on full content | None (enriched on session load) |
| Helpers | Own `decodeProjectName()`, `extractShortName()` etc. | Imports from parser.ts |

**When adding a new scan field**: Update both `QuickMeta` in the plugin AND `SessionMeta` in types. If it needs full file content, only the plugin can do it at scan time; the FSAccessStore version will be enriched via `LOAD_SESSION`.

## Known Issues

- Vitest is not in package.json (installed globally) — causes tsc warning on test files
- No dark mode (design constraint)
- No virtualization for large sessions
- Vite plugin duplicates some helper functions from parser.ts (intentional: plugin is self-contained server module)

## Git Workflow

1. Make changes
2. `npx vitest run` — all 34 tests must pass
3. `npx tsc --noEmit` — type check must pass
4. `npm run lint` — lint must pass
5. Commit with format: `<Type>: <summary>` (Types: Fix, Feat, Refactor, Docs, Test, Chore)
