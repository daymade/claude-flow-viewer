import { describe, expect, it } from 'vitest'

import type { SessionMeta } from '../../types/session'
import {
  buildCodexThreadForest,
  filterCodexThreadForest,
  findCodexSelectionContext,
  selectCodexDisplaySessions,
  selectCodexRootSessions,
  summarizeCodexThreadForest,
} from '../codex-navigation'

function session(overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'startTime' | 'startDisplay' | 'firstPromptPreview'>): SessionMeta {
  return {
    source: 'codex',
    id: overrides.id,
    startTime: overrides.startTime,
    startDisplay: overrides.startDisplay,
    firstPromptPreview: overrides.firstPromptPreview,
    promptCount: 0,
    toolCount: 0,
    fileSize: 128,
    recordCount: 4,
    ...overrides,
  }
}

describe('codex-navigation', () => {
  it('builds root to delegated-work trees and sorts by latest activity', () => {
    const forest = buildCodexThreadForest([
      session({
        id: 'root-older',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        firstPromptPreview: 'Older task',
        threadKind: 'primary',
      }),
      session({
        id: 'child-newer',
        startTime: '2026-03-10T00:04:00.000Z',
        startDisplay: '2026-03-10 08:04',
        firstPromptPreview: 'Delegated newer run',
        threadKind: 'subagent',
        parentSessionId: 'root-older',
      }),
      session({
        id: 'root-newest',
        startTime: '2026-03-10T00:03:00.000Z',
        startDisplay: '2026-03-10 08:03',
        firstPromptPreview: 'Newest task',
        threadKind: 'primary',
      }),
    ])

    expect(forest).toHaveLength(2)
    expect(forest[0].session.id).toBe('root-older')
    expect(forest[0].latestActivityTime).toBe('2026-03-10T00:04:00.000Z')
    expect(forest[0].children[0].session.id).toBe('child-newer')
    expect(forest[1].session.id).toBe('root-newest')
  })

  it('keeps parent sessions when selecting top display roots', () => {
    const sessions = selectCodexDisplaySessions([
      session({
        id: 'old-root',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        firstPromptPreview: 'Old root',
        threadKind: 'primary',
      }),
      session({
        id: 'new-child',
        startTime: '2026-03-10T00:05:00.000Z',
        startDisplay: '2026-03-10 08:05',
        firstPromptPreview: 'Delegated work',
        threadKind: 'subagent',
        parentSessionId: 'old-root',
      }),
      session({
        id: 'other-root',
        startTime: '2026-03-09T23:59:00.000Z',
        startDisplay: '2026-03-10 07:59',
        firstPromptPreview: 'Other task',
        threadKind: 'primary',
      }),
    ], 1)

    expect(sessions.map((item) => item.id)).toEqual(['new-child', 'old-root'])
  })

  it('can return only root sessions for the initial overview payload', () => {
    const sessions = selectCodexRootSessions([
      session({
        id: 'old-root',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        firstPromptPreview: 'Old root',
        threadKind: 'primary',
      }),
      session({
        id: 'new-child',
        startTime: '2026-03-10T00:05:00.000Z',
        startDisplay: '2026-03-10 08:05',
        firstPromptPreview: 'Delegated work',
        threadKind: 'subagent',
        parentSessionId: 'old-root',
      }),
      session({
        id: 'other-root',
        startTime: '2026-03-09T23:59:00.000Z',
        startDisplay: '2026-03-10 07:59',
        firstPromptPreview: 'Other task',
        threadKind: 'primary',
      }),
    ], 1)

    expect(sessions.map((item) => item.id)).toEqual(['old-root'])
  })

  it('finds the active delegated-work lineage', () => {
    const forest = buildCodexThreadForest([
      session({
        id: 'root',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        firstPromptPreview: 'Root task',
        threadKind: 'primary',
      }),
      session({
        id: 'worker',
        startTime: '2026-03-10T00:02:00.000Z',
        startDisplay: '2026-03-10 08:02',
        firstPromptPreview: 'Worker task',
        threadKind: 'subagent',
        parentSessionId: 'root',
      }),
      session({
        id: 'reviewer',
        startTime: '2026-03-10T00:03:00.000Z',
        startDisplay: '2026-03-10 08:03',
        firstPromptPreview: 'Reviewer task',
        threadKind: 'subagent',
        parentSessionId: 'worker',
      }),
    ])

    const context = findCodexSelectionContext(forest, 'reviewer')

    expect(context?.root.session.id).toBe('root')
    expect(context?.lineage.map((node) => node.session.id)).toEqual(['root', 'worker', 'reviewer'])
  })

  it('preserves ancestor context when filtering by delegated-work matches', () => {
    const forest = buildCodexThreadForest([
      session({
        id: 'root',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        firstPromptPreview: 'Root task',
        threadKind: 'primary',
      }),
      session({
        id: 'worker',
        startTime: '2026-03-10T00:02:00.000Z',
        startDisplay: '2026-03-10 08:02',
        firstPromptPreview: 'Worker task',
        threadKind: 'subagent',
        parentSessionId: 'root',
      }),
      session({
        id: 'reviewer',
        startTime: '2026-03-10T00:03:00.000Z',
        startDisplay: '2026-03-10 08:03',
        firstPromptPreview: 'Reviewer task',
        threadKind: 'subagent',
        parentSessionId: 'worker',
      }),
    ])

    const filtered = filterCodexThreadForest(forest, (candidate) => candidate.id === 'reviewer')

    expect(filtered).toHaveLength(1)
    expect(filtered[0].session.id).toBe('root')
    expect(filtered[0].children[0].session.id).toBe('worker')
    expect(filtered[0].children[0].children[0].session.id).toBe('reviewer')
  })

  it('tracks unlinked delegated work separately from main tasks', () => {
    const forest = buildCodexThreadForest([
      session({
        id: 'root',
        startTime: '2026-03-10T00:00:00.000Z',
        startDisplay: '2026-03-10 08:00',
        firstPromptPreview: 'Root task',
        threadKind: 'primary',
      }),
      session({
        id: 'orphan',
        startTime: '2026-03-10T00:01:00.000Z',
        startDisplay: '2026-03-10 08:01',
        firstPromptPreview: 'Detached delegated work',
        threadKind: 'subagent',
        parentSessionId: 'missing',
      }),
    ])

    expect(summarizeCodexThreadForest(forest)).toEqual({
      mainTaskCount: 1,
      delegatedCount: 0,
      unlinkedCount: 1,
    })
  })
})
