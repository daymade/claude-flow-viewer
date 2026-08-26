import type { DecisionMarker, SessionSource, UserInputOrigin } from '../types/session'

export interface UserInputListOptions {
  limit?: number
  sources?: SessionSource[]
  projectEncoded?: string
  feedbackOnly?: boolean
}

export interface UserInputRecord {
  id: string
  source: SessionSource
  projectEncoded: string
  projectLabel: string
  projectShortName: string
  sessionId: string
  sessionStartTime: string
  text: string
  timestamp: string | null
  timeRangeStart: string | null
  timeRangeEnd: string | null
  origin: UserInputOrigin
  decision: DecisionMarker
  promptNum: number | null
  sortTimestamp: string
  ordinal: number | null
}

export interface UserInputListPayload {
  generatedAt: string
  inputs: UserInputRecord[]
  coverage?: {
    claudeHistory: 'available' | 'missing'
    codexHistory: 'available' | 'missing'
    omittedClaudePasteInputs: number
    malformedHistoryLines: number
  }
}

/**
 * Codex can append hook feedback through the same history transport as a human input.
 * Keep this deliberately narrow: reject the concrete hook envelope, not prose that merely
 * discusses UserPromptSubmit or a blocked request.
 */
export function isHumanAuthoredHistoryInput(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^• UserPromptSubmit \((?:blocked|allowed)\) says:[\s\S]+\n\s*feedback:/i.test(trimmed)) {
    return false
  }
  if (
    trimmed.startsWith('这次任务如果涉及代码、脚本、配置、环境变量、端口、路径、部署方式、认证方式、测试方式或操作流程的变化')
    && trimmed.includes('交付时请明确给出：')
    && trimmed.includes('必须显式更新 `CLAUDE.md`')
  ) {
    return false
  }
  return true
}

function markdownQuote(value: string): string {
  return value.split('\n').map((line) => `> ${line}`).join('\n')
}

function displayWhen(input: UserInputRecord): string {
  if (input.timestamp && input.origin !== 'compacted') return input.timestamp
  if (input.timeRangeStart && input.timeRangeEnd) {
    return `${input.timeRangeStart} → ${input.timeRangeEnd} (per-message time not retained)`
  }
  return input.sessionStartTime
}

export function buildFeedbackEvidenceMarkdown(
  inputs: UserInputRecord[],
  generatedAt = new Date().toISOString(),
): string {
  const ordered = [...inputs].sort((left, right) => {
    const byTime = right.sortTimestamp.localeCompare(left.sortTimestamp)
    if (byTime !== 0) return byTime
    return (right.ordinal ?? -1) - (left.ordinal ?? -1)
  })

  const lines = [
    '---',
    'schema: claude-flow-feedback-evidence/v1',
    `generated_at: ${generatedAt}`,
    `item_count: ${ordered.length}`,
    '---',
    '',
    '# Feedback evidence packet',
    '',
    '> Exact user inputs selected in Claude Flow Viewer. This packet contains evidence, not an inferred rule.',
  ]

  ordered.forEach((input, index) => {
    lines.push(
      '',
      `## ${index + 1}. ${input.source} · ${input.projectShortName}`,
      '',
      `- Time: ${displayWhen(input)}`,
      `- Session: ${input.sessionId}`,
      `- Project: ${input.projectLabel}`,
      `- Origin: ${input.origin}`,
      `- Structural signal: ${input.decision}`,
      `- Evidence ID: ${input.id}`,
      '',
      '### Exact user input',
      '',
      markdownQuote(input.text),
    )
  })

  return `${lines.join('\n')}\n`
}
