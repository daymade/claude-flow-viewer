import { describe, expect, it } from 'vitest'

import type { SessionData, SessionMeta } from '../../types/session'
import { buildCodexTaskInsights } from '../codex-learning'

const session: SessionMeta = {
  source: 'codex',
  id: 'root-session',
  startTime: '2026-03-10T00:00:00.000Z',
  startDisplay: '2026-03-10 08:00',
  promptCount: 1,
  toolCount: 2,
  firstPromptPreview: 'Build the learning map',
  fileSize: 128,
  recordCount: 12,
  threadKind: 'primary',
}

const data: SessionData = {
  source: 'codex',
  prompts: [
    {
      num: 1,
      preview: 'Build the learning map',
      fullText: 'Build the learning map for Codex',
      time: '08:00:00',
      decision: 'none',
    },
  ],
  messages: [
    {
      kind: 'user-prompt',
      promptNum: 1,
      text: 'Build the learning map for Codex',
      images: [],
      time: '08:00:00',
      decision: 'none',
    },
    {
      kind: 'ai-tool-use',
      name: 'spawn_agent',
      summary: 'Agent: Audit the current graph model',
      input: { prompt: 'Audit the current graph model' },
      timestamp: '08:00:10',
    },
    {
      kind: 'delegation-update',
      agentId: 'worker-1',
      status: 'completed',
      summary: 'The delegated audit is complete',
      timestamp: '08:01:00',
    },
    {
      kind: 'ai-tool-use',
      name: 'exec_command',
      summary: '$ npx vitest run',
      input: { cmd: 'npx vitest run' },
      timestamp: '08:01:10',
    },
    {
      kind: 'task-event',
      taskId: 'turn-1',
      status: 'completed',
      summary: 'Finished the learning map',
      timestamp: '08:02:00',
    },
    {
      kind: 'ai-thinking',
      preview: 'Hidden reasoning',
      full: 'Long hidden reasoning',
      timestamp: '08:00:20',
    },
  ],
  heatmap: [0.5],
  markers: {
    compacts: 0,
    plans: 0,
    clears: 0,
    forks: 0,
  },
}

describe('buildCodexTaskInsights', () => {
  it('extracts delegation and completion moments while tracking hidden noise', () => {
    const insights = buildCodexTaskInsights(data, session)

    expect(insights.objective).toBe('Build the learning map for Codex')
    expect(insights.assignedSummary).toBe('Build the learning map for Codex')
    expect(insights.returnedSummary).toBe('Finished the learning map')
    expect(insights.statusLabel).toBe('Completed')
    expect(insights.keyMoments.some((moment) => moment.title === 'Delegated work spawned' && moment.timestamp === '08:00:10')).toBe(true)
    expect(insights.keyMoments.some((moment) => moment.title === 'Delegated work returned' && moment.timestamp === '08:01:00')).toBe(true)
    expect(insights.keyMoments.some((moment) => moment.title === 'Task completed' && moment.timestamp === '08:02:00')).toBe(true)
    expect(insights.hiddenNoise.some((bucket) => bucket.label === 'Internal thinking notes' && bucket.count === 1)).toBe(true)
  })
})
