// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SearchBackendStatus } from '../lib/fs-access'
import type { SearchResult } from '../lib/search'
import type { ResolvedSessionRef, SessionMeta } from '../types/session'
import { useSearchController } from './useSearchController'

afterEach(() => {
  vi.clearAllMocks()
})

const READY_BACKEND: SearchBackendStatus = {
  available: true,
  backend: 'sqlite',
  dbPath: '/tmp/search.sqlite',
  indexedAt: '2026-03-10T00:00:00.000Z',
  stats: {
    sessionCount: 1,
    chunkCount: 8,
    tokenCount: 24,
    trigramCount: 40,
  },
}

const UNAVAILABLE_BACKEND: SearchBackendStatus = {
  available: false,
  backend: 'sqlite',
  reason: 'server-required',
  message: 'Search requires the local Node/Vite server API and is unavailable in browser-only file access mode.',
}

const BARE_ID = '04207f06-471e-4983-b97a-029d611b56c5'

function makeResult(): SearchResult {
  return {
    chunkId: 'project-alpha:session-1:1:ai-text',
    projectEncoded: 'project-alpha',
    projectLabel: '/Users/test/project-alpha',
    projectShortName: 'project-alpha',
    sessionId: 'session-1',
    source: 'claude',
    kind: 'ai-text',
    locator: {
      kind: 'ai-text',
      messageIndex: 1,
    },
    title: 'AI response',
    snippet: 'Use a neon city skyline with rain reflections and amber rim light.',
    matchedText: 'neon city skyline',
    score: 42.5,
    reasons: {
      exactPhrase: 24,
      tokenOverlap: 8,
      trigram: 6,
      semantic: 0.5,
      kindBoost: 2,
      metadataBoost: 1,
      recency: 1.5,
    },
  }
}

function makeMeta(id: string): SessionMeta {
  return {
    source: 'claude',
    id,
    startTime: '2026-03-10T00:00:00.000Z',
    startDisplay: '2026-03-10 00:00',
    promptCount: 3,
    toolCount: 1,
    firstPromptPreview: 'Resolve me',
    fileSize: 1024,
    recordCount: 10,
  }
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    scanProjects: vi.fn(),
    readSessionContent: vi.fn(),
    scanAllProjectSessions: vi.fn(),
    readToolResult: vi.fn(),
    getSearchBackendStatus: vi.fn().mockResolvedValue(READY_BACKEND),
    searchSessions: vi.fn().mockResolvedValue([]),
    analyzeSkillRecommendations: vi.fn(),
    getSkillRecommendationBackendStatus: vi.fn(),
    ...overrides,
  }
}

describe('useSearchController', () => {
  it('uses the server search backend and turns a selected result into a jump target', async () => {
    const fileStore = makeStore({ searchSessions: vi.fn().mockResolvedValue([makeResult()]) })
    const loadSession = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() => useSearchController({
      query: 'neon skyline',
      fileStore,
      loadSession,
      upsertSessionMeta: vi.fn(),
    }))

    await waitFor(() => {
      expect(result.current.search.status).toBe('ready')
      expect(result.current.search.results).toHaveLength(1)
    })

    expect(fileStore.getSearchBackendStatus).toHaveBeenCalledTimes(1)
    expect(fileStore.searchSessions).toHaveBeenCalledWith('neon skyline', { limit: 10 })

    const hit = result.current.search.results[0]

    await act(async () => {
      await result.current.selectResult(hit)
    })

    expect(loadSession).toHaveBeenCalledWith('project-alpha', 'session-1')
    expect(result.current.search.activeTarget).toEqual({
      chunkId: hit.chunkId,
      projectEncoded: 'project-alpha',
      sessionId: 'session-1',
      messageIndex: 1,
      promptNum: undefined,
    })
  })

  it('surfaces an explicit unavailable state and does not query searchSessions without the server', async () => {
    const fileStore = makeStore({
      getSearchBackendStatus: vi.fn().mockResolvedValue(UNAVAILABLE_BACKEND),
      searchSessions: vi.fn(),
    })

    const { result } = renderHook(() => useSearchController({
      query: 'neon skyline',
      fileStore,
      loadSession: vi.fn().mockResolvedValue(undefined),
      upsertSessionMeta: vi.fn(),
    }))

    await waitFor(() => {
      expect(result.current.search.status).toBe('unavailable')
    })

    expect(result.current.search.error).toContain('local Node/Vite server API')
    expect(fileStore.searchSessions).not.toHaveBeenCalled()
  })

  it('resolves a bare session id through the resolve lane and opens it with a meta upsert', async () => {
    const resolvedRef: ResolvedSessionRef = {
      source: 'claude',
      projectEncoded: 'demo-project',
      sessionId: BARE_ID,
      meta: makeMeta(BARE_ID),
    }
    const resolveSession = vi.fn().mockResolvedValue(resolvedRef)
    const fileStore = makeStore({ resolveSession })
    const loadSession = vi.fn().mockResolvedValue(undefined)
    const upsertSessionMeta = vi.fn()

    const { result } = renderHook(() => useSearchController({
      query: BARE_ID,
      fileStore,
      loadSession,
      upsertSessionMeta,
    }))

    await waitFor(() => {
      expect(result.current.search.resolvedStatus).toBe('hit')
      expect(result.current.search.resolved).toEqual(resolvedRef)
    })
    expect(resolveSession).toHaveBeenCalledWith(BARE_ID)

    await act(async () => {
      await result.current.openResolved()
    })
    // Meta is injected BEFORE loadSession so AppShell can derive activeSession, and the authoritative
    // source is threaded so parsing does not re-derive it from a not-yet-listed project.
    expect(upsertSessionMeta).toHaveBeenCalledWith(resolvedRef)
    expect(loadSession).toHaveBeenCalledWith('demo-project', BARE_ID, 'claude')
  })

  it('never touches the resolve lane for a normal phrase that merely embeds a UUID', async () => {
    const resolveSession = vi.fn()
    const fileStore = makeStore({
      searchSessions: vi.fn().mockResolvedValue([makeResult()]),
      resolveSession,
    })

    const { result } = renderHook(() => useSearchController({
      query: `why did ${BARE_ID} crash`,
      fileStore,
      loadSession: vi.fn(),
      upsertSessionMeta: vi.fn(),
    }))

    await waitFor(() => {
      expect(result.current.search.status).toBe('ready')
    })
    expect(resolveSession).not.toHaveBeenCalled()
    expect(result.current.search.resolvedStatus).toBe('idle')
  })

  it('resolves independently of the search backend (browser mode: available=false)', async () => {
    const resolvedRef: ResolvedSessionRef = {
      source: 'claude',
      projectEncoded: 'demo-project',
      sessionId: BARE_ID,
      meta: makeMeta(BARE_ID),
    }
    const resolveSession = vi.fn().mockResolvedValue(resolvedRef)
    const searchSessions = vi.fn()
    const fileStore = makeStore({
      getSearchBackendStatus: vi.fn().mockResolvedValue(UNAVAILABLE_BACKEND),
      searchSessions,
      resolveSession,
    })

    const { result } = renderHook(() => useSearchController({
      query: BARE_ID,
      fileStore,
      loadSession: vi.fn(),
      upsertSessionMeta: vi.fn(),
    }))

    await waitFor(() => {
      expect(result.current.search.resolvedStatus).toBe('hit')
    })
    expect(resolveSession).toHaveBeenCalled()
    expect(result.current.search.resolved).toEqual(resolvedRef)
    // The full-text search itself stays unavailable — the two lanes are independent.
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('marks resolvedStatus "miss" when a bare id resolves to nothing', async () => {
    const fileStore = makeStore({ resolveSession: vi.fn().mockResolvedValue(null) })

    const { result } = renderHook(() => useSearchController({
      query: '00000000-0000-4000-8000-000000000000',
      fileStore,
      loadSession: vi.fn(),
      upsertSessionMeta: vi.fn(),
    }))

    await waitFor(() => {
      expect(result.current.search.resolvedStatus).toBe('miss')
    })
    expect(result.current.search.resolved).toBeNull()
  })
})
