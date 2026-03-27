// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillRecommendationsPanel } from './SkillRecommendationsPanel'
import type { ClaudeSkillRecommendationsState } from '../../hooks/useClaudeSkillRecommendations'

afterEach(() => {
  cleanup()
})

function makeState(overrides: Partial<ClaudeSkillRecommendationsState> = {}): ClaudeSkillRecommendationsState {
  return {
    status: 'ready',
    error: null,
    contextVersion: 1,
    backend: {
      available: true,
      backend: 'claude-code',
      cliPath: '/usr/local/bin/claude',
      model: 'haiku',
      sessionLimit: 6,
      message: 'Runs an on-demand local Claude Code team analysis over recent session history.',
    },
    analysis: {
      generatedAt: '2026-03-24T10:00:00.000Z',
      backend: 'claude-code',
      model: 'haiku',
      scope: 'smart',
      requestedProjectEncoded: 'codex:/Users/test/bb-browser',
      scopeLabel: 'Smart scope',
      targetLabel: 'bb-browser',
      analyzedSessionCount: 5,
      discussion: [
        { agent: 'scout', point: 'Recent history repeatedly asks for website integration analysis.' },
        { agent: 'skeptic', point: 'Only keep the website-integration pattern because it appears across multiple sessions.' },
        { agent: 'writer', point: 'Frame the skill around recurring site recommendation requests.' },
      ],
      recommendations: [
        {
          id: 'site-recommend',
          name: 'site-recommend',
          title: 'Website integration scout',
          summary: 'Recommend recurring websites that should become integrations.',
          rationale: 'Recent history repeatedly asks for website recommendations tied to GitHub issues and Claude docs.',
          whenToUse: 'Use this when a thread asks which sites or docs should become first-class integrations.',
          steps: ['Read the recent history', 'Extract repeated sites', 'Recommend the strongest candidates'],
          evidence: ['github.com', 'claude.com', 'recent history'],
          confidence: 'high',
        },
      ],
    },
    ...overrides,
  }
}

describe('SkillRecommendationsPanel', () => {
  it('renders actionable skill ideas from recent history analysis', () => {
    render(
      <SkillRecommendationsPanel
        recommendations={makeState()}
        activeProject={{ encodedName: 'codex:/Users/test/bb-browser', shortName: 'bb-browser' }}
        onAnalyze={() => {}}
        onRecheck={() => {}}
      />,
    )

    expect(screen.getByText('Skill ideas')).toBeTruthy()
    expect(screen.getByText('Website integration scout')).toBeTruthy()
    expect(screen.getByText('site-recommend')).toBeTruthy()
    expect(screen.getByText(/Team discussion/i)).toBeTruthy()
    expect(screen.getByText(/Smart scope · bb-browser · 5 sessions/i)).toBeTruthy()
    expect(screen.getByText(/Recent history repeatedly asks for website integration analysis/i)).toBeTruthy()
    expect(screen.getByText(/When to use:/i)).toBeTruthy()
  })

  it('shows on-demand analysis progress while the local Claude team is running', () => {
    render(
      <SkillRecommendationsPanel
        recommendations={makeState({ status: 'analyzing', analysis: null })}
        activeProject={{ encodedName: 'codex:/Users/test/bb-browser', shortName: 'bb-browser' }}
        onAnalyze={() => {}}
        onRecheck={() => {}}
      />,
    )

    expect(screen.getByText('Local Claude team is discussing')).toBeTruthy()
    expect(screen.getByText(/Scout, skeptic, and writer agents/i)).toBeTruthy()
  })

  it('lets the user choose a scope before triggering analysis', () => {
    const onAnalyze = vi.fn()
    render(
      <SkillRecommendationsPanel
        recommendations={makeState({ analysis: null })}
        activeProject={{ encodedName: 'codex:/Users/test/bb-browser', shortName: 'bb-browser' }}
        onAnalyze={onAnalyze}
        onRecheck={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /this project/i }))
    fireEvent.click(screen.getByRole('button', { name: /analyze with local claude/i }))

    expect(onAnalyze).toHaveBeenCalledWith({
      scope: 'project',
      projectEncoded: 'codex:/Users/test/bb-browser',
    })
  })

  it('hides stale results when the selected scope no longer matches the last run', () => {
    render(
      <SkillRecommendationsPanel
        recommendations={makeState()}
        activeProject={{ encodedName: 'codex:/Users/test/bb-browser', shortName: 'bb-browser' }}
        onAnalyze={() => {}}
        onRecheck={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /recent all/i }))

    expect(screen.getByText(/Selection changed/i)).toBeTruthy()
    expect(screen.getByText(/Re-run analysis to refresh the results/i)).toBeTruthy()
    expect(screen.queryByText(/Team discussion/i)).toBeNull()
  })

  it('lets the user recheck readiness from the unavailable state', () => {
    const onRecheck = vi.fn()
    render(
      <SkillRecommendationsPanel
        recommendations={makeState({
          status: 'unavailable',
          analysis: null,
          backend: {
            available: false,
            backend: 'claude-code',
            reason: 'not-ready',
            message: 'Local Claude Code is installed but not logged in for non-interactive analysis.',
          },
        })}
        activeProject={{ encodedName: 'codex:/Users/test/bb-browser', shortName: 'bb-browser' }}
        onAnalyze={() => {}}
        onRecheck={onRecheck}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /check local claude again/i }))
    expect(onRecheck).toHaveBeenCalled()
  })
})
