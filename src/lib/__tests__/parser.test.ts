import { describe, it, expect } from 'vitest'
import { parseSessionContent } from '../parser'

// --- Test fixtures: sanitized JSONL records ---

function jsonl(...records: Record<string, unknown>[]): string {
  return records.map(r => JSON.stringify(r)).join('\n')
}

function userMsg(uuid: string, parentUuid: string | null, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId: 'test-session',
    timestamp: '2026-03-07T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  }
}

function assistantMsg(uuid: string, parentUuid: string | null, content: unknown[]): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: 'test-session',
    timestamp: '2026-03-07T10:00:01.000Z',
    message: { role: 'assistant', content },
  }
}

/** Non-content record types that have uuid/parentUuid but are NOT user/assistant */

function progressRecord(uuid: string, parentUuid: string | null): Record<string, unknown> {
  return {
    type: 'progress',
    uuid,
    parentUuid,
    sessionId: 'test-session',
    timestamp: '2026-03-07T10:00:00.500Z',
  }
}

function systemRecord(uuid: string, parentUuid: string | null): Record<string, unknown> {
  return {
    type: 'system',
    uuid,
    parentUuid,
    sessionId: 'test-session',
    timestamp: '2026-03-07T10:00:00.500Z',
    message: { role: 'system', content: 'System context injected' },
  }
}

function fileHistorySnapshot(uuid: string, parentUuid: string | null): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    uuid,
    parentUuid,
    sessionId: 'test-session',
    timestamp: '2026-03-07T10:00:00.500Z',
    snapshot: { files: [] },
  }
}

// --- Tests ---

describe('parseSessionContent', () => {

  describe('basic linear parsing (no tree data)', () => {
    it('parses user prompts and AI responses', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: 'Hello world' }, timestamp: '2026-03-07T10:00:00Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }, timestamp: '2026-03-07T10:00:01Z' },
      )
      const result = parseSessionContent(content)
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0]).toMatchObject({ kind: 'user-prompt', promptNum: 1, text: 'Hello world' })
      expect(result.messages[1]).toMatchObject({ kind: 'ai-text', text: 'Hi there' })
      expect(result.prompts).toHaveLength(1)
    })

    it('parses Cherry Studio serialized agent sessions', () => {
      const content = JSON.stringify({
        source: 'cherrystudio',
        userDataPath: '/Users/test/Library/Application Support/CherryStudioDev',
        session: {
          id: 'cs-session-1',
          name: 'Website scout',
          description: 'Check recent websites',
          agentId: 'agent-1',
          agentName: 'Website Scout',
          agentType: 'agent',
          model: 'claude-4-sonnet',
          createdAt: '2026-03-10T10:00:00.000Z',
          updatedAt: '2026-03-10T10:00:05.000Z',
          messages: [
            {
              role: 'user',
              content: { text: 'Review recent history and recommend recurring sites.' },
              createdAt: '2026-03-10T10:00:00.000Z',
              updatedAt: '2026-03-10T10:00:00.000Z',
            },
            {
              role: 'agent',
              content: {
                message: { id: 'a1' },
                blocks: [
                  { id: 'b1', type: 'thinking', content: 'Hidden internal reasoning' },
                  { id: 'b2', type: 'main_text', content: 'You should inspect github.com and claude.com.' },
                ],
              },
              createdAt: '2026-03-10T10:00:01.000Z',
              updatedAt: '2026-03-10T10:00:01.000Z',
            },
            {
              role: 'tool',
              content: { text: 'Fetched site list successfully.' },
              createdAt: '2026-03-10T10:00:02.000Z',
              updatedAt: '2026-03-10T10:00:02.000Z',
            },
          ],
        },
      })

      const result = parseSessionContent(content, 'cherrystudio')
      expect(result.source).toBe('cherrystudio')
      expect(result.messages).toHaveLength(3)
      expect(result.messages[0]).toMatchObject({ kind: 'user-prompt', promptNum: 1, text: 'Review recent history and recommend recurring sites.' })
      expect(result.messages[1]).toMatchObject({ kind: 'ai-text', text: 'You should inspect github.com and claude.com.' })
      expect(result.messages[2]).toMatchObject({ kind: 'tool-result', content: 'Fetched site list successfully.' })
      expect(result.messages.some((message) => message.kind === 'ai-thinking')).toBe(false)
    })

    it('prefers recovered Cherry Studio non-thinking assistant text over thinking-only fallback blocks', () => {
      const content = JSON.stringify({
        source: 'cherrystudio',
        userDataPath: '/Users/test/Library/Application Support/CherryStudioDev',
        session: {
          id: 'topic:test',
          name: 'Cherry Studio chat',
          description: null,
          agentId: 'default',
          agentName: 'default',
          agentType: 'topic',
          model: null,
          createdAt: '2026-03-10T10:00:00.000Z',
          updatedAt: '2026-03-10T10:00:05.000Z',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: {
                blocks: [
                  { id: 'ub1', type: 'main_text', content: 'hi' },
                ],
              },
              createdAt: '2026-03-10T10:00:00.000Z',
              updatedAt: '2026-03-10T10:00:00.000Z',
            },
            {
              id: 'a1',
              role: 'assistant',
              content: {
                blocks: [
                  { id: 'ab1', type: 'thinking', content: 'Internal reasoning that should stay hidden.' },
                  { id: 'ab2', type: 'error', content: 'The model "step-tts-2" does not exist or you do not have access to it.' },
                ],
              },
              createdAt: '2026-03-10T10:00:01.000Z',
              updatedAt: '2026-03-10T10:00:01.000Z',
            },
          ],
        },
      })

      const result = parseSessionContent(content, 'cherrystudio')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0]).toMatchObject({ kind: 'user-prompt', text: 'hi' })
      expect(result.messages[1]).toMatchObject({
        kind: 'ai-text',
        text: 'The model "step-tts-2" does not exist or you do not have access to it.',
      })
      expect(result.messages.some((message) => message.kind === 'ai-thinking')).toBe(false)
    })

    it('cleans noisy recovered Cherry Studio main_text before rendering', () => {
      const content = JSON.stringify({
        source: 'cherrystudio',
        userDataPath: '/Users/test/Library/Application Support/CherryStudioDev',
        session: {
          id: 'topic:noisy-main-text',
          name: 'Cherry Studio chat',
          description: null,
          agentId: 'default',
          agentName: 'default',
          agentType: 'topic',
          model: null,
          createdAt: '2026-03-10T10:00:00.000Z',
          updatedAt: '2026-03-10T10:00:05.000Z',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: {
                blocks: [
                  { id: 'ub1', type: 'main_text', content: 'hi' },
                ],
              },
              createdAt: '2026-03-10T10:00:00.000Z',
              updatedAt: '2026-03-10T10:00:00.000Z',
            },
            {
              id: 'a1',
              role: 'assistant',
              content: {
                blocks: [
                  { id: 'ab1', type: 'thinking', content: 'cHmm, let me think this through."' },
                  { id: 'ab2', type: 'main_text', content: 'Hi there! = Sounds like you\'re in a cheerful mood today! What\'s on your mind?"' },
                ],
              },
              createdAt: '2026-03-10T10:00:01.000Z',
              updatedAt: '2026-03-10T10:00:01.000Z',
            },
          ],
        },
      })

      const result = parseSessionContent(content, 'cherrystudio')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[1]).toMatchObject({
        kind: 'ai-text',
        text: 'Hi there! Sounds like you\'re in a cheerful mood today! What\'s on your mind?',
      })
      expect(result.messages.some((message) => message.kind === 'ai-thinking')).toBe(false)
    })

    it('cleans noisy Cherry Studio thinking fallback text when no main_text is recoverable', () => {
      const content = JSON.stringify({
        source: 'cherrystudio',
        userDataPath: '/Users/test/Library/Application Support/CherryStudioDev',
        session: {
          id: 'topic:thinking-only',
          name: 'Cherry Studio chat',
          description: null,
          agentId: 'default',
          agentName: 'default',
          agentType: 'topic',
          model: null,
          createdAt: '2026-03-10T10:00:00.000Z',
          updatedAt: '2026-03-10T10:00:05.000Z',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: {
                blocks: [
                  { id: 'ub1', type: 'main_text', content: 'hi' },
                ],
              },
              createdAt: '2026-03-10T10:00:00.000Z',
              updatedAt: '2026-03-10T10:00:00.000Z',
            },
            {
              id: 'a1',
              role: 'assistant',
              content: {
                blocks: [
                  { id: 'ab1', type: 'thinking', content: 'cHmm, let me think this through."' },
                ],
              },
              createdAt: '2026-03-10T10:00:01.000Z',
              updatedAt: '2026-03-10T10:00:01.000Z',
            },
          ],
        },
      })

      const result = parseSessionContent(content, 'cherrystudio')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[1]).toMatchObject({
        kind: 'ai-thinking',
        full: 'Hmm, let me think this through.',
      })
    })

    it('filters out system content (local-command, command-)', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: '<local-command>foo</local-command>' }, timestamp: '2026-03-07T10:00:00Z' },
        { type: 'user', message: { role: 'user', content: '<command-bar>baz</command-bar>' }, timestamp: '2026-03-07T10:00:01Z' },
        { type: 'user', message: { role: 'user', content: 'Real prompt' }, timestamp: '2026-03-07T10:00:02Z' },
      )
      const result = parseSessionContent(content)
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ text: 'Real prompt', promptNum: 1 })
    })
  })

  describe('team message classification', () => {
    it('parses teammate-message as team-message kind', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="designer" color="green" summary="Design done">Report content here</teammate-message>' }, timestamp: '2026-03-07T10:00:00Z' },
      )
      const result = parseSessionContent(content)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]).toMatchObject({
        kind: 'team-message',
        from: 'designer',
        color: 'green',
        summary: 'Design done',
        content: 'Report content here',
        isProtocol: false,
      })
    })

    it('detects protocol events in teammate-message', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="eng" color="blue" summary="went idle">{"type":"idle_notification"}</teammate-message>' }, timestamp: '2026-03-07T10:00:00Z' },
      )
      const result = parseSessionContent(content)
      expect(result.messages[0]).toMatchObject({ kind: 'team-message', isProtocol: true })
    })

    it('parses task-notification as task-event kind', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: '<task-notification><task-id>abc123</task-id><status>completed</status><summary>Build passed</summary></task-notification>' }, timestamp: '2026-03-07T10:00:00Z' },
      )
      const result = parseSessionContent(content)
      expect(result.messages[0]).toMatchObject({
        kind: 'task-event',
        taskId: 'abc123',
        status: 'completed',
        summary: 'Build passed',
      })
    })

    it('team messages do not increment prompt numbering', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: 'First real prompt' }, timestamp: '2026-03-07T10:00:00Z' },
        { type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="x">report</teammate-message>' }, timestamp: '2026-03-07T10:00:01Z' },
        { type: 'user', message: { role: 'user', content: 'Second real prompt' }, timestamp: '2026-03-07T10:00:02Z' },
      )
      const result = parseSessionContent(content)
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ promptNum: 1 })
      expect(prompts[1]).toMatchObject({ promptNum: 2 })
    })
  })

  describe('fork / rewind detection', () => {
    it('detects fork and creates fork-indicator with abandoned branch', () => {
      // Tree: root -> A (user prompt) -> B (assistant, fork parent)
      //                                    ├─ C (assistant, abandoned - old response)
      //                                    └─ D (user, active - rewind new input)
      //                                         └─ E (assistant, active - new response)
      const content = jsonl(
        userMsg('aaa', null, 'What is 2+2?'),
        assistantMsg('bbb', 'aaa', [{ type: 'text', text: 'Let me think...' }]),
        // Abandoned branch: assistant continued
        assistantMsg('ccc', 'bbb', [{ type: 'text', text: 'The answer is 5' }]),
        // Active branch: user rewound and re-prompted
        userMsg('ddd', 'bbb', 'Think carefully'),
        assistantMsg('eee', 'ddd', [{ type: 'text', text: 'The answer is 4' }]),
      )

      const result = parseSessionContent(content)

      // Active path: aaa -> bbb -> ddd -> eee
      const kinds = result.messages.map(m => m.kind)
      expect(kinds).toContain('user-prompt')    // aaa
      expect(kinds).toContain('ai-text')        // bbb
      expect(kinds).toContain('fork-indicator') // after bbb (fork point)

      const fork = result.messages.find(m => m.kind === 'fork-indicator')
      expect(fork).toBeDefined()
      if (fork?.kind === 'fork-indicator') {
        expect(fork.abandonedMessages.length).toBeGreaterThan(0)
        expect(fork.reason).toBe('user-decision')
        // Abandoned branch contains "The answer is 5"
        const abandonedTexts = fork.abandonedMessages.filter(m => m.kind === 'ai-text')
        expect(abandonedTexts.some(m => m.kind === 'ai-text' && m.text === 'The answer is 5')).toBe(true)
      }

      // "The answer is 5" should NOT appear in main message flow
      const mainTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(mainTexts.some(m => m.kind === 'ai-text' && m.text === 'The answer is 5')).toBe(false)

      // "The answer is 4" SHOULD appear (active branch)
      expect(mainTexts.some(m => m.kind === 'ai-text' && m.text === 'The answer is 4')).toBe(true)
    })

    it('abandoned branch prompts do not affect main promptNum', () => {
      const content = jsonl(
        userMsg('aaa', null, 'Prompt 1'),
        assistantMsg('bbb', 'aaa', [{ type: 'text', text: 'Response 1' }]),
        // Abandoned: user sent another prompt on old branch
        userMsg('ccc', 'bbb', 'Abandoned prompt'),
        assistantMsg('ccc2', 'ccc', [{ type: 'text', text: 'Abandoned response' }]),
        // Active: user rewound
        userMsg('ddd', 'bbb', 'Prompt 2 after rewind'),
        assistantMsg('eee', 'ddd', [{ type: 'text', text: 'Response 2' }]),
      )

      const result = parseSessionContent(content)
      const mainPrompts = result.messages.filter(m => m.kind === 'user-prompt')
      // Only Prompt 1 and Prompt 2 should be numbered
      expect(mainPrompts).toHaveLength(2)
      expect(mainPrompts[0]).toMatchObject({ promptNum: 1, text: 'Prompt 1' })
      expect(mainPrompts[1]).toMatchObject({ promptNum: 2, text: 'Prompt 2 after rewind' })
    })

    it('does not create fork for parallel tool_result siblings of chained tool_use blocks', () => {
      // Simulates: assistant turn with Bash + ToolSearch chained as separate records.
      // Tree: user -> assistant(text) -> assistant(Bash tool_use) -> assistant(ToolSearch tool_use)
      //                                       |                            |
      //                                       └─ user(Bash result)         └─ user(ToolSearch result) -> assistant(next)
      // The Bash result is a sibling of ToolSearch (both children of Bash tool_use).
      // It should NOT be treated as a fork — it's a parallel tool result.
      const content = jsonl(
        userMsg('u1', null, 'Do two things'),
        assistantMsg('a-text', 'u1', [{ type: 'text', text: 'Sure, I will do two things.' }]),
        assistantMsg('a-bash', 'a-text', [{ type: 'tool_use', id: 't-bash', name: 'Bash', input: { command: 'mkdir foo' } }]),
        assistantMsg('a-toolsearch', 'a-bash', [{ type: 'tool_use', id: 't-ts', name: 'ToolSearch', input: { query: 'WebFetch' } }]),
        // Bash result (child of a-bash, sibling of a-toolsearch)
        {
          type: 'user', uuid: 'u-bash-result', parentUuid: 'a-bash',
          sessionId: 'test-session', timestamp: '2026-03-07T10:00:02.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-bash', content: 'Done' }] },
        },
        // ToolSearch result (child of a-toolsearch)
        {
          type: 'user', uuid: 'u-ts-result', parentUuid: 'a-toolsearch',
          sessionId: 'test-session', timestamp: '2026-03-07T10:00:03.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-ts', content: 'Found WebFetch' }] },
        },
        assistantMsg('a-next', 'u-ts-result', [{ type: 'text', text: 'All done' }]),
      )

      const result = parseSessionContent(content)

      // No fork indicators should exist
      const forks = result.messages.filter(m => m.kind === 'fork-indicator')
      expect(forks).toHaveLength(0)

      // The Bash tool result SHOULD appear in the main flow
      const toolResults = result.messages.filter(m => m.kind === 'tool-result')
      expect(toolResults.length).toBeGreaterThanOrEqual(2)
      expect(toolResults.some(m => m.kind === 'tool-result' && m.content.includes('Done'))).toBe(true)
      expect(toolResults.some(m => m.kind === 'tool-result' && m.content.includes('Found WebFetch'))).toBe(true)
    })

    it('classifies fork as tool-error when abandoned branch has error tool results', () => {
      // Tree: user -> assistant (tool_use) -> user (tool_result error, abandoned)
      //                                    -> user (tool_result ok, active - retry)
      const content = jsonl(
        userMsg('u1', null, 'Fetch this page'),
        assistantMsg('a1', 'u1', [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://example.com' } }]),
        // Abandoned: tool result with error
        {
          type: 'user', uuid: 'u2-err', parentUuid: 'a1',
          sessionId: 'test-session', timestamp: '2026-03-07T10:00:02.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: 403 Forbidden', is_error: true }] },
        },
        assistantMsg('a2-err', 'u2-err', [{ type: 'text', text: 'Failed attempt' }]),
        // Active: retry that worked
        {
          type: 'user', uuid: 'u2-ok', parentUuid: 'a1',
          sessionId: 'test-session', timestamp: '2026-03-07T10:00:03.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Success', is_error: false }] },
        },
        assistantMsg('a2-ok', 'u2-ok', [{ type: 'text', text: 'Got it' }]),
      )

      const result = parseSessionContent(content)
      const fork = result.messages.find(m => m.kind === 'fork-indicator')
      expect(fork).toBeDefined()
      if (fork?.kind === 'fork-indicator') {
        expect(fork.reason).toBe('tool-error')
      }
    })
  })

  describe('/clear detection', () => {
    it('detects /clear command and emits clear-divider (no tree data)', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2026-03-07T10:00:00Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }, timestamp: '2026-03-07T10:00:01Z' },
        { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' }, timestamp: '2026-03-07T10:00:02Z' },
        { type: 'user', message: { role: 'user', content: 'New conversation' }, timestamp: '2026-03-07T10:00:03Z' },
      )
      const result = parseSessionContent(content)
      const kinds = result.messages.map(m => m.kind)
      expect(kinds).toContain('clear-divider')
      // Prompts before and after /clear are both counted
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
    })

    it('detects /clear even when tree data creates disconnected components', () => {
      // /clear creates a tree discontinuity: post-clear messages may not link back
      const content = jsonl(
        userMsg('aaa', null, 'Before clear'),
        assistantMsg('bbb', 'aaa', [{ type: 'text', text: 'Response' }]),
        // /clear command (its uuid will NOT be on the active path traced from 'eee')
        userMsg('ccc', 'bbb', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
        // Post-clear: new root (parentUuid not linking back to pre-clear)
        userMsg('ddd', null, 'After clear'),
        assistantMsg('eee', 'ddd', [{ type: 'text', text: 'New response' }]),
      )
      const result = parseSessionContent(content)
      const kinds = result.messages.map(m => m.kind)
      expect(kinds).toContain('clear-divider')
    })
  })

  describe('plan mode detection', () => {
    it('detects EnterPlanMode and ExitPlanMode as markers', () => {
      const content = jsonl(
        userMsg('aaa', null, 'Please plan the refactor'),
        assistantMsg('bbb', 'aaa', [
          { type: 'text', text: 'I will enter plan mode.' },
          { type: 'tool_use', id: 'tool1', name: 'EnterPlanMode', input: {} },
        ]),
        userMsg('ccc', 'bbb', 'Looks good, proceed'),
        assistantMsg('ddd', 'ccc', [
          { type: 'tool_use', id: 'tool2', name: 'ExitPlanMode', input: { plan: 'Step 1: Refactor module A\nStep 2: Update tests', allowedPrompts: [] } },
          { type: 'text', text: 'Executing the plan now.' },
        ]),
      )
      const result = parseSessionContent(content)
      const kinds = result.messages.map(m => m.kind)
      expect(kinds).toContain('plan-start')
      expect(kinds).toContain('plan-end')

      const planEnd = result.messages.find(m => m.kind === 'plan-end')
      if (planEnd?.kind === 'plan-end') {
        expect(planEnd.planPreview).toContain('Refactor module A')
      }
    })
  })

  describe('tool summary enrichment', () => {
    it('formats SendMessage tool calls', () => {
      const content = jsonl(
        { type: 'assistant', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'SendMessage', input: { recipient: 'designer', summary: 'Please review the layout' } },
        ] }, timestamp: '2026-03-07T10:00:00Z' },
      )
      const result = parseSessionContent(content)
      expect(result.messages[0]).toMatchObject({ kind: 'ai-tool-use' })
      if (result.messages[0].kind === 'ai-tool-use') {
        expect(result.messages[0].summary).toContain('designer')
        expect(result.messages[0].summary).toContain('review the layout')
      }
    })

    it('formats TaskCreate tool calls', () => {
      const content = jsonl(
        { type: 'assistant', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Fix auth bug' } },
        ] }, timestamp: '2026-03-07T10:00:00Z' },
      )
      const result = parseSessionContent(content)
      if (result.messages[0].kind === 'ai-tool-use') {
        expect(result.messages[0].summary).toContain('Fix auth bug')
      }
    })
  })

  describe('non-content records in parent chain (tree-parser bug regression)', () => {
    // Bug context: analyzeConversationTree() originally only built byUuid from
    // user/assistant records. But the parentUuid chain includes progress, system,
    // file-history-snapshot records. When tracing the active path from tip back
    // to root, hitting a progress record's uuid broke the chain because it wasn't
    // in the lookup map. This caused ALL messages before the break point to be
    // excluded from the active path.

    it('progress record in parent chain does not break active path', () => {
      // Chain: user1 -> assistant1 -> progress1 -> user2 -> assistant2
      // The progress record sits between the two conversation turns.
      // Without the fix, user1 and assistant1 would be excluded.
      const content = jsonl(
        userMsg('u1', null, 'First question'),
        assistantMsg('a1', 'u1', [{ type: 'text', text: 'First answer' }]),
        progressRecord('p1', 'a1'),
        userMsg('u2', 'p1', 'Second question'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'Second answer' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'First question' })
      expect(prompts[1]).toMatchObject({ promptNum: 2, text: 'Second question' })

      const aiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(aiTexts).toHaveLength(2)
      expect(aiTexts[0]).toMatchObject({ text: 'First answer' })
      expect(aiTexts[1]).toMatchObject({ text: 'Second answer' })
    })

    it('system record in parent chain does not break active path', () => {
      // Chain: user1 -> system1 -> assistant1 -> user2 -> assistant2
      const content = jsonl(
        userMsg('u1', null, 'Hello'),
        systemRecord('s1', 'u1'),
        assistantMsg('a1', 's1', [{ type: 'text', text: 'Hi there' }]),
        userMsg('u2', 'a1', 'Follow up'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'Sure thing' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ text: 'Hello' })
      expect(prompts[1]).toMatchObject({ text: 'Follow up' })

      const aiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(aiTexts).toHaveLength(2)
    })

    it('mixed non-content types (progress, file-history-snapshot, system) in chain', () => {
      // Chain: user1 -> progress1 -> assistant1 -> fileSnapshot1 -> system1 -> user2 -> progress2 -> assistant2 -> user3 -> assistant3
      const content = jsonl(
        userMsg('u1', null, 'Prompt one'),
        progressRecord('p1', 'u1'),
        assistantMsg('a1', 'p1', [{ type: 'text', text: 'Response one' }]),
        fileHistorySnapshot('fh1', 'a1'),
        systemRecord('s1', 'fh1'),
        userMsg('u2', 's1', 'Prompt two'),
        progressRecord('p2', 'u2'),
        assistantMsg('a2', 'p2', [{ type: 'text', text: 'Response two' }]),
        userMsg('u3', 'a2', 'Prompt three'),
        assistantMsg('a3', 'u3', [{ type: 'text', text: 'Response three' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(3)
      expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Prompt one' })
      expect(prompts[1]).toMatchObject({ promptNum: 2, text: 'Prompt two' })
      expect(prompts[2]).toMatchObject({ promptNum: 3, text: 'Prompt three' })

      const aiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(aiTexts).toHaveLength(3)
    })

    it('large chain with many progress records (realistic: 683 progress in 970 total)', () => {
      // Real sessions have ~70% progress records. Simulate 5 user prompts with
      // hundreds of progress records interspersed. The bug would cause most
      // prompts to disappear because progress records break the parent chain.
      const records: Record<string, unknown>[] = []
      let lastUuid = 'root'
      const expectedPrompts: string[] = []

      // Initial user prompt
      records.push(userMsg('root', null, 'Initial setup request'))
      expectedPrompts.push('Initial setup request')

      let progressCount = 0
      for (let turn = 1; turn <= 4; turn++) {
        // Assistant response
        const assistantUuid = `a${turn}`
        records.push(assistantMsg(assistantUuid, lastUuid, [{ type: 'text', text: `Response ${turn}` }]))
        lastUuid = assistantUuid

        // Simulate ~170 progress records per turn (683 / 4 ≈ 170)
        for (let p = 0; p < 170; p++) {
          const pUuid = `prog-${turn}-${p}`
          records.push(progressRecord(pUuid, lastUuid))
          lastUuid = pUuid
          progressCount++
        }

        // Next user prompt
        const userUuid = `u${turn + 1}`
        const promptText = `Follow-up prompt ${turn + 1}`
        records.push(userMsg(userUuid, lastUuid, promptText))
        expectedPrompts.push(promptText)
        lastUuid = userUuid
      }

      // Final assistant response
      records.push(assistantMsg('a-final', lastUuid, [{ type: 'text', text: 'Final response' }]))

      expect(progressCount).toBe(680) // close to realistic 683

      const content = jsonl(...records)
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        expect(prompts[i]).toMatchObject({ promptNum: i + 1, text: expectedPrompts[i] })
      }

      // All 5 assistant responses should also appear
      const aiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(aiTexts).toHaveLength(5)
    })

    it('progress records between fork point and active child are handled', () => {
      // Fork scenario with progress records:
      // user1 -> assistant1 -> progress1 -> abandoned_user
      //                     -> progress2 -> active_user -> assistant2
      // The fork is at assistant1, but progress records sit between it and children.
      const content = jsonl(
        userMsg('u1', null, 'Question'),
        assistantMsg('a1', 'u1', [{ type: 'text', text: 'Thinking...' }]),
        progressRecord('p1', 'a1'),
        userMsg('abandoned', 'p1', 'Wrong follow-up'),
        assistantMsg('abandoned-a', 'abandoned', [{ type: 'text', text: 'Abandoned answer' }]),
        progressRecord('p2', 'a1'),
        userMsg('active', 'p2', 'Better follow-up'),
        assistantMsg('a2', 'active', [{ type: 'text', text: 'Good answer' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ text: 'Question' })
      expect(prompts[1]).toMatchObject({ text: 'Better follow-up' })

      // "Abandoned answer" should NOT be in the main flow
      const mainAiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(mainAiTexts.some(m => m.kind === 'ai-text' && m.text === 'Abandoned answer')).toBe(false)
      expect(mainAiTexts.some(m => m.kind === 'ai-text' && m.text === 'Good answer')).toBe(true)
    })
  })

  describe('/clear creating disconnected trees', () => {
    it('messages before and after /clear both appear with clear-divider between them', () => {
      // /clear creates a tree discontinuity: post-clear messages have parentUuid: null
      // Both subtrees should be represented in the output.
      const content = jsonl(
        userMsg('pre1', null, 'Before clear prompt 1'),
        assistantMsg('pre-a1', 'pre1', [{ type: 'text', text: 'Before clear response 1' }]),
        userMsg('pre2', 'pre-a1', 'Before clear prompt 2'),
        assistantMsg('pre-a2', 'pre2', [{ type: 'text', text: 'Before clear response 2' }]),
        // /clear command
        userMsg('clear-cmd', 'pre-a2', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
        // Post-clear: new root (parentUuid: null)
        userMsg('post1', null, 'After clear prompt 1'),
        assistantMsg('post-a1', 'post1', [{ type: 'text', text: 'After clear response 1' }]),
        userMsg('post2', 'post-a1', 'After clear prompt 2'),
        assistantMsg('post-a2', 'post2', [{ type: 'text', text: 'After clear response 2' }]),
      )
      const result = parseSessionContent(content)

      // Verify clear-divider is present
      const kinds = result.messages.map(m => m.kind)
      expect(kinds).toContain('clear-divider')

      // Verify prompts after /clear appear
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      const promptTexts = prompts.map(m => m.kind === 'user-prompt' ? m.text : '')
      expect(promptTexts).toContain('After clear prompt 1')
      expect(promptTexts).toContain('After clear prompt 2')

      // Verify all 4 prompts are numbered correctly
      expect(prompts).toHaveLength(4)
      expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Before clear prompt 1' })
      expect(prompts[1]).toMatchObject({ promptNum: 2, text: 'Before clear prompt 2' })
      expect(prompts[2]).toMatchObject({ promptNum: 3, text: 'After clear prompt 1' })
      expect(prompts[3]).toMatchObject({ promptNum: 4, text: 'After clear prompt 2' })
    })

    it('/clear with progress records in both pre- and post-clear chains', () => {
      const content = jsonl(
        userMsg('pre1', null, 'Pre-clear question'),
        progressRecord('pre-p1', 'pre1'),
        assistantMsg('pre-a1', 'pre-p1', [{ type: 'text', text: 'Pre-clear answer' }]),
        // /clear
        userMsg('clear-cmd', 'pre-a1', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
        // Post-clear with progress records
        userMsg('post1', null, 'Post-clear question'),
        progressRecord('post-p1', 'post1'),
        assistantMsg('post-a1', 'post-p1', [{ type: 'text', text: 'Post-clear answer' }]),
      )
      const result = parseSessionContent(content)

      const kinds = result.messages.map(m => m.kind)
      expect(kinds).toContain('clear-divider')

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ text: 'Pre-clear question' })
      expect(prompts[1]).toMatchObject({ text: 'Post-clear question' })

      const aiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(aiTexts).toHaveLength(2)
    })

    it('multiple /clear commands create multiple clear-dividers', () => {
      const content = jsonl(
        userMsg('u1', null, 'First session'),
        assistantMsg('a1', 'u1', [{ type: 'text', text: 'R1' }]),
        userMsg('clear1', 'a1', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
        userMsg('u2', null, 'Second session'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'R2' }]),
        userMsg('clear2', 'a2', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
        userMsg('u3', null, 'Third session'),
        assistantMsg('a3', 'u3', [{ type: 'text', text: 'R3' }]),
      )
      const result = parseSessionContent(content)

      const clearDividers = result.messages.filter(m => m.kind === 'clear-divider')
      expect(clearDividers).toHaveLength(2)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(3)
    })
  })

  describe('compact boundary detection', () => {
    function compactBoundaryRecord(uuid: string, logicalParentUuid: string): Record<string, unknown> {
      return {
        type: 'system',
        subtype: 'compact_boundary',
        uuid,
        parentUuid: null,
        logicalParentUuid,
        sessionId: 'test-session',
        timestamp: '2026-03-07T12:00:00.000Z',
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 167380 },
      }
    }

    function compactSummaryRecord(uuid: string, parentUuid: string): Record<string, unknown> {
      return {
        type: 'user',
        uuid,
        parentUuid,
        sessionId: 'test-session',
        timestamp: '2026-03-07T12:00:00.100Z',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation...' },
      }
    }

    it('compact_boundary + isCompactSummary pair emits compact-boundary message', () => {
      const content = jsonl(
        userMsg('u1', null, 'Before compact'),
        assistantMsg('a1', 'u1', [{ type: 'text', text: 'Response 1' }]),
        compactBoundaryRecord('cb1', 'a1'),
        compactSummaryRecord('cs1', 'cb1'),
        userMsg('u2', 'cs1', 'After compact'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'Response 2' }]),
      )
      const result = parseSessionContent(content)

      const compacts = result.messages.filter(m => m.kind === 'compact-boundary')
      expect(compacts).toHaveLength(1)
      if (compacts[0].kind === 'compact-boundary') {
        expect(compacts[0].trigger).toBe('auto')
        expect(compacts[0].preTokens).toBe(167380)
        expect(compacts[0].summaryText).toContain('This session is being continued')
      }
    })

    it('isCompactSummary records do not become user-prompt messages', () => {
      const content = jsonl(
        userMsg('u1', null, 'Prompt 1'),
        assistantMsg('a1', 'u1', [{ type: 'text', text: 'R1' }]),
        compactBoundaryRecord('cb1', 'a1'),
        compactSummaryRecord('cs1', 'cb1'),
        userMsg('u2', 'cs1', 'Prompt 2'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'R2' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Prompt 1' })
      expect(prompts[1]).toMatchObject({ promptNum: 2, text: 'Prompt 2' })
    })

    it('compact_boundary connects pre/post compact trees via logicalParentUuid', () => {
      // compact_boundary has parentUuid: null but logicalParentUuid: 'a1'
      // Without logicalParentUuid support, pre-compact messages would be lost
      const content = jsonl(
        userMsg('u1', null, 'Pre-compact prompt'),
        assistantMsg('a1', 'u1', [{ type: 'text', text: 'Pre-compact response' }]),
        compactBoundaryRecord('cb1', 'a1'),
        compactSummaryRecord('cs1', 'cb1'),
        userMsg('u2', 'cs1', 'Post-compact prompt'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'Post-compact response' }]),
      )
      const result = parseSessionContent(content)

      // Both pre- and post-compact prompts should appear
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ text: 'Pre-compact prompt' })
      expect(prompts[1]).toMatchObject({ text: 'Post-compact prompt' })

      const aiTexts = result.messages.filter(m => m.kind === 'ai-text')
      expect(aiTexts).toHaveLength(2)
    })

    it('compact_boundary with progress records in chain', () => {
      const content = jsonl(
        userMsg('u1', null, 'Question'),
        progressRecord('p1', 'u1'),
        assistantMsg('a1', 'p1', [{ type: 'text', text: 'Answer' }]),
        compactBoundaryRecord('cb1', 'a1'),
        compactSummaryRecord('cs1', 'cb1'),
        progressRecord('p2', 'cs1'),
        userMsg('u2', 'p2', 'Follow-up'),
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'Follow-up answer' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)

      const compacts = result.messages.filter(m => m.kind === 'compact-boundary')
      expect(compacts).toHaveLength(1)
    })
  })

  describe('persisted-output (tool result overflow to .txt file)', () => {
    const SESSION_ID = 'c83e2192-183d-4450-be6a-00c921c1e40e'

    it('extracts clean preview and file reference from persisted-output', () => {
      const persistedContent = `<persisted-output>\nOutput too large (34.1KB). Full output saved to: /Users/someone/.claude/projects/test/${SESSION_ID}/tool-results/toolu_abc.txt\n\nPreview (first 2KB):\nFound 249 files\n/path/to/file1.ts\n/path/to/file2.ts\n</persisted-output>`
      const content = jsonl(
        userMsg('u1', null, 'List all files'),
        assistantMsg('a1', 'u1', [
          { type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: { command: 'find . -name "*.ts"' } },
        ]),
        {
          type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'test-session',
          timestamp: '2026-03-07T10:00:02.000Z',
          message: { role: 'user', content: [
            { tool_use_id: 'toolu_abc', type: 'tool_result', content: persistedContent },
          ] },
        },
      )
      const result = parseSessionContent(content)

      const toolResults = result.messages.filter(m => m.kind === 'tool-result')
      expect(toolResults).toHaveLength(1)
      if (toolResults[0].kind === 'tool-result') {
        // Preview is the clean extracted content, NOT the raw XML tag
        expect(toolResults[0].content).toBe('Found 249 files\n/path/to/file1.ts\n/path/to/file2.ts')
        expect(toolResults[0].content).not.toContain('<persisted-output>')
        expect(toolResults[0].content).not.toContain('Output too large')
        // File reference is extracted as relative path
        expect(toolResults[0].externalFile).toBe('tool-results/toolu_abc.txt')
        expect(toolResults[0].totalSize).toBe('34.1KB')
        expect(toolResults[0].isError).toBe(false)
      }
    })

    it('preserves full preview content without 500-char truncation', () => {
      const longPreview = 'line '.repeat(500) // ~2500 chars
      const persistedContent = `<persisted-output>\nOutput too large (100KB). Full output saved to: /tmp/x/${SESSION_ID}/tool-results/out.txt\n\nPreview (first 2KB):\n${longPreview}\n</persisted-output>`
      const content = jsonl(
        {
          type: 'user', sessionId: 'test-session', timestamp: '2026-03-07T10:00:00Z',
          message: { role: 'user', content: [
            { tool_use_id: 'toolu_xyz', type: 'tool_result', content: persistedContent },
          ] },
        },
      )
      const result = parseSessionContent(content)

      const toolResults = result.messages.filter(m => m.kind === 'tool-result')
      expect(toolResults).toHaveLength(1)
      if (toolResults[0].kind === 'tool-result') {
        // Full preview is preserved (not truncated to 500 chars)
        expect(toolResults[0].content).toBe(longPreview)
        expect(toolResults[0].totalSize).toBe('100KB')
        expect(toolResults[0].externalFile).toBe('tool-results/out.txt')
      }
    })

    it('handles tool_result with array content containing persisted-output', () => {
      const persistedText = `<persisted-output>\nOutput too large (50KB). Full output saved to: /tmp/x/${SESSION_ID}/tool-results/arr.txt\n\nPreview (first 2KB):\nSome preview data here\n</persisted-output>`
      const content = jsonl(
        {
          type: 'user', sessionId: 'test-session', timestamp: '2026-03-07T10:00:00Z',
          message: { role: 'user', content: [
            { tool_use_id: 'toolu_arr', type: 'tool_result', content: [
              { type: 'text', text: persistedText },
            ] },
          ] },
        },
      )
      const result = parseSessionContent(content)

      const toolResults = result.messages.filter(m => m.kind === 'tool-result')
      expect(toolResults).toHaveLength(1)
      if (toolResults[0].kind === 'tool-result') {
        expect(toolResults[0].content).toBe('Some preview data here')
        expect(toolResults[0].externalFile).toBe('tool-results/arr.txt')
      }
    })

    it('normal (non-persisted) tool results retain their full text', () => {
      const longResult = 'x'.repeat(600)
      const content = jsonl(
        {
          type: 'user', sessionId: 'test-session', timestamp: '2026-03-07T10:00:00Z',
          message: { role: 'user', content: [
            { tool_use_id: 't1', type: 'tool_result', content: longResult },
          ] },
        },
      )
      const result = parseSessionContent(content)

      const toolResults = result.messages.filter(m => m.kind === 'tool-result')
      expect(toolResults).toHaveLength(1)
      if (toolResults[0].kind === 'tool-result') {
        expect(toolResults[0].content).toBe(longResult)
        expect(toolResults[0].externalFile).toBeUndefined()
      }
    })

    it('persisted-output tool result does not affect prompt numbering', () => {
      const content = jsonl(
        userMsg('u1', null, 'Prompt 1'),
        assistantMsg('a1', 'u1', [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ]),
        {
          type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'test-session',
          timestamp: '2026-03-07T10:00:02.000Z',
          message: { role: 'user', content: [
            { tool_use_id: 't1', type: 'tool_result', content: `<persisted-output>\nOutput too large (5KB). Full output saved to: /tmp/x/${SESSION_ID}/tool-results/t1.txt\n\nPreview (first 2KB):\nsome output\n</persisted-output>` },
          ] },
        },
        assistantMsg('a2', 'u2', [{ type: 'text', text: 'Done' }]),
        userMsg('u3', 'a2', 'Prompt 2'),
        assistantMsg('a3', 'u3', [{ type: 'text', text: 'Response 2' }]),
      )
      const result = parseSessionContent(content)

      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toMatchObject({ promptNum: 1, text: 'Prompt 1' })
      expect(prompts[1]).toMatchObject({ promptNum: 2, text: 'Prompt 2' })
    })
  })

  describe('graceful fallback', () => {
    it('works with JSONL that has no uuid/parentUuid fields', () => {
      const content = jsonl(
        { type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2026-03-07T10:00:00Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'World' }] }, timestamp: '2026-03-07T10:00:01Z' },
      )
      const result = parseSessionContent(content)
      expect(result.messages).toHaveLength(2)
      expect(result.prompts).toHaveLength(1)
    })

    it('handles malformed JSONL lines gracefully', () => {
      const content = '{"type":"user","message":{"role":"user","content":"OK"},"timestamp":"2026-03-07T10:00:00Z"}\nnot json\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fine"}]},"timestamp":"2026-03-07T10:00:01Z"}'
      const result = parseSessionContent(content)
      expect(result.messages).toHaveLength(2)
    })
  })

  describe('queued_command attachments (mid-work user input)', () => {
    function queuedAttachment(uuid: string, prompt: unknown, kind: string | undefined, ts: string): Record<string, unknown> {
      return {
        type: 'attachment',
        uuid,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: ts,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          ...(kind ? { origin: { kind } } : {}),
        },
      }
    }

    it('renders origin:human queued input as a queued user prompt', () => {
      const content = jsonl(
        userMsg('u1', null, 'start', { timestamp: '2026-03-07T10:00:00Z' }),
        queuedAttachment('a1', 'actually do X instead', 'human', '2026-03-07T10:00:10Z'),
        assistantMsg('a2', 'u1', [{ type: 'text', text: 'ok' }]),
      )
      const result = parseSessionContent(content)
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toMatchObject({ text: 'actually do X instead', queued: true, promptNum: 2 })
    })

    it('coerces the list-variant prompt payload', () => {
      const content = jsonl(
        queuedAttachment('a1', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }], 'human', '2026-03-07T10:00:10Z'),
      )
      const result = parseSessionContent(content)
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(1)
      expect((prompts[0] as { text: string }).text).toContain('line one')
      expect((prompts[0] as { text: string }).text).toContain('line two')
    })

    it('ignores peer and harness (no origin) attachment payloads', () => {
      const content = jsonl(
        queuedAttachment('a1', 'from another agent', 'peer', '2026-03-07T10:00:10Z'),
        queuedAttachment('a2', 'harness notice', undefined, '2026-03-07T10:00:20Z'),
      )
      const result = parseSessionContent(content)
      expect(result.messages.filter(m => m.kind === 'user-prompt')).toHaveLength(0)
    })

    it('does not double-render when the queued text was later delivered as a user record', () => {
      const content = jsonl(
        queuedAttachment('a1', 'same words', 'human', '2026-03-07T10:00:10Z'),
        userMsg('u1', null, 'same words', { timestamp: '2026-03-07T10:00:40Z' }),
      )
      const result = parseSessionContent(content)
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).not.toMatchObject({ queued: true })
    })
  })

  describe('duplicate prompt collapsing', () => {
    it('marks prompts repeated 5+ times with dupCount', () => {
      const recs = Array.from({ length: 5 }, (_, i) =>
        userMsg(`u${i}`, i === 0 ? null : `u${i - 1}`, 'identical instruction', { timestamp: `2026-03-07T10:0${i}:00Z` }))
      const result = parseSessionContent(jsonl(...recs))
      const prompts = result.messages.filter(m => m.kind === 'user-prompt')
      expect(prompts).toHaveLength(5)
      for (const p of prompts) expect(p).toMatchObject({ dupCount: 5 })
    })

    it('leaves prompts repeated fewer than 5 times untouched', () => {
      const recs = Array.from({ length: 4 }, (_, i) =>
        userMsg(`u${i}`, i === 0 ? null : `u${i - 1}`, 'again', { timestamp: `2026-03-07T10:0${i}:00Z` }))
      const result = parseSessionContent(jsonl(...recs))
      for (const p of result.messages.filter(m => m.kind === 'user-prompt')) {
        expect((p as { dupCount?: number }).dupCount).toBeUndefined()
      }
    })
  })
})
