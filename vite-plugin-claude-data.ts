import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { IncomingMessage } from 'node:http'

import type { ProjectMeta, SessionMeta, SessionSource } from './src/types/session'
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
import { listCherryStudioIndexedSessions, readCherryStudioSessionContent } from './server/cherrystudio/catalog'
import { ClaudeSkillRecommendationService } from './server/recommendations/claude-skill-recommendation-service'
import { SessionScanCache, getSessionScanCachePath } from './server/scan/session-scan-cache'
import type { SearchQueryOptions } from './src/lib/search'
import type { SkillRecommendationAnalyzeOptions } from './src/lib/skill-recommendations'

const MAX_CLAUDE_SESSIONS_PER_PROJECT = 50
const MAX_CODEX_GROUPS_PER_PROJECT = 50
const MAX_CHERRY_SESSIONS_PER_PROJECT = 50
const CLAUDE_PREVIEW_BYTES = 4096
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

type SkillRecommendationRequestBody = {
  options?: SkillRecommendationAnalyzeOptions
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
  const sessionScanCache = new SessionScanCache(getSessionScanCachePath(homeDir))
  const searchService = createSQLiteSearchService({
    claudeProjectsDir,
    codexRootDir,
    codexSessionsDir,
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

  const filePath = path.join(claudeProjectsDir, projectEncoded, `${sessionId}.jsonl`)
  return fs.promises.readFile(filePath, 'utf-8')
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
    const cached = sessionScanCache.get(filePath, stat)
    const scanned = cached?.source === 'codex'
      ? { cwd: cached.cwd, projectEncoded: cached.projectEncoded, meta: cached.meta }
      : quickScanCodexMetadata(await readHead(filePath, CODEX_PREVIEW_BYTES), sessionId, stat.size, indexEntry?.threadName)
    if (!scanned) return null
    if (onlyProject && scanned.projectEncoded !== onlyProject) return null
    if (!cached) {
      sessionScanCache.set(filePath, stat, {
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
