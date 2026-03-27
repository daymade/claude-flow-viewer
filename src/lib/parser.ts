import type { SessionData, SessionMeta, SessionSource } from '../types/session'
import {
  decodeProjectName,
  disambiguateShortNames,
  extractShortName,
  isClaudeSessionContent,
  parseClaudeSessionContent,
  quickScanClaudeMetadata,
} from './providers/claude'
import {
  extractCherryStudioShortName,
  isCherryStudioProjectId,
  isCherryStudioSessionContent,
  makeCherryStudioProjectId,
  parseCherryStudioSessionContent,
} from './providers/cherrystudio'
import {
  extractCodexSessionId,
  extractCodexShortName,
  isCodexProjectId,
  isCodexSessionContent,
  makeCodexProjectId,
  parseCodexSessionContent,
  quickScanCodexMetadata,
} from './providers/codex'

export {
  decodeProjectName,
  disambiguateShortNames,
  extractShortName,
  extractCherryStudioShortName,
  extractCodexSessionId,
  isCherryStudioProjectId,
  extractCodexShortName,
  makeCherryStudioProjectId,
  isCodexProjectId,
  makeCodexProjectId,
  quickScanClaudeMetadata,
  quickScanCodexMetadata,
}

export function detectSessionSource(content: string): SessionSource {
  if (isCherryStudioSessionContent(content)) return 'cherrystudio'
  return isCodexSessionContent(content) && !isClaudeSessionContent(content)
    ? 'codex'
    : 'claude'
}

export function parseSessionContent(content: string, source?: SessionSource): SessionData {
  const resolvedSource = source ?? detectSessionSource(content)
  if (resolvedSource === 'codex') return parseCodexSessionContent(content)
  if (resolvedSource === 'cherrystudio') return parseCherryStudioSessionContent(content)
  return parseClaudeSessionContent(content)
}

/**
 * Backward-compatible Claude quick scan entry used by the existing browser scan
 * path. Codex scanning uses quickScanCodexMetadata directly.
 */
export function quickScanMetadata(head: string, sessionId: string, fileSize: number): SessionMeta | null {
  return quickScanClaudeMetadata(head, sessionId, fileSize)
}
