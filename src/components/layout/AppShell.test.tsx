// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from './AppShell'
import { AppContext, type AppState } from '../../hooks/useSessionStore'

const mockedLoadAllProjectSessions = vi.fn()
const mockedAnalyze = vi.fn()

vi.mock('../../hooks/useFileLoader', () => ({
  useFileLoader: () => ({
    loadSession: vi.fn(),
    switchDirectory: vi.fn(),
    loadAllProjectSessions: mockedLoadAllProjectSessions,
  }),
}))

vi.mock('../../hooks/useClaudeSkillRecommendations', () => ({
  useClaudeSkillRecommendations: ({ fileStore }: { fileStore: unknown }) => ({
    recommendations: {
      status: 'ready',
      analysis: null,
      error: null,
      contextVersion: fileStore && typeof fileStore === 'object' && 'id' in (fileStore as Record<string, unknown>) && (fileStore as Record<string, unknown>).id === 'two' ? 2 : 1,
      backend: {
        available: true,
        backend: 'claude-code',
        cliPath: '/usr/local/bin/claude',
        model: 'haiku',
        sessionLimit: 6,
        message: 'Runs an on-demand local Claude Code team analysis over recent session history.',
      },
    },
    analyze: mockedAnalyze,
    recheck: vi.fn(),
  }),
}))

vi.mock('../../hooks/useSearchController', () => ({
  useSearchController: () => ({
    search: {
      status: 'idle',
      results: [],
      error: null,
      activeTarget: null,
      backend: null,
    },
    selectResult: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  mockedLoadAllProjectSessions.mockReset()
  mockedAnalyze.mockReset()
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

    expect(screen.getByText('Task workspace')).toBeTruthy()
    expect(screen.getAllByText('Plan the parser migration').length).toBeGreaterThan(0)
    expect(screen.getByText('Viewing delegated work')).toBeTruthy()
    expect(screen.getAllByText('Inspect the current tree model').length).toBeGreaterThan(0)
    expect(screen.getByText('Zeno · research')).toBeTruthy()
    expect(screen.getByTitle('Export current session as standalone HTML')).toBeTruthy()
    expect(screen.getByTitle('Open print preview for the current session snapshot')).toBeTruthy()
    expect(screen.getByTitle('Create a read-only share link from this snapshot')).toBeTruthy()
  })

  it('shows Cherry Studio as a session source in the header copy', () => {
    renderShell({
      projects: [
        {
          source: 'cherrystudio',
          encodedName: 'cherrystudio:/Users/test/cherry-studio',
          decodedName: '/Users/test/cherry-studio',
          shortName: 'cherry-studio',
          totalSessionCount: 1,
          sessions: [
            {
              source: 'cherrystudio',
              id: 'cherry-session',
              startTime: '2026-03-10T00:00:00.000Z',
              startDisplay: '2026-03-10 08:00',
              promptCount: 1,
              toolCount: 0,
              firstPromptPreview: 'Review the agent workflow',
              fileSize: 128,
              recordCount: 4,
            },
          ],
        },
      ],
      activeSessionId: 'cherry-session',
      activeProjectEncoded: 'cherrystudio:/Users/test/cherry-studio',
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

    expect(screen.getAllByText('Cherry Studio').length).toBeGreaterThan(0)
    expect(screen.getByText('Session view')).toBeTruthy()
    expect(screen.getAllByText('cherry-studio').length).toBeGreaterThan(0)
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

  it('keeps keyboard paging active after a Codex tab button receives focus', () => {
    renderShell({
      projects: [
        {
          source: 'codex',
          encodedName: 'codex:/Users/test/codex-agent-app',
          decodedName: '/Users/test/codex-agent-app',
          shortName: 'codex-agent-app',
          totalSessionCount: 1,
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
        prompts: [
          {
            num: 1,
            preview: 'Plan the parser migration',
            fullText: 'Plan the parser migration',
            time: '08:00:00',
            decision: 'none',
          },
        ],
        messages: [
          {
            kind: 'user-prompt',
            promptNum: 1,
            text: 'Plan the parser migration',
            images: [],
            time: '08:00:00',
            decision: 'none',
          },
        ],
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

    const structureButton = screen.getByRole('button', { name: 'Structure' })
    fireEvent.click(structureButton)

    const scroller = document.querySelector('[data-primary-scroll]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo

    fireEvent.keyDown(structureButton, { key: 'PageDown' })

    expect(scrollTo).toHaveBeenCalledWith({ top: 340, behavior: 'smooth' })
  })

  it('resets scope selection when the store changes even if the active project key stays the same', () => {
    const state = {
      projects: [
        {
          source: 'claude' as const,
          encodedName: '-Users-test-claude-project',
          decodedName: '/Users/test/claude-project',
          shortName: 'claude-project',
          totalSessionCount: 1,
          sessions: [
            {
              source: 'claude' as const,
              id: 'root-session',
              startTime: '2026-03-10T00:00:00.000Z',
              startDisplay: '2026-03-10 08:00',
              promptCount: 1,
              toolCount: 0,
              firstPromptPreview: 'Plan the parser migration',
              fileSize: 128,
              recordCount: 4,
            },
          ],
        },
      ],
      activeSessionId: 'root-session',
      activeProjectEncoded: '-Users-test-claude-project',
      activeSessionData: {
        source: 'claude' as const,
        messages: [],
        prompts: [],
        heatmap: [],
        markers: { compacts: 0, plans: 0, clears: 0, forks: 0 },
      },
      loading: false,
      error: null,
      searchQuery: '',
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
    }

    const { rerender } = render(
      <AppContext.Provider value={{ state: { ...state, fileStore: { id: 'one' } as never }, dispatch: vi.fn() }}>
        <AppShell />
      </AppContext.Provider>,
    )

    // The idle Skill ideas promo starts collapsed; expand it before choosing a scope.
    fireEvent.click(screen.getByRole('button', { name: /skill ideas/i }))
    fireEvent.click(screen.getByRole('button', { name: /this project/i }))
    fireEvent.click(screen.getByRole('button', { name: /analyze with local claude/i }))

    expect(mockedAnalyze).toHaveBeenLastCalledWith({
      scope: 'project',
      projectEncoded: '-Users-test-claude-project',
    })

    rerender(
      <AppContext.Provider value={{ state: { ...state, fileStore: { id: 'two' } as never }, dispatch: vi.fn() }}>
        <AppShell />
      </AppContext.Provider>,
    )

    // The store change remounts the panel (resetting scope to smart and re-collapsing it),
    // so expand again before re-triggering analysis.
    fireEvent.click(screen.getByRole('button', { name: /skill ideas/i }))
    fireEvent.click(screen.getByRole('button', { name: /analyze with local claude/i }))

    expect(mockedAnalyze).toHaveBeenLastCalledWith({
      scope: 'smart',
      projectEncoded: '-Users-test-claude-project',
    })
  })
})
