import { useReducer, useEffect } from 'react'
import { AppContext, reducer, initialState } from './hooks/useSessionStore'
import { WelcomeScreen } from './components/landing/WelcomeScreen'
import { AppShell } from './components/layout/AppShell'
import { tryAutoLoad } from './lib/fs-access'
import { parseFetchedSessionContent } from './lib/parser'
import { decodeHash, encodeHash } from './hooks/useFileLoader'
import { planInitialNavigation, mostRecentSession, type InitialNavPlan } from './lib/initial-navigation'
import type { FileStore } from './lib/fs-access'
import type { ProjectMeta, SessionSource, ResolvedSessionRef } from './types/session'

async function loadTarget(
  store: FileStore,
  dispatch: React.Dispatch<import('./hooks/useSessionStore').Action>,
  projectEncoded: string,
  sessionId: string,
  source: SessionSource | undefined,
  cancelled: { current: boolean },
) {
  const content = await store.readSessionContent(projectEncoded, sessionId)
  if (cancelled.current) return
  const data = parseFetchedSessionContent(content, source)
  if (cancelled.current) return
  dispatch({ type: 'LOAD_SESSION', sessionId, projectEncoded, data })
  history.replaceState(null, '', encodeHash(projectEncoded, sessionId))
}

/**
 * The URL's project is authoritative when an id exists in more than one project (e.g. an imported
 * copy vs the original, which the resolver de-prioritizes). Prefer the hash's project when it
 * actually holds the session; otherwise keep the resolver's answer.
 */
async function pickDeepLinkProject(
  store: FileStore,
  hashProject: string | undefined,
  ref: ResolvedSessionRef,
): Promise<string> {
  if (!hashProject || hashProject === ref.projectEncoded) return ref.projectEncoded
  try {
    await store.readSessionContent(hashProject, ref.sessionId)
    return hashProject
  } catch {
    return ref.projectEncoded
  }
}

async function loadDeepLink(
  store: FileStore,
  projects: ProjectMeta[],
  dispatch: React.Dispatch<import('./hooks/useSessionStore').Action>,
  plan: Extract<InitialNavPlan, { kind: 'deep-link' }>,
  cancelled: { current: boolean },
) {
  // Resolve by identifier: reaches sessions beyond the 50-cap and returns meta to upsert so
  // AppShell can derive activeSession. Only a genuine miss falls back to most recent.
  let ref: ResolvedSessionRef | null = null
  try {
    ref = store.resolveSession ? await store.resolveSession(plan.sessionId) : null
  } catch (err) {
    console.warn('Deep-link resolve failed:', err)
  }
  if (cancelled.current) return

  if (ref) {
    const projectEncoded = await pickDeepLinkProject(store, plan.projectEncoded, ref)
    if (cancelled.current) return
    dispatch({ type: 'UPSERT_SESSION_META', ref: { ...ref, projectEncoded } })
    // The session WAS resolved — a load failure here must NOT silently open a different session.
    await loadTarget(store, dispatch, projectEncoded, ref.sessionId, ref.source, cancelled)
      .catch((err) => console.warn('Deep-link session load failed:', err))
    return
  }

  const recent = mostRecentSession(projects)
  if (recent && !cancelled.current) {
    await loadTarget(store, dispatch, recent.projectEncoded, recent.sessionId, recent.source, cancelled)
      .catch((err) => console.warn('Failed to load fallback session:', err))
  }
}

async function loadInitialSession(
  store: FileStore,
  projects: ProjectMeta[],
  dispatch: React.Dispatch<import('./hooks/useSessionStore').Action>,
  cancelled: { current: boolean },
) {
  const plan = planInitialNavigation(projects, decodeHash())
  if (!plan || cancelled.current) return
  try {
    if (plan.kind === 'deep-link') {
      await loadDeepLink(store, projects, dispatch, plan, cancelled)
      return
    }
    await loadTarget(store, dispatch, plan.projectEncoded, plan.sessionId, plan.source, cancelled)
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
        <div className="min-h-screen bg-gradient-to-br from-stone-50 via-white to-amber-50/40 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" />
            <span className="text-amber-600 text-sm font-medium">Loading sessions from Claude, Codex, and Cherry Studio ...</span>
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
