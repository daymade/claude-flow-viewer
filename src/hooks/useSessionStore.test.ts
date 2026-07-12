import { describe, it, expect } from 'vitest'
import { reducer, initialState } from './useSessionStore'
import type { AppState } from './useSessionStore'
import type { ProjectMeta, SessionMeta, ResolvedSessionRef } from '../types/session'

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

function project(encodedName: string, sessions: SessionMeta[]): ProjectMeta {
  return {
    source: 'claude',
    encodedName,
    decodedName: encodedName,
    shortName: encodedName,
    sessions,
    totalSessionCount: sessions.length,
  }
}

function stateWith(projects: ProjectMeta[]): AppState {
  return { ...initialState, projects }
}

describe('UPSERT_SESSION_META', () => {
  it('injects a newer resolved session at the correct (front) position', () => {
    const state = stateWith([project('proj-a', [meta('s2', '2026-03-10T02:00:00Z')])])
    const ref: ResolvedSessionRef = { source: 'claude', projectEncoded: 'proj-a', sessionId: 's3', meta: meta('s3', '2026-03-10T03:00:00Z') }
    const next = reducer(state, { type: 'UPSERT_SESSION_META', ref })
    expect(next.projects[0].sessions.map(s => s.id)).toEqual(['s3', 's2'])
  })

  it('inserts an OLD beyond-cap session in startTime order, not blindly on top', () => {
    const state = stateWith([project('proj-a', [meta('s2', '2026-03-10T02:00:00Z')])])
    const ref: ResolvedSessionRef = { source: 'claude', projectEncoded: 'proj-a', sessionId: 's1', meta: meta('s1', '2026-03-10T01:00:00Z') }
    const next = reducer(state, { type: 'UPSERT_SESSION_META', ref })
    // s1 is older → must sort AFTER s2, not appear as the "latest" on top.
    expect(next.projects[0].sessions.map(s => s.id)).toEqual(['s2', 's1'])
  })

  it('preserves totalSessionCount (does not shrink the beyond-cap total)', () => {
    const proj = { ...project('proj-a', [meta('s2', '2026-03-10T02:00:00Z')]), totalSessionCount: 82 }
    const ref: ResolvedSessionRef = { source: 'claude', projectEncoded: 'proj-a', sessionId: 's3', meta: meta('s3', '2026-03-10T03:00:00Z') }
    const next = reducer(stateWith([proj]), { type: 'UPSERT_SESSION_META', ref })
    expect(next.projects[0].totalSessionCount).toBe(82)
  })

  it('synthesizes a meta when the resolver returned none, so the session still injects', () => {
    const state = stateWith([project('proj-a', [meta('s2', '2026-03-10T02:00:00Z')])])
    const ref: ResolvedSessionRef = { source: 'claude', projectEncoded: 'proj-a', sessionId: 's9' } // no meta
    const next = reducer(state, { type: 'UPSERT_SESSION_META', ref })
    const injected = next.projects[0].sessions.find(s => s.id === 's9')
    expect(injected).toBeTruthy()
    expect(injected?.source).toBe('claude')
    expect(injected?.id).toBe('s9')
  })

  it('is a no-op when the session already exists in the list', () => {
    const state = stateWith([project('proj-a', [meta('s2', '2026-03-10T02:00:00Z')])])
    const ref: ResolvedSessionRef = { source: 'claude', projectEncoded: 'proj-a', sessionId: 's2', meta: meta('s2', '2026-03-10T02:00:00Z') }
    const next = reducer(state, { type: 'UPSERT_SESSION_META', ref })
    expect(next).toBe(state)
  })

  it('creates a minimal project with a decoded Claude name when the project is absent from the scan', () => {
    const ref: ResolvedSessionRef = { source: 'claude', projectEncoded: '-Users-me-proj', sessionId: 's1', meta: meta('s1', '2026-03-10T01:00:00Z') }
    const next = reducer(stateWith([]), { type: 'UPSERT_SESSION_META', ref })
    expect(next.projects).toHaveLength(1)
    expect(next.projects[0].encodedName).toBe('-Users-me-proj')
    // decodeProjectName expands the leading-dash encoding back into a real path.
    expect(next.projects[0].decodedName).toContain('/')
  })
})

describe('EXPAND_PROJECT_SESSIONS', () => {
  it('preserves the active resolve-injected session the full scan cannot see', () => {
    const injected = meta('beyond-cap', '2026-03-10T05:00:00Z')
    const state: AppState = {
      ...stateWith([project('proj-a', [injected, meta('s1', '2026-03-10T01:00:00Z')])]),
      activeSessionId: 'beyond-cap',
    }
    // A 4KB-head full scan returns only s1 + s2, NOT the beyond-cap active session.
    const scanned = [meta('s1', '2026-03-10T01:00:00Z'), meta('s2', '2026-03-10T02:00:00Z')]
    const next = reducer(state, { type: 'EXPAND_PROJECT_SESSIONS', projectEncoded: 'proj-a', sessions: scanned })
    const ids = next.projects[0].sessions.map(s => s.id)
    expect(ids).toContain('beyond-cap')
    expect(ids).toContain('s1')
    expect(ids).toContain('s2')
  })

  it('uses the scan list verbatim when the active session is included in the scan', () => {
    const state: AppState = {
      ...stateWith([project('proj-a', [meta('s1', '2026-03-10T01:00:00Z')])]),
      activeSessionId: 's1',
    }
    // scanAllProjectSessions already returns a sorted list; EXPAND uses it as-is.
    const scanned = [meta('s2', '2026-03-10T02:00:00Z'), meta('s1', '2026-03-10T01:00:00Z')]
    const next = reducer(state, { type: 'EXPAND_PROJECT_SESSIONS', projectEncoded: 'proj-a', sessions: scanned })
    expect(next.projects[0].sessions.map(s => s.id)).toEqual(['s2', 's1'])
  })
})
