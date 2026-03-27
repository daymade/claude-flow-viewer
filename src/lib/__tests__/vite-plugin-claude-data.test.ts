import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockedHomeDir = ''
const mockedSkillService = {
  getStatus: vi.fn(),
  analyzeRecentHistory: vi.fn(),
}

vi.mock('node:os', () => ({
  default: {
    homedir: () => mockedHomeDir,
  },
}))

vi.mock('../../../server/recommendations/claude-skill-recommendation-service', () => {
  return {
    ClaudeSkillRecommendationService: class {
      getStatus = mockedSkillService.getStatus
      analyzeRecentHistory = mockedSkillService.analyzeRecentHistory
    },
  }
})

type Middleware = (req: { url?: string }, res: FakeResponse, next: () => void) => void

class FakeResponse {
  statusCode = 200
  headers = new Map<string, string>()
  body = ''
  private readonly resolve: (value: { statusCode: number; body: string; headers: Map<string, string>; nextCalled: boolean }) => void
  private nextCalled = false

  constructor(resolve: (value: { statusCode: number; body: string; headers: Map<string, string>; nextCalled: boolean }) => void) {
    this.resolve = resolve
  }

  setHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  markNext() {
    this.nextCalled = true
    this.resolve({ statusCode: this.statusCode, body: this.body, headers: this.headers, nextCalled: true })
  }

  end(body = '') {
    this.body = String(body)
    this.resolve({ statusCode: this.statusCode, body: this.body, headers: this.headers, nextCalled: this.nextCalled })
  }
}

async function setupPlugin() {
  vi.resetModules()
  const { claudeDataPlugin } = await import('../../../vite-plugin-claude-data.ts')

  let middleware: Middleware | null = null
  claudeDataPlugin().configureServer?.({
    middlewares: {
      use(fn: Middleware) {
        middleware = fn
      },
    },
  } as never)

  if (!middleware) throw new Error('Plugin middleware was not registered')

  return async function request(url: string, init: { method?: string; body?: string } = {}) {
    return new Promise<{ statusCode: number; body: string; headers: Map<string, string>; nextCalled: boolean }>((resolve) => {
      const res = new FakeResponse(resolve)
      const req = Readable.from(init.body ? [init.body] : []) as Readable & { url?: string; method?: string }
      req.url = url
      req.method = init.method ?? 'GET'
      middleware!(req as never, res, () => res.markNext())
    })
  }
}

async function writeJsonl(filePath: string, records: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
}

async function writeCherryStudioAgentsDb(root: string) {
  const dbPath = path.join(root, 'Library', 'Application Support', 'CherryStudioDev', 'Data', 'agents.db')
  await fs.mkdir(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        accessible_paths TEXT,
        instructions TEXT,
        model TEXT NOT NULL,
        plan_model TEXT,
        small_model TEXT,
        mcps TEXT,
        allowed_tools TEXT,
        configuration TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        accessible_paths TEXT,
        instructions TEXT,
        model TEXT NOT NULL,
        plan_model TEXT,
        small_model TEXT,
        mcps TEXT,
        allowed_tools TEXT,
        slash_commands TEXT,
        configuration TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent_session_id TEXT DEFAULT '',
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    db.prepare(`
      INSERT INTO agents (id, type, name, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('agent-1', 'agent', 'Website Scout', 'claude-4-sonnet', '2026-03-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z')

    db.prepare(`
      INSERT INTO sessions (id, agent_type, agent_id, name, description, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'cs-session-1',
      'agent',
      'agent-1',
      'Website Scout Session',
      'Review recurring websites',
      'claude-4-sonnet',
      '2026-03-10T00:00:10.000Z',
      '2026-03-10T00:00:20.000Z',
    )

    const insertMessage = db.prepare(`
      INSERT INTO session_messages (session_id, role, content, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    insertMessage.run(
      'cs-session-1',
      'user',
      JSON.stringify({ text: 'Review recent history and recommend recurring sites.' }),
      null,
      '2026-03-10T00:00:11.000Z',
      '2026-03-10T00:00:11.000Z',
    )
    insertMessage.run(
      'cs-session-1',
      'agent',
      JSON.stringify({ text: 'You should inspect github.com and claude.com.' }),
      null,
      '2026-03-10T00:00:12.000Z',
      '2026-03-10T00:00:12.000Z',
    )
  } finally {
    db.close()
  }
}

async function writeCherryStudioIndexedDbLog(root: string) {
  const filePath = path.join(root, 'Library', 'Application Support', 'CherryStudioDev', 'IndexedDB', 'file__0.indexeddb.leveldb', '000003.log')
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const tokens: string[] = []

  const pushBlock = ({
    blockId,
    messageId,
    type,
    createdAt,
    status = 'success',
    contentLabel,
    contentTokens = [],
    extraTokens = [],
  }: {
    blockId: string
    messageId: string
    type: string
    createdAt: string
    status?: string
    contentLabel?: string
    contentTokens?: string[]
    extraTokens?: string[]
  }) => {
    tokens.push(
      'CherryStudio',
      `id"$${blockId}"`,
      `messageId"$${messageId}"`,
      'type"',
      `${type}"`,
      'createdAt"',
      `${createdAt}"`,
      'status"',
      `${status}"`,
      ...extraTokens,
    )
    if (contentLabel) tokens.push(contentLabel, ...contentTokens)
  }

  const pushMessage = ({
    messageId,
    role,
    topicId,
    createdAt,
    status = 'success',
    blockIds,
    askId,
    assistantId = 'default',
  }: {
    messageId: string
    role: 'user' | 'assistant'
    topicId: string
    createdAt: string
    status?: string
    blockIds: string[]
    askId?: string
    assistantId?: string
  }) => {
    tokens.push(
      'CherryStudio',
      `id"$${messageId}"`,
      'role"',
      `${role}"`,
      `topicId"$${topicId}"`,
      'assistantId"',
      `${assistantId}"`,
      'createdAt"',
      `${createdAt}"`,
      'status"',
      `${status}"`,
      'blocksA',
      ...blockIds.map((blockId) => `"$${blockId}$`),
    )
    if (askId) tokens.push(`askId"$${askId}`)
  }

  const greetingTopicId = '5d2e0995-2f55-4c54-83ee-240638d5f27e'
  const greetingUserMessageId = '0eb502a4-03e1-4119-90ba-68b9fde3ea3e'
  const greetingAssistantMessageId = '3a98bb8e-b985-4985-8a42-2d03473c02b7'
  const greetingUserBlockId = '694023aa-519a-46cc-a37b-59af93c858a1'
  const greetingThinkingBlockId = '894944c4-0ade-482c-ac58-e4c7d250a0b7'
  const greetingMainTextBlockId = '6c9debc4-b3bc-4a03-8ceb-3f9a7a4ec255'

  pushBlock({
    blockId: greetingUserBlockId,
    messageId: greetingUserMessageId,
    type: 'main_text',
    createdAt: '2026-03-25T23:58:10.408Z',
    contentLabel: 'content',
    contentTokens: ['c', 'h', 'i', '"'],
  })
  pushMessage({
    messageId: greetingUserMessageId,
    role: 'user',
    topicId: greetingTopicId,
    createdAt: '2026-03-25T23:58:10.408Z',
    blockIds: [greetingUserBlockId],
  })
  pushBlock({
    blockId: greetingThinkingBlockId,
    messageId: greetingAssistantMessageId,
    type: 'thinking',
    createdAt: '2026-03-25T23:58:10.489Z',
    contentLabel: 'content',
    contentTokens: ['c', 'O', 'k', 'a', 'y', ',', ' ', 't', 'h', 'e', ' ', 'u', 's', 'e', 'r', ' ', 's', 'a', 'i', 'd', ' ', 'h', 'i', '.'],
  })
  pushBlock({
    blockId: greetingMainTextBlockId,
    messageId: greetingAssistantMessageId,
    type: 'main_text',
    createdAt: '2026-03-25T23:58:11.397Z',
    contentLabel: 'contentc',
    contentTokens: ['H', 'e', 'l', 'l', 'o', '!', ' ', 'H', 'o', 'w', ' ', 'c', 'a', 'n', ' ', 'I', ' ', 'h', 'e', 'l', 'p', ' ', 'y', 'o', 'u', ' ', 't', 'o', 'd', 'a', 'y', '?'],
    extraTokens: ['error_"'],
  })
  pushMessage({
    messageId: greetingAssistantMessageId,
    role: 'assistant',
    topicId: greetingTopicId,
    createdAt: '2026-03-25T23:58:10.489Z',
    blockIds: [greetingThinkingBlockId, greetingMainTextBlockId],
    askId: greetingUserMessageId,
  })

  const retryTopicId = '5a3e6519-2037-4add-ba00-8cf887c5fd77'
  const retryUserMessageId = '39a1f901-65d7-4773-9dc5-dfd0473f420f'
  const retryFirstAssistantId = '73be9866-1538-46bc-a08e-1f60b20ab7bb'
  const retrySecondUserId = '21218d94-8ab2-48c7-996b-d86ff361bed9'
  const retryFinalAssistantId = '44c62116-f1c5-4674-af74-a9ccac7d90e0'
  const retryUserBlockId = 'c71ce069-6041-4471-924e-c545a4bf70c6'
  const retryProcessingBlockId = '56f1eeab-cdda-4a7f-ad4f-95a71b2db817'
  const retryErrorBlockId = '9a3b59be-9b46-45c9-96e7-46a52be2a9a0'
  const retrySecondUserBlockId = 'e4a8fb27-f809-4039-a609-7f633117eaa6'
  const retryThinkingBlockId = 'fe51b8b7-fc3c-48ef-ae1f-9de57834ed4b'
  const retryFinalMainTextBlockId = 'a2a5454a-32b8-41f4-812e-0484578983e5'

  pushBlock({
    blockId: retryUserBlockId,
    messageId: retryUserMessageId,
    type: 'main_text',
    createdAt: '2026-03-26T00:19:18.066Z',
    contentLabel: 'content"',
    contentTokens: ['hi "'],
  })
  pushMessage({
    messageId: retryUserMessageId,
    role: 'user',
    topicId: retryTopicId,
    createdAt: '2026-03-26T00:19:18.066Z',
    blockIds: [retryUserBlockId],
  })
  pushBlock({
    blockId: retryProcessingBlockId,
    messageId: retryFirstAssistantId,
    type: 'unknown',
    createdAt: '2026-03-26T00:19:18.169Z',
    status: 'processing',
    extraTokens: ['error_{'],
  })
  pushBlock({
    blockId: retryErrorBlockId,
    messageId: retryFirstAssistantId,
    type: 'error',
    createdAt: '2026-03-26T00:19:18.298Z',
    extraTokens: [
      'erroro"',
      'name"',
      'AI_APICallError"',
      'message"FThe model "step-tts-2" does not exist or you do not have access to it."',
      'stack"',
      'AI_APICallError stack',
    ],
  })
  pushMessage({
    messageId: retryFirstAssistantId,
    role: 'assistant',
    topicId: retryTopicId,
    createdAt: '2026-03-26T00:19:18.088Z',
    status: 'pending',
    blockIds: [retryProcessingBlockId, retryErrorBlockId],
    askId: retryUserMessageId,
  })
  pushBlock({
    blockId: retrySecondUserBlockId,
    messageId: retrySecondUserId,
    type: 'main_text',
    createdAt: '2026-03-26T00:19:35.830Z',
    contentLabel: 'content"',
    contentTokens: ['hihihi"'],
  })
  pushMessage({
    messageId: retrySecondUserId,
    role: 'user',
    topicId: retryTopicId,
    createdAt: '2026-03-26T00:19:35.830Z',
    blockIds: [retrySecondUserBlockId],
  })
  pushBlock({
    blockId: retryThinkingBlockId,
    messageId: retryFinalAssistantId,
    type: 'thinking',
    createdAt: '2026-03-26T00:19:35.955Z',
    contentLabel: 'content',
    contentTokens: ['c', 'H', 'm', 'm', ',', ' ', 't', 'h', 'e', ' ', 'u', 's', 'e', 'r', ' ', 's', 't', 'a', 'r', 't', 'e', 'd', ' ', 'w', 'i', 't', 'h', ' ', 'h', 'i'],
  })
  pushBlock({
    blockId: retryFinalMainTextBlockId,
    messageId: retryFinalAssistantId,
    type: 'main_text',
    createdAt: '2026-03-26T00:19:37.040Z',
    contentLabel: 'contentc',
    contentTokens: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e', '!', ' ', 'S', 'o', 'u', 'n', 'd', 's', ' ', 'l', 'i', 'k', 'e', ' ', 'y', 'o', 'u', 'r', 'e', ' ', 'i', 'n', ' ', 'a', ' ', 'g', 'o', 'o', 'd', ' ', 'm', 'o', 'o', 'd', '.', ' ', 'W', 'h', 'a', 't', "'", 's', ' ', 'u', 'p', '?'],
    extraTokens: ['error_"'],
  })
  pushMessage({
    messageId: retryFinalAssistantId,
    role: 'assistant',
    topicId: retryTopicId,
    createdAt: '2026-03-26T00:19:35.852Z',
    blockIds: [retryThinkingBlockId, retryFinalMainTextBlockId],
    askId: retrySecondUserId,
  })

  const recoveredMainTextTopicId = '6b049574-c78e-428e-9d9e-c85fa24d4fa6'
  const recoveredMainTextUserMessageId = '2ac99284-4174-4fdb-a900-242f8dd0e66a'
  const recoveredMainTextAssistantMessageId = '53915dc5-a0d3-4670-bd4c-b5c2cc48fb84'
  const recoveredMainTextUserBlockId = '95dce4fb-18a2-4519-b309-dee4ee78a958'
  const recoveredMainTextThinkingBlockId = '38bd240e-402e-44dd-9a16-cc3d2f4e49d6'
  const recoveredMainTextBlockId = '5ca6ab66-2a17-4caa-9c1e-de09c0035714'

  pushBlock({
    blockId: recoveredMainTextUserBlockId,
    messageId: recoveredMainTextUserMessageId,
    type: 'main_text',
    createdAt: '2026-03-26T00:03:46.900Z',
    contentLabel: 'content',
    contentTokens: ['c', 'h', 'i', 'h', 'i', 'h', 'i', 'h', 'i', '"'],
  })
  pushMessage({
    messageId: recoveredMainTextUserMessageId,
    role: 'user',
    topicId: recoveredMainTextTopicId,
    createdAt: '2026-03-26T00:03:46.900Z',
    blockIds: [recoveredMainTextUserBlockId],
  })
  pushBlock({
    blockId: recoveredMainTextThinkingBlockId,
    messageId: recoveredMainTextAssistantMessageId,
    type: 'thinking',
    createdAt: '2026-03-26T00:03:46.983Z',
    contentLabel: 'content',
    contentTokens: ['c', 'H', 'm', 'm', ',', ' ', 't', 'h', 'e', ' ', 'u', 's', 'e', 'r', ' ', 'j', 'u', 's', 't', ' ', 's', 'a', 'i', 'd', ' ', '"', 'h', 'i', 'h', 'i', 'h', 'i', 'h', 'i', '"', '.'],
  })
  pushBlock({
    blockId: recoveredMainTextBlockId,
    messageId: recoveredMainTextAssistantMessageId,
    type: 'main_text',
    createdAt: '2026-03-26T00:03:47.864Z',
    contentLabel: 'contentc',
    contentTokens: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e', '!', ' ', '=', ' ', ' ', 'H', 'o', 'w', ' ', 'c', 'a', 'n', ' ', 'I', ' ', 'h', 'e', 'l', 'p', ' ', 'y', 'o', 'u', ' ', 't', 'o', 'd', 'a', 'y', '?', ' ', 'W', 'h', 'e', 't', 'h', 'e', 'r', ' ', 'y', 'o', 'u', ' ', 'h', 'a', 'v', 'e', ' ', 'a', ' ', 'q', 'u', 'e', 's', 't', 'i', 'o', 'n', ',', ' ', 'n', 'e', 'e', 'd', ' ', 's', 'o', 'm', 'e', ' ', 'i', 'n', 'f', 'o', ',', ' ', 'o', 'r', ' ', 'j', 'u', 's', 't', ' ', 'w', 'a', 'n', 't', ' ', 't', 'o', ' ', 'c', 'h', 'a', 't', ' ', ' ', 'I', '\'', 'm', ' ', 'h', 'e', 'r', 'e', ' ', 'f', 'o', 'r', ' ', 'y', 'o', 'u', '!'],
  })
  pushMessage({
    messageId: recoveredMainTextAssistantMessageId,
    role: 'assistant',
    topicId: recoveredMainTextTopicId,
    createdAt: '2026-03-26T00:03:46.916Z',
    blockIds: [recoveredMainTextThinkingBlockId, recoveredMainTextBlockId],
    askId: recoveredMainTextUserMessageId,
  })

  const assistantOnlyTopicId = '7f640fe2-54a8-4fa1-b19e-28dbf8ed40d2'
  const assistantOnlyMessageId = '58a9f566-b492-44ce-a0a5-f797e8f7f81a'
  const assistantOnlyBlockId = 'ae146ab2-8dd2-4a5d-bd60-3ffcc0b2ba73'

  pushBlock({
    blockId: assistantOnlyBlockId,
    messageId: assistantOnlyMessageId,
    type: 'main_text',
    createdAt: '2026-03-26T00:21:00.000Z',
    contentLabel: 'contentc',
    contentTokens: ['A', 's', 's', 'i', 's', 't', 'a', 'n', 't', '-', 'o', 'n', 'l', 'y', ' ', 't', 'o', 'p', 'i', 'c', ' ', 'r', 'e', 'p', 'l', 'y'],
  })
  pushMessage({
    messageId: assistantOnlyMessageId,
    role: 'assistant',
    topicId: assistantOnlyTopicId,
    createdAt: '2026-03-26T00:21:00.000Z',
    blockIds: [assistantOnlyBlockId],
  })

  const uuidPromptTopicId = '0f7eb616-6d3b-4d0a-8ef5-8fadcaf0d2c5'
  const uuidPromptUserMessageId = '2f651cba-3c7f-4cbb-a536-f11e567c1f5a'
  const uuidPromptAssistantMessageId = '405f6c35-f360-4010-a68a-8e9c61df037d'
  const uuidPromptUserBlockId = '75f5920b-c959-4d9a-ad47-13e370e4eb5f'
  const uuidPromptAssistantBlockId = '01e9caf7-5d78-46bb-8848-8fcddf6c77aa'

  pushBlock({
    blockId: uuidPromptUserBlockId,
    messageId: uuidPromptUserMessageId,
    type: 'main_text',
    createdAt: '2026-03-26T00:22:00.000Z',
    contentLabel: 'content"',
    contentTokens: ['11111111-1111-1111-1111-111111111111"'],
  })
  pushMessage({
    messageId: uuidPromptUserMessageId,
    role: 'user',
    topicId: uuidPromptTopicId,
    createdAt: '2026-03-26T00:22:00.000Z',
    blockIds: [uuidPromptUserBlockId],
  })
  pushBlock({
    blockId: uuidPromptAssistantBlockId,
    messageId: uuidPromptAssistantMessageId,
    type: 'main_text',
    createdAt: '2026-03-26T00:22:01.000Z',
    contentLabel: 'contentc',
    contentTokens: ['R', 'e', 'a', 'd', 'a', 'b', 'l', 'e', ' ', 'a', 's', 's', 'i', 's', 't', 'a', 'n', 't', ' ', 'f', 'a', 'l', 'l', 'b', 'a', 'c', 'k'],
  })
  pushMessage({
    messageId: uuidPromptAssistantMessageId,
    role: 'assistant',
    topicId: uuidPromptTopicId,
    createdAt: '2026-03-26T00:22:01.000Z',
    blockIds: [uuidPromptAssistantBlockId],
    askId: uuidPromptUserMessageId,
  })

  await fs.writeFile(filePath, Buffer.from(tokens.join('\0')))
}

describe('vite-plugin-claude-data', () => {
  let tempRoot = ''

  beforeEach(async () => {
    mockedSkillService.getStatus.mockReset()
    mockedSkillService.analyzeRecentHistory.mockReset()
    mockedSkillService.getStatus.mockResolvedValue({
      available: true,
      backend: 'claude-code',
      cliPath: '/Users/test/.local/bin/claude',
      model: 'haiku',
      sessionLimit: 6,
      message: 'Runs an on-demand local Claude Code team analysis over recent session history.',
    })
    mockedSkillService.analyzeRecentHistory.mockResolvedValue({
      generatedAt: '2026-03-10T00:00:10.000Z',
      backend: 'claude-code',
      model: 'haiku',
      scope: 'smart',
      requestedProjectEncoded: null,
      scopeLabel: 'Smart scope',
      targetLabel: null,
      analyzedSessionCount: 2,
      discussion: [
        { agent: 'scout', point: 'Recent history repeatedly asks for site recommendations.' },
      ],
      recommendations: [
        {
          id: 'site-recommend',
          name: 'site-recommend',
          title: 'Website integration scout',
          summary: 'Recommend recurring sites that should become integrations.',
          rationale: 'The pattern repeats across recent Claude and Codex history.',
          whenToUse: 'Use this when you want to mine recent history for integration candidates.',
          steps: ['Review history', 'Extract recurring sites', 'Recommend the strongest candidates'],
          evidence: ['github.com', 'claude.com'],
          confidence: 'high',
        },
      ],
    })

    tempRoot = await fs.mkdtemp(path.join(process.cwd(), '.tmp-claude-flow-viewer-plugin-'))
    mockedHomeDir = tempRoot

    await writeJsonl(
      path.join(tempRoot, '.claude', 'projects', 'demo-project', 'session-1.jsonl'),
      [
        {
          type: 'user',
          timestamp: '2026-03-10T00:00:00.000Z',
          message: { role: 'user', content: 'Inspect the Claude session' },
        },
        {
          type: 'assistant',
          timestamp: '2026-03-10T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Claude response' }] },
        },
      ],
    )

    await fs.mkdir(path.join(tempRoot, '.claude', 'projects', 'demo-project', 'session-1', 'tool-results'), { recursive: true })
    await fs.writeFile(
      path.join(tempRoot, '.claude', 'projects', 'demo-project', 'session-1', 'tool-results', 'output.txt'),
      'tool output',
    )

    await fs.mkdir(path.join(tempRoot, '.codex', 'sessions', '2026', '03', '10'), { recursive: true })
    await fs.writeFile(
      path.join(tempRoot, '.codex', 'session_index.jsonl'),
      JSON.stringify({
        id: '019cd000-0000-7000-8000-000000000001',
        thread_name: 'Inspect the Codex session',
        updated_at: '2026-03-10T00:00:05.000Z',
      }),
    )
    await writeJsonl(
      path.join(tempRoot, '.codex', 'sessions', '2026', '03', '10', 'rollout-2026-03-10T00-00-05-019cd000-0000-7000-8000-000000000001.jsonl'),
      [
        {
          timestamp: '2026-03-10T00:00:05.000Z',
          type: 'session_meta',
          payload: {
            id: '019cd000-0000-7000-8000-000000000001',
            timestamp: '2026-03-10T00:00:05.000Z',
            cwd: '/Users/test/workspace/codex-app',
          },
        },
        {
          timestamp: '2026-03-10T00:00:06.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect the Codex session' }],
          },
        },
      ],
    )
    await writeJsonl(
      path.join(tempRoot, '.codex', 'sessions', '2026', '03', '10', 'rollout-2026-03-10T00-00-06-019cd000-0000-7000-8000-000000000002.jsonl'),
      [
        {
          timestamp: '2026-03-10T00:00:06.000Z',
          type: 'session_meta',
          payload: {
            id: '019cd000-0000-7000-8000-000000000002',
            timestamp: '2026-03-10T00:00:06.000Z',
            cwd: '/Users/test/workspace/codex-app',
            forked_from_id: '019cd000-0000-7000-8000-000000000001',
            agent_nickname: 'Hooke',
            agent_role: 'research',
          },
        },
        {
          timestamp: '2026-03-10T00:00:07.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect the delegated branch' }],
          },
        },
      ],
    )

    await writeCherryStudioAgentsDb(tempRoot)
    await writeCherryStudioIndexedDbLog(tempRoot)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('scans and returns Claude, Codex, and Cherry Studio projects', async () => {
    const request = await setupPlugin()
    const res = await request('/api/scan')
    const projects = JSON.parse(res.body) as Array<{ source: string; encodedName: string; totalSessionCount: number; sessions: Array<{ id: string; firstPromptPreview: string }> }>

    expect(res.statusCode).toBe(200)
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'claude',
          encodedName: 'demo-project',
          sessions: [expect.objectContaining({ firstPromptPreview: 'Inspect the Claude session' })],
        }),
        expect.objectContaining({
          source: 'codex',
          encodedName: 'codex:/Users/test/workspace/codex-app',
          totalSessionCount: 2,
          sessions: [expect.objectContaining({ firstPromptPreview: 'Inspect the Codex session' })],
        }),
        expect.objectContaining({
          source: 'cherrystudio',
          sessions: expect.arrayContaining([
            expect.objectContaining({ id: 'cs-session-1', firstPromptPreview: 'Review recent history and recommend recurring sites.' }),
            expect.objectContaining({ id: 'topic:5a3e6519-2037-4add-ba00-8cf887c5fd77', firstPromptPreview: 'Hi there! Sounds like youre in a good mood. What\'s up?' }),
            expect.objectContaining({ id: 'topic:5d2e0995-2f55-4c54-83ee-240638d5f27e', firstPromptPreview: 'hi' }),
            expect.objectContaining({ id: 'topic:6b049574-c78e-428e-9d9e-c85fa24d4fa6', firstPromptPreview: 'hihihihi' }),
            expect.objectContaining({ id: 'topic:7f640fe2-54a8-4fa1-b19e-28dbf8ed40d2', firstPromptPreview: 'Assistant-only topic reply' }),
            expect.objectContaining({ id: 'topic:0f7eb616-6d3b-4d0a-8ef5-8fadcaf0d2c5', firstPromptPreview: 'Readable assistant fallback' }),
          ]),
        }),
      ]),
    )
    const codexProject = projects.find((project) => project.source === 'codex')
    expect(codexProject?.sessions.map((session) => session.id)).toEqual(['019cd000-0000-7000-8000-000000000001'])
  })

  it('returns the full Codex thread list when scanning one project on demand', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('codex:/Users/test/workspace/codex-app')

    const res = await request(`/api/scan-project/codex/${projectEncoded}`)

    expect(res.statusCode).toBe(200)
    const sessions = JSON.parse(res.body) as Array<{ id: string }>
    expect(sessions.map((session) => session.id)).toEqual([
      '019cd000-0000-7000-8000-000000000002',
      '019cd000-0000-7000-8000-000000000001',
    ])
  })

  it('reads a Codex session through the source-aware session route', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('codex:/Users/test/workspace/codex-app')
    const sessionId = '019cd000-0000-7000-8000-000000000001'

    const res = await request(`/api/session/codex/${projectEncoded}/${sessionId}`)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"type":"session_meta"')
    expect(res.body).toContain('"cwd":"/Users/test/workspace/codex-app"')
  })

  it('reads a Cherry Studio session through the source-aware session route', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('cherrystudio:/Users/test/Library/Application Support/CherryStudioDev')

    const res = await request(`/api/session/cherrystudio/${projectEncoded}/cs-session-1`)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"source":"cherrystudio"')
    expect(res.body).toContain('"id":"cs-session-1"')
    expect(res.body).toContain('github.com')
  })

  it('reads a Cherry Studio regular chat topic through the source-aware session route', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('cherrystudio:/Users/test/Library/Application Support/CherryStudioDev')

    const res = await request(`/api/session/cherrystudio/${projectEncoded}/topic:5d2e0995-2f55-4c54-83ee-240638d5f27e`)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"source":"cherrystudio"')
    expect(res.body).toContain('"name":"hi"')
    expect(res.body).toContain('Hello! How can I help you today?')
  })

  it('recovers a real local-style Cherry Studio final main_text from char-split blocks', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('cherrystudio:/Users/test/Library/Application Support/CherryStudioDev')

    const res = await request(`/api/session/cherrystudio/${projectEncoded}/topic:6b049574-c78e-428e-9d9e-c85fa24d4fa6`)
    const payload = JSON.parse(res.body) as {
      session: {
        name: string
        messages: Array<{ role: string; content: { blocks?: Array<{ type: string; content: string }> } | string }>
      }
    }

    expect(res.statusCode).toBe(200)
    expect(payload.session.name).toBe('hihihihi')
    expect(payload.session.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'main_text',
                content: 'Hi there! How can I help you today? Whether you have a question, need some info, or just want to chat I\'m here for you!',
              }),
              expect.objectContaining({
                type: 'thinking',
                content: expect.stringContaining('Hmm, the user just said hihihihi.'),
              }),
            ]),
          }),
        }),
      ]),
    )
  })

  it('uses a richer later Cherry Studio reply for multi-turn topic title while still recovering the final main_text', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('cherrystudio:/Users/test/Library/Application Support/CherryStudioDev')

    const res = await request(`/api/session/cherrystudio/${projectEncoded}/topic:5a3e6519-2037-4add-ba00-8cf887c5fd77`)
    const payload = JSON.parse(res.body) as {
      session: {
        name: string
        messages: Array<{ role: string; content: { blocks?: Array<{ type: string; content: string }> } | string }>
      }
    }

    expect(res.statusCode).toBe(200)
    expect(payload.session.name).toBe('Hi there! Sounds like youre in a good mood. What\'s up?')
    expect(payload.session.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'error',
                content: 'The model "step-tts-2" does not exist or you do not have access to it.',
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'main_text',
                content: 'Hi there! Sounds like youre in a good mood. What\'s up?',
              }),
            ]),
          }),
        }),
      ]),
    )
    expect(res.body).not.toContain('[Cherry Studio assistant reply could not be recovered cleanly]')
  })

  it('uses a readable assistant reply for topic title and preview when the first recovered prompt looks like a UUID', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('cherrystudio:/Users/test/Library/Application Support/CherryStudioDev')

    const res = await request(`/api/session/cherrystudio/${projectEncoded}/topic:0f7eb616-6d3b-4d0a-8ef5-8fadcaf0d2c5`)
    const payload = JSON.parse(res.body) as {
      session: {
        id: string
        name: string
      }
    }

    expect(res.statusCode).toBe(200)
    expect(payload.session.id).toBe('topic:0f7eb616-6d3b-4d0a-8ef5-8fadcaf0d2c5')
    expect(payload.session.name).toBe('Readable assistant fallback')
    expect(payload.session.name).not.toBe('11111111-1111-1111-1111-111111111111')
  })

  it('uses a human-readable assistant reply for topic preview and title when no user prompt is recoverable', async () => {
    const request = await setupPlugin()
    const projectEncoded = encodeURIComponent('cherrystudio:/Users/test/Library/Application Support/CherryStudioDev')

    const res = await request(`/api/session/cherrystudio/${projectEncoded}/topic:7f640fe2-54a8-4fa1-b19e-28dbf8ed40d2`)
    const payload = JSON.parse(res.body) as {
      session: {
        id: string
        name: string
        messages: Array<{ role: string; content: { blocks?: Array<{ type: string; content: string }> } | string }>
      }
    }

    expect(res.statusCode).toBe(200)
    expect(payload.session.id).toBe('topic:7f640fe2-54a8-4fa1-b19e-28dbf8ed40d2')
    expect(payload.session.name).toBe('Assistant-only topic reply')
    expect(payload.session.name).not.toBe('7f640fe2-54a8-4fa1-b19e-28dbf8ed40d2')
    expect(payload.session.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              type: 'main_text',
              content: 'Assistant-only topic reply',
            }),
          ],
        }),
      }),
    ])
  })

  it('rejects unsafe Claude tool-result paths', async () => {
    const request = await setupPlugin()
    const relativePath = encodeURIComponent('../secret.txt')
    const res = await request(`/api/tool-result/claude/demo-project/session-1/${relativePath}`)

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('directory traversal')
  })

  it('reports SQLite search availability and serves transcript hits through the server API', async () => {
    const request = await setupPlugin()

    const statusRes = await request('/api/search/status')
    expect(statusRes.statusCode).toBe(200)

    const status = JSON.parse(statusRes.body) as {
      available: boolean
      backend: string
      dbPath: string
    }

    expect(status.available).toBe(true)
    expect(status.backend).toBe('sqlite')

    const refreshRes = await request('/api/search/refresh', { method: 'POST' })
    expect(refreshRes.statusCode).toBe(200)

    const searchRes = await request('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'Claude response' }),
    })

    expect(searchRes.statusCode).toBe(200)
    const payload = JSON.parse(searchRes.body) as {
      results: Array<{ source: string; kind: string; sessionId: string; snippet: string }>
      status: { backend: string; dbPath: string }
    }

    expect(payload.status.backend).toBe('sqlite')
    expect(payload.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'claude',
          kind: 'ai-text',
          sessionId: 'session-1',
          snippet: expect.stringContaining('Claude response'),
        }),
        expect.objectContaining({
          source: 'cherrystudio',
          sessionId: 'cs-session-1',
          snippet: expect.stringContaining('github.com'),
        }),
        expect.objectContaining({
          source: 'cherrystudio',
          sessionId: 'topic:5d2e0995-2f55-4c54-83ee-240638d5f27e',
          snippet: expect.stringContaining('Hello! How can I help you today?'),
        }),
      ]),
    )

    await expect(fs.stat(status.dbPath)).resolves.toBeTruthy()
  })

  it('reports Claude-backed skill-analysis availability and serves structured recommendations', async () => {
    const request = await setupPlugin()

    const statusRes = await request('/api/skill-recommendations/status')
    expect(statusRes.statusCode).toBe(200)
    expect(JSON.parse(statusRes.body)).toMatchObject({
      available: true,
      backend: 'claude-code',
      model: 'haiku',
    })

    const analysisRes = await request('/api/skill-recommendations', {
      method: 'POST',
      body: JSON.stringify({ options: { sessionLimit: 4 } }),
    })
    expect(analysisRes.statusCode).toBe(200)
    expect(JSON.parse(analysisRes.body)).toMatchObject({
      backend: 'claude-code',
      recommendations: [
        expect.objectContaining({
          name: 'site-recommend',
          title: 'Website integration scout',
        }),
      ],
    })
    expect(mockedSkillService.analyzeRecentHistory).toHaveBeenCalledWith({ sessionLimit: 4 })
  })
})
