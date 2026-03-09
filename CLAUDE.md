# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Claude Flow Viewer — a browser-based viewer for Claude Code session JSONL files (`~/.claude/projects/**/*.jsonl`). Renders conversation trees with forks, compactions, /clear boundaries, plan mode transitions, team messages, and timeline visualization.

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

**Security**: The API endpoints validate paths to prevent directory traversal attacks. All paths are normalized with `path.resolve()` and validated with `path.relative()` before file access.

### JSONL Parsing Pipeline (`src/lib/parser.ts`)

`parseSessionContent(content)` is the core entry point:

1. **Parse all lines into records** - Each line is a JSON object representing a message, tool call, or system event
2. **Pre-scan for compact boundaries** - Index `compact_boundary` and `isCompactSummary` records by uuid
3. **Analyze conversation tree** (`analyzeConversationTree()` in tree-parser.ts):
   - Build parent/child graph from uuid/parentUuid fields
   - Trace active path from tip of each disconnected tree (multiple trees arise from `/clear` commands)
   - Include leaf tool_result siblings in active path (fixes false fork detection for parallel tool calls)
   - Collect abandoned fork branches via BFS subtree traversal
   - Detect plan mode transitions (EnterPlanMode/ExitPlanMode tool calls)
4. **Reorder records for display** - Pair each tool_use with its tool_result immediately following (matches CLI behavior)
5. **Iterate records and build messages** - Emit `SessionMessage[]` for active path only, inject fork-indicators, plan markers, clear dividers, compact boundaries

**Critical**: The reordering step (Step 4) ensures tool calls display with their results in chronological order, not JSONL file order. This matches the CLI's user experience.

### Conversation Tree (`src/lib/tree-parser.ts`)

Handles Claude Code's tree-structured conversations:

- **Active path**: Traced from tip (last record) to root via `parentUuid` chain. Multiple disconnected trees arise from `/clear` commands — each tree gets its own tip trace.
- **`logicalParentUuid`**: `compact_boundary` records have `parentUuid: null` but `logicalParentUuid` connecting them to pre-compact records. The tree parser uses this to bridge the gap.
- **Fork detection**: Parent nodes with >1 child where some children are off the active path → abandoned branches collected via BFS subtree traversal.
- **Tool result siblings**: Leaf tool_result children of active nodes are added to the active path to prevent false fork detection when multiple tool calls are chained in a single assistant turn.

**Fork Reason Classification**:
- `'user-decision'`: User actively rewound the conversation or interrupted Claude
- `'tool-error'`: Automatic retry after tool failure or internal strategy change (hidden from display to match CLI behavior)

### State Management (`src/hooks/useSessionStore.ts`)

Single `useReducer` with `AppContext`. No external state library. Key actions:
- `LOAD_START` - Begin loading
- `LOAD_PROJECTS` - Store projects and fileStore
- `LOAD_SESSION` - Store session data
- `TOGGLE_FILTER` - Toggle message type visibility
- `SET_SEARCH` - Update search query
- `SET_ERROR` - Display error message
- `RESET` - Clear all state

**Error Handling**: All async operations include proper error handling with user-friendly messages. Errors are logged to console for debugging.

### URL Routing

Hash-based: `#/{projectEncoded}/{sessionId}`. No react-router — just `encodeHash`/`decodeHash` helpers in `useFileLoader.ts`.

On initial load, the app tries to load the session from the URL hash. If not found, it falls back to the most recent session.

### Message Types (`src/types/session.ts`)

Discriminated union `SessionMessage` with `kind`:
- `user-prompt` - User input with decision marker (none/interrupt/correction)
- `ai-text` - Claude's text response
- `ai-thinking` - Claude's thinking process (extended thinking mode)
- `ai-tool-use` - Tool call with name and input
- `tool-result` - Tool execution result (success or error)
- `team-message` - Message from teammate agent
- `task-event` - Task status update
- `fork-indicator` - Conversation branch point with reason ('user-decision' or 'tool-error')
- `clear-divider` - `/clear` command boundary
- `compact-boundary` - Context compaction point
- `plan-start` / `plan-end` - Plan mode boundaries

## Design Constraints

- **Light theme only** — background `#FAFAF8`, no dark mode
- Color coding:
  - Blue (#2563eb) - User prompts
  - Teal - Compact boundaries
  - Amber - User decision forks
  - Gray - Auto-retry forks (hidden by default)
  - Indigo - Plan mode
  - Rose - Interrupts/corrections
- **CSS Requirements**:
  - `min-h-0` required on flex column children for `overflow-y-auto` to work
  - `<summary>` elements with `flex items-center` need `whitespace-nowrap`
- **Accessibility**: All interactive elements have proper ARIA labels and keyboard navigation

## Tech Stack

- React 19 (with hooks, no class components)
- Tailwind CSS v4 (via `@tailwindcss/vite`)
- Vite 7 (dev server + build tool)
- TypeScript 5.9 (strict mode with `noUnusedLocals`, `noUnusedParameters`)
- react-markdown + remark-gfm (for rendering markdown in AI responses)

## Development Workflow

### Starting Development

```bash
npm run dev
```

This starts the Vite dev server on `http://localhost:5173` (or next available port). The server automatically loads sessions from `~/.claude/projects/` via the `claudeDataPlugin`.

### Running Tests

```bash
npx vitest                    # Watch mode
npx vitest run                # Run once
npx vitest run <file>         # Run specific test file
```

Tests are located in `src/lib/__tests__/`. Currently covers:
- JSONL parsing (compact boundaries, /clear detection, fork detection)
- Tree analysis (active path tracing, fork classification)
- Tool result pairing logic

### Type Checking

```bash
npx tsc -b
```

Runs TypeScript compiler in build mode. Must pass before committing.

### Linting

```bash
npm run lint
```

Runs ESLint with TypeScript support. Fix issues before committing.

### Building for Production

```bash
npm run build
npm run preview  # Test the production build locally
```

Output goes to `dist/`. The production build uses File System Access API or drag-and-drop fallback (no dev server plugin).

## Common Tasks

### Adding a New Message Type

1. Add the type to `SessionMessage` union in `src/types/session.ts`
2. Add classification logic in `classifyRecord()` in `src/lib/parser.ts`
3. Add rendering component in `src/components/session/MessageRenderers.tsx`
4. Add case in `MessageBlock` switch in `src/components/session/SessionView.tsx`
5. (Optional) Add timeline event in `src/lib/timeline.ts` if it should appear in timeline
6. Add tests in `src/lib/__tests__/parser.test.ts`

### Modifying the Tree Analysis

**CRITICAL**: The tree analysis logic in `src/lib/tree-parser.ts` is complex and fragile. Changes here affect fork detection, active path tracing, and message ordering.

Before modifying:
1. Read the existing comments carefully
2. Understand the `logicalParentUuid` pattern for compact boundaries
3. Test with sessions containing: forks, /clear commands, compact boundaries, parallel tool calls
4. Add regression tests

Key invariants:
- Active path must include all user prompts and their responses
- Leaf tool_result siblings must be included to prevent false forks
- Disconnected trees (from /clear) must each have their own tip trace
- Fork detection must distinguish user decisions from auto-retries

### Debugging JSONL Parsing Issues

1. Check the raw JSONL file structure:
   ```bash
   cat ~/.claude/projects/{project}/{session}.jsonl | head -20
   ```

2. Enable debug logging in `parser.ts` (add console.log statements)

3. Use the browser DevTools to inspect the parsed `SessionData` object

4. Common issues:
   - Missing `uuid` or `parentUuid` fields → tree analysis fails
   - Malformed JSON → parsing throws error
   - Unexpected record types → classification returns empty messages
   - Tool results without matching tool_use → orphaned results

### Security Considerations

**Path Traversal Prevention**: The dev server plugin validates all file paths to prevent directory traversal attacks:
- Rejects paths containing `..`
- Rejects absolute paths
- Normalizes paths with `path.resolve()`
- Validates final path is within session directory using `path.relative()`

**XSS Prevention**: All user content is rendered through React (auto-escaped) or react-markdown (sanitized). Never use `dangerouslySetInnerHTML`.

**Data Privacy**: All data stays local. No analytics, no external requests. The app only reads from `~/.claude/` and never writes or modifies session files.

## Troubleshooting

### "No sessions found"

- Check that `~/.claude/projects/` exists and contains `.jsonl` files
- In dev mode, the server plugin should auto-detect the directory
- In production, use the directory picker to select `~/.claude` or your home directory

### "Failed to load session"

- Check browser console for detailed error
- Verify the JSONL file is valid JSON (one object per line)
- Check file permissions (must be readable)

### Tool calls showing in wrong order

- This was fixed in commit 5c76db6
- Ensure you're on the latest version
- The reordering logic in `parser.ts` Step 4 should pair tool_use with tool_result

### False fork indicators appearing

- This was fixed in commit 5c76db6
- Ensure `tree-parser.ts` Step 3 includes leaf tool_result siblings
- Check that `SessionView.tsx` filters out `tool-error` forks

### Timeline showing hidden forks

- This was fixed in commit 5c76db6
- Ensure `timeline.ts` filters out `tool-error` forks in `extractTimelineEvents()`

## Performance Considerations

- **Large sessions** (1000+ messages): Rendering is optimized with `useMemo` but not virtualized. Consider adding react-window for very large sessions.
- **Many projects** (100+): Project scanning is fast (only reads first 4KB of each file) but disambiguation is O(n²). Consider caching.
- **Heatmap computation**: Computed eagerly on parse. For large sessions, consider lazy computation.

## Code Style

- Use functional components with hooks (no class components)
- Prefer `const` over `let`
- Use TypeScript strict mode (no `any` types without justification)
- Use discriminated unions for message types
- Add JSDoc comments for complex functions
- Keep functions small and focused (< 50 lines)
- Use early returns to reduce nesting

## Git Workflow

1. Make changes
2. Run tests: `npx vitest run`
3. Type check: `npx tsc -b`
4. Lint: `npm run lint`
5. Commit with descriptive message
6. Push to remote

**Commit Message Format**:
```
<type>: <short summary>

<detailed description>

<footer>
```

Types: `Fix`, `Feat`, `Refactor`, `Docs`, `Test`, `Chore`

## Known Issues

- Vitest is not in package.json (installed globally) - causes tsc warning
- No dark mode support (design constraint)
- No virtualization for large sessions (performance consideration)
- Sidebar expanded state not persisted (UX consideration)

## Future Improvements

- Add virtualized list for large sessions (react-window)
- Add localStorage for sidebar expanded state
- Add export functionality (export session as markdown/PDF)
- Add search within session content
- Add keyboard shortcuts for navigation
- Add session comparison view
