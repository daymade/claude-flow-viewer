import { describe, expect, it } from 'vitest'
import { makeCodexProjectId, quickScanCodexMetadata } from '../codex-parser'
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
})
