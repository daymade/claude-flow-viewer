// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SearchBackendStatus } from '../lib/fs-access'
import type { SearchResult } from '../lib/search'
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

describe('useSearchController', () => {
  it('uses the server search backend and turns a selected result into a jump target', async () => {
    const fileStore = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      getSearchBackendStatus: vi.fn().mockResolvedValue(READY_BACKEND),
      searchSessions: vi.fn().mockResolvedValue([makeResult()]),
    }
    const loadSession = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() => useSearchController({
      query: 'neon skyline',
      fileStore,
      loadSession,
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
    const fileStore = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      getSearchBackendStatus: vi.fn().mockResolvedValue(UNAVAILABLE_BACKEND),
      searchSessions: vi.fn(),
    }

    const { result } = renderHook(() => useSearchController({
      query: 'neon skyline',
      fileStore,
      loadSession: vi.fn().mockResolvedValue(undefined),
    }))

    await waitFor(() => {
      expect(result.current.search.status).toBe('unavailable')
    })

    expect(result.current.search.error).toContain('local Node/Vite server API')
    expect(fileStore.searchSessions).not.toHaveBeenCalled()
  })
})
