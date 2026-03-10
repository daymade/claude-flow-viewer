import { useReducer, useEffect } from 'react'
import { AppContext, reducer, initialState } from './hooks/useSessionStore'
import { WelcomeScreen } from './components/landing/WelcomeScreen'
import { AppShell } from './components/layout/AppShell'
import { buildCodexThreadForest } from './lib/codex-navigation'
import { tryAutoLoad } from './lib/fs-access'
import { parseSessionContent } from './lib/parser'
import { decodeHash, encodeHash } from './hooks/useFileLoader'
import type { FileStore } from './lib/fs-access'
import type { ProjectMeta } from './types/session'

function resolveProjectEntry(project: ProjectMeta): { sessionId: string; activityTime: string } | null {
  if (project.source === 'codex') {
    const latestRoot = buildCodexThreadForest(project.sessions)[0]
    if (latestRoot) {
      return {
        sessionId: latestRoot.session.id,
        activityTime: latestRoot.latestActivityTime,
      }
    }
  }

  const latestSession = project.sessions[0]
  if (!latestSession) return null

  return {
    sessionId: latestSession.id,
    activityTime: latestSession.startTime,
  }
}

/** Find session target: from URL hash, or fall back to most recent session */
function resolveInitialSession(
  projects: ProjectMeta[],
): { projectEncoded: string; sessionId: string; source: ProjectMeta['source'] } | null {
  // Try URL hash first
  const fromHash = decodeHash()
  if (fromHash) {
    const project = projects.find(p => p.encodedName === fromHash.projectEncoded)
    const session = project?.sessions.find(s => s.id === fromHash.sessionId)
    if (project && session) return { ...fromHash, source: project.source }
  }

  let target: { projectEncoded: string; sessionId: string; source: ProjectMeta['source']; activityTime: string } | null = null
  for (const project of projects) {
    const entry = resolveProjectEntry(project)
    if (!entry) continue
    if (!target || entry.activityTime.localeCompare(target.activityTime) > 0) {
      target = {
        projectEncoded: project.encodedName,
        sessionId: entry.sessionId,
        source: project.source,
        activityTime: entry.activityTime,
      }
    }
  }

  if (target) {
    return {
      projectEncoded: target.projectEncoded,
      sessionId: target.sessionId,
      source: target.source,
    }
  }

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
    if (cancelled.current) return
    const data = parseSessionContent(content, target.source)
    if (cancelled.current) return
    dispatch({ type: 'LOAD_SESSION', sessionId: target.sessionId, projectEncoded: target.projectEncoded, data })
    // Sync URL hash
    history.replaceState(null, '', encodeHash(target.projectEncoded, target.sessionId))
  } catch (err) {
    // Non-critical: user can still manually select a session
    console.warn('Failed to load initial session:', err)
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
        if (cancelled.current) return // Check cancellation after async operation
        dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
        await loadInitialSession(store, projects, dispatch, cancelled)
      } else {
        dispatch({ type: 'SET_ERROR', error: '' })
      }
    }).catch((err) => {
      if (!cancelled.current) {
        console.error('Failed to auto-load sessions:', err)
        dispatch({ type: 'SET_ERROR', error: 'Failed to load sessions. Please try selecting a directory manually.' })
      }
    })

    return () => { cancelled.current = true }
  }, [])

  const showApp = state.projects.length > 0
  const showWelcome = !showApp && !state.loading

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {state.loading && state.projects.length === 0 ? (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-amber-50/40 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" />
            <span className="text-amber-600 text-sm font-medium">Loading sessions from ~/.claude and ~/.codex ...</span>
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
