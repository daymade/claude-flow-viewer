import { describe, it, expect } from 'vitest'
import { detectSessionIdentifier, isSessionUuid } from '../session-identifier'

const CLAUDE_ID = '04207f06-471e-4983-b97a-029d611b56c5'
const CODEX_ID = '019d2b15-a4d6-7a50-93ff-e97a83214f26'

describe('detectSessionIdentifier', () => {
  it('detects a bare claude UUID as the entire input', () => {
    expect(detectSessionIdentifier(CLAUDE_ID)).toEqual({ kind: 'bare-id', sessionId: CLAUDE_ID })
  })

  it('detects a bare codex (v7-shaped) UUID with the same 8-4-4-4-12 shape', () => {
    expect(detectSessionIdentifier(CODEX_ID)).toEqual({ kind: 'bare-id', sessionId: CODEX_ID })
  })

  it('trims surrounding whitespace around a bare id', () => {
    expect(detectSessionIdentifier(`  ${CLAUDE_ID}\n`)).toEqual({ kind: 'bare-id', sessionId: CLAUDE_ID })
  })

  it('lowercases a pasted uppercase UUID so it matches on-disk filenames and hash routing', () => {
    expect(detectSessionIdentifier(CLAUDE_ID.toUpperCase())).toEqual({ kind: 'bare-id', sessionId: CLAUDE_ID })
  })

  it('does NOT hijack a normal search phrase that merely embeds a UUID', () => {
    expect(detectSessionIdentifier(`why did ${CLAUDE_ID} crash`)).toBeNull()
    expect(detectSessionIdentifier(`session ${CLAUDE_ID}`)).toBeNull()
  })

  it('detects a Cherry Studio topic id and hints the source', () => {
    expect(detectSessionIdentifier('topic:abc123')).toEqual({
      kind: 'topic',
      sessionId: 'topic:abc123',
      sourceHint: 'cherrystudio',
    })
  })

  it('rejects a bare `topic:` with no id', () => {
    expect(detectSessionIdentifier('topic:')).toBeNull()
  })

  it('detects a Cherry Studio agent-session id (session_<epoch>_<random>)', () => {
    expect(detectSessionIdentifier('session_1774486987818_cdp26yi0z')).toEqual({
      kind: 'bare-id',
      sessionId: 'session_1774486987818_cdp26yi0z',
      sourceHint: 'cherrystudio',
    })
  })

  it('does not treat a normal phrase starting with "session" as an agent id', () => {
    expect(detectSessionIdentifier('session about the login bug')).toBeNull()
    expect(detectSessionIdentifier('open session_123 please')).toBeNull()
  })

  it('extracts the id from a claude .jsonl path', () => {
    const input = `~/.claude/projects/-Users-daymade-workspace-md-huawei-green-energy/${CLAUDE_ID}.jsonl`
    expect(detectSessionIdentifier(input)).toEqual({ kind: 'path', sessionId: CLAUDE_ID })
  })

  it('extracts the id from a codex rollout .jsonl path', () => {
    const input = `~/.codex/sessions/2026/07/09/rollout-2026-07-09T11-25-00-${CODEX_ID}.jsonl`
    expect(detectSessionIdentifier(input)).toEqual({ kind: 'path', sessionId: CODEX_ID })
  })

  it('extracts the id from a bare filename ending in .jsonl (no directory)', () => {
    expect(detectSessionIdentifier(`${CLAUDE_ID}.jsonl`)).toEqual({ kind: 'path', sessionId: CLAUDE_ID })
  })

  it('does not derive projectEncoded from a path parent directory', () => {
    const input = `/anything/2026/${CODEX_ID}.jsonl`
    const match = detectSessionIdentifier(input)
    expect(match?.projectEncoded).toBeUndefined()
  })

  it('parses an app hash into projectEncoded + sessionId', () => {
    const input = `#/-Users-daymade-workspace-md-huawei-green-energy/${CLAUDE_ID}`
    expect(detectSessionIdentifier(input)).toEqual({
      kind: 'hash',
      projectEncoded: '-Users-daymade-workspace-md-huawei-green-energy',
      sessionId: CLAUDE_ID,
    })
  })

  it('returns null for prose, partial hex, and ordinary words', () => {
    expect(detectSessionIdentifier('fix the login bug')).toBeNull()
    expect(detectSessionIdentifier('04207f06')).toBeNull()
    expect(detectSessionIdentifier('04207f06-471e')).toBeNull()
    expect(detectSessionIdentifier('')).toBeNull()
    expect(detectSessionIdentifier('   ')).toBeNull()
  })
})

describe('isSessionUuid', () => {
  it('accepts canonical UUIDs and rejects fragments', () => {
    expect(isSessionUuid(CLAUDE_ID)).toBe(true)
    expect(isSessionUuid('not-a-uuid')).toBe(false)
    expect(isSessionUuid('04207f06')).toBe(false)
  })
})
