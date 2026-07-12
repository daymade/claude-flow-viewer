import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { FileStore } from '../../lib/fs-access'
import type { SearchJumpTarget } from '../../hooks/useSearchController'
import { parseSessionContent } from '../../lib/parser'
import {
  buildCodexTaskInsights,
  codexLineageSummary,
  codexSubtreeNodes,
  type CodexTaskInsights,
  type CodexKeyMoment,
} from '../../lib/codex-learning'
import {
  buildCodexThreadForest,
  findCodexSelectionContext,
  type CodexThreadNode,
} from '../../lib/codex-navigation'
import type { FilterState, ProjectMeta, SessionData, SessionMeta } from '../../types/session'
import { SessionView } from '../session/SessionView'

type ViewMode = 'overview' | 'structure' | 'diagnostics'

interface CodexWorkspaceViewProps {
  project: ProjectMeta
  activeSession: SessionMeta
  activeSessionData: SessionData
  filter: FilterState
  searchQuery: string
  fileStore: FileStore | null
  activeSearchTarget?: SearchJumpTarget | null
  onSelectSession: (projectEncoded: string, sessionId: string) => void
}

function cacheKey(projectEncoded: string, sessionId: string): string {
  return `${projectEncoded}/${sessionId}`
}

function statusTone(statusLabel: string): string {
  if (/complete/i.test(statusLabel)) return 'bg-emerald-100 text-emerald-800'
  if (/rollback|interrupt|redirect/i.test(statusLabel)) return 'bg-amber-100 text-amber-800'
  return 'bg-stone-100 text-stone-700'
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function highlightMoments(moments: CodexKeyMoment[], count: number, filter?: (moment: CodexKeyMoment) => boolean) {
  const list = filter ? moments.filter(filter) : moments
  return list.slice(0, count)
}

function buildSessionStatus(data: SessionData | null, session: SessionMeta): string {
  if (!data) return session.threadKind === 'subagent' ? 'Delegated work' : 'Main task'

  const reversed = [...data.messages].reverse()
  const completed = reversed.find((message) => message.kind === 'task-event' && message.status === 'completed')
  if (completed?.kind === 'task-event') return 'Completed'

  const rollback = reversed.find((message) => message.kind === 'rollback-marker')
  if (rollback) return 'Rolled back'

  const decision = reversed.find((message) => message.kind === 'user-prompt' && message.decision !== 'none')
  if (decision?.kind === 'user-prompt') {
    return decision.decision === 'interrupt' ? 'Interrupted' : 'Redirected'
  }

  return 'In progress'
}

function looksGenericSummary(value: string, session: SessionMeta): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return true

  const preview = session.firstPromptPreview.replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalized === preview) return true
  if (!normalized.includes(' ') && normalized.length <= 32) return true
  return false
}

function groupRoots(nodes: CodexThreadNode[]) {
  return {
    mainTasks: nodes.filter((node) => !node.hasMissingParent),
    unlinkedTasks: nodes.filter((node) => node.hasMissingParent),
  }
}

export function CodexWorkspaceView({
  project,
  activeSession,
  activeSessionData,
  filter,
  searchQuery,
  fileStore,
  activeSearchTarget = null,
  onSelectSession,
}: CodexWorkspaceViewProps) {
  const activeViewKey = `${project.encodedName}:${activeSession.id}`
  const [viewState, setViewState] = useState<{ key: string; mode: ViewMode }>(() => ({
    key: activeViewKey,
    mode: 'overview',
  }))
  const viewMode = viewState.key === activeViewKey ? viewState.mode : 'overview'
  const setViewMode = (mode: ViewMode) => setViewState({ key: activeViewKey, mode })
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(() => new Set<string>())
  const [fetchedSessions, setFetchedSessions] = useState<Record<string, SessionData>>({})
  const [subtreeError, setSubtreeError] = useState<{ rootId: string; message: string } | null>(null)

  const sessionDataFor = useMemo(
    () => ({
      ...fetchedSessions,
      [cacheKey(project.encodedName, activeSession.id)]: activeSessionData,
    }),
    [activeSession.id, activeSessionData, fetchedSessions, project.encodedName],
  )

  const forest = useMemo(() => buildCodexThreadForest(project.sessions), [project.sessions])
  const selectionContext = useMemo(
    () => findCodexSelectionContext(forest, activeSession.id),
    [activeSession.id, forest],
  )
  const selectedRoot = selectionContext?.root ?? forest[0] ?? null
  const loadingProjectSessions = project.totalSessionCount > project.sessions.length
  const { mainTasks, unlinkedTasks } = useMemo(() => groupRoots(forest), [forest])

  const subtreeNodes = useMemo(
    () => (selectedRoot ? codexSubtreeNodes(selectedRoot) : []),
    [selectedRoot],
  )
  const delegatedNodes = useMemo(
    () => subtreeNodes.filter((node) => node.session.id !== selectedRoot?.session.id),
    [selectedRoot?.session.id, subtreeNodes],
  )

  const missingSessionIds = useMemo(
    () => subtreeNodes
      .map((node) => node.session.id)
      .filter((sessionId) => !sessionDataFor[cacheKey(project.encodedName, sessionId)]),
    [project.encodedName, sessionDataFor, subtreeNodes],
  )

  const activeSubtreeError = selectedRoot && subtreeError?.rootId === selectedRoot.session.id
    ? subtreeError.message
    : null
  const loadingSubtree = loadingProjectSessions || Boolean(fileStore && selectedRoot && missingSessionIds.length > 0 && !activeSubtreeError)

  useEffect(() => {
    if (!fileStore || !selectedRoot || missingSessionIds.length === 0) return

    let cancelled = false

    Promise.all(
      missingSessionIds.map(async (sessionId) => {
        const content = await fileStore.readSessionContent(project.encodedName, sessionId)
        return [sessionId, parseSessionContent(content, 'codex')] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      setFetchedSessions((prev) => {
        const next = { ...prev }
        for (const [sessionId, data] of entries) {
          next[cacheKey(project.encodedName, sessionId)] = data
        }
        return next
      })
    }).catch((error) => {
      if (!cancelled) {
        console.error('Failed to enrich Codex subtree', error)
        setSubtreeError({
          rootId: selectedRoot.session.id,
          message: 'Unable to load the full task subtree right now.',
        })
      }
    })

    return () => { cancelled = true }
  }, [fileStore, missingSessionIds, project.encodedName, selectedRoot])

  const rootData = selectedRoot ? sessionDataFor[cacheKey(project.encodedName, selectedRoot.session.id)] ?? null : null
  const activeData = sessionDataFor[cacheKey(project.encodedName, activeSession.id)] ?? activeSessionData
  const activeInsights = useMemo(
    () => buildCodexTaskInsights(activeData, activeSession),
    [activeData, activeSession],
  )
  const rootInsights = useMemo(
    () => (selectedRoot && rootData ? buildCodexTaskInsights(rootData, selectedRoot.session) : null),
    [rootData, selectedRoot],
  )

  const selectionSummary = codexLineageSummary(selectionContext) || 'Main task in focus'
  const loadedCount = subtreeNodes.filter((node) => Boolean(sessionDataFor[cacheKey(project.encodedName, node.session.id)])).length

  const expandBranch = (sessionId: string) => {
    setExpandedBranches((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const selectBranch = (sessionId: string) => {
    if (sessionId !== activeSession.id) {
      onSelectSession(project.encodedName, sessionId)
    } else {
      expandBranch(sessionId)
    }
  }

  if (viewMode === 'overview') {
    return (
      <CodexViewFrame
        viewMode={viewMode}
        setViewMode={setViewMode}
      >
        <ReadableConversationView
          activeSession={activeSession}
          activeData={activeData}
          selectedRoot={selectedRoot}
          selectionSummary={selectionSummary}
          delegatedNodes={delegatedNodes}
          loadingSubtree={loadingSubtree}
          subtreeError={activeSubtreeError}
          loadedCount={loadedCount}
          totalCount={subtreeNodes.length}
          filter={filter}
          searchQuery={searchQuery}
          activeSearchTarget={activeSearchTarget}
        />
      </CodexViewFrame>
    )
  }

  if (viewMode === 'diagnostics') {
    return (
      <CodexViewFrame
        viewMode={viewMode}
        setViewMode={setViewMode}
      >
        <div className="h-full min-h-0 overflow-y-auto bg-[#FAFAF8]" data-primary-scroll>
          <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8">
            <DecisionSummary insights={activeInsights} />
            <div className="mt-6">
              <NoiseSummary insights={activeInsights} />
            </div>
          </div>
        </div>
      </CodexViewFrame>
    )
  }

  return (
    <CodexViewFrame
      viewMode={viewMode}
      setViewMode={setViewMode}
    >
      <div className="h-full min-h-0 overflow-y-auto bg-[#FAFAF8]" data-primary-scroll>
        <div className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6 sm:py-6">
          {selectedRoot ? (
            <>
              <SelectedRootHero
                node={selectedRoot}
                insights={rootInsights}
                selectionSummary={selectionSummary}
                loadingSubtree={loadingSubtree}
                subtreeError={activeSubtreeError}
                loadedCount={loadedCount}
                totalCount={subtreeNodes.length}
              />

              <StructureGuide
                mainTaskCount={mainTasks.length}
                unlinkedCount={unlinkedTasks.length}
              />
              <TaskGraphSection
                node={selectedRoot}
                projectEncoded={project.encodedName}
                activeSessionId={activeSession.id}
                sessionDataFor={sessionDataFor}
                onSelectSession={onSelectSession}
              />
              <DelegatedBranchesPanel
                nodes={delegatedNodes}
                activeSessionId={activeSession.id}
                expandedBranches={expandedBranches}
                projectEncoded={project.encodedName}
                sessionDataFor={sessionDataFor}
                loadingProjectSessions={loadingProjectSessions}
                onSelectBranch={selectBranch}
                onToggleBranch={expandBranch}
              />
              <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr),360px]">
                <MainThreadNarrative insights={rootInsights} />
                <CurrentFocusSection
                  session={activeSession}
                  insights={activeInsights}
                  selectionSummary={selectionSummary}
                />
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    </CodexViewFrame>
  )
}

function CodexViewFrame({
  viewMode,
  setViewMode,
  children,
}: {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <div className="border-b border-stone-200 bg-white px-5 py-3" data-export-remove>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('overview')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              viewMode === 'overview'
                ? 'bg-stone-900 text-white'
                : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
            }`}
          >
            Conversation
          </button>
          <button
            type="button"
            onClick={() => setViewMode('structure')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              viewMode === 'structure'
                ? 'bg-stone-200 text-stone-800'
                : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
            }`}
          >
            Structure
          </button>
          <button
            type="button"
            onClick={() => setViewMode('diagnostics')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              viewMode === 'diagnostics'
                ? 'bg-stone-200 text-stone-800'
                : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700'
            }`}
          >
            Diagnostics
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

function ReadableConversationView({
  activeSession,
  activeData,
  selectedRoot,
  selectionSummary,
  delegatedNodes,
  loadingSubtree,
  subtreeError,
  loadedCount,
  totalCount,
  filter,
  searchQuery,
  activeSearchTarget,
}: {
  activeSession: SessionMeta
  activeData: SessionData
  selectedRoot: CodexThreadNode | null
  selectionSummary: string
  delegatedNodes: CodexThreadNode[]
  loadingSubtree: boolean
  subtreeError: string | null
  loadedCount: number
  totalCount: number
  filter: FilterState
  searchQuery: string
  activeSearchTarget: SearchJumpTarget | null
}) {
  const title = selectedRoot?.session.firstPromptPreview || activeSession.firstPromptPreview
  const visibleBranchCount = delegatedNodes.length
  const readerFilter: FilterState = {
    ...filter,
    thinking: false,
    toolCalls: false,
    toolResults: false,
    branches: false,
    markers: false,
    timeline: false,
    aiText: true,
    team: true,
  }
  const header = (
    <div className="border-b border-stone-200 bg-white">
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
          <span className="rounded bg-stone-100 px-2 py-0.5 font-semibold text-stone-700">
            {activeSession.threadKind === 'subagent' ? 'Delegated work' : 'Main task'}
          </span>
          <span>{activeSession.startDisplay}</span>
          <span>{selectionSummary}</span>
        </div>
        <h2 className="mt-3 max-w-4xl text-2xl font-semibold leading-tight text-stone-950">
          {title}
        </h2>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-stone-600">
          <span className="rounded bg-white px-2 py-1 ring-1 ring-stone-200">
            {formatCount(activeData.prompts.length, 'prompt')}
          </span>
          {visibleBranchCount > 0 && (
            <span className="rounded bg-white px-2 py-1 ring-1 ring-stone-200">
              {formatCount(visibleBranchCount, 'delegated branch')}
            </span>
          )}
          {loadingSubtree && totalCount > 0 && (
            <span className="rounded bg-white px-2 py-1 ring-1 ring-stone-200">
              Loading {loadedCount}/{totalCount}
            </span>
          )}
        </div>
        {subtreeError && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            {subtreeError}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#FAFAF8]">
      <div className="flex min-h-0 flex-1">
        <SessionView
          data={activeData}
          filter={readerFilter}
          searchQuery={searchQuery}
          activeSearchTarget={activeSearchTarget}
          showTimeline={false}
          showPromptIndex={false}
          header={header}
          readerMode
        />
      </div>
    </div>
  )
}

function SelectedRootHero({
  node,
  insights,
  selectionSummary,
  loadingSubtree,
  subtreeError,
  loadedCount,
  totalCount,
}: {
  node: CodexThreadNode
  insights: CodexTaskInsights | null
  selectionSummary: string
  loadingSubtree: boolean
  subtreeError: string | null
  loadedCount: number
  totalCount: number
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-5 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(insights?.statusLabel ?? 'In progress')}`}>
          {insights?.statusLabel ?? 'In progress'}
        </span>
        <span className="rounded bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
          {node.hasMissingParent ? 'Unlinked delegated work' : 'Selected main task'}
        </span>
        <span className="text-[11px] text-stone-400">{node.session.startDisplay}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">{node.session.firstPromptPreview}</div>
      <div className="mt-2 max-w-3xl text-sm leading-relaxed text-stone-600">
        {insights?.objective ?? node.session.firstPromptPreview}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-500">
        <span>{selectionSummary}</span>
        <span>{formatCount(node.descendantCount, 'delegated thread')}</span>
        <span>{loadingSubtree ? `Parsing subtree ${loadedCount}/${totalCount}` : `Loaded ${loadedCount}/${totalCount} threads`}</span>
      </div>
      {subtreeError && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {subtreeError}
        </div>
      )}
    </div>
  )
}

function CurrentFocusSection({
  session,
  insights,
  selectionSummary,
}: {
  session: SessionMeta
  insights: CodexTaskInsights
  selectionSummary: string
}) {
  return (
    <section className="mt-6 rounded-lg border border-stone-200 bg-white px-5 py-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Selected thread</div>
      <TaskDetailsPanel
        session={session}
        insights={insights}
        selectionSummary={selectionSummary}
      />
    </section>
  )
}

function MainThreadNarrative({ insights }: { insights: CodexTaskInsights | null }) {
  const beats = insights ? highlightMoments(
    insights.keyMoments,
    8,
    (moment) => ['delegation', 'decision', 'status', 'context'].includes(moment.kind),
  ) : []

  return (
    <section className="mt-6 rounded-lg border border-stone-200 bg-white px-5 py-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Main task timeline</div>
      <div className="mt-4 space-y-3">
        {beats.length > 0 ? beats.map((moment, index) => (
          <MomentRow key={`${moment.title}-${index}`} moment={moment} />
        )) : (
          <div className="rounded-md bg-stone-50 px-4 py-3 text-sm text-stone-500">
            No parsed timeline events for this task yet.
          </div>
        )}
      </div>
    </section>
  )
}

function DelegatedBranchesPanel({
  nodes,
  activeSessionId,
  expandedBranches,
  projectEncoded,
  sessionDataFor,
  loadingProjectSessions,
  onSelectBranch,
  onToggleBranch,
}: {
  nodes: CodexThreadNode[]
  activeSessionId: string
  expandedBranches: Set<string>
  projectEncoded: string
  sessionDataFor: Record<string, SessionData>
  loadingProjectSessions: boolean
  onSelectBranch: (sessionId: string) => void
  onToggleBranch: (sessionId: string) => void
}) {
  return (
    <section className="mt-6 rounded-lg border border-stone-200 bg-white px-5 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Delegated branches</div>
        <span className="text-[11px] text-stone-400">{formatCount(nodes.length, 'branch', 'branches')}</span>
      </div>
      <div className="mt-4 max-h-[560px] space-y-3 overflow-y-auto pr-1">
        {nodes.map((node) => {
          const data = sessionDataFor[cacheKey(projectEncoded, node.session.id)] ?? null
          const insights = data ? buildCodexTaskInsights(data, node.session) : null
          const isExpanded = node.session.id === activeSessionId || expandedBranches.has(node.session.id)
          return (
            <BranchNarrativeCard
              key={node.session.id}
              node={node}
              insights={insights}
              isExpanded={isExpanded}
              isActive={node.session.id === activeSessionId}
              onSelect={() => onSelectBranch(node.session.id)}
              onToggle={() => onToggleBranch(node.session.id)}
            />
          )
        })}
        {nodes.length === 0 && (
          <div className="rounded-md bg-stone-50 px-4 py-3 text-sm text-stone-500">
            {loadingProjectSessions
              ? 'Loading the full delegated task map for this project...'
              : 'This task does not have delegated branches in the loaded history.'}
          </div>
        )}
      </div>
    </section>
  )
}

function BranchNarrativeCard({
  node,
  insights,
  isExpanded,
  isActive,
  onSelect,
  onToggle,
}: {
  node: CodexThreadNode
  insights: CodexTaskInsights | null
  isExpanded: boolean
  isActive: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const primaryMoments = highlightMoments(
    insights?.keyMoments ?? [],
    4,
    (moment) => moment.kind !== 'context',
  )
  const status = insights?.statusLabel ?? 'In progress'
  const derivedHeadline = [insights?.completionSummary, insights?.objective, primaryMoments[0]?.detail]
    .find((value): value is string => Boolean(value) && !looksGenericSummary(value!, node.session))
  const headline = derivedHeadline
    || (insights ? 'Expand this branch to inspect its own result' : 'Loading branch summary...')
  const assignedLine = insights?.assignedSummary && !looksGenericSummary(insights.assignedSummary, node.session)
    ? insights.assignedSummary
    : null
  const returnedLine = insights?.returnedSummary && !looksGenericSummary(insights.returnedSummary, node.session)
    ? insights.returnedSummary
    : null
  const summaryLabel = primaryMoments[0]?.title
    || (returnedLine ? 'Returned' : assignedLine ? 'Assigned' : insights ? 'Expand to inspect' : 'Loading')

  return (
    <div className={`rounded-lg border transition-colors ${
      isActive ? 'border-amber-300 bg-amber-50/60' : 'border-stone-200 bg-white'
    }`}>
      <div className="px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect()
            }}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(status)}`}>
                {status}
              </span>
              <span className="rounded bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                {[node.session.agentName, node.session.agentRole].filter(Boolean).join(' · ') || 'Delegated work'}
              </span>
              <span className="text-[11px] text-stone-400">{node.session.startDisplay}</span>
            </div>
            <div className="mt-2 text-sm font-semibold leading-snug text-stone-900">{headline}</div>
            <div className="mt-1 space-y-1 text-[11px] leading-relaxed text-stone-600">
              {assignedLine && (
                <div>
                  <span className="font-semibold text-stone-700">Assigned:</span>{' '}
                  <span>{assignedLine}</span>
                </div>
              )}
              {returnedLine ? (
                <div>
                  <span className="font-semibold text-stone-700">Returned:</span>{' '}
                  <span>{returnedLine}</span>
                </div>
              ) : (
                <div>{summaryLabel}</div>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onToggle}
            className="rounded-md bg-stone-100 px-3 py-1.5 text-[11px] font-semibold text-stone-700 hover:bg-stone-200"
          >
            {isExpanded ? 'Hide branch messages' : 'Show branch messages'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {primaryMoments.slice(0, 2).map((moment, index) => (
            <span key={`${moment.title}-${index}`} className="rounded bg-stone-100 px-2 py-1 text-[11px] text-stone-600">
              {moment.title}
            </span>
          ))}
          {insights?.completionSummary && (
            <span className="rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">
              {insights.completionSummary}
            </span>
          )}
        </div>

        {isExpanded && (
          <div className="mt-4 space-y-4 border-t border-stone-200 pt-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">Messages from this branch</div>
              <div className="mt-3 space-y-3">
                {primaryMoments.length > 0 ? primaryMoments.map((moment, index) => (
                  <MomentCard key={`${moment.title}-${index}`} moment={moment} />
                )) : (
                  <div className="rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-500">
                    {insights ? 'No branch events detected.' : 'Branch parsing is still in progress.'}
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <DecisionSummary insights={insights} compact />
              <NoiseSummary insights={insights} compact />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DecisionSummary({
  insights,
  compact = false,
}: {
  insights: CodexTaskInsights | null
  compact?: boolean
}) {
  const decisions = highlightMoments(insights?.decisionPoints ?? [], compact ? 3 : 5)

  return (
    <section className={`rounded-lg border border-stone-200 bg-white ${compact ? 'px-4 py-4' : 'px-5 py-5'}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Decision points</div>
      <div className="mt-3 space-y-3">
        {decisions.length > 0 ? decisions.map((moment, index) => (
          <MomentRow key={`${moment.title}-${index}`} moment={moment} />
        )) : (
          <div className="rounded-md bg-stone-50 px-4 py-3 text-sm text-stone-500">
            No major decision point was detected for this level.
          </div>
        )}
      </div>
    </section>
  )
}

function NoiseSummary({
  insights,
  compact = false,
}: {
  insights: CodexTaskInsights | null
  compact?: boolean
}) {
  return (
    <section className={`rounded-lg border border-stone-200 bg-white ${compact ? 'px-4 py-4' : 'px-5 py-5'}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Diagnostics</div>
      <div className="mt-4 flex flex-wrap gap-2">
        {insights?.hiddenNoise.length ? insights.hiddenNoise.map((bucket) => (
          <span key={bucket.label} className="rounded bg-stone-100 px-2.5 py-1 text-[11px] text-stone-600">
            {bucket.count} {bucket.label}
          </span>
        )) : (
          <span className="rounded bg-stone-100 px-2.5 py-1 text-[11px] text-stone-600">
            No diagnostic buckets detected.
          </span>
        )}
      </div>
    </section>
  )
}

function StructureGuide({
  mainTaskCount,
  unlinkedCount,
}: {
  mainTaskCount: number
  unlinkedCount: number
}) {
  return (
    <div className="mt-6 rounded-lg border border-stone-200 bg-white px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Structure</div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-stone-600">
        <span className="rounded bg-stone-100 px-2.5 py-1">{formatCount(mainTaskCount, 'main task')}</span>
        <span className="rounded bg-stone-100 px-2.5 py-1">{formatCount(unlinkedCount, 'unlinked branch')}</span>
      </div>
    </div>
  )
}

function TaskGraphSection({
  node,
  projectEncoded,
  activeSessionId,
  sessionDataFor,
  onSelectSession,
}: {
  node: CodexThreadNode
  projectEncoded: string
  activeSessionId: string
  sessionDataFor: Record<string, SessionData>
  onSelectSession: (projectEncoded: string, sessionId: string) => void
}) {
  return (
    <div className="mt-6 rounded-lg border border-stone-200 bg-white">
      <div className="border-b border-stone-200 px-5 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Task graph</div>
      </div>
      <div className="overflow-x-auto px-5 py-6">
        <div className="min-w-[860px]">
          <TaskGraphBranch
            node={node}
            projectEncoded={projectEncoded}
            activeSessionId={activeSessionId}
            sessionDataFor={sessionDataFor}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>
    </div>
  )
}

function TaskGraphBranch({
  node,
  projectEncoded,
  activeSessionId,
  sessionDataFor,
  onSelectSession,
}: {
  node: CodexThreadNode
  projectEncoded: string
  activeSessionId: string
  sessionDataFor: Record<string, SessionData>
  onSelectSession: (projectEncoded: string, sessionId: string) => void
}) {
  return (
    <div className="flex items-start gap-8">
      <TaskGraphCard
        node={node}
        projectEncoded={projectEncoded}
        isActive={node.session.id === activeSessionId}
        data={sessionDataFor[cacheKey(projectEncoded, node.session.id)] ?? null}
        onSelectSession={onSelectSession}
      />

      {node.children.length > 0 && (
        <div className="relative min-w-0 flex-1 pl-8">
          <div className="absolute bottom-6 left-0 top-6 w-px bg-stone-200" />
          <div className="space-y-4">
            {node.children.map((child) => (
              <div key={child.session.id} className="relative before:absolute before:left-[-32px] before:top-10 before:h-px before:w-8 before:bg-stone-200">
                <TaskGraphBranch
                  node={child}
                  projectEncoded={projectEncoded}
                  activeSessionId={activeSessionId}
                  sessionDataFor={sessionDataFor}
                  onSelectSession={onSelectSession}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TaskGraphCard({
  node,
  projectEncoded,
  isActive,
  data,
  onSelectSession,
}: {
  node: CodexThreadNode
  projectEncoded: string
  isActive: boolean
  data: SessionData | null
  onSelectSession: (projectEncoded: string, sessionId: string) => void
}) {
  const insights = data ? buildCodexTaskInsights(data, node.session) : null
  const leadingMoments = insights ? highlightMoments(insights.keyMoments, 2, (moment) => moment.kind !== 'context') : []
  const status = buildSessionStatus(data, node.session)

  return (
    <button
      type="button"
      onClick={() => onSelectSession(projectEncoded, node.session.id)}
      className={`w-[320px] rounded-2xl border px-4 py-4 text-left transition-colors ${
        isActive
          ? 'border-amber-300 bg-amber-50 shadow-sm shadow-amber-100'
          : 'border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(status)}`}>
          {node.depth === 0 ? 'Main task' : 'Delegated work'}
        </span>
        {(node.session.agentName || node.session.agentRole) && (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
            {[node.session.agentName, node.session.agentRole].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
      <div className="mt-3 text-base font-semibold leading-snug text-stone-900">{node.session.firstPromptPreview}</div>
      <div className="mt-2 text-[11px] text-stone-500">Started {node.session.startDisplay}</div>
      <div className="mt-3 space-y-2">
        {leadingMoments.length > 0 ? leadingMoments.map((moment, index) => (
          <div key={`${moment.title}-${index}`} className="rounded-lg bg-stone-50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-500">{moment.title}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-stone-600">{moment.detail}</div>
            {moment.timestamp && <div className="mt-1 text-[10px] text-stone-400">{moment.timestamp}</div>}
          </div>
        )) : (
          <div className="rounded-md bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-stone-500">
            {data ? 'No key events detected.' : 'Parsing branch.'}
          </div>
        )}
      </div>
    </button>
  )
}

function TaskDetailsPanel({
  session,
  insights,
  selectionSummary,
}: {
  session: SessionMeta
  insights: CodexTaskInsights
  selectionSummary: string
}) {
  const keyMoments = highlightMoments(insights.keyMoments, 5)

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(insights.statusLabel)}`}>
            {insights.statusLabel}
          </span>
          <span className="rounded bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
            {insights.roleLabel}
          </span>
        </div>
        <div className="mt-3 text-lg font-semibold text-stone-900">{session.firstPromptPreview}</div>
        <div className="mt-2 text-sm leading-relaxed text-stone-600">{insights.objective}</div>
        <div className="mt-3 text-[11px] text-stone-500">{selectionSummary}</div>
      </div>

      {insights.completionSummary && (
        <div className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700">Completion event</div>
          <div className="mt-1 text-sm leading-relaxed text-emerald-900">{insights.completionSummary}</div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">Key events</div>
        <div className="mt-3 space-y-3">
          {keyMoments.map((moment, index) => (
            <MomentCard key={`${moment.title}-${index}`} moment={moment} />
          ))}
        </div>
      </div>
    </div>
  )
}

function MomentRow({ moment }: { moment: CodexKeyMoment }) {
  return (
    <div className="flex gap-3">
      <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
        moment.tone === 'emerald'
          ? 'bg-emerald-500'
          : moment.tone === 'amber'
            ? 'bg-amber-500'
            : moment.tone === 'rose'
              ? 'bg-rose-500'
              : 'bg-stone-400'
      }`} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-stone-800">{moment.title}</div>
          {moment.timestamp && <div className="text-[11px] text-stone-400">{moment.timestamp}</div>}
        </div>
        <div className="mt-1 text-sm leading-relaxed text-stone-600">{moment.detail}</div>
      </div>
    </div>
  )
}

function MomentCard({ moment }: { moment: CodexKeyMoment }) {
  const toneClass = moment.tone === 'emerald'
    ? 'border-emerald-100 bg-emerald-50/70'
    : moment.tone === 'amber'
      ? 'border-amber-100 bg-amber-50/70'
      : moment.tone === 'rose'
        ? 'border-rose-100 bg-rose-50/70'
        : 'border-stone-200 bg-stone-50'

  return (
    <div className={`rounded-lg border px-4 py-3 ${toneClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-stone-800">{moment.title}</div>
        {moment.timestamp && <div className="text-[11px] text-stone-400">{moment.timestamp}</div>}
      </div>
      <div className="mt-1.5 text-sm leading-relaxed text-stone-600">{moment.detail}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-6 py-10 text-center text-stone-500">
      No Codex task selected.
    </div>
  )
}
