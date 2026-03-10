import { buildSearchTrigrams, extractSearchChunks, normalizeSearchText, tokenizeSearchText } from './extract'
import { createCooccurrenceSemanticProvider } from './semantic'
import type {
  SearchChunkKind,
  SearchChunkRecord,
  SearchEngineOptions,
  SearchQueryOptions,
  SearchReasonBreakdown,
  SearchResult,
  SearchSessionRecord,
  SearchStats,
  SemanticSearchContext,
  SemanticSearchProvider,
  SemanticSearchProviderFactory,
} from './types'

const DEFAULT_LIMIT = 20

const KIND_WEIGHTS: Record<SearchChunkKind, number> = {
  metadata: 0.9,
  prompt: 1.3,
  'ai-text': 1.1,
  thinking: 0.8,
  'tool-call': 0.8,
  'tool-result': 1,
  'team-message': 0.95,
  'delegation-update': 0.85,
  'task-event': 0.9,
}

function roundScore(value: number): number {
  return Number(value.toFixed(3))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function includesPhrase(chunk: SearchChunkRecord, normalizedQuery: string): boolean {
  return normalizedQuery.length > 1 && chunk.normalizedText.includes(normalizedQuery)
}

function buildSnippet(chunk: SearchChunkRecord, query: string, matchedTokens: string[]): { snippet: string; matchedText: string } {
  const lower = chunk.text.toLowerCase()
  const loweredQuery = query.toLowerCase()
  let match = loweredQuery && lower.includes(loweredQuery) ? loweredQuery : ''

  if (!match) {
    match = matchedTokens.find((token) => lower.includes(token.toLowerCase())) ?? ''
  }

  if (!match) {
    const snippet = chunk.text.length > 140 ? `${chunk.text.slice(0, 137)}...` : chunk.text
    return { snippet, matchedText: chunk.text.slice(0, 48) }
  }

  const index = lower.indexOf(match.toLowerCase())
  const start = Math.max(0, index - 50)
  const end = Math.min(chunk.text.length, index + match.length + 70)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < chunk.text.length ? '...' : ''
  return {
    snippet: `${prefix}${chunk.text.slice(start, end).trim()}${suffix}`,
    matchedText: chunk.text.slice(index, index + match.length),
  }
}

function matchesOptions(chunk: SearchChunkRecord, options: SearchQueryOptions): boolean {
  if (options.projectEncoded && chunk.projectEncoded !== options.projectEncoded) return false
  if (options.sessionId && chunk.sessionId !== options.sessionId) return false
  if (options.kinds && !options.kinds.includes(chunk.kind)) return false
  if (options.sources && !options.sources.includes(chunk.source)) return false
  return true
}

function hasExternalSignal(options: SearchQueryOptions, chunkId: string): boolean {
  const signal = options.externalSignals?.[chunkId]
  return Boolean(signal && ((signal.bm25 ?? 0) > 0 || (signal.embedding ?? 0) > 0))
}

function toSessionKey(source: SearchChunkRecord['source'], projectEncoded: string, sessionId: string): string {
  return `${source}:${projectEncoded}:${sessionId}`
}

export class SearchEngine {
  private readonly chunks = new Map<string, SearchChunkRecord>()
  private readonly sessionChunks = new Map<string, string[]>()
  private readonly tokenIndex = new Map<string, Map<string, number>>()
  private readonly trigramIndex = new Map<string, Set<string>>()
  private semanticProvider: SemanticSearchProvider | null
  private readonly semanticProviderFactory: SemanticSearchProviderFactory | null
  private semanticDirty = true

  constructor(options: SearchEngineOptions | SemanticSearchProvider = {}) {
    if ('score' in options && 'name' in options) {
      this.semanticProvider = options
      this.semanticProviderFactory = null
      this.semanticDirty = false
      return
    }

    this.semanticProvider = options.semanticProvider ?? null
    this.semanticProviderFactory = options.semanticProvider
      ? null
      : options.semanticProviderFactory === undefined
        ? createCooccurrenceSemanticProvider
        : options.semanticProviderFactory
    this.semanticDirty = Boolean(this.semanticProviderFactory)
  }

  addSession(session: SearchSessionRecord): SearchChunkRecord[] {
    const chunks = extractSearchChunks(session)
    this.replaceSessionChunks(
      toSessionKey(session.meta.source, session.projectEncoded, session.meta.id),
      chunks,
    )
    return chunks
  }

  addSessions(sessions: SearchSessionRecord[]): SearchChunkRecord[] {
    return sessions.flatMap((session) => this.addSession(session))
  }

  addChunk(chunk: SearchChunkRecord): void {
    this.addChunks([chunk])
  }

  addChunks(chunks: SearchChunkRecord[]): void {
    for (const chunk of chunks) {
      const sessionKey = toSessionKey(chunk.source, chunk.projectEncoded, chunk.sessionId)
      this.removeChunk(chunk.id)

      this.chunks.set(chunk.id, chunk)
      const chunkIds = this.sessionChunks.get(sessionKey) ?? []
      chunkIds.push(chunk.id)
      this.sessionChunks.set(sessionKey, chunkIds)

      for (const token of chunk.tokens) {
        const postings = this.tokenIndex.get(token) ?? new Map<string, number>()
        postings.set(chunk.id, (postings.get(chunk.id) ?? 0) + 1)
        this.tokenIndex.set(token, postings)
      }

      for (const trigram of chunk.trigrams) {
        const matches = this.trigramIndex.get(trigram) ?? new Set<string>()
        matches.add(chunk.id)
        this.trigramIndex.set(trigram, matches)
      }
    }

    if (chunks.length > 0) {
      this.semanticDirty = Boolean(this.semanticProviderFactory)
    }
  }

  replaceSessionChunks(sessionKey: string, chunks: SearchChunkRecord[]): void {
    const existingChunkIds = this.sessionChunks.get(sessionKey)
    if (existingChunkIds) {
      for (const chunkId of [...existingChunkIds]) {
        this.removeChunk(chunkId)
      }
      this.sessionChunks.delete(sessionKey)
    }

    this.addChunks(chunks)
  }

  removeSession(source: SearchChunkRecord['source'], projectEncoded: string, sessionId: string): void {
    const sessionKey = toSessionKey(source, projectEncoded, sessionId)
    const existingChunkIds = this.sessionChunks.get(sessionKey)
    if (!existingChunkIds) return

    for (const chunkId of [...existingChunkIds]) {
      this.removeChunk(chunkId)
    }
    this.sessionChunks.delete(sessionKey)
    this.semanticDirty = Boolean(this.semanticProviderFactory)
  }

  getChunks(): SearchChunkRecord[] {
    return [...this.chunks.values()]
  }

  getChunk(chunkId: string): SearchChunkRecord | undefined {
    return this.chunks.get(chunkId)
  }

  search(query: string, options: SearchQueryOptions = {}): SearchResult[] {
    const normalizedQuery = normalizeSearchText(query)
    if (!normalizedQuery) return []

    this.ensureSemanticProvider()

    const queryTokens = tokenizeSearchText(query)
    const queryTrigrams = buildSearchTrigrams(query)
    const context: SemanticSearchContext = {
      normalizedQuery,
      queryTokens,
      queryTrigrams,
    }

    const candidates = this.collectCandidates(context, options)
    const results: SearchResult[] = []
    for (const chunk of candidates) {
      const scored = this.scoreChunk(chunk, context, query, options)
      if (scored.score <= 0) continue
      results.push(scored)
    }

    return results
      .sort((left, right) => right.score - left.score || right.locator.messageIndex - left.locator.messageIndex)
      .slice(0, options.limit ?? DEFAULT_LIMIT)
  }

  getStats(): SearchStats {
    return {
      sessionCount: this.sessionChunks.size,
      chunkCount: this.chunks.size,
      tokenCount: this.tokenIndex.size,
      trigramCount: this.trigramIndex.size,
    }
  }

  private collectCandidates(context: SemanticSearchContext, options: SearchQueryOptions): SearchChunkRecord[] {
    const candidateIds = new Set<string>(options.candidateChunkIds ?? [])

    for (const token of context.queryTokens) {
      const postings = this.tokenIndex.get(token)
      if (!postings) continue
      for (const chunkId of postings.keys()) {
        candidateIds.add(chunkId)
      }
    }

    for (const trigram of context.queryTrigrams) {
      const matches = this.trigramIndex.get(trigram)
      if (!matches) continue
      for (const chunkId of matches) {
        candidateIds.add(chunkId)
      }
    }

    const semanticTokens = this.semanticProvider?.expandQuery?.(context) ?? []
    for (const token of semanticTokens) {
      const postings = this.tokenIndex.get(token)
      if (!postings) continue
      for (const chunkId of postings.keys()) {
        candidateIds.add(chunkId)
      }
    }

    if (candidateIds.size === 0) {
      for (const chunk of this.chunks.values()) {
        if (includesPhrase(chunk, context.normalizedQuery)) {
          candidateIds.add(chunk.id)
        }
      }
    }

    return [...candidateIds]
      .map((chunkId) => this.chunks.get(chunkId))
      .filter((chunk): chunk is SearchChunkRecord => Boolean(chunk) && matchesOptions(chunk!, options))
  }

  private ensureSemanticProvider() {
    if (!this.semanticDirty || !this.semanticProviderFactory) return
    this.semanticProvider = this.semanticProviderFactory([...this.chunks.values()])
    this.semanticDirty = false
  }

  private scoreChunk(chunk: SearchChunkRecord, context: SemanticSearchContext, rawQuery: string, options: SearchQueryOptions): SearchResult {
    const exactPhrase = includesPhrase(chunk, context.normalizedQuery) ? 24 : 0

    let tokenOverlap = 0
    const matchedTokens: string[] = []
    for (const token of context.queryTokens) {
      const postings = this.tokenIndex.get(token)
      const frequency = postings?.get(chunk.id) ?? 0
      if (frequency <= 0) continue
      matchedTokens.push(token)
      const documentFrequency = postings?.size ?? 1
      const idf = 1 + Math.log((this.chunks.size + 1) / (documentFrequency + 1))
      tokenOverlap += Math.min(3, frequency) * idf
    }
    tokenOverlap *= 4

    const trigramOverlap = this.trigramScore(chunk, context.queryTrigrams)
    const semantic = clamp(this.semanticProvider?.score(chunk, context) ?? 0, 0, 1) * 8
    const kindBoost = KIND_WEIGHTS[chunk.kind] * 2
    const metadataBoost = chunk.searchTags.some((tag) => normalizeSearchText(tag).includes(context.normalizedQuery)) ? 2 : 0
    const sessionStartMs = chunk.sessionStartTime ? Date.parse(chunk.sessionStartTime) : Number.NaN
    const recency = Number.isFinite(sessionStartMs)
      ? clamp(1 - ((Date.now() - sessionStartMs) / (1000 * 60 * 60 * 24 * 365 * 5)), 0, 1)
      : 0

    const bm25 = roundScore(options.externalSignals?.[chunk.id]?.bm25 ?? 0)
    const embeddingSignal = roundScore(options.externalSignals?.[chunk.id]?.embedding ?? 0)

    const reasons: SearchReasonBreakdown = {
      exactPhrase,
      tokenOverlap: roundScore(tokenOverlap),
      trigram: roundScore(trigramOverlap),
      semantic: roundScore(semantic),
      kindBoost: roundScore(kindBoost),
      metadataBoost: roundScore(metadataBoost),
      recency: roundScore(recency),
      bm25,
      embedding: embeddingSignal,
    }

    const baseScore = exactPhrase
      + tokenOverlap
      + trigramOverlap
      + semantic
      + kindBoost
      + metadataBoost
      + recency
    const score = hasExternalSignal(options, chunk.id)
      ? roundScore(baseScore * 0.2 + bm25 * 1.5 + embeddingSignal * 2.5)
      : roundScore(baseScore)

    const snippet = buildSnippet(chunk, rawQuery, matchedTokens)
    return {
      chunkId: chunk.id,
      projectEncoded: chunk.projectEncoded,
      projectLabel: chunk.projectLabel,
      projectShortName: chunk.projectShortName,
      sessionId: chunk.sessionId,
      source: chunk.source,
      kind: chunk.kind,
      locator: chunk.locator,
      title: chunk.title,
      snippet: snippet.snippet,
      matchedText: snippet.matchedText,
      score,
      reasons,
    }
  }

  private trigramScore(chunk: SearchChunkRecord, queryTrigrams: string[]): number {
    if (queryTrigrams.length === 0 || chunk.trigrams.length === 0) return 0
    const querySet = new Set(queryTrigrams)
    let overlap = 0
    for (const trigram of chunk.trigrams) {
      if (querySet.has(trigram)) overlap += 1
    }
    const dice = (2 * overlap) / (querySet.size + chunk.trigrams.length)
    return roundScore(dice * 16)
  }

  private removeChunk(chunkId: string) {
    const chunk = this.chunks.get(chunkId)
    if (!chunk) return

    this.chunks.delete(chunkId)

    const sessionKey = toSessionKey(chunk.source, chunk.projectEncoded, chunk.sessionId)
    const sessionChunkIds = this.sessionChunks.get(sessionKey)
    if (sessionChunkIds) {
      const next = sessionChunkIds.filter((id) => id !== chunkId)
      if (next.length > 0) this.sessionChunks.set(sessionKey, next)
      else this.sessionChunks.delete(sessionKey)
    }

    for (const token of chunk.tokens) {
      const postings = this.tokenIndex.get(token)
      if (!postings) continue
      postings.delete(chunkId)
      if (postings.size === 0) this.tokenIndex.delete(token)
    }

    for (const trigram of chunk.trigrams) {
      const matches = this.trigramIndex.get(trigram)
      if (!matches) continue
      matches.delete(chunkId)
      if (matches.size === 0) this.trigramIndex.delete(trigram)
    }

    this.semanticDirty = Boolean(this.semanticProviderFactory)
  }
}
