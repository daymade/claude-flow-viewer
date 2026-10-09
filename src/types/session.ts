export type DecisionMarker = 'none' | 'interrupt' | 'correction'
export type SessionSource = 'claude' | 'codex' | 'cherrystudio'
export type SessionThreadKind = 'primary' | 'subagent'
export type UserInputOrigin = 'direct' | 'queued' | 'compacted'

export interface EmbeddedImage {
  mediaType: string
  dataUrl: string
}

export type SessionMessage = { sourceRecordId?: string; sourceRecord?: Record<string,unknown> } & (
  | { kind: 'user-prompt'; promptNum: number; text: string; images: EmbeddedImage[]; time: string; timestamp?: string; decision: DecisionMarker; queued?: boolean; dupCount?: number }
  | { kind: 'tool-result'; content: string; isError: boolean; externalFile?: string; totalSize?: string; timestamp?: string; toolUseId?: string }
  | { kind: 'ai-text'; text: string; timestamp?: string }
  | { kind: 'ai-thinking'; preview: string; full: string; timestamp?: string }
  | { kind: 'ai-tool-use'; summary: string; name: string; input: Record<string, unknown>; timestamp?: string; toolUseId?: string }
  | { kind: 'delegation-update'; timestamp: string; agentId: string; status: 'started' | 'running' | 'completed' | 'failed' | 'update'; summary: string }
  | { kind: 'team-message'; from: string; color: string; summary: string; content: string; isProtocol: boolean }
  | { kind: 'task-event'; taskId: string; status: string; summary: string; timestamp?: string }
  | { kind: 'fork-indicator'; abandonedMessages: SessionMessage[]; abandonedPreview: string; timestamp: string; reason: 'user-decision' | 'tool-error' }
  | { kind: 'rollback-marker'; timestamp: string; numTurns: number }
  | { kind: 'clear-divider'; timestamp: string }
  | { kind: 'compact-boundary'; timestamp: string; trigger: 'auto' | 'manual'; preTokens: number; summaryText: string }
  | { kind: 'plan-start'; timestamp: string }
  | { kind: 'plan-end'; timestamp: string; planPreview: string }
)

export interface TimelineEvent {
  kind: 'prompt' | 'compact' | 'clear' | 'fork' | 'plan-start' | 'plan-end'
  promptNum?: number
  time: string
  timestampMs: number
  preview: string
  decision?: DecisionMarker
}

export interface PromptIndexEntry {
  num: number
  preview: string
  fullText: string
  time: string
  timestamp?: string
  decision: DecisionMarker
}

/**
 * User input retained only inside a Codex compaction replacement history.
 * Codex preserves the exact text and order but not the original per-message timestamp,
 * so callers must display the honest session-start -> compaction time window.
 */
export interface RetainedUserInput {
  id: string
  text: string
  decision: DecisionMarker
  origin: 'compacted'
  timeRangeStart: string
  timeRangeEnd: string
  sortTimestamp: string
  ordinal: number
}

export interface SessionMarkers {
  compacts: number
  plans: number
  clears: number
  forks: number
}

export interface SessionMeta {
  source: SessionSource
  id: string
  startTime: string
  startDisplay: string
  promptCount: number
  toolCount: number
  firstPromptPreview: string
  /** File size in bytes */
  fileSize: number
  /** Total JSONL record count */
  recordCount: number
  /** Provider-specific thread hierarchy metadata */
  threadKind?: SessionThreadKind
  parentSessionId?: string
  agentName?: string
  agentRole?: string
  /** Special marker counts — available after scan (approximate) or full parse (exact) */
  markers?: SessionMarkers
}

export interface ProjectMeta {
  source: SessionSource
  encodedName: string
  decodedName: string
  shortName: string
  sessions: SessionMeta[]
  totalSessionCount: number
}

/**
 * A session located by identifier alone (the "known-item" resolve lane), independent of
 * whether it appears in any scanned project list. Shared SSOT for the backend resolve
 * endpoint, the FileStore.resolveSession implementations, the search controller, and routing.
 */
export interface ResolvedSessionRef {
  source: SessionSource
  projectEncoded: string
  sessionId: string
  /** Populated so callers can upsert it into the project list (required for AppShell to render it properly) */
  meta?: SessionMeta
}

/**
 * A minimal SessionMeta for a located session whose head-scan yielded no metadata (huge sessions,
 * or ones led by meta/command records). Shared SSOT so the server plugin, the browser stores, and
 * the reducer all synthesize the same shape. `mtimeMs` (file mtime) is used as a best-effort
 * startTime so the session sorts by recency instead of sinking to the bottom of an empty-startTime.
 */
export function createMinimalSessionMeta(source: SessionSource, sessionId: string, fileSize = 0, mtimeMs = 0): SessionMeta {
  const iso = mtimeMs ? new Date(mtimeMs).toISOString() : ''
  return {
    source,
    id: sessionId,
    startTime: iso,
    startDisplay: iso ? iso.slice(0, 16).replace('T', ' ') : '',
    promptCount: 0,
    toolCount: 0,
    firstPromptPreview: '',
    fileSize,
    recordCount: 0,
  }
}

export interface SessionData {
  source: SessionSource
  messages: SessionMessage[]
  prompts: PromptIndexEntry[]
  retainedUserInputs?: RetainedUserInput[]
  heatmap: number[]
  markers: SessionMarkers
}

export type ServerParsedSessionEnvelope = {__serverParsed:true;data:SessionData}

export interface FilterState {
  thinking: boolean
  toolCalls: boolean
  toolResults: boolean
  aiText: boolean
  team: boolean
  branches: boolean
  markers: boolean
  timeline: boolean
}
