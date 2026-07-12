import { describe, expect, it } from 'vitest'

import { computeHeatmap } from '../heatmap'
import type { SessionMessage } from '../../types/session'

const prompt = (promptNum: number, text = 'p'): SessionMessage =>
  ({ kind: 'user-prompt', promptNum, text, images: [], time: '10:00', decision: 'none' })
const tool = (): SessionMessage => ({ kind: 'ai-tool-use', summary: 's', name: 'Bash', input: {} })
const errorResult = (): SessionMessage => ({ kind: 'tool-result', content: 'boom', isError: true })
const aiText = (): SessionMessage => ({ kind: 'ai-text', text: 'hi' })

describe('computeHeatmap', () => {
  it('returns exactly one score per numbered prompt', () => {
    expect(computeHeatmap([prompt(1), tool(), prompt(2), tool(), prompt(3)])).toHaveLength(3)
  })

  // Regression guard. Abandoned fork-branch prompts are pushed into `messages` with
  // `promptNum: 0` but are NOT added to `SessionData.prompts`. If they opened their own
  // segment, heatmap would be longer than prompts and every index after the first fork
  // would shift — painting each prompt's intensity onto the wrong row, silently.
  it('does not let abandoned fork-branch prompts (promptNum 0) shift the alignment', () => {
    const messages = [
      prompt(1), tool(),
      prompt(0, 'abandoned branch'), tool(), // must fold into prompt 1's segment
      prompt(2), tool(),
    ]
    expect(computeHeatmap(messages)).toHaveLength(2) // one per NUMBERED prompt, not 3
  })

  it('ignores messages before the first numbered prompt', () => {
    expect(computeHeatmap([aiText(), tool(), prompt(1), tool()])).toHaveLength(1)
  })

  it('scores a busy turn higher than a quiet one, normalized to 0..1', () => {
    const [quiet, busy] = computeHeatmap([
      prompt(1),
      prompt(2), tool(), tool(), errorResult(),
    ])
    expect(busy).toBeGreaterThan(quiet)
    expect(busy).toBeLessThanOrEqual(1)
    expect(quiet).toBeGreaterThanOrEqual(0)
  })

  it('returns an empty array when there is no numbered prompt', () => {
    expect(computeHeatmap([aiText(), tool()])).toEqual([])
  })
})
