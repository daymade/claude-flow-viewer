import fs from 'node:fs'
import { execFile } from 'node:child_process'

import { parseSessionContent } from '../../src/lib/parser'
import {
  buildSkillRecommendationId,
  buildSkillRecommendationSessionDossier,
  type SkillRecommendation,
  type SkillRecommendationAnalysis,
  type SkillRecommendationAnalyzeOptions,
  type SkillRecommendationAnalyzeScope,
  type SkillRecommendationBackendStatus,
  type SkillRecommendationConfidence,
} from '../../src/lib/skill-recommendations'
import type { SearchSessionRecord } from '../../src/lib/search'
import { listIndexedSessionFiles, type IndexedSessionFile, type SearchRoots } from '../search/session-catalog'

const DEFAULT_SESSION_LIMIT = 6
const SMART_SESSION_LIMIT = 4
const PROJECT_SESSION_LIMIT = 6
const RECENT_SESSION_LIMIT = 8
const DEFAULT_MODEL = process.env.CLAUDE_SKILL_MODEL || 'haiku'
const DEFAULT_EFFORT = process.env.CLAUDE_SKILL_EFFORT || 'low'
const DEFAULT_TIMEOUT_MS = Math.max(15_000, Number(process.env.CLAUDE_SKILL_TIMEOUT_MS || 120_000))
const DEFAULT_MAX_BUDGET_USD = Math.max(0.1, Number(process.env.CLAUDE_SKILL_MAX_BUDGET_USD || 0.35))
const STATUS_PROBE_BUDGET_USD = Math.max(0.03, Number(process.env.CLAUDE_SKILL_STATUS_PROBE_BUDGET_USD || 0.12))
const STATUS_CACHE_TTL_MS = Math.max(30_000, Number(process.env.CLAUDE_SKILL_STATUS_CACHE_TTL_MS || 300_000))
const STATUS_PROBE_TIMEOUT_MS = Math.max(5_000, Number(process.env.CLAUDE_SKILL_STATUS_PROBE_TIMEOUT_MS || 15_000))
const TEMP_CWD = process.env.TMPDIR || '/tmp'
const USER_SHELL = process.env.SHELL || '/bin/zsh'
const ZSH_BOOTSTRAP = 'source ~/.zprofile >/dev/null 2>&1 || true; source ~/.zshrc >/dev/null 2>&1 || true; exec "$@" < /dev/null'
const BASH_BOOTSTRAP = 'source ~/.bash_profile >/dev/null 2>&1 || source ~/.bash_login >/dev/null 2>&1 || source ~/.profile >/dev/null 2>&1 || true; source ~/.bashrc >/dev/null 2>&1 || true; exec "$@" < /dev/null'

type ScoutOutput = {
  summary: string
  patterns: Array<{
    label: string
    evidence: string[]
  }>
}

type SkepticOutput = {
  summary: string
  keep: string[]
  discard: Array<{
    label: string
    reason: string
  }>
}

type WriterOutput = {
  summary: string
  candidates: Array<{
    name: string
    title: string
    summary: string
    rationale: string
    whenToUse: string
    steps: string[]
    evidence: string[]
    confidence: SkillRecommendationConfidence
  }>
}

type ClaudeCliEnvelope<T> = {
  is_error: boolean
  result?: string
  structured_output?: T
}

function scoutSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      patterns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'evidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'patterns'],
    additionalProperties: false,
  }
}

function skepticSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      keep: { type: 'array', items: { type: 'string' } },
      discard: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['label', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'keep', 'discard'],
    additionalProperties: false,
  }
}

function writerSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            rationale: { type: 'string' },
            whenToUse: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'string', enum: ['high', 'medium', 'emerging'] },
          },
          required: ['name', 'title', 'summary', 'rationale', 'whenToUse', 'steps', 'evidence', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'candidates'],
    additionalProperties: false,
  }
}

function normalizeCliError(error: unknown): Error {
  const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number }
  const raw = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim()
  if (/Not logged in/i.test(raw)) {
    return new Error('Local Claude Code is installed but not logged in for non-interactive analysis. Run `claude` once in a terminal and complete login.')
  }
  if (err.code === 'ENOENT' || /not found/i.test(raw)) {
    return new Error('The local `claude` CLI is not available on PATH, so Claude-backed skill analysis cannot run.')
  }
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(raw)) {
    return new Error('Local Claude Code timed out while analyzing recent history.')
  }
  return new Error(raw || 'Local Claude Code failed to analyze recent history.')
}

function execFileJson(
  file: string,
  args: string[],
  options: {
    cwd: string
    timeout: number
    maxBuffer: number
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const invocation = buildCliInvocation(file, args)
    const child = execFile(invocation.file, invocation.args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        const wrapped = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
        wrapped.stdout = String(stdout)
        wrapped.stderr = String(stderr)
        reject(wrapped)
        return
      }

      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
      })
    })

    // Claude CLI warns and waits a few seconds if stdin stays open without data.
    // Close it immediately so non-interactive runs proceed without the delay.
    child.stdin?.end()
  })
}

function buildCliInvocation(file: string, args: string[]): { file: string; args: string[] } {
  const shellPath = USER_SHELL
  const shellName = shellPath.split('/').pop() || shellPath

  if (shellName === 'zsh') {
    return {
      file: shellPath,
      args: ['-lc', ZSH_BOOTSTRAP, 'zsh', file, ...args],
    }
  }

  if (shellName === 'bash') {
    return {
      file: shellPath,
      args: ['-lc', BASH_BOOTSTRAP, 'bash', file, ...args],
    }
  }

  return {
    file,
    args,
  }
}

function agentsConfig() {
  return {
    scout: {
      description: 'Identify recurring workflows in recent local AI session history.',
      prompt: 'Inspect the supplied recent-session dossiers and identify repeated workflow patterns grounded in the provided evidence.',
    },
    skeptic: {
      description: 'Challenge weak abstractions and reject one-off ideas.',
      prompt: 'Reject patterns that are too repo-specific, one-off, or weakly supported. Keep only workflows that should plausibly become reusable skills.',
    },
    writer: {
      description: 'Draft reusable skill recommendations from agreed workflow patterns.',
      prompt: 'Turn the strongest retained patterns into reusable skills with crisp naming, summaries, and steps. Stay conservative and evidence-driven.',
    },
  }
}

function defaultLimitForScope(scope: SkillRecommendationAnalyzeScope): number {
  switch (scope) {
    case 'project': return PROJECT_SESSION_LIMIT
    case 'recent': return RECENT_SESSION_LIMIT
    case 'smart':
    default:
      return SMART_SESSION_LIMIT
  }
}

function totalBudgetForScope(scope: SkillRecommendationAnalyzeScope, maxBudgetUsd: number): number {
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error('CLAUDE_SKILL_MAX_BUDGET_USD must be greater than 0.')
  }
  if (scope === 'smart') return Number((maxBudgetUsd * 0.5).toFixed(3))
  if (scope === 'project') return Number((maxBudgetUsd * 0.75).toFixed(3))
  return Number(maxBudgetUsd.toFixed(3))
}

function cappedLimit(scope: SkillRecommendationAnalyzeScope, explicitLimit?: number): number {
  const defaultLimit = defaultLimitForScope(scope)
  if (typeof explicitLimit !== 'number' || !Number.isFinite(explicitLimit)) {
    return defaultLimit
  }
  return Math.max(1, Math.min(defaultLimit, Math.floor(explicitLimit)))
}

function agentBudgets(totalBudgetUsd: number) {
  if (totalBudgetUsd <= 0) {
    throw new Error('Total Claude skill-analysis budget must be greater than 0.')
  }

  const scout = Number((totalBudgetUsd * 0.34).toFixed(3))
  const skeptic = Number((totalBudgetUsd * 0.28).toFixed(3))
  const writer = Number((totalBudgetUsd - scout - skeptic).toFixed(3))
  return {
    scout,
    skeptic,
    writer,
  }
}

function selectHistoryWindow(
  sessionFiles: IndexedSessionFile[],
  options: SkillRecommendationAnalyzeOptions,
): {
  scope: SkillRecommendationAnalyzeScope
  requestedProjectEncoded: string | null
  scopeLabel: string
  targetLabel: string | null
  sessions: IndexedSessionFile[]
} {
  const scope = options.scope ?? 'smart'
  const limit = cappedLimit(scope, options.sessionLimit)
  const projectEncoded = options.projectEncoded

  if (scope === 'project' && projectEncoded) {
    const projectSessions = sessionFiles.filter((session) => session.projectEncoded === projectEncoded)
    if (projectSessions.length === 0) {
      throw new Error(`Project scope could not be resolved for ${projectEncoded}.`)
    }
    return {
      scope,
      requestedProjectEncoded: projectEncoded,
      scopeLabel: 'Current project',
      targetLabel: projectSessions[0]?.projectShortName ?? null,
      sessions: projectSessions.slice(0, limit),
    }
  }

  if (scope === 'recent') {
    return {
      scope,
      requestedProjectEncoded: null,
      scopeLabel: 'Recent across all projects',
      targetLabel: null,
      sessions: sessionFiles.slice(0, limit),
    }
  }

  if (projectEncoded) {
    const projectSessions = sessionFiles.filter((session) => session.projectEncoded === projectEncoded)
    if (projectSessions.length >= 2) {
      return {
        scope: 'smart',
        requestedProjectEncoded: projectEncoded,
        scopeLabel: 'Smart scope',
        targetLabel: projectSessions[0]?.projectShortName ?? null,
        sessions: projectSessions.slice(0, limit),
      }
    }
  }

  return {
    scope: 'smart',
    requestedProjectEncoded: projectEncoded ?? null,
    scopeLabel: 'Smart scope',
    targetLabel: null,
    sessions: sessionFiles.slice(0, limit),
  }
}

export class ClaudeSkillRecommendationService {
  private readonly roots: SearchRoots
  private readonly model: string
  private readonly effort: string
  private readonly timeoutMs: number
  private readonly maxBudgetUsd: number
  private readonly defaultSessionLimit: number
  private statusCache: { value: SkillRecommendationBackendStatus; expiresAt: number } | null = null

  constructor(
    roots: SearchRoots,
    options: {
      model?: string
      effort?: string
      timeoutMs?: number
      maxBudgetUsd?: number
      defaultSessionLimit?: number
    } = {},
  ) {
    this.roots = roots
    this.model = options.model || DEFAULT_MODEL
    this.effort = options.effort || DEFAULT_EFFORT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBudgetUsd = options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD
    this.defaultSessionLimit = options.defaultSessionLimit ?? DEFAULT_SESSION_LIMIT
  }

  async getStatus(): Promise<SkillRecommendationBackendStatus> {
    if (this.statusCache && this.statusCache.expiresAt > Date.now()) {
      return this.statusCache.value
    }

    const cliPath = await this.findClaudeCliPath()
    if (!cliPath) {
      const unavailable: SkillRecommendationBackendStatus = {
        available: false,
        backend: 'claude-code',
        reason: 'cli-unavailable',
        message: 'The local `claude` CLI was not found on PATH, so Claude-backed skill analysis is unavailable.',
      }
      return unavailable
    }

    try {
      await this.probeClaudeReady()
    } catch (error) {
      const unavailable: SkillRecommendationBackendStatus = {
        available: false,
        backend: 'claude-code',
        reason: 'not-ready',
        message: normalizeCliError(error).message,
      }
      return unavailable
    }

    const available: SkillRecommendationBackendStatus = {
      available: true,
      backend: 'claude-code',
      cliPath,
      model: this.model,
      sessionLimit: this.defaultSessionLimit,
      message: 'Runs an on-demand local Claude Code team analysis over recent session history.',
    }
    this.statusCache = {
      value: available,
      expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
    }
    return available
  }

  async analyzeRecentHistory(options: SkillRecommendationAnalyzeOptions = {}): Promise<SkillRecommendationAnalysis> {
    const sessionFiles = await listIndexedSessionFiles(this.roots)
    const window = selectHistoryWindow(sessionFiles, options)
    const selected = window.sessions

    if (selected.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        backend: 'claude-code',
        model: this.model,
        scope: window.scope,
        requestedProjectEncoded: window.requestedProjectEncoded,
        scopeLabel: window.scopeLabel,
        targetLabel: window.targetLabel,
        analyzedSessionCount: 0,
        discussion: [],
        recommendations: [],
      }
    }

    const budgets = agentBudgets(totalBudgetForScope(window.scope, this.maxBudgetUsd))
    const deadlineMs = Date.now() + this.timeoutMs

    const dossiers = await Promise.all(selected.map(async (sessionFile) => {
      const content = sessionFile.loadContent
        ? await sessionFile.loadContent()
        : await fs.promises.readFile(sessionFile.filePath, 'utf-8')
      const data = parseSessionContent(content, sessionFile.source)
      const record: SearchSessionRecord = {
        projectEncoded: sessionFile.projectEncoded,
        projectLabel: sessionFile.projectLabel,
        projectShortName: sessionFile.projectShortName,
        meta: sessionFile.meta,
        data,
      }
      return buildSkillRecommendationSessionDossier(record)
    }))

    const historyPayload = JSON.stringify({ sessions: dossiers }, null, 2)

    const scout = await this.runStructuredPrompt<ScoutOutput>({
      agentName: 'scout',
      maxBudgetUsd: budgets.scout,
      timeoutMs: this.remainingTimeout(deadlineMs),
      schema: scoutSchema(),
      systemPrompt: [
        'You are the scout agent in a local Claude Code analysis team.',
        'Inspect the supplied recent-session dossiers and identify workflows that truly repeat.',
        'Only describe patterns supported by concrete evidence from multiple sessions or multiple excerpts.',
      ].join(' '),
      prompt: [
        'Recent local history dossiers:',
        historyPayload,
        'Return short repeated workflow patterns with evidence.',
      ].join('\n\n'),
    })

    const skeptic = await this.runStructuredPrompt<SkepticOutput>({
      agentName: 'skeptic',
      maxBudgetUsd: budgets.skeptic,
      timeoutMs: this.remainingTimeout(deadlineMs),
      schema: skepticSchema(),
      systemPrompt: [
        'You are the skeptic agent in a local Claude Code analysis team.',
        'Challenge weak abstractions, remove one-off ideas, and keep only reusable workflows.',
      ].join(' '),
      prompt: [
        'Recent local history dossiers:',
        historyPayload,
        'Scout findings:',
        JSON.stringify(scout, null, 2),
        'Decide which labels should be kept or discarded for skill extraction.',
      ].join('\n\n'),
    })

    const writer = await this.runStructuredPrompt<WriterOutput>({
      agentName: 'writer',
      maxBudgetUsd: budgets.writer,
      timeoutMs: this.remainingTimeout(deadlineMs),
      schema: writerSchema(),
      systemPrompt: [
        'You are the writer agent in a local Claude Code analysis team.',
        'Turn the strongest repeated workflows into reusable skills with crisp triggers, steps, and evidence.',
        'Do not propose skills that are not backed by the provided history.',
      ].join(' '),
      prompt: [
        'Recent local history dossiers:',
        historyPayload,
        'Scout findings:',
        JSON.stringify(scout, null, 2),
        'Skeptic review:',
        JSON.stringify(skeptic, null, 2),
        'Produce the final candidate skills.',
      ].join('\n\n'),
    })

    const discussion = [
      { agent: 'scout', point: scout.summary },
      { agent: 'skeptic', point: skeptic.summary },
      { agent: 'writer', point: writer.summary },
    ]

    const recommendations: SkillRecommendation[] = writer.candidates.map((candidate, index) => ({
      id: buildSkillRecommendationId(candidate.name, index),
      name: candidate.name,
      title: candidate.title,
      summary: candidate.summary,
      rationale: candidate.rationale,
      whenToUse: candidate.whenToUse,
      steps: candidate.steps.slice(0, 6),
      evidence: candidate.evidence.slice(0, 4),
      confidence: candidate.confidence,
    }))

    return {
      generatedAt: new Date().toISOString(),
      backend: 'claude-code',
      model: this.model,
      scope: window.scope,
      requestedProjectEncoded: window.requestedProjectEncoded,
      scopeLabel: window.scopeLabel,
      targetLabel: window.targetLabel,
      analyzedSessionCount: dossiers.length,
      discussion,
      recommendations,
    }
  }

  private async findClaudeCliPath(): Promise<string | null> {
    try {
      await execFileJson('claude', ['--version'], {
        cwd: TEMP_CWD,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      })
      return 'claude'
    } catch {
      return null
    }
  }

  private remainingTimeout(deadlineMs: number): number {
    const remaining = deadlineMs - Date.now()
    if (remaining <= 0) {
      throw new Error('Local Claude Code timed out while analyzing recent history.')
    }
    return remaining
  }

  private async probeClaudeReady(): Promise<void> {
    const { stdout } = await execFileJson('claude', [
      '-p',
      '--model', this.model,
      '--effort', this.effort,
      '--no-session-persistence',
      '--output-format', 'json',
      '--max-budget-usd', String(STATUS_PROBE_BUDGET_USD),
      '--agents', JSON.stringify(agentsConfig()),
      '--agent', 'scout',
      '--json-schema', JSON.stringify({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: false,
      }),
      'Readiness probe. Return {"ok": true}.',
    ], {
      cwd: TEMP_CWD,
      timeout: Math.min(this.timeoutMs, STATUS_PROBE_TIMEOUT_MS),
      maxBuffer: 1024 * 1024 * 4,
    })

    const envelope = JSON.parse(stdout.trim()) as ClaudeCliEnvelope<{ ok: boolean }>
    if (envelope.is_error || !envelope.structured_output?.ok) {
      throw new Error(envelope.result || 'Local Claude Code readiness probe failed.')
    }
  }

  private async runStructuredPrompt<T>({
    agentName,
    maxBudgetUsd,
    timeoutMs,
    schema,
    systemPrompt,
    prompt,
  }: {
    agentName: 'scout' | 'skeptic' | 'writer'
    maxBudgetUsd: number
    timeoutMs: number
    schema: object
    systemPrompt: string
    prompt: string
  }): Promise<T> {
    try {
      const { stdout } = await execFileJson('claude', [
        '-p',
        '--model', this.model,
        '--effort', this.effort,
        '--no-session-persistence',
        '--output-format', 'json',
        '--max-budget-usd', String(maxBudgetUsd),
        '--agents', JSON.stringify(agentsConfig()),
        '--agent', agentName,
        '--system-prompt', systemPrompt,
        '--json-schema', JSON.stringify(schema),
        prompt,
      ], {
        cwd: TEMP_CWD,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
      })

      const envelope = JSON.parse(stdout.trim()) as ClaudeCliEnvelope<T>
      if (envelope.is_error || !envelope.structured_output) {
        throw new Error(envelope.result || 'Local Claude Code returned no structured output.')
      }
      return envelope.structured_output
    } catch (error) {
      throw normalizeCliError(error)
    }
  }
}
