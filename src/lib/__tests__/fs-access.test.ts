import { afterEach, describe, expect, it, vi } from 'vitest'

import { tryAutoLoad } from '../fs-access'
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
})
