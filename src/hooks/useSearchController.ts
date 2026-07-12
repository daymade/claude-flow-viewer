import { startTransition, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'

import type { FileStore, SearchBackendStatus } from '../lib/fs-access'
import type { SearchResult } from '../lib/search'
import type { ResolvedSessionRef, SessionSource } from '../types/session'
import { detectSessionIdentifier } from '../lib/session-identifier'

export interface SearchJumpTarget {
  chunkId: string
  projectEncoded: string
  sessionId: string
  messageIndex: number
  promptNum?: number
}

/** State of the "known-item" resolve lane, independent of the full-text search backend. */
export type ResolveStatus = 'idle' | 'resolving' | 'hit' | 'miss' | 'error'

export interface SearchControllerState {
  status: 'idle' | 'checking' | 'searching' | 'ready' | 'unavailable' | 'error'
  results: SearchResult[]
  error: string | null
  activeTarget: SearchJumpTarget | null
  backend: SearchBackendStatus | null
  /** A session located by identifier (the resolve lane); null when the query is not an id or misses. */
  resolved: ResolvedSessionRef | null
  resolvedStatus: ResolveStatus
}

interface UseSearchControllerArgs {
  query: string
  fileStore: FileStore | null
  loadSession: (projectEncoded: string, sessionId: string, sourceHint?: SessionSource) => Promise<void>
  /** Inject the resolved session's meta into the project list before loading it (blocker fix). */
  upsertSessionMeta: (ref: ResolvedSessionRef) => void
}

const EMPTY_STATE: SearchControllerState = {
  status: 'idle',
  results: [],
  error: null,
  activeTarget: null,
  backend: null,
  resolved: null,
  resolvedStatus: 'idle',
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
  upsertSessionMeta,
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
        setState((prev) => ({
          ...prev,
          status: 'unavailable',
          results: [],
          error: 'Search requires the local server.',
          activeTarget: null,
          backend: null,
        }))
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
        setState((prev) => ({
          ...prev,
          status: statusForBackend(backend),
          results: [],
          error: backend.available ? null : backend.message,
          activeTarget: null,
          backend,
        }))
      })
    }).catch((error) => {
      if (cancelled) return
      startTransition(() => {
        setState((prev) => ({
          ...prev,
          status: 'error',
          results: [],
          error: (error as Error).message,
          activeTarget: null,
          backend: null,
        }))
      })
    })

    return () => { cancelled = true }
  }, [fileStore])

  // Resolve lane — deliberately independent of the SQLite search backend (works in browser mode
  // where FTS is unavailable). detectSessionIdentifier gates it so a normal query never touches
  // resolveSession; a hit surfaces a direct-open target that the panel renders ABOVE the FTS list.
  // Both lanes run in parallel: the id is never fed to the tokenizer as a recall query, and a
  // content-embedded UUID that misses simply leaves resolved=null and falls through to FTS.
  useEffect(() => {
    const resolveSession = fileStore?.resolveSession
    if (!deferredQuery || !fileStore || !resolveSession) {
      startTransition(() => {
        setState((prev) => ({ ...prev, resolved: null, resolvedStatus: 'idle' }))
      })
      return
    }

    const match = detectSessionIdentifier(deferredQuery)
    if (!match) {
      startTransition(() => {
        setState((prev) => ({ ...prev, resolved: null, resolvedStatus: 'idle' }))
      })
      return
    }

    let cancelled = false
    startTransition(() => {
      setState((prev) => ({ ...prev, resolved: null, resolvedStatus: 'resolving' }))
    })

    void resolveSession.call(fileStore, match.sessionId).then((ref) => {
      if (cancelled) return
      startTransition(() => {
        setState((prev) => ({ ...prev, resolved: ref, resolvedStatus: ref ? 'hit' : 'miss' }))
      })
    }).catch(() => {
      // A thrown resolveSession (server 5xx / network) is an ERROR, not a definitive miss —
      // surfacing it as "not found" would wrongly tell the user the session doesn't exist.
      if (cancelled) return
      startTransition(() => {
        setState((prev) => ({ ...prev, resolved: null, resolvedStatus: 'error' }))
      })
    })

    return () => { cancelled = true }
  }, [deferredQuery, fileStore])

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

  const openResolved = useCallback(async () => {
    const ref = state.resolved
    if (!ref) return
    // Inject the resolved meta first so AppShell derives activeSession even when the session is
    // beyond the per-project 50-cap (and thus absent from the scanned list). Thread the authoritative
    // source so parsing does not have to re-derive it from a project that may not be in the list yet.
    upsertSessionMeta(ref)
    await loadSession(ref.projectEncoded, ref.sessionId, ref.source)
  }, [state.resolved, upsertSessionMeta, loadSession])

  const isBusy = state.status === 'checking' || state.status === 'searching'

  return {
    search: state,
    isBusy,
    selectResult,
    clearActiveTarget,
    openResolved,
  }
}
