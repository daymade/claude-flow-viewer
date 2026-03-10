import type { SessionData, SessionMeta, SessionSource } from '../../types/session'

export type SearchChunkKind =
  | 'metadata'
  | 'prompt'
  | 'ai-text'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'team-message'
  | 'delegation-update'
  | 'task-event'

export interface SearchSessionRecord {
  projectEncoded: string
  projectLabel: string
  projectShortName?: string
  meta: SessionMeta
  data: SessionData
}

export interface SearchChunkLocator {
  kind: SearchChunkKind
  messageIndex: number
  promptNum?: number
  timestamp?: string
}

export interface SearchChunkRecord {
  id: string
  projectEncoded: string
  projectLabel: string
  projectShortName: string
  sessionId: string
  source: SessionSource
  sessionStartTime: string
  kind: SearchChunkKind
  title: string
  text: string
  normalizedText: string
  tokens: string[]
  trigrams: string[]
  locator: SearchChunkLocator
  searchTags: string[]
}

export interface SearchEngineOptions {
  semanticProvider?: SemanticSearchProvider
  semanticProviderFactory?: SemanticSearchProviderFactory | null
}

export interface SearchExternalSignals {
  bm25?: number
  embedding?: number
}

export interface SearchReasonBreakdown {
  exactPhrase: number
  tokenOverlap: number
  trigram: number
  semantic: number
  kindBoost: number
  metadataBoost: number
  recency: number
  bm25?: number
  embedding?: number
}

export interface SearchResult {
  chunkId: string
  projectEncoded: string
  projectLabel: string
  projectShortName: string
  sessionId: string
  source: SessionSource
  kind: SearchChunkKind
  locator: SearchChunkLocator
  title: string
  snippet: string
  matchedText: string
  score: number
  reasons: SearchReasonBreakdown
}

export interface SearchQueryOptions {
  limit?: number
  kinds?: SearchChunkKind[]
  sources?: SessionSource[]
  projectEncoded?: string
  sessionId?: string
  candidateChunkIds?: string[]
  externalSignals?: Record<string, SearchExternalSignals>
}

export interface SearchStats {
  sessionCount: number
  chunkCount: number
  tokenCount: number
  trigramCount: number
}

export interface SearchBackendResponse {
  backend: 'client' | 'sqlite'
  results: SearchResult[]
  stats: SearchStats
}

export interface SemanticSearchContext {
  normalizedQuery: string
  queryTokens: string[]
  queryTrigrams: string[]
}

export interface SemanticSearchProvider {
  name: string
  expandQuery?(context: SemanticSearchContext): string[]
  score(chunk: SearchChunkRecord, context: SemanticSearchContext): number
}

export type SemanticSearchProviderFactory = (chunks: SearchChunkRecord[]) => SemanticSearchProvider
