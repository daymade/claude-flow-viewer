import type { SessionSource } from '../types/session'
import { extractCodexSessionId } from './codex-parser'

/**
 * Session-identifier detector — the entry point of the "known-item" resolve lane.
 *
 * It only recognises the SHAPE of an input (is this a session identifier, and what is the
 * normalized session id?). It deliberately does NOT decide truth: whether the id names a
 * real session is answered later by resolveSession() probing the filesystem. Keeping this a
 * pure, dependency-free function makes it unit-testable and the single source of truth for
 * identifier parsing, so the regex is not scattered across the controller / App / backend.
 *
 * Anchoring is load-bearing: a bare UUID must be the ENTIRE trimmed input. Otherwise a normal
 * full-text query that merely embeds a UUID (e.g. "why did <uuid> crash") would hijack the
 * resolve lane and jump the user away from the search they intended.
 */

// Canonical 8-4-4-4-12 UUID. Claude session ids (v4) and Codex rollout ids (v7) share this shape.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Cherry Studio regular-chat topic ids are stored with this prefix (SSOT: server/cherrystudio/catalog.ts).
const CHERRY_TOPIC_PREFIX = 'topic:'

// Cherry Studio agent-session ids look like `session_<epoch-ms>_<random>` (agents.db `sessions.id`),
// NOT a UUID. Anchored to the whole input so it cannot hijack a normal search.
const CHERRY_AGENT_ID_RE = /^session_\d{10,}_[a-z0-9]+$/i

export interface SessionIdentifierMatch {
  /** Which input shape matched. */
  kind: 'bare-id' | 'topic' | 'path' | 'hash'
  /** Normalized session id: lowercased for hex UUIDs; kept verbatim for `topic:` and agent ids. */
  sessionId: string
  /** Trustworthy only from the explicit `#/{project}/{session}` hash form; a hint elsewhere. */
  projectEncoded?: string
  /** Source narrowed purely by input shape (`topic:` → cherrystudio). Never authoritative. */
  sourceHint?: SessionSource
}

export function isSessionUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

export function detectSessionIdentifier(input: string): SessionIdentifierMatch | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // 1. Explicit app hash `#/{projectEncoded}/{sessionId}` — the only form carrying a project.
  if (trimmed.startsWith('#/')) {
    const parts = trimmed.slice(2).split('/')
    if (parts.length < 2) return null
    const projectEncoded = safeDecode(parts[0])
    const rawSession = safeDecode(parts.slice(1).join('/'))
    if (!projectEncoded || !rawSession) return null
    const sessionId = isSessionUuid(rawSession) ? rawSession.toLowerCase() : rawSession
    return { kind: 'hash', sessionId, projectEncoded }
  }

  // 2. Cherry Studio regular-chat topic id: `topic:{...}` (whole input).
  if (trimmed.startsWith(CHERRY_TOPIC_PREFIX)) {
    const rest = trimmed.slice(CHERRY_TOPIC_PREFIX.length).trim()
    if (!rest) return null
    return { kind: 'topic', sessionId: trimmed, sourceHint: 'cherrystudio' }
  }

  // 3. A file path / filename ending in `.jsonl` (claude `{uuid}.jsonl` or codex
  //    `rollout-<iso>-<uuid>.jsonl`). Extract the id only; never derive projectEncoded from a
  //    parent directory — that is reliable for claude but wrong for codex (parent = date dir).
  if (/\.jsonl$/i.test(trimmed)) {
    const basename = trimmed.split(/[\\/]/).pop() ?? ''
    const extracted = extractCodexSessionId(basename)
    if (isSessionUuid(extracted)) {
      return { kind: 'path', sessionId: extracted.toLowerCase() }
    }
    return null
  }

  // 4. A bare UUID — MUST be the entire input (anchored) to avoid hijacking normal searches.
  if (isSessionUuid(trimmed)) {
    return { kind: 'bare-id', sessionId: trimmed.toLowerCase() }
  }

  // 5. A Cherry Studio agent-session id (session_<epoch>_<random>) — whole input, so a normal
  //    search phrase can't trigger it. Kept verbatim (case-sensitive random suffix).
  if (CHERRY_AGENT_ID_RE.test(trimmed)) {
    return { kind: 'bare-id', sessionId: trimmed, sourceHint: 'cherrystudio' }
  }

  return null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
