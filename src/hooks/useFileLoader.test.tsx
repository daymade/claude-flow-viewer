// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'

import { AppContext, initialState, type AppState } from './useSessionStore'
import { useFileLoader } from './useFileLoader'
import { parseFetchedSessionContent } from '../lib/parser'
import { openDirectoryPicker, tryAutoLoad } from '../lib/fs-access'
import type { SessionData } from '../types/session'

vi.mock('../lib/fs-access', () => ({
  openDirectoryPicker: vi.fn(),
  createStoreFromFiles: vi.fn(),
  createStoreFromHandle: vi.fn(),
  tryAutoLoad: vi.fn(),
  getCherryStudioBrowserModeNotice: () => 'Cherry Studio sessions are unavailable in browser-only file access mode because the browser/manual store cannot read the local agents.db database. Use npm run dev or npm run preview to load Cherry Studio sessions through the local Node/Vite API.',
}))

vi.mock('../lib/parser', () => ({
  parseFetchedSessionContent: vi.fn(),
}))

const mockedParseSessionContent = vi.mocked(parseFetchedSessionContent)

afterEach(() => {
  vi.clearAllMocks()
  window.location.hash = ''
})

function createParsedData(source: SessionData['source']): SessionData {
  return {
    source,
    messages: [],
    prompts: [],
    heatmap: [],
    markers: { compacts: 0, plans: 0, clears: 0, forks: 0 },
  }
}

describe('useFileLoader', () => {
  it('passes the project source into parseFetchedSessionContent when loading a session', async () => {
    const readSessionContent = vi.fn().mockResolvedValue('{"type":"session_meta"}')
    const dispatch = vi.fn()
    const data = createParsedData('codex')
    mockedParseSessionContent.mockReturnValue(data)

    const state: AppState = {
      ...initialState,
      projects: [
        {
          source: 'codex',
          encodedName: 'codex:/Users/test/demo',
          decodedName: '/Users/test/demo',
          shortName: 'demo',
          totalSessionCount: 1,
          sessions: [
            {
              source: 'codex',
              id: 'session-1',
              startTime: '2026-03-10T00:00:00.000Z',
              startDisplay: '2026-03-10 08:00',
              promptCount: 0,
              toolCount: 0,
              firstPromptPreview: 'Preview',
              fileSize: 256,
              recordCount: 0,
            },
          ],
        },
      ],
      fileStore: {
        scanProjects: vi.fn(),
        readSessionContent,
        scanAllProjectSessions: vi.fn(),
        readToolResult: vi.fn(),
        searchSessions: vi.fn(),
        getSearchBackendStatus: vi.fn(),
        analyzeSkillRecommendations: vi.fn(),
        getSkillRecommendationBackendStatus: vi.fn(),
      },
    }

    const historySpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppContext.Provider value={{ state, dispatch }}>
        {children}
      </AppContext.Provider>
    )

    const { result } = renderHook(() => useFileLoader(), { wrapper })

    await act(async () => {
      await result.current.loadSession('codex:/Users/test/demo', 'session-1')
    })

    expect(readSessionContent).toHaveBeenCalledWith('codex:/Users/test/demo', 'session-1')
    expect(mockedParseSessionContent).toHaveBeenCalledWith('{"type":"session_meta"}', 'codex')
    expect(dispatch).toHaveBeenCalledWith({
      type: 'LOAD_SESSION',
      sessionId: 'session-1',
      projectEncoded: 'codex:/Users/test/demo',
      data,
    })
    expect(historySpy).toHaveBeenCalled()
  })

  it('passes the Cherry Studio source into parseFetchedSessionContent when loading a session', async () => {
    const readSessionContent = vi.fn().mockResolvedValue('{"type":"session_meta"}')
    const dispatch = vi.fn()
    const data = createParsedData('cherrystudio')
    mockedParseSessionContent.mockReturnValue(data)

    const state: AppState = {
      ...initialState,
      projects: [
        {
          source: 'cherrystudio',
          encodedName: 'cherrystudio:/Users/test/demo',
          decodedName: '/Users/test/demo',
          shortName: 'demo',
          totalSessionCount: 1,
          sessions: [
            {
              source: 'cherrystudio',
              id: 'session-1',
              startTime: '2026-03-10T00:00:00.000Z',
              startDisplay: '2026-03-10 08:00',
              promptCount: 0,
              toolCount: 0,
              firstPromptPreview: 'Preview',
              fileSize: 256,
              recordCount: 0,
            },
          ],
        },
      ],
      fileStore: {
        scanProjects: vi.fn(),
        readSessionContent,
        scanAllProjectSessions: vi.fn(),
        readToolResult: vi.fn(),
        searchSessions: vi.fn(),
        getSearchBackendStatus: vi.fn(),
        analyzeSkillRecommendations: vi.fn(),
        getSkillRecommendationBackendStatus: vi.fn(),
      },
    }

    const historySpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppContext.Provider value={{ state, dispatch }}>
        {children}
      </AppContext.Provider>
    )

    const { result } = renderHook(() => useFileLoader(), { wrapper })

    await act(async () => {
      await result.current.loadSession('cherrystudio:/Users/test/demo', 'session-1')
    })

    expect(readSessionContent).toHaveBeenCalledWith('cherrystudio:/Users/test/demo', 'session-1')
    expect(mockedParseSessionContent).toHaveBeenCalledWith('{"type":"session_meta"}', 'cherrystudio')
    expect(dispatch).toHaveBeenCalledWith({
      type: 'LOAD_SESSION',
      sessionId: 'session-1',
      projectEncoded: 'cherrystudio:/Users/test/demo',
      data,
    })
    expect(historySpy).toHaveBeenCalled()
  })

  it('surfaces the Cherry Studio browser-only boundary during manual directory loading', async () => {
    const boundaryMessage = 'Cherry Studio sessions are unavailable in browser-only file access mode because the browser/manual store cannot read the local agents.db database. Use npm run dev or npm run preview to load Cherry Studio sessions through the local Node/Vite API.'
    const dispatch = vi.fn()
    const store = {
      scanProjects: vi.fn().mockResolvedValue([]),
      readSessionContent: vi.fn(),
      scanAllProjectSessions: vi.fn(),
      readToolResult: vi.fn(),
      searchSessions: vi.fn(),
      getSearchBackendStatus: vi.fn(),
      analyzeSkillRecommendations: vi.fn(),
      getSkillRecommendationBackendStatus: vi.fn(),
      getBrowserModeNotice: vi.fn().mockResolvedValue(boundaryMessage),
    }

    vi.mocked(tryAutoLoad).mockResolvedValue(null)
    vi.mocked(openDirectoryPicker).mockResolvedValue(store as never)

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppContext.Provider value={{ state: initialState, dispatch }}>
        {children}
      </AppContext.Provider>
    )

    const { result } = renderHook(() => useFileLoader(), { wrapper })

    await act(async () => {
      await result.current.switchDirectory()
    })

    expect(store.scanProjects).toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith({ type: 'LOAD_PROJECTS', projects: [], fileStore: store })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ERROR', error: boundaryMessage })
  })
})
