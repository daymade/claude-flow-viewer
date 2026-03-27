# Claude Flow Viewer

A browser-based viewer for local Claude Code, Codex, and Cherry Studio session history. Visualize conversation flows, decision points, tool calls, and timeline events from your local AI desktop clients.

## Features

- 📊 **Timeline Visualization** - See the flow of your conversation with timestamps and decision points
- 🌳 **Tree Structure** - View conversation branches and rewound paths
- 🧭 **Source-Aware Navigation** - Browse separate `Claude`, `Codex`, and `Cherry Studio` sections, filter by source, and keep source identity visible
- 🍒 **Cherry Studio Support** - Load Cherry Studio agent sessions from local `agents.db` plus recovered regular chats from the same local IndexedDB/Local Storage-backed user-data store alongside `Claude` and `Codex`
- 🤖 **Codex Task Map** - Organize `Codex` history as main tasks, delegated work, and unlinked delegated runs instead of a flat rollout list
- 🗺️ **Progressive Codex Workspace** - Open `Codex` sessions into an overview-first learning surface, then drill into structure and raw transcript only when needed
- ⚡ **Fast Startup Scan** - Dev mode reuses a persistent local scan cache, avoids double `/api/scan` on boot, and loads `Codex` root tasks first so the first screen appears quickly
- 🧩 **Task Context Header** - When you open a delegated `Codex` run, the header keeps the main task and delegated-work path visible
- 🔧 **Tool Call Tracking** - See all tool calls with their results paired correctly
- 🔍 **SQLite Search Server** - Query a local SQLite-backed index across full session content, rank hits with FTS5/BM25 + trigram + local embedding recall, and jump straight to the matching message
- 🧠 **Claude Skill Suggestions** - Run an on-demand local Claude Code team analysis over recent history and get reusable skill ideas with discussion notes
- 📝 **Markdown Support** - Renders Claude's responses with full markdown formatting
- 🎨 **Clean UI** - Focused, distraction-free interface

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server (auto-loads from local Claude, Codex, and Cherry Studio data)
npm run dev

# Build for production
npm run build
```

## Usage

### Development Mode

```bash
npm run dev
```

Opens `http://localhost:5173`. Automatically loads sessions from local Claude, Codex, and Cherry Studio data roots, including Cherry Studio agent sessions and recovered regular chats when the local API is available.

### Production Mode

```bash
npm run build
npm run preview
```

In production, use the directory picker to select your home directory, `.claude`, or `.codex`, or drag-and-drop one of those folders into the welcome screen.

Browser/manual file access mode still does not load Cherry Studio sessions. Cherry Studio support is currently local-server-only because the browser/manual store does not read the app's local user-data stores or recover Cherry regular chats; use `npm run dev` or `npm run preview` so the local Node/Vite API can load them.

## Project Structure

```
src/
├── components/
│   ├── landing/        # Welcome screen
│   ├── codex/          # Codex overview / structure / transcript workspace
│   ├── layout/         # App shell, sidebar
│   ├── recommendations/# Claude-backed skill suggestion panel
│   ├── session/        # Session viewer, message renderers, timeline
│   └── shared/         # Reusable components
├── hooks/              # React hooks (state, file loading)
├── lib/                # Core logic
│   ├── parser.ts       # JSONL parsing
│   ├── codex-navigation.ts  # Codex thread tree / task-map helpers
│   ├── codex-learning.ts    # Codex learning summaries and hidden-noise analysis
│   ├── skill-recommendations.ts # Shared types + session dossiers for Claude-backed skill analysis
│   ├── source-metadata.ts       # Source label/badge/section registry
│   ├── tree-parser.ts  # Conversation tree analysis
│   ├── fs-access.ts    # File system abstraction
│   ├── timeline.ts     # Timeline event extraction
│   └── __tests__/      # Unit tests
└── types/              # TypeScript types
```

## Key Concepts

### Session Files

The viewer supports three local source layouts:

- Claude Code: `~/.claude/projects/{project}/{session}.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl` plus optional `~/.codex/session_index.jsonl`
- Cherry Studio: server-backed support for agent sessions from `Data/agents.db` plus recovered regular chats from the resolved local `userData` dir. The resolver checks `~/.cherrystudio/config/config.json` first, then default macOS `CherryStudio` / `CherryStudioDev` app-data paths, using `Local Storage` / `IndexedDB` presence to find the active install.

All sources are normalized into the same UI model. Claude sessions stay grouped by encoded project directory; Codex sessions are grouped by `cwd` from `session_meta`; Cherry Studio sessions are grouped under a `Cherry Studio` source project backed by the resolved local `userData` directory.

If you are using browser/manual file access instead of the dev/preview server, Cherry Studio remains unavailable in that mode. The browser store can browse Claude Code and Codex folders, but it does not currently load Cherry Studio's local app-data stores or recover Cherry regular chats on its own.

For `Codex`, subagent rollouts are not treated as flat duplicate sessions. The sidebar builds a task map from the parent-child rollout chain, keeps delegated work under its main task, and preserves the whole path during search and marker filtering. On first load, the app opens the root session of the latest `Codex` task instead of dropping you into a delegated run without context.

Startup is intentionally progressive. The dev server keeps a persistent local scan cache, reuses the first `/api/scan` payload instead of fetching it twice, and returns a root-first `Codex` project list on boot. Detailed `Codex` project sessions are hydrated after the initial screen is already visible.

When you open a `Codex` rollout, the main content area becomes a progressive learning surface. The default `Overview` shows the main-task storyline, every delegated branch in one screen, inline branch expansion, and a `Hidden by default` noise summary. `Structure` is a secondary tab for the exact tree, and `Raw transcript` is the audit fallback.

### Search Workflow

The search box is no longer just a sidebar metadata filter. In dev/local-server mode, the Vite plugin exposes a Node-side SQLite search service that incrementally indexes all available sessions and returns ranked matches for:

- session metadata
- user prompts
- AI responses and thinking previews
- tool calls and tool results
- team/delegation/task updates

Search stays fully local after the server and model cache are available. The server persists chunk rows in `~/.claude-flow-viewer/search.sqlite`, maintains a SQLite `FTS5` table for lexical retrieval, stores local embedding vectors, and ranks hits with `BM25 + exact/token/trigram + embedding` hybrid scoring. The default embedding provider is model-backed through `@xenova/transformers`, using `Xenova/multilingual-e5-small`, with cache/model paths under `~/.claude-flow-viewer/model-cache` and `~/.claude-flow-viewer/models`. If the embedding model cannot be loaded, search degrades to lexical-only instead of crashing. Results show contextual snippets and jump directly to the matching transcript block.

Browser-only file access mode still works for browsing sessions, but transcript search now requires the local Node/Vite server API because indexing and ranking run on the server side.

### Claude Skill Suggestions

The skill suggestion panel is no longer heuristic. In local-server mode it calls the local `claude` CLI on demand, from a clean temporary directory, and asks a small Claude custom-agent team to review recent session dossiers.

Users can choose a scope before paying the cost:

- `Smart` (recommended, low cost) prefers the current project when it has enough recent context, then falls back to global recent history
- `This project` (medium cost) only analyzes recent sessions from the active project
- `Recent all` (high cost) analyzes the recent cross-project history

The Claude team is:

- `scout` finds repeated workflows in recent history
- `skeptic` rejects weak or one-off abstractions
- `writer` turns the surviving workflows into reusable skill ideas

The app only does deterministic preprocessing: it parses recent sessions, compresses them into compact dossiers, and sends those dossiers to Claude. The actual abstraction and skill extraction comes from Claude Code, not keyword rules. Because this runs through the local server, browser-only file access mode cannot use this feature.

Prerequisites: the local `claude` CLI must be installed and already logged in for non-interactive use, otherwise the panel will stay unavailable or fail readiness checks. The local server tries to match the user’s real shell environment instead of assuming a “clean” env: it runs Claude through the user’s shell, with explicit startup-file loading for common shells such as `zsh` and `bash`.

### Conversation Tree

Conversations are tree-structured with `uuid` and `parentUuid` fields. The viewer:
- Traces the active path from the latest message back to the root
- Detects forks (conversation branches) when users rewind
- Pairs tool calls with their results for correct display order
- Handles `/clear` commands that create disconnected trees

### Fork Classification

- **Decision Point** (amber) - User actively rewound or interrupted
- **Retried** (gray, hidden) - Automatic retry after tool failure

Only user decisions are shown by default, matching the CLI behavior.

## Development

### Running Tests

```bash
npx vitest              # Watch mode
npx vitest run          # Run once
```

### Type Checking

```bash
npx tsc -b
```

### Linting

```bash
npm run lint
```

## Tech Stack

- React 19
- TypeScript 5.9 (strict mode)
- Tailwind CSS v4
- Vite 7
- react-markdown + remark-gfm

## Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed architecture, development workflow, and troubleshooting guide.

## Security

- All data stays local (no external requests)
- Path traversal protection in dev server
- XSS prevention through React auto-escaping
- Read-only access to session files

## License

MIT
