import type { SessionMessage } from '../types/session'

/**
 * Compute a per-prompt intensity score (0-1) for heatmap visualization.
 * Intensity is driven by: tool calls, forks, errors, thinking length.
 */
export function computeHeatmap(messages: SessionMessage[]): number[] {
  // Group messages by prompt segments
  const segments: SessionMessage[][] = []
  let current: SessionMessage[] = []

  for (const msg of messages) {
    if (msg.kind === 'user-prompt') {
      if (current.length > 0) segments.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
  }
  if (current.length > 0) segments.push(current)

  if (segments.length === 0) return []

  // Score each segment
  const rawScores = segments.map(seg => {
    let score = 0
    for (const m of seg) {
      switch (m.kind) {
        case 'ai-tool-use': score += 1; break
        case 'tool-result': score += m.isError ? 3 : 0.5; break
        case 'fork-indicator': score += 5; break
        case 'ai-thinking': score += m.full.length / 1000; break
        case 'compact-boundary': score += 2; break
      }
    }
    return score
  })

  // Normalize to 0-1
  const max = Math.max(...rawScores, 1)
  return rawScores.map(s => Math.min(1, s / max))
}
