import type {
  DecisionMarker,
  EmbeddedImage,
  PromptIndexEntry,
  SessionData,
  SessionMessage,
} from '../../types/session'
import { detectDecision } from '../decision-detector'
import { computeHeatmap } from '../heatmap'

export const CHERRY_STUDIO_PROJECT_PREFIX = 'cherrystudio:'

interface CherryStudioSerializedMessage {
  id?: number
  role: string
  content: unknown
  metadata?: string | null
  createdAt?: string
  updatedAt?: string
}

interface CherryStudioStructuredBlock {
  id?: string
  type?: string
  content?: string
  toolName?: string
}

interface CherryStudioSerializedSession {
  id: string
  name: string
  description?: string | null
  agentId?: string | null
  agentName?: string | null
  agentType?: string | null
  model?: string | null
  createdAt: string
  updatedAt: string
  messages: CherryStudioSerializedMessage[]
}

interface CherryStudioSerializedPayload {
  source: 'cherrystudio'
  userDataPath: string
  session: CherryStudioSerializedSession
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function sanitizeCherryStudioText(value: string): string {
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/([.!?])\s*=\s+(?=\S)/gu, '$1 ')
    .trim()
  const withoutSyntheticPrefix = normalized.replace(/^c(?=[A-Z][a-z])/u, '')
  const strippedTail = withoutSyntheticPrefix.replace(/\s*[=]+\s*$/g, '').trim()
  if (!strippedTail) return ''
  const quoteCount = [...strippedTail].filter((char) => char === '"').length
  if (
    quoteCount === 1
    && strippedTail.endsWith('"')
    && !strippedTail.startsWith('"')
  ) {
    return strippedTail.slice(0, -1).trimEnd()
  }
  return strippedTail
}

function previewText(value: string, limit = 100): string {
  const normalized = normalizeText(sanitizeCherryStudioText(value))
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

export function collectText(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const directText: string[] = []
    for (const key of ['text', 'content', 'message', 'output', 'input', 'reasoning']) {
      if (key in record) directText.push(...collectText(record[key]))
    }
    if (directText.length > 0) return directText
    return Object.values(record).flatMap((item) => collectText(item))
  }
  return []
}

function collectImages(value: unknown): EmbeddedImage[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectImages(item))
  }
  if (typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  const nested = Object.values(record).flatMap((item) => collectImages(item))
  const candidates = [
    typeof record.url === 'string' ? record.url : null,
    typeof record.image_url === 'string' ? record.image_url : null,
    typeof record.data === 'string' ? record.data : null,
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.startsWith('data:'))

  const direct = candidates.map((dataUrl) => ({
    mediaType: dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/png',
    dataUrl,
  }))

  return [...direct, ...nested]
}

function structuredBlocks(value: unknown): CherryStudioStructuredBlock[] | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.blocks)) return null
  return record.blocks as CherryStudioStructuredBlock[]
}

function structuredBlockText(blocks: CherryStudioStructuredBlock[], type: string): string {
  return blocks
    .filter((block) => block.type === type && typeof block.content === 'string' && block.content.trim())
    .map((block) => sanitizeCherryStudioText(block.content!))
    .filter(Boolean)
    .join('\n\n')
}

function structuredFallbackText(blocks: CherryStudioStructuredBlock[]): string {
  return blocks
    .filter((block) => block.type !== 'main_text' && block.type !== 'thinking' && typeof block.content === 'string' && block.content.trim())
    .map((block) => sanitizeCherryStudioText(block.content!))
    .filter(Boolean)
    .join('\n\n')
}

export function makeCherryStudioProjectId(userDataPath: string): string {
  return `${CHERRY_STUDIO_PROJECT_PREFIX}${userDataPath}`
}

export function isCherryStudioProjectId(projectEncoded: string): boolean {
  return projectEncoded.startsWith(CHERRY_STUDIO_PROJECT_PREFIX)
}

export function extractCherryStudioShortName(): string {
  return 'Cherry Studio'
}

export function isCherryStudioSessionContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return parsed.source === 'cherrystudio' && typeof parsed.session === 'object'
  } catch {
    return false
  }
}

function parsePayload(content: string): CherryStudioSerializedPayload {
  const parsed = JSON.parse(content) as CherryStudioSerializedPayload
  if (parsed.source !== 'cherrystudio' || !parsed.session) {
    throw new Error('Invalid Cherry Studio session payload')
  }
  return parsed
}

function toPromptText(message: CherryStudioSerializedMessage): { text: string; images: EmbeddedImage[] } {
  const blocks = structuredBlocks(message.content)
  if (blocks) {
    const mainText = structuredBlockText(blocks, 'main_text')
    return {
      text: mainText || structuredFallbackText(blocks),
      images: collectImages(message.content),
    }
  }

  const text = collectText(message.content).join('\n').trim()
  return {
    text: sanitizeCherryStudioText(text),
    images: collectImages(message.content),
  }
}

function messageTimestamp(message: CherryStudioSerializedMessage, fallback: string): string {
  return message.createdAt || message.updatedAt || fallback
}

function parseAssistantMessage(message: CherryStudioSerializedMessage, timestamp: string): SessionMessage[] {
  const blocks = structuredBlocks(message.content)
  if (blocks) {
    const mainText = structuredBlockText(blocks, 'main_text')
    const thinking = structuredBlockText(blocks, 'thinking')
    const fallbackText = structuredFallbackText(blocks)
    const nodes: SessionMessage[] = []
    if (mainText) {
      nodes.push({
        kind: 'ai-text',
        text: mainText,
        timestamp,
      })
    } else if (fallbackText) {
      nodes.push({
        kind: 'ai-text',
        text: fallbackText,
        timestamp,
      })
    } else if (thinking) {
      nodes.push({
        kind: 'ai-thinking',
        preview: previewText(thinking, 120),
        full: thinking,
        timestamp,
      })
    }
    return nodes
  }

  const text = sanitizeCherryStudioText(collectText(message.content).join('\n').trim())
  const metadataText = typeof message.metadata === 'string'
    ? sanitizeCherryStudioText(message.metadata)
    : ''

  if (!text && !metadataText) return []

  return [{
    kind: 'ai-text',
    text: [text, metadataText].filter(Boolean).join('\n\n'),
    timestamp,
  }]
}

function parseToolMessage(message: CherryStudioSerializedMessage, timestamp: string): SessionMessage[] {
  const blocks = structuredBlocks(message.content)
  if (blocks) {
    const toolResults = blocks
      .filter((block) => block.type === 'tool')
      .map((block) => ({
        kind: 'tool-result' as const,
        content: [block.toolName, block.content].filter(Boolean).join('\n'),
        isError: false,
        timestamp,
      }))
      .filter((block) => block.content.trim())
    if (toolResults.length > 0) return toolResults
  }

  const text = sanitizeCherryStudioText(collectText(message.content).join('\n').trim())
  const summary = text || (typeof message.metadata === 'string' ? sanitizeCherryStudioText(message.metadata) : '')
  if (!summary) return []

  return [{
    kind: 'tool-result',
    content: summary,
    isError: false,
    timestamp,
  }]
}

export function parseCherryStudioSessionContent(content: string): SessionData {
  const payload = parsePayload(content)
  const prompts: PromptIndexEntry[] = []
  const messages: SessionMessage[] = []
  let promptNum = 0

  for (const message of payload.session.messages) {
    const timestamp = messageTimestamp(message, payload.session.updatedAt)

    if (message.role === 'user') {
      const { text, images } = toPromptText(message)
      if (!text) continue
      promptNum += 1
      const decision: DecisionMarker = detectDecision(text, promptNum)
      prompts.push({
        num: promptNum,
        preview: previewText(text),
        fullText: text,
        time: formatTime(timestamp),
        decision,
      })
      messages.push({
        kind: 'user-prompt',
        promptNum,
        text,
        images,
        time: formatTime(timestamp),
        decision,
      })
      continue
    }

    if (message.role === 'tool') {
      messages.push(...parseToolMessage(message, timestamp))
      continue
    }

    messages.push(...parseAssistantMessage(message, timestamp))
  }

  const markers = {
    compacts: 0,
    plans: 0,
    clears: 0,
    forks: 0,
  }

  return {
    source: 'cherrystudio',
    messages,
    prompts,
    heatmap: computeHeatmap(messages),
    markers,
  }
}
