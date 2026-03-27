// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SkillRecommendationAnalysis,
  SkillRecommendationBackendStatus,
} from '../lib/skill-recommendations'
import { useClaudeSkillRecommendations } from './useClaudeSkillRecommendations'

afterEach(() => {
  vi.clearAllMocks()
})

const READY_BACKEND: SkillRecommendationBackendStatus = {
  available: true,
  backend: 'claude-code',
  cliPath: '/usr/local/bin/claude',
  model: 'haiku',
  sessionLimit: 6,
  message: 'Runs an on-demand local Claude Code team analysis over recent session history.',
}

const UNAVAILABLE_BACKEND: SkillRecommendationBackendStatus = {
  available: false,
  backend: 'claude-code',
  reason: 'server-required',
  message: 'Claude-backed skill analysis requires the local Node/Vite server API and is unavailable in browser-only file access mode.',
}

const ANALYSIS: SkillRecommendationAnalysis = {
  generatedAt: '2026-03-24T10:00:00.000Z',
  backend: 'claude-code',
  model: 'haiku',
  scope: 'smart',
  requestedProjectEncoded: null,
  scopeLabel: 'Smart scope',
  targetLabel: null,
  analyzedSessionCount: 4,
  discussion: [
    { agent: 'historian', point: 'Repeatedly saw website-integration analysis in recent history.' },
  ],
  recommendations: [
    {
      id: 'site-recommend',
      name: 'site-recommend',
      title: 'Website integration scout',
      summary: 'Recommend recurring websites that should become integrations.',
      rationale: 'Recent history repeatedly asks for this analysis.',
      whenToUse: 'Use when recent history asks which sites to integrate.',
      steps: ['Read recent history', 'Extract sites', 'Rank candidates'],
      evidence: ['github.com', 'claude.com'],
      confidence: 'high',
    },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useClaudeSkillRecommendations', () => {
  it('checks backend availability and runs on-demand Claude analysis', async () => {
    const fileStore = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn().mockResolvedValue(READY_BACKEND),
      analyzeSkillRecommendations: vi.fn().mockResolvedValue(ANALYSIS),
    }

    const { result } = renderHook(() => useClaudeSkillRecommendations({ fileStore }))

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('ready')
    })

    await act(async () => {
      await result.current.analyze({ scope: 'project', projectEncoded: 'project-alpha', sessionLimit: 4 })
    })

    expect(fileStore.analyzeSkillRecommendations).toHaveBeenCalledWith({ scope: 'project', projectEncoded: 'project-alpha', sessionLimit: 4 })
    expect(result.current.recommendations.analysis?.recommendations[0]?.name).toBe('site-recommend')
  })

  it('surfaces an explicit unavailable state when the local server is missing', async () => {
    const fileStore = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn().mockResolvedValue(UNAVAILABLE_BACKEND),
      analyzeSkillRecommendations: vi.fn(),
    }

    const { result } = renderHook(() => useClaudeSkillRecommendations({ fileStore }))

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('unavailable')
    })

    expect(result.current.recommendations.error).toContain('local Node/Vite server API')
    expect(fileStore.analyzeSkillRecommendations).not.toHaveBeenCalled()
  })

  it('can recheck backend readiness after an unavailable state', async () => {
    const fileStore = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn()
        .mockResolvedValueOnce(UNAVAILABLE_BACKEND)
        .mockResolvedValueOnce(READY_BACKEND),
      analyzeSkillRecommendations: vi.fn(),
    }

    const { result } = renderHook(() => useClaudeSkillRecommendations({ fileStore }))

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('unavailable')
    })

    await act(async () => {
      await result.current.recheck()
    })

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('ready')
    })

    expect(fileStore.getSkillRecommendationBackendStatus).toHaveBeenCalledTimes(2)
  })

  it('ignores stale analysis responses when a newer run finishes later', async () => {
    const first = deferred<SkillRecommendationAnalysis>()
    const second = deferred<SkillRecommendationAnalysis>()
    const fileStore = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn().mockResolvedValue(READY_BACKEND),
      analyzeSkillRecommendations: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    }

    const { result } = renderHook(() => useClaudeSkillRecommendations({ fileStore }))

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('ready')
    })

    await act(async () => {
      void result.current.analyze({ scope: 'recent' })
      void result.current.analyze({ scope: 'project', projectEncoded: 'project-alpha' })
    })

    second.resolve({
      ...ANALYSIS,
      scope: 'project',
      requestedProjectEncoded: 'project-alpha',
      targetLabel: 'project-alpha',
    })
    first.resolve({
      ...ANALYSIS,
      scope: 'recent',
      requestedProjectEncoded: null,
      targetLabel: null,
    })

    await waitFor(() => {
      expect(result.current.recommendations.analysis?.scope).toBe('project')
    })
  })

  it('invalidates an in-flight analysis when fileStore changes to a new non-null store', async () => {
    const first = deferred<SkillRecommendationAnalysis>()
    const storeA = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn().mockResolvedValue(READY_BACKEND),
      analyzeSkillRecommendations: vi.fn().mockReturnValue(first.promise),
    }
    const storeB = {
      scanProjects: vi.fn(),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn().mockResolvedValue(READY_BACKEND),
      analyzeSkillRecommendations: vi.fn(),
    }

    const { result, rerender } = renderHook(({ fileStore }) => useClaudeSkillRecommendations({ fileStore }), {
      initialProps: { fileStore: storeA },
    })

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('ready')
    })

    await act(async () => {
      void result.current.analyze({ scope: 'recent' })
    })

    rerender({ fileStore: storeB })

    await waitFor(() => {
      expect(result.current.recommendations.status).toBe('ready')
    })

    first.resolve({
      ...ANALYSIS,
      scope: 'recent',
      requestedProjectEncoded: null,
      targetLabel: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current.recommendations.analysis).toBeNull()
  })
})
