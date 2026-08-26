import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { createMinimalSessionMeta } from './src/types/session'
import type { ProjectMeta, SessionMeta, SessionSource, ResolvedSessionRef } from './src/types/session'
import { quickScanMetadata, decodeProjectName, extractShortName, disambiguateShortNames } from './src/lib/parser'
import {
  CODEX_PREVIEW_BYTES,
  extractCodexSessionId,
  extractCodexShortName,
  isCodexProjectId,
  quickScanCodexMetadata,
} from './src/lib/providers/codex'
import { selectCodexRootSessions } from './src/lib/codex-navigation'
import { createSQLiteSearchService } from './server/search/sqlite-search-service'
import { listCachedSessionFiles } from './server/search/session-catalog'
import { listCherryStudioIndexedSessions, readCherryStudioSessionContent } from './server/cherrystudio/catalog'
import { ClaudeSkillRecommendationService } from './server/recommendations/claude-skill-recommendation-service'
import { SessionScanCache, getSessionScanCachePath } from './server/scan/session-scan-cache'
import type { SearchQueryOptions } from './src/lib/search'
import type { SkillRecommendationAnalyzeOptions } from './src/lib/skill-recommendations'
import type { UserInputListOptions } from './src/lib/user-inputs'

const MAX_CLAUDE_SESSIONS_PER_PROJECT = 50
const MAX_CODEX_GROUPS_PER_PROJECT = 50
const MAX_CHERRY_SESSIONS_PER_PROJECT = 50
const CLAUDE_PREVIEW_BYTES = 4096
// The resolve probe reads a larger head than scan's character-slice: readHead counts BYTES, and CJK
// sessions pack ~3 bytes/char, so 4× keeps ≥4096 chars of coverage (parity with scan's content.slice)
// so quickScan finds the first user message and returns meta for the list upsert.
const RESOLVE_HEAD_BYTES = CLAUDE_PREVIEW_BYTES * 4
const CODEX_SCAN_CONCURRENCY = 24

type ScanSummary = {
  source: SessionSource
  decodedName: string
  shortName: string
  sessions: SessionMeta[]
  totalSessionCount: number
}

type CodexThreadIndexEntry = {
  threadName: string
  updatedAt: string
}

const codexSessionFileIndex = new Map<string, string>()
const codexProjectSessionCatalog = new Map<string, SessionMeta[]>()

type SearchRequestBody = {
  query?: string
  options?: SearchQueryOptions
}

type UserInputRequestBody = {
  options?: UserInputListOptions
}

type SkillRecommendationRequestBody = {
  options?: SkillRecommendationAnalyzeOptions
}

type ShareRequestBody = {
  title?: string
  html?: string
}

type MiddlewareRegistrar = (fn: (req: IncomingMessage & { url?: string; method?: string }, res: {
  setHeader(name: string, value: string): void
  end(body?: string): void
  statusCode: number
}, next: () => void) => void) => void

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < items.length; index += batchSize) {
    const chunk = items.slice(index, index + batchSize)
    const chunkResults = await Promise.all(chunk.map(fn))
    for (const result of chunkResults) {
      if (result !== null) results.push(result)
    }
  }
  return results
}

export function claudeDataPlugin(): Plugin {
  const homeDir = os.homedir()
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects')
  const codexRootDir = path.join(homeDir, '.codex')
  const codexSessionsDir = path.join(codexRootDir, 'sessions')
  const shareRootDir = path.join(homeDir, '.claude-flow-viewer', 'shares')
  const sessionScanCache = new SessionScanCache(getSessionScanCachePath(homeDir))
  const searchService = createSQLiteSearchService({
    claudeProjectsDir,
    codexRootDir,
    codexSessionsDir,
  }, undefined, {
    userInputSessionCatalog: () => listCachedSessionFiles({
      claudeProjectsDir,
      codexRootDir,
      codexSessionsDir,
    }, sessionScanCache),
  })
  const skillRecommendationService = new ClaudeSkillRecommendationService({
    claudeProjectsDir,
    codexRootDir,
    codexSessionsDir,
  })

  const installMiddleware = (registerMiddleware: MiddlewareRegistrar) => {
    registerMiddleware((req, res, next) => {
      const url = req.url || ''
      const pathname = getPathname(url)

      if (pathname === '/api/search/status') {
        searchService.getStatus().then((status) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            available: true,
            ...status,
          }))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname === '/api/share') {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end('Use POST /api/share')
          return
        }

        // Reject cross-site writes (CSRF): a present Origin must match the server host. A malicious
        // page's background POST carries its own Origin and is blocked here; same-origin viewer
        // requests and header-less local tools (curl) are allowed through.
        const shareHeaders = (req as IncomingMessage).headers ?? {}
        const shareOrigin = typeof shareHeaders.origin === 'string' ? shareHeaders.origin : ''
        if (shareOrigin) {
          let originHost = ''
          try { originHost = new URL(shareOrigin).host } catch { originHost = '' }
          if (!shareHeaders.host || originHost !== shareHeaders.host) {
            res.statusCode = 403
            res.end('Cross-origin share requests are not allowed')
            return
          }
        }

        readJsonBody(req).then(async (body) => {
          const payload = body as ShareRequestBody
          if (!payload.html || typeof payload.html !== 'string') {
            throw new Error('Missing HTML snapshot')
          }
          if (!/^<!doctype html>/i.test(payload.html.trim())) {
            throw new Error('Share payload must be a complete HTML document')
          }

          const id = crypto.randomUUID()
          const shareDir = path.join(shareRootDir, id)
          await fs.promises.mkdir(shareDir, { recursive: true })
          await fs.promises.writeFile(path.join(shareDir, 'index.html'), payload.html, 'utf-8')
          await fs.promises.writeFile(path.join(shareDir, 'meta.json'), JSON.stringify({
            id,
            title: payload.title || 'Decision Flow snapshot',
            createdAt: new Date().toISOString(),
          }, null, 2), 'utf-8')

          return { id, url: `/share/${id}/` }
        }).then((payload) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }).catch((err) => {
          res.statusCode = 500
          res.end(String(err.message || err))
        })
        return
      }

      if (pathname.startsWith('/share/')) {
        const id = pathname.slice('/share/'.length).split('/')[0]
        if (!/^[0-9a-f-]{36}$/i.test(id)) {
          res.statusCode = 404
          res.end('Share not found')
          return
        }

        const filePath = path.join(shareRootDir, id, 'index.html')
        fs.promises.readFile(filePath, 'utf-8').then((html) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          // Serve snapshots in a sandboxed, opaque origin. The snapshot's own scroll-to-top JS still
          // runs (allow-scripts), but any injected JS runs in a null origin — it cannot reach the
          // viewer's same-origin APIs (/api/session, /api/resolve-session, …), cookies, or storage,
          // which neutralizes a stored-XSS payload smuggled in via a CSRF POST to /api/share.
          res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-downloads')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.end(html)
        }).catch(() => {
          res.statusCode = 404
          res.end('Share not found')
        })
        return
      }

      if (pathname === '/api/search/refresh') {
        searchService.ensureFreshIndex(true).then(() => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname === '/api/search') {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end('Use POST /api/search')
          return
        }

        readJsonBody(req).then((body) => {
          const payload = body as SearchRequestBody
          return searchService.search(payload.query ?? '', payload.options ?? {})
        }).then((payload) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname === '/api/user-inputs') {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end('Use POST /api/user-inputs')
          return
        }

        readJsonBody(req).then((body) => {
          const payload = body as UserInputRequestBody
          return searchService.listUserInputs(payload.options ?? {})
        }).then((payload) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname === '/api/skill-recommendations/status') {
        skillRecommendationService.getStatus().then((status) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(status))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname === '/api/skill-recommendations') {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end('Use POST /api/skill-recommendations')
          return
        }

        readJsonBody(req).then((body) => {
          const payload = body as SkillRecommendationRequestBody
          return skillRecommendationService.analyzeRecentHistory(payload.options ?? {})
        }).then((payload) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname === '/api/import') {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end('Use POST /api/import')
          return
        }

        readJsonBody(req).then(async (body) => {
          const { files } = body as { files?: { name: string; content: string }[] }
          if (!files || !Array.isArray(files) || files.length === 0) {
            return { imported: 0, errors: ['No files provided'] }
          }

          const errors: string[] = []
          let imported = 0

          for (const file of files) {
            try {
              // Detect source and project from filename pattern
              // Claude format: {sessionId}.jsonl
              // We place it under a generic "imported" project
              const sessionId = file.name.replace(/\.jsonl?$/i, '')
              if (!sessionId) {
                errors.push(`Could not parse session ID from filename: ${file.name}`)
                continue
              }

              // Use a dedicated import project
              const importProjectDir = path.resolve(claudeProjectsDir, 'C--imported')
              fs.mkdirSync(importProjectDir, { recursive: true })

              const destPath = path.resolve(importProjectDir, file.name.endsWith('.jsonl') ? file.name : `${file.name}.jsonl`)
              fs.writeFileSync(destPath, file.content, 'utf-8')
              imported++
            } catch (err) {
              errors.push(`Failed to import ${file.name}: ${String(err)}`)
            }
          }

          return { imported, errors }
        }).then((result) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ imported: 0, errors: [String(err)] }))
        })
        return
      }

      if (pathname === '/api/scan') {
        scanAllProjects(claudeProjectsDir, codexRootDir, codexSessionsDir, sessionScanCache).then((projects) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(projects))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname.startsWith('/api/scan-project/')) {
        const rest = pathname.slice('/api/scan-project/'.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx < 0) {
          res.statusCode = 400
          res.end('Need /api/scan-project/:source/:project')
          return
        }

        const source = rest.slice(0, slashIdx) as SessionSource
        const projectEncoded = decodeURIComponent(rest.slice(slashIdx + 1))

        scanProjectSessions(source, projectEncoded, claudeProjectsDir, codexRootDir, codexSessionsDir, sessionScanCache).then((sessions) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(sessions))
        }).catch((err) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
        return
      }

      if (pathname.startsWith('/api/session/')) {
        const rest = pathname.slice('/api/session/'.length)
        const parts = rest.split('/')
        if (parts.length < 3) {
          res.statusCode = 400
          res.end('Need /api/session/:source/:project/:session')
          return
        }

        const source = parts[0] as SessionSource
        const projectEncoded = decodeURIComponent(parts[1])
        const sessionId = decodeURIComponent(parts.slice(2).join('/'))

        readSessionContent(source, projectEncoded, sessionId, claudeProjectsDir, codexSessionsDir).then((content) => {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(content)
        }).catch((err) => {
          res.statusCode = err instanceof NotFoundError ? 404 : 500
          res.end(String(err.message || err))
        })
        return
      }

      if (pathname === '/api/resolve-session') {
        let id: string | null = null
        try {
          id = new URL(url, 'http://localhost').searchParams.get('id')
        } catch {
          id = null
        }
        if (!id) {
          res.statusCode = 400
          res.end('Need ?id=<session id>')
          return
        }

        resolveSessionById(id, claudeProjectsDir, codexSessionsDir).then((ref) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(ref))
        }).catch((err) => {
          if (err instanceof ValidationError) {
            res.statusCode = 400
            res.end(String(err.message))
            return
          }
          res.statusCode = err instanceof NotFoundError ? 404 : 500
          res.end(String(err.message || err))
        })
        return
      }

      if (pathname.startsWith('/api/tool-result/')) {
        const rest = pathname.slice('/api/tool-result/'.length)
        const parts = rest.split('/')
        if (parts.length < 4) {
          res.statusCode = 400
          res.end('Need /api/tool-result/:source/:project/:session/:relativePath')
          return
        }

        const source = parts[0] as SessionSource
        const projectEncoded = decodeURIComponent(parts[1])
        const sessionId = decodeURIComponent(parts[2])
        const relativePath = decodeURIComponent(parts.slice(3).join('/'))

        if (source !== 'claude') {
          res.statusCode = 400
          res.end('Tool result files are only available for Claude sessions')
          return
        }

        if (relativePath.includes('..') || path.isAbsolute(relativePath)) {
          res.statusCode = 400
          res.end('Invalid path: directory traversal not allowed')
          return
        }

        const sessionDir = path.resolve(claudeProjectsDir, projectEncoded, sessionId)
        const filePath = path.resolve(sessionDir, relativePath)
        const relativeToSession = path.relative(sessionDir, filePath)
        if (relativeToSession.startsWith('..') || path.isAbsolute(relativeToSession)) {
          res.statusCode = 400
          res.end('Invalid path: outside session directory')
          return
        }

        fs.promises.readFile(filePath, 'utf-8').then((content) => {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(content)
        }).catch(() => {
          res.statusCode = 404
          res.end('Tool result not found')
        })
        return
      }

        next()
      })
  }

  return {
    name: 'claude-data',
    configureServer(server) {
      installMiddleware(server.middlewares.use.bind(server.middlewares))
    },
    configurePreviewServer(server) {
      installMiddleware(server.middlewares.use.bind(server.middlewares))
    },
  }
}

function getPathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname
  } catch {
    return url
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf-8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

async function scanAllProjects(
  claudeProjectsDir: string,
  codexRootDir: string,
  codexSessionsDir: string,
  sessionScanCache: SessionScanCache,
): Promise<ProjectMeta[]> {
  const projectMap = new Map<string, ScanSummary>()
  codexProjectSessionCatalog.clear()

  await sessionScanCache.load()
  await Promise.all([
    scanClaudeProjects(projectMap, claudeProjectsDir, sessionScanCache),
    scanCodexProjects(projectMap, codexRootDir, codexSessionsDir, sessionScanCache),
  ])
  await scanCherryStudioProjects(projectMap)
  await sessionScanCache.persist()

  return finalizeProjects(projectMap)
}

async function scanProjectSessions(
  source: SessionSource,
  projectEncoded: string,
  claudeProjectsDir: string,
  codexRootDir: string,
  codexSessionsDir: string,
  sessionScanCache: SessionScanCache,
): Promise<SessionMeta[]> {
  await sessionScanCache.load()
  if (source === 'codex') {
    const cached = codexProjectSessionCatalog.get(projectEncoded)
    if (cached) return cached

    const projectMap = new Map<string, ScanSummary>()
    await scanCodexProjects(projectMap, codexRootDir, codexSessionsDir, sessionScanCache, projectEncoded)
    await sessionScanCache.persist()
    return projectMap.get(projectEncoded)?.sessions ?? []
  }

  if (source === 'cherrystudio') {
    const projectMap = new Map<string, ScanSummary>()
    await scanCherryStudioProjects(projectMap, projectEncoded)
    return projectMap.get(projectEncoded)?.sessions ?? []
  }

  const projectMap = new Map<string, ScanSummary>()
  await scanClaudeProjects(projectMap, claudeProjectsDir, sessionScanCache, projectEncoded)
  await sessionScanCache.persist()
  return projectMap.get(projectEncoded)?.sessions ?? []
}

async function readSessionContent(
  source: SessionSource,
  projectEncoded: string,
  sessionId: string,
  claudeProjectsDir: string,
  codexSessionsDir: string,
): Promise<string> {
  if (source === 'cherrystudio') {
    return readCherryStudioSessionContent(sessionId, {
      homeDir: path.resolve(claudeProjectsDir, '..', '..'),
    })
  }

  if (source === 'codex' || isCodexProjectId(projectEncoded)) {
    const filePath = await resolveCodexSessionFile(codexSessionsDir, sessionId)
    return fs.promises.readFile(filePath, 'utf-8')
  }

  if (hasPathTraversal(projectEncoded) || hasPathTraversal(sessionId)) {
    throw new NotFoundError(`Invalid session path: ${projectEncoded}/${sessionId}`)
  }
  const filePath = path.join(claudeProjectsDir, projectEncoded, `${sessionId}.jsonl`)
  return fs.promises.readFile(filePath, 'utf-8')
}

class ValidationError extends Error {}

function hasPathTraversal(segment: string): boolean {
  return (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('..') ||
    segment.includes('\0') ||
    path.isAbsolute(segment)
  )
}

const RESOLVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Cherry Studio agent-session ids (agents.db `sessions.id`): session_<epoch-ms>_<random>. No path
// separators, so it is inherently traversal-safe.
const RESOLVE_CHERRY_AGENT_RE = /^session_\d{10,}_[a-z0-9]+$/i

/**
 * Server-side validation for /api/resolve-session. The endpoint is reachable directly (curl),
 * so it NEVER trusts the client detector — path-separator safety is enforced here. Returns a
 * Cherry `topic:` id (verbatim, separator-free), a Cherry agent id (`session_…`), or a strict
 * lowercased UUID; anything else throws ValidationError → 400.
 */
function normalizeResolveId(rawId: string): { kind: 'uuid' | 'topic' | 'cherry-agent'; id: string } {
  const trimmed = (rawId ?? '').trim()
  if (!trimmed) throw new ValidationError('Empty session id')

  if (trimmed.startsWith('topic:')) {
    const rest = trimmed.slice('topic:'.length)
    if (!rest || hasPathTraversal(rest)) throw new ValidationError('Invalid Cherry Studio topic id')
    return { kind: 'topic', id: trimmed }
  }

  if (RESOLVE_CHERRY_AGENT_RE.test(trimmed)) {
    return { kind: 'cherry-agent', id: trimmed }
  }

  // Accept a bare id / filename / full path, reduce to the basename, and require a strict UUID.
  // Anything that is not a canonical UUID (including anything with path separators) is rejected.
  const basename = trimmed.split(/[\\/]/).pop() ?? ''
  const uuid = basename.replace(/\.jsonl$/i, '').toLowerCase()
  if (!RESOLVE_UUID_RE.test(uuid)) {
    throw new ValidationError('Not a valid session identifier')
  }
  return { kind: 'uuid', id: uuid }
}

/**
 * Locate a session by identifier alone, independent of the scanned-list 50-cap. Probe order is
 * cheapest-first: claude (one stat per project dir) → cherry (30s-cached catalog) → codex (a full
 * ~/.codex tree-walk with no negative cache, so it must run last). Returns a populated meta so
 * callers can upsert it into the project list; misses throw NotFoundError → 404 (never a silent
 * fallback to some other session).
 */
async function resolveSessionById(
  rawId: string,
  claudeProjectsDir: string,
  codexSessionsDir: string,
): Promise<ResolvedSessionRef> {
  const normalized = normalizeResolveId(rawId)
  const homeDir = path.resolve(claudeProjectsDir, '..', '..')

  if (normalized.kind === 'topic' || normalized.kind === 'cherry-agent') {
    const cherry = await resolveCherrySessionById(normalized.id, homeDir)
    if (cherry) return cherry
    throw new NotFoundError(`No Cherry Studio session found: ${normalized.id}`)
  }

  const claude = await resolveClaudeSessionById(normalized.id, claudeProjectsDir)
  if (claude) return claude

  const cherry = await resolveCherrySessionById(normalized.id, homeDir)
  if (cherry) return cherry

  const codex = await resolveCodexSessionById(normalized.id, codexSessionsDir)
  if (codex) return codex

  throw new NotFoundError(`No session found with id: ${normalized.id}`)
}

async function resolveClaudeSessionById(
  sessionId: string,
  claudeProjectsDir: string,
): Promise<ResolvedSessionRef | null> {
  if (!fs.existsSync(claudeProjectsDir)) return null
  const entries = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true })
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  // De-prioritize the import target so an original session wins over its imported copy.
  const ordered = [
    ...dirNames.filter((n) => n !== 'C--imported'),
    ...dirNames.filter((n) => n === 'C--imported'),
  ]
  for (const dirName of ordered) {
    const filePath = path.join(claudeProjectsDir, dirName, `${sessionId}.jsonl`)
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(filePath)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const meta = quickScanMetadata(await readHead(filePath, RESOLVE_HEAD_BYTES), sessionId, stat.size)
      ?? createMinimalSessionMeta('claude', sessionId, stat.size, stat.mtimeMs)
    return { source: 'claude', projectEncoded: dirName, sessionId, meta }
  }
  return null
}

async function resolveCodexSessionById(
  sessionId: string,
  codexSessionsDir: string,
): Promise<ResolvedSessionRef | null> {
  // The whole probe is guarded: resolveCodexSessionFile may return a STALE cached path (the index
  // is only rebuilt on /api/scan), so stat/readHead can throw ENOENT for a since-deleted file.
  // Return null (→ eventual 404) instead of letting it propagate to a 500.
  try {
    const filePath = await resolveCodexSessionFile(codexSessionsDir, sessionId)
    const stat = await fs.promises.stat(filePath)
    const scanned = quickScanCodexMetadata(await readHead(filePath, RESOLVE_HEAD_BYTES), sessionId, stat.size)
    if (!scanned) return null
    return { source: 'codex', projectEncoded: scanned.projectEncoded, sessionId, meta: scanned.meta }
  } catch {
    return null
  }
}

async function resolveCherrySessionById(
  sessionId: string,
  homeDir: string,
): Promise<ResolvedSessionRef | null> {
  // Guarded: this probe runs BEFORE codex, so an IndexedDB-recovery throw here must not abort the
  // whole resolve (which would 500 and skip the codex probe). Treat any failure as a miss.
  try {
    const sessions = await listCherryStudioIndexedSessions({ homeDir })
    const hit = sessions.find((s) => s.sessionId === sessionId || s.meta.id === sessionId)
    if (!hit) return null
    return { source: 'cherrystudio', projectEncoded: hit.projectEncoded, sessionId: hit.sessionId, meta: hit.meta }
  } catch {
    return null
  }
}

async function scanCherryStudioProjects(
  projectMap: Map<string, ScanSummary>,
  onlyProject?: string,
): Promise<void> {
  const sessions = (await listCherryStudioIndexedSessions())
    .filter((session) => !onlyProject || session.projectEncoded === onlyProject)

  if (sessions.length === 0) return

  const grouped = new Map<string, SessionMeta[]>()
  const names = new Map<string, { decodedName: string; shortName: string }>()

  for (const session of sessions) {
    if (!grouped.has(session.projectEncoded)) {
      grouped.set(session.projectEncoded, [])
      names.set(session.projectEncoded, {
        decodedName: session.projectLabel,
        shortName: session.projectShortName,
      })
    }
    grouped.get(session.projectEncoded)!.push(session.meta)
  }

  for (const [encodedName, projectSessions] of grouped) {
    const named = names.get(encodedName)
    const sorted = sortSessions(projectSessions)
    projectMap.set(encodedName, {
      source: 'cherrystudio',
      decodedName: named?.decodedName ?? encodedName,
      shortName: named?.shortName ?? 'Cherry Studio',
      sessions: sorted.slice(0, MAX_CHERRY_SESSIONS_PER_PROJECT),
      totalSessionCount: sorted.length,
    })
  }
}

async function scanClaudeProjects(
  projectMap: Map<string, ScanSummary>,
  claudeProjectsDir: string,
  sessionScanCache: SessionScanCache,
  onlyProject?: string,
): Promise<void> {
  if (!fs.existsSync(claudeProjectsDir)) return

  const projectDirs = await fs.promises.readdir(claudeProjectsDir, { withFileTypes: true })
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue
    if (onlyProject && dir.name !== onlyProject) continue

    const dirPath = path.join(claudeProjectsDir, dir.name)
    const files = await fs.promises.readdir(dirPath)
    const jsonlFiles = files.filter((fileName) => fileName.endsWith('.jsonl'))
    if (jsonlFiles.length === 0) continue

    const fileStats = await Promise.all(jsonlFiles.map(async (fileName) => {
      const filePath = path.join(dirPath, fileName)
      const stat = await fs.promises.stat(filePath)
      return { fileName, filePath, mtimeMs: stat.mtimeMs, size: stat.size }
    }))

    fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const recent = fileStats.slice(0, MAX_CLAUDE_SESSIONS_PER_PROJECT)
    const sessions: SessionMeta[] = []

    for (const file of recent) {
      const cached = sessionScanCache.get(file.filePath, { mtimeMs: file.mtimeMs, size: file.size })
      if (cached?.source === 'claude') {
        sessions.push(cached.meta)
        continue
      }

      const content = await fs.promises.readFile(file.filePath, 'utf-8')
      const meta = quickScanMetadata(content.slice(0, CLAUDE_PREVIEW_BYTES), file.fileName.replace(/\.jsonl$/i, ''), file.size)
      if (!meta) continue
      meta.markers = countClaudeMarkers(content)
      sessionScanCache.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size }, { source: 'claude', meta })
      sessions.push(meta)
    }

    if (sessions.length === 0) continue

    projectMap.set(dir.name, {
      source: 'claude',
      decodedName: decodeProjectName(dir.name),
      shortName: extractShortName(dir.name),
      sessions: sortSessions(sessions),
      totalSessionCount: fileStats.length > MAX_CLAUDE_SESSIONS_PER_PROJECT ? fileStats.length : sessions.length,
    })
  }
}

async function scanCodexProjects(
  projectMap: Map<string, ScanSummary>,
  codexRootDir: string,
  codexSessionsDir: string,
  sessionScanCache: SessionScanCache,
  onlyProject?: string,
): Promise<void> {
  if (!fs.existsSync(codexSessionsDir)) return

  codexSessionFileIndex.clear()
  const threadIndex = await readCodexThreadIndex(codexRootDir)
  const filePaths: string[] = []
  for await (const filePath of walkJsonlFiles(codexSessionsDir)) {
    filePaths.push(filePath)
  }

  const statCache = new Map<string, { mtimeMs: number; size: number }>()
  await Promise.all(filePaths.map(async (filePath) => {
    const stat = await fs.promises.stat(filePath)
    statCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size })
  }))

  filePaths.sort((a, b) => {
    const aSessionId = extractCodexSessionId(path.basename(a))
    const bSessionId = extractCodexSessionId(path.basename(b))
    const aTime = threadIndex.get(aSessionId)?.updatedAt || new Date(statCache.get(a)?.mtimeMs || 0).toISOString()
    const bTime = threadIndex.get(bSessionId)?.updatedAt || new Date(statCache.get(b)?.mtimeMs || 0).toISOString()
    return bTime.localeCompare(aTime)
  })

  const grouped = new Map<string, SessionMeta[]>()
  const names = new Map<string, string>()

  const scannedEntries = await mapInBatches(filePaths, CODEX_SCAN_CONCURRENCY, async (filePath) => {
    const stat = statCache.get(filePath)
    if (!stat) return null
    const sessionId = extractCodexSessionId(path.basename(filePath))
    const indexEntry = threadIndex.get(sessionId)
    const scanStat = {
      ...stat,
      fingerprint: `${indexEntry?.threadName ?? ''}\n${indexEntry?.updatedAt ?? ''}`,
    }
    const cached = sessionScanCache.get(filePath, scanStat)
    const scanned = cached?.source === 'codex'
      ? { cwd: cached.cwd, projectEncoded: cached.projectEncoded, meta: cached.meta }
      : quickScanCodexMetadata(await readHead(filePath, CODEX_PREVIEW_BYTES), sessionId, stat.size, indexEntry?.threadName)
    if (!scanned) return null
    if (onlyProject && scanned.projectEncoded !== onlyProject) return null
    if (!cached) {
      sessionScanCache.set(filePath, scanStat, {
        source: 'codex',
        cwd: scanned.cwd,
        projectEncoded: scanned.projectEncoded,
        meta: scanned.meta,
      })
    }
    return { filePath, sessionId, scanned }
  })

  for (const { filePath, sessionId, scanned } of scannedEntries) {
    codexSessionFileIndex.set(sessionId, filePath)

    if (!grouped.has(scanned.projectEncoded)) {
      grouped.set(scanned.projectEncoded, [])
      names.set(scanned.projectEncoded, scanned.cwd)
    }
    grouped.get(scanned.projectEncoded)!.push(scanned.meta)
  }

    for (const [encodedName, sessions] of grouped) {
      const decodedName = names.get(encodedName) || encodedName
      const sorted = sortSessions(sessions)
      codexProjectSessionCatalog.set(encodedName, sorted)
      projectMap.set(encodedName, {
        source: 'codex',
        decodedName,
        shortName: extractCodexShortName(decodedName),
        sessions: onlyProject ? sorted : selectCodexRootSessions(sorted, MAX_CODEX_GROUPS_PER_PROJECT),
        totalSessionCount: sorted.length,
      })
    }
  }

async function readCodexThreadIndex(codexRootDir: string): Promise<Map<string, CodexThreadIndexEntry>> {
  const index = new Map<string, CodexThreadIndexEntry>()
  const indexPath = path.join(codexRootDir, 'session_index.jsonl')
  if (!fs.existsSync(indexPath)) return index

  const content = await fs.promises.readFile(indexPath, 'utf-8')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const data = JSON.parse(line) as Record<string, unknown>
      if (typeof data.id === 'string') {
        index.set(data.id, {
          threadName: typeof data.thread_name === 'string' ? data.thread_name : '',
          updatedAt: typeof data.updated_at === 'string' ? data.updated_at : '',
        })
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return index
}

async function resolveCodexSessionFile(codexSessionsDir: string, sessionId: string): Promise<string> {
  const cached = codexSessionFileIndex.get(sessionId)
  if (cached) return cached

  for await (const filePath of walkJsonlFiles(codexSessionsDir)) {
    const candidateId = extractCodexSessionId(path.basename(filePath))
    if (candidateId === sessionId) {
      codexSessionFileIndex.set(sessionId, filePath)
      return filePath
    }
  }

  throw new NotFoundError(`Codex session not found: ${sessionId}`)
}

function finalizeProjects(projectMap: Map<string, ScanSummary>): ProjectMeta[] {
  const projects = Array.from(projectMap.entries()).map(([encodedName, summary]) => ({
    source: summary.source,
    encodedName,
    decodedName: summary.decodedName,
    shortName: summary.shortName,
    sessions: summary.sessions,
    totalSessionCount: summary.totalSessionCount,
  }))

  disambiguateProjectNames(projects)

  return projects.sort((a, b) => {
    const aTime = a.sessions[0]?.startTime || ''
    const bTime = b.sessions[0]?.startTime || ''
    return bTime.localeCompare(aTime)
  })
}

function disambiguateProjectNames(projects: ProjectMeta[]) {
  disambiguateShortNames(projects.filter((project) => project.source === 'claude'))

  const groups = new Map<string, ProjectMeta[]>()
  for (const project of projects) {
    if (project.source !== 'codex') continue
    const list = groups.get(project.shortName)
    if (list) list.push(project)
    else groups.set(project.shortName, [project])
  }

  for (const [, dupes] of groups) {
    if (dupes.length <= 1) continue
    for (let index = 0; index < dupes.length; index++) {
      const project = dupes[index]
      const parts = project.decodedName.replace(/\\/g, '/').split('/').filter(Boolean)
      const parent = parts[parts.length - 2]
      project.shortName = parent ? `${project.shortName} (${parent})` : `${project.shortName} #${index + 1}`
    }
  }
}

function sortSessions(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
}

function countClaudeMarkers(content: string) {
  const compactMatches = content.match(/"subtype"\s*:\s*"compact_boundary"/g)
  const planMatches = content.match(/"EnterPlanMode"/g)
  const clearMatches = content.match(/<command-name>\/clear<\/command-name>/g)

  return {
    compacts: compactMatches?.length ?? 0,
    plans: planMatches?.length ?? 0,
    clears: clearMatches?.length ?? 0,
    forks: 0,
  }
}

async function readHead(filePath: string, bytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

async function *walkJsonlFiles(dirPath: string): AsyncGenerator<string> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      yield * walkJsonlFiles(entryPath)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield entryPath
    }
  }
}

class NotFoundError extends Error {}
