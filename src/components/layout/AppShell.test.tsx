// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from './AppShell'
import { AppContext, type AppState } from '../../hooks/useSessionStore'

const mockedLoadAllProjectSessions = vi.fn()

vi.mock('../../hooks/useFileLoader', () => ({
  useFileLoader: () => ({
    loadSession: vi.fn(),
    switchDirectory: vi.fn(),
    loadAllProjectSessions: mockedLoadAllProjectSessions,
  }),
}))

afterEach(() => {
  cleanup()
  mockedLoadAllProjectSessions.mockReset()
})

function renderShell(state: AppState) {
  return render(
    <AppContext.Provider value={{ state, dispatch: vi.fn() }}>
      <AppShell />
    </AppContext.Provider>,
  )
}

describe('AppShell', () => {
  it('describes delegated Codex work in task-centric language', () => {
    renderShell({
      projects: [
        {
          source: 'codex',
          encodedName: 'codex:/Users/test/codex-agent-app',
          decodedName: '/Users/test/codex-agent-app',
          shortName: 'codex-agent-app',
          totalSessionCount: 2,
          sessions: [
            {
              source: 'codex',
              id: 'root-session',
              startTime: '2026-03-10T00:00:00.000Z',
              startDisplay: '2026-03-10 08:00',
              promptCount: 1,
              toolCount: 0,
              firstPromptPreview: 'Plan the parser migration',
              fileSize: 128,
              recordCount: 4,
              threadKind: 'primary',
            },
            {
              source: 'codex',
              id: 'agent-session',
              startTime: '2026-03-10T00:01:00.000Z',
              startDisplay: '2026-03-10 08:01',
              promptCount: 0,
              toolCount: 0,
              firstPromptPreview: 'Inspect the current tree model',
              fileSize: 64,
              recordCount: 2,
              threadKind: 'subagent',
              parentSessionId: 'root-session',
              agentName: 'Zeno',
              agentRole: 'research',
            },
          ],
        },
      ],
      activeSessionId: 'agent-session',
      activeProjectEncoded: 'codex:/Users/test/codex-agent-app',
      activeSessionData: null,
      loading: false,
      error: null,
      searchQuery: '',
      fileStore: null,
      filter: {
        thinking: true,
        toolCalls: true,
        toolResults: true,
        aiText: true,
        team: true,
        branches: true,
        markers: true,
        timeline: true,
      },
    })

    expect(screen.getByText('Learning map')).toBeTruthy()
    expect(screen.getAllByText('Plan the parser migration').length).toBeGreaterThan(0)
    expect(screen.getByText('Viewing delegated work')).toBeTruthy()
    expect(screen.getAllByText('Inspect the current tree model').length).toBeGreaterThan(0)
    expect(screen.getByText('Zeno · research')).toBeTruthy()
  })

  it('hydrates the full Codex project session list after selecting a truncated project', () => {
    renderShell({
      projects: [
        {
          source: 'codex',
          encodedName: 'codex:/Users/test/codex-agent-app',
          decodedName: '/Users/test/codex-agent-app',
          shortName: 'codex-agent-app',
          totalSessionCount: 12,
          sessions: [
            {
              source: 'codex',
              id: 'root-session',
              startTime: '2026-03-10T00:00:00.000Z',
              startDisplay: '2026-03-10 08:00',
              promptCount: 1,
              toolCount: 0,
              firstPromptPreview: 'Plan the parser migration',
              fileSize: 128,
              recordCount: 4,
              threadKind: 'primary',
            },
          ],
        },
      ],
      activeSessionId: 'root-session',
      activeProjectEncoded: 'codex:/Users/test/codex-agent-app',
      activeSessionData: {
        source: 'codex',
        messages: [],
        prompts: [],
        heatmap: [],
        markers: { compacts: 0, plans: 0, clears: 0, forks: 0 },
      },
      loading: false,
      error: null,
      searchQuery: '',
      fileStore: null,
      filter: {
        thinking: true,
        toolCalls: true,
        toolResults: true,
        aiText: true,
        team: true,
        branches: true,
        markers: true,
        timeline: true,
      },
    })

    expect(mockedLoadAllProjectSessions).toHaveBeenCalledWith('codex:/Users/test/codex-agent-app')
  })
})
