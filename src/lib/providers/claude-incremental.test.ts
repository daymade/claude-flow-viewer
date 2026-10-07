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

  it('preserves the original per-walk semantics on parent cycles', () => {
    // Cyclic parent chains (corrupt but real): the pre-memoization code walked
    // fresh from every start node and resolved each to its own first repeat,
    // producing three components and zero fork-indicators. Acyclic-only
    // caching must reproduce that exactly — caching one start's resolution
    // would merge the walks and drop records.
    const a = JSON.stringify({ uuid: 'A', parentUuid: 'C', type: 'user', sessionId: SESSION_ID, timestamp: '2026-10-07T10:00:00.000Z', message: { role: 'user', content: '问题A' } })
    const b = JSON.stringify({ uuid: 'B', parentUuid: 'A', type: 'assistant', sessionId: SESSION_ID, timestamp: '2026-10-07T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '回答B' }] } })
    const c = JSON.stringify({ uuid: 'C', parentUuid: 'B', type: 'user', sessionId: SESSION_ID, timestamp: '2026-10-07T10:00:02.000Z', message: { role: 'user', content: '问题C' } })
    const d = JSON.stringify({ uuid: 'D', parentUuid: 'A', type: 'user', sessionId: SESSION_ID, timestamp: '2026-10-07T10:00:03.000Z', message: { role: 'user', content: '问题D' } })
    const e = JSON.stringify({ uuid: 'E', parentUuid: 'B', type: 'user', sessionId: SESSION_ID, timestamp: '2026-10-07T10:00:04.000Z', message: { role: 'user', content: '问题E' } })
    const data = parseClaudeSessionContent([a, b, c, d, e].join('\n') + '\n')
    const kinds = data.messages.map((m) => m.kind)
    expect(kinds).toEqual(['user-prompt', 'ai-text', 'user-prompt', 'user-prompt', 'user-prompt'])
    const texts = data.messages.filter((m) => m.kind === 'user-prompt').map((m) => m.kind === 'user-prompt' && m.text)
    expect(texts).toEqual(['问题A', '问题C', '问题D', '问题E'])
  })
})

describe('adversarial findings (review-driven)', () => {
  it('A1: falls back when a new delivery matches a frozen queued-attachment prompt', () => {
    seq = 0
    const lines: string[] = []
    const push = (line: string): string => {
      lines.push(line)
      return (JSON.parse(line) as { uuid: string }).uuid
    }
    const p1 = push(userPrompt('第一阶段问题', null))
    const a1 = push(assistant([{ type: 'text', text: '回答一' }], p1))
    push(rec('attachment', a1, { attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: '排队的命令' } }))
    const p2 = push(userPrompt('第二个问题', a1))
    push(assistant([{ type: 'text', text: '回答二' }], p2))
    const part1 = lines.join('\n') + '\n'
    // the queued text is later delivered as a real user record
    const delivery = userPrompt('排队的命令', p2)
    const full = part1 + delivery + '\n'

    const boot = parseClaudeSessionWithState(part1, 'testsha')
    expect(boot.data.messages.some((m) => m.kind === 'user-prompt' && m.queued && m.text === '排队的命令')).toBe(true)
    const continued = continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)
    expect(continued).toBeNull()
    // full parse dedupes: the queued copy is skipped, the delivery renders once
    const reference = parseClaudeSessionContent(full)
    const occurrences = reference.messages.filter((m) => m.kind === 'user-prompt' && m.text === '排队的命令').length
    expect(occurrences).toBe(1)
  })

  it('A2: a history retry absorbed by a fallback is not inlined by the next continuation', () => {
    seq = 0
    const lines: string[] = []
    const push = (line: string): string => {
      lines.push(line)
      return (JSON.parse(line) as { uuid: string }).uuid
    }
    const u1 = push(userPrompt('第一个问题', null))
    const u2 = push(assistant([{ type: 'text', text: '第一个回答' }], u1))
    const u3 = push(userPrompt('第二个问题', u2))
    const u4 = push(assistant([{ type: 'text', text: '第二个回答' }], u3))
    const part1 = lines.join('\n') + '\n'
    // a retry of the first turn arrives together with the main chain
    const retry = assistant([{ type: 'text', text: '重试的旧回答' }], u1)
    const main = assistant([{ type: 'text', text: '主链继续' }], u4)
    const retryUuid = (JSON.parse(retry) as { uuid: string }).uuid
    const mainUuid = (JSON.parse(main) as { uuid: string }).uuid
    const phase2 = part1 + retry + '\n' + main + '\n'
    // the retry's parent is frozen: the continuation must decline and fall back
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    expect(continueClaudeSessionWithState(phase2, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)).toBeNull()
    // full parse absorbs it correctly (retry lives only in the fork-indicator)
    const absorbed = parseClaudeSessionWithState(phase2, 'testsha')
    const forked = absorbed.data.messages.find((m) => m.kind === 'fork-indicator')
    expect(forked).toBeTruthy()
    expect(absorbed.data.messages.filter((m) => m.kind === 'ai-text' && m.text === '重试的旧回答').length).toBe(0)
    // the next continuation must not resurrect the abandoned branch inline
    const more = assistant([{ type: 'text', text: '追加的回答' }], mainUuid)
    const phase3 = phase2 + more + '\n'
    const continued = continueClaudeSessionWithState(phase3, { messages: absorbed.data.messages, prompts: absorbed.data.prompts }, absorbed.state)
    expect(continued).not.toBeNull()
    expect(JSON.stringify(continued!.data)).toBe(JSON.stringify(parseClaudeSessionContent(phase3)))
    expect(continued!.data.messages.filter((m) => m.kind === 'ai-text' && m.text === '重试的旧回答').length).toBe(0)
    void retryUuid
  })

  it('A3: falls back when a uuid-less compact summary arrives after its boundary is frozen', () => {
    seq = 0
    const lines: string[] = []
    const push = (line: string): string => {
      lines.push(line)
      return (JSON.parse(line) as { uuid?: string }).uuid ?? ''
    }
    push(userPrompt('压缩前的问题', null))
    const boundaryLine = JSON.stringify({
      uuid: uuid(), parentUuid: null, logicalParentUuid: null, type: 'system', subtype: 'compact_boundary',
      sessionId: SESSION_ID, timestamp: '2026-10-07T11:00:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 12345 },
    })
    lines.push(boundaryLine)
    const boundary = (JSON.parse(boundaryLine) as { uuid: string }).uuid
    const p1 = push(userPrompt('压缩后第一问', boundary))
    push(assistant([{ type: 'text', text: '回答' }], p1))
    const part1 = lines.join('\n') + '\n'
    // the summary record arrives late and carries no uuid of its own
    const summary = JSON.stringify({
      parentUuid: boundary, type: 'user', isCompactSummary: true, sessionId: SESSION_ID,
      timestamp: '2026-10-07T11:00:01.000Z', message: { role: 'user', content: '迟到的摘要' },
    })
    const full = part1 + summary + '\n'
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    expect(continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)).toBeNull()
    expect(JSON.stringify(parseClaudeSessionContent(full))).toContain('迟到的摘要')
  })

  it('C1: falls back when windowOffset is rolled back to a different record', () => {
    const { part1, full } = buildSession()
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    const rolled = { ...boot.state, windowOffset: 0 }
    expect(
      continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, rolled),
    ).toBeNull()
  })

  it('falls back when the uuid-path forgery points the window at a non-prompt record', () => {
    // Forgery recipe from the delta re-review: windowOffset advanced past the
    // window-head prompt to its assistant child, windowRecordUuid set to that
    // child, frozenMessageCount bumped, hashes re-stamped around the drift.
    // The universal head-text check must reject it: the assistant child did
    // not produce prompts[frozenPromptCount].
    const { part1, full } = buildSession()
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    expect(boot.state.windowRecordUuid).not.toBeNull()
    const headEnd = part1.indexOf('\n', boot.state.windowOffset)
    const headRecord = JSON.parse(part1.slice(boot.state.windowOffset, headEnd)) as { uuid: string }
    // find the assistant child of the head record inside the consumed window
    const windowTail = part1.slice(headEnd + 1, boot.state.consumedLength).trim().split('\n')
    const child = windowTail
      .map((l) => JSON.parse(l) as { uuid: string; parentUuid: string | null })
      .find((r) => r.parentUuid === headRecord.uuid)
    expect(child).toBeDefined()
    const childOffset = part1.indexOf(child!.uuid)
    const lineStart = part1.lastIndexOf('\n', childOffset) + 1
    const forged = {
      ...boot.state,
      windowOffset: lineStart,
      windowRecordUuid: child!.uuid,
      frozenMessageCount: boot.data.messages.length,
      lastUuid: child!.uuid,
    }
    expect(
      continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, forged),
    ).toBeNull()
  })

  it('C7: falls back when lastUuid does not match the consumed prefix tip', () => {
    const { part1, full } = buildSession()
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    const tampered = { ...boot.state, lastUuid: boot.state.lastUuid === null ? 'ffffffff-0000-4000-8000-000000000000' : 'ffffffff-0000-4000-8000-000000000000' }
    expect(
      continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, tampered),
    ).toBeNull()
  })
})

// --- Late-fork persistence + parent-check edge contracts (promoted from the
// adversarial re-review probes; each expectation encodes the CONTRACT) ---

function buildRetryShapes() {
  seq = 0
  let clock = 0
  const ts = (): string => {
    clock += 1
    return `2026-10-07T10:00:${String(clock % 60).padStart(2, '0')}.000Z`
  }
  const recT = (type: string, parent: string | null, extra: Record<string, unknown>): string =>
    JSON.stringify({ uuid: uuid(), parentUuid: parent, type, sessionId: SESSION_ID, timestamp: ts(), ...extra })
  const upT = (text: string, parent: string | null): string =>
    recT('user', parent, { message: { role: 'user', content: text } })
  const asT = (text: string, parent: string | null): string =>
    recT('assistant', parent, { message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const uOf = (line: string): string => (JSON.parse(line) as { uuid: string }).uuid

  const lines: string[] = []
  const push = (line: string): string => { lines.push(line); return uOf(line) }
  const u1 = push(upT('第一个问题', null))
  const u2 = push(asT('第一个回答', u1))
  const u3 = push(upT('第二个问题', u2))
  const u4 = push(asT('第二个回答', u3))
  const part1 = lines.join('\n') + '\n'
  // a retry that forks off frozen history, then the main chain grows past it
  const retry = asT('重试的旧回答', u1)
  const main = asT('主链继续', u4)
  const phase2 = part1 + retry + '\n' + main + '\n'
  return { part1, phase2, retryUuid: uOf(retry), mainUuid: uOf(main), asT, uOf }
}

describe('late-fork contracts', () => {
  it('the skip set SURVIVES into the state stamped by the next continuation', () => {
    const { phase2, mainUuid, asT, uOf } = buildRetryShapes()
    const absorbed = parseClaudeSessionWithState(phase2, 'testsha') // full parse after fallback
    expect(absorbed.state.lateForkUuids.length).toBe(1)
    const more1 = asT('追加一', mainUuid)
    const phase3 = phase2 + more1 + '\n'
    const cont1 = continueClaudeSessionWithState(phase3, { messages: absorbed.data.messages, prompts: absorbed.data.prompts }, absorbed.state)
    expect(cont1).not.toBeNull()
    expect(JSON.stringify(cont1!.data)).toBe(JSON.stringify(parseClaudeSessionContent(phase3)))
    // CONTRACT: the skip set persists — dropping it resurrects the abandoned
    // branch one continuation later (the frozen region is identical, so the
    // skip judgment is unchanged).
    expect(cont1!.state.lateForkUuids).toEqual(absorbed.state.lateForkUuids)
    const more2 = asT('追加二', uOf(more1))
    const phase4 = phase3 + more2 + '\n'
    const cont2 = continueClaudeSessionWithState(phase4, { messages: cont1!.data.messages, prompts: cont1!.data.prompts }, cont1!.state)
    expect(cont2).not.toBeNull()
    // byte-identical to full parse at EVERY continuation depth
    expect(JSON.stringify(cont2!.data)).toBe(JSON.stringify(parseClaudeSessionContent(phase4)))
  })

  it('falls back when a new record chains to a window late-fork (full parse would re-tip)', () => {
    const { phase2, retryUuid, mainUuid, asT } = buildRetryShapes()
    const absorbed = parseClaudeSessionWithState(phase2, 'testsha')
    // child of the abandoned retry, plus main-chain growth, arrive together
    const forkChild = asT('fork 上的回复', retryUuid)
    const main2 = asT('主链再走', mainUuid)
    const phase3 = phase2 + forkChild + '\n' + main2 + '\n'
    const cont = continueClaudeSessionWithState(phase3, { messages: absorbed.data.messages, prompts: absorbed.data.prompts }, absorbed.state)
    // full parse re-tips to the fork child: the retry becomes ACTIVE and the
    // main chain beyond the fork point becomes abandoned — nothing incremental
    // can reproduce that; the continuation MUST decline.
    expect(cont).toBeNull()
    // and the full parse it falls back to does re-tip (probe premise)
    const fullData = JSON.stringify(parseClaudeSessionContent(phase3))
    expect(fullData).toContain('fork 上的回复')
  })

  it('A1 dedup never fires on another queued attachment (only real deliveries)', () => {
    seq = 0
    let clock = 0
    const ts = (): string => {
      clock += 1
      return `2026-10-07T10:00:${String(clock % 60).padStart(2, '0')}.000Z`
    }
    const att = (text = '相同的排队命令') => JSON.stringify({ type: 'attachment', sessionId: SESSION_ID, timestamp: ts(), attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: text } })
    const lines: string[] = []
    const p1 = userPrompt('起始问题', null); lines.push(p1)
    const p1u = (JSON.parse(p1) as { uuid: string }).uuid
    lines.push(assistant([{ type: 'text', text: '起始回答' }], p1u))
    lines.push(att())
    const r2 = att(); lines.push(r2)
    const part1 = lines.join('\n') + '\n'
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    expect(boot.state.windowRecordUuid).toBeNull()
    expect(boot.state.windowOffset).toBe(part1.indexOf(r2))
    // a real delivery chained to the CURRENT TIP (a1 is the tip: the queued
    // attachments are uuid-less and never advance it) continues byte-identically
    const a1Line = lines[1]
    const a1u = (JSON.parse(a1Line) as { uuid: string }).uuid
    const delivery = userPrompt('后续问题', a1u)
    const full = part1 + delivery + '\n'
    const ok = continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)
    expect(ok).not.toBeNull()
    expect(JSON.stringify(ok!.data)).toBe(JSON.stringify(parseClaudeSessionContent(full)))
    // a real delivery chained to a NON-TIP frozen record is a retry of frozen
    // history: full parse re-tips, the continuation must decline
    const retry = userPrompt('回到起点再试', p1u)
    const retryFull = part1 + retry + '\n'
    expect(continueClaudeSessionWithState(retryFull, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)).toBeNull()
    // a real delivery matching a frozen queued prompt's TEXT trips A1 dedup:
    // full parse would skip the already-published frozen copy, which only a
    // full parse can repair — conservative fallback, correct output.
    const delivered = JSON.stringify({ uuid: uuid(), parentUuid: p1u, type: 'user', sessionId: SESSION_ID, timestamp: ts(), message: { role: 'user', content: '相同的排队命令' } })
    const deliveredFull = part1 + delivered + '\n'
    expect(continueClaudeSessionWithState(deliveredFull, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)).toBeNull()
    // a second identical queued ATTACHMENT arriving later must NOT trip the
    // dedup scan: full parse renders both attachments, so the continuation
    // stays byte-identical without a fallback.
    const again = part1 + att() + '\n'
    const cont = continueClaudeSessionWithState(again, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)
    expect(cont).not.toBeNull()
    expect(JSON.stringify(cont!.data)).toBe(JSON.stringify(parseClaudeSessionContent(again)))
  })

  it('a genuine uuid-less window head continues byte-identically (regression: no head-text false fallback)', () => {
    // Same shape as above but the two queued attachments carry DIFFERENT
    // texts, so the head text is unambiguous — the genuine continuation must
    // be accepted (and is, byte-identically). The companion tampered shape
    // (offset rolled back to a same-text sibling) is accepted BY DESIGN:
    // uuid-less identical-text heads are positionally ambiguous, and the
    // contract only requires the tampered output to differ from full parse
    // in a way that forces nothing — it renders the same records with a
    // shifted prompt numbering, a divergence confined to that corrupt-state
    // shape. Real Claude JSONL prompt records carry uuids, which bind the
    // head exactly; this test pins the genuine side so the exemption for
    // uuid-less heads never eats a healthy continuation.
    seq = 0
    let clock = 0
    const ts = (): string => {
      clock += 1
      return `2026-10-07T10:00:${String(clock % 60).padStart(2, '0')}.000Z`
    }
    const att = (text: string) => JSON.stringify({ type: 'attachment', sessionId: SESSION_ID, timestamp: ts(), attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: text } })
    const lines: string[] = []
    const p1 = userPrompt('起始问题', null); lines.push(p1)
    const p1u = (JSON.parse(p1) as { uuid: string }).uuid
    lines.push(assistant([{ type: 'text', text: '起始回答' }], p1u))
    lines.push(att('第一条排队命令'))
    lines.push(att('第二条排队命令'))
    const part1 = lines.join('\n') + '\n'
    const boot = parseClaudeSessionWithState(part1, 'testsha')
    expect(boot.state.windowRecordUuid).toBeNull()
    const a1u = (JSON.parse(lines[1]) as { uuid: string }).uuid
    const delivery = userPrompt('后续问题', a1u)
    const full = part1 + delivery + '\n'
    const ok = continueClaudeSessionWithState(full, { messages: boot.data.messages, prompts: boot.data.prompts }, boot.state)
    expect(ok).not.toBeNull()
    expect(JSON.stringify(ok!.data)).toBe(JSON.stringify(parseClaudeSessionContent(full)))
  })
})
