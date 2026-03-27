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

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function codexDelegatedPreviewLabel(delegatedCount: number, isTruncated: boolean): string {
  if (delegatedCount > 0) {
    return `${delegatedCount} delegated work item${delegatedCount === 1 ? '' : 's'}`
  }
  return isTruncated ? 'Delegated work loads on open' : 'No delegated work recorded'
}

type MarkerFilterKey = keyof SessionMarkers
type SourceFilter = 'all' | SessionSource

const MARKER_FILTERS: { key: MarkerFilterKey; label: string; color: string; activeColor: string }[] = [
  { key: 'forks', label: 'Forks', color: 'text-amber-500', activeColor: 'bg-amber-100 text-amber-700' },
  { key: 'compacts', label: 'Compacts', color: 'text-teal-500', activeColor: 'bg-teal-100 text-teal-700' },
  { key: 'clears', label: 'Clears', color: 'text-gray-500', activeColor: 'bg-gray-200 text-gray-700' },
  { key: 'plans', label: 'Plans', color: 'text-indigo-500', activeColor: 'bg-indigo-100 text-indigo-700' },
]

const SOURCE_FILTERS: Array<{ key: SourceFilter; label: string; activeClass: string }> = [
  { key: 'all', label: 'All sources', activeClass: 'bg-slate-200 text-slate-800' },
  { key: 'claude', label: 'Claude', activeClass: 'bg-sky-100 text-sky-800' },
  { key: 'codex', label: 'Codex', activeClass: 'bg-emerald-100 text-emerald-800' },
  { key: 'cherrystudio', label: 'Cherry Studio', activeClass: 'bg-orange-100 text-orange-800' },
]

interface SidebarProps {
  projects: ProjectMeta[]
  activeSessionId: string | null
  activeProjectEncoded: string | null
  searchQuery: string
  activeHeatmap: number[] | null
  onSelectSession: (projectEncoded: string, sessionId: string) => void
  onLoadAllSessions: (projectEncoded: string) => void
}

export function Sidebar({
  projects,
  activeSessionId,
  activeProjectEncoded,
  searchQuery,
  activeHeatmap,
  onSelectSession,
  onLoadAllSessions,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>())
  const [markerFilter, setMarkerFilter] = useState<MarkerFilterKey | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [manuallyCollapsedActiveProjects, setManuallyCollapsedActiveProjects] = useState<Set<string>>(() => new Set<string>())

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const hasTreeFilter = Boolean(normalizedSearch) || Boolean(markerFilter)

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

    if (!normalizedSearch && !markerFilter) {
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
        return project.sessions.some(sessionMatches) || projectMatchesSearch
          ? [project]
          : []
      }

      const sessions = project.sessions.filter(sessionMatches)
      return sessions.length > 0 ? [{ ...project, sessions }] : []
    })
  }, [markerFilter, normalizedSearch, projects, sourceFilter])

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
      <div className="px-3 py-2 border-b border-slate-100">
        <div className="flex flex-wrap items-center gap-1.5">
          {SOURCE_FILTERS.map(({ key, label, activeClass }) => (
            <button
              key={key}
              type="button"
              onClick={() => setSourceFilter(key)}
              className={`px-2 py-1 rounded-md text-[10px] font-semibold cursor-pointer transition-colors ${
                sourceFilter === key
                  ? activeClass
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-100">
        <span className="text-[10px] text-slate-400 mr-0.5 shrink-0">Markers:</span>
        {MARKER_FILTERS.map(({ key, label, activeColor }) => (
          <button
            key={key}
            type="button"
            onClick={() => toggleMarkerFilter(key)}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold cursor-pointer transition-colors ${
              markerFilter === key
                ? activeColor
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
            }`}
          >
            {label}
          </button>
        ))}
        {markerFilter && (
          <button
            type="button"
            onClick={() => setMarkerFilter(null)}
            className="ml-auto text-[9px] text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      {SOURCE_ORDER.map((source) => {
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
              const isExpanded = expandedProjects.has(project.encodedName) || Boolean(searchQuery) || Boolean(markerFilter)
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
                  <div key={project.encodedName} className="border-b border-slate-100">
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
                            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
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
                            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                              Unlinked delegated work
                            </div>
                            <div className="mx-2 mb-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
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
                            className="mx-3 mt-1 px-2.5 py-2 w-[calc(100%-24px)] text-center text-[11px] text-emerald-700 hover:bg-emerald-50 rounded-lg cursor-pointer transition-colors font-medium"
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
                <div key={project.encodedName} className="border-b border-slate-100">
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
                      {project.sessions.map((session) => (
                        <SessionCard
                          key={session.id}
                          projectSource={project.source}
                          session={session}
                          activeSessionId={activeSessionId}
                          activeHeatmap={activeHeatmap}
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
      className={`px-3 py-2.5 text-xs font-semibold cursor-pointer flex items-start gap-2 transition-colors ${
        isActiveProject
          ? 'bg-amber-50/80'
          : SOURCE_METADATA[project.source].projectHoverClass
      }`}
      onClick={onToggle}
      title={`${project.decodedName}\n${loadedCount}/${totalCount} entries loaded`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="currentColor"
        className={`text-slate-400 shrink-0 mt-0.5 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
      >
        <path d="M3 1l5 4-5 4V1z" />
      </svg>

      <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${SOURCE_METADATA[project.source].badgeClass}`}>
        {SOURCE_METADATA[project.source].label}
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-slate-700">{project.shortName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium text-slate-400">
          <span>{summaryLabel}</span>
          {detailLabel && <span>{detailLabel}</span>}
        </div>
      </div>

      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 tabular-nums ${
        isActiveProject ? 'bg-amber-200 text-amber-700' : 'bg-slate-200 text-slate-500'
      }`}>
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
    <div className="mx-3 mt-2 rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-700">Task map</div>
        {hasTreeFilter && (
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-[9px] font-semibold text-emerald-700">
            Filtered view
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-emerald-900">
        <span><strong className="font-semibold">{summary.mainTaskCount}</strong> main task{summary.mainTaskCount === 1 ? '' : 's'}</span>
        <span>{summary.delegatedCount > 0
          ? <><strong className="font-semibold">{summary.delegatedCount}</strong> delegated work item{summary.delegatedCount === 1 ? '' : 's'}</>
          : delegatedPreview}
        </span>
        {summary.unlinkedCount > 0 && (
          <span><strong className="font-semibold">{summary.unlinkedCount}</strong> unlinked item{summary.unlinkedCount === 1 ? '' : 's'}</span>
        )}
      </div>
      {(isTruncated || hasUnlinkedTasks) && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-emerald-800/80">
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
    ? 'bg-amber-50 border-l-amber-600 shadow-sm shadow-amber-100'
    : 'bg-white border-l-emerald-500 hover:bg-emerald-50/40'
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
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-slate-100 text-slate-600'
              }`}>
                {label}
              </span>
              {showMatchHint && (
                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                  Contains a matching branch
                </span>
              )}
            </div>
            <div className="mt-1 text-[12px] font-semibold leading-snug text-slate-800">
              {headline}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400">
              <span>{node.session.startDisplay}</span>
              <span>{secondary}</span>
            </div>
          </div>
          {node.session.fileSize > 0 && (
            <div className="text-[10px] text-slate-400 tabular-nums shrink-0">
              {formatFileSize(node.session.fileSize)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface SessionCardProps {
  projectSource: SessionSource
  session: SessionMeta
  activeSessionId: string | null
  activeHeatmap: number[] | null
  onClick: () => void
}

function SessionCard({ projectSource, session, activeSessionId, activeHeatmap, onClick }: SessionCardProps) {
  const isActive = session.id === activeSessionId
  const stateClass = isActive
    ? 'bg-amber-50 border-l-amber-600 shadow-sm shadow-amber-100'
    : SOURCE_METADATA[projectSource].sessionClass

  return (
    <div
      className={`mx-1.5 mb-0.5 px-2.5 py-2 cursor-pointer rounded-lg border-l-[3px] transition-all duration-100 ${stateClass}`}
      onClick={onClick}
      title={`Session: ${session.id}\nFile: ${session.fileSize ? formatFileSize(session.fileSize) : '?'}\nRecords: ${session.recordCount || '?'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-slate-700">{session.startDisplay}</div>
        </div>
        {session.fileSize > 0 && (
          <div className="text-[10px] text-slate-400 tabular-nums shrink-0">
            {formatFileSize(session.fileSize)}
          </div>
        )}
      </div>
      <div className="text-[11px] text-slate-500 truncate mt-0.5 leading-snug">{session.firstPromptPreview}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-slate-400">
        {session.promptCount > 0 && <span>{formatCount(session.promptCount, 'prompt')}</span>}
        {session.toolCount > 0 && <span>{formatCount(session.toolCount, 'tool')}</span>}
        {session.recordCount > 0 && <span>{formatCount(session.recordCount, 'record')}</span>}
      </div>
      <MarkerBadgeRow markers={session.markers} />
      {isActive && activeHeatmap && activeHeatmap.length > 0 && (
        <HeatmapBar values={activeHeatmap} />
      )}
    </div>
  )
}

function MarkerBadgeRow({ markers }: { markers?: SessionMarkers }) {
  if (!markers || (markers.compacts === 0 && markers.plans === 0 && markers.clears === 0 && markers.forks === 0)) {
    return null
  }

  return (
    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
      {markers.forks > 0 && (
        <span className="text-[9px] font-bold px-1.5 py-px rounded bg-amber-50 text-amber-600">
          {formatCount(markers.forks, 'fork')}
        </span>
      )}
      {markers.compacts > 0 && (
        <span className="text-[9px] font-bold px-1.5 py-px rounded bg-teal-50 text-teal-600">
          {formatCount(markers.compacts, 'compact')}
        </span>
      )}
      {markers.clears > 0 && (
        <span className="text-[9px] font-bold px-1.5 py-px rounded bg-gray-100 text-gray-500">
          {formatCount(markers.clears, 'clear')}
        </span>
      )}
      {markers.plans > 0 && (
        <span className="text-[9px] font-bold px-1.5 py-px rounded bg-indigo-50 text-indigo-500">
          {formatCount(markers.plans, 'plan')}
        </span>
      )}
    </div>
  )
}

function HeatmapBar({ values }: { values: number[] }) {
  const w = 100
  const h = 6
  const barWidth = Math.max(1, w / values.length)

  return (
    <svg width={w} height={h} className="mt-1.5 rounded-sm overflow-hidden" viewBox={`0 0 ${w} ${h}`}>
      <rect width={w} height={h} fill="#f1f5f9" />
      {values.map((value, index) => (
        <rect
          key={index}
          x={index * barWidth}
          y={0}
          width={barWidth}
          height={h}
          fill={heatColor(value)}
        />
      ))}
    </svg>
  )
}

function heatColor(intensity: number): string {
  if (intensity < 0.1) return '#f1f5f9'
  if (intensity < 0.3) return '#bfdbfe'
  if (intensity < 0.5) return '#93c5fd'
  if (intensity < 0.7) return '#60a5fa'
  if (intensity < 0.9) return '#3b82f6'
  return '#2563eb'
}
