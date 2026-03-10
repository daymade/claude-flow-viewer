import type {
  DecisionMarker,
  EmbeddedImage,
  PromptIndexEntry,
  SessionData,
  SessionMessage,
  SessionMeta,
  SessionThreadKind,
} from '../types/session'
import { detectDecision } from './decision-detector'
import { computeHeatmap } from './heatmap'

export const CODEX_PROJECT_PREFIX = 'codex:'
// Codex session_meta is the first JSONL line. We only need a small head window
// for scan-time grouping and thread metadata, not the full bootstrap payload.
export const CODEX_PREVIEW_BYTES = 16 * 1024

export interface CodexQuickScanResult {
  cwd: string
  projectEncoded: string
  meta: SessionMeta
}

function extractCodexSessionMetaPayload(head: string): Record<string, unknown> | null {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      if (record.type !== 'session_meta') continue
      const payload = record.payload
      if (payload && typeof payload === 'object') {
        return payload as Record<string, unknown>
      }
    } catch {
      break
    }
  }
  return null
}

interface CodexSessionHeadMeta {
  cwd: string
  startTime: Date | null
  threadKind: SessionThreadKind
  parentSessionId?: string
  agentName?: string
  agentRole?: string
}

function extractCodexHeadField(head: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = head.match(new RegExp(`"${escaped}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 's'))
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

function parseTimestamp(value: unknown): Date | null {
  if (!value) return null
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function extractTimestamp(record: Record<string, unknown>): Date | null {
  const direct = parseTimestamp(record.timestamp)
  if (direct) return direct

  const payload = record.payload
  if (payload && typeof payload === 'object') {
    const payloadTs = parseTimestamp((payload as Record<string, unknown>).timestamp)
    if (payloadTs) return payloadTs
  }

  return null
}

function extractThreadMeta(payload: Record<string, unknown>): Pick<SessionMeta, 'threadKind' | 'parentSessionId' | 'agentName' | 'agentRole'> {
  const source = payload.source
  const sourceRecord = source && typeof source === 'object' ? source as Record<string, unknown> : undefined
  const subagent = sourceRecord?.subagent
  const subagentRecord = subagent && typeof subagent === 'object' ? subagent as Record<string, unknown> : undefined
  const spawn = subagentRecord?.thread_spawn
  const spawnRecord = spawn && typeof spawn === 'object' ? spawn as Record<string, unknown> : undefined

  const parentSessionId =
    (typeof spawnRecord?.parent_thread_id === 'string' ? spawnRecord.parent_thread_id as string : undefined)
    ?? (typeof payload.forked_from_id === 'string' ? payload.forked_from_id as string : undefined)

  const agentName =
    (typeof payload.agent_nickname === 'string' ? payload.agent_nickname as string : undefined)
    ?? (typeof spawnRecord?.agent_nickname === 'string' ? spawnRecord.agent_nickname as string : undefined)

  const agentRole =
    (typeof payload.agent_role === 'string' ? payload.agent_role as string : undefined)
    ?? (typeof spawnRecord?.agent_role === 'string' ? spawnRecord.agent_role as string : undefined)

  return {
    threadKind: parentSessionId || subagentRecord ? 'subagent' : 'primary',
    parentSessionId,
    agentName,
    agentRole,
  }
}

function extractCodexSessionHeadMeta(record: Record<string, unknown>): CodexSessionHeadMeta | null {
  if (record.type !== 'session_meta') return null
  const payload = record.payload
  if (!payload || typeof payload !== 'object') return null

  const payloadRecord = payload as Record<string, unknown>
  const cwd = typeof payloadRecord.cwd === 'string' ? payloadRecord.cwd : ''
  if (!cwd) return null

  const source = payloadRecord.source
  const sourceRecord = source && typeof source === 'object' ? source as Record<string, unknown> : undefined
  const subagent = sourceRecord?.subagent
  const subagentRecord = subagent && typeof subagent === 'object' ? subagent as Record<string, unknown> : undefined
  const threadSpawn = subagentRecord?.thread_spawn
  const spawnRecord = threadSpawn && typeof threadSpawn === 'object' ? threadSpawn as Record<string, unknown> : undefined

  const parentFromSpawn = typeof spawnRecord?.parent_thread_id === 'string' ? spawnRecord.parent_thread_id : undefined
  const parentFromFork = typeof payloadRecord.forked_from_id === 'string' ? payloadRecord.forked_from_id : undefined
  const parentSessionId = parentFromSpawn ?? parentFromFork

  return {
    cwd,
    startTime: parseTimestamp(payloadRecord.timestamp) ?? extractTimestamp(record),
    threadKind: parentSessionId ? 'subagent' : 'primary',
    parentSessionId,
    agentName: typeof payloadRecord.agent_nickname === 'string' ? payloadRecord.agent_nickname : undefined,
    agentRole: typeof payloadRecord.agent_role === 'string' ? payloadRecord.agent_role : undefined,
  }
}

function formatDateTime(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${min}`
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function sanitizePreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100)
}

function isCodexBootstrapText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('# CLAUDE.md')
    || trimmed.startsWith('# AGENTS.md')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.startsWith('<turn_aborted>')
}

function extractDelegationUpdate(text: string): Extract<SessionMessage, { kind: 'delegation-update' }> | null {
  const trimmed = text.trim()
  const match = trimmed.match(/^<subagent_notification>([\s\S]+)<\/subagent_notification>$/)
  if (!match) return null

  try {
    const payload = JSON.parse(match[1]) as Record<string, unknown>
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : 'delegated-work'
    const statusRecord = payload.status && typeof payload.status === 'object'
      ? payload.status as Record<string, unknown>
      : undefined

    let status: Extract<SessionMessage, { kind: 'delegation-update' }>['status'] = 'update'
    let summary = ''

    if (statusRecord) {
      if (typeof statusRecord.completed === 'string') {
        status = 'completed'
        summary = statusRecord.completed
      } else if (typeof statusRecord.failed === 'string') {
        status = 'failed'
        summary = statusRecord.failed
      } else if (typeof statusRecord.started === 'string') {
        status = 'started'
        summary = statusRecord.started
      } else if (typeof statusRecord.running === 'string') {
        status = 'running'
        summary = statusRecord.running
      } else {
        const firstStatusEntry = Object.entries(statusRecord).find(([, value]) => typeof value === 'string')
        if (firstStatusEntry) {
          const [statusKey, statusValue] = firstStatusEntry
          if (statusKey === 'completed') status = 'completed'
          else if (statusKey === 'failed') status = 'failed'
          else if (statusKey === 'started') status = 'started'
          else if (statusKey === 'running') status = 'running'
          summary = statusValue as string
        }
      }
    }

    if (!summary && typeof payload.message === 'string') {
      summary = payload.message
    }

    return {
      kind: 'delegation-update',
      agentId,
      status,
      timestamp: '',
      summary: sanitizePreview(summary || `${agentId} sent an update`),
    }
  } catch {
    return {
      kind: 'delegation-update',
      agentId: 'delegated-work',
      status: 'update',
      timestamp: '',
      summary: 'Delegated work reported an update',
    }
  }
}

function parseContentParts(content: unknown): { text: string; images: EmbeddedImage[] } {
  if (!Array.isArray(content)) return { text: '', images: [] }

  const parts: string[] = []
  const images: EmbeddedImage[] = []

  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const part = item as Record<string, unknown>
    const type = String(part.type || '')

    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      parts.push(String(part.text || ''))
      continue
    }

    if (type.includes('image')) {
      const dataUrl =
        typeof part.image_url === 'string' ? part.image_url
          : typeof part.url === 'string' ? part.url
            : typeof part.data === 'string' && String(part.data).startsWith('data:') ? String(part.data)
              : null

      if (dataUrl && dataUrl.startsWith('data:')) {
        const mediaTypeMatch = dataUrl.match(/^data:([^;]+);/)
        images.push({
          mediaType: mediaTypeMatch?.[1] || 'image/png',
          dataUrl,
        })
      } else {
        parts.push('[Image]')
      }
    }
  }

  return { text: parts.join('\n').trim(), images }
}

function extractPromptFromMessage(record: Record<string, unknown>): { text: string; images: EmbeddedImage[] } | null {
  if (record.type !== 'response_item') return null
  const payload = record.payload
  if (!payload || typeof payload !== 'object') return null
  const item = payload as Record<string, unknown>
  if (item.type !== 'message' || item.role !== 'user') return null

  const { text, images } = parseContentParts(item.content)
  if (!text || isCodexBootstrapText(text)) return null
  return { text, images }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { raw }
  } catch {
    return { raw }
  }
}

function extractSessionIdFromFilename(fileName: string): string {
  const match = fileName.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)
  if (match) return match[1]
  return fileName.replace(/\.jsonl$/i, '')
}

function filenameOf(pathValue: string): string {
  const parts = pathValue.split('/').filter(Boolean)
  return parts[parts.length - 1] || pathValue
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const lower = name.toLowerCase()
  switch (lower) {
    case 'exec_command':
    case 'shell_command':
    case 'bash':
      return `$ ${String(input.cmd || input.command || input.description || '').slice(0, 80)}`
    case 'apply_patch':
      return 'Apply patch'
    case 'update_plan':
      return 'Update plan'
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return name
    case 'read_mcp_resource':
      return `Read resource ${String(input.uri || '').slice(0, 60)}`
    case 'open':
    case 'read':
      return `Read ${filenameOf(String(input.path || input.file_path || input.ref_id || ''))}`
    case 'spawn_agent':
      return `Agent: ${String(input.message || input.prompt || '').slice(0, 60)}`
    case 'web_search':
    case 'web_search_call':
      return `Search ${String(input.query || input.q || '').slice(0, 60)}`
    default:
      return `${name}${Object.keys(input).length > 0 ? ` ${String(input.description || input.subject || '').slice(0, 60)}` : ''}`.trim()
  }
}

function unwrapToolOutput(raw: unknown): { content: string; isError: boolean } {
  if (typeof raw !== 'string') {
    return { content: String(raw ?? ''), isError: false }
  }

  let content = raw
  let isError = false

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.output === 'string') content = obj.output
      const metadata = obj.metadata
      if (metadata && typeof metadata === 'object') {
        const exitCode = (metadata as Record<string, unknown>).exit_code
        if (typeof exitCode === 'number' && exitCode !== 0) isError = true
      }
      if (typeof obj.error === 'string' && obj.error) {
        content = `${obj.error}\n${content}`.trim()
        isError = true
      }
    }
  } catch {
    // Raw plain text output is valid.
  }

  if (/aborted by user/i.test(content) || /^error[:\s]/i.test(content)) {
    isError = true
  }

  const display = content.slice(0, 500) + (content.length > 500 ? `... (${content.length} chars)` : '')
  return { content: display, isError }
}

function extractReasoningText(payload: Record<string, unknown>): string {
  const summary = payload.summary
  if (Array.isArray(summary)) {
    const parts = summary
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(item => String(item.text || ''))
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }

  if (typeof payload.content === 'string' && payload.content.trim()) {
    return payload.content
  }

  return payload.encrypted_content ? '[Encrypted reasoning]' : ''
}

function decidePrompt(text: string, promptNum: number, pendingInterrupt: boolean): DecisionMarker {
  const detected = detectDecision(text, promptNum)
  return pendingInterrupt && detected === 'none' ? 'interrupt' : detected
}

export function makeCodexProjectId(cwd: string): string {
  return `${CODEX_PROJECT_PREFIX}${cwd}`
}

export function isCodexProjectId(projectEncoded: string): boolean {
  return projectEncoded.startsWith(CODEX_PROJECT_PREFIX)
}

export function isCodexSessionContent(content: string): boolean {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const type = record.type
      return type === 'session_meta'
        || type === 'response_item'
        || type === 'event_msg'
        || type === 'turn_context'
    } catch {
      continue
    }
  }
  return false
}

export function extractCodexShortName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  const last = parts[parts.length - 1] || cwd
  if (last.length >= 3) return last
  const parent = parts[parts.length - 2]
  return parent ? `${parent}/${last}` : last
}

export function extractCodexSessionId(fileName: string): string {
  return extractSessionIdFromFilename(fileName)
}

export function quickScanCodexMetadata(
  head: string,
  sessionId: string,
  fileSize: number,
  threadName?: string,
): CodexQuickScanResult | null {
  const payload = extractCodexSessionMetaPayload(head)
  let startTime = parseTimestamp(payload?.timestamp) ?? parseTimestamp(extractCodexHeadField(head, 'timestamp'))
  let cwd = typeof payload?.cwd === 'string' ? payload.cwd : extractCodexHeadField(head, 'cwd') || ''
  let firstPromptPreview = threadName ? sanitizePreview(threadName) : ''
  const threadMeta = payload ? extractThreadMeta(payload) : {
    threadKind: 'primary' as const,
    parentSessionId: undefined,
    agentName: undefined,
    agentRole: undefined,
  }

  for (const line of head.split('\n')) {
    if (!line.trim()) continue

    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }

    if (!startTime) {
      startTime = extractTimestamp(record)
    }

    if (record.type === 'session_meta') {
      const sessionMeta = extractCodexSessionHeadMeta(record)
      if (sessionMeta) {
        if (!cwd) cwd = sessionMeta.cwd
        startTime = startTime ?? sessionMeta.startTime
      }
    }

    if (!firstPromptPreview) {
      const prompt = extractPromptFromMessage(record)
      if (prompt) firstPromptPreview = sanitizePreview(prompt.text)
    }

    if (startTime && cwd && firstPromptPreview) break
  }

  if (!startTime) {
    const payloadTimestamp = extractCodexHeadField(head, 'timestamp')
    startTime = parseTimestamp(payloadTimestamp)
  }

  if (!startTime || !cwd) return null

  if (!firstPromptPreview) {
    firstPromptPreview = sanitizePreview(extractCodexShortName(cwd))
  }

  return {
    cwd,
    projectEncoded: makeCodexProjectId(cwd),
    meta: {
      source: 'codex',
      id: sessionId,
      startTime: startTime.toISOString(),
      startDisplay: formatDateTime(startTime),
      threadKind: threadMeta.threadKind,
      parentSessionId: threadMeta.parentSessionId,
      agentName: threadMeta.agentName,
      agentRole: threadMeta.agentRole,
      promptCount: 0,
      toolCount: 0,
      firstPromptPreview,
      fileSize,
      recordCount: 0,
    },
  }
}

export function parseCodexSessionContent(content: string): SessionData {
  const messages: SessionMessage[] = []
  const prompts: PromptIndexEntry[] = []
  const records: Record<string, unknown>[] = []

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      continue
    }
  }

  let promptCounter = 0
  let pendingInterrupt = false

  for (const record of records) {
    const timestamp = formatTime(extractTimestamp(record) || new Date())

    if (record.type === 'event_msg') {
      const payload = record.payload
      if (!payload || typeof payload !== 'object') continue
      const event = payload as Record<string, unknown>
      switch (event.type) {
        case 'task_started':
          messages.push({
            kind: 'task-event',
            taskId: typeof event.turn_id === 'string' ? event.turn_id : '?',
            status: 'started',
            summary: 'Task started',
            timestamp,
          })
          break
        case 'task_complete':
          messages.push({
            kind: 'task-event',
            taskId: typeof event.turn_id === 'string' ? event.turn_id : '?',
            status: 'completed',
            summary: sanitizePreview(String(event.last_agent_message || 'Task completed')),
            timestamp,
          })
          break
        case 'turn_aborted':
          pendingInterrupt = true
          break
        case 'thread_rolled_back':
          messages.push({
            kind: 'rollback-marker',
            timestamp,
            numTurns: typeof event.num_turns === 'number' ? event.num_turns : 1,
          })
          break
        case 'context_compacted':
          messages.push({
            kind: 'compact-boundary',
            timestamp,
            trigger: 'auto',
            preTokens: 0,
            summaryText: '',
          })
          break
      }
      continue
    }

    if (record.type !== 'response_item') continue
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue
    const item = payload as Record<string, unknown>

    switch (item.type) {
      case 'message': {
        const role = String(item.role || '')
        if (role === 'assistant') {
          const { text } = parseContentParts(item.content)
          if (text) messages.push({ kind: 'ai-text', text, timestamp })
        } else if (role === 'user') {
          const { text } = parseContentParts(item.content)
          const delegationUpdate = text ? extractDelegationUpdate(text) : null
          if (delegationUpdate) {
            messages.push({
              ...delegationUpdate,
              timestamp,
            })
            break
          }

          const prompt = extractPromptFromMessage(record)
          if (prompt) {
            promptCounter++
            const decision = decidePrompt(prompt.text, promptCounter, pendingInterrupt)
            pendingInterrupt = false
            messages.push({
              kind: 'user-prompt',
              promptNum: promptCounter,
              text: prompt.text,
              images: prompt.images,
              time: timestamp,
              decision,
            })
            prompts.push({
              num: promptCounter,
              preview: sanitizePreview(prompt.text),
              fullText: prompt.text,
              time: timestamp,
              decision,
            })
          }
        }
        break
      }
      case 'reasoning': {
        const reasoning = extractReasoningText(item)
        if (!reasoning) break
        messages.push({
          kind: 'ai-thinking',
          preview: sanitizePreview(reasoning).slice(0, 120),
          full: reasoning.slice(0, 3000) + (reasoning.length > 3000 ? `\n... (${reasoning.length} chars total)` : ''),
          timestamp,
        })
        break
      }
      case 'function_call': {
        const input = parseJsonObject(item.arguments)
        messages.push({
          kind: 'ai-tool-use',
          summary: summarizeToolCall(String(item.name || 'unknown'), input),
          name: String(item.name || 'unknown'),
          input,
          timestamp,
        })
        break
      }
      case 'custom_tool_call': {
        const input = typeof item.input === 'string'
          ? { raw: item.input }
          : item.input && typeof item.input === 'object'
            ? item.input as Record<string, unknown>
            : {}
        messages.push({
          kind: 'ai-tool-use',
          summary: summarizeToolCall(String(item.name || 'custom_tool'), input),
          name: String(item.name || 'custom_tool'),
          input,
          timestamp,
        })
        break
      }
      case 'web_search_call': {
        const input: Record<string, unknown> = {}
        if (typeof item.query === 'string') input.query = item.query
        if (typeof item.arguments === 'string') Object.assign(input, parseJsonObject(item.arguments))
        messages.push({
          kind: 'ai-tool-use',
          summary: summarizeToolCall('web_search_call', input),
          name: 'web_search_call',
          input,
          timestamp,
        })
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const result = unwrapToolOutput(item.output)
        messages.push({
          kind: 'tool-result',
          content: result.content,
          isError: result.isError,
          timestamp,
        })
        break
      }
    }
  }

  const markers = { compacts: 0, plans: 0, clears: 0, forks: 0 }
  for (const msg of messages) {
    if (msg.kind === 'compact-boundary') markers.compacts++
    else if (msg.kind === 'rollback-marker') markers.forks++
  }

  return {
    source: 'codex',
    messages,
    prompts,
    heatmap: computeHeatmap(messages),
    markers,
  }
}
