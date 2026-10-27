import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import type { SessionData, SessionMessage, FilterState, PromptIndexEntry } from '../../types/session'
import { extractTimelineEvents } from '../../lib/timeline'
import { Timeline } from './Timeline'
import { useHoverCard, HoverCard } from '../shared/HoverCard'
import { SessionResources, type ReadToolResult, type ResolveImage, type SessionResourcesValue } from './SessionResources'
import {
  PromptBlock,
  AiTextBlock,
  ThinkingHint,
  ToolCallLine,
  ToolResultBlock,
  TeamMessageBlock,
  DelegationUpdateBlock,
  TaskEventBlock,
  ForkIndicator,
  RollbackMarker,
  ClearDivider,
  CompactBoundaryDivider,
  PlanStartMarker,
  PlanEndMarker,
} from './MessageRenderers'

export interface ReaderJumpTarget {
  messageIndex: number
  promptNum?: number
  /**
   * Optional stable identity token for one explicit navigation request.
   * A host that wants repeated jumps to the same position to count as
   * separate navigations (and to suspend the reader's internal Find)
   * supplies a fresh token per request; re-rendering with the same token
   * is the same navigation and must not reset anything.
   */
  requestId?: string | number
}

export interface SessionViewProps {
  data: SessionData
  filter: FilterState
  searchQuery: string
  activeSearchTarget?: ReaderJumpTarget | null
  showTimeline?: boolean
  showPromptIndex?: boolean
  header?: React.ReactNode
  readerMode?: boolean
  readToolResult?: ReadToolResult | null
  resolveImage?: ResolveImage | null
  /** Semantic identity of the session resource behind `readToolResult`. */
  resourceScope?: string | null
  /** Optional actions rendered with the fully-filtered guidance (e.g. adjust filters, load earlier). */
  filteredEmptyActions?: React.ReactNode
  /** Optional actions rendered with the zero-loaded-records guidance. */
  rangeEmptyActions?: React.ReactNode
  /** Suppresses empty-state guidance while a read is still in flight. */
  pending?: boolean
}

function scrollWithinReader(container: HTMLDivElement, target: HTMLElement, block: 'start' | 'center') {
  const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  const padding = block === 'center' ? Math.max(0, (container.clientHeight - target.offsetHeight) / 2) : 0
  container.scrollTop = Math.max(0, offset - padding)
}

function revealReaderMatch(container: HTMLDivElement, target: HTMLElement, query: string) {
  if (!query) return false
  const needle = query.toLowerCase()
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  let match: { node: Text; start: number; end: number } | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const offset = text.toLowerCase().indexOf(needle)
    if (offset < 0) continue
    // Case folding can change UTF-16 length (İ → i + combining dot).
    // DOM Range offsets must stay in the original Text node's coordinates.
    let start = 0, end = 0, folded = 0
    for (const character of text) {
      const next = folded + character.toLowerCase().length
      if (next <= offset) start += character.length
      end += character.length
      if (next >= offset + needle.length) break
      folded = next
    }
    // Prefer the complete body over a summary that may be visually truncated.
    if (!match || !node.parentElement?.closest('summary')) match = { node: node as Text, start, end }
    if (!node.parentElement?.closest('summary')) break
  }
  if (!match) return false
  for (let parent = match.node.parentElement; parent && target.contains(parent); parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  const range = document.createRange()
  range.setStart(match.node, match.start)
  range.setEnd(match.node, match.end)
  if (typeof range.getBoundingClientRect !== 'function') return false
  // Scroll the original record/tool output's own bounded <pre> first, then
  // the transcript. Moving only the message wrapper can leave its hit clipped.
  for (let parent = match.node.parentElement; parent && container.contains(parent); parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const rect = range.getBoundingClientRect(), bounds = parent.getBoundingClientRect()
    if (parent === container || /auto|scroll/.test(style.overflowY)) {
      parent.scrollTop += rect.top - bounds.top - Math.max(0, (parent.clientHeight - rect.height) / 2)
    }
    if (/auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
      parent.scrollLeft += rect.left - bounds.left - Math.max(0, (parent.clientWidth - rect.width) / 2)
    }
  }
  return true
}

export function SessionView({
  data,
  filter,
  searchQuery,
  activeSearchTarget = null,
  showTimeline = true,
  showPromptIndex = true,
  header = null,
  readerMode = false,
  readToolResult = null,
  resolveImage = null,
  resourceScope = null,
  filteredEmptyActions = null,
  rangeEmptyActions = null,
  pending = false,
}: SessionViewProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const resourcesValue = useMemo<SessionResourcesValue | null>(
    () => {
      if (!readToolResult&&!resolveImage) return null
      if(resolveImage)return {readToolResult:readToolResult??undefined,resolveImage,scope:resourceScope}
      return resourceScope != null ? { readToolResult:readToolResult!, scope: resourceScope } : readToolResult
    },
    [readToolResult, resolveImage, resourceScope],
  )
  const [activePromptNums, setActivePromptNums] = useState<Set<number>>(new Set())
  const [scrollFraction, setScrollFraction] = useState(0)
  const [viewportFraction, setViewportFraction] = useState(1)
  const [promptPositions, setPromptPositions] = useState<Map<number, number>>(new Map())
  const rafRef = useRef(0)

  const scrollToPrompt = useCallback((num: number) => {
    const el = contentRef.current?.querySelector(`[data-prompt="${num}"]`)
    if(el instanceof HTMLElement && contentRef.current)scrollWithinReader(contentRef.current,el,'start')
  }, [])

  const scrollToFraction = useCallback((fraction: number) => {
    const el = contentRef.current
    if (!el || el.scrollHeight <= 0) return
    el.scrollTop = Math.max(0, fraction * el.scrollHeight)
  }, [])

  const rendered = useMemo(
    () => renderMessages(data.messages, filter, searchQuery, activeSearchTarget?.messageIndex ?? null, readerMode),
    [activeSearchTarget?.messageIndex, data.messages, filter, readerMode, searchQuery],
  )

  // Emptiness is determined from genuinely rendered nodes: renderMessages only
  // returns nodes that produce visible output, so a nonempty loaded window with
  // zero entries is entirely filtered, not empty. A read still in flight shows
  // neither guidance — pending and failure states stay distinct from
  // success-empty.
  const emptyKind = pending || rendered.length > 0
    ? null
    : data.messages.length > 0 ? 'filtered' : 'range'

  const timelineEvents = useMemo(
    () => extractTimelineEvents(data.messages),
    [data.messages],
  )

  // Track scroll position for timeline minimap
  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const update = () => {
      const sh = el.scrollHeight
      if (sh <= 0) return
      setScrollFraction(el.scrollTop / sh)
      setViewportFraction(el.clientHeight / sh)
    }

    const onScroll = () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(update)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    update()

    const resizeObs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resizeObs?.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(rafRef.current)
      resizeObs?.disconnect()
    }
  }, [])

  // Measure prompt element positions for timeline mapping
  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const measure = () => {
      const sh = el.scrollHeight
      if (sh <= 0) return
      const containerRect = el.getBoundingClientRect()
      const map = new Map<number, number>()
      el.querySelectorAll('[data-prompt]').forEach(node => {
        const htmlEl = node as HTMLElement
        const num = Number(htmlEl.dataset.prompt)
        if (isNaN(num)) return
        const rect = htmlEl.getBoundingClientRect()
        const offsetInContent = rect.top - containerRect.top + el.scrollTop
        map.set(num, offsetInContent / sh)
      })
      setPromptPositions(map)
    }

    const raf = requestAnimationFrame(measure)
    const resizeObs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => requestAnimationFrame(measure))
    resizeObs?.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      resizeObs?.disconnect()
    }
  }, [rendered])

  useEffect(() => {
    if (!activeSearchTarget) return
    const el = contentRef.current
    if (!el) return

    const raf = requestAnimationFrame(() => {
      const target = activeSearchTarget.promptNum
        ? el.querySelector(`[data-prompt="${activeSearchTarget.promptNum}"]`)
        : el.querySelector(`[data-message-index="${activeSearchTarget.messageIndex}"]`)
      if (target instanceof HTMLElement) {
        if (!revealReaderMatch(el,target,searchQuery)) scrollWithinReader(el,target,'center')
      }
    })

    return () => cancelAnimationFrame(raf)
  }, [activeSearchTarget, rendered, searchQuery])

  // IntersectionObserver to track which prompts are visible
  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        setActivePromptNums(prev => {
          const next = new Set(prev)
          for (const entry of entries) {
            const num = Number((entry.target as HTMLElement).dataset.prompt)
            if (isNaN(num)) continue
            if (entry.isIntersecting) next.add(num)
            else next.delete(num)
          }
          // Only update state if changed
          if (next.size === prev.size && [...next].every(n => prev.has(n))) return prev
          return next
        })
      },
      { root: container, threshold: 0.1 },
    )

    const elements = container.querySelectorAll('[data-prompt]')
    elements.forEach(el => observer.observe(el))

    return () => observer.disconnect()
  }, [rendered])

  return (
    <SessionResources.Provider value={resourcesValue}><div className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
      <div
        className="min-h-0 flex-1 overflow-y-auto bg-[#FAFAF8] focus:outline-none"
        ref={contentRef}
        data-primary-scroll
        data-export-primary
        tabIndex={0}
      >
        {header}
        <div className="py-6 px-4 max-w-4xl mx-auto sm:py-8 sm:px-8">
          {rendered}
          {emptyKind && (
            <div className="reader-empty-state" role="status" data-empty-state={emptyKind}>
              <p>{emptyKind === 'filtered' ? '当前筛选没有可见记录' : '当前读取范围没有记录'}</p>
              {(emptyKind === 'filtered' ? filteredEmptyActions : rangeEmptyActions) && (
                <div className="reader-empty-actions">{emptyKind === 'filtered' ? filteredEmptyActions : rangeEmptyActions}</div>
              )}
            </div>
          )}
        </div>
      </div>
      {showPromptIndex && (
        <PromptOutline
          prompts={data.prompts}
          heatmap={data.heatmap}
          activeNums={activePromptNums}
          onJump={scrollToPrompt}
        />
      )}
      {showTimeline && filter.timeline && timelineEvents.length > 0 && (
        <div className="hidden md:flex min-h-0">
          <Timeline
            events={timelineEvents}
            onJump={scrollToPrompt}
            onScrollTo={scrollToFraction}
            activeNums={activePromptNums}
            prompts={data.prompts}
            scrollFraction={scrollFraction}
            viewportFraction={viewportFraction}
            promptPositions={promptPositions}
          />
        </div>
      )}
    </div></SessionResources.Provider>
  )
}

// ─── Prompt Outline (right-rail table of contents, Obsidian-style) ───

function PromptOutline({
  prompts,
  heatmap,
  activeNums,
  onJump,
}: {
  prompts: PromptIndexEntry[]
  /** Per-prompt intensity 0–1. `heatmap[i]` lines up with `prompts[i]` — contract pinned in `heatmap.test.ts`. */
  heatmap: number[]
  activeNums: Set<number>
  onJump: (num: number) => void
}) {
  const hover = useHoverCard<number>()

  if (prompts.length === 0) return null

  const hoveredPrompt = hover.hoveredId !== null ? prompts.find(p => p.num === hover.hoveredId) : null

  return (
    <div
      className="hidden lg:flex w-[232px] shrink-0 flex-col border-l border-stone-200/70 bg-[#FAFAF8]"
      data-export-remove
    >
      <div className="shrink-0 border-b border-stone-200/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
        Outline · {prompts.length}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 overscroll-y-contain">
        {prompts.map((p, i) => {
          const isSpecial = p.decision === 'interrupt' || p.decision === 'correction'
          const isActive = activeNums.has(p.num)
          // The left rail doubles as the heat strip: how much work happened under this prompt
          // (tool calls, errors, forks, thinking). Scan it to find the heavy turns at a glance.
          const intensity = Math.max(0, Math.min(1, heatmap[i] ?? 0))
          return (
            <button
              key={p.num}
              onClick={() => onJump(p.num)}
              onMouseEnter={(e) => hover.show(p.num, e.currentTarget)}
              onMouseLeave={hover.hide}
              title={`Activity ${Math.round(intensity * 100)}%`}
              className={`group flex w-full items-stretch gap-2 px-2.5 py-1.5 text-left transition-colors ${
                isActive ? 'bg-amber-50' : 'hover:bg-stone-100/70'
              }`}
            >
              <span
                className={`w-[3px] shrink-0 rounded-full ${
                  isActive ? 'bg-amber-500' : isSpecial ? 'bg-amber-300' : ''
                }`}
                style={
                  isActive || isSpecial
                    ? undefined
                    : { backgroundColor: `rgba(120, 113, 108, ${(0.12 + intensity * 0.68).toFixed(3)})` }
                }
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-semibold tabular-nums ${isSpecial ? 'text-amber-600' : 'text-stone-400'}`}>#{p.num}</span>
                  <span className="text-[10px] tabular-nums text-stone-400">{p.time.slice(0, 5)}</span>
                  {isSpecial && (
                    <span className="rounded-full bg-amber-100 px-1.5 text-[9px] font-semibold text-amber-700">
                      {p.decision === 'interrupt' ? 'interrupt' : 'decision'}
                    </span>
                  )}
                </span>
                <span className={`mt-0.5 text-[12px] leading-snug line-clamp-2 ${
                  isActive ? 'font-medium text-stone-900' : 'text-stone-600'
                }`}>
                  {p.preview}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {hoveredPrompt && hover.anchorRect && (
        <HoverCard
          header={<>
            <span className="text-xs font-bold text-amber-700">#{hoveredPrompt.num}</span>
            <span className="text-[10px] font-mono text-stone-400">{hoveredPrompt.time}</span>
          </>}
          content={hoveredPrompt.fullText}
          anchorRect={hover.anchorRect}
          placement="left"
          onMouseEnter={hover.keep}
          onMouseLeave={hover.hide}
        />
      )}
    </div>
  )
}

// ─── Message rendering with tool call grouping ───

function renderMessages(
  messages: SessionMessage[],
  filter: FilterState,
  searchQuery: string,
  highlightedMessageIndex: number | null,
  readerMode: boolean,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let i = 0
  const forceExpandedTools = Boolean(searchQuery) || highlightedMessageIndex !== null

  while (i < messages.length) {
    const msg = messages[i]

    // Detect consecutive tool calls + results and group them
    if (!forceExpandedTools && (msg.kind === 'ai-tool-use' || msg.kind === 'tool-result')) {
      const groupStart = i
      const group: SessionMessage[] = []
      while (i < messages.length && (messages[i].kind === 'ai-tool-use' || messages[i].kind === 'tool-result')) {
        group.push(messages[i])
        i++
      }
      const toolCalls = group.filter(m => m.kind === 'ai-tool-use')
      // Group if 3+ tool calls; otherwise render individually
      if (toolCalls.length >= 3) {
        // The group's own visibility condition is applied before adding it, so
        // rendering and visibility stay one logic path: the returned array only
        // ever holds nodes that genuinely render, and emptiness can be read
        // from it directly (an element that later returns null would look
        // truthy here while producing no visible output).
        if (toolGroupVisible(filter)) {
          nodes.push(<ToolGroup key={`tg-${i}`} messages={group} filter={filter} />)
        }
      } else {
        for (let j = 0; j < group.length; j++) {
          const node = renderAnchoredMessage(group[j], groupStart + j, filter, searchQuery, highlightedMessageIndex, `t-${i}-${j}`, readerMode)
          if (node) nodes.push(node)
        }
      }
    } else {
      const node = renderAnchoredMessage(msg, i, filter, searchQuery, highlightedMessageIndex, i, readerMode)
      if (node) nodes.push(node)
      i++
    }
  }
  return nodes
}

function renderAnchoredMessage(
  msg: SessionMessage,
  messageIndex: number,
  filter: FilterState,
  searchQuery: string,
  highlightedMessageIndex: number | null,
  key: React.Key,
  readerMode: boolean,
) {
  const forceVisible = highlightedMessageIndex === messageIndex
  const content = MessageBlock({ msg, filter, searchQuery, forceVisible, readerMode })
  if (!content) return null

  return (
    <div
      key={key}
      data-message-index={messageIndex}
      data-source-record-id={msg.sourceRecordId}
      className={forceVisible ? 'scroll-mt-28 rounded-2xl bg-amber-50/60 ring-1 ring-amber-200 px-2 py-1' : 'scroll-mt-28'}
    >
      {'timestamp' in msg && msg.timestamp && <time className="block text-[10px] text-stone-400 font-mono mt-2" dateTime={msg.timestamp}>{/^\d{4}-\d\d-\d\dT/.test(msg.timestamp) ? new Date(msg.timestamp).toLocaleString(undefined,{hour12:false}) : msg.timestamp}</time>}
      {content}
      <SourceRecordDetails msg={msg}/>
    </div>
  )
}

function SourceRecordDetails({msg}:{msg:SessionMessage}) {
  return msg.sourceRecord ? <details className="ml-6 my-2 text-[11px] text-stone-400"><summary className="cursor-pointer">Original native record</summary><pre className="p-3 whitespace-pre-wrap break-words max-h-80 overflow-auto bg-stone-50">{JSON.stringify(msg.sourceRecord,null,2)}</pre></details> : null
}

// ─── Tool Group (collapsed consecutive tool calls) ───

/**
 * A tool group renders only when at least one tool stream is enabled. This is
 * the single visibility condition: renderMessages applies it before adding a
 * group, and ToolGroup keeps it as its own guard.
 */
function toolGroupVisible(filter: FilterState) {
  return filter.toolCalls || filter.toolResults
}

function ToolGroup({ messages, filter }: { messages: SessionMessage[]; filter: FilterState }) {
  const toolCalls = messages.filter(m => m.kind === 'ai-tool-use') as Extract<SessionMessage, { kind: 'ai-tool-use' }>[]
  const results = messages.filter(m => m.kind === 'tool-result') as Extract<SessionMessage, { kind: 'tool-result' }>[]
  const errorCount = results.filter(r => r.isError).length

  if (!toolGroupVisible(filter)) return null

  const names = toolCalls.slice(0, 4).map(t => t.name)
  const namesSummary = names.join(', ') + (toolCalls.length > 4 ? ` +${toolCalls.length - 4}` : '')

  return (
    <details className="mt-1.5 ml-6">
      <summary className="cursor-pointer py-1.5 text-sm text-stone-500 select-none hover:text-stone-700 transition-colors flex items-center gap-2 whitespace-nowrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400 shrink-0">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-medium shrink-0">{toolCalls.length} tool calls</span>
        <span className="text-stone-400 font-mono text-xs truncate min-w-0">({namesSummary})</span>
        {errorCount > 0 && <span className="text-red-500 text-xs font-medium shrink-0">{errorCount} error{errorCount > 1 ? 's' : ''}</span>}
      </summary>
      <div className="mt-1 ml-2 pl-3 border-l border-stone-200">
        {messages.map((m, j) => {
          if (m.kind === 'ai-tool-use' && !filter.toolCalls) return null
          if (m.kind === 'tool-result' && !filter.toolResults) return null
          return <div key={j}><MessageBlock msg={m} filter={filter} searchQuery="" /><SourceRecordDetails msg={m}/></div>
        })}
      </div>
    </details>
  )
}

// ─── Message dispatcher ───

function MessageBlock({
  msg,
  filter,
  searchQuery,
  forceVisible = false,
  readerMode = false,
}: {
  msg: SessionMessage
  filter: FilterState
  searchQuery: string
  forceVisible?: boolean
  readerMode?: boolean
}) {
  switch (msg.kind) {
    case 'user-prompt': return <PromptBlock msg={msg} searchQuery={searchQuery} />
    case 'ai-thinking': return filter.thinking || forceVisible ? <ThinkingHint msg={msg} /> : null
    case 'ai-tool-use': return filter.toolCalls || forceVisible ? <ToolCallLine msg={msg} /> : null
    case 'tool-result': return filter.toolResults || forceVisible ? <ToolResultBlock msg={msg} /> : null
    case 'ai-text': return filter.aiText || forceVisible ? <AiTextBlock msg={msg} /> : null
    case 'team-message': return filter.team || forceVisible ? <TeamMessageBlock msg={msg} /> : null
    case 'delegation-update': return filter.team || forceVisible ? <DelegationUpdateBlock msg={msg} /> : null
    case 'task-event': return !readerMode && (filter.team || forceVisible) ? <TaskEventBlock msg={msg} /> : null
    case 'fork-indicator': {
      // Only show user-decision forks; hide tool-error auto-retries (CLI doesn't show them)
      if (msg.reason === 'tool-error') return null
      return filter.branches || forceVisible ? <ForkIndicator msg={msg} filter={filter} searchQuery={searchQuery} MessageBlock={MessageBlock} /> : null
    }
    case 'rollback-marker': return filter.branches || forceVisible ? <RollbackMarker msg={msg} /> : null
    case 'clear-divider': return filter.markers || forceVisible ? <ClearDivider msg={msg} /> : null
    case 'compact-boundary': return filter.markers || forceVisible ? <CompactBoundaryDivider msg={msg} /> : null
    case 'plan-start': return filter.markers || forceVisible ? <PlanStartMarker msg={msg} /> : null
    case 'plan-end': return filter.markers || forceVisible ? <PlanEndMarker msg={msg} /> : null
  }
}
