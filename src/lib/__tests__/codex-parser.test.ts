import { describe, expect, it } from 'vitest'
import {
  makeCodexProjectId,
  parseCodexSessionContent,
  parseCodexSessionContentStreaming,
  quickScanCodexMetadata,
} from '../codex-parser'
import { parseSessionContent } from '../parser'

function jsonl(...records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

function formatLocalTime(timestamp: string): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function responseMessage(role: string, text: string): Record<string, unknown> {
  const contentType = role === 'assistant' ? 'output_text' : 'input_text'
  return {
    timestamp: '2026-03-09T10:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: contentType, text }],
    },
  }
}

describe('codex parsing', () => {
  it('auto-detects and normalizes codex session content', () => {
    const content = jsonl(
      {
        timestamp: '2026-03-09T09:59:59.000Z',
        type: 'session_meta',
        payload: {
          id: '019cd000-0000-7000-8000-000000000001',
          timestamp: '2026-03-09T09:59:59.000Z',
          cwd: '/Users/test/workspace/decision-viewer',
        },
      },
      {
        timestamp: '2026-03-09T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      responseMessage('user', 'Ship the parser'),
      {
        timestamp: '2026-03-09T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Thinking through the parse pipeline' }],
        },
      },
      {
        timestamp: '2026-03-09T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"rg --files"}',
        },
      },
      {
        timestamp: '2026-03-09T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: '{"output":"src/App.tsx\\nsrc/lib/parser.ts","metadata":{"exit_code":0}}',
        },
      },
      {
        timestamp: '2026-03-09T10:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 2 },
      },
      {
        timestamp: '2026-03-09T10:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', reason: 'interrupted' },
      },
      responseMessage('user', 'No, use the current repository'),
      responseMessage('assistant', 'Done. I used the current repository.'),
      {
        timestamp: '2026-03-09T10:00:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'Finished the parser update',
        },
      },
    )

    const result = parseSessionContent(content)

    expect(result.source).toBe('codex')

    const prompts = result.messages.filter((message) => message.kind === 'user-prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Ship the parser', decision: 'none' })
    expect(prompts[1]).toMatchObject({ promptNum: 2, text: 'No, use the current repository', decision: 'interrupt' })

    expect(result.messages.some((message) => message.kind === 'task-event' && message.status === 'started')).toBe(true)
    const rollbackMarker = result.messages.find((message) => message.kind === 'rollback-marker')
    expect(rollbackMarker).toBeDefined()
    expect(rollbackMarker).toMatchObject({
      kind: 'rollback-marker',
      timestamp: formatLocalTime('2026-03-09T10:00:04.000Z'),
      numTurns: 2,
    })
    expect(result.messages.some((message) => message.kind === 'ai-thinking' && message.preview.includes('Thinking through the parse pipeline'))).toBe(true)
    expect(result.messages.some((message) => message.kind === 'ai-tool-use' && message.summary.includes('rg --files'))).toBe(true)
    expect(result.messages.some((message) => message.kind === 'tool-result' && message.content.includes('src/App.tsx'))).toBe(true)
    expect(result.messages.some((message) => message.kind === 'ai-text' && message.text === 'Done. I used the current repository.')).toBe(true)
    expect(result.messages.some((message) => message.kind === 'task-event' && message.status === 'completed')).toBe(true)
    expect(result.markers.forks).toBe(1)
  })

  it('ignores bootstrap user instructions in codex sessions', () => {
    const content = jsonl(
      {
        timestamp: '2026-03-09T09:59:59.000Z',
        type: 'session_meta',
        payload: {
          id: '019cd000-0000-7000-8000-000000000002',
          timestamp: '2026-03-09T09:59:59.000Z',
          cwd: '/Users/test/workspace/decision-viewer',
        },
      },
      responseMessage('user', '# AGENTS.md instructions for /tmp/example'),
      responseMessage('user', 'Actual request'),
    )

    const result = parseSessionContent(content, 'codex')
    const prompts = result.messages.filter((message) => message.kind === 'user-prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Actual request' })
  })

  it('keeps subagent notifications as structured updates without counting them as prompts', () => {
    const content = jsonl(
      {
        timestamp: '2026-03-09T09:59:59.000Z',
        type: 'session_meta',
        payload: {
          id: '019cd000-0000-7000-8000-000000000004',
          timestamp: '2026-03-09T09:59:59.000Z',
          cwd: '/Users/test/workspace/decision-viewer',
        },
      },
      responseMessage('user', '<subagent_notification>{"agent_id":"worker-1","status":{"completed":"done"}}</subagent_notification>'),
      responseMessage('user', 'Resume the real task'),
    )

    const result = parseSessionContent(content, 'codex')
    const prompts = result.messages.filter((message) => message.kind === 'user-prompt')
    const update = result.messages.find((message) => message.kind === 'delegation-update')

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Resume the real task' })
    expect(update).toMatchObject({
      kind: 'delegation-update',
      agentId: 'worker-1',
      status: 'completed',
      summary: 'done',
    })
  })

  it('parses current Codex event messages and object-shaped tool outputs', () => {
    const content = jsonl(
      {
        timestamp: '2026-06-29T04:00:29.000Z',
        type: 'session_meta',
        payload: {
          id: '019f1189-2820-7371-99ea-d0fb51025384',
          timestamp: '2026-06-29T04:00:29.000Z',
          cwd: '/Users/test/workspace/research',
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '打开 Kimi 查询仙工智能报告',
          images: [],
          local_images: [],
          text_elements: [],
        },
      },
      {
        timestamp: '2026-06-29T04:00:31.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: '我会先读取工具说明，再打开 Kimi。',
          phase: 'commentary',
        },
      },
      {
        timestamp: '2026-06-29T04:00:32.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          arguments: { query: 'computer use', limit: 8 },
        },
      },
      {
        timestamp: '2026-06-29T04:00:33.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          status: 'completed',
          tools: [
            {
              type: 'namespace',
              name: 'mcp__computer_use',
              tools: [{ type: 'function', name: 'get_app_state' }],
            },
          ],
        },
      },
      {
        timestamp: '2026-06-29T04:00:34.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          invocation: {
            server: 'computer-use',
            tool: 'get_app_state',
            arguments: { app: 'Kimi' },
          },
          result: {
            Ok: {
              content: [
                { type: 'text', text: 'Window: Kimi' },
              ],
            },
          },
        },
      },
      {
        timestamp: '2026-06-29T04:00:35.000Z',
        type: 'compacted',
        payload: {},
      },
    )

    const result = parseSessionContent(content, 'codex')
    const promptMessages = result.messages.filter((message) => message.kind === 'user-prompt')
    const toolCalls = result.messages.filter((message) => message.kind === 'ai-tool-use')
    const toolResults = result.messages.filter((message) => message.kind === 'tool-result')

    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0]).toMatchObject({ text: '打开 Kimi 查询仙工智能报告' })
    expect(result.messages.some((message) => message.kind === 'ai-text' && message.text.includes('读取工具说明'))).toBe(true)
    expect(toolCalls).toHaveLength(2)
    expect(toolResults.some((message) => message.content.includes('mcp__computer_use.get_app_state'))).toBe(true)
    expect(toolResults.some((message) => message.content.includes('Window: Kimi'))).toBe(true)
    expect(toolResults.every((message) => !message.content.includes('[object Object]'))).toBe(true)
    expect(result.markers.compacts).toBe(1)
  })

  it('preserves MCP Ok error status on current Codex tool events', () => {
    const content = jsonl(
      {
        timestamp: '2026-06-29T04:00:29.000Z',
        type: 'session_meta',
        payload: {
          id: '019f1189-2820-7371-99ea-d0fb51025384',
          timestamp: '2026-06-29T04:00:29.000Z',
          cwd: '/Users/test/workspace/research',
        },
      },
      {
        timestamp: '2026-06-29T04:00:34.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          invocation: {
            server: 'computer-use',
            tool: 'click',
            arguments: { x: 10, y: 20 },
          },
          result: {
            Ok: {
              isError: true,
              content: [
                { type: 'text', text: 'Element not found' },
              ],
            },
          },
        },
      },
    )

    const result = parseSessionContent(content, 'codex')
    const toolResult = result.messages.find((message) => message.kind === 'tool-result')

    expect(toolResult).toMatchObject({
      kind: 'tool-result',
      content: 'Element not found',
      isError: true,
    })
  })

  it('deduplicates mixed event_msg and response_item user prompt shapes', () => {
    const content = jsonl(
      {
        timestamp: '2026-06-29T04:00:29.000Z',
        type: 'session_meta',
        payload: {
          id: '019f1189-2820-7371-99ea-d0fb51025384',
          timestamp: '2026-06-29T04:00:29.000Z',
          cwd: '/Users/test/workspace/research',
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '打开 Kimi 查询仙工智能报告',
          text_elements: [{ type: 'text', text: '打开 Kimi 查询仙工智能报告' }],
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '打开 Kimi 查询仙工智能报告' }],
        },
      },
    )

    const result = parseSessionContent(content, 'codex')
    const promptMessages = result.messages.filter((message) => message.kind === 'user-prompt')

    expect(promptMessages).toHaveLength(1)
    expect(promptMessages[0]).toMatchObject({
      promptNum: 1,
      text: '打开 Kimi 查询仙工智能报告',
    })
    expect(result.prompts).toHaveLength(1)
  })
})

describe('codex quick scan', () => {
  it('extracts metadata from a truncated session_meta head', () => {
    const head = '{"timestamp":"2026-03-09T09:59:59.000Z","type":"session_meta","payload":{"id":"019cd000-0000-7000-8000-000000000003","timestamp":"2026-03-09T09:59:59.000Z","cwd":"/Users/test/workspace/decision-viewer","base_instructions":{"text":"'

    const result = quickScanCodexMetadata(head, '019cd000-0000-7000-8000-000000000003', 4096, 'Parser maintenance')

    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      cwd: '/Users/test/workspace/decision-viewer',
      projectEncoded: makeCodexProjectId('/Users/test/workspace/decision-viewer'),
      meta: {
        source: 'codex',
        id: '019cd000-0000-7000-8000-000000000003',
        firstPromptPreview: 'Parser maintenance',
      },
    })
  })

  it('extracts subagent thread metadata when it is present in session_meta', () => {
    const head = jsonl({
      timestamp: '2026-03-09T09:59:59.000Z',
      type: 'session_meta',
      payload: {
        id: '019cd000-0000-7000-8000-000000000005',
        timestamp: '2026-03-09T09:59:59.000Z',
        cwd: '/Users/test/workspace/decision-viewer',
        forked_from_id: '019cd000-parent',
        agent_nickname: 'Galileo',
        agent_role: 'worker',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: '019cd000-parent',
              depth: 1,
            },
          },
        },
      },
    })

    const result = quickScanCodexMetadata(head, '019cd000-0000-7000-8000-000000000005', 4096, 'Subagent task')

    expect(result).toMatchObject({
      meta: {
        threadKind: 'subagent',
        parentSessionId: '019cd000-parent',
        agentName: 'Galileo',
        agentRole: 'worker',
      },
    })
  })

  it('counts prompts and tool calls from the head when Codex writes event_msg records', () => {
    const head = jsonl(
      {
        timestamp: '2026-06-29T04:00:29.000Z',
        type: 'session_meta',
        payload: {
          id: '019f1189-2820-7371-99ea-d0fb51025384',
          timestamp: '2026-06-29T04:00:29.000Z',
          cwd: '/Users/test/workspace/research',
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '打开 Kimi 查询仙工智能报告',
          images: [],
          local_images: [],
          text_elements: [],
        },
      },
      {
        timestamp: '2026-06-29T04:00:32.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          arguments: { query: 'computer use' },
        },
      },
    )

    const result = quickScanCodexMetadata(head, '019f1189-2820-7371-99ea-d0fb51025384', 2048)

    expect(result?.meta.firstPromptPreview).toBe('打开 Kimi 查询仙工智能报告')
    expect(result?.meta.promptCount).toBe(1)
    expect(result?.meta.toolCount).toBe(1)
    expect(result?.meta.recordCount).toBe(3)
  })

  it('deduplicates mixed prompt shapes during quick scan', () => {
    const head = jsonl(
      {
        timestamp: '2026-06-29T04:00:29.000Z',
        type: 'session_meta',
        payload: {
          id: '019f1189-2820-7371-99ea-d0fb51025384',
          timestamp: '2026-06-29T04:00:29.000Z',
          cwd: '/Users/test/workspace/research',
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '打开 Kimi 查询仙工智能报告',
          text_elements: [{ type: 'text', text: '打开 Kimi 查询仙工智能报告' }],
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '打开 Kimi 查询仙工智能报告' }],
        },
      },
    )

    const result = quickScanCodexMetadata(head, '019f1189-2820-7371-99ea-d0fb51025384', 2048)

    expect(result?.meta.firstPromptPreview).toBe('打开 Kimi 查询仙工智能报告')
    expect(result?.meta.promptCount).toBe(1)
    expect(result?.meta.recordCount).toBe(3)
  })

  it('recovers exact user inputs retained only by the last Codex compaction', () => {
    const content = jsonl(
      {
        timestamp: '2026-08-26T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a039be-f86d-7203-b821-1d72370e1b69',
          timestamp: '2026-08-26T00:00:00.000Z',
          cwd: '/Users/test/workspace/pkm',
        },
      },
      {
        timestamp: '2026-08-26T02:00:00.000Z',
        type: 'compacted',
        payload: {
          replacement_history: [
            { role: 'user', content: [{ type: 'input_text', text: '先看我们以前是怎么做的' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
            { role: 'user', content: [{ type: 'input_text', text: '<skill><name>injected</name></skill>' }] },
            { role: 'user', content: [{ type: 'input_text', text: '不要重新开启一轮试错' }] },
          ],
        },
      },
      {
        timestamp: '2026-08-26T02:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续当前工作' }],
        },
      },
    )

    const result = parseSessionContent(content)

    expect(result.prompts).toHaveLength(1)
    expect(result.prompts[0]).toMatchObject({
      fullText: '继续当前工作',
      timestamp: '2026-08-26T02:01:00.000Z',
    })
    expect(result.retainedUserInputs).toEqual([
      expect.objectContaining({
        // The compacted record is records[1] (session_meta, compacted, response_item), so its
        // own array position — not the retained entry's ordinal — is what "1" in the id refers to.
        // Pinned here because nothing else in this suite checks it, and it is the one value that
        // silently goes wrong if a future change mis-times when the classifier's per-record index
        // counter advances relative to an early return.
        id: 'compacted-1-0',
        text: '先看我们以前是怎么做的',
        origin: 'compacted',
        timeRangeStart: '2026-08-26T00:00:00.000Z',
        timeRangeEnd: '2026-08-26T02:00:00.000Z',
        ordinal: 0,
      }),
      expect.objectContaining({
        id: 'compacted-1-3',
        text: '不要重新开启一轮试错',
        origin: 'compacted',
        ordinal: 3,
      }),
    ])
  })

  it('drops sub_agent_activity events without adding messages or counts', () => {
    // A deliberate no-op, pinned so the decision survives. These events carry no content (six
    // fixed fields), are broadcast byte-identically across sibling session files, trail
    // spawn_agent/interrupt_agent tool calls that already render, and the format is retired
    // (0 occurrences in 2026/09 vs 819 files in 2026/07).
    const content = jsonl(
      {
        type: 'session_meta',
        payload: {
          id: '019cd000-0000-7000-8000-000000000009',
          timestamp: '2026-03-09T09:59:59.000Z',
          cwd: '/Users/test/workspace/decision-viewer',
        },
      },
      responseMessage('user', 'Delegate the audit'),
      {
        timestamp: '2026-03-09T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          event_id: 'call_abc123',
          occurred_at_ms: 1785753512100,
          agent_thread_id: '019fc325-44c2-7681-b59c-3b7e503d29e1',
          agent_path: '/root',
          kind: 'started',
        },
      },
      responseMessage('assistant', 'Audit delegated.'),
    )

    const result = parseSessionContent(content, 'codex')

    expect(result.messages.some((m) => JSON.stringify(m).includes('sub_agent_activity'))).toBe(false)
    expect(result.prompts).toHaveLength(1)
    expect(result.messages.filter((m) => m.kind === 'ai-text')).toHaveLength(1)
  })
})

describe('codex classifier equivalence (sync vs streaming entry points)', () => {
  // The frozen streaming contract yields raw lines WITHOUT trailing newlines, same as
  // `content.split('\n')` on the synchronous path — this must stay a faithful line source, not a
  // shortcut, or a passing equivalence test here would prove nothing about the real driver in
  // vite-plugin-claude-data.ts.
  async function* linesFromString(content: string): AsyncIterable<string> {
    for (const line of content.split('\n')) {
      yield line
    }
  }

  async function noopYield(): Promise<void> {}

  it('produces identical SessionData for a mixed-record session (classify switch coverage)', async () => {
    const content = jsonl(
      {
        timestamp: '2026-06-29T04:00:29.000Z',
        type: 'session_meta',
        payload: {
          id: '019f1189-2820-7371-99ea-d0fb51025384',
          timestamp: '2026-06-29T04:00:29.000Z',
          cwd: '/Users/test/workspace/research',
        },
      },
      {
        timestamp: '2026-06-29T04:00:30.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        timestamp: '2026-06-29T04:00:31.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Ship the streaming parser',
          images: [],
          local_images: [],
          text_elements: [],
        },
      },
      {
        timestamp: '2026-06-29T04:00:32.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Thinking through the streaming pass' }],
        },
      },
      {
        timestamp: '2026-06-29T04:00:33.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"rg --files"}',
        },
      },
      {
        timestamp: '2026-06-29T04:00:34.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: '{"output":"src/lib/codex-parser.ts","metadata":{"exit_code":0}}',
        },
      },
      {
        timestamp: '2026-06-29T04:00:35.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          invocation: {
            server: 'computer-use',
            tool: 'get_app_state',
            arguments: { app: 'Terminal' },
          },
          result: { Ok: { content: [{ type: 'text', text: 'Window: Terminal' }] } },
        },
      },
      {
        timestamp: '2026-06-29T04:00:36.000Z',
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      },
      {
        timestamp: '2026-06-29T04:00:37.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', reason: 'interrupted' },
      },
      responseMessage('user', 'No, keep the old behavior'),
      responseMessage('assistant', 'Done. Kept the old behavior.'),
      {
        timestamp: '2026-06-29T04:00:38.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'Finished the streaming parser',
        },
      },
    )

    const direct = parseCodexSessionContent(content)
    const streamed = await parseCodexSessionContentStreaming(linesFromString(content), noopYield)

    expect(streamed).toEqual(direct)
  })

  it('produces identical retained user inputs after a compaction (the fold this refactor changed most)', async () => {
    // Same shape as the "recovers exact user inputs retained only by the last Codex compaction" spec
    // above — this is the highest-risk path in the refactor (a full-array scan folded into a
    // per-record incremental snapshot), so it gets its own dedicated equivalence check.
    const content = jsonl(
      {
        timestamp: '2026-08-26T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a039be-f86d-7203-b821-1d72370e1b69',
          timestamp: '2026-08-26T00:00:00.000Z',
          cwd: '/Users/test/workspace/pkm',
        },
      },
      {
        timestamp: '2026-08-26T02:00:00.000Z',
        type: 'compacted',
        payload: {
          replacement_history: [
            { role: 'user', content: [{ type: 'input_text', text: '先看我们以前是怎么做的' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
            { role: 'user', content: [{ type: 'input_text', text: '<skill><name>injected</name></skill>' }] },
            { role: 'user', content: [{ type: 'input_text', text: '不要重新开启一轮试错' }] },
          ],
        },
      },
      {
        timestamp: '2026-08-26T02:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续当前工作' }],
        },
      },
    )

    const direct = parseCodexSessionContent(content)
    const streamed = await parseCodexSessionContentStreaming(linesFromString(content), noopYield)

    expect(streamed).toEqual(direct)
    expect(direct.retainedUserInputs).toHaveLength(2)
    // `toEqual` above only proves the two entry points agree with EACH OTHER — both share the same
    // createCodexClassifier, so a bug in the shared fold (e.g. the compaction snapshot's recorded
    // index) would reproduce identically on both sides and this comparison alone would not catch it.
    // Pin the actual id values too: records here are [session_meta(0), compacted(1), response_item],
    // so the compacted record's own array position is 1.
    expect((direct.retainedUserInputs ?? []).map((r) => r.id)).toEqual(['compacted-1-0', 'compacted-1-3'])
  })

  it('awaits yieldToEventLoop every 3000 processed records, not more often and not never', async () => {
    // The frozen contract's entire reason to exist is this cadence — a single-threaded dev server
    // must get control back periodically during a multi-second parse. Neither equivalence test above
    // exercises it (their fixtures are a dozen records, nowhere near the threshold), so a regression
    // here — the modulo widened, the await dropped, the counter reset in the wrong place — would
    // otherwise ship silently. 6001 minimal (but validly-typed, non-blank) records cross the 3000
    // boundary exactly twice.
    const totalRecords = 6001
    async function* manyMinimalLines(): AsyncIterable<string> {
      for (let i = 0; i < totalRecords; i++) {
        // No timestamp, no recognized type: falls through every branch in processRecord via its
        // early returns, so this measures pure cadence, not classification cost.
        yield JSON.stringify({ type: 'noop', seq: i })
      }
    }

    let yieldCount = 0
    const countingYield = async () => {
      yieldCount += 1
    }

    await parseCodexSessionContentStreaming(manyMinimalLines(), countingYield)

    expect(yieldCount).toBe(2)
  })
})

describe('codex compaction boundary de-duplication', () => {
  // Real rollouts write one compaction two ways. The records are separated only by bookkeeping that
  // emits nothing, which is exactly what the de-dup keys off, so the fixture reproduces that layout.
  const meta = {
    timestamp: '2026-07-24T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '019f9333-b95e-7311-a97d-f54939a7365e',
      timestamp: '2026-07-24T00:00:00.000Z',
      cwd: '/Users/test/workspace/demo',
    },
  }
  const topLevelCompacted = { timestamp: '2026-07-24T01:00:00.000Z', type: 'compacted', payload: {} }
  const eventCompacted = {
    timestamp: '2026-07-24T01:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  }
  const interveningBookkeeping = [
    { timestamp: '2026-07-24T01:00:01.000Z', type: 'world_state', payload: {} },
    { timestamp: '2026-07-24T01:00:02.000Z', type: 'turn_context', payload: {} },
    { timestamp: '2026-07-24T01:00:02.500Z', type: 'event_msg', payload: { type: 'token_count' } },
  ]
  const prompt = (at: string, text: string) => ({
    timestamp: at,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })

  it('counts one compaction written as both a top-level record and an event_msg only once', () => {
    const data = parseCodexSessionContent(
      jsonl(meta, topLevelCompacted, ...interveningBookkeeping, eventCompacted),
    )

    expect(data.markers.compacts).toBe(1)
    expect(data.messages.filter((m) => m.kind === 'compact-boundary')).toHaveLength(1)
  })

  it('de-duplicates whichever of the two forms comes first', () => {
    const data = parseCodexSessionContent(
      jsonl(meta, eventCompacted, ...interveningBookkeeping, topLevelCompacted),
    )

    expect(data.markers.compacts).toBe(1)
  })

  it('still counts a compaction written in only one of the two forms', () => {
    // The 829MB rollout writes only the top-level record (75 of them, counted correctly); other files
    // carry only the event_msg. Suppressing either case outright to stop the double-count would drop
    // those to zero, which is why the de-dup is positional rather than by record type.
    const topOnly = parseCodexSessionContent(jsonl(meta, topLevelCompacted))
    const eventOnly = parseCodexSessionContent(jsonl(meta, eventCompacted))

    expect(topOnly.markers.compacts).toBe(1)
    expect(eventOnly.markers.compacts).toBe(1)
  })

  it('keeps two compactions separated by real conversation distinct', () => {
    const data = parseCodexSessionContent(
      jsonl(
        meta,
        topLevelCompacted,
        prompt('2026-07-24T01:05:00.000Z', 'carry on'),
        { timestamp: '2026-07-24T02:00:00.000Z', type: 'compacted', payload: {} },
      ),
    )

    expect(data.markers.compacts).toBe(2)
  })
})

describe('codex inter-agent messages (response_item / agent_message)', () => {
  const meta = {
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '01a05a82-7b8c-7082-aa99-cd272516ffd4',
      timestamp: '2026-09-01T00:00:00.000Z',
      cwd: '/Users/test/workspace/demo',
    },
  }
  const agentMessage = (author: string, text: string, encrypted = false) => ({
    timestamp: '2026-09-01T00:01:00.000Z',
    type: 'response_item',
    payload: {
      type: 'agent_message',
      author,
      recipient: '/root',
      content: [
        { type: 'input_text', text },
        ...(encrypted ? [{ type: 'encrypted_content', encrypted_content: 'gAAAAA…' }] : []),
      ],
    },
  })
  const header = (kind: string, sender: string) =>
    `Message Type: ${kind}\nTask name: /root\nSender: ${sender}\nPayload:\n`

  it('surfaces a delegated agent conclusion as a team message', () => {
    const body = '只读审阅结论：远端仍是 origin/main，本地仅有一个未推 commit。'
    const data = parseCodexSessionContent(
      jsonl(meta, agentMessage('/root/integration_conflict_audit', header('FINAL_ANSWER', '/root/integration_conflict_audit') + body)),
    )

    const team = data.messages.filter((m) => m.kind === 'team-message')
    expect(team).toHaveLength(1)
    expect(team[0]).toMatchObject({ from: 'integration_conflict_audit', content: body, isProtocol: false })
  })

  it('drops the routing envelopes whose payload is encrypted rather than rendering empty bubbles', () => {
    // Measured: every MESSAGE / NEW_TASK record has an empty body and an unreadable
    // encrypted_content part. One real session holds 738 of them, so emitting them would bury the
    // conclusions this case exists to surface.
    const data = parseCodexSessionContent(
      jsonl(
        meta,
        agentMessage('/root', header('MESSAGE', '/root/audit'), true),
        agentMessage('/root', header('NEW_TASK', '/root/audit'), true),
      ),
    )

    expect(data.messages.filter((m) => m.kind === 'team-message')).toHaveLength(0)
  })

  it('gives one agent the same colour throughout and different agents their own', () => {
    const data = parseCodexSessionContent(
      jsonl(
        meta,
        agentMessage('/root/alpha', header('FINAL_ANSWER', '/root/alpha') + 'first'),
        agentMessage('/root/beta', header('FINAL_ANSWER', '/root/beta') + 'second'),
        agentMessage('/root/alpha', header('FINAL_ANSWER', '/root/alpha') + 'third'),
      ),
    )

    const team = data.messages.flatMap((m) => (m.kind === 'team-message' ? [m] : []))
    expect(team).toHaveLength(3)
    expect(team[0].color).toBe(team[2].color)
    expect(team[1].from).toBe('beta')
  })

  it('keeps the whole text when the header is absent instead of dropping the record', () => {
    // A future shape that stops writing the `Payload:` header must degrade to showing everything,
    // never to showing nothing — the failure mode this whole case exists to fix.
    const data = parseCodexSessionContent(
      jsonl(meta, agentMessage('/root/scout', 'a bare conclusion with no header at all')),
    )

    const team = data.messages.filter((m) => m.kind === 'team-message')
    expect(team).toHaveLength(1)
    expect(team[0]).toMatchObject({ content: 'a bare conclusion with no header at all' })
  })
})
