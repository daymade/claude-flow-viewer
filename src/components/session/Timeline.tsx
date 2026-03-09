import { useMemo } from 'react'
import type { TimelineEvent, PromptIndexEntry } from '../../types/session'
import { computeTimeGap, formatGap } from '../../lib/timeline'
import { useHoverCard, HoverCard } from '../shared/HoverCard'

interface TimelineProps {
  events: TimelineEvent[]
  onJump: (promptNum: number) => void
  activeNums: Set<number>
  prompts: PromptIndexEntry[]
}

export function Timeline({ events, onJump, activeNums, prompts }: TimelineProps) {
  const items = useMemo(() => buildTimelineItems(events), [events])
  const promptMap = useMemo(
    () => new Map(prompts.map(p => [p.num, p])),
    [prompts],
  )
  const hover = useHoverCard<number>()

  return (
    <div className="w-[72px] shrink-0 bg-white border-l border-gray-200 overflow-y-auto py-4 flex flex-col items-center relative">
      {/* Vertical connector line */}
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-200 -translate-x-1/2" />

      {items.map((item, i) => {
        if (item.type === 'gap') {
          return (
            <div key={`gap-${i}`} className="relative z-10 my-1 flex flex-col items-center">
              <div className="w-px h-3 bg-gray-300 border-dashed" />
              <span className="text-[9px] text-gray-400 font-mono bg-white px-1">{item.label}</span>
              <div className="w-px h-3 bg-gray-300 border-dashed" />
            </div>
          )
        }

        const ev = item.event
        const isActive = ev.promptNum !== undefined && activeNums.has(ev.promptNum)

        if (ev.kind === 'prompt') {
          const dotColor = getDotColor(ev)
          return (
            <button
              key={`ev-${i}`}
              className={`relative z-10 my-1.5 flex flex-col items-center cursor-pointer group transition-transform ${
                isActive ? 'scale-110' : ''
              }`}
              onClick={() => ev.promptNum !== undefined && onJump(ev.promptNum)}
              onMouseEnter={(e) => ev.promptNum !== undefined && hover.show(ev.promptNum, e.currentTarget)}
              onMouseLeave={hover.hide}
            >
              <div className={`w-3 h-3 rounded-full border-2 transition-all duration-200 ${
                isActive
                  ? `${dotColor.activeBg} ${dotColor.activeBorder} shadow-sm timeline-dot-active`
                  : `bg-white ${dotColor.border} group-hover:${dotColor.hoverBg}`
              }`} />
              <span className={`text-[9px] font-mono mt-0.5 transition-colors ${
                isActive ? 'text-gray-700 font-semibold' : 'text-gray-400'
              }`}>{ev.time.slice(0, 5)}</span>
            </button>
          )
        }

        // Non-prompt event markers (compact, clear, fork, plan) — keep native tooltip
        return (
          <div
            key={`ev-${i}`}
            className="relative z-10 my-1 flex flex-col items-center"
            title={ev.preview}
          >
            <div className={`w-2 h-2 rounded-sm ${getEventMarkerColor(ev.kind)}`} />
            <span className="text-[8px] text-gray-400 font-mono mt-0.5">{getEventLabel(ev.kind)}</span>
          </div>
        )
      })}

      {/* Hover card for prompt dots */}
      {hover.hoveredId !== null && hover.anchorRect && (() => {
        const prompt = promptMap.get(hover.hoveredId)
        if (!prompt) return null
        return (
          <HoverCard
            header={<>
              <span className="font-bold text-blue-600 text-xs">#{prompt.num}</span>
              <span className="text-[10px] text-gray-400 font-mono">{prompt.time}</span>
            </>}
            content={prompt.fullText}
            anchorRect={hover.anchorRect}
            placement="left"
            onMouseEnter={hover.keep}
            onMouseLeave={hover.hide}
          />
        )
      })()}
    </div>
  )
}

// ─── Internal ───

interface TimelineItem {
  type: 'event' | 'gap'
  event: TimelineEvent
  label?: string
}

function buildTimelineItems(events: TimelineEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []

  for (let i = 0; i < events.length; i++) {
    // Insert gap indicator if >5 min between events
    if (i > 0) {
      const gap = computeTimeGap(events[i - 1], events[i])
      if (gap >= 300) {
        items.push({ type: 'gap', event: events[i], label: formatGap(gap) })
      }
    }
    items.push({ type: 'event', event: events[i] })
  }

  return items
}

function getDotColor(ev: TimelineEvent) {
  if (ev.decision === 'interrupt') {
    return {
      border: 'border-amber-400',
      activeBg: 'bg-amber-500',
      activeBorder: 'border-amber-500',
      hoverBg: 'bg-amber-50',
    }
  }
  if (ev.decision === 'correction') {
    return {
      border: 'border-rose-400',
      activeBg: 'bg-rose-500',
      activeBorder: 'border-rose-500',
      hoverBg: 'bg-rose-50',
    }
  }
  return {
    border: 'border-blue-400',
    activeBg: 'bg-blue-500',
    activeBorder: 'border-blue-500',
    hoverBg: 'bg-blue-50',
  }
}

function getEventMarkerColor(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'compact': return 'bg-teal-400'
    case 'clear': return 'bg-gray-400'
    case 'fork': return 'bg-amber-400'
    case 'plan-start': return 'bg-indigo-400'
    case 'plan-end': return 'bg-indigo-300'
    default: return 'bg-gray-300'
  }
}

function getEventLabel(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'compact': return 'CMP'
    case 'clear': return 'CLR'
    case 'fork': return 'FRK'
    case 'plan-start': return 'PLN'
    case 'plan-end': return 'END'
    default: return ''
  }
}
