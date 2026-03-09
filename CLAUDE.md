# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Claude Flow Viewer — a browser-based viewer for Claude Code session JSONL files (`~/.claude/projects/**/*.jsonl`). Renders conversation trees with forks, compactions, /clear boundaries, plan mode transitions, team messages, and timeline visualization.

## Commands

```bash
npm run dev       # Start Vite dev server (auto-loads sessions from ~/.claude via server plugin)
npm run build     # tsc -b && vite build
npm run lint      # eslint .
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
parser.ts: parseSessionContent() → SessionData { messages, prompts, heatmap }
    ↓
useSessionStore (useReducer) → AppContext
    ↓
AppShell → Sidebar + SessionView + Timeline
```

### FileStore Abstraction (`src/lib/fs-access.ts`)

Three implementations behind one `FileStore` interface, tried in order:
1. **APIFileStore** — Dev mode: Vite server plugin (`vite-plugin-claude-data.ts`) serves `/api/scan`, `/api/session/:project/:session`, `/api/tool-result/...` endpoints reading `~/.claude` directly via Node fs
2. **FSAccessStore** — Production: File System Access API (`showDirectoryPicker`), user picks `.claude` directory
3. **InputFallbackStore** — Drag-and-drop file input fallback

### JSONL Parsing Pipeline (`src/lib/parser.ts`)

`parseSessionContent(content)` is the core entry point:
1. Parse all lines into records
2. Pre-scan for `compact_boundary` and `isCompactSummary` records, index by uuid
3. `analyzeConversationTree()` (tree-parser.ts) — builds parent/child graph from uuid/parentUuid fields, traces active path from tip of each disconnected tree, collects abandoned fork branches and plan mode transitions
4. Iterate records: emit `SessionMessage[]` for active path only, inject fork-indicators, plan markers, clear dividers, compact boundaries

### Conversation Tree (`src/lib/tree-parser.ts`)

Handles Claude Code's tree-structured conversations:
- **Active path**: Traced from tip (last record) to root via `parentUuid` chain. Multiple disconnected trees arise from `/clear` commands — each tree gets its own tip trace.
- **`logicalParentUuid`**: `compact_boundary` records have `parentUuid: null` but `logicalParentUuid` connecting them to pre-compact records. The tree parser uses this to bridge the gap.
- **Fork detection**: Parent nodes with >1 child where some children are off the active path → abandoned branches collected via BFS subtree traversal.

### State Management (`src/hooks/useSessionStore.ts`)

Single `useReducer` with `AppContext`. No external state library. Key actions: `LOAD_PROJECTS`, `LOAD_SESSION`, `TOGGLE_FILTER`, `SET_SEARCH`.

### URL Routing

Hash-based: `#/{projectEncoded}/{sessionId}`. No react-router — just `encodeHash`/`decodeHash` helpers in `useFileLoader.ts`.

### Message Types (`src/types/session.ts`)

Discriminated union `SessionMessage` with `kind`:
`user-prompt` | `ai-text` | `ai-thinking` | `ai-tool-use` | `tool-result` | `team-message` | `task-event` | `fork-indicator` | `clear-divider` | `compact-boundary` | `plan-start` | `plan-end`

## Design Constraints

- **Light theme only** — background `#FAFAF8`, no dark mode
- Color coding: blue=prompts, teal=compact, amber=forks, indigo=plan, gray=clear
- `min-h-0` required on flex column children for `overflow-y-auto` to work
- `<summary>` elements with `flex items-center` need `whitespace-nowrap`

## Tech Stack

React 19, Tailwind CSS v4 (via `@tailwindcss/vite`), Vite 7, TypeScript 5.9 (strict mode with `noUnusedLocals`, `noUnusedParameters`)
