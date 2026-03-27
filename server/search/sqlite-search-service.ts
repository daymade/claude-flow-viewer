import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'

import { parseSessionContent } from '../../src/lib/parser'
import {
  SearchEngine,
  buildSearchTrigrams,
  extractSearchChunks,
  normalizeSearchText,
  tokenizeSearchText,
  type SearchChunkRecord,
  type SearchQueryOptions,
  type SearchResult,
  type SearchStats,
} from '../../src/lib/search'
import type { SearchEmbeddingProvider } from './embedding-provider'
import { listIndexedSessionFiles, type IndexedSessionFile, type SearchRoots } from './session-catalog'

const SEARCH_HOME_DIR = path.join(os.homedir(), '.claude-flow-viewer')
const SEARCH_DB_PATH = path.join(SEARCH_HOME_DIR, 'search.sqlite')
const REFRESH_INTERVAL_MS = 5000
const SCHEMA_VERSION = '4'
const DEFAULT_LEXICAL_LIMIT = 80
const DEFAULT_EMBEDDING_LIMIT = 80
const DEFAULT_FALLBACK_SCAN_LIMIT = 160
const BM25_SIGNAL_WEIGHT = 12
const EMBEDDING_SIGNAL_WEIGHT = 12
const MAX_QUERY_EMBEDDING_CACHE = 64
const SEARCH_VEC_TABLE = 'search_embeddings_vec'
const EMBEDDING_DIMS_META_KEY = 'embedding_dimensions'

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
  source: SearchChunkRecord['source']
  project_encoded: string
  session_id: string
  kind: SearchChunkRecord['kind']
  dims: number
  vector_json: string
  vector_blob: Buffer
}

type EmbeddingDistanceRow = {
  chunk_id: string
  distance: number
}

type SessionChunkRow = {
  id: number
  chunk_id: string
}

type VecEmbeddingJoinRow = {
  chunk_rowid: number
  source: SearchChunkRecord['source']
  project_encoded: string
  session_id: string
  kind: SearchChunkRecord['kind']
  vector_json: string
}

type SqliteMasterRow = {
  name: string
}

type MetaRow = {
  value: string
}

type FtsCandidateRow = {
  chunk_id: string
  bm25_score: number
}

type CountRow = {
  count: number
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

function toVecPrimaryKey(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
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

function serializeEmbeddingText(vector: Float32Array): string {
  return JSON.stringify([...vector])
}

function serializeEmbeddingBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export class SQLiteSearchService {
  private readonly roots: SearchRoots
  private readonly dbPath: string
  private readonly db: InstanceType<typeof Database>
  private readonly lexicalCandidateLimit: number
  private readonly embeddingCandidateLimit: number

  private embeddingProvider: SearchEmbeddingProvider | null
  private embeddingEnabled: boolean
  private lastRefreshAt = 0
  private refreshPromise: Promise<void> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private sqliteVecEnabled = false
  private vecLoadPromise: Promise<void> | null = null
  private vecTableDirty = false
  private readonly queryEmbeddingCache = new Map<string, Float32Array>()

  private readonly selectIndexedSessionsStmt
  private readonly deleteIndexedSessionStmt
  private readonly upsertIndexedSessionStmt
  private readonly selectSessionChunkRowsStmt
  private readonly clearFtsStmt
  private readonly repopulateFtsStmt
  private readonly deleteChunkEmbeddingStmt
  private readonly insertChunkStmt
  private readonly selectEmbeddingRowsStmt
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
    this.embeddingProvider = options.embeddingProvider ?? null
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
      SELECT id, chunk_id
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
    this.selectEmbeddingRowsStmt = this.db.prepare(`
      SELECT chunk_id, source, project_encoded, session_id, kind, dims, vector_json, vector_blob
      FROM search_embeddings
    `)
    this.insertEmbeddingStmt = this.db.prepare(`
      INSERT INTO search_embeddings (
        chunk_id,
        source,
        project_encoded,
        session_id,
        kind,
        dims,
        vector_json,
        vector_blob,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        dims = excluded.dims,
        source = excluded.source,
        project_encoded = excluded.project_encoded,
        session_id = excluded.session_id,
        kind = excluded.kind,
        vector_json = excluded.vector_json,
        vector_blob = excluded.vector_blob,
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
    if (this.countIndexedSessions() === 0) {
      await this.ensureFreshIndex()
    } else {
      this.scheduleFreshIndex()
    }

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

    const embeddingSignals = await this.collectEmbeddingSignals(query, {
      ...options,
      candidateChunkIds: candidateChunkIds.size > 0 ? [...candidateChunkIds] : undefined,
    })
    for (const [chunkId, signal] of embeddingSignals) {
      candidateChunkIds.add(chunkId)
      const existing = externalSignals[chunkId] ?? {}
      externalSignals[chunkId] = { ...existing, embedding: signal }
    }

    if (candidateChunkIds.size === 0) {
      const fallbackChunks = this.collectFallbackChunks(query, options)
      if (fallbackChunks.length > 0) {
        const engine = new SearchEngine()
        engine.addChunks(fallbackChunks)

        return {
          results: engine.search(query, options),
          status: this.getStatusPayload(),
        }
      }

      return {
        results: [],
        status: this.getStatusPayload(),
      }
    }

    const chunks = this.selectChunksByIds([...candidateChunkIds])
    if (chunks.length === 0) {
      return {
        results: [],
        status: this.getStatusPayload(),
      }
    }

    const engine = new SearchEngine()
    engine.addChunks(chunks)
    const results = engine.search(query, {
      ...options,
      candidateChunkIds: candidateChunkIds.size > 0 ? [...candidateChunkIds] : undefined,
      externalSignals,
    })

    return {
      results: results ?? [],
      status: this.getStatusPayload(),
    }
  }

  async getStatus(): Promise<SearchStatusPayload> {
    if (this.countIndexedSessions() === 0) {
      await this.ensureFreshIndex()
    } else {
      this.scheduleFreshIndex()
    }
    return this.getStatusPayload()
  }

  private getStatusPayload(): SearchStatusPayload {
    return {
      backend: 'sqlite',
      dbPath: this.dbPath,
      indexedAt: this.getMeta('last_indexed_at'),
      stats: {
        sessionCount: this.countIndexedSessions(),
        chunkCount: this.countIndexedChunks(),
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
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refreshIndex(force).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private scheduleFreshIndex(force = false): void {
    if (!force && this.countIndexedSessions() > 0 && !this.getMeta('last_indexed_at')) {
      return
    }

    const now = Date.now()
    if (!force && this.lastRefreshAt > 0 && now - this.lastRefreshAt < REFRESH_INTERVAL_MS) {
      return
    }
    if (this.refreshPromise) {
      return
    }
    if (this.refreshTimer) {
      return
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.refreshPromise) return

      this.refreshPromise = this.refreshIndex(force).finally(() => {
        this.refreshPromise = null
      })
      void this.refreshPromise
    }, 0)
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

    if (removed.length > 0) {
      this.removePersistedSessions(removed)
    }

    for (const session of changed) {
      await this.reindexSession(session)
    }

    if (removed.length > 0 || changed.length > 0 || force) {
      if (!this.sqliteVecEnabled || !this.vecTableExists()) {
        this.vecTableDirty = true
      }
      this.rebuildFtsIndex()
      this.setMeta('last_indexed_at', new Date().toISOString())
    }

    this.lastRefreshAt = Date.now()
  }

  private removePersistedSessions(rows: IndexedSessionRow[]) {
    const sessionChunkRows = new Map<string, SessionChunkRow[]>(
      rows.map((row) => {
        const key = sessionKey(row.source, row.project_encoded, row.session_id)
        const chunkRows = this.selectSessionChunkRowsStmt.all(row.source, row.project_encoded, row.session_id) as SessionChunkRow[]
        return [key, chunkRows]
      }),
    )

    const removeTransaction = this.db.transaction((input: IndexedSessionRow[]) => {
      const deleteVecStmt = this.sqliteVecEnabled && this.vecTableExists()
        ? this.db.prepare(`DELETE FROM ${SEARCH_VEC_TABLE} WHERE chunk_rowid = ?`)
        : null

      for (const row of input) {
        const key = sessionKey(row.source, row.project_encoded, row.session_id)
        const chunkRows = sessionChunkRows.get(key) ?? []
        for (const chunk of chunkRows) {
          deleteVecStmt?.run(toVecPrimaryKey(chunk.id))
          this.deleteChunkEmbeddingStmt.run(chunk.chunk_id)
        }
        this.db.prepare('DELETE FROM search_chunks WHERE source = ? AND project_encoded = ? AND session_id = ?')
          .run(row.source, row.project_encoded, row.session_id)
        this.deleteIndexedSessionStmt.run(row.source, row.project_encoded, row.session_id)
      }
    })

    removeTransaction(rows)
  }

  private async reindexSession(session: IndexedSessionFile): Promise<SearchChunkRecord[]> {
    const content = session.loadContent
      ? await session.loadContent()
      : await fs.promises.readFile(session.filePath, 'utf-8')
    const data = parseSessionContent(content, session.source)
    const chunks = extractSearchChunks({
      projectEncoded: session.projectEncoded,
      projectLabel: session.projectLabel,
      projectShortName: session.projectShortName,
      meta: session.meta,
      data,
    })

    const embeddings = await this.embedChunks(chunks)
    const firstVector = embeddings.values().next().value as Float32Array | undefined
    if (firstVector && firstVector.length > 0) {
      await this.ensureVecTable(firstVector.length)
    }
    const timestamp = new Date().toISOString()

    const writeTransaction = this.db.transaction((input: IndexedSessionFile, nextChunks: SearchChunkRecord[]) => {
      const existingRows = this.selectSessionChunkRowsStmt.all(input.source, input.projectEncoded, input.sessionId) as SessionChunkRow[]
      const deleteVecStmt = this.sqliteVecEnabled && this.vecTableExists()
        ? this.db.prepare(`DELETE FROM ${SEARCH_VEC_TABLE} WHERE chunk_rowid = ?`)
        : null
      const insertVecStmt = this.sqliteVecEnabled && this.vecTableExists()
        ? this.db.prepare(`
          INSERT INTO ${SEARCH_VEC_TABLE} (
            chunk_rowid,
            embedding,
            source,
            project_encoded,
            session_id,
            kind
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        : null

      for (const row of existingRows) {
        deleteVecStmt?.run(toVecPrimaryKey(row.id))
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
        const inserted = this.insertChunkStmt.run(
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
        const chunkRowId = Number((inserted as { lastInsertRowid: number | bigint }).lastInsertRowid)

        const vector = embeddings.get(chunk.id)
        if (vector && vector.length > 0) {
          this.insertEmbeddingStmt.run(
            chunk.id,
            chunk.source,
            chunk.projectEncoded,
            chunk.sessionId,
            chunk.kind,
            vector.length,
            serializeEmbeddingText(vector),
            serializeEmbeddingBlob(vector),
            timestamp,
          )
          insertVecStmt?.run(
            toVecPrimaryKey(chunkRowId),
            serializeEmbeddingText(vector),
            chunk.source,
            chunk.projectEncoded,
            chunk.sessionId,
            chunk.kind,
          )
        }
      }
    })

    writeTransaction(session, chunks)

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
    if (!this.hasFtsRows()) return new Map()

    const rows = this.searchFtsStmt.all(ftsQuery, this.lexicalCandidateLimit) as FtsCandidateRow[]
    return normalizeFtsSignals(rows)
  }

  private hasFtsRows(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM search_chunks_fts').get() as CountRow | undefined
    return (row?.count ?? 0) > 0
  }

  private collectFallbackChunks(query: string, options: SearchQueryOptions): SearchChunkRecord[] {
    const normalizedQuery = normalizeSearchText(query)
    if (!normalizedQuery) return []

    const selectFallbackRows = (likeClauses: string[], params: string[]): ChunkRow[] => {
      if (likeClauses.length === 0) return []

      const whereClauses = [`(${likeClauses.join(' OR ')})`]
      if (options.sources && options.sources.length > 0) {
        const placeholders = options.sources.map(() => '?').join(', ')
        whereClauses.push(`source IN (${placeholders})`)
        params.push(...options.sources)
      }
      if (options.projectEncoded) {
        whereClauses.push('project_encoded = ?')
        params.push(options.projectEncoded)
      }
      if (options.sessionId) {
        whereClauses.push('session_id = ?')
        params.push(options.sessionId)
      }
      if (options.kinds && options.kinds.length > 0) {
        const placeholders = options.kinds.map(() => '?').join(', ')
        whereClauses.push(`kind IN (${placeholders})`)
        params.push(...options.kinds)
      }

      return this.db.prepare(`
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
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY session_start_time DESC, id DESC
      LIMIT ?
    `).all(...params, DEFAULT_FALLBACK_SCAN_LIMIT) as ChunkRow[]
    }

    const exactRows = selectFallbackRows(
      ['normalized_text LIKE ? ESCAPE \'\\\''],
      [`%${escapeLikePattern(normalizedQuery)}%`],
    )
    if (exactRows.length > 0) {
      return exactRows.map(chunkRowToRecord)
    }

    const patterns = new Set<string>([normalizedQuery])
    for (const token of tokenizeSearchText(query)) {
      patterns.add(token)
    }
    for (const trigram of buildSearchTrigrams(query)) {
      patterns.add(trigram)
    }

    const likeClauses: string[] = []
    const params: string[] = []
    const orderedPatterns = [...patterns].filter(Boolean)

    for (const pattern of orderedPatterns) {
      likeClauses.push('normalized_text LIKE ? ESCAPE \'\\\'')
      params.push(`%${escapeLikePattern(pattern)}%`)
    }

    for (const pattern of orderedPatterns.slice(0, 12)) {
      likeClauses.push('trigrams_json LIKE ? ESCAPE \'\\\'')
      params.push(`%${escapeLikePattern(`"${pattern}"`)}%`)
    }

    return selectFallbackRows(likeClauses, params).map(chunkRowToRecord)
  }

  private async collectEmbeddingSignals(query: string, options: SearchQueryOptions = {}): Promise<Map<string, number>> {
    if (!this.embeddingProvider || !this.embeddingEnabled) {
      return new Map()
    }

    try {
      let queryVector = this.queryEmbeddingCache.get(query)
      if (!queryVector) {
        queryVector = await this.embeddingProvider.embedQuery(query)
        this.setCachedQueryVector(query, queryVector)
      }
      if (!queryVector || queryVector.length === 0) return new Map()

      await this.ensureVecTable(queryVector.length)
      if (this.sqliteVecEnabled && this.vecTableExists()) {
        try {
          return await this.collectEmbeddingSignalsWithVec(queryVector, options)
        } catch {
          this.sqliteVecEnabled = false
        }
      }

      return this.collectEmbeddingSignalsInProcess(queryVector, options)
    } catch {
      this.embeddingEnabled = false
      this.embeddingProvider = null
      this.queryEmbeddingCache.clear()
      return new Map()
    }
  }

  private async collectEmbeddingSignalsWithVec(
    queryVector: Float32Array,
    options: SearchQueryOptions,
  ): Promise<Map<string, number>> {
    const candidateFilter = options.candidateChunkIds ? new Set(options.candidateChunkIds) : null
    const queryVectorText = JSON.stringify(Array.from(queryVector))
    const params: Array<string | number> = [queryVectorText, this.embeddingCandidateLimit]
    let sql = `
      WITH vector_matches AS (
        SELECT chunk_rowid, distance
        FROM ${SEARCH_VEC_TABLE}
        WHERE embedding MATCH ?
          AND k = ?
    `

    if (candidateFilter && candidateFilter.size > 0) {
      const placeholders = Array.from(candidateFilter).map(() => '?').join(', ')
      sql += ` AND chunk_rowid IN (
        SELECT id
        FROM search_chunks
        WHERE chunk_id IN (${placeholders})
      )`
      params.push(...candidateFilter)
    }

    if (options.sources && options.sources.length > 0) {
      const placeholders = options.sources.map(() => '?').join(', ')
      sql += ` AND source IN (${placeholders})`
      params.push(...options.sources)
    }

    if (options.projectEncoded) {
      sql += ' AND project_encoded = ?'
      params.push(options.projectEncoded)
    }

    if (options.sessionId) {
      sql += ' AND session_id = ?'
      params.push(options.sessionId)
    }

    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map(() => '?').join(', ')
      sql += ` AND kind IN (${placeholders})`
      params.push(...options.kinds)
    }

    sql += `
      )
      SELECT search_chunks.chunk_id, vector_matches.distance
      FROM vector_matches
      JOIN search_chunks ON search_chunks.id = vector_matches.chunk_rowid
      ORDER BY vector_matches.distance ASC
    `

    const rows = this.db.prepare(sql).all(...params) as EmbeddingDistanceRow[]
    const scores: Array<{ chunkId: string; similarity: number }> = []
    for (const row of rows) {
      const similarity = 1 - Math.max(0, Math.min(2, row.distance))
      if (similarity > 0) {
        scores.push({ chunkId: row.chunk_id, similarity })
      }
    }

    return normalizeEmbeddingSignals(scores, this.embeddingCandidateLimit)
  }

  private vecTableExists(): boolean {
    const row = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(SEARCH_VEC_TABLE) as SqliteMasterRow | undefined
    return Boolean(row)
  }

  private async ensureVecTable(dims: number): Promise<void> {
    if (!Number.isInteger(dims) || dims <= 0) return

    await this.ensureVecSupport()
    if (!this.sqliteVecEnabled) return

    const storedDims = Number(this.getMeta(EMBEDDING_DIMS_META_KEY) ?? Number.NaN)
    const tableExists = this.vecTableExists()
    if (tableExists && storedDims === dims && !this.vecTableDirty) {
      return
    }

    this.db.exec(`DROP TABLE IF EXISTS ${SEARCH_VEC_TABLE}`)
    this.db.exec(`
      CREATE VIRTUAL TABLE ${SEARCH_VEC_TABLE} USING vec0(
        chunk_rowid INTEGER PRIMARY KEY,
        embedding FLOAT[${dims}] distance_metric=cosine,
        source TEXT,
        project_encoded TEXT,
        session_id TEXT,
        kind TEXT
      )
    `)
    this.setMeta(EMBEDDING_DIMS_META_KEY, String(dims))
    this.rebuildVecTable(dims)
    this.vecTableDirty = false
  }

  private rebuildVecTable(dims: number): void {
    if (!this.sqliteVecEnabled || !this.vecTableExists()) return

    const rows = this.db.prepare(`
      SELECT
        search_chunks.id AS chunk_rowid,
        search_embeddings.source,
        search_embeddings.project_encoded,
        search_embeddings.session_id,
        search_embeddings.kind,
        search_embeddings.vector_json
      FROM search_embeddings
      JOIN search_chunks ON search_chunks.chunk_id = search_embeddings.chunk_id
      WHERE search_embeddings.dims = ?
    `).all(dims) as VecEmbeddingJoinRow[]

    const insertVecStmt = this.db.prepare(`
      INSERT INTO ${SEARCH_VEC_TABLE} (
        chunk_rowid,
        embedding,
        source,
        project_encoded,
        session_id,
        kind
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const writeTransaction = this.db.transaction((input: VecEmbeddingJoinRow[]) => {
      for (const row of input) {
        insertVecStmt.run(
          toVecPrimaryKey(row.chunk_rowid),
          row.vector_json,
          row.source,
          row.project_encoded,
          row.session_id,
          row.kind,
        )
      }
    })
    writeTransaction(rows)
  }

  private countIndexedSessions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM indexed_sessions').get() as { count: number } | undefined
    return row?.count ?? 0
  }

  private countIndexedChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM search_chunks').get() as { count: number } | undefined
    return row?.count ?? 0
  }

  private selectChunksByIds(chunkIds: string[]): SearchChunkRecord[] {
    if (chunkIds.length === 0) return []
    const placeholders = chunkIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
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
      WHERE chunk_id IN (${placeholders})
    `).all(...chunkIds) as ChunkRow[]
    return rows.map(chunkRowToRecord)
  }

  private collectEmbeddingSignalsInProcess(
    queryVector: Float32Array,
    options: SearchQueryOptions,
  ): Map<string, number> {
    const candidateFilter = options.candidateChunkIds ? new Set(options.candidateChunkIds) : null
    const scores: Array<{ chunkId: string; similarity: number }> = []

    for (const row of this.selectEmbeddingRowsStmt.iterate() as IterableIterator<EmbeddingRow>) {
      if (row.dims !== queryVector.length) continue
      if (candidateFilter && !candidateFilter.has(row.chunk_id)) continue
      if (options.sources && !options.sources.includes(row.source)) continue
      if (options.projectEncoded && row.project_encoded !== options.projectEncoded) continue
      if (options.sessionId && row.session_id !== options.sessionId) continue
      if (options.kinds && !options.kinds.includes(row.kind)) continue

      const vector = parseEmbedding(row.vector_json)
      if (vector.length === 0) continue
      const similarity = dotSimilarity(queryVector, vector)
      if (similarity > 0) {
        scores.push({ chunkId: row.chunk_id, similarity })
      }
    }

    return normalizeEmbeddingSignals(scores, this.embeddingCandidateLimit)
  }

  private async ensureVecSupport(): Promise<void> {
    if (this.sqliteVecEnabled || !this.embeddingProvider || !this.embeddingEnabled) return
    if (this.vecLoadPromise) {
      await this.vecLoadPromise
      return
    }

    this.vecLoadPromise = (async () => {
      try {
        const sqliteVec = await import('sqlite-vec')
        const load = (sqliteVec as { load?: (db: InstanceType<typeof Database>) => Promise<void> | void }).load
        if (typeof load === 'function') {
          await load(this.db)
          this.sqliteVecEnabled = true
        }
      } catch {
        this.sqliteVecEnabled = false
      } finally {
        this.vecLoadPromise = null
      }
    })()

    await this.vecLoadPromise
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

  private setCachedQueryVector(query: string, vector: Float32Array): void {
    if (!vector.length) return
    this.queryEmbeddingCache.set(query, vector)
    if (this.queryEmbeddingCache.size <= MAX_QUERY_EMBEDDING_CACHE) return

    const oldest = this.queryEmbeddingCache.keys().next().value
    if (oldest !== undefined) {
      this.queryEmbeddingCache.delete(oldest)
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
        source TEXT NOT NULL,
        project_encoded TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        vector_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_search_embeddings_filter
      ON search_embeddings (source, project_encoded, session_id);

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
