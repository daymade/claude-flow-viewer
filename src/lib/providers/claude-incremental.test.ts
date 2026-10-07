import { describe, it, expect } from 'vitest'
import {
  parseClaudeSessionWithState,
  continueClaudeSessionWithState,
  parseClaudeSessionContent,
  type ClaudeParserState,
} from './claude'
import type { SessionData } from '../../types/session'

// --- Synthetic session builder ---

let seq = 0
function uuid(): string {
  seq += 1
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

function rec(type: string, parent: string | null, extra: Record<string, unknown>): string {
  return JSON.stringify({
    uuid: uuid(),
    parentUuid: parent,
    type,
    sessionId: SESSION_ID,
    timestamp: '2026-10-07T10:00:00.000Z',
    ...extra,
  })
}

function userPrompt(text: string, parent: string | null): string {
  return rec('user', parent, { message: { role: 'user', content: text } })
}

function assistant(blocks: unknown[], parent: string | null): string {
  return rec('assistant', parent, { message: { role: 'assistant', content: blocks } })
}

function toolResult(id: string, text: string, parent: string | null): string {
  return rec('user', parent, {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  })
}

/** A session exercising every state-bearing parser feature. */
function buildSession(): { part1: string; full: string; forked: string; firstUuid: string } {
  seq = 0
  const lines: string[] = []
  const push = (line: string): string => {
    lines.push(line)
    return (JSON.parse(line) as { uuid: string }).uuid
  }

  const firstUuid: string[] = []
  const p1 = push(userPrompt('帮我查一下性能', null))
  firstUuid.push(p1)
  const a1 = push(assistant([
    { type: 'thinking', thinking: '想一想' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: '列文件' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/x' } },
  ], p1))
  // attachment records interleaved between tool_use and tool_result (non-linear parents)
  push(rec('attachment', a1, { attachment: { type: 'queued_command', origin: { kind: 'harness' }, prompt: '内部队列' } }))
  const r1 = push(toolResult('t1', 'ok1', a1))
  void r1
  const r2 = push(toolResult('t2', 'ok2', a1))
  // an abandoned branch: two children of a1 (r2 and the fork below)
  const abandoned = push(assistant([{ type: 'text', text: '被放弃的分支回答' }], a1))
  void abandoned
  let parent = push(assistant([{ type: 'text', text: '结果是这样' }], r2))
  // dup-collapse: same prompt 6 times
  for (let i = 0; i < 6; i++) {
    const p = push(userPrompt('继续', parent))
    parent = push(assistant([{ type: 'text', text: '好' }], p))
  }
  // /clear then a new root
  push(userPrompt('<command-name>/clear</command-name>', parent))
  const p3 = push(userPrompt('新对话开始', null))
  const a3 = push(assistant([{ type: 'text', text: '你好' }], p3))
  // compact boundary + summary
  const boundaryLine = JSON.stringify({
    uuid: uuid(), parentUuid: null, logicalParentUuid: a3, type: 'system', subtype: 'compact_boundary',
    sessionId: SESSION_ID, timestamp: '2026-10-07T11:00:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 12345 },
  })
  lines.push(boundaryLine)
  const boundary = (JSON.parse(boundaryLine) as { uuid: string }).uuid
  push(rec('user', boundary, { isCompactSummary: true, message: { role: 'user', content: '压缩摘要文本' } }))
  const p4 = push(userPrompt('压缩后第一问', boundary))
  const a4 = push(assistant([{ type: 'text', text: '压缩后回答' }], p4))

  const part1 = lines.join('\n') + '\n'

  const more: string[] = []
  const pushMore = (line: string): string => {
    more.push(line)
    return (JSON.parse(line) as { uuid: string }).uuid
  }
  const p5 = pushMore(userPrompt('追加的问题', a4))
  const a5 = pushMore(assistant([{ type: 'text', text: '追加回答' }], p5))
  pushMore(rec('attachment', a5, { attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: '排队的人工输入' } }))

  const full = part1 + more.join('\n') + '\n'

  // fork from frozen history: parent = the session's first uuid (turns old)
  const forkLine = JSON.stringify({
    uuid: uuid(), parentUuid: firstUuid[0], type: 'user', sessionId: SESSION_ID,
    timestamp: '2026-10-07T12:00:00.000Z', message: { role: 'user', content: '从历史分叉的编辑' },
  })
  const forked = full + forkLine + '\n'

  return { part1, full, forked, firstUuid: firstUuid[0] }
}

function continueFrom(part1: string, full: string) {
  const boot = parseClaudeSessionWithState(part1, 'testsha')
  return continueClaudeSessionWithState(
    full,
    { messages: boot.data.messages, prompts: boot.data.prompts },
    boot.state,
  )
}

describe('incremental continuation', () => {
  it('produces byte-identical output to a full parse for a split at every line', () => {
    const { part1, full } = buildSession()
    const reference = JSON.stringify(parseClaudeSessionContent(full))
    const part1Lines = part1.split('\n')
    // split at every line boundary of part1; continue to full; compare
    for (let cut = 1; cut < part1Lines.length; cut++) {
      const prefix = part1Lines.slice(0, cut).join('\n') + '\n'
      const boot = parseClaudeSessionWithState(prefix, 'testsha')
      const continued = continueClaudeSessionWithState(
        full,
        { messages: boot.data.messages, prompts: boot.data.prompts },
        boot.state,
      )
      expect(continued, `split at line ${cut} should stay incremental`).not.toBeNull()
      expect(JSON.stringify(continued!.data), `split at line ${cut}`).toBe(reference)
    }
  })

  it('chains successive continuations without drift', () => {
    const { part1, full } = buildSession()
    const reference = JSON.stringify(parseClaudeSessionContent(full))
    const part1Lines = part1.split('\n').filter(Boolean)
    const third = Math.floor(part1Lines.length / 3)
    const s1 = part1Lines.slice(0, third).join('\n') + '\n'
    const s2 = part1Lines.slice(0, third * 2).join('\n') + '\n'
    const boot = parseClaudeSessionWithState(s1, 'testsha')
    const step2 = continueClaudeSessionWithState(s2, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)
    expect(step2).not.toBeNull()
    const step3 = continueClaudeSessionWithState(full, { messages: step2!.data.messages, prompts: step2!.data.prompts }, step2!.state)
    expect(step3).not.toBeNull()
    expect(JSON.stringify(step3!.data)).toBe(reference)
  })

  it('declines continuation (null) when a new record forks from frozen history', () => {
    const { part1, forked } = buildSession()
    expect(continueFrom(part1, forked)).toBeNull()
  })

  it('declines continuation when the source shrank or nothing was appended', () => {
    const { part1 } = buildSession()
    expect(continueFrom(part1, part1)).toBeNull()
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    const truncated = part1.slice(0, Math.floor(part1.length / 2))
    expect(
      continueClaudeSessionWithState(truncated, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state),
    ).toBeNull()
  })

  it('declines continuation for foreign or corrupt state', () => {
    const { part1, full } = buildSession()
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    const garbage = { version: 1 } as unknown as ClaudeParserState
    expect(continueClaudeSessionWithState(full, { messages: [], prompts: [] }, garbage)).toBeNull()
    const tampered = { ...boot.state, frozenMessageCount: boot.data.messages.length + 100 }
    expect(
      continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, tampered),
    ).toBeNull()
  })

  it('handles a partial tail line the same way in both paths', () => {
    const { part1, full } = buildSession()
    const partialTail = full + '{"uuid":"incomplete'
    const referenceFull = parseClaudeSessionContent(partialTail)
    const continued = continueFrom(part1, partialTail)
    expect(continued).not.toBeNull()
    expect(JSON.stringify(continued!.data)).toBe(JSON.stringify(referenceFull))
  })
})

describe('findRoot memoization regression', () => {
  it('parses a deep single-chain session without the quadratic walk', () => {
    // 50k linear records: the un-memoized O(records x depth) walk needs ~10^9
    // steps (minutes); memoized it must finish well under the test timeout.
    const lines: string[] = []
    let parent: string | null = null
    for (let i = 0; i < 25000; i++) {
      const pLine = userPrompt(`问题 ${i}`, parent)
      lines.push(pLine)
      const pUuid = (JSON.parse(pLine) as { uuid: string }).uuid
      const aLine = assistant([{ type: 'text', text: `回答 ${i}` }], pUuid)
      lines.push(aLine)
      parent = (JSON.parse(aLine) as { uuid: string }).uuid
    }
    const data: SessionData = parseClaudeSessionContent(lines.join('\n') + '\n')
    expect(data.prompts.length).toBe(25000)
    expect(data.messages.filter((m) => m.kind === 'user-prompt').length).toBe(25000)
  }, 30000)
})
