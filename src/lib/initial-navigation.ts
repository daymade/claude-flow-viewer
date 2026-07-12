import { buildCodexThreadForest } from './codex-navigation'
import type { ProjectMeta, SessionSource } from '../types/session'

/** What to open on first load, decided purely from the scanned projects + the URL hash. */
export type InitialNavPlan =
  | { kind: 'listed'; projectEncoded: string; sessionId: string; source: SessionSource }
  | { kind: 'deep-link'; projectEncoded: string; sessionId: string }
  | { kind: 'recent'; projectEncoded: string; sessionId: string; source: SessionSource }

function resolveProjectEntry(project: ProjectMeta): { sessionId: string; activityTime: string } | null {
  if (project.source === 'codex') {
    const latestRoot = buildCodexThreadForest(project.sessions)[0]
    if (latestRoot) {
      return {
        sessionId: latestRoot.session.id,
        activityTime: latestRoot.latestActivityTime,
      }
    }
  }

  const latestSession = project.sessions[0]
  if (!latestSession) return null

  return {
    sessionId: latestSession.id,
    activityTime: latestSession.startTime,
  }
}

/** The most-recent-session fallback, shared by the initial plan and the deep-link miss path. */
export function mostRecentSession(projects: ProjectMeta[]): Extract<InitialNavPlan, { kind: 'recent' }> | null {
  let target: { projectEncoded: string; sessionId: string; source: SessionSource; activityTime: string } | null = null
  for (const project of projects) {
    const entry = resolveProjectEntry(project)
    if (!entry) continue
    if (!target || entry.activityTime.localeCompare(target.activityTime) > 0) {
      target = {
        projectEncoded: project.encodedName,
        sessionId: entry.sessionId,
        source: project.source,
        activityTime: entry.activityTime,
      }
    }
  }
  if (!target) return null
  return { kind: 'recent', projectEncoded: target.projectEncoded, sessionId: target.sessionId, source: target.source }
}

/**
 * Decide what to open on first load. A hash that points to a session NOT in the scanned list
 * (e.g. beyond the per-project 50-cap) yields a 'deep-link' plan so the loader resolves it by id
 * instead of silently falling back to the most recent session.
 */
export function planInitialNavigation(
  projects: ProjectMeta[],
  hash: { projectEncoded: string; sessionId: string } | null,
): InitialNavPlan | null {
  if (hash) {
    const project = projects.find(p => p.encodedName === hash.projectEncoded)
    const session = project?.sessions.find(s => s.id === hash.sessionId)
    if (project && session) {
      return { kind: 'listed', projectEncoded: hash.projectEncoded, sessionId: hash.sessionId, source: project.source }
    }
    if (hash.projectEncoded && hash.sessionId) {
      return { kind: 'deep-link', projectEncoded: hash.projectEncoded, sessionId: hash.sessionId }
    }
  }
  return mostRecentSession(projects)
}
