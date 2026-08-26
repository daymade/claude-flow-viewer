import fs from 'node:fs'
import path from 'node:path'

import type { SessionMeta, SessionSource } from '../../src/types/session'
import { decodeProjectName, disambiguateShortNames, extractShortName, quickScanMetadata } from '../../src/lib/parser'
import { listCherryStudioIndexedSessions } from '../cherrystudio/catalog'
import type { CodexQuickScanResult } from '../../src/lib/codex-parser'
import {
  CODEX_PREVIEW_BYTES,
  extractCodexSessionId,
  extractCodexShortName,
  quickScanCodexMetadata,
} from '../../src/lib/providers/codex'
import type { SessionScanCache } from '../scan/session-scan-cache'

const CLAUDE_PREVIEW_BYTES = 4096

type CodexThreadIndexEntry = {
  threadName: string
  updatedAt: string
}

type ProjectNameEntry = {
  source: SessionSource
  encodedName: string
  decodedName: string
  shortName: string
}

export interface SearchRoots {
  claudeProjectsDir: string
  codexRootDir: string
  codexSessionsDir: string
}

export interface IndexedSessionFile {
  source: SessionSource
  projectEncoded: string
  projectLabel: string
  projectShortName: string
  sessionId: string
  filePath: string
  fileSize: number
  fileMtimeMs: number
  fingerprint: string
  meta: SessionMeta
  loadContent?: () => Promise<string>
}

type CodexScanCandidate = {
  filePath: string
  sessionId: string
  scanned: CodexQuickScanResult
  stat: fs.Stats
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

function disambiguateProjectEntries(entries: ProjectNameEntry[]) {
  const claudeProjects = entries
    .filter((entry) => entry.source === 'claude')
    .map((entry) => ({
      source: entry.source,
      encodedName: entry.encodedName,
      decodedName: entry.decodedName,
      shortName: entry.shortName,
      sessions: [],
      totalSessionCount: 0,
    }))

  disambiguateShortNames(claudeProjects)

  const resolvedClaude = new Map(claudeProjects.map((entry) => [entry.encodedName, entry.shortName]))
  for (const entry of entries) {
    if (entry.source === 'claude') {
      entry.shortName = resolvedClaude.get(entry.encodedName) ?? entry.shortName
    }
  }

  const codexGroups = new Map<string, ProjectNameEntry[]>()
  for (const entry of entries) {
    if (entry.source !== 'codex' && entry.source !== 'cherrystudio') continue
    const list = codexGroups.get(entry.shortName)
    if (list) list.push(entry)
    else codexGroups.set(entry.shortName, [entry])
  }

  for (const [, dupes] of codexGroups) {
    if (dupes.length <= 1) continue
    const used = new Set<string>()
    for (const entry of dupes) {
      const parts = entry.decodedName.replace(/\\/g, '/').split('/').filter(Boolean)
      const parent = parts[parts.length - 2]
      const candidate = parent ? `${entry.shortName} (${parent})` : entry.shortName
      if (!used.has(candidate)) {
        entry.shortName = candidate
        used.add(candidate)
        continue
      }

      let suffix = 2
      let indexed = `${candidate} #${suffix}`
      while (used.has(indexed)) {
        suffix += 1
        indexed = `${candidate} #${suffix}`
      }
      entry.shortName = indexed
      used.add(indexed)
    }
  }
}

export async function listIndexedSessionFiles(roots: SearchRoots): Promise<IndexedSessionFile[]> {
  const sessions: IndexedSessionFile[] = []
  const projectEntries = new Map<string, ProjectNameEntry>()

  if (fs.existsSync(roots.claudeProjectsDir)) {
    const projectDirs = await fs.promises.readdir(roots.claudeProjectsDir, { withFileTypes: true })
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue

      const encodedName = dir.name
      const decodedName = decodeProjectName(encodedName)
      projectEntries.set(`claude:${encodedName}`, {
        source: 'claude',
        encodedName,
        decodedName,
        shortName: extractShortName(encodedName),
      })

      const dirPath = path.join(roots.claudeProjectsDir, dir.name)
      const files = await fs.promises.readdir(dirPath)
      const jsonlFiles = files.filter((fileName) => fileName.endsWith('.jsonl'))
      for (const fileName of jsonlFiles) {
        const filePath = path.join(dirPath, fileName)
        const stat = await fs.promises.stat(filePath)
        const head = await readHead(filePath, CLAUDE_PREVIEW_BYTES)
        const sessionId = fileName.replace(/\.jsonl$/i, '')
        const meta = quickScanMetadata(head, sessionId, stat.size)
        if (!meta) continue

        sessions.push({
          source: 'claude',
          projectEncoded: encodedName,
          projectLabel: decodedName,
          projectShortName: extractShortName(encodedName),
          sessionId,
          filePath,
          fileSize: stat.size,
          fileMtimeMs: stat.mtimeMs,
          fingerprint: `${stat.mtimeMs}:${stat.size}`,
          meta,
        })
      }
    }
  }

  if (fs.existsSync(roots.codexSessionsDir)) {
    const threadIndex = await readCodexThreadIndex(roots.codexRootDir)
    const candidates: CodexScanCandidate[] = []

    for await (const filePath of walkJsonlFiles(roots.codexSessionsDir)) {
      const stat = await fs.promises.stat(filePath)
      const sessionId = extractCodexSessionId(path.basename(filePath))
      const head = await readHead(filePath, CODEX_PREVIEW_BYTES)
      const scanned = quickScanCodexMetadata(head, sessionId, stat.size, threadIndex.get(sessionId)?.threadName)
      if (!scanned) continue
      candidates.push({ filePath, sessionId, scanned, stat })

      projectEntries.set(`codex:${scanned.projectEncoded}`, {
        source: 'codex',
        encodedName: scanned.projectEncoded,
        decodedName: scanned.cwd,
        shortName: extractCodexShortName(scanned.cwd),
      })
    }

    for (const candidate of candidates) {
      sessions.push({
        source: 'codex',
        projectEncoded: candidate.scanned.projectEncoded,
        projectLabel: candidate.scanned.cwd,
        projectShortName: extractCodexShortName(candidate.scanned.cwd),
        sessionId: candidate.sessionId,
        filePath: candidate.filePath,
        fileSize: candidate.stat.size,
        fileMtimeMs: candidate.stat.mtimeMs,
        fingerprint: `${candidate.stat.mtimeMs}:${candidate.stat.size}`,
        meta: candidate.scanned.meta,
      })
    }
  }

  const cherrySessions = await listCherryStudioIndexedSessions({
    homeDir: path.resolve(roots.claudeProjectsDir, '..', '..'),
  })
  for (const session of cherrySessions) {
    sessions.push(session)
    projectEntries.set(`cherrystudio:${session.projectEncoded}`, {
      source: 'cherrystudio',
      encodedName: session.projectEncoded,
      decodedName: session.projectLabel,
      shortName: session.projectShortName,
    })
  }

  const projectList = [...projectEntries.values()]
  disambiguateProjectEntries(projectList)
  const resolvedNames = new Map(projectList.map((entry) => [`${entry.source}:${entry.encodedName}`, entry.shortName]))

  return sessions
    .map((session) => ({
      ...session,
      projectShortName: resolvedNames.get(`${session.source}:${session.projectEncoded}`) ?? session.projectShortName,
    }))
    .sort((left, right) => {
      const time = right.meta.startTime.localeCompare(left.meta.startTime)
      if (time !== 0) return time
      return left.sessionId.localeCompare(right.sessionId)
    })
}

/**
 * Fast session-identity catalog backed by the scan cache already populated during /api/scan.
 * Unlike listIndexedSessionFiles(), this does not stat and read the head of every history file.
 * Claude/Codex exact text and time still come from their input ledgers; Cherry content is parsed
 * from its own catalog. Cached metadata only supplies project/session identity.
 */
export async function listCachedSessionFiles(
  roots: SearchRoots,
  scanCache: SessionScanCache,
): Promise<IndexedSessionFile[]> {
  const sessions: IndexedSessionFile[] = []
  const projectEntries = new Map<string, ProjectNameEntry>()

  for (const entry of await scanCache.snapshot()) {
    const scan = entry.scan
    if (scan.source === 'claude') {
      const encodedName = path.basename(path.dirname(entry.filePath))
      const decodedName = decodeProjectName(encodedName)
      projectEntries.set(`claude:${encodedName}`, {
        source: 'claude',
        encodedName,
        decodedName,
        shortName: extractShortName(encodedName),
      })
      sessions.push({
        source: 'claude',
        projectEncoded: encodedName,
        projectLabel: decodedName,
        projectShortName: extractShortName(encodedName),
        sessionId: scan.meta.id,
        filePath: entry.filePath,
        fileSize: entry.size,
        fileMtimeMs: entry.mtimeMs,
        fingerprint: `${entry.mtimeMs}:${entry.size}`,
        meta: scan.meta,
      })
      continue
    }

    const shortName = extractCodexShortName(scan.cwd)
    projectEntries.set(`codex:${scan.projectEncoded}`, {
      source: 'codex',
      encodedName: scan.projectEncoded,
      decodedName: scan.cwd,
      shortName,
    })
    sessions.push({
      source: 'codex',
      projectEncoded: scan.projectEncoded,
      projectLabel: scan.cwd,
      projectShortName: shortName,
      sessionId: scan.meta.id,
      filePath: entry.filePath,
      fileSize: entry.size,
      fileMtimeMs: entry.mtimeMs,
      fingerprint: `${entry.mtimeMs}:${entry.size}`,
      meta: scan.meta,
    })
  }

  const cherrySessions = await listCherryStudioIndexedSessions({
    homeDir: path.resolve(roots.claudeProjectsDir, '..', '..'),
  })
  for (const session of cherrySessions) {
    sessions.push(session)
    projectEntries.set(`cherrystudio:${session.projectEncoded}`, {
      source: 'cherrystudio',
      encodedName: session.projectEncoded,
      decodedName: session.projectLabel,
      shortName: session.projectShortName,
    })
  }

  const projectList = [...projectEntries.values()]
  disambiguateProjectEntries(projectList)
  const resolvedNames = new Map(projectList.map((entry) => [`${entry.source}:${entry.encodedName}`, entry.shortName]))

  return sessions.map((session) => ({
    ...session,
    projectShortName: resolvedNames.get(`${session.source}:${session.projectEncoded}`) ?? session.projectShortName,
  }))
}
