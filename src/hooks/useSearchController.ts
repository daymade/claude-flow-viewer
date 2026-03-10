import { startTransition, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'

import type { FileStore, SearchBackendStatus } from '../lib/fs-access'
import type { SearchResult } from '../lib/search'

export interface SearchJumpTarget {
  chunkId: string
  projectEncoded: string
  sessionId: string
  messageIndex: number
  promptNum?: number
}

export interface SearchControllerState {
  status: 'idle' | 'checking' | 'searching' | 'ready' | 'unavailable' | 'error'
  results: SearchResult[]
  error: string | null
  activeTarget: SearchJumpTarget | null
  backend: SearchBackendStatus | null
}

interface UseSearchControllerArgs {
  query: string
  fileStore: FileStore | null
  loadSession: (projectEncoded: string, sessionId: string) => Promise<void>
}

const EMPTY_STATE: SearchControllerState = {
  status: 'idle',
  results: [],
  error: null,
  activeTarget: null,
  backend: null,
}

function isActiveTargetInResults(activeTarget: SearchJumpTarget | null, results: SearchResult[]): boolean {
  if (!activeTarget) return false
  return results.some((result) => result.chunkId === activeTarget.chunkId)
}

function statusForBackend(backend: SearchBackendStatus | null): SearchControllerState['status'] {
  if (!backend) return 'checking'
  return backend.available ? 'idle' : 'unavailable'
}

function backendMessage(backend: SearchBackendStatus | null): string | null {
  if (!backend || backend.available) return null
  return backend.message
}

export function useSearchController({
  query,
  fileStore,
  loadSession,
}: UseSearchControllerArgs) {
  const deferredQuery = useDeferredValue(query.trim())
  const [state, setState] = useState<SearchControllerState>(EMPTY_STATE)
  const requestIdRef = useRef(0)
  const activeTargetRef = useRef<SearchJumpTarget | null>(null)

  useEffect(() => {
    requestIdRef.current += 1

    if (!fileStore) {
      activeTargetRef.current = null
      startTransition(() => {
        setState(EMPTY_STATE)
      })
      return
    }

    if (!fileStore.getSearchBackendStatus) {
      activeTargetRef.current = null
      startTransition(() => {
        setState({
          status: 'unavailable',
          results: [],
          error: 'Search requires the local server.',
          activeTarget: null,
          backend: null,
        })
      })
      return
    }

    let cancelled = false
    startTransition(() => {
      setState((prev) => ({
        ...prev,
        status: 'checking',
        error: null,
        results: [],
      }))
    })

    void fileStore.getSearchBackendStatus().then((backend) => {
      if (cancelled) return
      activeTargetRef.current = null
      startTransition(() => {
        setState({
          status: statusForBackend(backend),
          results: [],
          error: backend.available ? null : backend.message,
          activeTarget: null,
          backend,
        })
      })
    }).catch((error) => {
      if (cancelled) return
      startTransition(() => {
        setState({
          status: 'error',
          results: [],
          error: (error as Error).message,
          activeTarget: null,
          backend: null,
        })
      })
    })

    return () => { cancelled = true }
  }, [fileStore])

  useEffect(() => {
    if (!deferredQuery) {
      activeTargetRef.current = null
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: statusForBackend(prev.backend),
          results: [],
          error: backendMessage(prev.backend),
          activeTarget: null,
        }))
      })
      return
    }

    if (!fileStore || !state.backend) {
      return
    }

    if (!state.backend.available) {
      activeTargetRef.current = null
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'unavailable',
          results: [],
          error: backendMessage(state.backend) ?? 'Search requires the local server.',
          activeTarget: null,
        }))
      })
      return
    }

    if (!fileStore.searchSessions) {
      activeTargetRef.current = null
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'unavailable',
          results: [],
          error: 'Search requires the local server.',
          activeTarget: null,
        }))
      })
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    let cancelled = false

    startTransition(() => {
      setState((prev) => ({
        ...prev,
        status: 'searching',
        error: null,
      }))
    })

    void fileStore.searchSessions(deferredQuery, { limit: 10 }).then((results) => {
      if (cancelled || requestId !== requestIdRef.current) return

      const nextActiveTarget = isActiveTargetInResults(activeTargetRef.current, results)
        ? activeTargetRef.current
        : null
      activeTargetRef.current = nextActiveTarget

      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'ready',
          results,
          error: null,
          activeTarget: nextActiveTarget,
        }))
      })
    }).catch((error) => {
      if (cancelled || requestId !== requestIdRef.current) return
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'error',
          results: [],
          error: (error as Error).message,
          activeTarget: null,
        }))
      })
    })

    return () => { cancelled = true }
  }, [deferredQuery, fileStore, state.backend])

  const selectResult = useCallback(async (result: SearchResult) => {
    await loadSession(result.projectEncoded, result.sessionId)
    const nextTarget: SearchJumpTarget = {
      chunkId: result.chunkId,
      projectEncoded: result.projectEncoded,
      sessionId: result.sessionId,
      messageIndex: result.locator.messageIndex,
      promptNum: result.locator.promptNum,
    }
    activeTargetRef.current = nextTarget
    startTransition(() => {
      setState((prev) => ({
        ...prev,
        activeTarget: nextTarget,
      }))
    })
  }, [loadSession])

  const clearActiveTarget = useCallback(() => {
    activeTargetRef.current = null
    startTransition(() => {
      setState((prev) => ({
        ...prev,
        activeTarget: null,
      }))
    })
  }, [])

  const isBusy = state.status === 'checking' || state.status === 'searching'

  return {
    search: state,
    isBusy,
    selectResult,
    clearActiveTarget,
  }
}
