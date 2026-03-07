import type { DecisionMarker } from '../types/session'

const CORRECTION_KEYWORDS = [
  'no ', 'not ', 'wrong', 'stop', "don't", 'instead',
  'actually', 'wait', 'cancel',
]

export function detectDecision(text: string, promptNum: number): DecisionMarker {
  if (text.includes('[Request interrupted by user]')) return 'interrupt'
  if (promptNum > 1) {
    const lower = text.toLowerCase()
    if (CORRECTION_KEYWORDS.some(kw => lower.includes(kw))) return 'correction'
  }
  return 'none'
}
