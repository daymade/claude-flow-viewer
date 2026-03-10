import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'

import { parseSessionContent } from '../../src/lib/parser'
import {
  SearchEngine,
  extractSearchChunks,
  tokenizeSearchText,
  type SearchChunkRecord,
  type SearchQueryOptions,
  type SearchResult,
  type SearchStats,
} from '../../src/lib/search'
import { createDefaultEmbeddingProvider, type SearchEmbeddingProvider } from './embedding-provider'
import { listIndexedSessionFiles, type IndexedSessionFile, type SearchRoots } from './session-catalog'

const SEARCH_HOME_DIR = path.join(os.homedir(), '.claude-flow-viewer')
const SEARCH_DB_PATH = path.join(SEARCH_HOME_DIR, 'search.sqlite')
const REFRESH_INTERVAL_MS = 5000
const SCHEMA_VERSION = '3'
const DEFAULT_LEXICAL_LIMIT = 80
const DEFAULT_EMBEDDING_LIMIT = 80
const BM25_SIGNAL_WEIGHT = 12
const EMBEDDING_SIGNAL_WEIGHT = 12

type IndexedSessionRow = {
  source: SearchChunkRecord['source']
  project_encoded: string
  session_id: string
  file_path: string
  fingerprint: string
}

type ChunkRow = {
  chunk_id: string
  source: SearchChunkRecord['source']
  project_encoded: string
  project_label: string
  project_short_name: string
  session_id: string
  session_start_time: string
  kind: SearchChunkRecord['kind']
  title: string
  text: string
  normalized_text: string
  locator_json: string
  tokens_json: string
  trigrams_json: string
  search_tags_json: string
}

type EmbeddingRow = {
  chunk_id: string
  vector_json: string
}

type MetaRow = {
  value: string
}

type FtsCandidateRow = {
  chunk_id: string
  bm25_score: number
}

type SearchSignal = {
  bm25?: number
  embedding?: number
}

export interface SearchStatusPayload {
  backend: 'sqlite'
  dbPath: string
  indexedAt: string | null
  stats: SearchStats
  embeddingProvider: string | null
  embeddingEnabled: boolean
}

export interface SearchQueryPayload {
  results: SearchResult[]
  status: SearchStatusPayload
}

export interface SQLiteSearchServiceOptions {
  embeddingProvider?: SearchEmbeddingProvider | null
  lexicalCandidateLimit?: number
  embeddingCandidateLimit?: number
}

function openDatabase(dbPath: string): InstanceType<typeof Database> {
  return new Database(dbPath)
}

function sessionKey(source: SearchChunkRecord['source'], projectEncoded: string, sessionId: string): string {
  return `${source}:${projectEncoded}:${sessionId}`
}

function chunkRowToRecord(row: ChunkRow): SearchChunkRecord {
  return {
    id: row.chunk_id,
    source: row.source,
    projectEncoded: row.project_encoded,
    projectLabel: row.project_label,
    projectShortName: row.project_short_name,
    sessionId: row.session_id,
    sessionStartTime: row.session_start_time,
    kind: row.kind,
    title: row.title,
    text: row.text,
    normalizedText: row.normalized_text,
    locator: JSON.parse(row.locator_json) as SearchChunkRecord['locator'],
    tokens: JSON.parse(row.tokens_json) as string[],
    trigrams: JSON.parse(row.trigrams_json) as string[],
    searchTags: JSON.parse(row.search_tags_json) as string[],
  }
}

function parseEmbedding(json: string): Float32Array {
  try {
    const values = JSON.parse(json) as number[]
    return Float32Array.from(values)
  } catch {
    return new Float32Array()
  }
}

function serializeEmbedding(vector: Float32Array): string {
  return JSON.stringify([...vector])
}

function normalizeFtsSignals(rows: FtsCandidateRow[]): Map<string, number> {
  if (rows.length === 0) return new Map()

  const sorted = [...rows].sort((left, right) => left.bm25_score - right.bm25_score)
  const best = sorted[0]?.bm25_score ?? 0
  const worst = sorted[sorted.length - 1]?.bm25_score ?? 0

  if (best === worst) {
    return new Map(sorted.map((row) => [row.chunk_id, BM25_SIGNAL_WEIGHT]))
  }

  const scale = worst - best
  return new Map(sorted.map((row) => {
    const normalized = (worst - row.bm25_score) / scale
    return [row.chunk_id, Number((normalized * BM25_SIGNAL_WEIGHT).toFixed(3))]
  }))
}

function dotSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0
  let sum = 0
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index]
  }
  return sum
}

function normalizeEmbeddingSignals(
  scores: Array<{ chunkId: string; similarity: number }>,
  limit: number,
): Map<string, number> {
  const filtered = scores
    .filter((entry) => Number.isFinite(entry.similarity) && entry.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit)

  if (filtered.length === 0) return new Map()

  const best = filtered[0]?.similarity ?? 0
  const worst = filtered[filtered.length - 1]?.similarity ?? 0
  if (best === worst) {
    return new Map(filtered.map((entry) => [entry.chunkId, EMBEDDING_SIGNAL_WEIGHT]))
  }

  const scale = best - worst
  return new Map(filtered.map((entry) => {
    const normalized = (entry.similarity - worst) / scale
    return [entry.chunkId, Number((normalized * EMBEDDING_SIGNAL_WEIGHT).toFixed(3))]
  }))
}

function buildFtsQuery(query: string): string | null {
  const tokens = tokenizeSearchText(query)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

export class SQLiteSearchService {
  private readonly roots: SearchRoots
  private readonly dbPath: string
  private readonly db: InstanceType<typeof Database>
  private readonly lexicalCandidateLimit: number
  private readonly embeddingCandidateLimit: number

  private engine: SearchEngine | null = null
  private chunkEmbeddings = new Map<string, Float32Array>()
  private embeddingProvider: SearchEmbeddingProvider | null
  private embeddingEnabled: boolean
  private lastRefreshAt = 0
  private refreshPromise: Promise<void> | null = null
  private readonly queryEmbeddingCache = new Map<string, Float32Array>()

  private readonly selectIndexedSessionsStmt
  private readonly deleteIndexedSessionStmt
  private readonly upsertIndexedSessionStmt
  private readonly selectSessionChunkRowsStmt
  private readonly clearFtsStmt
  private readonly repopulateFtsStmt
  private readonly deleteChunkEmbeddingStmt
  private readonly insertChunkStmt
  private readonly selectAllChunksStmt
  private readonly selectAllEmbeddingsStmt
  private readonly insertEmbeddingStmt
  private readonly setMetaStmt
  private readonly getMetaStmt
  private readonly searchFtsStmt

  constructor(
    roots: SearchRoots,
    dbPath = SEARCH_DB_PATH,
    options: SQLiteSearchServiceOptions = {},
  ) {
    this.roots = roots
    this.dbPath = dbPath
    this.lexicalCandidateLimit = options.lexicalCandidateLimit ?? DEFAULT_LEXICAL_LIMIT
    this.embeddingCandidateLimit = options.embeddingCandidateLimit ?? DEFAULT_EMBEDDING_LIMIT
    this.embeddingProvider = options.embeddingProvider ?? createDefaultEmbeddingProvider()
    this.embeddingEnabled = Boolean(this.embeddingProvider)

    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    this.db = openDatabase(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    this.setMetaStmt = this.db.prepare(`
      INSERT INTO search_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.getMetaStmt = this.db.prepare(`
      SELECT value
      FROM search_meta
      WHERE key = ?
    `)

    const currentSchema = this.getMeta('schema_version')
    if (currentSchema !== SCHEMA_VERSION) {
      this.resetSchema()
      this.setMeta('schema_version', SCHEMA_VERSION)
    }

    this.selectIndexedSessionsStmt = this.db.prepare(`
      SELECT source, project_encoded, session_id, file_path, fingerprint
      FROM indexed_sessions
    `)
    this.deleteIndexedSessionStmt = this.db.prepare(`
      DELETE FROM indexed_sessions
      WHERE source = ? AND project_encoded = ? AND session_id = ?
    `)
    this.upsertIndexedSessionStmt = this.db.prepare(`
      INSERT INTO indexed_sessions (
        source,
        project_encoded,
        session_id,
        file_path,
        fingerprint,
        project_label,
        project_short_name,
        session_start_time,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, project_encoded, session_id) DO UPDATE SET
        file_path = excluded.file_path,
        fingerprint = excluded.fingerprint,
        project_label = excluded.project_label,
        project_short_name = excluded.project_short_name,
        session_start_time = excluded.session_start_time,
        updated_at = excluded.updated_at
    `)
    this.selectSessionChunkRowsStmt = this.db.prepare(`
      SELECT chunk_id
      FROM search_chunks
      WHERE source = ? AND project_encoded = ? AND session_id = ?
    `)
    this.clearFtsStmt = this.db.prepare(`
      DELETE FROM search_chunks_fts
    `)
    this.repopulateFtsStmt = this.db.prepare(`
      INSERT INTO search_chunks_fts (chunk_id, title, text, search_tags)
      SELECT chunk_id, title, text, search_tags_json
      FROM search_chunks
    `)
    this.deleteChunkEmbeddingStmt = this.db.prepare(`
      DELETE FROM search_embeddings
      WHERE chunk_id = ?
    `)
    this.insertChunkStmt = this.db.prepare(`
      INSERT INTO search_chunks (
        chunk_id,
        source,
        project_encoded,
        project_label,
        project_short_name,
        session_id,
        session_start_time,
        kind,
        title,
        text,
        normalized_text,
        locator_json,
        tokens_json,
        trigrams_json,
        search_tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectAllChunksStmt = this.db.prepare(`
      SELECT
        chunk_id,
        source,
        project_encoded,
        project_label,
        project_short_name,
        session_id,
        session_start_time,
        kind,
        title,
        text,
        normalized_text,
        locator_json,
        tokens_json,
        trigrams_json,
        search_tags_json
      FROM search_chunks
    `)
    this.selectAllEmbeddingsStmt = this.db.prepare(`
      SELECT chunk_id, vector_json
      FROM search_embeddings
    `)
    this.insertEmbeddingStmt = this.db.prepare(`
      INSERT INTO search_embeddings (
        chunk_id,
        dims,
        vector_json,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        dims = excluded.dims,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at
    `)
    this.searchFtsStmt = this.db.prepare(`
      SELECT chunk_id, bm25(search_chunks_fts, 1.5, 1.0, 0.7) AS bm25_score
      FROM search_chunks_fts
      WHERE search_chunks_fts MATCH ?
      LIMIT ?
    `)
  }

  async search(query: string, options: SearchQueryOptions = {}): Promise<SearchQueryPayload> {
    await this.ensureFreshIndex()

    if (!query.trim()) {
      return {
        results: [],
        status: this.getStatusPayload(),
      }
    }

    const candidateChunkIds = new Set<string>(options.candidateChunkIds ?? [])
    const externalSignals: Record<string, SearchSignal> = { ...options.externalSignals }

    const lexicalSignals = this.collectLexicalSignals(query)
    for (const [chunkId, signal] of lexicalSignals) {
      candidateChunkIds.add(chunkId)
      const existing = externalSignals[chunkId] ?? {}
      externalSignals[chunkId] = { ...existing, bm25: signal }
    }

    const embeddingSignals = await this.collectEmbeddingSignals(query)
    for (const [chunkId, signal] of embeddingSignals) {
      candidateChunkIds.add(chunkId)
      const existing = externalSignals[chunkId] ?? {}
      externalSignals[chunkId] = { ...existing, embedding: signal }
    }

    const results = this.engine?.search(query, {
      ...options,
      candidateChunkIds: candidateChunkIds.size > 0 ? [...candidateChunkIds] : undefined,
      externalSignals,
    }) ?? []

    return {
      results,
      status: this.getStatusPayload(),
    }
  }

  async getStatus(): Promise<SearchStatusPayload> {
    await this.ensureFreshIndex()
    return this.getStatusPayload()
  }

  private getStatusPayload(): SearchStatusPayload {
    return {
      backend: 'sqlite',
      dbPath: this.dbPath,
      indexedAt: this.getMeta('last_indexed_at'),
      stats: this.engine?.getStats() ?? {
        sessionCount: 0,
        chunkCount: 0,
        tokenCount: 0,
        trigramCount: 0,
      },
      embeddingProvider: this.embeddingProvider?.name ?? null,
      embeddingEnabled: this.embeddingEnabled && Boolean(this.embeddingProvider),
    }
  }

  private getMeta(key: string): string | null {
    const row = this.getMetaStmt.get(key) as MetaRow | undefined
    return row?.value ?? null
  }

  private setMeta(key: string, value: string) {
    this.setMetaStmt.run(key, value)
  }

  async ensureFreshIndex(force = false): Promise<void> {
    const now = Date.now()
    if (!force && this.engine && now - this.lastRefreshAt < REFRESH_INTERVAL_MS) {
      return
    }
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refreshIndex(force).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async refreshIndex(force: boolean): Promise<void> {
    const currentSessions = await listIndexedSessionFiles(this.roots)
    const currentMap = new Map(currentSessions.map((session) => [sessionKey(session.source, session.projectEncoded, session.sessionId), session]))
    const persistedRows = this.selectIndexedSessionsStmt.all() as IndexedSessionRow[]
    const persistedMap = new Map(persistedRows.map((row) => [sessionKey(row.source, row.project_encoded, row.session_id), row]))

    const removed = persistedRows.filter((row) => !currentMap.has(sessionKey(row.source, row.project_encoded, row.session_id)))
    const changed = currentSessions.filter((session) => {
      const persisted = persistedMap.get(sessionKey(session.source, session.projectEncoded, session.sessionId))
      if (!persisted) return true
      return force || persisted.fingerprint !== session.fingerprint || persisted.file_path !== session.filePath
    })

    if (!this.engine) {
      this.engine = new SearchEngine()
      const persistedChunks = (this.selectAllChunksStmt.all() as ChunkRow[]).map(chunkRowToRecord)
      this.engine.addChunks(persistedChunks)
      this.chunkEmbeddings = new Map(
        (this.selectAllEmbeddingsStmt.all() as EmbeddingRow[]).map((row) => [row.chunk_id, parseEmbedding(row.vector_json)]),
      )
    }

    if (removed.length > 0) {
      this.removePersistedSessions(removed)
      for (const row of removed) {
        this.engine.removeSession(row.source, row.project_encoded, row.session_id)
      }
    }

    for (const session of changed) {
      const chunks = await this.reindexSession(session)
      this.engine.removeSession(session.source, session.projectEncoded, session.sessionId)
      this.engine.addChunks(chunks)
    }

    if (removed.length > 0 || changed.length > 0 || force) {
      this.rebuildFtsIndex()
      this.setMeta('last_indexed_at', new Date().toISOString())
    }

    this.lastRefreshAt = Date.now()
  }

  private removePersistedSessions(rows: IndexedSessionRow[]) {
    const sessionChunkRows = new Map<string, Array<{ chunk_id: string }>>(
      rows.map((row) => {
        const key = sessionKey(row.source, row.project_encoded, row.session_id)
        const chunkRows = this.selectSessionChunkRowsStmt.all(row.source, row.project_encoded, row.session_id) as Array<{ chunk_id: string }>
        return [key, chunkRows]
      }),
    )

    const removeTransaction = this.db.transaction((input: IndexedSessionRow[]) => {
      for (const row of input) {
        const key = sessionKey(row.source, row.project_encoded, row.session_id)
        const chunkRows = sessionChunkRows.get(key) ?? []
        for (const chunk of chunkRows) {
          this.deleteChunkEmbeddingStmt.run(chunk.chunk_id)
        }
        this.db.prepare('DELETE FROM search_chunks WHERE source = ? AND project_encoded = ? AND session_id = ?')
          .run(row.source, row.project_encoded, row.session_id)
        this.deleteIndexedSessionStmt.run(row.source, row.project_encoded, row.session_id)
      }
    })

    removeTransaction(rows)

    for (const row of rows) {
      const key = sessionKey(row.source, row.project_encoded, row.session_id)
      const chunkRows = sessionChunkRows.get(key) ?? []
      for (const chunk of chunkRows) {
        this.chunkEmbeddings.delete(chunk.chunk_id)
      }
    }
  }

  private async reindexSession(session: IndexedSessionFile): Promise<SearchChunkRecord[]> {
    const content = await fs.promises.readFile(session.filePath, 'utf-8')
    const data = parseSessionContent(content, session.source)
    const chunks = extractSearchChunks({
      projectEncoded: session.projectEncoded,
      projectLabel: session.projectLabel,
      projectShortName: session.projectShortName,
      meta: session.meta,
      data,
    })

    const embeddings = await this.embedChunks(chunks)
    const timestamp = new Date().toISOString()

    const writeTransaction = this.db.transaction((input: IndexedSessionFile, nextChunks: SearchChunkRecord[]) => {
      const existingRows = this.selectSessionChunkRowsStmt.all(input.source, input.projectEncoded, input.sessionId) as Array<{ chunk_id: string }>
      for (const row of existingRows) {
        this.deleteChunkEmbeddingStmt.run(row.chunk_id)
      }
      this.db.prepare('DELETE FROM search_chunks WHERE source = ? AND project_encoded = ? AND session_id = ?')
        .run(input.source, input.projectEncoded, input.sessionId)

      this.upsertIndexedSessionStmt.run(
        input.source,
        input.projectEncoded,
        input.sessionId,
        input.filePath,
        input.fingerprint,
        input.projectLabel,
        input.projectShortName,
        input.meta.startTime,
        timestamp,
      )

      for (const chunk of nextChunks) {
        this.insertChunkStmt.run(
          chunk.id,
          chunk.source,
          chunk.projectEncoded,
          chunk.projectLabel,
          chunk.projectShortName,
          chunk.sessionId,
          chunk.sessionStartTime,
          chunk.kind,
          chunk.title,
          chunk.text,
          chunk.normalizedText,
          JSON.stringify(chunk.locator),
          JSON.stringify(chunk.tokens),
          JSON.stringify(chunk.trigrams),
          JSON.stringify(chunk.searchTags),
        )

        const vector = embeddings.get(chunk.id)
        if (vector && vector.length > 0) {
          this.insertEmbeddingStmt.run(
            chunk.id,
            vector.length,
            serializeEmbedding(vector),
            timestamp,
          )
        }
      }
    })

    writeTransaction(session, chunks)

    for (const [chunkId, vector] of embeddings) {
      this.chunkEmbeddings.set(chunkId, vector)
    }

    const indexedChunkIds = new Set(chunks.map((chunk) => chunk.id))
    for (const chunkId of [...this.chunkEmbeddings.keys()]) {
      if (chunkId.startsWith(`${session.projectEncoded}:${session.sessionId}:`) && !indexedChunkIds.has(chunkId)) {
        this.chunkEmbeddings.delete(chunkId)
      }
    }

    this.queryEmbeddingCache.clear()
    return chunks
  }

  private rebuildFtsIndex() {
    const rebuild = this.db.transaction(() => {
      this.clearFtsStmt.run()
      this.repopulateFtsStmt.run()
    })
    rebuild()
  }

  private collectLexicalSignals(query: string): Map<string, number> {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) return new Map()

    const rows = this.searchFtsStmt.all(ftsQuery, this.lexicalCandidateLimit) as FtsCandidateRow[]
    return normalizeFtsSignals(rows)
  }

  private async collectEmbeddingSignals(query: string): Promise<Map<string, number>> {
    if (!this.embeddingProvider || !this.embeddingEnabled || this.chunkEmbeddings.size === 0) {
      return new Map()
    }

    try {
      let queryVector = this.queryEmbeddingCache.get(query)
      if (!queryVector) {
        queryVector = await this.embeddingProvider.embedQuery(query)
        this.queryEmbeddingCache.set(query, queryVector)
      }
      if (!queryVector || queryVector.length === 0) return new Map()

      const scores: Array<{ chunkId: string; similarity: number }> = []
      for (const [chunkId, vector] of this.chunkEmbeddings) {
        const similarity = dotSimilarity(queryVector, vector)
        if (similarity > 0) {
          scores.push({ chunkId, similarity })
        }
      }

      return normalizeEmbeddingSignals(scores, this.embeddingCandidateLimit)
    } catch {
      this.embeddingEnabled = false
      this.embeddingProvider = null
      this.queryEmbeddingCache.clear()
      return new Map()
    }
  }

  private async embedChunks(chunks: SearchChunkRecord[]): Promise<Map<string, Float32Array>> {
    if (!this.embeddingProvider || !this.embeddingEnabled || chunks.length === 0) {
      return new Map()
    }

    try {
      return await this.embeddingProvider.embedChunks(chunks)
    } catch {
      this.embeddingEnabled = false
      this.embeddingProvider = null
      return new Map()
    }
  }

  private resetSchema() {
    this.db.exec(`
      DROP TABLE IF EXISTS search_chunks_fts;
      DROP TABLE IF EXISTS search_embeddings;
      DROP TABLE IF EXISTS search_chunks;
      DROP TABLE IF EXISTS indexed_sessions;

      CREATE TABLE indexed_sessions (
        source TEXT NOT NULL,
        project_encoded TEXT NOT NULL,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        project_label TEXT NOT NULL,
        project_short_name TEXT NOT NULL,
        session_start_time TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, project_encoded, session_id)
      );

      CREATE TABLE search_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        project_encoded TEXT NOT NULL,
        project_label TEXT NOT NULL,
        project_short_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_start_time TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        locator_json TEXT NOT NULL,
        tokens_json TEXT NOT NULL,
        trigrams_json TEXT NOT NULL,
        search_tags_json TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE search_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        title,
        text,
        search_tags,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE search_embeddings (
        chunk_id TEXT PRIMARY KEY,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_search_chunks_session
      ON search_chunks (source, project_encoded, session_id);
    `)
  }
}

export function createSQLiteSearchService(
  roots: SearchRoots,
  dbPath?: string,
  options?: SQLiteSearchServiceOptions,
): SQLiteSearchService {
  return new SQLiteSearchService(roots, dbPath, options)
}
