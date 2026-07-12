import { describe, it, expect } from 'vitest'
import { planInitialNavigation } from '../initial-navigation'
import type { ProjectMeta, SessionMeta, SessionSource } from '../../types/session'

function meta(id: string, startTime: string): SessionMeta {
  return {
    source: 'claude',
    id,
    startTime,
    startDisplay: startTime,
    promptCount: 1,
    toolCount: 0,
    firstPromptPreview: id,
    fileSize: 100,
    recordCount: 2,
  }
}

function project(encodedName: string, source: SessionSource, sessions: SessionMeta[]): ProjectMeta {
  return {
    source,
    encodedName,
    decodedName: encodedName,
    shortName: encodedName,
    sessions,
    totalSessionCount: sessions.length,
  }
}

describe('planInitialNavigation', () => {
  const projects = [
    project('proj-a', 'claude', [meta('s1', '2026-03-10T01:00:00Z'), meta('s2', '2026-03-10T02:00:00Z')]),
    project('proj-b', 'claude', [meta('s3', '2026-03-10T03:00:00Z')]),
  ]

  it('returns a listed plan when the hash points to a scanned session', () => {
    expect(planInitialNavigation(projects, { projectEncoded: 'proj-a', sessionId: 's1' })).toEqual({
      kind: 'listed',
      projectEncoded: 'proj-a',
      sessionId: 's1',
      source: 'claude',
    })
  })

  it('returns a deep-link plan when the hash session is absent from the scanned list (beyond the 50-cap)', () => {
    expect(planInitialNavigation(projects, { projectEncoded: 'proj-a', sessionId: 'old-session-999' })).toEqual({
      kind: 'deep-link',
      projectEncoded: 'proj-a',
      sessionId: 'old-session-999',
    })
  })

  it('returns a deep-link plan when the hash project is not scanned at all', () => {
    expect(planInitialNavigation(projects, { projectEncoded: 'unknown-proj', sessionId: 'x' })).toEqual({
      kind: 'deep-link',
      projectEncoded: 'unknown-proj',
      sessionId: 'x',
    })
  })

  it('falls back to the most recent session when there is no hash', () => {
    const plan = planInitialNavigation(projects, null)
    expect(plan?.kind).toBe('recent')
    expect(plan).toMatchObject({ projectEncoded: 'proj-b', sessionId: 's3' })
  })

  it('returns null when there is nothing to open', () => {
    expect(planInitialNavigation([], null)).toBeNull()
  })
})
