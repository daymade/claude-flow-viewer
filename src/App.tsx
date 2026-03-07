import { useReducer, useEffect } from 'react'
import { AppContext, reducer, initialState } from './hooks/useSessionStore'
import { WelcomeScreen } from './components/landing/WelcomeScreen'
import { AppShell } from './components/layout/AppShell'
import { tryAutoLoad } from './lib/fs-access'
import { parseSessionContent } from './lib/parser'
import { decodeHash, encodeHash } from './hooks/useFileLoader'
import type { FileStore } from './lib/fs-access'
import type { ProjectMeta } from './types/session'

/** Find session target: from URL hash, or fall back to most recent session */
function resolveInitialSession(
  projects: ProjectMeta[],
): { projectEncoded: string; sessionId: string } | null {
  // Try URL hash first
  const fromHash = decodeHash()
  if (fromHash) {
    const project = projects.find(p => p.encodedName === fromHash.projectEncoded)
    const session = project?.sessions.find(s => s.id === fromHash.sessionId)
    if (project && session) return fromHash
  }
  // Fall back to most recent session
  const first = projects[0]
  const firstSession = first?.sessions[0]
  if (first && firstSession) return { projectEncoded: first.encodedName, sessionId: firstSession.id }
  return null
}

async function loadInitialSession(
  store: FileStore,
  projects: ProjectMeta[],
  dispatch: React.Dispatch<import('./hooks/useSessionStore').Action>,
  cancelled: { current: boolean },
) {
  const target = resolveInitialSession(projects)
  if (!target || cancelled.current) return
  try {
    const content = await store.readSessionContent(target.projectEncoded, target.sessionId)
    const data = parseSessionContent(content)
    if (cancelled.current) return
    dispatch({ type: 'LOAD_SESSION', sessionId: target.sessionId, projectEncoded: target.projectEncoded, data })
    // Sync URL hash
    history.replaceState(null, '', encodeHash(target.projectEncoded, target.sessionId))
  } catch {
    // Non-critical: user can still manually select a session
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Auto-load from Vite dev server API on startup
  useEffect(() => {
    const cancelled = { current: false }
    dispatch({ type: 'LOAD_START' })

    tryAutoLoad().then(async (store) => {
      if (cancelled.current) return
      if (store) {
        const projects = await store.scanProjects()
        dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
        await loadInitialSession(store, projects, dispatch, cancelled)
      } else {
        dispatch({ type: 'SET_ERROR', error: '' })
      }
    }).catch(() => {
      if (!cancelled.current) dispatch({ type: 'SET_ERROR', error: '' })
    })

    return () => { cancelled.current = true }
  }, [])

  const showApp = state.projects.length > 0
  const showWelcome = !showApp && !state.loading

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {state.loading && state.projects.length === 0 ? (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-violet-50/40 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
            <span className="text-violet-600 text-sm font-medium">Loading sessions from ~/.claude ...</span>
          </div>
        </div>
      ) : showWelcome ? (
        <WelcomeScreen />
      ) : (
        <AppShell />
      )}
    </AppContext.Provider>
  )
}
