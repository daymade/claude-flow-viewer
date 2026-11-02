import { describe, expect, it, vi } from 'vitest'
import {
  parseCodexMessagesStreaming,
  parseCodexSessionContentStreaming,
  type CodexMessageCoordinate,
} from '../codex-parser'
import type { SessionMessage } from '../../types/session'

const yieldNow = async () => {}
async function* lines(records: unknown[]) {
  for (const record of records) yield JSON.stringify(record)
}
const at = '2026-11-03T00:00:00.000Z'
const event = (payload: Record<string, unknown>) => ({ timestamp: at, type: 'event_msg', payload })

describe('canonical Codex message sink', () => {
  it('matches full messages and physical coordinates, including MCP pairs and compact rereads', async () => {
    const records = [
      { type: 'session_meta', timestamp: at, payload: { timestamp: at, cwd: '/fixture' } },
      event({ type: 'user_message', message: 'inspect the complete original' }),
      event({ type: 'mcp_tool_call_end', invocation: { server: 'fixture', tool: 'read', arguments: { n: 1 } }, result: { Ok: { content: [{ type: 'text', text: 'complete' }], isError: false } } }),
      { timestamp: at, type: 'compacted', payload: { replacement_history: [{ role: 'user', content: 'retained question' }] } },
      { timestamp: at, type: 'world_state', payload: {} },
      event({ type: 'context_compacted' }),
      event({ type: 'agent_message', message: 'visible after compaction' }),
      event({ type: 'context_compacted' }),
    ]
    const full = await parseCodexSessionContentStreaming(lines(records), yieldNow)
    const messages: Readonly<SessionMessage>[] = []
    const coordinates: CodexMessageCoordinate[] = []
    const scan = await parseCodexMessagesStreaming(lines(records), yieldNow, (message, coordinate) => {
      messages.push(message)
      coordinates.push(coordinate)
    })
    expect(messages).toEqual(full.messages)
    expect(coordinates.map(c => c.messageIndex)).toEqual(messages.map((_, i) => i))
    expect(coordinates.map(c => c.recordIndex)).toEqual([1, 2, 2, 3, 6, 7])
    expect(messages.map(m => m.sourceRecord)).toEqual(coordinates.map(c => records[c.recordIndex]))
    expect(messages[1].sourceRecord).toBe(messages[2].sourceRecord)
    expect(full.markers.compacts).toBe(2)
    expect(scan).toEqual({ source: 'codex', messageCount: 6, recordCount: 8 })
    expect(Object.keys(scan).sort()).toEqual(['messageCount', 'recordCount', 'source'])
  })

  it('preserves fallback clock calls and the accepted-prompt time window', async () => {
    const RealDate = Date
    const trace: number[] = []
    let tick = 0
    class ObservedDate extends RealDate {
      constructor(value?: string | number) {
        if (value === undefined) {
          const now = RealDate.UTC(2026, 10, 3) + tick++ * 1100
          trace.push(now)
          super(now)
        } else super(value)
      }
    }
    const records = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' } },
      { type: 'world_state', payload: {} },
      { type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' } },
    ]
    vi.stubGlobal('Date', ObservedDate)
    try {
      const full = await parseCodexSessionContentStreaming(lines(records), yieldNow)
      const originalTrace = [...trace]
      tick = 0
      trace.length = 0
      const messages: Readonly<SessionMessage>[] = []
      await parseCodexMessagesStreaming(lines(records), yieldNow, message => { messages.push(message) })
      expect(messages).toEqual(full.messages)
      expect(trace).toEqual(originalTrace)
      expect(trace).toHaveLength(3)
      expect(full.prompts).toHaveLength(2)
    } finally { vi.unstubAllGlobals() }
  })

  it('still rejects malformed retained history during finalization in both APIs', async () => {
    const records = [{ timestamp: at, type: 'compacted', payload: { replacement_history: [
      { role: 'user', content: [{ type: 'input_text', text: { toString: 'not callable' } }] },
    ] } }]
    await expect(parseCodexSessionContentStreaming(lines(records), yieldNow)).rejects.toThrow(TypeError)
    const sink = vi.fn()
    await expect(parseCodexMessagesStreaming(lines(records), yieldNow, sink)).rejects.toThrow(TypeError)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing recordSelection contract separate from complete sink emission', async () => {
    const records = [
      event({ type: 'user_message', message: 'first' }),
      event({ type: 'agent_message', message: 'second' }),
      event({ type: 'agent_message', message: 'third' }),
    ]
    const selections: number[] = []
    const selected = await parseCodexSessionContentStreaming(lines(records), yieldNow, {
      recordSelection: (_record, index) => { selections.push(index); return index === 2 },
    })
    expect(selections).toEqual([0, 1, 2])
    expect(selected.messages).toHaveLength(1)
    expect(selected.messages[0].sourceRecordId).toBe('codex-record-2')
    const sink = vi.fn()
    const scan = await parseCodexMessagesStreaming(lines(records), yieldNow, sink)
    expect(scan.messageCount).toBe(3)
    expect(sink).toHaveBeenCalledTimes(3)
  })

  it('rejects sink failures instead of resolving a partial scan', async () => {
    const records = [event({ type: 'agent_message', message: 'first' }), event({ type: 'agent_message', message: 'second' })]
    const failure = new Error('sink rejected output')
    const sink = vi.fn(() => { throw failure })
    await expect(parseCodexMessagesStreaming(lines(records), yieldNow, sink)).rejects.toBe(failure)
    expect(sink).toHaveBeenCalledTimes(1)
    await expect(parseCodexMessagesStreaming(lines(records), yieldNow, async () => {})).rejects.toThrow('must be synchronous')
  })
})
