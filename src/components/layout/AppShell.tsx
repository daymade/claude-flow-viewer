import { useMemo, useState, useCallback, useRef, useEffect, type CSSProperties, type WheelEvent } from 'react'
import { useAppState } from '../../hooks/useSessionStore'
import { useClaudeSkillRecommendations } from '../../hooks/useClaudeSkillRecommendations'
import { useFileLoader } from '../../hooks/useFileLoader'
import { useSearchController } from '../../hooks/useSearchController'
import { buildCodexThreadForest, findCodexSelectionContext } from '../../lib/codex-navigation'
import { SOURCE_METADATA } from '../../lib/source-metadata'
import { exportSessionAsHTML, exportSessionAsPDF, shareSessionSnapshot } from '../../lib/export-html'
import { Sidebar } from '../sidebar/Sidebar'
import { CodexWorkspaceView } from '../codex/CodexWorkspaceView'
import { SkillRecommendationsPanel } from '../recommendations/SkillRecommendationsPanel'
import { SearchResultsPanel } from '../search/SearchResultsPanel'
import { SessionReader } from '../session/SessionReader'
import { SessionToolbar } from '../session/SessionToolbar'
import { UserInputsWorkspace } from '../user-inputs/UserInputsWorkspace'
import type { UserInputRecord } from '../../lib/user-inputs'
import type { ResolvedSessionRef } from '../../types/session'

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 280

export function AppShell() {
  const { state, dispatch } = useAppState()
  const { loadSession, switchDirectory, loadAllProjectSessions } = useFileLoader()
  const upsertSessionMeta = useCallback(
    (ref: ResolvedSessionRef) => dispatch({ type: 'UPSERT_SESSION_META', ref }),
    [dispatch],
  )
  const { search, selectResult, openResolved } = useSearchController({
    query: state.searchQuery,
    fileStore: state.fileStore,
    loadSession,
    upsertSessionMeta,
  })
  const { recommendations, analyze, recheck } = useClaudeSkillRecommendations({
    fileStore: state.fileStore,
  })
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const dragging = useRef(false)
  const hydratedCodexProjects = useRef(new Set<string>())
  const importFileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [showUserInputs, setShowUserInputs] = useState(false)

  const handleSelectSession = useCallback((projectEncoded: string, sessionId: string, sourceHint?: UserInputRecord['source']) => {
    setShowUserInputs(false)
    void loadSession(projectEncoded, sessionId, sourceHint)
  }, [loadSession])

  const handleOpenUserInputSession = useCallback((input: UserInputRecord) => {
    handleSelectSession(input.projectEncoded, input.sessionId, input.source)
  }, [handleSelectSession])

  const handleExport = useCallback(() => {
    exportSessionAsHTML()
  }, [])

  const handlePrintPDF = useCallback(() => {
    exportSessionAsPDF()
  }, [])

  const handleShare = useCallback(async () => {
    setSharing(true)
    try {
      await shareSessionSnapshot()
    } finally {
      setSharing(false)
    }
  }, [])

  const handleContentWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('[data-primary-scroll]')) return

    const scroller = e.currentTarget.querySelector('[data-primary-scroll]') as HTMLElement | null
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return

    scroller.scrollTop += e.deltaY
  }, [])

  useEffect(() => {
    if (!state.activeSessionData) return

    const handleKeyScroll = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const isSpace = event.key === ' '
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (isSpace && target?.closest('button, a, [role="button"]')) return

      const scroller = document.querySelector('[data-primary-scroll]') as HTMLElement | null
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return

      const pageStep = Math.max(240, scroller.clientHeight * 0.85)
      let top: number | null = null

      if (event.key === 'PageDown' || event.key === ' ') top = scroller.scrollTop + pageStep
      else if (event.key === 'PageUp') top = scroller.scrollTop - pageStep
      else if (event.key === 'Home') top = 0
      else if (event.key === 'End') top = scroller.scrollHeight
      else return

      event.preventDefault()
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }

    window.addEventListener('keydown', handleKeyScroll)
    return () => window.removeEventListener('keydown', handleKeyScroll)
  }, [state.activeSessionData])

  const handleImportClick = useCallback(() => {
    importFileRef.current?.click()
  }, [])

  const handleImportFiles = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setImporting(true)
    try {
      // Read files and send as JSON
      const fileData: { name: string; content: string }[] = []
      for (let i = 0; i < files.length; i++) {
        const content = await files[i].text()
        fileData.push({ name: files[i].name, content })
      }

      const resp = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: fileData }),
      })

      if (resp.ok) {
        const result = await resp.json() as { imported: number; errors: string[] }
        if (result.errors.length > 0) {
          console.warn('Import warnings:', result.errors)
        }
        window.location.reload()
      } else {
        const errText = await resp.text().catch(() => 'Unknown error')
        throw new Error(errText)
      }
    } catch (err) {
      console.error('API import failed, trying browser-side:', err)
      // Fallback: use browser-side import
      try {
        const { createStoreFromFiles } = await import('../../lib/fs-access')
        const store = createStoreFromFiles(files)
        const projects = await store.scanProjects()
        if (projects.length > 0) {
          dispatch({ type: 'LOAD_PROJECTS', projects, fileStore: store })
        } else {
          alert('No valid session files found in the selected files.')
        }
      } catch (fallbackErr) {
        console.error('Browser-side import failed:', fallbackErr)
        alert('Import failed: ' + String(fallbackErr))
      }
    } finally {
      setImporting(false)
      if (importFileRef.current) importFileRef.current.value = ''
    }
  }, [dispatch])

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
      sessions += p.totalSessionCount || p.sessions.length
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

  const activeCodexContext = useMemo(() => {
    if (!activeProject || activeProject.source !== 'codex' || !activeSession) return null
    const forest = buildCodexThreadForest(activeProject.sessions)
    return findCodexSelectionContext(forest, activeSession.id)
  }, [activeProject, activeSession])
  const showMessageFilters = activeProject?.source !== 'codex'
  const activeSourceMeta = activeProject ? SOURCE_METADATA[activeProject.source] : null
  const showSkillRecommendations = !showUserInputs && !state.searchQuery.trim() && activeProject?.source !== 'codex'

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

  useEffect(() => {
    if (!activeProject || activeProject.source !== 'codex') return
    if (activeProject.totalSessionCount <= activeProject.sessions.length) return
    if (hydratedCodexProjects.current.has(activeProject.encodedName)) return

    hydratedCodexProjects.current.add(activeProject.encodedName)
    void loadAllProjectSessions(activeProject.encodedName)
  }, [activeProject, loadAllProjectSessions])

  const sidebarSearchQuery = state.searchQuery.trim() ? '' : state.searchQuery

  const activeSearchTarget = search.activeTarget
    && search.activeTarget.projectEncoded === state.activeProjectEncoded
    && search.activeTarget.sessionId === state.activeSessionId
    ? search.activeTarget
    : null
  const activeExportTitle = activeProject && activeSession
    ? `${SOURCE_METADATA[activeProject.source].label} · ${activeSession.firstPromptPreview || activeProject.shortName}`
    : 'Claude Flow Viewer snapshot'
  const activeExportFilename = activeProject && activeSession
    ? `claude-flow-${activeProject.source}-${activeSession.id.slice(0, 8)}.html`
    : 'claude-flow-snapshot.html'
  const skillPanelStoreKey = useMemo(
    () => `${recommendations.contextVersion}:${activeProject?.encodedName ?? 'no-active-project'}`,
    [activeProject?.encodedName, recommendations.contextVersion],
  )

  return (
    <div className="h-screen overflow-hidden flex flex-col md:flex-row bg-[#FAFAF8]">
      {/* ── Sidebar Panel (full-height) ── */}
      <div
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        className="w-full max-h-[42vh] shrink-0 relative flex flex-col bg-white border-b border-stone-200 md:h-auto md:max-h-none md:w-[var(--sidebar-width)] md:min-w-[200px] md:max-w-[600px] md:border-b-0 md:border-r"
      >
        {/* Sidebar Header */}
        <div className="px-3 py-3 border-b border-stone-100 shrink-0">
          <div className="flex items-center gap-2 mb-2.5">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-amber-600 to-amber-700 flex items-center justify-center shadow-sm shadow-amber-200/60">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </div>
            <h1 className="text-[13px] font-bold text-stone-900 tracking-tight font-sans">Decision Flow</h1>
            <button
              onClick={switchDirectory}
              className="ml-auto text-[10px] text-stone-400 hover:text-amber-700 cursor-pointer whitespace-nowrap font-medium transition-colors"
            >
              Switch
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search... (Cmd+K)"
              value={state.searchQuery}
              onChange={(e) => dispatch({ type: 'SET_SEARCH', query: e.target.value })}
              className="w-full py-1.5 pl-7 pr-2 border border-stone-200 rounded-md text-xs font-sans outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-500/10 bg-stone-50 placeholder:text-stone-400 transition-all"
            />
          </div>
          {search.backend && !search.backend.available && (
            <div className="mt-1.5 rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-[10px] text-stone-500">
              {search.backend.message}
            </div>
          )}

          <SearchResultsPanel
            query={state.searchQuery}
            search={search}
            onSelectResult={(result) => {
              setShowUserInputs(false)
              void selectResult(result)
            }}
            onOpenResolved={() => {
              setShowUserInputs(false)
              void openResolved()
            }}
          />
        </div>

        {/* Project/Session List — the primary content of the rail, starts right under search */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <Sidebar
            projects={state.projects}
            activeSessionId={state.activeSessionId}
            activeProjectEncoded={state.activeProjectEncoded}
            searchQuery={sidebarSearchQuery}
            onSelectSession={handleSelectSession}
            onLoadAllSessions={loadAllProjectSessions}
          />
        </div>

        {/* Secondary tools + global stats, pinned at the bottom out of the content path */}
        <div className="shrink-0 border-t border-stone-200/70 px-3 py-2">
          <button
            type="button"
            onClick={() => setShowUserInputs(true)}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors ${
              showUserInputs ? 'bg-amber-50 text-amber-800' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 5h16M4 12h16M4 19h10" />
              <path d="M2 5h.01M2 12h.01M2 19h.01" />
            </svg>
            我的输入
            <span className="ml-auto text-[10px] font-normal text-stone-400">新到旧</span>
          </button>
          {showSkillRecommendations && (
            <SkillRecommendationsPanel
              key={skillPanelStoreKey}
              recommendations={recommendations}
              activeProject={activeProject ? {
                encodedName: activeProject.encodedName,
                shortName: activeProject.shortName,
              } : null}
              onAnalyze={(options) => void analyze(options)}
              onRecheck={() => void recheck()}
            />
          )}
          <div className="flex gap-3 mt-2 text-[10px] text-stone-400">
            <span className="tabular-nums">
              <span className="font-bold text-stone-600">{stats.sessions}</span> sessions
            </span>
            {stats.prompts > 0 && (
              <span className="tabular-nums">
                <span className="font-bold text-stone-500">{stats.prompts}</span> prompts
              </span>
            )}
          </div>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={onDragStart}
          className="absolute top-0 right-0 hidden w-1 h-full cursor-col-resize hover:bg-amber-400/30 active:bg-amber-400/50 transition-colors z-10 md:block"
        />
      </div>

      {/* ── Content Panel ── */}
      <div
        className="flex-1 flex flex-col min-w-0 min-h-0"
        onWheel={handleContentWheel}
        data-export-live={!showUserInputs && state.activeSessionData ? true : undefined}
        data-export-title={!showUserInputs && state.activeSessionData ? activeExportTitle : undefined}
        data-export-filename={!showUserInputs && state.activeSessionData ? activeExportFilename : undefined}
      >
        {/* Content Header (selection context + filters) */}
        {!showUserInputs && <div className="bg-white border-b border-stone-200/70 px-4 py-2.5 flex flex-col gap-2 shrink-0 sm:flex-row sm:items-start sm:gap-4">
          {activeProject ? (
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${activeSourceMeta!.badgeClass}`}>
                  {activeSourceMeta!.label}
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 bg-stone-100 text-stone-500">
                  {activeSourceMeta!.viewLabel}
                </span>
              </div>

              {activeProject.source === 'codex' && activeSession && activeCodexContext ? (
                <div className="mt-1.5 min-w-0">
                  <div className="text-sm font-semibold text-stone-800 truncate">
                    {activeCodexContext.root.session.firstPromptPreview}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500">
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${
                      activeCodexContext.root.hasMissingParent
                        ? 'bg-stone-100 text-stone-600'
                        : 'bg-stone-50 text-stone-700'
                    }`}>
                      {activeCodexContext.root.hasMissingParent ? 'Unlinked delegated work' : 'Main task'}
                    </span>
                    <span>
                      {activeCodexContext.lineage.length > 1 ? 'Viewing delegated work' : 'Viewing main task'}
                    </span>
                    {activeSession.id !== activeCodexContext.root.session.id && (
                      <span className="truncate text-stone-600">
                        {activeSession.firstPromptPreview}
                      </span>
                    )}
                    {(activeSession.agentName || activeSession.agentRole) && (
                      <span className="text-stone-400">
                        {[activeSession.agentName, activeSession.agentRole].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </div>
                  {activeCodexContext.lineage.length > 1 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-stone-400">
                      {activeCodexContext.lineage.map((node, index) => (
                        <div key={node.session.id} className="flex items-center gap-1">
                          {index > 0 && <span className="text-stone-300">/</span>}
                          <span className={`rounded-full px-1.5 py-0.5 ${
                            index === 0
                              ? 'bg-stone-50 text-stone-700'
                              : 'bg-white border border-stone-100 text-stone-500'
                          }`}>
                            {index === 0 ? 'Main task' : 'Delegated work'}
                          </span>
                          <span className="truncate max-w-44">{node.session.firstPromptPreview}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : activeSession ? (
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-stone-400 min-w-0">
                  <span className="font-medium text-stone-600 truncate max-w-48" title={activeProject.decodedName}>
                    {activeProject.shortName}
                  </span>
                  <span className="text-stone-300">/</span>
                  <span className="text-stone-400 truncate max-w-48 font-mono text-[11px]" title={`Session: ${activeSession.id}`}>
                    {activeSession.id.slice(0, 8)}
                  </span>
                </div>
              ) : (
                <div className="mt-1.5 text-xs text-stone-400">No session selected</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-stone-400">No session selected</div>
          )}

          {/* Action buttons: Import / Export / Share */}
          <div data-export-remove className="flex w-full flex-wrap items-center justify-start gap-1.5 shrink-0 sm:w-auto sm:justify-end">
            <button
              onClick={handleImportClick}
              disabled={importing}
              className="px-2.5 py-1 text-[11px] font-medium text-stone-500 hover:text-stone-700 hover:bg-stone-100 rounded-md transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1"
              title="Import .jsonl session files"
            >
              {importing ? (
                <div className="w-3 h-3 border-1.5 border-stone-300 border-t-stone-500 rounded-full animate-spin" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
              )}
              Import
            </button>
            <button
              onClick={handleExport}
              disabled={!state.activeSessionData}
              className="px-2.5 py-1 text-[11px] font-medium text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded-md transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1"
              title="Export current session as standalone HTML"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              HTML
            </button>
            <button
              onClick={handlePrintPDF}
              disabled={!state.activeSessionData}
              className="px-2.5 py-1 text-[11px] font-medium text-stone-500 hover:text-stone-700 hover:bg-stone-100 rounded-md transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1"
              title="Open print preview for the current session snapshot"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9V2h12v7" />
                <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" />
                <path d="M6 14h12v8H6z" />
              </svg>
              Print/PDF
            </button>
            <button
              onClick={handleShare}
              disabled={!state.activeSessionData || sharing}
              className="px-2.5 py-1 text-[11px] font-medium text-stone-700 hover:text-stone-800 hover:bg-stone-50 rounded-md transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1"
              title="Create a read-only share link from this snapshot"
            >
              {sharing ? (
                <div className="w-3 h-3 border-1.5 border-stone-200 border-t-stone-600 rounded-full animate-spin" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                </svg>
              )}
              Share
            </button>
          </div>
          <input
            ref={importFileRef}
            type="file"
            accept=".jsonl,.json"
            multiple
            onChange={handleImportFiles}
            className="hidden"
          />

          {/* Filter toggles */}
          {showMessageFilters ? (
            <SessionToolbar filter={state.filter} onToggle={key => dispatch({type:'TOGGLE_FILTER',key})} />
          ) : null}
        </div>}

        {/* Session content */}
        {showUserInputs ? (
          <UserInputsWorkspace
            fileStore={state.fileStore}
            onClose={() => setShowUserInputs(false)}
            onOpenSession={handleOpenUserInputSession}
          />
        ) : state.loading ? (
          <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-amber-200 border-t-amber-600 rounded-full animate-spin" />
              <span>Loading session...</span>
            </div>
          </div>
        ) : state.activeSessionData ? (
          <div className="flex min-h-0 flex-1">
            {state.activeSessionData.source === 'codex' && activeProject && activeSession ? (
              <CodexWorkspaceView
                project={activeProject}
                activeSession={activeSession}
                activeSessionData={state.activeSessionData}
                filter={state.filter}
                searchQuery={state.searchQuery}
                fileStore={state.fileStore}
                activeSearchTarget={activeSearchTarget}
                onSelectSession={handleSelectSession}
              />
            ) : (
              <SessionReader
                data={state.activeSessionData}
                filter={state.filter}
                searchQuery={state.searchQuery}
                activeSearchTarget={activeSearchTarget}
                showToolbar={false}
                readToolResult={state.fileStore && state.activeProjectEncoded && state.activeSessionId ? relative => state.fileStore!.readToolResult(state.activeProjectEncoded!, state.activeSessionId!, relative) : null}
              />
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">
            <div className="flex flex-col items-center gap-2">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-stone-300">
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
