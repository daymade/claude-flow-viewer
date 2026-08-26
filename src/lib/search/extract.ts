import type { SessionMessage } from '../../types/session'
import type { SearchChunkKind, SearchChunkLocator, SearchChunkRecord, SearchSessionRecord } from './types'

const WORD_RE = /[\p{L}\p{N}]+/gu

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text)
  if (!normalized) return []

  const words = normalized.match(WORD_RE) ?? []
  return Array.from(new Set(words.filter((word) => word.length > 1)))
}

export function buildSearchTrigrams(text: string): string[] {
  const normalized = normalizeSearchText(text).replace(/\s+/g, ' ')
  if (normalized.length < 3) {
    return normalized ? [normalized] : []
  }

  const grams = new Set<string>()
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    const gram = normalized.slice(index, index + 3)
    if (gram.includes('\n')) continue
    grams.add(gram)
  }
  return [...grams]
}

function toTitle(kind: SearchChunkKind): string {
  switch (kind) {
    case 'metadata': return 'Session metadata'
    case 'prompt': return 'User prompt'
    case 'ai-text': return 'AI response'
    case 'thinking': return 'AI thinking'
    case 'tool-call': return 'Tool call'
    case 'tool-result': return 'Tool result'
    case 'team-message': return 'Team message'
    case 'delegation-update': return 'Delegation update'
    case 'task-event': return 'Task event'
  }
}

function createChunk(
  session: SearchSessionRecord,
  kind: SearchChunkKind,
  text: string,
  locator: SearchChunkLocator,
  searchTags: string[] = [],
): SearchChunkRecord | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const normalizedText = normalizeSearchText(trimmed)
  if (!normalizedText) return null

  return {
    id: `${session.projectEncoded}:${session.meta.id}:${locator.messageIndex}:${kind}`,
    projectEncoded: session.projectEncoded,
    projectLabel: session.projectLabel,
    projectShortName: session.projectShortName ?? session.projectLabel,
    sessionId: session.meta.id,
    source: session.meta.source,
    sessionStartTime: session.meta.startTime,
    kind,
    title: toTitle(kind),
    text: trimmed,
    normalizedText,
    tokens: tokenizeSearchText(trimmed),
    trigrams: buildSearchTrigrams(trimmed),
    locator,
    searchTags: searchTags.filter(Boolean),
  }
}

function messageTimestamp(message: SessionMessage): string | undefined {
  switch (message.kind) {
    case 'user-prompt': return message.timestamp ?? message.time
    case 'ai-text':
    case 'ai-thinking':
    case 'ai-tool-use':
    case 'tool-result':
    case 'task-event':
      return message.timestamp
    case 'delegation-update':
      return message.timestamp
    default:
      return undefined
  }
}

function toolCallText(message: Extract<SessionMessage, { kind: 'ai-tool-use' }>): string {
  const inputPairs = Object.entries(message.input)
    .map(([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')

  return [message.name, message.summary, inputPairs].filter(Boolean).join(' ')
}

function messageToChunk(
  session: SearchSessionRecord,
  message: SessionMessage,
  messageIndex: number,
): SearchChunkRecord | null {
  switch (message.kind) {
    case 'user-prompt':
      return createChunk(
        session,
        'prompt',
        message.text,
        {
          kind: 'prompt',
          messageIndex,
          promptNum: message.promptNum,
          timestamp: message.timestamp ?? message.time,
          origin: message.queued ? 'queued' : 'direct',
        },
        [
          ...message.images.map((image) => image.mediaType),
          `decision:${message.decision}`,
          `origin:${message.queued ? 'queued' : 'direct'}`,
        ],
      )
    case 'ai-text':
      return createChunk(session, 'ai-text', message.text, { kind: 'ai-text', messageIndex, timestamp: message.timestamp })
    case 'ai-thinking':
      return createChunk(session, 'thinking', `${message.preview}\n${message.full}`, { kind: 'thinking', messageIndex, timestamp: message.timestamp })
    case 'ai-tool-use':
      return createChunk(session, 'tool-call', toolCallText(message), {
        kind: 'tool-call',
        messageIndex,
        timestamp: message.timestamp,
      }, [message.name])
    case 'tool-result':
      return createChunk(session, 'tool-result', [message.content, message.externalFile, message.totalSize].filter(Boolean).join(' '), {
        kind: 'tool-result',
        messageIndex,
        timestamp: message.timestamp,
      }, [message.isError ? 'error' : 'success'])
    case 'team-message':
      return createChunk(session, 'team-message', [message.from, message.summary, message.content].filter(Boolean).join(' '), {
        kind: 'team-message',
        messageIndex,
        timestamp: messageTimestamp(message),
      }, [message.from])
    case 'delegation-update':
      return createChunk(session, 'delegation-update', [message.agentId, message.status, message.summary].filter(Boolean).join(' '), {
        kind: 'delegation-update',
        messageIndex,
        timestamp: message.timestamp,
      }, [message.agentId, message.status])
    case 'task-event':
      return createChunk(session, 'task-event', [message.taskId, message.status, message.summary].filter(Boolean).join(' '), {
        kind: 'task-event',
        messageIndex,
        timestamp: message.timestamp,
      }, [message.taskId, message.status])
    default:
      return null
  }
}

export function extractSearchChunks(session: SearchSessionRecord): SearchChunkRecord[] {
  const metadataText = [
    session.projectLabel,
    session.projectShortName,
    session.meta.firstPromptPreview,
    session.meta.startDisplay,
    session.meta.id,
    session.meta.agentName,
    session.meta.agentRole,
    session.meta.threadKind,
    session.meta.parentSessionId,
  ].filter(Boolean).join(' ')

  const chunks: SearchChunkRecord[] = []
  const metadataChunk = createChunk(
    session,
    'metadata',
    metadataText,
    { kind: 'metadata', messageIndex: -1, timestamp: session.meta.startDisplay },
    [session.meta.source, session.meta.agentRole ?? '', session.meta.agentName ?? ''],
  )

  if (metadataChunk) {
    chunks.push(metadataChunk)
  }

  session.data.messages.forEach((message, messageIndex) => {
    const chunk = messageToChunk(session, message, messageIndex)
    if (chunk) chunks.push(chunk)
  })

  session.data.retainedUserInputs?.forEach((input) => {
    const chunk = createChunk(
      session,
      'prompt',
      input.text,
      {
        kind: 'prompt',
        messageIndex: -(input.ordinal + 1),
        timestamp: input.sortTimestamp,
        origin: input.origin,
        timeRangeStart: input.timeRangeStart,
        timeRangeEnd: input.timeRangeEnd,
        ordinal: input.ordinal,
      },
      [`decision:${input.decision}`, 'origin:compacted'],
    )
    if (chunk) chunks.push(chunk)
  })

  return chunks
}
