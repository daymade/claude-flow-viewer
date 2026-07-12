// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexWorkspaceView } from './CodexWorkspaceView'
import type { FilterState, ProjectMeta, SessionData, SessionMeta } from '../../types/session'

afterEach(() => {
  cleanup()
})

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

Object.assign(globalThis, {
  ResizeObserver: ResizeObserverMock,
  IntersectionObserver: IntersectionObserverMock,
})

const filter: FilterState = {
  thinking: true,
  toolCalls: true,
  toolResults: true,
  aiText: true,
  team: true,
  branches: true,
  markers: true,
  timeline: true,
}

const project: ProjectMeta = {
  source: 'codex',
  encodedName: 'codex:/Users/test/claude-flow-viewer',
  decodedName: '/Users/test/claude-flow-viewer',
  shortName: 'claude-flow-viewer',
  totalSessionCount: 2,
  sessions: [
    {
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
    },
    {
      source: 'codex',
      id: 'child-session',
      startTime: '2026-03-10T00:01:00.000Z',
      startDisplay: '2026-03-10 08:01',
      promptCount: 0,
      toolCount: 1,
      firstPromptPreview: 'Inspect the current graph model',
      fileSize: 64,
      recordCount: 6,
      threadKind: 'subagent',
      parentSessionId: 'root-session',
      agentName: 'Hooke',
      agentRole: 'research',
    },
  ],
}

const activeSession: SessionMeta = project.sessions[0]

const activeSessionData: SessionData = {
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
      kind: 'task-event',
      taskId: 'turn-1',
      status: 'completed',
      summary: 'Finished the learning map',
      timestamp: '08:02:00',
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

describe('CodexWorkspaceView', () => {
  it('starts with the readable conversation surface', () => {
    const fileStore = {
      readSessionContent: vi.fn().mockResolvedValue([
        JSON.stringify({
          timestamp: '2026-03-10T00:01:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'child-session',
            timestamp: '2026-03-10T00:01:00.000Z',
            cwd: '/Users/test/claude-flow-viewer',
            forked_from_id: 'root-session',
            agent_nickname: 'Hooke',
            agent_role: 'research',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-10T00:01:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Audit the current graph model' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-10T00:01:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-child',
            last_agent_message: 'Reported the graph audit back to the parent thread',
          },
        }),
      ].join('\n')),
    }

    render(
      <CodexWorkspaceView
        project={project}
        activeSession={activeSession}
        activeSessionData={activeSessionData}
        filter={filter}
        searchQuery=""
        fileStore={fileStore as never}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Conversation').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Build the learning map for Codex')).toHaveLength(1)
    expect(screen.getAllByText('#1').length).toBeGreaterThan(0)
    expect(screen.queryByText('Agent: Audit the current graph model')).toBeNull()
    expect(screen.queryByText('Task started')).toBeNull()
    expect(document.querySelector('[class*="w-[72px]"]')).toBeNull()
    expect(screen.queryByText('Hidden by default')).toBeNull()
    expect(screen.queryByText('What happened in the main task')).toBeNull()
    expect(document.querySelector('[data-export-snapshot]')).toBeNull()
  })

  it('keeps the Codex task structure available as a secondary view', async () => {
    render(
      <CodexWorkspaceView
        project={project}
        activeSession={activeSession}
        activeSessionData={activeSessionData}
        filter={filter}
        searchQuery=""
        fileStore={null}
        onSelectSession={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))

    expect(screen.getAllByText('Task graph').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Delegated branches').length).toBeGreaterThan(0)
  })

  it('shows that the delegated task map is still hydrating when only root sessions are loaded', () => {
    render(
      <CodexWorkspaceView
        project={{ ...project, totalSessionCount: 12, sessions: [project.sessions[0]] }}
        activeSession={activeSession}
        activeSessionData={activeSessionData}
        filter={filter}
        searchQuery=""
        fileStore={null}
        onSelectSession={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))

    expect(screen.getAllByText('Loading the full delegated task map for this project...').length).toBeGreaterThan(0)
  })

  it('returns to conversation when the active Codex session changes', async () => {
    const { rerender } = render(
      <CodexWorkspaceView
        project={project}
        activeSession={activeSession}
        activeSessionData={activeSessionData}
        filter={filter}
        searchQuery=""
        fileStore={null}
        onSelectSession={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Structure' }))
    expect(screen.getAllByText('Task graph').length).toBeGreaterThan(0)

    rerender(
      <CodexWorkspaceView
        project={project}
        activeSession={project.sessions[1]}
        activeSessionData={activeSessionData}
        filter={filter}
        searchQuery=""
        fileStore={null}
        onSelectSession={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('Task graph')).toBeNull()
    })
    expect(screen.getAllByText('Build the learning map for Codex')).toHaveLength(1)
  })
})
