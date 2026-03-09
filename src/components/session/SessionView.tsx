import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const REMARK_PLUGINS = [remarkGfm]
import type { SessionData, SessionMessage, FilterState, PromptIndexEntry } from '../../types/session'
import { extractTimelineEvents } from '../../lib/timeline'
import { Timeline } from './Timeline'
import {
  PromptBlock,
  AiTextBlock,
  ThinkingHint,
  ToolCallLine,
  ToolResultBlock,
  TeamMessageBlock,
  TaskEventBlock,
  ForkIndicator,
  ClearDivider,
  CompactBoundaryDivider,
  PlanStartMarker,
  PlanEndMarker,
} from './MessageRenderers'

interface SessionViewProps {
  data: SessionData
  filter: FilterState
  searchQuery: string
}

export function SessionView({ data, filter, searchQuery }: SessionViewProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [activePromptNums, setActivePromptNums] = useState<Set<number>>(new Set())

  const scrollToPrompt = useCallback((num: number) => {
    const el = contentRef.current?.querySelector(`[data-prompt="${num}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const rendered = useMemo(
    () => renderMessages(data.messages, filter, searchQuery),
    [data.messages, filter, searchQuery],
  )

  const timelineEvents = useMemo(
    () => extractTimelineEvents(data.messages),
    [data.messages],
  )

  // IntersectionObserver to track which prompts are visible
  useEffect(() => {
    const container = contentRef.current
    if (!container) return

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
    <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto bg-[#FAFAF8] min-h-0" ref={contentRef}>
        <PromptIndex prompts={data.prompts} onJump={scrollToPrompt} />
        <div className="py-8 px-8 max-w-4xl mx-auto">
          {rendered}
        </div>
      </div>
      {filter.timeline && timelineEvents.length > 0 && (
        <Timeline
          events={timelineEvents}
          onJump={scrollToPrompt}
          activeNums={activePromptNums}
        />
      )}
    </div>
  )
}

// ─── Prompt Index (sticky table of contents) ───

const PROMPT_INDEX_MIN = 36
const PROMPT_INDEX_DEFAULT = 68
const PROMPT_INDEX_MAX = 400

function PromptIndex({ prompts, onJump }: { prompts: PromptIndexEntry[]; onJump: (num: number) => void }) {
  const [height, setHeight] = useState(PROMPT_INDEX_DEFAULT)
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)
  const [hoveredNum, setHoveredNum] = useState<number | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Cleanup hover timer on unmount
  useEffect(() => {
    return () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }
  }, [])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startY.current = e.clientY
    startH.current = height
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ev.clientY - startY.current
      setHeight(Math.min(PROMPT_INDEX_MAX, Math.max(PROMPT_INDEX_MIN, startH.current + delta)))
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
  }, []) // startH.current captures height at drag start, no need for height dep

  const showPopover = useCallback((num: number, btnEl: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      const rect = btnEl.getBoundingClientRect()
      const containerRect = containerRef.current?.getBoundingClientRect()
      if (!containerRect) return
      setPopoverPos({
        left: Math.max(8, Math.min(rect.left - containerRect.left, containerRect.width - 420)),
        top: rect.bottom - containerRect.top + 4,
      })
      setHoveredNum(num)
    }, 300)
  }, [])

  const hidePopover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHoveredNum(null), 150)
  }, [])

  const keepPopover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])

  if (prompts.length === 0) return null

  const hoveredPrompt = hoveredNum !== null ? prompts.find(p => p.num === hoveredNum) : null

  return (
    <div ref={containerRef} className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm border-b border-gray-200" style={{ height }}>
      <div className="overflow-y-auto py-1.5 overscroll-y-contain" style={{ height: height - 8 }}>
        <div className="max-w-4xl mx-auto px-8 flex flex-wrap gap-0.5">
        {prompts.map((p) => {
          const isSpecial = p.decision === 'interrupt' || p.decision === 'correction'
          return (
            <button
              key={p.num}
              onClick={() => onJump(p.num)}
              onMouseEnter={(e) => showPopover(p.num, e.currentTarget)}
              onMouseLeave={hidePopover}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer transition-colors whitespace-nowrap ${
                isSpecial ? 'text-amber-700 hover:bg-amber-50' : 'text-gray-500 hover:bg-gray-100'
              } ${hoveredNum === p.num ? (isSpecial ? 'bg-amber-50' : 'bg-gray-100') : ''}`}
            >
              <span className={`font-bold ${isSpecial ? 'text-amber-600' : 'text-blue-600'}`}>#{p.num}</span>
              <span className="max-w-[100px] truncate text-gray-600">{p.preview.slice(0, 30)}</span>
              <span className="text-[10px] text-gray-400 font-mono">{p.time.slice(0, 5)}</span>
            </button>
          )
        })}
        </div>
      </div>

      {/* Hover popover */}
      {hoveredPrompt && (
        <div
          onMouseEnter={keepPopover}
          onMouseLeave={hidePopover}
          className="absolute z-20 w-[400px] max-h-[320px] overflow-y-auto bg-white rounded-lg shadow-lg shadow-gray-200/80 border border-gray-200 p-4"
          style={{ left: popoverPos.left, top: popoverPos.top }}
        >
          <div className="flex items-center gap-2 mb-2 pb-2 border-b border-gray-100">
            <span className="font-bold text-blue-600 text-xs">#{hoveredPrompt.num}</span>
            <span className="text-[10px] text-gray-400 font-mono">{hoveredPrompt.time}</span>
          </div>
          <div className="text-sm text-gray-700 prose prose-sm prose-gray max-w-none [&_pre]:bg-gray-50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_code]:text-xs [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:rounded">
            <Markdown remarkPlugins={REMARK_PLUGINS}>{hoveredPrompt.fullText}</Markdown>
          </div>
        </div>
      )}

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="absolute bottom-0 left-0 right-0 h-2 cursor-row-resize group flex items-center justify-center"
      >
        <div className="w-8 h-0.5 rounded-full bg-gray-300 group-hover:bg-violet-400 transition-colors" />
      </div>
    </div>
  )
}

// ─── Message rendering with tool call grouping ───

function renderMessages(messages: SessionMessage[], filter: FilterState, searchQuery: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    // Detect consecutive tool calls + results and group them
    if (msg.kind === 'ai-tool-use' || msg.kind === 'tool-result') {
      const group: SessionMessage[] = []
      while (i < messages.length && (messages[i].kind === 'ai-tool-use' || messages[i].kind === 'tool-result')) {
        group.push(messages[i])
        i++
      }
      const toolCalls = group.filter(m => m.kind === 'ai-tool-use')
      // Group if 3+ tool calls; otherwise render individually
      if (toolCalls.length >= 3) {
        nodes.push(<ToolGroup key={`tg-${i}`} messages={group} filter={filter} />)
      } else {
        for (let j = 0; j < group.length; j++) {
          nodes.push(<MessageBlock key={`t-${i}-${j}`} msg={group[j]} filter={filter} searchQuery={searchQuery} />)
        }
      }
    } else {
      nodes.push(<MessageBlock key={i} msg={msg} filter={filter} searchQuery={searchQuery} />)
      i++
    }
  }
  return nodes
}

// ─── Tool Group (collapsed consecutive tool calls) ───

function ToolGroup({ messages, filter }: { messages: SessionMessage[]; filter: FilterState }) {
  const toolCalls = messages.filter(m => m.kind === 'ai-tool-use') as Extract<SessionMessage, { kind: 'ai-tool-use' }>[]
  const results = messages.filter(m => m.kind === 'tool-result') as Extract<SessionMessage, { kind: 'tool-result' }>[]
  const errorCount = results.filter(r => r.isError).length

  if (!filter.toolCalls && !filter.toolResults) return null

  const names = toolCalls.slice(0, 4).map(t => t.name)
  const namesSummary = names.join(', ') + (toolCalls.length > 4 ? ` +${toolCalls.length - 4}` : '')

  return (
    <details className="mt-1.5 ml-6">
      <summary className="cursor-pointer py-1.5 text-sm text-gray-500 select-none hover:text-gray-700 transition-colors flex items-center gap-2 whitespace-nowrap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 shrink-0">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-medium shrink-0">{toolCalls.length} tool calls</span>
        <span className="text-gray-400 font-mono text-xs truncate min-w-0">({namesSummary})</span>
        {errorCount > 0 && <span className="text-red-500 text-xs font-medium shrink-0">{errorCount} error{errorCount > 1 ? 's' : ''}</span>}
      </summary>
      <div className="mt-1 ml-2 pl-3 border-l border-gray-200">
        {messages.map((m, j) => {
          if (m.kind === 'ai-tool-use' && !filter.toolCalls) return null
          if (m.kind === 'tool-result' && !filter.toolResults) return null
          return <MessageBlock key={j} msg={m} filter={filter} searchQuery="" />
        })}
      </div>
    </details>
  )
}

// ─── Message dispatcher ───

function MessageBlock({ msg, filter, searchQuery }: { msg: SessionMessage; filter: FilterState; searchQuery: string }) {
  switch (msg.kind) {
    case 'user-prompt': return <PromptBlock msg={msg} searchQuery={searchQuery} />
    case 'ai-thinking': return filter.thinking ? <ThinkingHint msg={msg} /> : null
    case 'ai-tool-use': return filter.toolCalls ? <ToolCallLine msg={msg} /> : null
    case 'tool-result': return filter.toolResults ? <ToolResultBlock msg={msg} /> : null
    case 'ai-text': return filter.aiText ? <AiTextBlock msg={msg} /> : null
    case 'team-message': return filter.team ? <TeamMessageBlock msg={msg} /> : null
    case 'task-event': return filter.team ? <TaskEventBlock msg={msg} /> : null
    case 'fork-indicator': {
      // Only show user-decision forks; hide tool-error auto-retries (CLI doesn't show them)
      if (msg.reason === 'tool-error') return null
      return filter.branches ? <ForkIndicator msg={msg} filter={filter} searchQuery={searchQuery} MessageBlock={MessageBlock} /> : null
    }
    case 'clear-divider': return filter.markers ? <ClearDivider msg={msg} /> : null
    case 'compact-boundary': return filter.markers ? <CompactBoundaryDivider msg={msg} /> : null
    case 'plan-start': return filter.markers ? <PlanStartMarker msg={msg} /> : null
    case 'plan-end': return filter.markers ? <PlanEndMarker msg={msg} /> : null
  }
}
