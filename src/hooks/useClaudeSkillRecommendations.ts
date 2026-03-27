import { startTransition, useCallback, useEffect, useRef, useState } from 'react'

import type { FileStore } from '../lib/fs-access'
import type {
  SkillRecommendationAnalysis,
  SkillRecommendationBackendStatus,
  SkillRecommendationAnalyzeOptions,
} from '../lib/skill-recommendations'

export interface ClaudeSkillRecommendationsState {
  status: 'idle' | 'checking' | 'ready' | 'analyzing' | 'unavailable' | 'error'
  analysis: SkillRecommendationAnalysis | null
  error: string | null
  backend: SkillRecommendationBackendStatus | null
  contextVersion: number
}

const EMPTY_STATE: ClaudeSkillRecommendationsState = {
  status: 'idle',
  analysis: null,
  error: null,
  backend: null,
  contextVersion: 0,
}

function backendMessage(backend: SkillRecommendationBackendStatus | null): string | null {
  if (!backend || backend.available) return null
  return backend.message
}

function statusForBackend(backend: SkillRecommendationBackendStatus | null): ClaudeSkillRecommendationsState['status'] {
  if (!backend) return 'checking'
  return backend.available ? 'ready' : 'unavailable'
}

export function useClaudeSkillRecommendations({
  fileStore,
}: {
  fileStore: FileStore | null
}) {
  const [state, setState] = useState<ClaudeSkillRecommendationsState>(EMPTY_STATE)
  const analysisRequestIdRef = useRef(0)
  const statusRequestIdRef = useRef(0)
  const contextVersionRef = useRef(0)

  const recheck = useCallback(async () => {
    analysisRequestIdRef.current += 1
    const requestId = statusRequestIdRef.current + 1
    statusRequestIdRef.current = requestId

    if (!fileStore) {
      startTransition(() => {
        setState((prev) => ({
          ...EMPTY_STATE,
          contextVersion: prev.contextVersion,
        }))
      })
      return
    }

    startTransition(() => {
      setState((prev) => ({
        ...prev,
        status: 'checking',
        analysis: null,
        error: null,
      }))
    })

    try {
      const backend = await fileStore.getSkillRecommendationBackendStatus()
      if (requestId !== statusRequestIdRef.current) return
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: statusForBackend(backend),
          analysis: null,
          error: backendMessage(backend),
          backend,
        }))
      })
    } catch (error) {
      if (requestId !== statusRequestIdRef.current) return
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'error',
          analysis: null,
          error: (error as Error).message,
          backend: null,
        }))
      })
    }
  }, [fileStore])

  useEffect(() => {
    void recheck()
  }, [recheck])

  useEffect(() => {
    contextVersionRef.current += 1
    const contextVersion = contextVersionRef.current

    if (!fileStore) {
      startTransition(() => {
        setState({
          ...EMPTY_STATE,
          contextVersion,
        })
      })
      return
    }

    startTransition(() => {
      setState((prev) => ({
        ...prev,
        contextVersion,
      }))
    })
  }, [fileStore])

  const analyze = useCallback(async (options: SkillRecommendationAnalyzeOptions = {}) => {
    if (!fileStore || !state.backend?.available) return
    const requestId = analysisRequestIdRef.current + 1
    analysisRequestIdRef.current = requestId

    startTransition(() => {
      setState((prev) => ({
        ...prev,
        status: 'analyzing',
        error: null,
      }))
    })

    try {
      const analysis = await fileStore.analyzeSkillRecommendations(options)
      if (requestId !== analysisRequestIdRef.current) return
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'ready',
          analysis,
          error: null,
        }))
      })
    } catch (error) {
      if (requestId !== analysisRequestIdRef.current) return
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'error',
          analysis: null,
          error: (error as Error).message,
        }))
      })
    }
  }, [fileStore, state.backend])

  return {
    recommendations: state,
    analyze,
    recheck,
  }
}
