import { useMemo, useState } from 'react'

import type { ProjectMeta, SessionMarkers, SessionMeta, SessionSource } from '../../types/session'
import {
  buildCodexThreadForest,
  filterCodexThreadForest,
  findCodexSelectionContext,
  summarizeCodexThreadForest,
  type CodexThreadNode,
} from '../../lib/codex-navigation'
import { SOURCE_METADATA, SOURCE_ORDER } from '../../lib/source-metadata'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// Visible "when" for each session row. Time is core signal, not hover-only noise:
// today -> HH:MM, this year -> "Jul 11", older -> year.
function formatWhen(iso: string, fallback: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback.slice(5, 10)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  return String(d.getFullYear())
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function codexDelegatedPreviewLabel(delegatedCount: number, isTruncated: boolean): string {
  if (delegatedCount > 0) {
    return `${delegatedCount} delegated work item${delegatedCount === 1 ? '' : 's'}`
  }
  return isTruncated ? 'Delegated work loads on open' : 'No delegated work recorded'
}

// A first message that is only a greeting or a connectivity check (not a real ask) makes a
// session indistinguishable from noise in a long project list. Matched as a whole normalized
// string, not a substring, so a real prompt that merely contains "hi" or "test" is unaffected.
const TRIVIAL_PREVIEWS = new Set([
  'hi', 'hey', 'hello', 'hola', 'yo',
  'yes', 'no', 'ok', 'okay', 'test', 'testing', 'ping', 'pong',
  'thanks', 'thank you',
  '你好', '在吗', '在么', '测试', '试试', '试一下', '好的', '继续', '谢谢',
])

function isTrivialPreview(preview: string): boolean {
  const normalized = preview.trim().toLowerCase().replace(/[!?.,、。！？~～]+$/u, '')
  return TRIVIAL_PREVIEWS.has(normalized)
}

type MarkerFilterKey = keyof SessionMarkers
type SourceFilter = 'all' | SessionSource

const MARKER_FILTERS: { key: MarkerFilterKey; label: string }[] = [
  { key: 'forks', label: 'Forks' },
  { key: 'compacts', label: 'Compacts' },
  { key: 'clears', label: 'Clears' },
  { key: 'plans', label: 'Plans' },
]

const SOURCE_FILTERS: Array<{ key: SourceFilter; label: string }> = [
  { key: 'all', label: 'All sources' },
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'cherrystudio', label: 'Cherry Studio' },
]

interface SidebarProps {
  projects: ProjectMeta[]
  activeSessionId: string | null
  activeProjectEncoded: string | null
  searchQuery: string
  onSelectSession: (projectEncoded: string, sessionId: string) => void
  onLoadAllSessions: (projectEncoded: string) => void
}

export function Sidebar({
  projects,
  activeSessionId,
  activeProjectEncoded,
  searchQuery,
  onSelectSession,
  onLoadAllSessions,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>())
  const [markerFilter, setMarkerFilter] = useState<MarkerFilterKey | null>(null)
  const [showMarkerFilter, setShowMarkerFilter] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  // Opt-in and off by default: this only hides sessions from view, it never changes what's on
  // disk, but a filter that can silently hide real content must not be on unless asked for.
  const [hideTrivial, setHideTrivial] = useState(false)
  const [manuallyCollapsedActiveProjects, setManuallyCollapsedActiveProjects] = useState<Set<string>>(() => new Set<string>())

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const hasTreeFilter = Boolean(normalizedSearch) || Boolean(markerFilter)
  const activeProjectSource = useMemo(
    () => projects.find((project) => project.encodedName === activeProjectEncoded)?.source ?? null,
    [activeProjectEncoded, projects],
  )
  const sourceOrder = useMemo(() => {
    if (sourceFilter !== 'all' || !activeProjectSource) return SOURCE_ORDER
    return [
      activeProjectSource,
      ...SOURCE_ORDER.filter((source) => source !== activeProjectSource),
    ]
  }, [activeProjectSource, sourceFilter])

  const expandedProjects = useMemo(() => {
    const next = new Set(expanded)
    if (activeProjectEncoded && !manuallyCollapsedActiveProjects.has(activeProjectEncoded)) {
      next.add(activeProjectEncoded)
    }
    if (next.size === 0 && projects.length > 0 && !activeProjectEncoded) {
      next.add(projects[0].encodedName)
    }
    return next
  }, [expanded, activeProjectEncoded, manuallyCollapsedActiveProjects, projects])

  const filteredProjects = useMemo(() => {
    let result = projects

    if (sourceFilter !== 'all') {
      result = result.filter((project) => project.source === sourceFilter)
    }

    if (!normalizedSearch && !markerFilter && !hideTrivial) {
      return result
    }

    return result.flatMap((project) => {
      const projectMatchesSearch = normalizedSearch
        ? project.shortName.toLowerCase().includes(normalizedSearch)
          || project.decodedName.toLowerCase().includes(normalizedSearch)
        : false

      const sessionMatches = (session: SessionMeta) => {
        const searchMatch = !normalizedSearch
          || projectMatchesSearch
          || session.firstPromptPreview.toLowerCase().includes(normalizedSearch)
          || session.startDisplay.toLowerCase().includes(normalizedSearch)
          || session.id.toLowerCase().includes(normalizedSearch)
          || Boolean(session.agentName?.toLowerCase().includes(normalizedSearch))
          || Boolean(session.agentRole?.toLowerCase().includes(normalizedSearch))

        const markerMatch = !markerFilter || Boolean(session.markers && session.markers[markerFilter] > 0)
        return searchMatch && markerMatch
      }

      if (project.source === 'codex') {
        // hideTrivial does not apply here: Codex sessions are organized as a task tree (see
        // hasTreeFilter/CodexTaskNavCard below), where a root task is often opened by delegation
        // rather than a typed prompt, so "first message" is a much weaker signal than for Claude.
        return project.sessions.some(sessionMatches) || projectMatchesSearch
          ? [project]
          : []
      }

      const sessions = project.sessions.filter(
        (session) => sessionMatches(session) && (!hideTrivial || !isTrivialPreview(session.firstPromptPreview)),
      )
      return sessions.length > 0 ? [{ ...project, sessions }] : []
    })
  }, [markerFilter, normalizedSearch, projects, sourceFilter, hideTrivial])

  const toggleProject = (encodedName: string) => {
    const isCurrentlyExpanded = expandedProjects.has(encodedName)

    setExpanded((prev) => {
      const next = new Set(prev)
      if (isCurrentlyExpanded) next.delete(encodedName)
      else next.add(encodedName)
      return next
    })

    if (encodedName === activeProjectEncoded) {
      setManuallyCollapsedActiveProjects((prev) => {
        const next = new Set(prev)
        if (isCurrentlyExpanded) next.add(encodedName)
        else next.delete(encodedName)
        return next
      })
    }
  }

  const toggleMarkerFilter = (key: MarkerFilterKey) => {
    setMarkerFilter((prev) => (prev === key ? null : key))
  }

  const selectSession = (projectEncoded: string, sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(projectEncoded)
      return next
    })
    setManuallyCollapsedActiveProjects((prev) => {
      if (!prev.has(projectEncoded)) return prev
      const next = new Set(prev)
      next.delete(projectEncoded)
      return next
    })
    onSelectSession(projectEncoded, sessionId)
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 border-b border-stone-200/70">
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {SOURCE_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setSourceFilter(key)}
                className={`rounded-md px-2 py-1 text-[11px] cursor-pointer transition-colors ${
                  sourceFilter === key
                    ? 'bg-stone-800 text-white font-medium'
                    : 'bg-stone-100 text-stone-500 hover:bg-stone-200 hover:text-stone-700'
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setHideTrivial((v) => !v)}
              title="Hide sessions whose first message is just a greeting or connectivity test (hi / test / ok …)"
              aria-pressed={hideTrivial}
              className={`rounded-md px-2 py-1 text-[11px] cursor-pointer transition-colors ${
                hideTrivial
                  ? 'bg-amber-50 text-amber-700 font-medium'
                  : 'bg-stone-100 text-stone-500 hover:bg-stone-200 hover:text-stone-700'
              }`}
            >
              Hide trivial
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowMarkerFilter((v) => !v)}
            title="Filter conversations by marker (forks, compacts, clears, plans)"
            aria-label="Filter by marker"
            aria-expanded={showMarkerFilter}
            className={`ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] cursor-pointer transition-colors ${
              markerFilter || showMarkerFilter
                ? 'bg-amber-50 text-amber-700'
                : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600'
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
            </svg>
            {markerFilter && <span className="font-medium tabular-nums">1</span>}
          </button>
        </div>
        {showMarkerFilter && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] text-stone-400">Show only:</span>
            {MARKER_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleMarkerFilter(key)}
                title={`Show only sessions containing ${label.toLowerCase()}`}
                className={`rounded-full border px-2 py-0.5 text-[11px] cursor-pointer transition-colors ${
                  markerFilter === key
                    ? 'border-amber-300 bg-amber-50 text-amber-800 font-medium'
                    : 'border-stone-200 text-stone-500 hover:border-stone-300 hover:text-stone-700'
                }`}
              >
                {label}
              </button>
            ))}
            {markerFilter && (
              <button
                type="button"
                onClick={() => setMarkerFilter(null)}
                className="text-[10px] font-medium text-amber-700 hover:underline cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {sourceOrder.map((source) => {
        const sectionProjects = filteredProjects.filter((project) => project.source === source)
        if (sectionProjects.length === 0) return null

        const sectionMeta = SOURCE_METADATA[source]
        const sectionLabel = sectionMeta.sectionLabel
        const sectionClass = sectionMeta.projectClass

        return (
          <div key={source}>
            <div className={`px-3 py-2 border-b text-[10px] font-semibold uppercase tracking-[0.12em] ${sectionClass}`}>
              {sectionLabel}
            </div>
            {sectionProjects.map((project) => {
              const isExpanded = expandedProjects.has(project.encodedName) || Boolean(searchQuery) || Boolean(markerFilter) || hideTrivial
              const isActiveProject = project.encodedName === activeProjectEncoded
              const sessionCount = project.sessions.length
              const totalCount = project.totalSessionCount
              const isTruncated = totalCount > sessionCount

              if (project.source === 'codex') {
                const fullForest = buildCodexThreadForest(project.sessions)
                const visibleForest = hasTreeFilter
                  ? filterCodexThreadForest(fullForest, (session) => {
                      const searchMatch = !normalizedSearch || [
                        project.shortName,
                        project.decodedName,
                        session.firstPromptPreview,
                        session.startDisplay,
                        session.id,
                        session.agentName ?? '',
                        session.agentRole ?? '',
                      ].some((value) => value.toLowerCase().includes(normalizedSearch))
                      const markerMatch = !markerFilter || Boolean(session.markers && session.markers[markerFilter] > 0)
                      return searchMatch && markerMatch
                    })
                  : fullForest

                const visibleSummary = summarizeCodexThreadForest(visibleForest)
                const selectionContext = findCodexSelectionContext(fullForest, isActiveProject ? activeSessionId : null)
                const activeRootId = selectionContext?.root.session.id ?? null
                const mainTasks = visibleForest.filter((node) => !node.hasMissingParent)
                const unlinkedTasks = visibleForest.filter((node) => node.hasMissingParent)

                return (
                  <div key={project.encodedName} className="border-b border-stone-200/50">
                    <ProjectHeader
                      project={project}
                      isActiveProject={isActiveProject}
                      isExpanded={isExpanded}
                      summaryLabel={`${visibleSummary.mainTaskCount} main task${visibleSummary.mainTaskCount === 1 ? '' : 's'}`}
                      detailLabel={[
                        codexDelegatedPreviewLabel(visibleSummary.delegatedCount, isTruncated),
                        visibleSummary.unlinkedCount > 0
                          ? `${visibleSummary.unlinkedCount} unlinked item${visibleSummary.unlinkedCount === 1 ? '' : 's'}`
                          : null,
                      ].filter(Boolean).join(' · ')}
                      loadedCount={sessionCount}
                      totalCount={totalCount}
                      onToggle={() => toggleProject(project.encodedName)}
                    />

                    {isExpanded && (
                      <div className="pb-2">
                        <TaskMapSummary
                          summary={visibleSummary}
                          hasTreeFilter={hasTreeFilter}
                          isTruncated={isTruncated}
                          hasUnlinkedTasks={unlinkedTasks.length > 0}
                        />

                        {mainTasks.length > 0 && (
                          <div className="px-2 pt-1">
                            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">
                              Main tasks
                            </div>
                            {mainTasks.map((node) => (
                              <CodexTaskNavCard
                                key={node.session.id}
                                node={node}
                                projectEncoded={project.encodedName}
                                isActive={node.session.id === activeRootId}
                                showMatchHint={hasTreeFilter && node.session.id !== activeRootId}
                                showDeferredChildHint={isTruncated && node.children.length === 0}
                                onSelectSession={selectSession}
                              />
                            ))}
                          </div>
                        )}

                        {unlinkedTasks.length > 0 && (
                          <div className="px-2 pt-2">
                            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">
                              Unlinked delegated work
                            </div>
                            <div className="mx-2 mb-2 rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-stone-500">
                              These delegated threads do not have their parent task in the currently loaded sessions.
                              {isTruncated && ' Load all sessions to restore missing parent context when that parent exists in older history.'}
                            </div>
                            {unlinkedTasks.map((node) => (
                              <CodexTaskNavCard
                                key={node.session.id}
                                node={node}
                                projectEncoded={project.encodedName}
                                isActive={node.session.id === activeRootId}
                                showMatchHint={hasTreeFilter && node.session.id !== activeRootId}
                                onSelectSession={selectSession}
                              />
                            ))}
                          </div>
                        )}

                        {isTruncated && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              onLoadAllSessions(project.encodedName)
                            }}
                            className="mx-3 mt-1 px-2.5 py-2 w-[calc(100%-24px)] text-center text-[11px] text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer transition-colors font-medium"
                          >
                            Load all {totalCount} entries (+{totalCount - sessionCount} more)
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              }

              return (
                <div key={project.encodedName} className="border-b border-stone-200/50">
                  <ProjectHeader
                    project={project}
                    isActiveProject={isActiveProject}
                    isExpanded={isExpanded}
                    summaryLabel={`${sessionCount} conversation${sessionCount === 1 ? '' : 's'}`}
                    detailLabel={null}
                    loadedCount={sessionCount}
                    totalCount={totalCount}
                    onToggle={() => toggleProject(project.encodedName)}
                  />

                  {isExpanded && (
                    <div className="pb-1">
                      {[...project.sessions]
                        .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
                        .map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          activeSessionId={activeSessionId}
                          onClick={() => selectSession(project.encodedName, session.id)}
                        />
                      ))}
                      {isTruncated && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            onLoadAllSessions(project.encodedName)
                          }}
                          className="mx-1.5 mb-0.5 px-2.5 py-2 w-[calc(100%-12px)] text-center text-[11px] text-amber-600 hover:bg-amber-50 rounded-lg cursor-pointer transition-colors font-medium"
                        >
                          Load all {totalCount} sessions (+{totalCount - sessionCount} more)
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

interface ProjectHeaderProps {
  project: ProjectMeta
  isActiveProject: boolean
  isExpanded: boolean
  summaryLabel: string
  detailLabel: string | null
  loadedCount: number
  totalCount: number
  onToggle: () => void
}

function ProjectHeader({
  project,
  isActiveProject,
  isExpanded,
  summaryLabel,
  detailLabel,
  loadedCount,
  totalCount,
  onToggle,
}: ProjectHeaderProps) {
  const isTruncated = totalCount > loadedCount

  return (
    <div
      className={`px-3 py-2.5 text-xs cursor-pointer flex items-start gap-2 transition-colors ${
        isActiveProject ? 'bg-amber-50/70' : 'hover:bg-stone-100/70'
      }`}
      onClick={onToggle}
      title={`${project.decodedName}\n${loadedCount}/${totalCount} entries loaded`}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 10 10"
        fill="currentColor"
        className={`text-stone-400 shrink-0 mt-1 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
      >
        <path d="M3 1l5 4-5 4V1z" />
      </svg>

      <div className="min-w-0 flex-1">
        <div className={`truncate font-medium ${isActiveProject ? 'text-stone-900' : 'text-stone-600'}`}>{project.shortName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-stone-400">
          <span>{summaryLabel}</span>
          {detailLabel && (
            <>
              <span aria-hidden className="text-stone-300">·</span>
              <span>{detailLabel}</span>
            </>
          )}
        </div>
      </div>

      <span className={`text-[11px] shrink-0 tabular-nums mt-0.5 ${isActiveProject ? 'text-amber-700' : 'text-stone-400'}`}>
        {isTruncated ? `${loadedCount}/${totalCount}` : loadedCount}
      </span>
    </div>
  )
}

interface TaskMapSummaryProps {
  summary: ReturnType<typeof summarizeCodexThreadForest>
  hasTreeFilter: boolean
  isTruncated: boolean
  hasUnlinkedTasks: boolean
}

function TaskMapSummary({ summary, hasTreeFilter, isTruncated, hasUnlinkedTasks }: TaskMapSummaryProps) {
  const delegatedPreview = codexDelegatedPreviewLabel(summary.delegatedCount, isTruncated)

  return (
    <div className="mx-3 mt-2 rounded-xl border border-stone-200/70 bg-stone-50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-500">Task map</div>
        {hasTreeFilter && (
          <span className="rounded-full bg-white px-2 py-0.5 text-[9px] font-semibold text-stone-500 ring-1 ring-stone-200">
            Filtered view
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-600">
        <span><strong className="font-semibold text-stone-800">{summary.mainTaskCount}</strong> main task{summary.mainTaskCount === 1 ? '' : 's'}</span>
        <span>{summary.delegatedCount > 0
          ? <><strong className="font-semibold text-stone-800">{summary.delegatedCount}</strong> delegated work item{summary.delegatedCount === 1 ? '' : 's'}</>
          : delegatedPreview}
        </span>
        {summary.unlinkedCount > 0 && (
          <span><strong className="font-semibold text-stone-800">{summary.unlinkedCount}</strong> unlinked item{summary.unlinkedCount === 1 ? '' : 's'}</span>
        )}
      </div>
      {(isTruncated || hasUnlinkedTasks) && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-stone-500">
          {isTruncated
            ? 'Root tasks load first so the first screen stays fast. Open a task or load the full history to hydrate delegated work.'
            : hasUnlinkedTasks
              ? 'Unlinked delegated work stays visible so you can see where parent context is missing.'
              : 'Every visible delegated item is placed according to the loaded parent-child chain.'}
        </div>
      )}
    </div>
  )
}

interface CodexTaskNavCardProps {
  node: CodexThreadNode
  projectEncoded: string
  isActive: boolean
  showMatchHint: boolean
  showDeferredChildHint?: boolean
  onSelectSession: (projectEncoded: string, sessionId: string) => void
}

function CodexTaskNavCard({
  node,
  projectEncoded,
  isActive,
  showMatchHint,
  showDeferredChildHint = false,
  onSelectSession,
}: CodexTaskNavCardProps) {
  const label = node.hasMissingParent ? 'Unlinked delegated work' : 'Main task'
  const borderClass = isActive
    ? 'bg-amber-50 border-l-amber-600'
    : 'bg-white border-l-stone-300 hover:bg-stone-100/60'
  const headline = node.session.firstPromptPreview
  const secondary = node.children.length > 0
    ? `${formatCount(node.children.length, 'delegated branch', 'delegated branches')} under this task`
    : showDeferredChildHint
      ? 'Delegated work loads when you open this task'
    : node.hasMissingParent
      ? 'This branch is missing its parent task'
      : 'No delegated branches recorded'

  return (
    <div className="pb-1">
      <div
        className={`mx-2 rounded-xl border-l-[3px] px-3 py-2.5 transition-colors cursor-pointer ${borderClass}`}
        onClick={() => onSelectSession(projectEncoded, node.session.id)}
        title={`Session: ${node.session.id}\nFile: ${formatFileSize(node.session.fileSize)}\nRecords: ${node.session.recordCount || '?'}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${
                label === 'Main task'
                  ? 'bg-stone-200 text-stone-700'
                  : 'bg-stone-100 text-stone-500'
              }`}>
                {label}
              </span>
              {showMatchHint && (
                <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                  Contains a matching branch
                </span>
              )}
            </div>
            <div className="mt-1 text-[12px] font-semibold leading-snug text-stone-800">
              {headline}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400">
              <span>{node.session.startDisplay}</span>
              <span>{secondary}</span>
            </div>
          </div>
          {node.session.fileSize > 0 && (
            <div className="text-[10px] text-stone-400 tabular-nums shrink-0">
              {formatFileSize(node.session.fileSize)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface SessionCardProps {
  session: SessionMeta
  activeSessionId: string | null
  onClick: () => void
}

function SessionCard({ session, activeSessionId, onClick }: SessionCardProps) {
  const isActive = session.id === activeSessionId
  const title = session.firstPromptPreview?.trim() || session.startDisplay
  // Size / counts / markers / heatmap move into the hover tooltip instead of
  // stacking a colored badge pile under every row. The rail stays a list of titles.
  const meta = [
    session.startDisplay,
    session.fileSize ? formatFileSize(session.fileSize) : null,
    session.promptCount ? formatCount(session.promptCount, 'prompt') : null,
    session.toolCount ? formatCount(session.toolCount, 'tool') : null,
    markerSummary(session.markers),
  ].filter(Boolean).join(' · ')

  return (
    <div
      className={`group relative mx-1.5 mb-px flex items-center gap-2 rounded-lg px-2.5 py-[7px] cursor-pointer transition-colors ${
        isActive ? 'bg-amber-50 text-stone-900' : 'text-stone-600 hover:bg-stone-100/60'
      }`}
      onClick={onClick}
      title={`${meta}\n${session.id}`}
    >
      {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-amber-600" />}
      <span className={`min-w-0 flex-1 truncate text-[13px] leading-snug ${isActive ? 'font-medium' : ''}`}>
        {title}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-stone-400">
        {formatWhen(session.startTime, session.startDisplay)}
      </span>
    </div>
  )
}

function markerSummary(markers?: SessionMarkers): string | null {
  if (!markers) return null
  const parts = [
    markers.forks > 0 ? formatCount(markers.forks, 'fork') : null,
    markers.compacts > 0 ? formatCount(markers.compacts, 'compact') : null,
    markers.clears > 0 ? formatCount(markers.clears, 'clear') : null,
    markers.plans > 0 ? formatCount(markers.plans, 'plan') : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : null
}
