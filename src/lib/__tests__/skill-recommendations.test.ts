import { describe, expect, it } from 'vitest'

import type { SearchSessionRecord } from '../search'
import { buildSkillRecommendationSessionDossier } from '../skill-recommendations'

const session: SearchSessionRecord = {
  projectEncoded: 'codex:/Users/test/bb-browser',
  projectLabel: '/Users/test/bb-browser',
  projectShortName: 'bb-browser',
  meta: {
    source: 'codex',
    id: 'session-1',
    startTime: '2026-03-24T10:00:00.000Z',
    startDisplay: '2026-03-24 18:00',
    promptCount: 1,
    toolCount: 2,
    firstPromptPreview: 'Analyze recent history and recommend which websites should become integrations.',
    fileSize: 256,
    recordCount: 8,
    threadKind: 'primary',
  },
  data: {
    source: 'codex',
    prompts: [
      {
        num: 1,
        preview: 'Analyze recent history',
        fullText: 'Analyze recent history and recommend websites from https://github.com/epiral/bb-browser/issues/23 and https://claude.com/resources/tutorials .',
        time: '10:00:00',
        decision: 'none',
      },
    ],
    messages: [
      {
        kind: 'user-prompt',
        promptNum: 1,
        text: 'Analyze recent history and recommend websites from https://github.com/epiral/bb-browser/issues/23 and https://claude.com/resources/tutorials .',
        images: [],
        time: '10:00:00',
        decision: 'none',
      },
      {
        kind: 'ai-tool-use',
        name: 'web_search_call',
        summary: 'Search the linked docs and sites',
        input: { query: 'bb-browser integration ideas' },
        timestamp: '10:00:05',
      },
      {
        kind: 'delegation-update',
        agentId: 'worker-1',
        status: 'completed',
        summary: 'Returned candidate websites and docs.',
        timestamp: '10:00:30',
      },
      {
        kind: 'task-event',
        taskId: 'task-1',
        status: 'completed',
        summary: 'Recommended which sites should become integrations.',
        timestamp: '10:01:00',
      },
    ],
    heatmap: [0.4],
    markers: {
      compacts: 0,
      plans: 0,
      clears: 0,
      forks: 0,
    },
  },
}

describe('buildSkillRecommendationSessionDossier', () => {
  it('compresses parsed sessions into Claude-analysis dossiers without heuristic classification', () => {
    const dossier = buildSkillRecommendationSessionDossier(session)

    expect(dossier.projectShortName).toBe('bb-browser')
    expect(dossier.tools).toContain('web_search_call')
    expect(dossier.domains).toEqual(expect.arrayContaining(['github.com', 'claude.com']))
    expect(dossier.excerpts.some((excerpt) => excerpt.kind === 'prompt')).toBe(true)
    expect(dossier.excerpts.some((excerpt) => excerpt.kind === 'delegation-update')).toBe(true)
    expect(dossier.excerpts.some((excerpt) => excerpt.kind === 'task-event')).toBe(true)
  })
})
