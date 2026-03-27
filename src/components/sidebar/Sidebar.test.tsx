// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Sidebar } from './Sidebar'
import type { ProjectMeta, SessionMeta } from '../../types/session'

afterEach(() => {
  cleanup()
})

function makeSession(
  source: SessionMeta['source'],
  id: string,
  preview: string,
  overrides: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    source,
    id,
    startTime: '2026-03-10T00:00:00.000Z',
    startDisplay: '2026-03-10 08:00',
    promptCount: source === 'claude' ? 1 : 0,
    toolCount: 0,
    firstPromptPreview: preview,
    fileSize: 128,
    recordCount: 4,
    ...overrides,
  }
}

function claudeProject(): ProjectMeta {
  return {
    source: 'claude',
    encodedName: '-Users-test-claude-app',
    decodedName: '/Users/test/claude-app',
    shortName: 'claude-app',
    totalSessionCount: 1,
    sessions: [
      makeSession('claude', 'claude-session', 'Explain the parser architecture'),
    ],
  }
}

function cherryStudioProject(): ProjectMeta {
  return {
    source: 'cherrystudio',
    encodedName: 'cherrystudio:/Users/test/cherry-studio',
    decodedName: '/Users/test/cherry-studio',
    shortName: 'cherry-studio',
    totalSessionCount: 1,
    sessions: [
      makeSession('cherrystudio', 'cherry-session', 'Review the agent workflow'),
    ],
  }
}

function codexProject(): ProjectMeta {
  return {
    source: 'codex',
    encodedName: 'codex:/Users/test/codex-app',
    decodedName: '/Users/test/codex-app',
    shortName: 'codex-app',
    totalSessionCount: 4,
    sessions: [
      makeSession('codex', 'main-task', 'Ship the parser', {
        threadKind: 'primary',
      }),
      makeSession('codex', 'worker-task', 'Inspect scan pipeline', {
        startTime: '2026-03-10T00:01:00.000Z',
        startDisplay: '2026-03-10 08:01',
        threadKind: 'subagent',
        parentSessionId: 'main-task',
        agentName: 'Zeno',
        agentRole: 'worker',
      }),
      makeSession('codex', 'review-task', 'Review the patch', {
        startTime: '2026-03-10T00:02:00.000Z',
        startDisplay: '2026-03-10 08:02',
        threadKind: 'subagent',
        parentSessionId: 'worker-task',
        agentRole: 'reviewer',
      }),
      makeSession('codex', 'detached-task', 'Recover missing context', {
        startTime: '2026-03-09T23:59:00.000Z',
        startDisplay: '2026-03-10 07:59',
        threadKind: 'subagent',
        parentSessionId: 'missing-parent',
        agentRole: 'researcher',
      }),
    ],
  }
}

describe('Sidebar', () => {
  it('uses full source names and descriptive section labels', () => {
    render(
      <Sidebar
        projects={[claudeProject(), codexProject(), cherryStudioProject()]}
        activeSessionId={null}
        activeProjectEncoded={null}
        searchQuery=""
        activeHeatmap={null}
        onSelectSession={vi.fn()}
        onLoadAllSessions={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Claude').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Codex').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Cherry Studio').length).toBeGreaterThan(0)
    expect(screen.getByText('Claude conversations')).toBeTruthy()
    expect(screen.getByText('Codex tasks')).toBeTruthy()
    expect(screen.getByText('Cherry Studio sessions')).toBeTruthy()
    expect(screen.queryByText('CLD')).toBeNull()
    expect(screen.queryByText('CDX')).toBeNull()
  })

  it('renders Codex as compact main-task navigation without flattening delegated work into the sidebar', () => {
    render(
      <Sidebar
        projects={[codexProject()]}
        activeSessionId={null}
        activeProjectEncoded={null}
        searchQuery=""
        activeHeatmap={null}
        onSelectSession={vi.fn()}
        onLoadAllSessions={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('codex-app'))

    expect(screen.getByText('Task map')).toBeTruthy()
    expect(screen.getByText('1 main task')).toBeTruthy()
    expect(screen.getByText((_, element) => element?.textContent === '2 delegated work items')).toBeTruthy()
    expect(screen.getByText((_, element) => element?.textContent === '1 unlinked item')).toBeTruthy()
    expect(screen.getByText('Main task')).toBeTruthy()
    expect(screen.getByText('Ship the parser')).toBeTruthy()
    expect(screen.getByText('These delegated threads do not have their parent task in the currently loaded sessions.')).toBeTruthy()
    expect(screen.queryByText('Inspect scan pipeline')).toBeNull()
    expect(screen.queryByText('Review the patch')).toBeNull()
    expect(screen.getByText('1 delegated branch under this task')).toBeTruthy()
    expect(screen.getByText('This branch is missing its parent task')).toBeTruthy()
  })

  it('preserves the main-task entry when search matches a nested delegated thread', () => {
    render(
      <Sidebar
        projects={[codexProject()]}
        activeSessionId={null}
        activeProjectEncoded={null}
        searchQuery="Review the patch"
        activeHeatmap={null}
        onSelectSession={vi.fn()}
        onLoadAllSessions={vi.fn()}
      />,
    )

    expect(screen.getByText('Ship the parser')).toBeTruthy()
    expect(screen.queryByText('Inspect scan pipeline')).toBeNull()
    expect(screen.queryByText('Review the patch')).toBeNull()
    expect(screen.getByText('Contains a matching branch')).toBeTruthy()
  })

  it('does not claim there is zero delegated work when a Codex project is only partially hydrated', () => {
    render(
      <Sidebar
        projects={[{
          ...codexProject(),
          sessions: [codexProject().sessions[0]],
        }]}
        activeSessionId={null}
        activeProjectEncoded={null}
        searchQuery=""
        activeHeatmap={null}
        onSelectSession={vi.fn()}
        onLoadAllSessions={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('codex-app'))

    expect(screen.getAllByText('Delegated work loads on open')).toHaveLength(2)
    expect(screen.getByText('Delegated work loads when you open this task')).toBeTruthy()
    expect(screen.queryByText((_, element) => element?.textContent === '0 delegated work items')).toBeNull()
  })

  it('allows the active project to stay collapsed until a new project is deliberately selected', () => {
    const onSelectSession = vi.fn()

    const { rerender } = render(
      <Sidebar
        projects={[claudeProject(), codexProject()]}
        activeSessionId="claude-session"
        activeProjectEncoded="-Users-test-claude-app"
        searchQuery=""
        activeHeatmap={null}
        onSelectSession={onSelectSession}
        onLoadAllSessions={vi.fn()}
      />,
    )

    expect(screen.getByText('Explain the parser architecture')).toBeTruthy()

    fireEvent.click(screen.getByText('claude-app'))
    expect(screen.queryByText('Explain the parser architecture')).toBeNull()

    rerender(
      <Sidebar
        projects={[claudeProject(), codexProject()]}
        activeSessionId="claude-session"
        activeProjectEncoded="-Users-test-claude-app"
        searchQuery=""
        activeHeatmap={null}
        onSelectSession={onSelectSession}
        onLoadAllSessions={vi.fn()}
      />,
    )

    expect(screen.queryByText('Explain the parser architecture')).toBeNull()

    fireEvent.click(screen.getByText('codex-app'))
    fireEvent.click(screen.getByText('Ship the parser'))
    expect(onSelectSession).toHaveBeenCalledWith('codex:/Users/test/codex-app', 'main-task')
  })
})
