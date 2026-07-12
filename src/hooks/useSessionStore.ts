import { createContext, useContext, type Dispatch } from 'react'
import { createMinimalSessionMeta } from '../types/session'
import type { ProjectMeta, SessionData, SessionMeta, FilterState, ResolvedSessionRef } from '../types/session'
import type { FileStore } from '../lib/fs-access'
import { decodeProjectName, extractShortName } from '../lib/parser'

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
  | { type: 'UPSERT_SESSION_META'; ref: ResolvedSessionRef }
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

/** Fallback short name when the resolved session's project is absent from the scan (rare). */
function deriveResolvedShortName(ref: ResolvedSessionRef): string {
  const tail = ref.projectEncoded.replace(/^codex:/, '').split(/[/\\]/).filter(Boolean).pop()
  return tail || ref.projectEncoded
}

/** Keep a project's session list in startTime-desc order (matches the scan-time sortSessions). */
function sortSessionsByStartTimeDesc(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
}

/** A minimal meta so a resolved session still derives activeSession when the resolver had no meta. */
function synthesizeMeta(ref: ResolvedSessionRef): SessionMeta {
  return ref.meta ?? createMinimalSessionMeta(ref.source, ref.sessionId)
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null }
    case 'LOAD_PROJECTS':
      return { ...state, loading: false, projects: action.projects, fileStore: action.fileStore }
    case 'LOAD_SESSION_START':
      return { ...state, loading: true }
    case 'LOAD_SESSION': {
      const promptCount = action.data.prompts.length
      const toolCount = action.data.messages.filter((message) => message.kind === 'ai-tool-use').length
      const firstPromptPreview = action.data.prompts[0]?.preview
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
                    ? {
                        ...s,
                        promptCount,
                        toolCount,
                        markers: action.data.markers,
                        // Backfill the preview for a resolve-injected minimal-meta session so the
                        // sidebar shows a real title once it has been opened (it starts blank).
                        firstPromptPreview: s.firstPromptPreview || firstPromptPreview || '',
                      }
                    : s
                ),
              }
            : p
        ),
      }
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
        projects: state.projects.map(p => {
          if (p.encodedName !== action.projectEncoded) return p
          // Preserve a resolve-injected active session the 4KB-head full scan can't see (its first
          // prompt sits past the head), so expanding the list does not blank the open session.
          const scannedIds = new Set(action.sessions.map(s => s.id))
          const preserved = p.sessions.filter(s => s.id === state.activeSessionId && !scannedIds.has(s.id))
          const sessions = preserved.length
            ? sortSessionsByStartTimeDesc([...preserved, ...action.sessions])
            : action.sessions
          return { ...p, sessions, totalSessionCount: Math.max(action.sessions.length, sessions.length) }
        }),
      }
    case 'UPSERT_SESSION_META': {
      // A session opened via the resolve lane (or a deep link) may live beyond the per-project
      // 50-cap and thus be absent from the scanned list. AppShell derives activeSession from
      // project.sessions.find(...), so without this the header shows "no session" and Codex even
      // renders through the wrong view. Inject the resolved meta so it renders properly.
      const { ref } = action
      // Always have a meta (even if the resolver could not extract one) so activeSession derives.
      const meta = synthesizeMeta(ref)
      const existing = state.projects.find(p => p.encodedName === ref.projectEncoded)
      if (existing) {
        if (existing.sessions.some(s => s.id === ref.sessionId)) return state
        return {
          ...state,
          projects: state.projects.map(p =>
            p.encodedName === ref.projectEncoded
              ? {
                  ...p,
                  // Insert in startTime-desc order rather than blindly prepending an old session on top.
                  sessions: sortSessionsByStartTimeDesc([meta, ...p.sessions]),
                  totalSessionCount: Math.max(p.totalSessionCount, p.sessions.length + 1),
                }
              : p
          ),
        }
      }
      // Project itself is absent from the scan (rare) — synthesize a minimal entry so it renders,
      // using the same name decoding the scan uses for Claude projects.
      const created: ProjectMeta = {
        source: ref.source,
        encodedName: ref.projectEncoded,
        decodedName: ref.source === 'claude' ? decodeProjectName(ref.projectEncoded) : ref.projectEncoded.replace(/^codex:/, ''),
        shortName: ref.source === 'claude' ? extractShortName(ref.projectEncoded) : deriveResolvedShortName(ref),
        sessions: [meta],
        totalSessionCount: 1,
      }
      return { ...state, projects: [...state.projects, created] }
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
