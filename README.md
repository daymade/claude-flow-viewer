# Claude Flow Viewer

A browser-based viewer for Claude Code session files. Visualize conversation flows, decision points, tool calls, and timeline events from your `~/.claude/projects/` sessions.

## Features

- 📊 **Timeline Visualization** - See the flow of your conversation with timestamps and decision points
- 🌳 **Tree Structure** - View conversation branches and rewound paths
- 🔧 **Tool Call Tracking** - See all tool calls with their results paired correctly
- 🔍 **Search & Filter** - Find specific prompts, filter by message type
- 📝 **Markdown Support** - Renders Claude's responses with full markdown formatting
- 🎨 **Clean UI** - Focused, distraction-free interface

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server (auto-loads from ~/.claude)
npm run dev

# Build for production
npm run build
```

## Usage

### Development Mode

```bash
npm run dev
```

Opens `http://localhost:5173`. Automatically loads sessions from `~/.claude/projects/`.

### Production Mode

```bash
npm run build
npm run preview
```

In production, use the directory picker to select your `.claude` folder or drag-and-drop it into the welcome screen.

## Project Structure

```
src/
├── components/
│   ├── landing/        # Welcome screen
│   ├── layout/         # App shell, sidebar
│   ├── session/        # Session viewer, message renderers, timeline
│   └── shared/         # Reusable components
├── hooks/              # React hooks (state, file loading)
├── lib/                # Core logic
│   ├── parser.ts       # JSONL parsing
│   ├── tree-parser.ts  # Conversation tree analysis
│   ├── fs-access.ts    # File system abstraction
│   ├── timeline.ts     # Timeline event extraction
│   └── __tests__/      # Unit tests
└── types/              # TypeScript types
```

## Key Concepts

### Session Files

Claude Code stores conversation history in JSONL files at `~/.claude/projects/{project}/{session}.jsonl`. Each line is a JSON object representing a message, tool call, or system event.

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
