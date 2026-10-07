import type { SessionData, SessionMeta, SessionMessage, PromptIndexEntry } from '../../types/session'
import { detectDecision } from '../decision-detector'
import { analyzeConversationTree } from '../tree-parser'
import { computeHeatmap } from '../heatmap'

// --- Timestamp ---

function parseTimestamp(value: unknown): Date | null {
  if (!value) return null
  if (typeof value === 'string') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof value === 'number') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

function extractTimestamp(data: Record<string, unknown>): Date {
  for (const path of ['timestamp', 'snapshot.timestamp', 'message.timestamp']) {
    let val: unknown = data
    for (const part of path.split('.')) {
      val = (val as Record<string, unknown>)?.[part]
    }
    const ts = parseTimestamp(val)
    if (ts) return ts
  }
  return new Date(NaN)
}

function formatDateTime(d: Date): string {
  if(Number.isNaN(d.getTime()))return 'Time not recorded'
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${min}`
}

function formatTime(d: Date): string {
  if(Number.isNaN(d.getTime()))return 'Time not recorded'
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

// --- Project name ---

export function decodeProjectName(encoded: string): string {
  if (encoded.startsWith('-')) {
    return '/' + encoded.slice(1).replaceAll('-', '/')
  }
  return encoded
}

export function isClaudeSessionContent(content: string): boolean {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const data = JSON.parse(line) as Record<string, unknown>
      const type = data.type
      return type === 'user' || type === 'assistant' || type === 'system' || type === 'progress'
    } catch {
      continue
    }
  }
  return false
}

export function extractShortName(encoded: string): string {
  const segments = encoded.split('-').filter(Boolean)
  if (segments.length === 0) return encoded

  const last = segments[segments.length - 1]
  if (last.length >= 3) return last

  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i].length >= 3) {
      return segments[i] + '/' + last
    }
  }
  return last
}

export function disambiguateShortNames(projects: Array<{ encodedName: string; shortName: string }>) {
  const countMap = new Map<string, number>()
  for (const p of projects) {
    countMap.set(p.shortName, (countMap.get(p.shortName) || 0) + 1)
  }

  for (const [name, count] of countMap) {
    if (count <= 1) continue
    const dupes = projects.filter(p => p.shortName === name)

    let disambiguated = false
    for (let depth = 1; depth <= 5; depth++) {
      const labels = dupes.map(p => {
        const segments = p.encodedName.split('-').filter(Boolean)
        const shortSegCount = name.split('/').length
        const parentIdx = segments.length - shortSegCount - depth
        return parentIdx >= 0 ? segments[parentIdx] : ''
      })
      const unique = new Set(labels)
      if (unique.size === dupes.length) {
        for (let i = 0; i < dupes.length; i++) {
          dupes[i].shortName = `${name} (${labels[i]})`
        }
        disambiguated = true
        break
      }
    }

    if (!disambiguated) {
      for (let i = 0; i < dupes.length; i++) {
        dupes[i].shortName = `${name} #${i + 1}`
      }
    }
  }
}

// --- Message classification ---

type ContentClass =
  | { type: 'real-prompt' }
  | { type: 'team-message'; from: string; color: string; summary: string; content: string; isProtocol: boolean }
  | { type: 'task-event'; taskId: string; status: string; summary: string }
  | { type: 'system'; skip: true }

const PROTOCOL_EVENTS = ['idle_notification', 'shutdown_approved', 'teammate_terminated', 'shutdown_request']

function classifyUserContent(text: string): ContentClass {
  const t = text.trim()

  if (t.startsWith('<local-command') || t.startsWith('<command-') || t.startsWith('<system-reminder>')) {
    return { type: 'system', skip: true }
  }

  if (t.startsWith('<teammate-message')) {
    const fromMatch = t.match(/teammate_id="([^"]*)"/)
    const colorMatch = t.match(/color="([^"]*)"/)
    const summaryMatch = t.match(/summary="([^"]*)"/)
    const from = fromMatch?.[1] || 'unknown'
    const color = colorMatch?.[1] || 'blue'
    const summary = summaryMatch?.[1] || ''

    // Extract inner content (between opening tag end and closing tag)
    const tagEndIdx = t.indexOf('>')
    const closeIdx = t.lastIndexOf('</teammate-message>')
    const inner = (tagEndIdx >= 0 && closeIdx > tagEndIdx) ? t.slice(tagEndIdx + 1, closeIdx).trim() : t

    // Detect protocol events (JSON with known event types)
    let isProtocol = false
    try {
      const parsed = JSON.parse(inner)
      if (parsed && typeof parsed === 'object' && PROTOCOL_EVENTS.includes(parsed.type || parsed.event)) {
        isProtocol = true
      }
    } catch { /* not JSON, that's fine */ }

    return { type: 'team-message', from, color, summary, content: inner, isProtocol }
  }

  if (t.startsWith('<task-notification')) {
    const taskIdMatch = t.match(/<task-id>\s*(.*?)\s*<\/task-id>/s)
    const statusMatch = t.match(/<status>\s*(.*?)\s*<\/status>/s)
    const summaryMatch = t.match(/<summary>\s*(.*?)\s*<\/summary>/s)
    return {
      type: 'task-event',
      taskId: taskIdMatch?.[1] || '?',
      status: statusMatch?.[1] || 'unknown',
      summary: summaryMatch?.[1] || '',
    }
  }

  if (!t) return { type: 'system', skip: true }
  return { type: 'real-prompt' }
}

function classifyUserMessage(msg: Record<string, unknown>): ContentClass | null {
  if (msg.type !== 'user') return null
  if (msg.isMeta) return null
  if (msg.isCompactSummary) return null
  const message = msg.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content === 'string') {
    return classifyUserContent(content)
  }
  if (Array.isArray(content)) {
    if (content.every((c) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'tool_result')) {
      return null
    }
    for (const c of content) {
      if (typeof c !== 'object' || c === null) continue
      const item = c as Record<string, unknown>
      if (item.type === 'text' || item.type === 'input_text') {
        const text = String(item.text || '')
        if (text.trim()) {
          const cls = classifyUserContent(text)
          if (cls.type !== 'system') return cls
        }
      }
    }
  }
  return null
}

function getUserText(msg: Record<string, unknown>): string {
  const message = msg.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content) {
      if (typeof c !== 'object' || c === null) continue
      const item = c as Record<string, unknown>
      if (item.type === 'text' || item.type === 'input_text') {
        parts.push(String(item.text || ''))
      } else if (item.type === 'image' || item.type === 'image_url') {
        parts.push('[Image]')
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** Normalize prompt text for dedupe/frequency comparison (whitespace-insensitive). */
function normalizePromptText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Extract the text of a queued_command attachment's `prompt` payload.
 * Observed as a plain string, with a list-of-content-blocks variant.
 */
function coerceQueuedPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    const parts: string[] = []
    for (const c of prompt) {
      if (typeof c === 'object' && c !== null) {
        const item = c as Record<string, unknown>
        if (typeof item.text === 'string') parts.push(item.text)
      } else if (typeof c === 'string') {
        parts.push(c)
      }
    }
    return parts.join('\n')
  }
  return ''
}

function getUserImages(msg: Record<string, unknown>): import('../../types/session').EmbeddedImage[] {
  const message = msg.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const images: import('../../types/session').EmbeddedImage[] = []
  for (const c of content) {
    if (typeof c !== 'object' || c === null) continue
    const item = c as Record<string, unknown>
    if (item.type === 'image') {
      const source = item.source as Record<string, unknown> | undefined
      if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        images.push({
          mediaType: source.media_type as string,
          dataUrl: `data:${source.media_type};base64,${source.data}`,
        })
      }
    }
  }
  return images
}

// --- Tool summary ---

function getFilename(fp: string): string {
  if (!fp) return ''
  const parts = fp.split('/')
  return parts[parts.length - 1] || fp
}

const PERSISTED_RE = /^<persisted-output>\n(.+?)\n\nPreview \(first [^)]+\):\n([\s\S]*?)\n<\/persisted-output>$/

function parsePersistedOutput(text: string): { preview: string; relativePath: string | undefined; totalSize: string } | null {
  const m = text.match(PERSISTED_RE)
  if (!m) return null
  const header = m[1]   // "Output too large (34.1KB). Full output saved to: /abs/path/tool-results/xxx.txt"
  const preview = m[2]  // actual preview content

  const sizeMatch = header.match(/\(([^)]+)\)/)
  const totalSize = sizeMatch ? sizeMatch[1] : 'unknown'

  // Extract relative path: .../sessionId/tool-results/filename.txt → tool-results/filename.txt
  const pathMatch = header.match(/saved to: .+?\/[0-9a-f-]{36}\/(tool-results\/[^\s]+)/)
  const relativePath = pathMatch ? pathMatch[1] : undefined

  return { preview, relativePath, totalSize }
}

function toolSummary(item: Record<string, unknown>): string {
  const name = String(item.name || 'unknown')
  const inp = (item.input || {}) as Record<string, unknown>

  switch (name.toLowerCase()) {
    case 'read':
      return `Read ${getFilename(String(inp.file_path || inp.filePath || ''))}`
    case 'write':
      return `Write ${getFilename(String(inp.file_path || inp.filePath || ''))}`
    case 'edit':
      return `Edit ${getFilename(String(inp.file_path || inp.filePath || ''))}`
    case 'bash':
      return `$ ${inp.description || String(inp.command || '').slice(0, 60)}`
    case 'glob':
      return `Glob ${inp.pattern || ''}`
    case 'grep':
      return `Grep '${inp.pattern || ''}'`
    case 'agent':
    case 'task':
      return `Agent: ${inp.description || String(inp.prompt || '').slice(0, 60)}`
    case 'toolsearch':
      return `ToolSearch: ${inp.query || ''}`
    case 'sendmessage':
      return `\u2192 Sent to ${inp.recipient || inp.teammate_id || '?'}: ${String(inp.summary || inp.content || '').slice(0, 60)}`
    case 'taskcreate':
      return `Created task: ${String(inp.subject || inp.description || '').slice(0, 60)}`
    case 'taskupdate':
      return `Updated task #${inp.id || inp.task_id || '?'}: ${inp.status || ''}`
    case 'tasklist':
      return 'Listed tasks'
    default:
      return name
  }
}

// --- Record classification helper ---

interface ClassifyResult {
  messages: SessionMessage[]
  isPrompt: boolean
  isClear: boolean
}

/**
 * Classify a single JSONL record into SessionMessage(s).
 * When `promptCounter` is provided, user prompts increment it and use its value.
 * When `promptCounter` is null, prompt numbering is skipped (for abandoned branches).
 */
function classifyRecord(
  data: Record<string, unknown>,
  promptCounter: { value: number } | null,
  prompts: PromptIndexEntry[] | null,
): ClassifyResult {
  const result: ClassifyResult = { messages: [], isPrompt: false, isClear: false }
  const msgType = data.type

  // Classify user messages
  if (msgType === 'user' && !data.isMeta) {
    const cls = classifyUserMessage(data)

    if (cls?.type === 'real-prompt') {
      result.isPrompt = true
      const text = getUserText(data)
      const images = getUserImages(data)
      const ts = extractTimestamp(data)
      const time = formatTime(ts)
      const timestamp = Number.isNaN(ts.getTime()) ? '' : ts.toISOString()
      if (promptCounter) {
        promptCounter.value++
        const decision = detectDecision(text, promptCounter.value)
        result.messages.push({ kind: 'user-prompt', promptNum: promptCounter.value, text, images, time, timestamp, decision })
        prompts?.push({
          num: promptCounter.value,
          preview: text.slice(0, 100).replace(/\n/g, ' '),
          fullText: text,
          time,
          timestamp,
          decision,
        })
      } else {
        const decision = detectDecision(text, 0)
        result.messages.push({ kind: 'user-prompt', promptNum: 0, text, images, time, timestamp, decision })
      }
      return result
    }

    if (cls?.type === 'team-message') {
      result.messages.push({
        kind: 'team-message',
        from: cls.from,
        color: cls.color,
        summary: cls.summary,
        content: cls.content,
        isProtocol: cls.isProtocol,
      })
      return result
    }

    if (cls?.type === 'task-event') {
      result.messages.push({
        kind: 'task-event',
        taskId: cls.taskId,
        status: cls.status,
        summary: cls.summary,
      })
      return result
    }

    // Check if this is a /clear command (system skip) — mark it so caller can inject clear-divider
    if (cls?.type === 'system') {
      const text = getUserText(data)
      if (text.includes('<command-name>/clear</command-name>')) {
        result.isClear = true
      }
    }
  }

  // Tool results (user type with tool_result content)
  if (msgType === 'user') {
    const message = data.message as Record<string, unknown> | undefined
    const contentArr = message?.content
    if (Array.isArray(contentArr)) {
      for (const c of contentArr) {
        if (typeof c !== 'object' || c === null) continue
        const item = c as Record<string, unknown>
        if (item.type !== 'tool_result') continue
        let resultContent = item.content
        if (Array.isArray(resultContent)) {
          resultContent = (resultContent as Record<string, unknown>[])
            .filter((rc) => rc.type === 'text')
            .map((rc) => String(rc.text || ''))
            .join('\n')
        }
        const full = String(resultContent || '')
        const persisted = parsePersistedOutput(full)
        if (persisted) {
          result.messages.push({
            kind: 'tool-result',
            content: persisted.preview,
            isError: Boolean(item.is_error),
            externalFile: persisted.relativePath,
            totalSize: persisted.totalSize,
          })
        } else {
          const display = full
          result.messages.push({
            kind: 'tool-result',
            content: display,
            isError: Boolean(item.is_error),
          })
        }
      }
    }
    return result
  }

  // Assistant message
  if (msgType === 'assistant') {
    const message = data.message as Record<string, unknown> | undefined
    const contentItems = message?.content
    if (!Array.isArray(contentItems)) return result

    for (const c of contentItems) {
      if (typeof c !== 'object' || c === null) continue
      const item = c as Record<string, unknown>

      switch (item.type) {
        case 'thinking': {
          const thinking = String(item.thinking || '')
          if (!thinking) break
          result.messages.push({
            kind: 'ai-thinking',
            preview: thinking.slice(0, 120).replace(/\n/g, ' '),
            full: thinking,
          })
          break
        }
        case 'text': {
          const text = String(item.text || '').trim()
          if (!text) break
          result.messages.push({ kind: 'ai-text', text })
          break
        }
        case 'tool_use': {
          const summary = toolSummary(item)
          result.messages.push({
            kind: 'ai-tool-use',
            summary,
            name: String(item.name || 'unknown'),
            input: (item.input || {}) as Record<string, unknown>,
          })
          break
        }
      }
    }
    return result
  }

  return result
}

// --- Main parsers ---

export function parseClaudeSessionContent(content: string): SessionData {
  return parseSessionCore(content, null).data
}

// --- Incremental continuation ---

/**
 * Serializable snapshot of the parser's accumulators, letting a later run parse
 * only the current turn plus appended bytes instead of the whole file.
 * All offsets are JS string indices into the exact content string that was parsed.
 * `prefixSha256` is opaque here: the caller (CLI) computes and verifies it,
 * because this module must stay runtime-agnostic (no node:crypto in browser bundles).
 */
export interface ClaudeParserState {
  version: 1
  parserSha: string
  prefixSha256: string
  /** String index of the record that produced the last numbered prompt. */
  windowOffset: number
  /** String index one past the last complete (newline-terminated) consumed line. */
  consumedLength: number
  frozenMessageCount: number
  frozenPromptCount: number
  lastUuid: string | null
  deliveredPromptIndex: Record<string, number[]>
  compactBoundaries: Record<string, { trigger: 'auto' | 'manual'; preTokens: number; ts: string }>
  compactSummaries: Record<string, string>
}

interface ParseSeed {
  baseMessages: SessionMessage[]
  basePrompts: PromptIndexEntry[]
  promptCounterStart: number
  deliveredPromptIndex: Map<string, number[]>
  compactBoundaries: Map<string, { trigger: 'auto' | 'manual'; preTokens: number; ts: string }>
  compactSummaries: Map<string, string>
}

interface CoreOutcome {
  data: SessionData
  windowOffset: number
  consumedLength: number
  frozenMessageCount: number
  frozenPromptCount: number
  lastUuid: string | null
  deliveredPromptIndex: Map<string, number[]>
  compactBoundaries: Map<string, { trigger: 'auto' | 'manual'; preTokens: number; ts: string }>
  compactSummaries: Map<string, string>
}

function parseSessionCore(content: string, seed: ParseSeed | null): CoreOutcome {
  // Step 1: Parse all lines into records, tracking each record's string offset
  // (the incremental window boundary is the offset of the last prompt's record).
  const lines = content.split('\n')
  const records: Record<string, unknown>[] = []
  const offsets = new WeakMap<Record<string, unknown>, number>()
  let lastUuid: string | null = null
  let lineStart = 0

  for (const line of lines) {
    const start = lineStart
    lineStart += line.length + 1
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      records.push(record)
      offsets.set(record, start)
      if (typeof record.uuid === 'string') lastUuid = record.uuid
    } catch {
      continue
    }
  }

  // A final line without a terminating newline is not consumed: it may still be
  // mid-write and will be re-read once complete.
  const consumedLength = content.endsWith('\n') ? content.length : content.length - lines[lines.length - 1].length

  // Step 2: Pre-scan for compact_boundary and isCompactSummary records
  // (seeded with the frozen region's maps on continuation; window records re-add
  // identical key/value pairs, which is idempotent)
  const compactBoundaries = new Map<string, { trigger: 'auto' | 'manual'; preTokens: number; ts: string }>(seed?.compactBoundaries ?? [])
  const compactSummaries = new Map<string, string>(seed?.compactSummaries ?? []) // keyed by parentUuid (= boundary uuid) -> summary text

  for (const rec of records) {
    if (rec.type === 'system' && rec.subtype === 'compact_boundary' && typeof rec.uuid === 'string') {
      const meta = rec.compactMetadata as Record<string, unknown> | undefined
      const ts = extractTimestamp(rec)
      compactBoundaries.set(rec.uuid as string, {
        trigger: (meta?.trigger === 'manual' ? 'manual' : 'auto'),
        preTokens: typeof meta?.preTokens === 'number' ? meta.preTokens : 0,
        ts: formatTime(ts),
      })
    }
    if (rec.isCompactSummary && typeof rec.parentUuid === 'string') {
      const message = rec.message as Record<string, unknown> | undefined
      const content = message?.content
      const text = typeof content === 'string' ? content : ''
      compactSummaries.set(rec.parentUuid as string, text)
    }
  }

  // Pre-scan: index delivered user prompts (normalized text -> timestamps in seconds).
  // queued_command attachments whose text later landed as a real user record must not
  // double-render; the real record wins and the attachment copy is skipped.
  const deliveredPromptIndex = new Map<string, number[]>()
  if (seed) {
    for (const [key, secs] of seed.deliveredPromptIndex) deliveredPromptIndex.set(key, [...secs])
  }
  for (const rec of records) {
    if (rec.type !== 'user' || rec.isMeta) continue
    if (classifyUserMessage(rec)?.type !== 'real-prompt') continue
    const norm = normalizePromptText(getUserText(rec))
    if (!norm) continue
    const sec = extractTimestamp(rec).getTime() / 1000
    const list = deliveredPromptIndex.get(norm)
    if (list) list.push(sec)
    else deliveredPromptIndex.set(norm, [sec])
  }

  // Step 3: Analyze conversation tree
  const tree = analyzeConversationTree(records)

  const planTransitionByUuid = new Map<string, Array<{ type: 'enter' | 'exit'; planPreview?: string }>>()
  for (const pt of tree.planTransitions) {
    const existing = planTransitionByUuid.get(pt.uuid)
    if (existing) {
      existing.push({ type: pt.type, planPreview: pt.planPreview })
    } else {
      planTransitionByUuid.set(pt.uuid, [{ type: pt.type, planPreview: pt.planPreview }])
    }
  }

  // Step 4: Reorder records to pair tool_use with their tool_result.
  // CLI displays tool calls with their results immediately following, even when
  // multiple tools are called in parallel. We need to match this UX by reordering:
  // instead of [tool_use_A, tool_use_B, result_A, result_B], show
  // [tool_use_A, result_A, tool_use_B, result_B].
  const reorderedRecords: Record<string, unknown>[] = []
  const toolResultMap = new Map<string, Record<string, unknown>>() // tool_use_id -> tool_result record

  // First pass: index all tool_result records by their tool_use_id
  for (const rec of records) {
    if (rec.type === 'user') {
      const msg = rec.message as Record<string, unknown> | undefined
      const content = msg?.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c === 'object' && c !== null) {
            const item = c as Record<string, unknown>
            if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
              toolResultMap.set(item.tool_use_id as string, rec)
            }
          }
        }
      }
    }
  }

  // Second pass: emit records, inserting tool_result immediately after tool_use
  const emitted = new Set<Record<string, unknown>>()
  for (const rec of records) {
    if (emitted.has(rec)) continue
    reorderedRecords.push(rec)
    emitted.add(rec)

    // If this is an assistant message with tool_use, emit its tool_result next
    if (rec.type === 'assistant') {
      const msg = rec.message as Record<string, unknown> | undefined
      const content = msg?.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c === 'object' && c !== null) {
            const item = c as Record<string, unknown>
            if (item.type === 'tool_use' && typeof item.id === 'string') {
              const resultRec = toolResultMap.get(item.id as string)
              if (resultRec && !emitted.has(resultRec)) {
                reorderedRecords.push(resultRec)
                emitted.add(resultRec)
              }
            }
          }
        }
      }
    }
  }

  // Step 5: Iterate records and build messages
  const messages: SessionMessage[] = seed ? [...seed.baseMessages] : []
  const prompts: PromptIndexEntry[] = seed ? [...seed.basePrompts] : []
  const promptCounter = { value: seed?.promptCounterStart ?? 0 }

  // Records that produced the last numbered prompt mark the incremental window:
  // everything before that record is frozen output; the record itself and all
  // later ones are re-processed on continuation.
  let windowMark: { offset: number; messageCount: number; promptCount: number } | null = null

  for (const data of reorderedRecords) {
    const iterationMessageBase = messages.length
    const iterationPromptBase = promptCounter.value
    const uuid = data.uuid as string | undefined

    // 5a: Detect compact_boundary records and emit compact-boundary message
    if (data.type === 'system' && data.subtype === 'compact_boundary' && typeof uuid === 'string') {
      const boundary = compactBoundaries.get(uuid)
      if (boundary) {
        messages.push({
          kind: 'compact-boundary',
          timestamp: boundary.ts,
          trigger: boundary.trigger,
          preTokens: boundary.preTokens,
          summaryText: compactSummaries.get(uuid) || '',
        })
      }
      continue
    }

    // 5b: Skip isCompactSummary records (content folded into compact-boundary)
    if (data.isCompactSummary) {
      continue
    }

    // 5c: Detect /clear BEFORE tree filtering — /clear resets conversation context
    // and creates tree discontinuities, so it may not be on the active path
    if (data.type === 'user' && !data.isMeta) {
      const msg = data.message as Record<string, unknown> | undefined
      const rawContent = msg?.content
      const rawText = typeof rawContent === 'string' ? rawContent : ''
      if (rawText.includes('<command-name>/clear</command-name>')) {
        const ts = extractTimestamp(data)
        messages.push({ kind: 'clear-divider', timestamp: formatTime(ts) })
        continue
      }
    }

    // 5c2: Mid-work user input lives in attachment records, not user records.
    // Render origin.kind=='human' queued_command payloads as user prompts.
    // (Skipped when the same text was later delivered as a real user record —
    // that copy wins the timeline slot; peer/harness origins are not user prose.)
    if (data.type === 'attachment') {
      const att = data.attachment as Record<string, unknown> | undefined
      const origin = att?.origin as Record<string, unknown> | undefined
      if (att?.type === 'queued_command' && origin?.kind === 'human') {
        const text = coerceQueuedPromptText(att.prompt).trim()
        if (text) {
          const ts = extractTimestamp(data)
          const norm = normalizePromptText(text)
          const deliveredSecs = deliveredPromptIndex.get(norm)
          const wasDelivered = deliveredSecs?.some((s) => Math.abs(s - ts.getTime() / 1000) <= 120)
          if (!wasDelivered && promptCounter) {
            promptCounter.value++
            const time = formatTime(ts)
            const timestamp = Number.isNaN(ts.getTime()) ? '' : ts.toISOString()
            const decision = detectDecision(text, promptCounter.value)
            messages.push({ kind: 'user-prompt', promptNum: promptCounter.value, text, images: [], time, timestamp, decision, queued: true })
            prompts?.push({
              num: promptCounter.value,
              preview: text.slice(0, 100).replace(/\n/g, ' '),
              fullText: text,
              time,
              timestamp,
              decision,
            })
            windowMark = { offset: offsets.get(data) ?? 0, messageCount: iterationMessageBase, promptCount: iterationPromptBase }
          }
        }
      }
      continue
    }

    // 5d: Skip abandoned branch records when tree data is available
    if (tree.hasTreeData && typeof uuid === 'string' && !tree.activeUuids.has(uuid)) {
      continue
    }

    // 5e: Inject plan-start/plan-end before the record's own messages
    if (tree.hasTreeData && typeof uuid === 'string' && planTransitionByUuid.has(uuid)) {
      const transitions = planTransitionByUuid.get(uuid)!
      const ts = extractTimestamp(data)
      const timestamp = formatTime(ts)
      for (const pt of transitions) {
        if (pt.type === 'enter') {
          messages.push({ kind: 'plan-start', timestamp })
        } else {
          messages.push({ kind: 'plan-end', timestamp, planPreview: pt.planPreview || '' })
        }
      }
    }

    // 5f: Classify the record with the standard logic
    const classified = classifyRecord(data, promptCounter, prompts)

    // Skip system records that produced no messages
    if (classified.messages.length === 0) {
      continue
    }

    const recorded = extractTimestamp(data)
    const recordedTimestamp = Number.isNaN(recorded.getTime()) ? undefined : (typeof data.timestamp==='string' ? data.timestamp : recorded.toISOString())
    messages.push(...classified.messages.map(message => ({...message, timestamp:recordedTimestamp ?? '', ...(message.kind==='user-prompt' && !recordedTimestamp ? {time:'Time not recorded'} : {})})))
    if (promptCounter.value > iterationPromptBase) {
      windowMark = { offset: offsets.get(data) ?? 0, messageCount: iterationMessageBase, promptCount: iterationPromptBase }
    }

    // 5g: Inject fork-indicator after the current record if it's a fork point
    if (tree.hasTreeData && typeof uuid === 'string' && tree.forkPoints.has(uuid)) {
      const branches = tree.forkPoints.get(uuid)!
      const ts = extractTimestamp(data)
      const timestamp = formatTime(ts)

      for (const branch of branches) {
        // Classify abandoned branch records (no prompt numbering)
        const abandonedMessages: SessionMessage[] = []
        let abandonedPreview = ''

        for (const abandonedRec of branch) {
          const aClassified = classifyRecord(abandonedRec, null, null)
          abandonedMessages.push(...aClassified.messages)

          // Extract preview from first assistant text if not yet found
          if (!abandonedPreview) {
            for (const msg of aClassified.messages) {
              if (msg.kind === 'ai-text') {
                abandonedPreview = msg.text.slice(0, 100)
                break
              }
            }
          }
        }

        if (abandonedMessages.length > 0) {
          // Determine fork reason: if abandoned branch contains ANY tool_result,
          // it's an auto-retry (tool succeeded/failed and Claude tried a different approach).
          // Only mark as user-decision if the abandoned branch has no tool results at all.
          const hasToolResult = abandonedMessages.some(m => m.kind === 'tool-result')
          messages.push({
            kind: 'fork-indicator',
            abandonedMessages,
            abandonedPreview,
            timestamp,
            reason: hasToolResult ? 'tool-error' : 'user-decision',
          })
        }
      }
    }
  }

  // Mark exact-duplicate user prompts for collapsed rendering. Hook/loop-injected
  // boilerplate lands as structurally ordinary user records (promptSource: typed),
  // so identical text repeated many times is the reliable tell — this also collapses
  // genuinely repeated short prompts ("继续" ×N), which is the desired view for both.
  const DUP_COLLAPSE_THRESHOLD = 5
  const promptFreq = new Map<string, number>()
  for (const m of messages) {
    if (m.kind === 'user-prompt') {
      const norm = normalizePromptText(m.text)
      promptFreq.set(norm, (promptFreq.get(norm) ?? 0) + 1)
    }
  }
  for (const m of messages) {
    if (m.kind === 'user-prompt') {
      const n = promptFreq.get(normalizePromptText(m.text)) ?? 0
      if (n >= DUP_COLLAPSE_THRESHOLD) m.dupCount = n
    }
  }

  // Count markers from parsed messages
  const markers = { compacts: 0, plans: 0, clears: 0, forks: 0 }
  for (const msg of messages) {
    if (msg.kind === 'compact-boundary') markers.compacts++
    else if (msg.kind === 'plan-start') markers.plans++
    else if (msg.kind === 'clear-divider') markers.clears++
    else if (msg.kind === 'fork-indicator' && msg.reason === 'user-decision') markers.forks++
  }

  const data: SessionData = { source: 'claude', messages, prompts, heatmap: computeHeatmap(messages), markers }
  return {
    data,
    windowOffset: windowMark ? windowMark.offset : 0,
    consumedLength,
    frozenMessageCount: windowMark ? windowMark.messageCount : 0,
    frozenPromptCount: windowMark ? windowMark.promptCount : 0,
    lastUuid,
    deliveredPromptIndex,
    compactBoundaries,
    compactSummaries,
  }
}

function toParserState(outcome: CoreOutcome, parserSha: string, baseOffset: number, fallbackLastUuid: string | null): ClaudeParserState {
  return {
    version: 1,
    parserSha,
    prefixSha256: '',
    windowOffset: baseOffset + outcome.windowOffset,
    consumedLength: baseOffset + outcome.consumedLength,
    frozenMessageCount: outcome.frozenMessageCount,
    frozenPromptCount: outcome.frozenPromptCount,
    lastUuid: outcome.lastUuid ?? fallbackLastUuid,
    deliveredPromptIndex: Object.fromEntries(outcome.deliveredPromptIndex),
    compactBoundaries: Object.fromEntries(outcome.compactBoundaries),
    compactSummaries: Object.fromEntries(outcome.compactSummaries),
  }
}

export function parseClaudeSessionWithState(content: string, parserSha = ''): { data: SessionData; state: ClaudeParserState } {
  const outcome = parseSessionCore(content, null)
  return { data: outcome.data, state: toParserState(outcome, parserSha, 0, null) }
}

/**
 * Continue a previous parse when the source only gained complete lines on the
 * active conversation path. Returns null — meaning the caller must fall back to
 * a full parse — when anything could retroactively change already-published
 * output: the source shrank, nothing was appended, or a new record's effective
 * parent points into the frozen region (a fork from history; the common
 * non-linear case, tool_result children of window tool_uses, stays incremental).
 */
export function continueClaudeSessionWithState(
  content: string,
  previous: { messages: SessionMessage[]; prompts: PromptIndexEntry[] },
  state: ClaudeParserState,
): { data: SessionData; state: ClaudeParserState } | null {
  if (state.version !== 1) return null
  if (!Number.isInteger(state.windowOffset) || !Number.isInteger(state.consumedLength)) return null
  if (state.windowOffset < 0 || state.windowOffset > state.consumedLength || state.consumedLength >= content.length) return null
  if (!Array.isArray(previous.messages) || !Array.isArray(previous.prompts)) return null
  if (state.frozenMessageCount > previous.messages.length || state.frozenPromptCount > previous.prompts.length) return null

  const windowUuids = new Set<string>()
  for (const line of content.slice(state.windowOffset, state.consumedLength).split('\n')) {
    if (!line.trim()) continue
    try {
      const u = (JSON.parse(line) as Record<string, unknown>).uuid
      if (typeof u === 'string') windowUuids.add(u)
    } catch { /* window lines were validated when first consumed */ }
  }
  let running = state.lastUuid
  for (const line of content.slice(state.consumedLength).split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try { record = JSON.parse(line) } catch { continue } // unconsumed partial tail
    const uuid = record.uuid
    if (typeof uuid !== 'string') continue
    const rawParent = record.parentUuid
    const logicalParent = record.logicalParentUuid
    const effectiveParent = (rawParent === null || rawParent === undefined) && typeof logicalParent === 'string'
      ? logicalParent
      : rawParent
    const isCompactBoundary = record.type === 'system' && record.subtype === 'compact_boundary'
    if (typeof effectiveParent === 'string' && effectiveParent !== running && !windowUuids.has(effectiveParent) && !isCompactBoundary) {
      return null
    }
    windowUuids.add(uuid)
    running = uuid
  }

  const outcome = parseSessionCore(content.slice(state.windowOffset), {
    baseMessages: previous.messages.slice(0, state.frozenMessageCount),
    basePrompts: previous.prompts.slice(0, state.frozenPromptCount),
    promptCounterStart: state.frozenPromptCount,
    deliveredPromptIndex: new Map(Object.entries(state.deliveredPromptIndex).map(([key, secs]) => [key, [...secs]])),
    compactBoundaries: new Map(Object.entries(state.compactBoundaries)),
    compactSummaries: new Map(Object.entries(state.compactSummaries)),
  })
  return { data: outcome.data, state: toParserState(outcome, state.parserSha, state.windowOffset, state.lastUuid) }
}

/**
 * Lightweight metadata scan from the first few KB of a JSONL file.
 * Only extracts startTime and firstPromptPreview (promptCount/toolCount/recordCount are 0).
 */
export function quickScanClaudeMetadata(head: string, sessionId: string, fileSize: number): SessionMeta | null {
  let startTime: Date | null = null
  let firstPromptPreview = ''

  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let data: Record<string, unknown>
    try { data = JSON.parse(line) } catch { continue }

    if (!startTime) {
      const recorded=extractTimestamp(data)
      if(!Number.isNaN(recorded.getTime()))startTime=recorded
    }

    if (!firstPromptPreview) {
      const cls = classifyUserMessage(data)
      if (cls?.type === 'real-prompt') {
        firstPromptPreview = getUserText(data).slice(0, 100).replace(/\n/g, ' ')
      }
    }

    if (startTime && firstPromptPreview) break
  }

  if (!startTime || !firstPromptPreview) return null

  return {
    source: 'claude',
    id: sessionId,
    startTime: startTime.toISOString(),
    startDisplay: formatDateTime(startTime),
    promptCount: 0,
    toolCount: 0,
    firstPromptPreview,
    fileSize,
    recordCount: 0,
  }
}
