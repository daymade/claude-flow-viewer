import type { SearchChunkKind, SearchSessionRecord } from './search'
import { extractSearchChunks } from './search'

const URL_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#][^\s]*)?/gi
const MAX_EXCERPTS = 10
const MAX_TEXT_LENGTH = 220

const INCLUDED_KINDS: SearchChunkKind[] = [
  'prompt',
  'team-message',
  'delegation-update',
  'task-event',
  'tool-call',
  'ai-text',
]

export type SkillRecommendationConfidence = 'high' | 'medium' | 'emerging'
export type SkillRecommendationAnalyzeScope = 'smart' | 'project' | 'recent'

export interface SkillRecommendationBackendReadyStatus {
  available: true
  backend: 'claude-code'
  cliPath: string
  model: string
  sessionLimit: number
  message: string
}

export interface SkillRecommendationBackendUnavailableStatus {
  available: false
  backend: 'claude-code'
  reason: 'server-required' | 'cli-unavailable' | 'not-ready'
  message: string
}

export type SkillRecommendationBackendStatus =
  | SkillRecommendationBackendReadyStatus
  | SkillRecommendationBackendUnavailableStatus

export interface SkillRecommendationAnalyzeOptions {
  scope?: SkillRecommendationAnalyzeScope
  projectEncoded?: string
  sessionLimit?: number
}

export interface SkillRecommendationDiscussionPoint {
  agent: string
  point: string
}

export interface SkillRecommendation {
  id: string
  name: string
  title: string
  summary: string
  rationale: string
  whenToUse: string
  steps: string[]
  evidence: string[]
  confidence: SkillRecommendationConfidence
}

export interface SkillRecommendationAnalysis {
  generatedAt: string
  backend: 'claude-code'
  model: string
  scope: SkillRecommendationAnalyzeScope
  requestedProjectEncoded: string | null
  scopeLabel: string
  targetLabel: string | null
  analyzedSessionCount: number
  discussion: SkillRecommendationDiscussionPoint[]
  recommendations: SkillRecommendation[]
}

export interface SkillRecommendationSessionExcerpt {
  kind: SearchChunkKind
  label: string
  text: string
}

export interface SkillRecommendationSessionDossier {
  source: SearchSessionRecord['meta']['source']
  projectShortName: string
  projectLabel: string
  sessionId: string
  startedAt: string
  preview: string
  role: string | null
  tools: string[]
  domains: string[]
  excerpts: SkillRecommendationSessionExcerpt[]
}

function summarizeText(value: string, limit = MAX_TEXT_LENGTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

function extractDomains(values: string[]): string[] {
  const matches = new Set<string>()
  for (const value of values) {
    for (const match of value.matchAll(URL_RE)) {
      if (match[1]) matches.add(match[1].toLowerCase().replace(/^www\./, ''))
    }
  }
  return [...matches]
}

function kindLabel(kind: SearchChunkKind): string {
  switch (kind) {
    case 'prompt': return 'Prompt'
    case 'tool-call': return 'Tool'
    case 'team-message': return 'Team'
    case 'delegation-update': return 'Delegation'
    case 'task-event': return 'Task'
    case 'ai-text': return 'Response'
    default: return kind
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function buildSkillRecommendationId(name: string, fallbackIndex: number): string {
  const slug = slugify(name)
  return slug || `skill-${fallbackIndex + 1}`
}

export function buildSkillRecommendationSessionDossier(session: SearchSessionRecord): SkillRecommendationSessionDossier {
  const chunks = extractSearchChunks(session)
  const excerpts = chunks
    .filter((chunk) => INCLUDED_KINDS.includes(chunk.kind))
    .slice(0, MAX_EXCERPTS)
    .map((chunk) => ({
      kind: chunk.kind,
      label: kindLabel(chunk.kind),
      text: summarizeText(chunk.text),
    }))

  const tools = chunks
    .filter((chunk) => chunk.kind === 'tool-call')
    .flatMap((chunk) => chunk.searchTags)
    .filter(Boolean)

  const domains = extractDomains([
    session.meta.firstPromptPreview,
    ...chunks.map((chunk) => chunk.text),
  ])

  return {
    source: session.meta.source,
    projectShortName: session.projectShortName ?? session.projectLabel,
    projectLabel: session.projectLabel,
    sessionId: session.meta.id,
    startedAt: session.meta.startTime,
    preview: summarizeText(session.meta.firstPromptPreview, 140),
    role: [session.meta.agentName, session.meta.agentRole].filter(Boolean).join(' · ') || null,
    tools: [...new Set(tools)].slice(0, 8),
    domains: domains.slice(0, 8),
    excerpts,
  }
}
