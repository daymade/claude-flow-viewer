import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockedHomeDir = ''

vi.mock('node:os', () => ({
  default: {
    homedir: () => mockedHomeDir,
  },
}))

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

describe('vite-plugin-claude-data', () => {
  let tempRoot = ''

  beforeEach(async () => {
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
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('scans and returns both Claude and Codex projects', async () => {
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
      ]),
    )

    await expect(fs.stat(status.dbPath)).resolves.toBeTruthy()
  })
})
