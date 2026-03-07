import type { SessionMessage, TimelineEvent } from '../types/session'

export function extractTimelineEvents(messages: SessionMessage[]): TimelineEvent[] {
  const events: TimelineEvent[] = []

  for (const msg of messages) {
    switch (msg.kind) {
      case 'user-prompt':
        events.push({
          kind: 'prompt',
          promptNum: msg.promptNum,
          time: msg.time,
          timestampMs: parseTimeToMs(msg.time),
          preview: msg.text.slice(0, 80).replace(/\n/g, ' '),
          decision: msg.decision,
        })
        break

      case 'compact-boundary':
        events.push({
          kind: 'compact',
          time: msg.timestamp,
          timestampMs: parseTimeToMs(msg.timestamp),
          preview: `Context compacted (${formatTokens(msg.preTokens)} tokens)`,
        })
        break

      case 'clear-divider':
        events.push({
          kind: 'clear',
          time: msg.timestamp,
          timestampMs: parseTimeToMs(msg.timestamp),
          preview: 'Context cleared',
        })
        break

      case 'fork-indicator':
        events.push({
          kind: 'fork',
          time: msg.timestamp,
          timestampMs: parseTimeToMs(msg.timestamp),
          preview: `Rewound (${msg.abandonedMessages.length} abandoned)`,
        })
        break

      case 'plan-start':
        events.push({
          kind: 'plan-start',
          time: msg.timestamp,
          timestampMs: parseTimeToMs(msg.timestamp),
          preview: 'Plan mode started',
        })
        break

      case 'plan-end':
        events.push({
          kind: 'plan-end',
          time: msg.timestamp,
          timestampMs: parseTimeToMs(msg.timestamp),
          preview: 'Plan mode ended',
        })
        break
    }
  }

  return events
}

function parseTimeToMs(timeStr: string): number {
  const parts = timeStr.split(':')
  if (parts.length !== 3) return 0
  const [h, m, s] = parts.map(Number)
  return ((h * 60 + m) * 60 + s) * 1000
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function computeTimeGap(a: TimelineEvent, b: TimelineEvent): number {
  const diffMs = b.timestampMs - a.timestampMs
  return Math.max(0, Math.round(diffMs / 1000))
}

export function formatGap(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h${rem}m` : `${h}h`
}
