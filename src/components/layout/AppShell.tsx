import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useAppState } from '../../hooks/useSessionStore'
import { useFileLoader } from '../../hooks/useFileLoader'
import { Sidebar } from '../sidebar/Sidebar'
import { SessionView } from '../session/SessionView'
import type { FilterState } from '../../types/session'

const FILTER_LABELS: { key: keyof FilterState; label: string; color: string }[] = [
  { key: 'thinking', label: 'Thinking', color: 'text-amber-700' },
  { key: 'toolCalls', label: 'Tool Calls', color: 'text-violet-700' },
  { key: 'toolResults', label: 'Results', color: 'text-emerald-700' },
  { key: 'aiText', label: 'AI Text', color: 'text-slate-600' },
  { key: 'team', label: 'Team', color: 'text-blue-700' },
  { key: 'branches', label: 'Branches', color: 'text-amber-700' },
  { key: 'markers', label: 'Markers', color: 'text-indigo-700' },
  { key: 'timeline', label: 'Timeline', color: 'text-teal-700' },
]

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 280

export function AppShell() {
  const { state, dispatch } = useAppState()
  const { loadSession, loadDirectory, loadAllProjectSessions } = useFileLoader()
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const dragging = useRef(false)
  const dragRef = useRef<HTMLDivElement>(null)

  // Drag handle for resizable sidebar
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX))
      setSidebarWidth(newWidth)
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const stats = useMemo(() => {
    let sessions = 0
    let prompts = 0
    let tools = 0
    for (const p of state.projects) {
      sessions += p.sessions.length
      for (const s of p.sessions) {
        prompts += s.promptCount
        tools += s.toolCount
      }
    }
    return { sessions, prompts, tools }
  }, [state.projects])

  // Find active project name for header breadcrumb
  const activeProject = useMemo(() => {
    if (!state.activeProjectEncoded) return null
    return state.projects.find(p => p.encodedName === state.activeProjectEncoded) || null
  }, [state.projects, state.activeProjectEncoded])

  const activeSession = useMemo(() => {
    if (!activeProject || !state.activeSessionId) return null
    return activeProject.sessions.find(s => s.id === state.activeSessionId) || null
  }, [activeProject, state.activeSessionId])

  // Keyboard shortcut: Cmd+K for search focus
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="h-screen flex bg-[#FAFAF8]">
      {/* ── Sidebar Panel (full-height) ── */}
      <div
        style={{ width: sidebarWidth, minWidth: SIDEBAR_MIN, maxWidth: SIDEBAR_MAX }}
        className="shrink-0 relative flex flex-col bg-white border-r border-slate-200"
      >
        {/* Sidebar Header */}
        <div className="px-3 py-3 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2 mb-2.5">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center shadow-sm shadow-violet-200">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </div>
            <h1 className="text-[13px] font-bold text-slate-900 tracking-tight">Decision Flow</h1>
            <button
              onClick={() => { dispatch({ type: 'RESET' }); loadDirectory() }}
              className="ml-auto text-[10px] text-slate-400 hover:text-violet-600 cursor-pointer whitespace-nowrap font-medium transition-colors"
            >
              Switch
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search... (Cmd+K)"
              value={state.searchQuery}
              onChange={(e) => dispatch({ type: 'SET_SEARCH', query: e.target.value })}
              className="w-full py-1.5 pl-7 pr-2 border border-slate-200 rounded-md text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/10 bg-slate-50 placeholder:text-slate-400 transition-all"
            />
          </div>

          {/* Stats */}
          <div className="flex gap-3 mt-2 text-[10px] text-slate-400">
            <span className="tabular-nums">
              <span className="font-bold text-slate-600">{stats.sessions}</span> sessions
            </span>
            {stats.prompts > 0 && (
              <span className="tabular-nums">
                <span className="font-bold text-blue-600">{stats.prompts}</span> prompts
              </span>
            )}
          </div>
        </div>

        {/* Project/Session List */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <Sidebar
            projects={state.projects}
            activeSessionId={state.activeSessionId}
            activeProjectEncoded={state.activeProjectEncoded}
            searchQuery={state.searchQuery}
            activeHeatmap={state.activeSessionData?.heatmap ?? null}
            onSelectSession={loadSession}
            onLoadAllSessions={loadAllProjectSessions}
          />
        </div>

        {/* Drag handle */}
        <div
          ref={dragRef}
          onMouseDown={onDragStart}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-violet-400/30 active:bg-violet-400/50 transition-colors z-10"
        />
      </div>

      {/* ── Content Panel ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Content Header (breadcrumb + filters, one compact row) */}
        <div className="bg-white border-b border-slate-100 px-4 py-1.5 flex items-center gap-4 shrink-0">
          {/* Breadcrumb */}
          {activeProject ? (
            <div className="flex items-center gap-1.5 text-xs text-slate-400 min-w-0 shrink-0">
              <span className="font-medium text-slate-500 truncate max-w-40" title={activeProject.decodedName}>
                {activeProject.shortName}
              </span>
              {activeSession && (
                <>
                  <span className="text-slate-300">/</span>
                  <span className="text-slate-400 truncate max-w-48 font-mono text-[11px]" title={`Session: ${activeSession.id}`}>
                    {activeSession.id.slice(0, 8)}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-400">No session selected</div>
          )}

          {/* Filter toggles */}
          <div className="flex items-center gap-2.5 ml-auto text-[11px] text-slate-500">
            {FILTER_LABELS.map(({ key, label, color }) => (
              <label key={key} className="cursor-pointer flex items-center gap-1 hover:text-slate-700 transition-colors select-none">
                <input
                  type="checkbox"
                  checked={state.filter[key]}
                  onChange={() => dispatch({ type: 'TOGGLE_FILTER', key })}
                  className="accent-violet-600 m-0"
                />
                <span className={state.filter[key] ? color : ''}>{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Session content */}
        {state.loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
              <span>Loading session...</span>
            </div>
          </div>
        ) : state.activeSessionData ? (
          <SessionView
            data={state.activeSessionData}
            filter={state.filter}
            searchQuery={state.searchQuery}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
            <div className="flex flex-col items-center gap-2">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-slate-300">
                <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Select a session to view the decision flow</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
