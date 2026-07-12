/* eslint-disable react-refresh/only-export-components -- hook is co-located with its component */
import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const REMARK_PLUGINS = [remarkGfm]

// ─── Hook: manages hover state + debounced show/hide ───

export function useHoverCard<T extends string | number = number>(
  showDelay = 300,
  hideDelay = 150,
) {
  const [hoveredId, setHoveredId] = useState<T | null>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [])

  const show = useCallback((id: T, el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setAnchorRect(el.getBoundingClientRect())
      setHoveredId(id)
    }, showDelay)
  }, [showDelay])

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setHoveredId(null)
      setAnchorRect(null)
    }, hideDelay)
  }, [hideDelay])

  const keep = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return { hoveredId, anchorRect, show, hide, keep }
}

// ─── Card component (rendered via portal at document.body) ───

interface HoverCardProps {
  header?: React.ReactNode
  content: string
  anchorRect: DOMRect
  placement: 'below' | 'left'
  onMouseEnter: () => void
  onMouseLeave: () => void
}

function computeCardWidth(text: string): number {
  const len = text.length
  if (len < 80) return 240
  if (len < 200) return 360
  return 480
}

function computePosition(
  anchor: DOMRect,
  placement: 'below' | 'left',
  cardWidth: number,
): { left: number; top: number } {
  if (placement === 'below') {
    return {
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - cardWidth - 8)),
      top: anchor.bottom + 4,
    }
  }
  // 'left' — position to the left of anchor element
  return {
    left: Math.max(8, anchor.left - cardWidth - 8),
    top: Math.max(8, Math.min(anchor.top, window.innerHeight - 408)),
  }
}

export function HoverCard({ header, content, anchorRect, placement, onMouseEnter, onMouseLeave }: HoverCardProps) {
  const cardWidth = computeCardWidth(content)
  const pos = computePosition(anchorRect, placement, cardWidth)

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 overflow-y-auto bg-white rounded-lg shadow-lg shadow-stone-200/80 border border-stone-200 p-4"
      style={{ left: pos.left, top: pos.top, width: cardWidth, maxHeight: 400 }}
    >
      {header && (
        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-stone-100">
          {header}
        </div>
      )}
      <div className="text-sm text-stone-700 prose prose-sm prose-stone max-w-none [&_pre]:bg-stone-50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_code]:text-xs [&_code]:bg-stone-100 [&_code]:px-1 [&_code]:rounded">
        <Markdown remarkPlugins={REMARK_PLUGINS}>{content}</Markdown>
      </div>
    </div>,
    document.body,
  )
}
