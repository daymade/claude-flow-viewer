import fs from 'node:fs/promises'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { SearchChunkRecord } from '../../src/lib/search'
import type { SearchEmbeddingProvider } from './embedding-provider'
import { createSQLiteSearchService } from './sqlite-search-service'

type TempFixture = {
  root: string
  claudeProjectsDir: string
  codexRootDir: string
  codexSessionsDir: string
  cherryUserDataDir: string
  dbPath: string
}

async function makeFixture(): Promise<TempFixture> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-sqlite-search-'))
  return {
    root,
    claudeProjectsDir: path.join(root, '.claude', 'projects'),
    codexRootDir: path.join(root, '.codex'),
    codexSessionsDir: path.join(root, '.codex', 'sessions'),
    cherryUserDataDir: path.join(root, 'Library', 'Application Support', 'CherryStudioDev'),
    dbPath: path.join(root, '.claude-flow-viewer', 'search.sqlite'),
  }
}

async function writeClaudeSession(filePath: string, prompt: string, response: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-03-10T00:00:00.000Z',
      message: { role: 'user', content: prompt },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-10T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: response }] },
    }),
  ].join('\n'))
}

async function writeCherryStudioAgentDb(
  userDataDir: string,
  content: {
    prompt?: string
    thinking?: string
    reply?: string
  } = {},
) {
  const prompt = content.prompt ?? 'Map amber reflections across the harbor'
  const thinking = content.thinking ?? 'Pick a warmer reflection gradient.'
  const reply = content.reply ?? 'Cherry Studio rendered amber reflections with blue water shadows.'

  await fs.mkdir(path.join(userDataDir, 'Data'), { recursive: true })

  const dbPath = path.join(userDataDir, 'Data', 'agents.db')
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    db.prepare('INSERT INTO agents (id, name, type) VALUES (?, ?, ?)').run(
      'agent-1',
      'Cherry Analyst',
      'assistant',
    )

    db.prepare(`
      INSERT INTO sessions (
        id,
        agent_id,
        agent_type,
        name,
        description,
        model,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'cs-session-1',
      'agent-1',
      'assistant',
      'Cherry search smoke test',
      null,
      'gpt-4.1',
      '2026-03-10T00:00:00.000Z',
      '2026-03-10T00:00:02.000Z',
    )

    db.prepare(`
      INSERT INTO session_messages (
        session_id,
        role,
        content,
        metadata,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'cs-session-1',
      'user',
      JSON.stringify({
        blocks: [
          {
            type: 'main_text',
            content: prompt,
          },
        ],
      }),
      null,
      '2026-03-10T00:00:00.000Z',
      '2026-03-10T00:00:00.000Z',
    )

    db.prepare(`
      INSERT INTO session_messages (
        session_id,
        role,
        content,
        metadata,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'cs-session-1',
      'assistant',
      JSON.stringify({
        blocks: [
          {
            type: 'thinking',
            content: thinking,
          },
          {
            type: 'main_text',
            content: reply,
          },
        ],
      }),
      null,
      '2026-03-10T00:00:01.000Z',
      '2026-03-10T00:00:01.000Z',
    )
  } finally {
    db.close()
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs = 250): Promise<T | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs)
    }),
  ])
}

describe('SQLiteSearchService', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('persists chunks in SQLite and incrementally reindexes changed or removed sessions', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    const sessionPath = path.join(fixture.claudeProjectsDir, 'demo-project', 'session-1.jsonl')
    await writeClaudeSession(
      sessionPath,
      'Paint the skyline from memory',
      'Use a neon skyline with amber reflections and rain.',
    )

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await service.ensureFreshIndex()
    const initial = await service.search('amber reflections')

    expect(initial.results[0]?.sessionId).toBe('session-1')
    expect(initial.results[0]?.snippet.toLowerCase()).toContain('amber reflections')
    expect(initial.results[0]?.reasons.bm25).toBeGreaterThan(0)
    expect(initial.status.stats.sessionCount).toBe(1)

    const persistedDb = await fs.stat(fixture.dbPath)
    expect(persistedDb.size).toBeGreaterThan(0)

    await writeClaudeSession(
      sessionPath,
      'Paint the skyline from memory',
      'Switch to a watercolor harbor at sunrise with mist.',
    )

    const restarted = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await restarted.ensureFreshIndex()
    const updated = await restarted.search('watercolor harbor sunrise')
    expect(updated.results[0]?.sessionId).toBe('session-1')
    expect(updated.results[0]?.snippet.toLowerCase()).toContain('watercolor harbor')

    const stale = await restarted.search('amber reflections')
    expect(stale.results.some((result) => result.snippet.toLowerCase().includes('amber reflections'))).toBe(false)
    expect(stale.results.some((result) => result.kind === 'ai-text')).toBe(false)

    await fs.rm(sessionPath, { force: true })

    const afterDelete = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await afterDelete.ensureFreshIndex()
    const deleted = await afterDelete.search('watercolor harbor sunrise')
    expect(deleted.results).toEqual([])
    expect(deleted.status.stats.sessionCount).toBe(0)
  })

  it('refreshes the same service after a session changes without waiting for the throttle window', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    const sessionPath = path.join(fixture.claudeProjectsDir, 'demo-project', 'session-1.jsonl')
    await writeClaudeSession(
      sessionPath,
      'Paint the skyline from memory',
      'Use a neon skyline with amber reflections and rain.',
    )

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await service.ensureFreshIndex()
    expect((await service.search('amber reflections', { limit: 5 })).results[0]?.sessionId).toBe('session-1')

    await writeClaudeSession(
      sessionPath,
      'Paint the skyline from memory',
      'Switch to a watercolor harbor at sunrise with mist.',
    )

    await service.ensureFreshIndex()
    const updated = await service.search('watercolor harbor sunrise', { limit: 5 })

    expect(updated.results[0]?.sessionId).toBe('session-1')
    expect(updated.results[0]?.snippet.toLowerCase()).toContain('watercolor harbor')
    expect(updated.results.some((result) => result.snippet.toLowerCase().includes('amber reflections'))).toBe(false)
  })

  it('fuses embedding similarity into hybrid ranking when a local provider is available', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    await writeClaudeSession(
      path.join(fixture.claudeProjectsDir, 'demo-project', 'session-1.jsonl'),
      'Review the skyline concept',
      'Render a skyline with reflective glass towers at dusk.',
    )
    await writeClaudeSession(
      path.join(fixture.claudeProjectsDir, 'demo-project', 'session-2.jsonl'),
      'Review the aurora concept',
      'Compose northern lights over a misty harbor.',
    )

    const fakeProvider: SearchEmbeddingProvider = {
      name: 'fake-embeddings',
      modelId: 'test-model',
      cacheDir: fixture.root,
      localModelPath: fixture.root,
      async embedQuery(query: string) {
        if (query.includes('polar')) return Float32Array.from([1, 0])
        return Float32Array.from([0, 1])
      },
      async embedChunks(chunks: SearchChunkRecord[]) {
        return new Map(chunks.map((chunk) => [
          chunk.id,
          chunk.text.includes('northern lights')
            ? Float32Array.from([1, 0])
            : Float32Array.from([0, 1]),
        ]))
      },
    }

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath, {
      embeddingProvider: fakeProvider,
    })

    await service.ensureFreshIndex()
    const results = await service.search('polar memory', { limit: 5 })

    expect(results.status.embeddingEnabled).toBe(true)
    expect(results.status.embeddingProvider).toBe('fake-embeddings')
    expect(results.results[0]?.sessionId).toBe('session-2')
    expect(results.results[0]?.reasons.embedding).toBeGreaterThan(0)
  })

  it('indexes Cherry Studio sessions and returns them through the search pipeline', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    await writeCherryStudioAgentDb(fixture.cherryUserDataDir)

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await service.ensureFreshIndex()
    const results = await service.search('amber reflections', { limit: 5 })

    expect(results.status.stats.sessionCount).toBe(1)
    expect(results.status.indexedAt).toBeTruthy()
    expect(results.results.some((result) => result.source === 'cherrystudio')).toBe(true)

    const cherryResult = results.results.find((result) => result.source === 'cherrystudio')
    expect(cherryResult?.sessionId).toBe('cs-session-1')
    expect(cherryResult?.projectShortName).toBe('Cherry Studio')
    expect(cherryResult?.snippet.toLowerCase()).toContain('amber reflections')
  })

  it('refreshes Cherry Studio data on demand for status and search requests', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    await writeCherryStudioAgentDb(fixture.cherryUserDataDir)

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    const status = await service.getStatus()
    expect(status.stats.sessionCount).toBe(1)
    expect(status.indexedAt).toBeTruthy()

    const results = await service.search('amber reflections', { limit: 5 })
    expect(results.results[0]?.source).toBe('cherrystudio')
    expect(results.results[0]?.sessionId).toBe('cs-session-1')
  })

  it('serves status and search immediately from the current Cherry index while refresh runs in the background', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    await writeCherryStudioAgentDb(fixture.cherryUserDataDir)

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await service.ensureFreshIndex()

    let refreshCalls = 0
    const testService = service as unknown as {
      refreshIndex: () => Promise<void>
      lastRefreshAt: number
    }
    testService.refreshIndex = async () => {
      refreshCalls += 1
      await new Promise<void>(() => {})
    }
    testService.lastRefreshAt = 0

    const status = await raceWithTimeout(service.getStatus())
    expect(status).not.toBe('timeout')
    expect((status as { stats: { sessionCount: number } }).stats.sessionCount).toBe(1)

    const results = await raceWithTimeout(service.search('amber reflections', { limit: 5 }))
    expect(results).not.toBe('timeout')
    expect((results as { results: Array<{ source: string; sessionId: string }> }).results.some((result) => result.source === 'cherrystudio')).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refreshCalls).toBeGreaterThan(0)
  })

  it('falls back to persisted chunks when FTS metadata is missing so Cherry searches stay responsive', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)

    await writeCherryStudioAgentDb(fixture.cherryUserDataDir, {
      prompt: 'what framwork are you using',
      reply: 'Cherry Studio is using a local search framework regression fixture.',
    })

    const service = createSQLiteSearchService({
      claudeProjectsDir: fixture.claudeProjectsDir,
      codexRootDir: fixture.codexRootDir,
      codexSessionsDir: fixture.codexSessionsDir,
    }, fixture.dbPath)

    await service.ensureFreshIndex()

    const db = new Database(fixture.dbPath)
    try {
      db.exec(`
        DELETE FROM search_chunks_fts;
        DELETE FROM search_meta WHERE key = 'last_indexed_at';
      `)
    } finally {
      db.close()
    }

    let refreshCalls = 0
    const testService = service as unknown as {
      refreshIndex: () => Promise<void>
      lastRefreshAt: number
    }
    testService.refreshIndex = async () => {
      refreshCalls += 1
      await new Promise<void>(() => {})
    }
    testService.lastRefreshAt = 0

    const status = await raceWithTimeout(service.getStatus())
    expect(status).not.toBe('timeout')
    expect((status as { indexedAt: string | null }).indexedAt).toBeNull()

    const results = await raceWithTimeout(service.search('framwork', { limit: 5 }))
    expect(results).not.toBe('timeout')

    const payload = results as { results: Array<{ source: string; sessionId: string; snippet: string }> }
    expect(payload.results.some((result) => result.source === 'cherrystudio')).toBe(true)
    expect(payload.results[0]?.sessionId).toBe('cs-session-1')
    expect(payload.results[0]?.snippet.toLowerCase()).toContain('framwork')
    expect(refreshCalls).toBe(0)
  })
})
