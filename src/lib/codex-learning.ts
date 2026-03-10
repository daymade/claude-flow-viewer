import type { SessionData, SessionMessage, SessionMeta } from '../types/session'
import type { CodexSelectionContext, CodexThreadNode } from './codex-navigation'

export interface CodexKeyMoment {
  kind: 'delegation' | 'verification' | 'command' | 'decision' | 'status' | 'context'
  title: string
  detail: string
  timestamp?: string
  tone: 'emerald' | 'amber' | 'rose' | 'slate'
}

export interface CodexNoiseBucket {
  label: string
  count: number
}

export interface CodexTaskInsights {
  objective: string
  statusLabel: string
  roleLabel: string
  assignedSummary: string | null
  returnedSummary: string | null
  activitySummary: string | null
  keyMoments: CodexKeyMoment[]
  decisionPoints: CodexKeyMoment[]
  hiddenNoise: CodexNoiseBucket[]
  completionSummary: string | null
}

interface MomentCandidate extends CodexKeyMoment {
  priority: number
  order: number
}

function summarizeText(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

function describeToolMoment(message: Extract<SessionMessage, { kind: 'ai-tool-use' }>, order: number): MomentCandidate | null {
  const name = message.name.toLowerCase()
  const input = message.input
  const prompt = String(input.prompt || input.message || input.description || input.task || '').trim()

  if (name === 'spawn_agent' || name === 'agent' || name === 'task') {
    return {
      kind: 'delegation',
      title: 'Delegated work spawned',
      detail: summarizeText(prompt || message.summary),
      timestamp: message.timestamp,
      tone: 'emerald',
      priority: 90,
      order,
    }
  }

  if (name === 'send_input') {
    const followUp = String(input.text || input.message || input.prompt || '').trim()
    return {
      kind: 'delegation',
      title: 'Delegated work guided',
      detail: summarizeText(followUp || message.summary),
      timestamp: message.timestamp,
      tone: 'emerald',
      priority: 70,
      order,
    }
  }

  if (name === 'update_plan') {
    return {
      kind: 'decision',
      title: 'Plan updated',
      detail: summarizeText(message.summary),
      timestamp: message.timestamp,
      tone: 'amber',
      priority: 65,
      order,
    }
  }

  if (name === 'apply_patch') {
    return {
      kind: 'command',
      title: 'Patch prepared',
      detail: summarizeText(message.summary),
      timestamp: message.timestamp,
      tone: 'slate',
      priority: 55,
      order,
    }
  }

  if (name === 'exec_command' || name === 'shell_command' || name === 'bash') {
    const command = String(input.cmd || input.command || message.summary)
    const verificationCommand = /(npm run|npx |vitest|tsc|eslint|pytest|cargo test|go test|pnpm test|yarn test)/i.test(command)

    return {
      kind: verificationCommand ? 'verification' : 'command',
      title: verificationCommand ? 'Verification run' : 'Command executed',
      detail: summarizeText(command, 140),
      timestamp: message.timestamp,
      tone: verificationCommand ? 'emerald' : 'slate',
      priority: verificationCommand ? 60 : 35,
      order,
    }
  }

  return null
}

function finalizeMoments(candidates: MomentCandidate[]): CodexKeyMoment[] {
  const preserved: MomentCandidate[] = []
  let commandCount = 0
  let verificationCount = 0

  for (const candidate of candidates.sort((left, right) => left.order - right.order)) {
    if (candidate.kind === 'command') {
      if (commandCount >= 4) continue
      commandCount++
    }

    if (candidate.kind === 'verification') {
      if (verificationCount >= 3) continue
      verificationCount++
    }

    preserved.push(candidate)
  }

  return preserved.map((candidate) => ({
    kind: candidate.kind,
    title: candidate.title,
    detail: candidate.detail,
    timestamp: candidate.timestamp,
    tone: candidate.tone,
  }))
}

function roleLabel(session: SessionMeta): string {
  if (session.threadKind !== 'subagent') return 'Main task'
  const parts = [session.agentName, session.agentRole].filter(Boolean)
  return parts.length > 0 ? `Delegated work · ${parts.join(' · ')}` : 'Delegated work'
}

function looksGenericPreview(value: string, session: SessionMeta): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return true

  const sessionPreview = session.firstPromptPreview.replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalized === sessionPreview) return true

  if (!normalized.includes(' ') && normalized.length <= 32) return true
  return false
}

export function buildCodexTaskInsights(data: SessionData, session: SessionMeta): CodexTaskInsights {
  const firstPrompt = data.prompts[0]?.fullText?.trim() ?? ''
  const latestPrompt = data.prompts[data.prompts.length - 1]?.fullText?.trim() ?? ''
  const promptObjective = session.threadKind === 'subagent' ? latestPrompt || firstPrompt : firstPrompt
  const objective = promptObjective && !looksGenericPreview(promptObjective, session)
    ? promptObjective
    : session.firstPromptPreview
  const assignedSummary = promptObjective || null
  const candidates: MomentCandidate[] = []
  const hiddenNoiseCounts = new Map<string, number>()
  let completionSummary: string | null = null
  let finalAssistantText: string | null = null

  for (let index = 0; index < data.messages.length; index++) {
    const message = data.messages[index]

    switch (message.kind) {
      case 'user-prompt':
        if (message.decision !== 'none') {
          candidates.push({
            kind: 'decision',
            title: message.decision === 'interrupt' ? 'User interrupted the flow' : 'User changed direction',
            detail: summarizeText(message.text),
            timestamp: message.time,
            tone: 'amber',
            priority: 80,
            order: index,
          })
        } else {
          hiddenNoiseCounts.set('User prompts', (hiddenNoiseCounts.get('User prompts') ?? 0) + 1)
        }
        break
      case 'ai-tool-use': {
        const toolMoment = describeToolMoment(message, index)
        if (toolMoment) candidates.push(toolMoment)
        else hiddenNoiseCounts.set('Low-signal tool calls', (hiddenNoiseCounts.get('Low-signal tool calls') ?? 0) + 1)
        break
      }
      case 'tool-result':
        if (message.isError) {
          candidates.push({
            kind: 'decision',
            title: 'A tool call failed',
            detail: summarizeText(message.content),
            timestamp: message.timestamp,
            tone: 'rose',
            priority: 75,
            order: index,
          })
        } else {
          hiddenNoiseCounts.set('Raw tool outputs', (hiddenNoiseCounts.get('Raw tool outputs') ?? 0) + 1)
        }
        break
      case 'delegation-update':
        candidates.push({
          kind: 'delegation',
          title: message.status === 'completed' ? 'Delegated work returned' : 'Delegated work sent an update',
          detail: summarizeText(message.summary),
          timestamp: message.timestamp,
          tone: message.status === 'failed' ? 'rose' : 'emerald',
          priority: 85,
          order: index,
        })
        break
      case 'rollback-marker':
        candidates.push({
          kind: 'decision',
          title: 'The thread rolled back',
          detail: `${message.numTurns} turn${message.numTurns === 1 ? '' : 's'} were removed from the active path.`,
          timestamp: message.timestamp,
          tone: 'amber',
          priority: 82,
          order: index,
        })
        break
      case 'compact-boundary':
        candidates.push({
          kind: 'context',
          title: 'Context was compacted',
          detail: message.summaryText ? summarizeText(message.summaryText) : 'The session folded earlier context before continuing.',
          timestamp: message.timestamp,
          tone: 'slate',
          priority: 50,
          order: index,
        })
        break
      case 'task-event':
        if (message.status === 'completed') {
          completionSummary = message.summary || completionSummary
          candidates.push({
            kind: 'status',
            title: 'Task completed',
            detail: summarizeText(message.summary || 'The active task completed.'),
            timestamp: message.timestamp,
            tone: 'emerald',
            priority: 88,
            order: index,
          })
        } else {
          hiddenNoiseCounts.set('Protocol task events', (hiddenNoiseCounts.get('Protocol task events') ?? 0) + 1)
        }
        break
      case 'ai-thinking':
        hiddenNoiseCounts.set('Internal thinking notes', (hiddenNoiseCounts.get('Internal thinking notes') ?? 0) + 1)
        break
      case 'ai-text':
        finalAssistantText = summarizeText(message.text, 160)
        hiddenNoiseCounts.set('General assistant narration', (hiddenNoiseCounts.get('General assistant narration') ?? 0) + 1)
        break
      case 'team-message':
        hiddenNoiseCounts.set('Protocol messages', (hiddenNoiseCounts.get('Protocol messages') ?? 0) + 1)
        break
      default:
        break
    }
  }

  const keyMoments = finalizeMoments(candidates)
  if (!completionSummary && finalAssistantText && !looksGenericPreview(finalAssistantText, session)) {
    completionSummary = finalAssistantText
  }

  const promotedKeyMoments = completionSummary && !keyMoments.some((moment) => moment.kind === 'status')
    ? [
        {
          kind: 'status' as const,
          title: 'Delivered result',
          detail: completionSummary,
          tone: 'emerald' as const,
        },
        ...keyMoments,
      ]
    : keyMoments

  const decisionPoints = keyMoments.filter((moment) => moment.kind === 'decision' || moment.kind === 'context')
  const activitySummary = keyMoments.find((moment) => moment.kind !== 'status' && moment.kind !== 'context')?.detail ?? null
  const hiddenNoise = Array.from(hiddenNoiseCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)

  return {
    objective,
    statusLabel: completionSummary ? 'Completed' : 'In progress',
    roleLabel: roleLabel(session),
    assignedSummary,
    returnedSummary: completionSummary,
    activitySummary,
    keyMoments: promotedKeyMoments,
    decisionPoints,
    hiddenNoise,
    completionSummary,
  }
}

export function codexSubtreeNodes(root: CodexThreadNode): CodexThreadNode[] {
  const collected: CodexThreadNode[] = [root]
  for (const child of root.children) {
    collected.push(...codexSubtreeNodes(child))
  }
  return collected
}

export function codexLineageSummary(context: CodexSelectionContext | null): string {
  if (!context) return ''
  if (context.lineage.length === 1) return 'Main task in focus'
  return `Viewing delegated work ${context.lineage.length - 1} level${context.lineage.length === 2 ? '' : 's'} deep`
}
