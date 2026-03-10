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
  extractCodexSessionId,
  extractCodexShortName,
  isCodexProjectId,
  makeCodexProjectId,
  quickScanClaudeMetadata,
  quickScanCodexMetadata,
}

export function detectSessionSource(content: string): SessionSource {
  return isCodexSessionContent(content) && !isClaudeSessionContent(content)
    ? 'codex'
    : 'claude'
}

export function parseSessionContent(content: string, source?: SessionSource): SessionData {
  const resolvedSource = source ?? detectSessionSource(content)
  return resolvedSource === 'codex'
    ? parseCodexSessionContent(content)
    : parseClaudeSessionContent(content)
}

/**
 * Backward-compatible Claude quick scan entry used by the existing browser scan
 * path. Codex scanning uses quickScanCodexMetadata directly.
 */
export function quickScanMetadata(head: string, sessionId: string, fileSize: number): SessionMeta | null {
  return quickScanClaudeMetadata(head, sessionId, fileSize)
}
