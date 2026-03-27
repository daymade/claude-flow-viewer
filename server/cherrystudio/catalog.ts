import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'

import type { SessionMeta } from '../../src/types/session'
import {
  collectText,
  extractCherryStudioShortName,
  makeCherryStudioProjectId,
  sanitizeCherryStudioText,
} from '../../src/lib/providers/cherrystudio'

const DEFAULT_SESSION_LIMIT = 50
const CHERRY_TOPIC_SESSION_PREFIX = 'topic:'
const REGULAR_SESSIONS_CACHE_TTL_MS = 30_000

type RegularSessionsCacheEntry = {
  sessions: CherryStudioIndexedSession[]
  timestamp: number
}

const regularSessionsCache = new Map<string, RegularSessionsCacheEntry>()

type CherryAgentRow = {
  id: string
  name: string
  type: string
}

type CherrySessionRow = {
  id: string
  agent_id: string
  agent_type: string
  name: string
  description: string | null
  model: string | null
  created_at: string
  updated_at: string
}

type CherryMessageRow = {
  id: number
  role: string
  content: string
  metadata: string | null
  created_at: string
  updated_at: string
}

type CherryRegularMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  topicId: string
  assistantId: string
  createdAt: string
  status: string
  blockIds: string[]
  askId?: string
}

type CherryRegularBlock = {
  id: string
  messageId: string
  type: string
  createdAt: string
  status: string
  content: string
}

type CherrySerializedMessage = {
  id: string | number
  role: string
  content: unknown
  metadata?: string | null
  createdAt: string
  updatedAt: string
}

type CherrySerializedBlock = {
  id: string
  type: string
  content: string
}

type CherryPreviewCandidate = {
  text: string
  role: string
  kind: 'main_text' | 'fallback' | 'thinking' | 'plain'
}

function cherryHomeDir(homeDir: string): string {
  return path.join(homeDir, '.cherrystudio')
}

function cherryConfigPath(homeDir: string): string {
  return path.join(cherryHomeDir(homeDir), 'config', 'config.json')
}

function defaultMacUserDataDirs(homeDir: string): string[] {
  return [
    path.join(homeDir, 'Library', 'Application Support', 'CherryStudio'),
    path.join(homeDir, 'Library', 'Application Support', 'CherryStudioDev'),
  ]
}

function inferHomeDir(homeDir?: string): string {
  return homeDir || os.homedir()
}

export interface CherryStudioIndexedSession {
  source: 'cherrystudio'
  projectEncoded: string
  projectLabel: string
  projectShortName: string
  sessionId: string
  filePath: string
  fileSize: number
  fileMtimeMs: number
  fingerprint: string
  meta: SessionMeta
  loadContent(): Promise<string>
}

function makeCherryTopicSessionId(topicId: string): string {
  return `${CHERRY_TOPIC_SESSION_PREFIX}${topicId}`
}

function parseTimestamp(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateTime(value: string): string {
  const date = parseTimestamp(value)
  if (!date) return value
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${min}`
}

function normalizePreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 99)}…`
}

function readableCherryTitle(value: string): string {
  const normalized = normalizePreview(sanitizeCherryStudioText(value))
  if (!normalized) return ''
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) return ''
  return normalized
}

function isUsableRecoveredText(value: string): boolean {
  const normalized = sanitizeCherryStudioText(value)
  if (!normalized) return false
  const tokens = normalized.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const shortTokenRatio = tokens.filter((token) => token.length <= 2).length / tokens.length
  const symbolRatio = (normalized.match(/[^\p{L}\p{N}\s.,!?，。！？:'"()\-_*`/]/gu)?.length ?? 0) / normalized.length
  if (symbolRatio > 0.25) return false
  if (tokens.length >= 6 && shortTokenRatio > 0.6) return false
  return true
}

function extractMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).blocks)) {
      const blocks = (parsed as Record<string, unknown>).blocks as Array<Record<string, unknown>>
      const mainText = blocks
        .filter((block) => block.type === 'main_text' && typeof block.content === 'string')
        .map((block) => String(block.content).trim())
        .filter(Boolean)
        .join('\n')
      if (mainText) return mainText
    }
    return collectText(parsed).join('\n').trim()
  } catch {
    return content
  }
}

function structuredContentBlocks(content: unknown): CherrySerializedBlock[] {
  if (!content || typeof content !== 'object') return []
  const record = content as Record<string, unknown>
  if (!Array.isArray(record.blocks)) return []
  return record.blocks.filter((block): block is CherrySerializedBlock => {
    if (!block || typeof block !== 'object') return false
    const candidate = block as Record<string, unknown>
    return typeof candidate.id === 'string'
      && typeof candidate.type === 'string'
      && typeof candidate.content === 'string'
  })
}

function hasStructuredContent(content: unknown): boolean {
  return structuredContentBlocks(content).some((block) => isUsableRecoveredText(block.content))
}


function listIndexedDbFiles(userDataDir: string): string[] {
  const root = path.join(userDataDir, 'IndexedDB')
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  const walk = (dirPath: string) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
        continue
      }
      if (/\.(log|ldb|sst)$/i.test(entry.name)) {
        files.push(entryPath)
      }
    }
  }
  walk(root)
  return files
}

function extractPrintableTokens(buffer: Buffer): string[] {
  const tokens: string[] = []
  let current = ''
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte)
      continue
    }
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function extractGuid(value: string | undefined): string | null {
  if (!value) return null
  return value.match(GUID_RE)?.[0] ?? null
}

function isControlToken(token: string): boolean {
  return token === 'CherryStudio'
    || token === 'content'
    || token === 'content"'
    || token.startsWith('id"$')
    || token.startsWith('messageId"$')
    || token.startsWith('role"')
    || token.startsWith('topicId"$')
    || token.startsWith('assistantId')
    || token.startsWith('createdAt"')
    || token.startsWith('updatedAt"')
    || token.startsWith('status"')
    || token.startsWith('type"')
    || token.startsWith('blocksA')
    || token.startsWith('blocksa')
    || token.startsWith('askId"$')
    || token.startsWith('knowledgeBaseIds')
    || token.startsWith('citationReferences')
    || token.startsWith('metadata_')
    || token.startsWith('model')
    || token.startsWith('provider')
    || token.startsWith('group')
    || token.startsWith('usage')
    || token.startsWith('traceId')
    || token.startsWith('thinking_millsec')
    || token.startsWith('error_')
    || token.startsWith('erroro"')
    || token.startsWith('name"')
    || token.startsWith('message"')
    || token.startsWith('stack"')
    || token.startsWith('cause"')
    || token === 'url'
    || token.startsWith('url"')
    || token.startsWith('messages')
    || token.startsWith('prompt_tokens')
    || token.startsWith('completion_tokens')
    || token.startsWith('total_tokens')
}

function nextValue(tokens: string[], label: string): string | undefined {
  const index = tokens.findIndex((token) => token === label)
  if (index < 0) return undefined
  return tokens[index + 1]?.replace(/"+$/g, '')
}

function nextGuids(tokens: string[], labels: string[]): string[] {
  const ids: string[] = []
  const start = tokens.findIndex((token) => labels.includes(token))
  if (start < 0) return ids
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (isControlToken(token) && index > start + 1) break
    const guid = extractGuid(token)
    if (guid) ids.push(guid)
  }
  return ids
}

function isCharacterLikeToken(token: string): boolean {
  return token.length === 1 || /^\s+$/u.test(token)
}

function decodeContentTokens(tokens: string[]): string {
  const filtered = tokens.filter((token) => token && token !== '"')
  if (filtered.length === 0) return ''

  if (filtered.every((token) => isCharacterLikeToken(token))) {
    return filtered.join('')
  }

  const [first, ...rest] = filtered
  if (first && first.length <= 3 && rest.every((token) => isCharacterLikeToken(token))) {
    const normalizedFirst = first.replace(/^"+|"+$/g, '')
    if (!normalizedFirst) return rest.join('')
    if (rest.length === 0) return normalizedFirst
    if (normalizedFirst.length === 1 && !/\d/u.test(normalizedFirst)) {
      return rest.join('')
    }
    if (/^[\p{L}\p{N}]+$/u.test(normalizedFirst)) {
      if (/^c[\p{Lu}]/u.test(normalizedFirst)) {
        const trailing = normalizedFirst.match(/[\p{L}\p{N}]$/u)?.[0] ?? ''
        return `${trailing}${rest.join('')}`
      }
      return `${normalizedFirst}${rest.join('')}`
    }

    const trailing = normalizedFirst.match(/[\p{L}\p{N}]$/u)?.[0]
      ?? normalizedFirst.replace(/^[^\p{L}\p{N}]+/u, '')
    if (!trailing) return rest.join('')
    return `${trailing}${rest.join('')}`
  }

  const joined = filtered.join(' ').replace(/\s+/g, ' ').trim()
  return joined.replace(/^[^\p{L}\p{N}]+/u, '')
}

function normalizeInlineTokenPrefix(value: string): string {
  const normalized = value.replace(/^"+|"+$/g, '')
  if (normalized === 'c') return ''
  if (/^c(?=[\p{Lu}`])/u.test(normalized)) return normalized.slice(1)
  if (/^[A-Za-z](?=[A-Z][a-z])/u.test(normalized)) {
    return normalized.slice(1)
  }
  return normalized
}

function nextLabeledText(tokens: string[], labels: string[]): string {
  const start = tokens.findIndex((token) => labels.some((label) => token === label || token.startsWith(label)))
  if (start < 0) return ''

  const startToken = tokens[start]
  const label = labels.find((candidate) => tokens[start] === candidate || tokens[start].startsWith(candidate))
  const inlineSeed = label ? normalizeInlineTokenPrefix(tokens[start].slice(label.length)) : ''
  const collected: string[] = []
  if (inlineSeed) collected.push(inlineSeed)

  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === 'CherryStudio') break
    if (isControlToken(token) && collected.length > 0) break
    collected.push(token)
  }

  if (
    label === 'content'
    && startToken === 'content'
    && collected[0] === 'c'
    && collected[1]
    && !isControlToken(collected[1])
  ) {
    collected.shift()
  }

  return sanitizeCherryStudioText(decodeContentTokens(collected))
}

function nextContent(tokens: string[]): string {
  return nextLabeledText(tokens, ['content"', 'content'])
}

function recordWindow(tokens: string[], startIndex: number, maxSpan = 240): string[] {
  const window: string[] = []
  for (let index = startIndex; index < tokens.length && index < startIndex + maxSpan; index += 1) {
    if (index > startIndex && tokens[index].startsWith('id"$')) break
    window.push(tokens[index])
  }
  return window
}

function statusRank(status: string): number {
  if (status === 'success') return 4
  if (status === 'streaming') return 3
  if (status === 'processing') return 2
  if (status === 'pending') return 1
  return 0
}

function isNewerString(left: string, right: string): boolean {
  return left.localeCompare(right) > 0
}

function extractRegularIndexedDbState(userDataDir: string): {
  messages: Map<string, CherryRegularMessage>
  blocks: Map<string, CherryRegularBlock>
} {
  const messages = new Map<string, CherryRegularMessage>()
  const blocks = new Map<string, CherryRegularBlock>()

  for (const filePath of listIndexedDbFiles(userDataDir)) {
    const tokens = extractPrintableTokens(fs.readFileSync(filePath))
    for (let index = 0; index < tokens.length; index += 1) {
      if (!tokens[index].startsWith('id"$')) continue
      const chunk = recordWindow(tokens, index)
      const id = extractGuid(chunk[0])
      if (!id) continue

      const role = nextValue(chunk, 'role"')
      const topicId = extractGuid(chunk.find((token) => token.startsWith('topicId"$')))
      const messageId = extractGuid(chunk.find((token) => token.startsWith('messageId"$')))

      if (role && topicId) {
        const nextMessage: CherryRegularMessage = {
          id,
          role: role as CherryRegularMessage['role'],
          topicId,
          assistantId: nextValue(chunk, 'assistantId"') || nextValue(chunk, 'assistantId"$') || 'default',
          createdAt: nextValue(chunk, 'createdAt"') || new Date(0).toISOString(),
          status: nextValue(chunk, 'status"') || 'unknown',
          blockIds: nextGuids(chunk, ['blocksA', 'blocksa']),
          askId: extractGuid(chunk.find((token) => token.startsWith('askId"$'))) ?? undefined,
        }
        const current = messages.get(nextMessage.id)
        if (!current || statusRank(nextMessage.status) >= statusRank(current.status) || isNewerString(nextMessage.createdAt, current.createdAt)) {
          messages.set(nextMessage.id, nextMessage)
        }
        continue
      }

      if (messageId) {
        const blockType = nextValue(chunk, 'type"') || 'unknown'
        const nextBlock: CherryRegularBlock = {
          id,
          messageId,
          type: blockType,
          createdAt: nextValue(chunk, 'createdAt"') || new Date(0).toISOString(),
          status: nextValue(chunk, 'status"') || 'unknown',
          content: blockType === 'error'
            ? nextLabeledText(chunk, ['message"', 'content"', 'content'])
            : nextContent(chunk),
        }
        const current = blocks.get(nextBlock.id)
        if (
          !current
          || statusRank(nextBlock.status) >= statusRank(current.status)
          || (nextBlock.content.length > current.content.length && nextBlock.status === current.status)
        ) {
          blocks.set(nextBlock.id, nextBlock)
        }
      }
    }
  }

  return { messages, blocks }
}

function blocksByMessageId(blocks: Map<string, CherryRegularBlock>): Map<string, CherryRegularBlock[]> {
  const grouped = new Map<string, CherryRegularBlock[]>()
  for (const block of blocks.values()) {
    const current = grouped.get(block.messageId)
    if (current) current.push(block)
    else grouped.set(block.messageId, [block])
  }
  for (const [, list] of grouped) {
    list.sort((left, right) => {
      const created = left.createdAt.localeCompare(right.createdAt)
      if (created !== 0) return created
      return statusRank(right.status) - statusRank(left.status)
    })
  }
  return grouped
}

function buildRegularSerializedContent(
  userDataDir: string,
  topicId: string,
  title: string,
  assistantId: string,
  messages: CherrySerializedMessage[],
  createdAt: string,
  updatedAt: string,
): string {
  return JSON.stringify({
    source: 'cherrystudio',
    userDataPath: userDataDir,
    session: {
      id: makeCherryTopicSessionId(topicId),
      name: title,
      description: null,
      agentId: assistantId,
      agentName: assistantId,
      agentType: 'topic',
      model: null,
      createdAt,
      updatedAt,
      messages,
    },
  })
}

function buildRegularSerializedMessageContent(
  message: CherryRegularMessage,
  relatedBlocks: CherryRegularBlock[],
): unknown {
  const readableBlocks = relatedBlocks
    .map((block) => ({
      id: block.id,
      type: block.type,
      content: sanitizeCherryStudioText(block.content),
    }))
    .filter((block) => isUsableRecoveredText(block.content))

  if (readableBlocks.length === 0) return ''

  if (message.role === 'assistant') {
    const orderedBlocks = [
      ...readableBlocks.filter((block) => block.type === 'main_text'),
      ...readableBlocks.filter((block) => block.type !== 'main_text' && block.type !== 'thinking'),
      ...readableBlocks.filter((block) => block.type === 'thinking'),
    ]

    return {
      blocks: orderedBlocks,
    }
  }

  const promptBlocks = readableBlocks.filter((block) => block.type === 'main_text')
  const blocks = promptBlocks.length > 0
    ? promptBlocks
    : readableBlocks.filter((block) => block.type !== 'thinking')

  if (blocks.length === 0) return ''

  return {
    blocks: blocks.map((block) => ({
      ...block,
      type: 'main_text',
    })),
  }
}

function previewCandidateForMessage(
  message: CherrySerializedMessage,
  includeThinking = false,
): CherryPreviewCandidate | null {
  if (typeof message.content === 'string') {
    const text = isUsableRecoveredText(message.content)
      ? sanitizeCherryStudioText(message.content)
      : ''
    return text
      ? {
          text,
          role: message.role,
          kind: 'plain',
        }
      : null
  }

  const blocks = structuredContentBlocks(message.content)
  const mainText = blocks
    .filter((block) => block.type === 'main_text' && isUsableRecoveredText(block.content))
    .map((block) => sanitizeCherryStudioText(block.content))
    .find(Boolean)
  if (mainText) {
    return {
      text: mainText,
      role: message.role,
      kind: 'main_text',
    }
  }

  const fallback = blocks
    .filter((block) => block.type !== 'main_text' && block.type !== 'thinking' && isUsableRecoveredText(block.content))
    .map((block) => sanitizeCherryStudioText(block.content))
    .find(Boolean)
  if (fallback) {
    return {
      text: fallback,
      role: message.role,
      kind: 'fallback',
    }
  }

  if (!includeThinking) return null

  const thinking = blocks
    .filter((block) => block.type === 'thinking' && isUsableRecoveredText(block.content))
    .map((block) => sanitizeCherryStudioText(block.content))
    .find(Boolean)
  if (!thinking) return null

  return {
    text: thinking,
    role: message.role,
    kind: 'thinking',
  }
}

function isWeakOpeningPreview(text: string): boolean {
  const normalized = sanitizeCherryStudioText(text).toLowerCase()
  if (!normalized) return true
  const collapsed = normalized.replace(/[\s.!?,]+/g, '')
  if (/^(hi|hello|hey|yo|sup|ok|okay)+$/i.test(collapsed)) return true

  const tokens = normalized.split(/\s+/).filter(Boolean)
  return tokens.length <= 2 && normalized.length <= 12
}

function isRichPreviewText(text: string): boolean {
  const normalized = sanitizeCherryStudioText(text)
  if (!normalized) return false
  const tokens = normalized.split(/\s+/).filter(Boolean)
  return normalized.length >= 32 || tokens.length >= 6
}

function selectTopicPreviewAndTitle(messages: CherrySerializedMessage[]): {
  preview: string
  title: string
} {
  const directCandidates = messages
    .map((message) => previewCandidateForMessage(message))
    .filter((candidate): candidate is CherryPreviewCandidate => candidate !== null)
  const readableDirect = directCandidates.filter((candidate) => readableCherryTitle(candidate.text))
  const userTurnCount = messages.filter((message) => message.role === 'user').length
  const openingCandidate = directCandidates[0]
  const richerLaterAssistantMainText = [...readableDirect]
    .reverse()
    .find((candidate) => candidate.role === 'assistant' && candidate.kind === 'main_text' && isRichPreviewText(candidate.text))
  const preferredDirect = (
    userTurnCount > 1
    && openingCandidate
    && isWeakOpeningPreview(openingCandidate.text)
    && richerLaterAssistantMainText
  )
    ? richerLaterAssistantMainText
    : readableDirect.find((candidate) => candidate.kind === 'main_text' || candidate.kind === 'plain')
      || readableDirect[0]

  const thinkingCandidates = messages
    .map((message) => previewCandidateForMessage(message, true))
    .filter((candidate): candidate is CherryPreviewCandidate => candidate !== null)
  const readableThinking = thinkingCandidates.find((candidate) => readableCherryTitle(candidate.text))

  const previewCandidate = preferredDirect?.text
    || directCandidates[0]?.text
    || readableThinking?.text
    || thinkingCandidates[0]?.text
    || 'Cherry Studio chat'

  return {
    preview: normalizePreview(previewCandidate),
    title: readableCherryTitle(preferredDirect?.text || previewCandidate) || 'Cherry Studio chat',
  }
}

function listCherryStudioRegularSessions(userDataDir: string): CherryStudioIndexedSession[] {
  const indexedDbRoot = path.join(userDataDir, 'IndexedDB')
  if (!fs.existsSync(indexedDbRoot)) return []

  const { messages, blocks } = extractRegularIndexedDbState(userDataDir)
  const groupedBlocks = blocksByMessageId(blocks)
  const byTopic = new Map<string, CherryRegularMessage[]>()

  for (const message of messages.values()) {
    if (!byTopic.has(message.topicId)) byTopic.set(message.topicId, [])
    byTopic.get(message.topicId)!.push(message)
  }

  const indexedDbFiles = listIndexedDbFiles(userDataDir)
  const fingerprintBase = indexedDbFiles.map((filePath) => {
    const stat = fs.statSync(filePath)
    return `${path.basename(filePath)}:${stat.mtimeMs}:${stat.size}`
  }).join('|')
  const latestStat = indexedDbFiles
    .map((filePath) => fs.statSync(filePath))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]

  const projectEncoded = makeCherryStudioProjectId(userDataDir)
  const projectShortName = extractCherryStudioShortName()

  return [...byTopic.entries()]
    .map(([topicId, topicMessages]) => {
      const orderedMessages = [...topicMessages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      const serializedMessages: CherrySerializedMessage[] = orderedMessages.map((message) => {
        const relatedBlocks = (groupedBlocks.get(message.id) ?? message.blockIds
          .map((blockId) => blocks.get(blockId))
          .filter((block): block is CherryRegularBlock => Boolean(block)))
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

        return {
          id: message.id,
          role: message.role,
          content: buildRegularSerializedMessageContent(message, relatedBlocks),
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        }
      })

      const cleanedMessages = serializedMessages.filter((message) => {
        if (typeof message.content === 'string') {
          return isUsableRecoveredText(message.content)
        }
        return hasStructuredContent(message.content)
      })

      const { preview, title } = selectTopicPreviewAndTitle(cleanedMessages)
      const createdAt = orderedMessages[0]?.createdAt || new Date(0).toISOString()
      const updatedAt = orderedMessages[orderedMessages.length - 1]?.createdAt || createdAt
      const promptCount = cleanedMessages.filter((message) => message.role === 'user').length

      return {
        source: 'cherrystudio' as const,
        projectEncoded,
        projectLabel: userDataDir,
        projectShortName,
        sessionId: makeCherryTopicSessionId(topicId),
        filePath: indexedDbRoot,
        fileSize: latestStat?.size ?? 0,
        fileMtimeMs: latestStat?.mtimeMs ?? 0,
        fingerprint: `${fingerprintBase}:${topicId}`,
        meta: {
          source: 'cherrystudio' as const,
          id: makeCherryTopicSessionId(topicId),
          startTime: createdAt,
          startDisplay: formatDateTime(createdAt),
          promptCount,
          toolCount: 0,
          firstPromptPreview: preview,
          fileSize: latestStat?.size ?? 0,
          recordCount: cleanedMessages.length,
          agentName: orderedMessages[0]?.assistantId,
          agentRole: 'topic',
        },
        loadContent: async () => buildRegularSerializedContent(
          userDataDir,
          topicId,
          title,
          orderedMessages[0]?.assistantId || 'default',
          cleanedMessages,
          createdAt,
          updatedAt,
        ),
      }
    })
    .filter((session) => session.meta.recordCount > 0)
    .sort((left, right) => right.meta.startTime.localeCompare(left.meta.startTime))
    .slice(0, DEFAULT_SESSION_LIMIT)
}

function readConfiguredUserDataPath(homeDir?: string): string | null {
  const configPath = cherryConfigPath(inferHomeDir(homeDir))
  if (!fs.existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    return typeof parsed.appDataPath === 'string' && parsed.appDataPath.trim() ? parsed.appDataPath : null
  } catch {
    return null
  }
}

export function resolveCherryStudioUserDataDir(homeDir?: string): string | null {
  const resolvedHomeDir = inferHomeDir(homeDir)
  const configured = readConfiguredUserDataPath(resolvedHomeDir)
  if (configured && fs.existsSync(configured)) {
    return configured
  }

  for (const candidate of defaultMacUserDataDirs(resolvedHomeDir)) {
    if (!fs.existsSync(candidate)) continue
    if (fs.existsSync(path.join(candidate, 'Data', 'agents.db'))) return candidate
    if (fs.existsSync(path.join(candidate, 'Local Storage', 'leveldb'))) return candidate
    if (fs.existsSync(path.join(candidate, 'IndexedDB'))) return candidate
  }
  return null
}

function openAgentsDb(userDataDir: string): { db: Database.Database; dbPath: string; stat: fs.Stats } | null {
  const dbPath = path.join(userDataDir, 'Data', 'agents.db')
  if (!fs.existsSync(dbPath)) return null
  const stat = fs.statSync(dbPath)
  return {
    db: new Database(dbPath, { readonly: true }),
    dbPath,
    stat,
  }
}

function queryAgents(db: Database.Database): Map<string, CherryAgentRow> {
  const rows = db.prepare('SELECT id, name, type FROM agents').all() as CherryAgentRow[]
  return new Map(rows.map((row) => [row.id, row]))
}

function querySessionRows(db: Database.Database): CherrySessionRow[] {
  return db.prepare(`
    SELECT id, agent_id, agent_type, name, description, model, created_at, updated_at
    FROM sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(DEFAULT_SESSION_LIMIT) as CherrySessionRow[]
}

function queryMessages(db: Database.Database, sessionId: string): CherryMessageRow[] {
  return db.prepare(`
    SELECT id, role, content, metadata, created_at, updated_at
    FROM session_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sessionId) as CherryMessageRow[]
}

function buildSerializedContent(
  userDataDir: string,
  session: CherrySessionRow,
  agent: CherryAgentRow | undefined,
  messages: CherryMessageRow[],
): string {
  return JSON.stringify({
    source: 'cherrystudio',
    userDataPath: userDataDir,
    session: {
      id: session.id,
      name: session.name,
      description: session.description,
      agentId: session.agent_id,
      agentName: agent?.name ?? null,
      agentType: agent?.type ?? session.agent_type,
      model: session.model,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: (() => {
          try {
            return JSON.parse(message.content)
          } catch {
            return message.content
          }
        })(),
        metadata: message.metadata,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
      })),
    },
  })
}

function listCherryStudioAgentSessions(userDataDir: string): CherryStudioIndexedSession[] {
  const opened = openAgentsDb(userDataDir)
  if (!opened) return []

  const { db, dbPath, stat } = opened
  try {
    const agents = queryAgents(db)
    const sessions = querySessionRows(db)
    const projectEncoded = makeCherryStudioProjectId(userDataDir)
    const projectShortName = extractCherryStudioShortName()

    return sessions.map((session) => {
      const messages = queryMessages(db, session.id)
      const agent = agents.get(session.agent_id)
      const firstUserPrompt = messages.find((message) => message.role === 'user')
      const preview = firstUserPrompt
        ? normalizePreview(extractMessageText(firstUserPrompt.content))
        : normalizePreview(session.name || agent?.name || session.id)
      const promptCount = messages.filter((message) => message.role === 'user').length
      const toolCount = messages.filter((message) => message.role === 'tool').length
      const serialized = buildSerializedContent(userDataDir, session, agent, messages)

      return {
        source: 'cherrystudio',
        projectEncoded,
        projectLabel: userDataDir,
        projectShortName,
        sessionId: session.id,
        filePath: dbPath,
        fileSize: stat.size,
        fileMtimeMs: stat.mtimeMs,
        fingerprint: `${stat.mtimeMs}:${stat.size}:${session.updated_at}`,
        meta: {
          source: 'cherrystudio',
          id: session.id,
          startTime: session.created_at,
          startDisplay: formatDateTime(session.created_at),
          promptCount,
          toolCount,
          firstPromptPreview: preview,
          fileSize: stat.size,
          recordCount: messages.length,
          agentName: agent?.name,
          agentRole: session.agent_type || agent?.type,
        },
        loadContent: async () => serialized,
      }
    })
  } finally {
    db.close()
  }
}

function getCachedRegularSessions(userDataDir: string): CherryStudioIndexedSession[] {
  const cached = regularSessionsCache.get(userDataDir)
  if (cached && Date.now() - cached.timestamp < REGULAR_SESSIONS_CACHE_TTL_MS) {
    return cached.sessions
  }
  const sessions = listCherryStudioRegularSessions(userDataDir)
  regularSessionsCache.set(userDataDir, { sessions, timestamp: Date.now() })
  return sessions
}

export async function listCherryStudioIndexedSessions(options: { homeDir?: string } = {}): Promise<CherryStudioIndexedSession[]> {
  const userDataDir = resolveCherryStudioUserDataDir(options.homeDir)
  if (!userDataDir) return []

  const agentSessions = listCherryStudioAgentSessions(userDataDir)
  const regularSessions = getCachedRegularSessions(userDataDir)
  return [...agentSessions, ...regularSessions]
}

export async function readCherryStudioSessionContent(sessionId: string, options: { homeDir?: string } = {}): Promise<string> {
  const userDataDir = resolveCherryStudioUserDataDir(options.homeDir)
  if (!userDataDir) {
    throw new Error('Cherry Studio user data directory not found.')
  }

  if (sessionId.startsWith(CHERRY_TOPIC_SESSION_PREFIX)) {
    const regularSessions = getCachedRegularSessions(userDataDir)
    const session = regularSessions.find((entry) => entry.sessionId === sessionId)
    if (!session) {
      throw new Error(`Cherry Studio regular chat not found: ${sessionId}`)
    }
    return session.loadContent()
  }

  const opened = openAgentsDb(userDataDir)
  if (!opened) {
    throw new Error('Cherry Studio agents.db not found.')
  }

  const { db } = opened
  try {
    const session = db.prepare(`
      SELECT id, agent_id, agent_type, name, description, model, created_at, updated_at
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as CherrySessionRow | undefined

    if (!session) {
      throw new Error(`Cherry Studio session not found: ${sessionId}`)
    }

    const agent = db.prepare('SELECT id, name, type FROM agents WHERE id = ? LIMIT 1').get(session.agent_id) as CherryAgentRow | undefined
    const messages = queryMessages(db, session.id)
    return buildSerializedContent(userDataDir, session, agent, messages)
  } finally {
    db.close()
  }
}
