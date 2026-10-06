import type {
  DecisionMarker,
  EmbeddedImage,
  PromptIndexEntry,
  RetainedUserInput,
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
/**
 * Codex moves older rollouts out of `sessions/` into this sibling directory. They are unique
 * history — nothing in sessions/ duplicates them — so every scanner must walk both.
 */
export const CODEX_ARCHIVED_SESSIONS_DIR = 'archived_sessions'

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

/**
 * Codex "teams" writes inter-agent traffic as `response_item` / `agent_message`, whose one
 * `input_text` part carries a fixed header before the body:
 *
 *   Message Type: FINAL_ANSWER
 *   Task name: /root
 *   Sender: /root/integration_conflict_audit
 *   Payload:
 *   <body>
 *
 * Only the body is content. Measured across real rollouts the split is total: every FINAL_ANSWER
 * carries a plain-text body (249/249 in September's 20 largest files, 298/298 in an August one),
 * and every MESSAGE / NEW_TASK carries none -- their payload sits in an `encrypted_content` part
 * this viewer cannot read. So the emit decision keys off the body, not the label: a body-bearing
 * record of any type becomes a message, an empty one is dropped rather than rendering hundreds of
 * empty envelopes into the reading surface.
 *
 * With no header at all the whole text is treated as the body, so an unrecognised future shape
 * degrades to showing everything rather than to showing nothing.
 */
function extractAgentMessageBody(text: string): string {
  const marker = '\nPayload:\n'
  const at = text.indexOf(marker)
  if (at === -1) return text.startsWith('Message Type:') ? '' : text.trim()
  return text.slice(at + marker.length).trim()
}

/** Stable per-agent colour, so one delegated agent keeps its identity across a session. */
function teamColorFor(name: string): string {
  const palette = ['green', 'blue', 'purple']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stringifyDisplayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isCodexBootstrapText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('# CLAUDE.md')
    || trimmed.startsWith('# AGENTS.md')
    || trimmed.startsWith('<skill>')
    || trimmed.startsWith('<skills_instructions>')
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
  if (typeof content === 'string') return { text: content.trim(), images: [] }

  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      const record = content as Record<string, unknown>
      if (typeof record.text === 'string') return { text: record.text.trim(), images: [] }
      if (Array.isArray(record.content)) return parseContentParts(record.content)
    }
    return { text: '', images: [] }
  }

  const parts: string[] = []
  const images: EmbeddedImage[] = []

  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
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

function extractPromptFromEvent(event: Record<string, unknown>): { text: string; images: EmbeddedImage[] } | null {
  if (event.type !== 'user_message') return null
  const textParts: string[] = []
  const messageText = typeof event.message === 'string' ? event.message.trim() : ''
  if (messageText) textParts.push(messageText)

  const textElements = event.text_elements
  if (!messageText && Array.isArray(textElements)) {
    for (const element of textElements) {
      const parsed = parseContentParts(element)
      if (parsed.text) textParts.push(parsed.text)
    }
  }

  const images: EmbeddedImage[] = []
  for (const key of ['images', 'local_images']) {
    const items = event[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (typeof item === 'string') {
        if (item.startsWith('data:')) {
          const mediaTypeMatch = item.match(/^data:([^;]+);/)
          images.push({ mediaType: mediaTypeMatch?.[1] || 'image/png', dataUrl: item })
        } else {
          textParts.push(`[Image: ${filenameOf(item)}]`)
        }
        continue
      }
      const parsed = parseContentParts(item)
      if (parsed.text) textParts.push(parsed.text)
      images.push(...parsed.images)
    }
  }

  const text = textParts.join('\n').trim()
  if (!text || isCodexBootstrapText(text)) return null
  return { text, images }
}

/**
 * A snapshot of "which prompt texts are still live elsewhere in the session" taken at the moment
 * of the most recent `compacted` record. `createCodexClassifier` rebuilds this incrementally as it
 * streams records instead of re-scanning a materialized `records[]` array a second time — see the
 * fold in `processRecord` below for why the snapshot's counts must be re-baselined per compaction
 * rather than accumulated once at the end.
 */
interface CompactionSnapshot {
  record: Record<string, unknown>
  index: number
  at: Date
  counts: Map<string, number>
}

/**
 * Builds the retained-input list from the LAST compaction's snapshot. This is the unchanged tail of
 * what used to be extractRetainedUserInputs's second full-array scan + history.forEach — only the
 * inputs changed (a precomputed snapshot instead of a fresh scan of `records[]`).
 */
function buildRetainedFromSnapshot(
  sessionStart: Date | null,
  snapshot: CompactionSnapshot | null,
): RetainedUserInput[] {
  if (!snapshot) return []
  const payload = snapshot.record.payload
  if (!payload || typeof payload !== 'object') return []
  const history = (payload as Record<string, unknown>).replacement_history
  if (!Array.isArray(history)) return []

  const rangeEnd = snapshot.at.toISOString()
  const rangeStart = (sessionStart ?? snapshot.at).toISOString()
  // Clone, don't alias: the consume-one dedup below mutates this map. Sharing snapshot.counts
  // directly would make a second finalize() call on the same classifier see already-decremented
  // counts and return a different (wrong) answer for the identical session.
  const directTextCounts = new Map(snapshot.counts)

  const retained: RetainedUserInput[] = []
  history.forEach((entry, ordinal) => {
    if (!entry || typeof entry !== 'object') return
    const item = entry as Record<string, unknown>
    if (item.role !== 'user') return
    const { text } = parseContentParts(item.content)
    if (!text || isCodexBootstrapText(text)) return

    const key = normalizePromptText(text)
    const directCount = directTextCounts.get(key) ?? 0
    if (directCount > 0) {
      directTextCounts.set(key, directCount - 1)
      return
    }

    retained.push({
      id: `compacted-${snapshot.index}-${ordinal}`,
      text,
      decision: detectDecision(text, ordinal + 1),
      origin: 'compacted',
      timeRangeStart: rangeStart,
      timeRangeEnd: rangeEnd,
      sortTimestamp: rangeEnd,
      ordinal,
    })
  })

  return retained
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
    case 'tool_search':
    case 'tool_search_call':
      return `Search tools ${String(input.query || '').slice(0, 60)}`
    default:
      return `${name}${Object.keys(input).length > 0 ? ` ${String(input.description || input.subject || '').slice(0, 60)}` : ''}`.trim()
  }
}

function unwrapToolOutput(raw: unknown): { content: string; isError: boolean } {
  if (typeof raw !== 'string') {
    const content = stringifyDisplayValue(raw)
    const display = content
    return { content: display, isError: false }
  }

  let content = raw
  let isError = false

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.output === 'string') content = obj.output
      else if ('output' in obj) content = stringifyDisplayValue(obj.output)
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

  const display = content
  return { content: display, isError }
}

function extractMcpResultContent(result: unknown): { content: string; isError: boolean } {
  if (!result || typeof result !== 'object') return unwrapToolOutput(result)
  const record = result as Record<string, unknown>
  if ('Err' in record) {
    return { content: stringifyDisplayValue(record.Err), isError: true }
  }

  const ok = record.Ok
  if (!ok || typeof ok !== 'object') return unwrapToolOutput(result)
  const okRecord = ok as Record<string, unknown>
  const okIsError = okRecord.isError === true || okRecord.is_error === true
  const content = okRecord.content
  if (!Array.isArray(content)) {
    const unwrapped = unwrapToolOutput(ok)
    return { ...unwrapped, isError: unwrapped.isError || okIsError }
  }

  const parts: string[] = []
  for (const item of content) {
    const parsed = parseContentParts([item])
    if (parsed.text) parts.push(parsed.text)
    if (!parsed.text && item && typeof item === 'object') parts.push(stringifyDisplayValue(item))
  }
  const unwrapped = unwrapToolOutput(parts.join('\n'))
  return { ...unwrapped, isError: unwrapped.isError || okIsError }
}

function extractToolSearchOutput(item: Record<string, unknown>): string {
  const tools = item.tools
  if (!Array.isArray(tools)) return stringifyDisplayValue(item)

  const names: string[] = []
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.name === 'string') names.push(record.name)
    const nested = record.tools
    if (Array.isArray(nested)) {
      for (const tool of nested) {
        if (tool && typeof tool === 'object' && typeof (tool as Record<string, unknown>).name === 'string') {
          names.push(`${record.name || 'tool'}.${String((tool as Record<string, unknown>).name)}`)
        }
      }
    }
  }

  const unique = [...new Set(names)]
  return unique.length > 0
    ? `Available tools:\n${unique.slice(0, 40).map((name) => `- ${name}`).join('\n')}${unique.length > 40 ? `\n... (${unique.length} tools total)` : ''}`
    : stringifyDisplayValue(item)
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

function scanCodexHeadStats(head: string): { promptCount: number; toolCount: number; recordCount: number } {
  let promptCount = 0
  let toolCount = 0
  let recordCount = 0
  const seenPrompts: Array<{ text: string; timestampMs: number }> = []
  const countPrompt = (prompt: { text: string }, timestampMs: number) => {
    const text = normalizePromptText(prompt.text)
    if (!text) return
    const isDuplicate = seenPrompts.some((seen) =>
      seen.text === text && Math.abs(seen.timestampMs - timestampMs) <= 1000
    )
    if (isDuplicate) return
    seenPrompts.push({ text, timestampMs })
    promptCount++
  }

  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    recordCount++

    if (record.type === 'event_msg') {
      const payload = record.payload
      if (payload && typeof payload === 'object') {
        const event = payload as Record<string, unknown>
        const prompt = extractPromptFromEvent(event)
        if (prompt) countPrompt(prompt, extractTimestamp(record)?.getTime() ?? recordCount)
        if (event.type === 'mcp_tool_call_end') toolCount++
      }
      continue
    }

    if (record.type !== 'response_item') continue
    const payload = record.payload
    if (!payload || typeof payload !== 'object') continue
    const item = payload as Record<string, unknown>
    const prompt = extractPromptFromMessage(record)
    if (prompt) countPrompt(prompt, extractTimestamp(record)?.getTime() ?? recordCount)
    if (
      item.type === 'function_call'
      || item.type === 'custom_tool_call'
      || item.type === 'web_search_call'
      || item.type === 'tool_search_call'
    ) {
      toolCount++
    }
  }

  return { promptCount, toolCount, recordCount }
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
  const headStats = scanCodexHeadStats(head)
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
      const prompt = record.type === 'event_msg' && record.payload && typeof record.payload === 'object'
        ? extractPromptFromEvent(record.payload as Record<string, unknown>)
        : extractPromptFromMessage(record)
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
      promptCount: headStats.promptCount,
      toolCount: headStats.toolCount,
      firstPromptPreview,
      fileSize,
      recordCount: headStats.recordCount,
    },
  }
}

/**
 * The per-record classification core, shared by the synchronous (`parseCodexSessionContent`) and
 * streaming (`parseCodexSessionContentStreaming`) entry points so the switch that turns a raw Codex
 * record into `SessionMessage`s is written exactly once. Everything that used to live in
 * `parseCodexSessionContent`'s own closure (prompt dedup state) plus the retained-input bookkeeping
 * that used to be `extractRetainedUserInputs`'s own second full-array scan now lives here instead,
 * folded into the same per-record pass — see the comment above `processRecord`'s retained-input
 * block for why that fold is safe.
 */
function createCodexClassifier() {
  const messages: SessionMessage[] = []
  const prompts: PromptIndexEntry[] = []
  let promptCounter = 0
  let pendingInterrupt = false
  const seenPrompts: Array<{ text: string; timestampMs: number }> = []
  const pushPrompt = (prompt: { text: string; images: EmbeddedImage[] }, timestampDate: Date) => {
    const textKey = normalizePromptText(prompt.text)
    if (!textKey) return false
    const timestampMs = timestampDate.getTime()
    const isDuplicate = seenPrompts.some((seen) =>
      seen.text === textKey && Math.abs(seen.timestampMs - timestampMs) <= 1000
    )
    if (isDuplicate) return false

    seenPrompts.push({ text: textKey, timestampMs })
    promptCounter++
    const decision = decidePrompt(prompt.text, promptCounter, pendingInterrupt)
    pendingInterrupt = false
    const timestamp = timestampDate.toISOString()
    messages.push({
      kind: 'user-prompt',
      promptNum: promptCounter,
      text: prompt.text,
      images: prompt.images,
      time: formatTime(timestampDate),
      timestamp,
      decision,
    })
    prompts.push({
      num: promptCounter,
      preview: sanitizePreview(prompt.text),
      fullText: prompt.text,
      time: formatTime(timestampDate),
      timestamp,
      decision,
    })
    return true
  }

  // One compaction can be written BOTH ways: a top-level `compacted` record and an `event_msg`
  // `context_compacted`. Both cases below emit a boundary, so a file that writes both double-counted
  // `markers.compacts` and rendered two dividers (measured: a 635MB rollout reported 584 for 292 real
  // compactions). Neither case can simply be deleted -- the formats are not consistent between files,
  // and a 829MB rollout writes only the top-level form, so dropping either would turn over-counting
  // into under-counting for whichever files use only the other one.
  //
  // The two records for one compaction are separated only by bookkeeping that emits nothing
  // (`world_state`, `turn_context`, `token_count` -- verified for all 292 pairs, zero unpaired), so
  // "the previous message is already a boundary" identifies the duplicate exactly, whichever form
  // came first. Two genuine compactions with no message at all between them would merge, which cannot
  // happen: a compaction is triggered by the context the messages in between built up.
  const pushCompactBoundary = (timestamp: string) => {
    if (messages[messages.length - 1]?.kind === 'compact-boundary') return
    messages.push({ kind: 'compact-boundary', timestamp, trigger: 'auto', preTokens: 0, summaryText: '' })
  }

  // Retained-input bookkeeping (was extractRetainedUserInputs's own two full-array scans over a
  // materialized records[]). Codex writes rollouts append-only during a live session, so record
  // timestamps are non-decreasing — verified directly against real oversized rollouts (zero
  // out-of-order violations across 124,685 records), not merely assumed. That lets liveDirectTextCounts
  // grow forward-only and lastCompactionSnapshot re-baseline from it at each `compacted` record,
  // so finalize() only ever needs the LAST compaction's snapshot, never a second pass over the file.
  let sessionStart: Date | null = null
  const liveDirectTextCounts = new Map<string, number>()
  let lastCompactionSnapshot: CompactionSnapshot | null = null
  let recordIndex = 0

  function processRecord(record: Record<string, unknown>): void {
    // Captured before any of the early returns below so every record advances the index exactly
    // once, matching extractRetainedUserInputs's original `for (let index = 0; ...)` position.
    // Placing the increment at the tail instead would miss it for most record types: the classify
    // switch below returns early for event_msg/compacted/non-response_item records, which is the
    // majority of records in a real session.
    const currentRecordIndex = recordIndex
    recordIndex += 1

    if (!sessionStart && record.type === 'session_meta') {
      const metaPayload = record.payload
      if (metaPayload && typeof metaPayload === 'object') {
        sessionStart = parseTimestamp((metaPayload as Record<string, unknown>).timestamp) ?? extractTimestamp(record)
      }
    }

    // extractTimestamp is pure, so computing it once here and reusing it below (as `timestampDate`'s
    // source) instead of calling it a second time inside the classify switch is not a behavior
    // change — just one fewer redundant parse per record.
    const recordAt = extractTimestamp(record)
    if (recordAt) {
      const eventPayload = record.type === 'event_msg' && record.payload && typeof record.payload === 'object'
        ? record.payload as Record<string, unknown>
        : null
      const retainedProbe = eventPayload ? extractPromptFromEvent(eventPayload) : extractPromptFromMessage(record)
      if (retainedProbe) {
        const key = normalizePromptText(retainedProbe.text)
        liveDirectTextCounts.set(key, (liveDirectTextCounts.get(key) ?? 0) + 1)
        // A record positioned after the last compaction line but sharing its exact timestamp still
        // satisfies extractRetainedUserInputs's original `at <= compaction.at` (inclusive) check —
        // keep feeding the frozen snapshot too, not just the live map.
        if (lastCompactionSnapshot && recordAt.getTime() <= lastCompactionSnapshot.at.getTime()) {
          lastCompactionSnapshot.counts.set(key, (lastCompactionSnapshot.counts.get(key) ?? 0) + 1)
        }
      }
    }
    if (record.type === 'compacted' && recordAt) {
      // Re-baseline from the live map: under non-decreasing timestamps, everything folded into the
      // live map up to this instant already satisfies `at <= recordAt` for THIS compaction.
      lastCompactionSnapshot = { record, index: currentRecordIndex, at: recordAt, counts: new Map(liveDirectTextCounts) }
    }

    // --- Below is the classify switch, moved verbatim from the old per-record loop body. Its 5
    // `continue` statements become `return` now that this runs once per record instead of once per
    // `for` iteration; none of the 5 sit inside a nested loop of their own, so the conversion is exact. ---
    const timestampDate = recordAt || new Date()
    const timestamp = formatTime(timestampDate)

    if (record.type === 'event_msg') {
      const payload = record.payload
      if (!payload || typeof payload !== 'object') return
      const event = payload as Record<string, unknown>
      switch (event.type) {
        case 'user_message': {
          const prompt = extractPromptFromEvent(event)
          if (!prompt) break
          pushPrompt(prompt, timestampDate)
          break
        }
        case 'agent_message': {
          const message = typeof event.message === 'string' ? event.message.trim() : ''
          if (message) messages.push({ kind: 'ai-text', text: message, timestamp })
          break
        }
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
          pushCompactBoundary(timestamp)
          break
        case 'mcp_tool_call_end': {
          const invocation = event.invocation && typeof event.invocation === 'object'
            ? event.invocation as Record<string, unknown>
            : {}
          const server = typeof invocation.server === 'string' ? invocation.server : 'mcp'
          const tool = typeof invocation.tool === 'string' ? invocation.tool : 'tool'
          const input = invocation.arguments && typeof invocation.arguments === 'object'
            ? invocation.arguments as Record<string, unknown>
            : {}
          messages.push({
            kind: 'ai-tool-use',
            summary: summarizeToolCall(`${server}.${tool}`, input),
            name: `${server}.${tool}`,
            input,
            timestamp,
          })
          const result = extractMcpResultContent(event.result)
          messages.push({
            kind: 'tool-result',
            content: result.content,
            isError: result.isError,
            timestamp,
          })
          break
        }

        // Deliberately dropped, recorded here so the question is not re-opened. Every one of the
        // 18,473 of these across this machine's history carries the same six fields
        // (type/event_id/occurred_at_ms/agent_thread_id/agent_path/kind) and no content: `started`
        // trails a spawn_agent tool call already rendered as ai-tool-use, `interrupted` trails
        // interrupt_agent. They are also broadcast — one event_id was found byte-identical in 13
        // separate session files — so surfacing them would duplicate delegation the reader already
        // sees. The format is retired besides: 819/1086 files in 2026/07, 202/3144 in 2026/08,
        // 0/199 in 2026/09, superseded by item_completed (whose content we already parse via
        // response_item). Delegation that IS content-bearing arrives as <subagent_notification>
        // and is parsed into delegation-update above.
        case 'sub_agent_activity':
          break
      }
      return
    }

    if (record.type === 'compacted') {
      pushCompactBoundary(timestamp)
      return
    }

    if (record.type !== 'response_item') return
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return
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
            pushPrompt(prompt, timestampDate)
          }
        }
        break
      }
      case 'agent_message': {
        // Codex teams: a delegated agent handing work back to the main thread. This is the same
        // event `delegation-update` describes, in the record shape that replaced the `event_msg`
        // form during August -- so without this case the conclusions delegated agents return are
        // dropped outright from every session written since.
        const parts = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
        const text = parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
        const body = text ? extractAgentMessageBody(text) : ''
        if (!body) break
        const author = typeof item.author === 'string' ? item.author : ''
        const from = author.split('/').filter(Boolean).pop() || 'delegated-agent'
        messages.push({
          kind: 'team-message',
          from,
          color: teamColorFor(from),
          summary: sanitizePreview(body),
          content: body,
          isProtocol: false,
        })
        break
      }
      case 'reasoning': {
        const reasoning = extractReasoningText(item)
        if (!reasoning) break
        messages.push({
          kind: 'ai-thinking',
          preview: sanitizePreview(reasoning).slice(0, 120),
          full: reasoning,
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
        if (item.action && typeof item.action === 'object') {
          const action = item.action as Record<string, unknown>
          if (typeof action.query === 'string') input.query = action.query
          if (Array.isArray(action.queries)) input.queries = action.queries
        }
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
      case 'tool_search_call': {
        const input = item.arguments && typeof item.arguments === 'object'
          ? item.arguments as Record<string, unknown>
          : parseJsonObject(item.arguments)
        messages.push({
          kind: 'ai-tool-use',
          summary: summarizeToolCall('tool_search_call', input),
          name: 'tool_search_call',
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
      case 'tool_search_output': {
        const result = unwrapToolOutput(extractToolSearchOutput(item))
        messages.push({
          kind: 'tool-result',
          content: result.content,
          isError: String(item.status || '').toLowerCase() === 'failed',
          timestamp,
        })
        break
      }
    }
  }

  function finalize(): SessionData {
    const markers = { compacts: 0, plans: 0, clears: 0, forks: 0 }
    for (const msg of messages) {
      if (msg.kind === 'compact-boundary') markers.compacts++
      else if (msg.kind === 'rollback-marker') markers.forks++
    }

    return {
      source: 'codex',
      messages,
      prompts,
      retainedUserInputs: buildRetainedFromSnapshot(sessionStart, lastCompactionSnapshot),
      heatmap: computeHeatmap(messages),
      markers,
    }
  }

  return { processRecord, finalize }
}

export function parseCodexSessionContent(content: string): SessionData {
  const classifier = createCodexClassifier()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    classifier.processRecord(record)
  }
  return classifier.finalize()
}

// How many records pass through the streaming classifier between explicit event-loop yields. 3000
// matches ~40 yields over the ~125k-record file this streaming path exists for — frequent enough
// that the single-threaded dev/preview server stays responsive during a multi-second parse, cheap
// enough (a `setImmediate` round-trip) that it costs nothing measurable against the parse itself.
const CODEX_STREAM_YIELD_EVERY_LINES = 3000

/**
 * Streaming twin of `parseCodexSessionContent`, for Codex files too large to ever exist as one JS
 * string (see `readSessionContent`'s Codex branch in vite-plugin-claude-data.ts, the only caller).
 * Drives the identical `processRecord`/`finalize` pair via `for await` instead of a synchronous
 * `for...of`, so classification logic is written exactly once regardless of entry point.
 *
 * `yieldToEventLoop` is required, not optional: the local API is single-threaded, and an implicit
 * assumption that stream I/O alone provides enough asynchrony is exactly the failure class this
 * branch exists to close off (see CLAUDE.md's "Indexing must never own the event loop"). Making this
 * parameter optional is how that regresses — a future caller could simply forget to pass it.
 *
 * This function must stay free of Node-specific imports (no `fs`, no `readline`, no `setImmediate`):
 * `codex-parser.ts` is bundled into the browser build via `parser.ts` -> `useFileLoader.ts`/`App.tsx`,
 * so all I/O and the event-loop yield itself are supplied by the (Node-only) caller.
 */
export async function parseCodexSessionContentStreaming(
  lines: AsyncIterable<string>,
  yieldToEventLoop: () => Promise<void>,
): Promise<SessionData> {
  const classifier = createCodexClassifier()
  let recordsProcessed = 0
  for await (const line of lines) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    classifier.processRecord(record)
    recordsProcessed += 1
    if (recordsProcessed % CODEX_STREAM_YIELD_EVERY_LINES === 0) await yieldToEventLoop()
  }
  return classifier.finalize()
}
