import type { ServerParsedSessionEnvelope, SessionData, SessionMeta, SessionSource } from '../types/session'
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

// `JSON.stringify({ __serverParsed: true, data })` always emits `__serverParsed` first with no
// whitespace, so this exact compact prefix is a safe, bounded (string-length-independent) gate.
// Cherry Studio's route returns ONE whole-file JSON document -- a blind `JSON.parse` there to
// check for the marker would cost real time proportional to that document's size, unlike a JSONL
// line. Every ordinary session (ordinary JSONL, and Cherry Studio's document) fails this prefix
// check and is rejected without ever being parsed.
const SERVER_PARSED_ENVELOPE_PREFIX = '{"__serverParsed":true'

function tryParseServerEnvelope(content: string): ServerParsedSessionEnvelope | null {
  if (!content.startsWith(SERVER_PARSED_ENVELOPE_PREFIX)) return null
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    // The marker check is `=== true`, never "JSON.parse succeeded" alone -- a genuine one-record
    // session (just a session_meta line, no newline) is valid whole-string JSON too.
    if (parsed && typeof parsed === 'object' && parsed.__serverParsed === true && 'data' in parsed) {
      return parsed as ServerParsedSessionEnvelope
    }
  } catch {
    // Past the cheap prefix check but not actually valid JSON (a truncated body) -- fall through
    // to the normal path instead of throwing.
  }
  return null
}

/**
 * Entry point for content fetched from /api/session, which for an oversized Codex session is
 * already fully parsed server-side and wrapped in a ServerParsedSessionEnvelope (see
 * parseCodexSessionContentStreaming in codex-parser.ts) instead of returned as raw text.
 * Falls back to parseSessionContent for every other case, which stays the unchanged dispatch
 * boundary -- callers that never fetch through /api/session (the search indexer, the skill
 * recommendation flow, manual/browser file stores) keep calling it directly and never see this
 * envelope shape.
 */
export function parseFetchedSessionContent(content: string, source?: SessionSource): SessionData {
  const envelope = tryParseServerEnvelope(content)
  if (envelope) return envelope.data
  return parseSessionContent(content, source)
}

/**
 * Backward-compatible Claude quick scan entry used by the existing browser scan
 * path. Codex scanning uses quickScanCodexMetadata directly.
 */
export function quickScanMetadata(head: string, sessionId: string, fileSize: number): SessionMeta | null {
  return quickScanClaudeMetadata(head, sessionId, fileSize)
}
