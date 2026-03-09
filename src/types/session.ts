export type DecisionMarker = 'none' | 'interrupt' | 'correction'

export interface EmbeddedImage {
  mediaType: string
  dataUrl: string
}

export type SessionMessage =
  | { kind: 'user-prompt'; promptNum: number; text: string; images: EmbeddedImage[]; time: string; decision: DecisionMarker }
  | { kind: 'tool-result'; content: string; isError: boolean; externalFile?: string; totalSize?: string }
  | { kind: 'ai-text'; text: string }
  | { kind: 'ai-thinking'; preview: string; full: string }
  | { kind: 'ai-tool-use'; summary: string; name: string; input: Record<string, unknown> }
  | { kind: 'team-message'; from: string; color: string; summary: string; content: string; isProtocol: boolean }
  | { kind: 'task-event'; taskId: string; status: string; summary: string }
  | { kind: 'fork-indicator'; abandonedMessages: SessionMessage[]; abandonedPreview: string; timestamp: string; reason: 'user-decision' | 'tool-error' }
  | { kind: 'clear-divider'; timestamp: string }
  | { kind: 'compact-boundary'; timestamp: string; trigger: 'auto' | 'manual'; preTokens: number; summaryText: string }
  | { kind: 'plan-start'; timestamp: string }
  | { kind: 'plan-end'; timestamp: string; planPreview: string }

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
  decision: DecisionMarker
}

export interface SessionMarkers {
  compacts: number
  plans: number
  clears: number
  forks: number
}

export interface SessionMeta {
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
  /** Special marker counts — available after scan (approximate) or full parse (exact) */
  markers?: SessionMarkers
}

export interface ProjectMeta {
  encodedName: string
  decodedName: string
  shortName: string
  sessions: SessionMeta[]
  totalSessionCount: number
}

export interface SessionData {
  messages: SessionMessage[]
  prompts: PromptIndexEntry[]
  heatmap: number[]
  markers: SessionMarkers
}

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
