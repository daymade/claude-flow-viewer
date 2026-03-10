import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { FileStore } from '../../lib/fs-access'
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

type ViewMode = 'overview' | 'structure' | 'transcript'

interface CodexWorkspaceViewProps {
  project: ProjectMeta
  activeSession: SessionMeta
  activeSessionData: SessionData
  filter: FilterState
  searchQuery: string
  fileStore: FileStore | null
  onSelectSession: (projectEncoded: string, sessionId: string) => void
}

function cacheKey(projectEncoded: string, sessionId: string): string {
  return `${projectEncoded}/${sessionId}`
}

function statusTone(statusLabel: string): string {
  if (/complete/i.test(statusLabel)) return 'bg-emerald-100 text-emerald-800'
  if (/rollback|interrupt|redirect/i.test(statusLabel)) return 'bg-amber-100 text-amber-800'
  return 'bg-slate-100 text-slate-700'
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
  onSelectSession,
}: CodexWorkspaceViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
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

  if (viewMode === 'transcript') {
    return (
      <CodexViewFrame
        viewMode={viewMode}
        setViewMode={setViewMode}
        subtitle="Raw transcript is preserved for audit. The overview stays first because Codex is multi-threaded work, not a single conversation."
      >
        <SessionView data={activeData} filter={filter} searchQuery={searchQuery} />
      </CodexViewFrame>
    )
  }

  return (
    <CodexViewFrame
      viewMode={viewMode}
      setViewMode={setViewMode}
      subtitle="Start with overview. Structure is secondary. Raw transcript is only for proof."
    >
      <div className="h-full min-h-0 overflow-y-auto bg-[#FAFAF8]">
        <div className="mx-auto max-w-[1180px] px-6 py-6">
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

              {viewMode === 'overview' ? (
                <>
                  <LearningGuide />
                  <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
                    <CurrentFocusSection
                      session={activeSession}
                      insights={activeInsights}
                      selectionSummary={selectionSummary}
                    />
                    <MainThreadNarrative insights={rootInsights} />
                  </div>
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
                  <div className="mt-6 grid gap-6 lg:grid-cols-2">
                    <DecisionSummary insights={rootInsights} />
                    <NoiseSummary insights={rootInsights} />
                  </div>
                </>
              ) : (
                <>
                  <StructureGuide
                    mainTaskCount={mainTasks.length}
                    unlinkedCount={unlinkedTasks.length}
                  />
                  <div className="mt-6 rounded-2xl border border-emerald-100 bg-white shadow-sm shadow-slate-100">
                    <div className="border-b border-emerald-100 px-5 py-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Task graph</div>
                      <div className="mt-1 text-sm text-slate-500">
                        Use this when you want the exact delegation structure. It is no longer the default reading mode.
                      </div>
                    </div>
                    <div className="overflow-x-auto px-5 py-6">
                      <div className="min-w-[860px]">
                        <TaskGraphBranch
                          node={selectedRoot}
                          projectEncoded={project.encodedName}
                          activeSessionId={activeSession.id}
                          sessionDataFor={sessionDataFor}
                          onSelectSession={onSelectSession}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr),360px]">
                    <MainThreadNarrative insights={rootInsights} />
                    <CurrentFocusSection
                      session={activeSession}
                      insights={activeInsights}
                      selectionSummary={selectionSummary}
                    />
                  </div>
                </>
              )}
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
  subtitle,
  children,
}: {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('overview')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              viewMode === 'overview'
                ? 'bg-emerald-100 text-emerald-800'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setViewMode('structure')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              viewMode === 'structure'
                ? 'bg-slate-200 text-slate-800'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            Structure
          </button>
          <button
            type="button"
            onClick={() => setViewMode('transcript')}
            className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              viewMode === 'transcript'
                ? 'bg-slate-200 text-slate-800'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            Raw transcript
          </button>
          <span className="text-[11px] text-slate-400">{subtitle}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
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
    <div className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 via-white to-slate-50 px-5 py-5 shadow-sm shadow-slate-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(insights?.statusLabel ?? 'In progress')}`}>
          {insights?.statusLabel ?? 'In progress'}
        </span>
        <span className="rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          {node.hasMissingParent ? 'Unlinked delegated work' : 'Selected main task'}
        </span>
        <span className="text-[11px] text-slate-400">{node.session.startDisplay}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">{node.session.firstPromptPreview}</div>
      <div className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
        {insights?.objective ?? node.session.firstPromptPreview}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span>{selectionSummary}</span>
        <span>{formatCount(node.descendantCount, 'delegated thread')}</span>
        <span>{loadingSubtree ? `Parsing subtree ${loadedCount}/${totalCount}` : `Loaded ${loadedCount}/${totalCount} threads`}</span>
      </div>
      {subtreeError && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {subtreeError}
        </div>
      )}
    </div>
  )
}

function LearningGuide() {
  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm shadow-slate-100">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">How to read this task</div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <GuideStep title="1. Start with overview" detail="See every delegated branch in one screen before you open anything." />
        <GuideStep title="2. Expand one branch" detail="Each branch opens inline, so you stay in context while reading its own messages." />
        <GuideStep title="3. Open raw proof last" detail="Only drop into raw transcript when the summaries are not enough." />
      </div>
    </div>
  )
}

function GuideStep({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3">
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-slate-600">{detail}</div>
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
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm shadow-slate-100">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Current focus</div>
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
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm shadow-slate-100">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">What happened in the main task</div>
      <div className="mt-1 text-sm text-slate-600">
        Read this first. It explains the main storyline before you open any delegated branch.
      </div>
      <div className="mt-4 space-y-3">
        {beats.length > 0 ? beats.map((moment, index) => (
          <MomentRow key={`${moment.title}-${index}`} moment={moment} />
        )) : (
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
            The selected main task does not have enough parsed events yet to build a storyline.
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
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm shadow-slate-100">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Delegated branches</div>
        <span className="text-[11px] text-slate-400">{formatCount(nodes.length, 'branch', 'branches')}</span>
      </div>
      <div className="mt-1 text-sm text-slate-600">
        This is the one-screen overview. Every branch stays in one compact list, and each row expands inline so you do not have to jump away.
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
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
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
    <div className={`rounded-2xl border transition-colors ${
      isActive ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200 bg-white'
    }`}>
      <div className="px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(status)}`}>
                {status}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                {[node.session.agentName, node.session.agentRole].filter(Boolean).join(' · ') || 'Delegated work'}
              </span>
              <span className="text-[11px] text-slate-400">{node.session.startDisplay}</span>
            </div>
            <div className="mt-2 text-sm font-semibold leading-snug text-slate-900">{headline}</div>
            <div className="mt-1 space-y-1 text-[11px] leading-relaxed text-slate-600">
              {assignedLine && (
                <div>
                  <span className="font-semibold text-slate-700">Assigned:</span>{' '}
                  <span>{assignedLine}</span>
                </div>
              )}
              {returnedLine ? (
                <div>
                  <span className="font-semibold text-slate-700">Returned:</span>{' '}
                  <span>{returnedLine}</span>
                </div>
              ) : (
                <div>{summaryLabel}</div>
              )}
            </div>
          </button>

          <button
            type="button"
            onClick={onToggle}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-200"
          >
            {isExpanded ? 'Hide branch messages' : 'Show branch messages'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {primaryMoments.slice(0, 2).map((moment, index) => (
            <span key={`${moment.title}-${index}`} className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
              {moment.title}
            </span>
          ))}
          {insights?.completionSummary && (
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">
              {insights.completionSummary}
            </span>
          )}
        </div>

        {isExpanded && (
          <div className="mt-4 space-y-4 border-t border-slate-200 pt-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Messages from this branch</div>
              <div className="mt-3 space-y-3">
                {primaryMoments.length > 0 ? primaryMoments.map((moment, index) => (
                  <MomentCard key={`${moment.title}-${index}`} moment={moment} />
                )) : (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    {insights
                      ? 'This branch mostly contains low-signal execution details, so the overview keeps it collapsed.'
                      : 'This branch is still being parsed.'}
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
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-100 ${compact ? 'px-4 py-4' : 'px-5 py-5'}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Decision points</div>
      <div className="mt-3 space-y-3">
        {decisions.length > 0 ? decisions.map((moment, index) => (
          <MomentRow key={`${moment.title}-${index}`} moment={moment} />
        )) : (
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
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
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-100 ${compact ? 'px-4 py-4' : 'px-5 py-5'}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Hidden by default</div>
      <div className="mt-1 text-sm text-slate-600">
        This is the information we intentionally keep out of the default path so you can learn without drowning in protocol noise.
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {insights?.hiddenNoise.length ? insights.hiddenNoise.map((bucket) => (
          <span key={bucket.label} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">
            {bucket.count} {bucket.label}
          </span>
        )) : (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">
            This level was already concise.
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
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm shadow-slate-100">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Structure mode</div>
      <div className="mt-1 text-sm text-slate-600">
        Use structure mode when you need the exact parent-child layout. Overview remains the primary way to learn the task.
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600">
        <span className="rounded-full bg-slate-100 px-2.5 py-1">{formatCount(mainTaskCount, 'main task')}</span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1">{formatCount(unlinkedCount, 'unlinked branch')}</span>
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
          <div className="absolute bottom-6 left-0 top-6 w-px bg-emerald-200" />
          <div className="space-y-4">
            {node.children.map((child) => (
              <div key={child.session.id} className="relative before:absolute before:left-[-32px] before:top-10 before:h-px before:w-8 before:bg-emerald-200">
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
          : 'border-slate-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/40'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone(status)}`}>
          {node.depth === 0 ? 'Main task' : 'Delegated work'}
        </span>
        {(node.session.agentName || node.session.agentRole) && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
            {[node.session.agentName, node.session.agentRole].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
      <div className="mt-3 text-base font-semibold leading-snug text-slate-900">{node.session.firstPromptPreview}</div>
      <div className="mt-2 text-[11px] text-slate-500">Started {node.session.startDisplay}</div>
      <div className="mt-3 space-y-2">
        {leadingMoments.length > 0 ? leadingMoments.map((moment, index) => (
          <div key={`${moment.title}-${index}`} className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{moment.title}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-600">{moment.detail}</div>
            {moment.timestamp && <div className="mt-1 text-[10px] text-slate-400">{moment.timestamp}</div>}
          </div>
        )) : (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            {data
              ? 'This branch mostly contains low-signal execution details, so structure mode keeps it summarized.'
              : 'Load in progress. The branch will fill in once the subtree is parsed.'}
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
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
            {insights.roleLabel}
          </span>
        </div>
        <div className="mt-3 text-lg font-semibold text-slate-900">{session.firstPromptPreview}</div>
        <div className="mt-2 text-sm leading-relaxed text-slate-600">{insights.objective}</div>
        <div className="mt-3 text-[11px] text-slate-500">{selectionSummary}</div>
      </div>

      {insights.completionSummary && (
        <div className="rounded-xl bg-emerald-50 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700">Outcome</div>
          <div className="mt-1 text-sm leading-relaxed text-emerald-900">{insights.completionSummary}</div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">What mattered here</div>
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
              : 'bg-slate-400'
      }`} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-800">{moment.title}</div>
          {moment.timestamp && <div className="text-[11px] text-slate-400">{moment.timestamp}</div>}
        </div>
        <div className="mt-1 text-sm leading-relaxed text-slate-600">{moment.detail}</div>
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
        : 'border-slate-200 bg-slate-50'

  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-slate-800">{moment.title}</div>
        {moment.timestamp && <div className="text-[11px] text-slate-400">{moment.timestamp}</div>}
      </div>
      <div className="mt-1.5 text-sm leading-relaxed text-slate-600">{moment.detail}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center text-slate-500 shadow-sm shadow-slate-100">
      Select a Codex task to build its overview.
    </div>
  )
}
