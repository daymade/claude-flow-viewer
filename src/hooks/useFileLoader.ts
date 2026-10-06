import { useCallback } from 'react'
import { useAppState } from './useSessionStore'
import { openDirectoryPicker, createStoreFromFiles, createStoreFromHandle, tryAutoLoad } from '../lib/fs-access'
import { parseFetchedSessionContent } from '../lib/parser'
import type { SessionSource } from '../types/session'

// --- Hash-based URL routing ---

export function encodeHash(projectEncoded: string, sessionId: string): string {
  return `#/${encodeURIComponent(projectEncoded)}/${encodeURIComponent(sessionId)}`
}

export function decodeHash(): { projectEncoded: string; sessionId: string } | null {
  const hash = window.location.hash
  if (!hash.startsWith('#/')) return null
  const parts = hash.slice(2).split('/')
  if (parts.length < 2) return null
  return {
    projectEncoded: decodeURIComponent(parts[0]),
    sessionId: decodeURIComponent(parts.slice(1).join('/')),
  }
}

export function useFileLoader() {
  const { state, dispatch } = useAppState()

  const loadStore = useCallback(async (store: Awaited<ReturnType<typeof openDirectoryPicker>> | Awaited<ReturnType<typeof createStoreFromFiles>> | Awaited<ReturnType<typeof createStoreFromHandle>>) => {
    const projects = await store.scanProjects()
    dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })

    const notice = await store.getBrowserModeNotice?.()
    if (notice && projects.length === 0) {
      dispatch({ type: 'SET_ERROR', error: notice })
    }
  }, [dispatch])

  const loadDirectory = useCallback(async () => {
    dispatch({ type: 'LOAD_START' })
    try {
      const store = await openDirectoryPicker()
      await loadStore(store)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        dispatch({ type: 'SET_ERROR', error: '' })
        return
      }
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch, loadStore])

  const loadFromFiles = useCallback(async (files: FileList) => {
    dispatch({ type: 'LOAD_START' })
    try {
      const store = createStoreFromFiles(files)
      await loadStore(store)
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch, loadStore])

  const loadSession = useCallback(async (projectEncoded: string, sessionId: string, sourceHint?: SessionSource) => {
    if (!state.fileStore) return
    dispatch({ type: 'LOAD_SESSION_START' })
    try {
      const project = state.projects.find((item) => item.encodedName === projectEncoded)
      const content = await state.fileStore.readSessionContent(projectEncoded, sessionId)
      // Prefer the known source: the project list may not yet include a just-resolved beyond-cap
      // session, so project?.source can be undefined even though the caller knows the real source.
      const data = parseFetchedSessionContent(content, project?.source ?? sourceHint)
      dispatch({ type: 'LOAD_SESSION', sessionId, projectEncoded, data })
      // Sync URL hash
      const newHash = encodeHash(projectEncoded, sessionId)
      if (window.location.hash !== newHash) {
        history.replaceState(null, '', newHash)
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [state.fileStore, state.projects, dispatch])

  const loadFromHandle = useCallback(async (handle: FileSystemDirectoryHandle) => {
    dispatch({ type: 'LOAD_START' })
    try {
      const store = createStoreFromHandle(handle)
      await loadStore(store)
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch, loadStore])

  const loadAllProjectSessions = useCallback(async (projectEncoded: string) => {
    if (!state.fileStore) return
    try {
      const sessions = await state.fileStore.scanAllProjectSessions(projectEncoded)
      dispatch({ type: 'EXPAND_PROJECT_SESSIONS', projectEncoded, sessions })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [state.fileStore, dispatch])

  /** Try API first (dev server), fall back to directory picker */
  const switchDirectory = useCallback(async () => {
    dispatch({ type: 'RESET' })
    dispatch({ type: 'LOAD_START' })
    try {
      const apiStore = await tryAutoLoad()
      if (apiStore) {
        await loadStore(apiStore)
        return
      }
    } catch { /* API not available, fall through */ }
    // No API — open directory picker
    try {
      const store = await openDirectoryPicker()
      await loadStore(store)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        dispatch({ type: 'SET_ERROR', error: '' })
        return
      }
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch, loadStore])

  return { loadDirectory, loadFromFiles, loadFromHandle, loadSession, loadAllProjectSessions, switchDirectory }
}
