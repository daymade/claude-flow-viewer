import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStoreFromFiles, createStoreFromHandle, getCherryStudioBrowserModeNotice, tryAutoLoad } from '../fs-access'
import type { ProjectMeta } from '../../types/session'

const projects: ProjectMeta[] = [
  {
    source: 'codex',
    encodedName: 'codex:/Users/test/demo',
    decodedName: '/Users/test/demo',
    shortName: 'demo',
    totalSessionCount: 1,
    sessions: [
      {
        source: 'codex',
        id: 'root-session',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        promptCount: 1,
        toolCount: 0,
        firstPromptPreview: 'Inspect the startup scan',
        fileSize: 128,
        recordCount: 4,
        threadKind: 'primary',
      },
    ],
  },
]

afterEach(() => {
  vi.restoreAllMocks()
})

function makeCherryStudioFileList(): FileList {
  const file = { name: 'agents.db', webkitRelativePath: 'Library/Application Support/CherryStudioDev/Data/agents.db' }
  return {
    0: file,
    length: 1,
    item(index: number) {
      return index === 0 ? file : null
    },
  } as unknown as FileList
}

type FakeDirectoryHandle = {
  kind: 'directory'
  name: string
  getDirectoryHandle(childName: string): Promise<FakeDirectoryHandle>
  getFileHandle(childName: string): Promise<{ kind: 'file'; name: string }>
}

function makeDirectoryHandle(name: string, tree: Record<string, FakeDirectoryHandle | true> = {}): FakeDirectoryHandle {
  const directories = new Map<string, FakeDirectoryHandle>()
  const files = new Set<string>()

  for (const [childName, child] of Object.entries(tree)) {
    if (child === true) {
      files.add(childName)
    } else {
      directories.set(childName, child)
    }
  }

  return {
    kind: 'directory' as const,
    name,
    async getDirectoryHandle(childName: string) {
      const child = directories.get(childName)
      if (!child) throw new Error(`Missing directory: ${childName}`)
      return child
    },
    async getFileHandle(childName: string) {
      if (!files.has(childName)) throw new Error(`Missing file: ${childName}`)
      return { kind: 'file' as const, name: childName }
    },
  }
}

describe('tryAutoLoad', () => {
  it('reuses the initial project payload instead of fetching /api/scan twice', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(projects), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const store = await tryAutoLoad()
    expect(store).toBeTruthy()

    const loadedProjects = await store!.scanProjects()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/scan')
    expect(loadedProjects).toEqual(projects)
  })

  it('surfaces detailed backend errors for skill-analysis requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === '/api/scan') {
        return new Response(JSON.stringify(projects), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (input === '/api/skill-recommendations') {
        return new Response(JSON.stringify({
          error: 'Local Claude Code is installed but not logged in for non-interactive analysis.',
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected fetch: ${String(input)}`)
    })

    const store = await tryAutoLoad()
    await expect(store!.analyzeSkillRecommendations()).rejects.toThrow('not logged in')
    expect(fetchMock).toHaveBeenCalledWith('/api/skill-recommendations', expect.objectContaining({
      method: 'POST',
    }))
  })
})

describe('browser manual Cherry Studio boundary', () => {
  it('flags Cherry Studio inputs from directory-based file selection', async () => {
    const store = createStoreFromFiles(makeCherryStudioFileList())

    await expect(store.getBrowserModeNotice?.()).resolves.toBe(getCherryStudioBrowserModeNotice())
  })

  it('flags Cherry Studio inputs from directory picker roots', async () => {
    const handle = makeDirectoryHandle('home', {
      Library: makeDirectoryHandle('Library', {
        'Application Support': makeDirectoryHandle('Application Support', {
          CherryStudioDev: makeDirectoryHandle('CherryStudioDev', {
            Data: makeDirectoryHandle('Data', {
              'agents.db': true,
            }),
          }),
        }),
      }),
    })

    const store = createStoreFromHandle(handle as unknown as FileSystemDirectoryHandle)

    await expect(store.getBrowserModeNotice?.()).resolves.toBe(getCherryStudioBrowserModeNotice())
  })
})
