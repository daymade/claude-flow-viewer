import { useMemo, useRef, useCallback } from 'react'
import type { TimelineEvent, PromptIndexEntry } from '../../types/session'
import { useHoverCard, HoverCard } from '../shared/HoverCard'

interface TimelineProps {
  events: TimelineEvent[]
  onJump: (promptNum: number) => void
  onScrollTo: (fraction: number) => void
  activeNums: Set<number>
  prompts: PromptIndexEntry[]
  /** scrollTop / scrollHeight — where the viewport top is in content space (0–1) */
  scrollFraction: number
  /** clientHeight / scrollHeight — how much of content is visible (0–1, >=1 means all visible) */
  viewportFraction: number
  /** promptNum → offsetInContent/scrollHeight (0–1) measured from DOM */
  promptPositions: Map<number, number>
}

/** Edge padding so dots at extremes don't clip */
const EDGE_PAD = 0.012

export function Timeline({
  events, onJump, onScrollTo, activeNums, prompts,
  scrollFraction, viewportFraction, promptPositions,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const promptMap = useMemo(
    () => new Map(prompts.map(p => [p.num, p])),
    [prompts],
  )
  const hover = useHoverCard<number>()
  const hoveredPrompt = hover.hoveredId !== null ? promptMap.get(hover.hoveredId) ?? null : null

  // Compute positions for all events, mapped to content space (0–1)
  const positionedEvents = useMemo(
    () => computeEventPositions(events, promptPositions),
    [events, promptPositions],
  )

  // Decide which prompt dots show time labels (active + evenly spaced)
  const labelVisible = useMemo(() => {
    const promptEvts = positionedEvents.filter(pe => pe.event.kind === 'prompt')
    const count = promptEvts.length
    const interval = Math.max(1, Math.ceil(count / 12))
    const visible = new Set<number>()
    promptEvts.forEach((pe, idx) => {
      if (idx % interval === 0 || idx === count - 1) {
        if (pe.event.promptNum !== undefined) visible.add(pe.event.promptNum)
      }
    })
    return visible
  }, [positionedEvents])

  // Viewport indicator bounds (percentage)
  const allVisible = viewportFraction >= 1
  const vpTop = allVisible ? 0 : toPercent(scrollFraction)
  const vpBottom = allVisible ? 100 : toPercent(Math.min(1, scrollFraction + viewportFraction))
  const vpHeight = Math.max(vpBottom - vpTop, 1.5)

  // Click on the track → scroll main content to that position
  const onTrackClick = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const clickRatio = (e.clientY - rect.top) / rect.height
    const contentRatio = fromPercent(clickRatio * 100)
    const target = Math.max(0, Math.min(1 - viewportFraction, contentRatio - viewportFraction / 2))
    onScrollTo(target)
  }, [viewportFraction, onScrollTo])

  // Drag the viewport indicator to scroll
  const onIndicatorDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const container = containerRef.current
    if (!container) return
    const startY = e.clientY
    const startFraction = scrollFraction
    const usableHeight = container.getBoundingClientRect().height * (1 - 2 * EDGE_PAD)

    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientY - startY) / usableHeight
      onScrollTo(Math.max(0, Math.min(1 - viewportFraction, startFraction + delta)))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [scrollFraction, viewportFraction, onScrollTo])

  return (
    <div
      ref={containerRef}
      className="w-[72px] shrink-0 bg-white border-l border-stone-200 relative select-none cursor-pointer"
      onClick={onTrackClick}
    >
      {/* Track line */}
      <div
        className="absolute left-1/2 w-px bg-stone-200 -translate-x-1/2"
        style={{ top: `${EDGE_PAD * 100}%`, bottom: `${EDGE_PAD * 100}%` }}
      />

      {/* Viewport indicator — shows which portion of content is visible */}
      <div
        className="absolute left-0 right-0 bg-amber-50/80 border-y border-amber-300/30 cursor-grab active:cursor-grabbing z-[5]"
        style={{ top: `${vpTop}%`, height: `${vpHeight}%`, minHeight: 12 }}
        onMouseDown={onIndicatorDrag}
        onClick={e => e.stopPropagation()}
      />

      {/* Start / end time anchors */}
      {events.length > 0 && (
        <>
          <div className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[7px] text-stone-300 font-mono z-20 pointer-events-none">
            {events[0].time.slice(0, 5)}
          </div>
          <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[7px] text-stone-300 font-mono z-20 pointer-events-none">
            {events[events.length - 1].time.slice(0, 5)}
          </div>
        </>
      )}

      {/* Event markers — absolutely positioned by content ratio */}
      {positionedEvents.map((pe, i) => {
        const ev = pe.event
        const isActive = ev.promptNum !== undefined && activeNums.has(ev.promptNum)
        const top = toPercent(pe.position)

        if (ev.kind === 'prompt') {
          const dot = getDotColor(ev)
          const showTime = isActive || (ev.promptNum !== undefined && labelVisible.has(ev.promptNum))
          return (
            <button
              key={i}
              className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center cursor-pointer group z-10"
              style={{ top: `${top}%` }}
              onClick={e => { e.stopPropagation(); if (ev.promptNum !== undefined) onJump(ev.promptNum) }}
              onMouseEnter={e => { if (ev.promptNum !== undefined) hover.show(ev.promptNum, e.currentTarget) }}
              onMouseLeave={hover.hide}
            >
              <div className={`rounded-full border-2 transition-all duration-150 ${
                isActive
                  ? `w-3 h-3 ${dot.activeBg} ${dot.activeBorder} shadow-sm`
                  : `w-2 h-2 bg-white ${dot.border} group-hover:scale-150`
              }`} />
              {showTime && (
                <span className={`text-[7px] font-mono leading-none mt-px whitespace-nowrap ${
                  isActive ? 'text-stone-600 font-medium' : 'text-stone-400'
                }`}>
                  {ev.time.slice(0, 5)}
                </span>
              )}
            </button>
          )
        }

        // Non-prompt markers (compact, clear, fork, plan) — shape + label
        return (
          <div
            key={i}
            className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center z-10"
            style={{ top: `${top}%` }}
            title={ev.preview}
          >
            <div className={getEventMarkerStyle(ev.kind)} />
            <span className="text-[6px] font-mono text-stone-400 leading-none mt-0.5 whitespace-nowrap">
              {getEventLabel(ev.kind)}
            </span>
          </div>
        )
      })}

      {/* Hover card for prompt dots */}
      {hoveredPrompt && hover.anchorRect && (
        <HoverCard
          header={<>
            <span className="font-bold text-blue-600 text-xs">#{hoveredPrompt.num}</span>
            <span className="text-[10px] text-stone-400 font-mono">{hoveredPrompt.time}</span>
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

// ─── Coordinate mapping ───
// Maps content-space fraction (0–1) to display percentage with edge padding

function toPercent(fraction: number): number {
  return (EDGE_PAD + Math.max(0, Math.min(1, fraction)) * (1 - 2 * EDGE_PAD)) * 100
}

function fromPercent(percent: number): number {
  return (percent / 100 - EDGE_PAD) / (1 - 2 * EDGE_PAD)
}

// ─── Event positioning ───

interface PositionedEvent {
  event: TimelineEvent
  position: number // 0–1 in content space
}

function computeEventPositions(
  events: TimelineEvent[],
  promptPositions: Map<number, number>,
): PositionedEvent[] {
  if (events.length === 0) return []

  // If no DOM measurements yet, fall back to even distribution
  if (promptPositions.size === 0) {
    const n = events.length
    return events.map((ev, i) => ({
      event: ev,
      position: n === 1 ? 0.5 : i / (n - 1),
    }))
  }

  // Map known positions (prompts with DOM measurements), null for unknown
  const raw: (number | null)[] = events.map(ev =>
    ev.promptNum !== undefined && promptPositions.has(ev.promptNum)
      ? promptPositions.get(ev.promptNum)!
      : null,
  )

  // Interpolate unknown positions between surrounding known ones
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== null) continue
    let pIdx = -1, pVal = 0
    for (let j = i - 1; j >= 0; j--) {
      if (raw[j] !== null) { pIdx = j; pVal = raw[j]!; break }
    }
    let nIdx = raw.length, nVal = 1
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j] !== null) { nIdx = j; nVal = raw[j]!; break }
    }
    raw[i] = pVal + (nVal - pVal) * ((i - pIdx) / (nIdx - pIdx))
  }

  return events.map((ev, i) => ({ event: ev, position: raw[i]! }))
}

// ─── Styling helpers ───

function getDotColor(ev: TimelineEvent) {
  if (ev.decision === 'interrupt') {
    return { border: 'border-amber-400', activeBg: 'bg-amber-500', activeBorder: 'border-amber-500' }
  }
  if (ev.decision === 'correction') {
    return { border: 'border-rose-400', activeBg: 'bg-rose-500', activeBorder: 'border-rose-500' }
  }
  return { border: 'border-blue-400', activeBg: 'bg-blue-500', activeBorder: 'border-blue-500' }
}

function getEventMarkerStyle(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'compact': return 'w-1.5 h-1.5 rotate-45 bg-stone-500/60'               // diamond
    case 'clear': return 'w-3.5 h-px bg-stone-400 rounded-full'                   // horizontal line
    case 'fork': return 'w-2 h-2 rounded-full bg-amber-500/50 border border-amber-500/60'  // hollow circle
    case 'plan-start': return 'w-2 h-2 rounded-sm bg-stone-500/50'                // filled square
    case 'plan-end': return 'w-2 h-2 rounded-sm border border-stone-400 bg-transparent' // hollow square
    default: return 'w-1.5 h-1.5 rounded-sm bg-stone-300'
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
