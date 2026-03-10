import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SearchChunkRecord } from '../../src/lib/search'
import type { SearchEmbeddingProvider } from './embedding-provider'
import { createSQLiteSearchService } from './sqlite-search-service'

type TempFixture = {
  root: string
  claudeProjectsDir: string
  codexRootDir: string
  codexSessionsDir: string
  dbPath: string
}

async function makeFixture(): Promise<TempFixture> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-sqlite-search-'))
  return {
    root,
    claudeProjectsDir: path.join(root, '.claude', 'projects'),
    codexRootDir: path.join(root, '.codex'),
    codexSessionsDir: path.join(root, '.codex', 'sessions'),
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

    const deleted = await afterDelete.search('watercolor harbor sunrise')
    expect(deleted.results).toEqual([])
    expect(deleted.status.stats.sessionCount).toBe(0)
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

    const results = await service.search('polar memory', { limit: 5 })

    expect(results.status.embeddingEnabled).toBe(true)
    expect(results.status.embeddingProvider).toBe('fake-embeddings')
    expect(results.results[0]?.sessionId).toBe('session-2')
    expect(results.results[0]?.reasons.embedding).toBeGreaterThan(0)
  })
})
