import { describe, expect, it } from 'vitest'
import { continueClaudeSessionWithState, parseClaudeSessionContent, parseClaudeSessionWithState, type ClaudeParserState } from './claude'

const timestamp = '2026-10-09T10:00:00.000Z'
function record(uuid: string | undefined, type: string, parentUuid: string | null, extra: Record<string, unknown>) {
  return { uuid, type, parentUuid, timestamp, ...extra }
}
function content(records: Record<string, unknown>[]) {
  return records.map(item => JSON.stringify(item)).join('\n') + '\n'
}
function toolSession() {
  return [
    record('prompt', 'user', null, { message: { content: 'Delegate and collect results' } }),
    record('calls', 'assistant', 'prompt', { message: { content: [
      { type: 'text', text: 'Dispatching' },
      { type: 'thinking', thinking: 'Consider both results' },
      { type: 'tool_use', id: 'call-one', name: 'Agent', input: { prompt: 'first' } },
      { type: 'tool_use', id: 'call-two', name: 'Agent', input: { prompt: 'second' } },
    ] } }),
    // Results arrive in the opposite order, separated by an unrelated record.
    record('result-two', 'user', 'calls', { message: { content: [
      { type: 'tool_result', tool_use_id: 'call-two', content: 'second result' },
    ] } }),
    record('attachment', 'attachment', 'calls', { attachment: { type: 'ignored' } }),
    record('result-one', 'user', 'calls', { message: { content: [
      { type: 'tool_result', tool_use_id: 'call-one', content: 'first result' },
    ] } }),
    record('answer', 'assistant', 'result-one', { message: { content: [{ type: 'text', text: 'Collected' }] } }),
  ]
}

describe('Claude message provenance', () => {
  it('shares the source UUID across content blocks and pairs tools using native IDs', () => {
    const data = parseClaudeSessionContent(content(toolSession()))
    const calls = data.messages.filter(message => message.sourceRecordId === 'calls')
    expect(calls.map(message => message.kind)).toEqual(['ai-text', 'ai-thinking', 'ai-tool-use', 'ai-tool-use'])
    expect(calls.filter(message => message.kind === 'ai-tool-use').map(message => message.toolUseId)).toEqual(['call-one', 'call-two'])
    const results = data.messages.filter(message => message.kind === 'tool-result')
    expect(results).toHaveLength(2)
    expect(results.map(message => [message.content, message.toolUseId, message.sourceRecordId])).toEqual(expect.arrayContaining([
      ['first result', 'call-one', 'result-one'], ['second result', 'call-two', 'result-two'],
    ]))
    expect(data.messages.find(message => message.kind === 'user-prompt')?.sourceRecordId).toBe('prompt')
  })

  it('does not invent record or tool IDs when they are missing, empty, or not strings', () => {
    const data = parseClaudeSessionContent(content([
      record(undefined, 'assistant', null, { message: { content: [
        { type: 'tool_use', name: 'Agent', input: { name: 'call-one' } },
        { type: 'tool_use', id: '', name: 'Agent', input: {} },
        { type: 'tool_use', id: 42, name: 'Agent', input: {} },
      ] } }),
      record(undefined, 'user', null, { message: { content: [
        { type: 'tool_result', content: 'no id' },
        { type: 'tool_result', tool_use_id: '', content: 'empty id' },
      ] } }),
    ]))
    expect(data.messages).toHaveLength(5)
    for (const message of data.messages) {
      expect(message).not.toHaveProperty('sourceRecordId')
      expect(message).not.toHaveProperty('toolUseId')
    }
  })

  it('retains teammate, task notification, compact, and clear record identities', () => {
    const data = parseClaudeSessionContent(content([
      record('team', 'user', null, { message: { content: '<teammate-message teammate_id="reviewer" summary="Done">Returned findings</teammate-message>' } }),
      record('task', 'user', 'team', { message: { content: '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Done</summary></task-notification>' } }),
      record('compact', 'system', null, { logicalParentUuid: 'task', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 123 } }),
      record('summary', 'user', 'compact', { isCompactSummary: true, message: { content: 'Preserved summary' } }),
      record('clear', 'user', 'summary', { message: { content: '<command-name>/clear</command-name>' } }),
    ]))
    expect(data.messages.map(message => [message.kind, message.sourceRecordId])).toEqual([
      ['team-message', 'team'], ['task-event', 'task'], ['compact-boundary', 'compact'], ['clear-divider', 'clear'],
    ])
    expect(data.messages.find(message => message.kind === 'compact-boundary')).toMatchObject({ summaryText: 'Preserved summary' })
  })

  it('treats whitespace-only IDs as unknown while preserving meaningful IDs verbatim', () => {
    const data = parseClaudeSessionContent(content([
      record(' \t ', 'assistant', null, { message: { content: [
        { type: 'tool_use', id: ' \t ', name: 'Agent', input: {} },
        { type: 'tool_use', id: ' call-one ', name: 'Agent', input: {} },
      ] } }),
      record(' result ', 'user', null, { message: { content: [
        { type: 'tool_result', tool_use_id: '\n\t', content: 'unknown' },
        { type: 'tool_result', tool_use_id: ' call-one ', content: 'preserved' },
      ] } }),
    ]))
    const tools = data.messages.filter(message => message.kind === 'ai-tool-use')
    expect(tools).toHaveLength(2)
    expect(tools[0]).not.toHaveProperty('sourceRecordId')
    expect(tools[0]).not.toHaveProperty('toolUseId')
    expect(tools[1]).toMatchObject({ toolUseId: ' call-one ' })
    expect(tools[1]).not.toHaveProperty('sourceRecordId')
    const results = data.messages.filter(message => message.kind === 'tool-result')
    expect(results[0]).toMatchObject({ sourceRecordId: ' result ' })
    expect(results[0]).not.toHaveProperty('toolUseId')
    expect(results[1]).toMatchObject({ sourceRecordId: ' result ', toolUseId: ' call-one ' })
  })

  it('preserves provenance within abandoned branches and identifies the actual fork point', () => {
    const data = parseClaudeSessionContent(content([
      record('root', 'user', null, { message: { content: 'Start' } }),
      record('old', 'assistant', 'root', { message: { content: [{ type: 'tool_use', id: 'old-call', name: 'Agent', input: {} }] } }),
      record('new', 'assistant', 'root', { message: { content: [{ type: 'text', text: 'New branch' }] } }),
    ]))
    const fork = data.messages.find(message => message.kind === 'fork-indicator')
    expect(fork).toMatchObject({ sourceRecordId: 'root', abandonedMessages: [
      { kind: 'ai-tool-use', sourceRecordId: 'old', toolUseId: 'old-call' },
    ] })
  })

  it('keeps queued attachments and derived plan markers bound to their source records', () => {
    const data = parseClaudeSessionContent(content([
      record('prompt', 'user', null, { message: { content: 'Plan this' } }),
      record('plan-enter', 'assistant', 'prompt', { message: { content: [{ type: 'tool_use', id: 'enter', name: 'EnterPlanMode', input: {} }] } }),
      record('queued', 'attachment', 'plan-enter', { attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: 'Also check this' } }),
      record('plan-exit', 'assistant', 'plan-enter', { message: { content: [{ type: 'tool_use', id: 'exit', name: 'ExitPlanMode', input: { plan: 'The plan' } }] } }),
    ]))
    expect(data.messages.find(message => message.kind === 'plan-start')?.sourceRecordId).toBe('plan-enter')
    expect(data.messages.find(message => message.kind === 'plan-end')?.sourceRecordId).toBe('plan-exit')
    expect(data.messages.find(message => message.kind === 'user-prompt' && message.queued)?.sourceRecordId).toBe('queued')
  })

  it('keeps frozen and appended provenance byte-identical between full and incremental parsing', () => {
    const records = toolSession()
    records.push(record('second-prompt', 'user', 'answer', { message: { content: 'Continue' } }))
    const initial = parseClaudeSessionWithState(content(records))
    expect(initial.state.frozenMessageCount).toBeGreaterThan(0)
    const full = content([...records,
      record('team-return', 'user', 'second-prompt', { message: { content: '<teammate-message teammate_id="reviewer">Returned</teammate-message>' } }),
      record('last', 'assistant', 'team-return', { message: { content: [{ type: 'text', text: 'Done' }] } }),
    ])
    const incremental = continueClaudeSessionWithState(full, initial.data, initial.state)
    expect(incremental).not.toBeNull()
    expect(JSON.stringify(incremental?.data)).toBe(JSON.stringify(parseClaudeSessionContent(full)))
    expect(incremental?.data.messages.find(message => message.kind === 'team-message')?.sourceRecordId).toBe('team-return')
  })

  it('rejects legacy state so frozen output without provenance cannot be reused', () => {
    const initial = parseClaudeSessionWithState(content(toolSession()))
    const legacy = { ...initial.state, version: 2 } as unknown as ClaudeParserState
    const full = content([...toolSession(), record('next', 'user', 'answer', { message: { content: 'Next' } })])
    expect(continueClaudeSessionWithState(full, initial.data, legacy)).toBeNull()
  })
})
