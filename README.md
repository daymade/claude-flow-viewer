# Claude Flow Viewer

A browser-based viewer for local Claude Code, Codex, and Cherry Studio session history. Visualize conversation flows, decision points, tool calls, and timeline events from your local AI desktop clients.

## Features

- 📊 **Timeline Visualization** - See the flow of your conversation with timestamps and decision points
- 🌳 **Tree Structure** - View conversation branches and rewound paths
- 🧭 **Source-Aware Navigation** - Browse separate `Claude`, `Codex`, and `Cherry Studio` sections, filter by source, and keep source identity visible
- 🍒 **Cherry Studio Support** - Load Cherry Studio agent sessions from local `agents.db` plus recovered regular chats from the same local IndexedDB/Local Storage-backed user-data store alongside `Claude` and `Codex`
- 🤖 **Codex Task Map** - Organize `Codex` history as main tasks, delegated work, and unlinked delegated runs instead of a flat rollout list
- 🗺️ **Readable Codex Workspace** - Open `Codex` sessions into a conversation-first reading surface, then inspect structure and diagnostics only when needed
- ⚡ **Fast Startup Scan** - Dev mode reuses a persistent local scan cache, avoids double `/api/scan` on boot, and loads `Codex` root tasks first so the first screen appears quickly
- 🧩 **Task Context Header** - When you open a delegated `Codex` run, the header keeps the main task and delegated-work path visible
- 🔧 **Tool Call Tracking** - See all tool calls with their results paired correctly
- 📤 **Readable Local Export** - Export the current readable session surface as standalone HTML, print/PDF, or a local share link backed by the same renderer you see in the app
- 🔍 **SQLite Search Server** - Query a local SQLite-backed index across full session content, rank hits with FTS5/BM25 + trigram + local embedding recall, and jump straight to the matching message
- 🎯 **Open by Session ID** - Paste a session id (or its `.jsonl` path) into the search box to jump straight to that session, even one buried far down a large project — a separate identifier lane from full-text search, so a normal search that merely mentions an id is never hijacked
- 🧾 **My Inputs Ledger** - List exact human inputs across local sessions from newest to oldest, keep session/source provenance visible, and export only the selected corrections as a versioned feedback evidence packet
- 🧠 **Claude Skill Suggestions** - Run an on-demand local Claude Code team analysis over recent history and get reusable skill ideas with discussion notes
- 📝 **Markdown Rendering** - Renders AI responses with markdown formatting inside parsed sessions
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

### Embedded Reader

`npm run build:reader` builds the shared Reader package, including `embed.html`.

嵌入页可追加 `view=conversation`，初次打开时隐藏 Thinking、Tool Calls 和 Results；工具栏可重新开启，刷新与翻页保留当前过滤设置。未传该参数时使用原有默认显示。

正文中的本地文件引用链接会被嵌入页拦住，不发起导航；当前会话、已加载范围、过滤、Find 与滚动位置保持不动。拦截提示的展开、关闭与「来源与读取边界」折叠只是界面状态：会话数据按页身份保持稳定，不会因此重新定位真实内容滚动区，进行中的 Find 或宿主 focus 不被打断；「刷新到最新」与翻页仍会按新页更新数据。明确本地形式——`~`、盘符、原始或编码解出的文件系统根路径、`file:` 链接——按本地文件引用处理，显示可关闭的「本地文件引用未绑定预览」提示，引用来源展示实际引用，不把嵌入页基准地址解析出的路径当作文件路径。宿主的 `/api`、`/reader` 路由只在显式书写时维持原行为：以 `/` 开头的根相对地址，或绝对同源的 http(s) 链接；`report.md`、`./report.md`、`notes/report.md` 这类普通相对路径不会被基准地址提升为应用路由，与其余无法识别的同源引用一样显示「该引用未绑定预览」，折叠的引用来源逐字保留原始 href、来源记录与会话。外部 https 链接与纯 `#` 锚点维持原行为。

```text
embed.html?endpoint=/api/sessions/example&channel=example&session=example&view=conversation
```

### Development Mode

```bash
npm run dev
```

Opens the Vite dev URL printed in the terminal, usually `http://localhost:5173`; if that port is occupied, Vite may choose the next available port such as `5174`. The local server automatically loads sessions from local Claude, Codex, and Cherry Studio data roots, including Cherry Studio agent sessions and recovered regular chats when the local API is available.

### Preview and Browser-Only Modes

```bash
npm run build
npm run preview
```

`npm run preview` serves the production build with the same local Node/Vite API middleware mounted, so it can auto-load local Claude, Codex, and Cherry Studio roots like dev mode.

If you serve the built files without the Vite preview server, use the directory picker to select your home directory, `.claude`, or `.codex`, or drag-and-drop one of those folders into the welcome screen.

Browser/manual file access mode still does not load Cherry Studio sessions. Cherry Studio support is currently local-server-only because the browser/manual store does not read the app's local user-data stores or recover Cherry regular chats; use `npm run dev` or `npm run preview` so the local Node/Vite API can load them.

### Export and Local Share

The toolbar exports the current readable session surface, not a separate hand-built export template:

- `HTML` downloads a standalone `.html` file.
- `Print/PDF` opens the browser print dialog for saving as PDF.
- `Share` writes the same standalone HTML to `~/.claude-flow-viewer/shares/{id}/index.html` and copies a local `/share/{id}/` URL.

Share links are unauthenticated local-server links. They work while the same dev/preview server can serve `/share/{id}/`; they are not public online hosting links, but anyone who can reach that local server and has the URL can view the snapshot. Do not expose the dev/preview server through `--host`, tunnels, or reverse proxies for private shares.

## Project Structure

```
src/
├── components/
│   ├── landing/        # Welcome screen
│   ├── codex/          # Codex conversation / structure / diagnostics workspace
│   ├── layout/         # App shell, sidebar
│   ├── recommendations/# Claude-backed skill suggestion panel
│   ├── user-inputs/    # Exact-input ledger + explicit feedback packet export
│   ├── session/        # Session viewer, message renderers, timeline
│   └── shared/         # Reusable components
├── hooks/              # React hooks (state, file loading)
├── lib/                # Core logic
│   ├── parser.ts       # JSONL parsing
│   ├── codex-navigation.ts  # Codex thread tree / task-map helpers
│   ├── codex-learning.ts    # Codex learning summaries and hidden-noise analysis
│   ├── skill-recommendations.ts # Shared types + session dossiers for Claude-backed skill analysis
│   ├── user-inputs.ts  # Cross-session input contract + feedback packet renderer
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

Manual import accepts raw session files (`.jsonl` / `.json`). Markdown exports are intentionally not a supported source because they lose the original tool-call, role, and thread structure that the viewer needs for faithful rendering.

For `Codex`, subagent rollouts are not treated as flat duplicate sessions. The sidebar builds a task map from the parent-child rollout chain, keeps delegated work under its main task, and preserves the whole path during search and marker filtering. On first load, the app opens the root session of the latest `Codex` task instead of dropping you into a delegated run without context.

Startup is intentionally progressive. The dev server keeps a persistent local scan cache, reuses the first `/api/scan` payload instead of fetching it twice, and returns a root-first `Codex` project list on boot. Detailed `Codex` project sessions are hydrated after the initial screen is already visible.

When you open a `Codex` rollout, the default `Conversation` tab uses a reader preset over the shared transcript renderer: user prompts, assistant prose, and meaningful team/delegation status stay visible, while thinking/tool streams, raw task lifecycle events, markers, the right-rail prompt outline, and the timeline minimap stay out of the default reading path. `Structure` is the secondary task-map view for parent-child rollout layout, delegated branches, and key-event summaries. `Diagnostics` keeps parser-derived decision/noise buckets available without making them the default share/read surface.

### Search Workflow

The search box is no longer just a sidebar metadata filter. In dev/local-server mode, the Vite plugin exposes a Node-side SQLite search service that incrementally indexes all available sessions and returns ranked matches for:

- session metadata
- user prompts
- AI responses and thinking previews
- tool calls and tool results
- team/delegation/task updates

Search stays fully local after the server and model cache are available. The server persists chunk rows in `~/.claude-flow-viewer/search.sqlite`, maintains a SQLite `FTS5` table for lexical retrieval, stores local embedding vectors, and ranks hits with `BM25 + exact/token/trigram + embedding` hybrid scoring. The default embedding provider is model-backed through `@xenova/transformers`, using `Xenova/multilingual-e5-small`, with cache/model paths under `~/.claude-flow-viewer/model-cache` and `~/.claude-flow-viewer/models`. If the embedding model cannot be loaded, search degrades to lexical-only instead of crashing. Results show contextual snippets and jump directly to the matching transcript block.

Browser-only file access mode still works for browsing sessions, but transcript search now requires the local Node/Vite server API because indexing and ranking run on the server side.

The search box also doubles as an identifier jump. Paste a session id — a bare UUID, a Cherry agent id like `session_1774486987818_…`, a `topic:` Cherry chat id, or a `.jsonl` path — and a direct **Open session** card appears above the full-text results. This resolve lane is deliberately separate from full-text search: it locates the session file by id — bypassing the per-project scan limit — instead of matching content, so it reaches old sessions that search ranking would never surface. Because a bare id must be the entire query, a normal search that merely mentions an id is never hijacked. Resolution works in browser mode for `Claude`/`Codex`; Cherry Studio resolution needs the local server.

### My Inputs and Feedback Evidence

The bottom-rail **My Inputs** workspace reads the clients' own input ledgers (`~/.claude/history.jsonl` and `~/.codex/history.jsonl`) and joins them with the existing scan cache for project labels. It lists exact human inputs newest first without opening multi-hundred-megabyte rollout files or waiting for full-text/embedding indexing. Every row keeps its source, project, session id, and exact timestamp. Cherry Studio inputs use its local session catalog because it has no equivalent input ledger.

Claude paste markers are expanded only when the history record still carries their inline content. If a record retains only a content hash, the row is omitted and the UI reports that coverage gap instead of presenting `[Pasted text …]` as the user's complete words. The full Codex parser still preserves compaction-only prompts for transcript search, with an honest session-start → compaction range, but the primary My Inputs path uses the timestamped Codex input ledger.

Users can filter likely interruptions/corrections, select the entries that matter, and export `claude-flow-feedback-evidence/v1` Markdown. That file is an evidence packet, not an inferred rule: Flow Viewer does no automatic distillation or skill mutation. AgentZero accepts the packet explicitly with `--domain feedback`, where its normal provenance and human-adjudication gates apply.

This workspace requires `npm run dev` or `npm run preview`; browser/manual file mode cannot read the client input ledgers.

### Claude Skill Suggestions

The skill suggestion panel is no longer heuristic. In local-server mode it calls the local `claude` CLI on demand, from a clean temporary directory, and asks a small Claude custom-agent team to review recent session dossiers. The panel is hidden while a `Codex` session is active so the sidebar remains focused on task navigation and share-oriented reading.

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

- Session files, local search indexes, model cache, and share snapshots stay on the local machine
- Share links served by `/share/{id}/` are local-server links, not uploaded public URLs
- On-demand Claude skill suggestions run through the local `claude` CLI and follow that CLI's own network/auth behavior
- Path traversal protection in dev server
- XSS prevention through React auto-escaping for viewer-rendered session content; local share snapshots are stored standalone HTML and should only be served from trusted local viewer instances
- Read-only access to session files

## License

MIT
