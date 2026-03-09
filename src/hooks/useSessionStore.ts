import { createContext, useContext, type Dispatch } from 'react'
import type { ProjectMeta, SessionData, SessionMeta, FilterState } from '../types/session'
import type { FileStore } from '../lib/fs-access'

export interface AppState {
  projects: ProjectMeta[]
  activeSessionId: string | null
  activeProjectEncoded: string | null
  activeSessionData: SessionData | null
  loading: boolean
  error: string | null
  filter: FilterState
  searchQuery: string
  fileStore: FileStore | null
}

export type Action =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_PROJECTS'; projects: ProjectMeta[]; fileStore: FileStore }
  | { type: 'LOAD_SESSION_START' }
  | { type: 'LOAD_SESSION'; sessionId: string; projectEncoded: string; data: SessionData }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'TOGGLE_FILTER'; key: keyof FilterState }
  | { type: 'SET_SEARCH'; query: string }
  | { type: 'EXPAND_PROJECT_SESSIONS'; projectEncoded: string; sessions: SessionMeta[] }
  | { type: 'RESET' }

export const initialState: AppState = {
  projects: [],
  activeSessionId: null,
  activeProjectEncoded: null,
  activeSessionData: null,
  loading: false,
  error: null,
  filter: { thinking: true, toolCalls: true, toolResults: true, aiText: true, team: true, branches: true, markers: true, timeline: true },
  searchQuery: '',
  fileStore: null,
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null }
    case 'LOAD_PROJECTS':
      return { ...state, loading: false, projects: action.projects, fileStore: action.fileStore }
    case 'LOAD_SESSION_START':
      return { ...state, loading: true }
    case 'LOAD_SESSION':
      return {
        ...state,
        loading: false,
        activeSessionId: action.sessionId,
        activeProjectEncoded: action.projectEncoded,
        activeSessionData: action.data,
        // Enrich session markers from full parse (forks require tree analysis)
        projects: state.projects.map(p =>
          p.encodedName === action.projectEncoded
            ? {
                ...p,
                sessions: p.sessions.map(s =>
                  s.id === action.sessionId
                    ? { ...s, markers: action.data.markers }
                    : s
                ),
              }
            : p
        ),
      }
    case 'SET_ERROR':
      return { ...state, loading: false, error: action.error }
    case 'TOGGLE_FILTER':
      return { ...state, filter: { ...state.filter, [action.key]: !state.filter[action.key] } }
    case 'SET_SEARCH':
      return { ...state, searchQuery: action.query }
    case 'EXPAND_PROJECT_SESSIONS':
      return {
        ...state,
        projects: state.projects.map(p =>
          p.encodedName === action.projectEncoded
            ? { ...p, sessions: action.sessions, totalSessionCount: action.sessions.length }
            : p
        ),
      }
    case 'RESET':
      return initialState
    default:
      return state
  }
}

export const AppContext = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null)

export function useAppState() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppState must be used within AppContext.Provider')
  return ctx
}
