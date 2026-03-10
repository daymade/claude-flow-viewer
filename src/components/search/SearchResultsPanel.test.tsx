// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SearchResultsPanel } from './SearchResultsPanel'
import type { SearchControllerState } from '../../hooks/useSearchController'
import type { SearchBackendStatus } from '../../lib/fs-access'
import type { SearchResult } from '../../lib/search'

function makeResult(): SearchResult {
  return {
    chunkId: 'project-alpha:session-1:1:ai-text',
    projectEncoded: 'project-alpha',
    projectLabel: '/Users/test/project-alpha',
    projectShortName: 'project-alpha',
    sessionId: 'session-1',
    source: 'claude',
    kind: 'ai-text',
    locator: {
      kind: 'ai-text',
      messageIndex: 1,
    },
    title: 'AI response',
    snippet: 'Use a neon city skyline with rain reflections and amber rim light.',
    matchedText: 'neon city skyline',
    score: 42.5,
    reasons: {
      exactPhrase: 24,
      tokenOverlap: 8,
      trigram: 6,
      semantic: 0,
      kindBoost: 2,
      metadataBoost: 1,
      recency: 1.5,
    },
  }
}

const READY_BACKEND: SearchBackendStatus = {
  available: true,
  backend: 'sqlite',
  dbPath: '/tmp/search.sqlite',
  indexedAt: '2026-03-10T00:00:00.000Z',
  stats: {
    sessionCount: 1,
    chunkCount: 4,
    tokenCount: 16,
    trigramCount: 24,
  },
}

function makeSearchState(overrides: Partial<SearchControllerState> = {}): SearchControllerState {
  return {
    status: 'ready',
    results: [makeResult()],
    error: null,
    activeTarget: null,
    backend: READY_BACKEND,
    ...overrides,
  }
}

describe('SearchResultsPanel', () => {
  it('renders ranked transcript hits and forwards selection', () => {
    const onSelectResult = vi.fn()
    render(
      <SearchResultsPanel
        query="neon skyline"
        search={makeSearchState()}
        onSelectResult={onSelectResult}
      />,
    )

    expect(screen.getByText('AI response · Message 2')).toBeTruthy()
    expect(screen.getByText('Match: neon city skyline')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /AI response/i }))
    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({
      chunkId: 'project-alpha:session-1:1:ai-text',
      sessionId: 'session-1',
    }))
  })

  it('shows server querying progress before results are ready', () => {
    render(
      <SearchResultsPanel
        query="skyline"
        search={makeSearchState({
          status: 'searching',
          results: [],
        })}
        onSelectResult={vi.fn()}
      />,
    )

    expect(screen.getByText('Querying SQLite index')).toBeTruthy()
    expect(screen.getByText('Querying the local SQLite search service.')).toBeTruthy()
  })

  it('shows explicit local-server-required state when backend is unavailable', () => {
    render(
      <SearchResultsPanel
        query="skyline"
        search={makeSearchState({
          status: 'unavailable',
          results: [],
          error: 'Search requires the local server.',
          backend: {
            available: false,
            backend: 'sqlite',
            reason: 'server-required',
            message: 'Search requires the local Node/Vite server API and is unavailable in browser-only file access mode.',
          },
        })}
        onSelectResult={vi.fn()}
      />,
    )

    expect(screen.getByText('Local server required')).toBeTruthy()
    expect(screen.getByText(/browser-only file access mode/i)).toBeTruthy()
  })
})
