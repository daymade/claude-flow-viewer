import { createContext, useContext } from 'react'

export type ReadToolResult = (relativePath: string) => Promise<string>

/**
 * A tool-result loader plus the semantic identity of the resource it reads.
 * `scope` must stay stable for one logical session resource and change when
 * the resource changes:
 * - standalone viewer: `${source}/${projectEncoded}/${sessionId}`
 * - embed: `${endpoint}|${provider}|${sessionId}`
 * When `scope` is supplied, a fresh loader callback for the same resource
 * (e.g. an inline closure recreated each render) must NOT discard already
 * loaded output. When it is omitted, the loader identity is the only
 * identity signal and consumers conservatively invalidate on loader change.
 */
export interface ScopedToolResultReader {
  readToolResult: ReadToolResult
  scope?: string | null
}

export type SessionResourcesValue = ReadToolResult | ScopedToolResultReader

export const SessionResources = createContext<SessionResourcesValue | null>(null)
export const useSessionResources = () => useContext(SessionResources)

export function resolveToolResultReader(value: SessionResourcesValue | null): {
  read: ReadToolResult | null
  scope: string | null
} {
  if (!value) return { read: null, scope: null }
  if (typeof value === 'function') return { read: value, scope: null }
  return { read: value.readToolResult ?? null, scope: value.scope ?? null }
}
