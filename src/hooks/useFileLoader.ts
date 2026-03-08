import { useCallback } from 'react'
import { useAppState } from './useSessionStore'
import { openDirectoryPicker, createStoreFromFiles, createStoreFromHandle, tryAutoLoad } from '../lib/fs-access'
import { parseSessionContent } from '../lib/parser'

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

  const loadDirectory = useCallback(async () => {
    dispatch({ type: 'LOAD_START' })
    try {
      const store = await openDirectoryPicker()
      const projects = await store.scanProjects()
      dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        dispatch({ type: 'SET_ERROR', error: '' })
        return
      }
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch])

  const loadFromFiles = useCallback(async (files: FileList) => {
    dispatch({ type: 'LOAD_START' })
    try {
      const store = createStoreFromFiles(files)
      const projects = await store.scanProjects()
      dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch])

  const loadSession = useCallback(async (projectEncoded: string, sessionId: string) => {
    if (!state.fileStore) return
    dispatch({ type: 'LOAD_SESSION_START' })
    try {
      const content = await state.fileStore.readSessionContent(projectEncoded, sessionId)
      const data = parseSessionContent(content)
      dispatch({ type: 'LOAD_SESSION', sessionId, projectEncoded, data })
      // Sync URL hash
      const newHash = encodeHash(projectEncoded, sessionId)
      if (window.location.hash !== newHash) {
        history.replaceState(null, '', newHash)
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [state.fileStore, dispatch])

  const loadFromHandle = useCallback(async (handle: FileSystemDirectoryHandle) => {
    dispatch({ type: 'LOAD_START' })
    try {
      const store = createStoreFromHandle(handle)
      const projects = await store.scanProjects()
      dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch])

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
        const projects = await apiStore.scanProjects()
        dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: apiStore })
        return
      }
    } catch { /* API not available, fall through */ }
    // No API — open directory picker
    try {
      const store = await openDirectoryPicker()
      const projects = await store.scanProjects()
      dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        dispatch({ type: 'SET_ERROR', error: '' })
        return
      }
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [dispatch])

  return { loadDirectory, loadFromFiles, loadFromHandle, loadSession, loadAllProjectSessions, switchDirectory }
}
