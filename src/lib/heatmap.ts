import type { SessionMessage } from '../types/session'

/**
 * Compute a per-prompt intensity score (0-1) for heatmap visualization.
 * Intensity is driven by: tool calls, forks, errors, thinking length.
 *
 * ALIGNMENT CONTRACT: the returned array has exactly one entry per *numbered* prompt,
 * so `heatmap[i]` always lines up with `SessionData.prompts[i]`. Two things would
 * silently break that if segmented naively:
 *   - Abandoned fork-branch prompts are pushed into `messages` with `promptNum: 0` but
 *     are NOT added to `prompts`. They must NOT open a new segment (they are folded into
 *     the current prompt's segment, which is also semantically right — an abandoned branch
 *     is work done during that turn).
 *   - Messages before the first numbered prompt must not form a leading segment.
 * Both would shift every subsequent index and paint intensities onto the wrong rows.
 * Guarded by `heatmap.test.ts`.
 */
export function computeHeatmap(messages: SessionMessage[]): number[] {
  const segments: SessionMessage[][] = []
  let current: SessionMessage[] | null = null

  for (const msg of messages) {
    if (msg.kind === 'user-prompt' && msg.promptNum > 0) {
      if (current) segments.push(current)
      current = [msg]
    } else if (current) {
      current.push(msg)
    }
    // messages before the first numbered prompt are intentionally dropped
  }
  if (current) segments.push(current)

  if (segments.length === 0) return []

  // Score each segment
  const rawScores = segments.map(seg => {
    let score = 0
    for (const m of seg) {
      switch (m.kind) {
        case 'ai-tool-use': score += 1; break
        case 'tool-result': score += m.isError ? 3 : 0.5; break
        case 'fork-indicator': score += 5; break
        case 'rollback-marker': score += 5; break
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
