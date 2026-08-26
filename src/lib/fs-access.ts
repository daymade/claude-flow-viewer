import { createMinimalSessionMeta } from '../types/session'
import type { ProjectMeta, SessionMeta, SessionSource, ResolvedSessionRef } from '../types/session'
import type { SearchQueryOptions, SearchResult, SearchStats } from './search'
import type {
  SkillRecommendationAnalysis,
  SkillRecommendationAnalyzeOptions,
  SkillRecommendationBackendStatus,
} from './skill-recommendations'
import type { UserInputListOptions, UserInputListPayload } from './user-inputs'
import { quickScanMetadata, decodeProjectName, extractShortName, disambiguateShortNames } from './parser'
import {
  CODEX_PROJECT_PREFIX,
  CODEX_PREVIEW_BYTES,
  extractCodexSessionId,
  extractCodexShortName,
  isCodexProjectId,
  quickScanCodexMetadata,
} from './providers/codex'
import { isCherryStudioProjectId } from './providers/cherrystudio'
import { selectCodexRootSessions } from './codex-navigation'

const MAX_CLAUDE_SESSIONS_PER_PROJECT = 50
const MAX_CODEX_GROUPS_PER_PROJECT = 50
const CLAUDE_PREVIEW_BYTES = 4096
// Resolve reads a larger head than the scan preview (parity with the server RESOLVE_HEAD_BYTES) so
// CJK Claude sessions, which pack ~3 bytes/char, still yield meta in browser mode.
const RESOLVE_HEAD_BYTES = CLAUDE_PREVIEW_BYTES * 4
const CODEX_SCAN_CONCURRENCY = 24

type ScanSummary = {
  decodedName: string
  shortName: string
  sessions: SessionMeta[]
  totalSessionCount: number
  source: SessionSource
}

type CodexThreadIndexEntry = {
  threadName: string
  updatedAt: string
}

export interface FileStore {
  scanProjects(): Promise<ProjectMeta[]>
  readSessionContent(projectEncoded: string, sessionId: string): Promise<string>
  scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]>
  /** Read a tool-result overflow file. relativePath is like "tool-results/xxx.txt" */
  readToolResult(projectEncoded: string, sessionId: string, relativePath: string): Promise<string>
  searchSessions(query: string, options?: SearchQueryOptions): Promise<SearchResult[]>
  getSearchBackendStatus(): Promise<SearchBackendStatus>
  analyzeSkillRecommendations(options?: SkillRecommendationAnalyzeOptions): Promise<SkillRecommendationAnalysis>
  getSkillRecommendationBackendStatus(): Promise<SkillRecommendationBackendStatus>
  /** Server-backed cross-session user-input ledger. Browser/manual stores do not index all sessions. */
  listUserInputs?(options?: UserInputListOptions): Promise<UserInputListPayload>
  /** Optional browser/manual-mode notice for unsupported source layouts. */
  getBrowserModeNotice?(): Promise<string | null>
  /**
   * Resolve a session by identifier alone (bare id / `topic:` id), independent of the scanned
   * project list. Returns null when the id names no locatable session in this store. Optional
   * because browser/manual stores can only resolve claude/codex (never Cherry, which needs the
   * local server). SSOT for the "known-item" resolve lane.
   */
  resolveSession?(input: string): Promise<ResolvedSessionRef | null>
}

export function getCherryStudioBrowserModeNotice(): string {
  return 'Cherry Studio sessions are unavailable in browser-only file access mode because the browser/manual store cannot read the local agents.db database. Use npm run dev or npm run preview to load Cherry Studio sessions through the local Node/Vite API.'
}

/** Single inference of source from an encoded project id, used by every store's resolve path. */
function inferSourceFromProjectEncoded(projectEncoded: string): SessionSource {
  if (isCherryStudioProjectId(projectEncoded)) return 'cherrystudio'
  return isCodexProjectId(projectEncoded) ? 'codex' : 'claude'
}

/** Quick-scan a browser File/handle-backed session to populate meta for the resolve lane. */
async function quickScanBrowserFile(file: File, sessionId: string, source: SessionSource): Promise<SessionMeta> {
  if (source === 'codex') {
    const head = await file.slice(0, CODEX_PREVIEW_BYTES).text()
    const scanned = quickScanCodexMetadata(head, sessionId, file.size)?.meta
    if (scanned) return scanned
  } else {
    const head = await file.slice(0, RESOLVE_HEAD_BYTES).text()
    const scanned = quickScanMetadata(head, sessionId, file.size)
    if (scanned) return scanned
  }
  // Mirror the server: a located file always carries meta (best-effort mtime keeps sort order sane).
  return createMinimalSessionMeta(source, sessionId, file.size, file.lastModified)
}

export interface SearchBackendReadyStatus {
  available: true
  backend: 'sqlite'
  message?: string
  dbPath: string
  indexedAt: string | null
  stats: SearchStats
}

export interface SearchBackendUnavailableStatus {
  available: false
  backend: 'sqlite'
  reason: 'server-required'
  message: string
}

export type SearchBackendStatus = SearchBackendReadyStatus | SearchBackendUnavailableStatus

export function getUnavailableSearchStatus(): SearchBackendUnavailableStatus {
  return {
    available: false,
    backend: 'sqlite',
    reason: 'server-required',
    message: 'Search requires the local Node/Vite server API and is unavailable in browser-only file access mode.',
  }
}

export function getUnavailableSkillRecommendationStatus(): SkillRecommendationBackendStatus {
  return {
    available: false,
    backend: 'claude-code',
    reason: 'server-required',
    message: 'Claude-backed skill analysis requires the local Node/Vite server API and is unavailable in browser-only file access mode.',
  }
}

async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: string }
    return data.error || fallback
  } catch {
    return fallback
  }
}

function sortProjects(projects: ProjectMeta[]): ProjectMeta[] {
  return projects.sort((a, b) => {
    const aTime = a.sessions[0]?.startTime || ''
    const bTime = b.sessions[0]?.startTime || ''
    return bTime.localeCompare(aTime)
  })
}

function toProjects(projectMap: Map<string, ScanSummary>): ProjectMeta[] {
  const projects = Array.from(projectMap.entries()).map(([encodedName, summary]) => ({
    source: summary.source,
    encodedName,
    decodedName: summary.decodedName,
    shortName: summary.shortName,
    sessions: summary.sessions,
    totalSessionCount: summary.totalSessionCount,
  }))
  disambiguateProjectNames(projects)
  return sortProjects(projects)
}

function disambiguateProjectNames(projects: ProjectMeta[]) {
  disambiguateShortNames(projects.filter((project) => project.source === 'claude'))

  const codexGroups = new Map<string, ProjectMeta[]>()
  for (const project of projects) {
    if (project.source !== 'codex') continue
    const list = codexGroups.get(project.shortName)
    if (list) list.push(project)
    else codexGroups.set(project.shortName, [project])
  }

  for (const [, dupes] of codexGroups) {
    if (dupes.length <= 1) continue

    const used = new Set<string>()
    for (const project of dupes) {
      const parts = project.decodedName.replace(/\\/g, '/').split('/').filter(Boolean)
      const parent = parts[parts.length - 2]
      const candidate = parent ? `${project.shortName} (${parent})` : project.shortName
      if (!used.has(candidate)) {
        project.shortName = candidate
        used.add(candidate)
        continue
      }

      let suffix = 2
      let indexed = `${candidate} #${suffix}`
      while (used.has(indexed)) {
        suffix++
        indexed = `${candidate} #${suffix}`
      }
      project.shortName = indexed
      used.add(indexed)
    }
  }
}

function sortSessions(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
}

type ClaudFileEntry = { handle: FileSystemFileHandle; file: File }
type CodexFileEntry = { handle: FileSystemFileHandle; file: File }

function isCherryStudioManualPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some((segment) => /cherrystudio/i.test(segment) || segment === '.cherrystudio')) return true
  return segments.at(-1)?.toLowerCase() === 'agents.db'
}

async function *walkJsonlFiles(dirHandle: FileSystemDirectoryHandle): AsyncGenerator<CodexFileEntry> {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory') {
      yield * walkJsonlFiles(entry as FileSystemDirectoryHandle)
      continue
    }

    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    const handle = entry as FileSystemFileHandle
    yield { handle, file: await handle.getFile() }
  }
}

async function readFileHead(file: File, bytes: number): Promise<string> {
  return file.slice(0, bytes).text()
}

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

// --- File System Access API implementation ---

class FSAccessStore implements FileStore {
  private rootHandle: FileSystemDirectoryHandle
  private sessionFiles = new Map<string, FileSystemFileHandle>()
  private browserModeNoticePromise: Promise<string | null> | null = null

  constructor(rootHandle: FileSystemDirectoryHandle) {
    this.rootHandle = rootHandle
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    this.sessionFiles.clear()
    const projectMap = new Map<string, ScanSummary>()

    await Promise.all([
      this.scanClaudeProjects(projectMap),
      this.scanCodexProjects(projectMap),
    ])

    return toProjects(projectMap)
  }

  async scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]> {
    if (isCodexProjectId(projectEncoded)) {
      const projectMap = new Map<string, ScanSummary>()
      await this.scanCodexProjects(projectMap, projectEncoded)
      return projectMap.get(projectEncoded)?.sessions ?? []
    }

    const projectMap = new Map<string, ScanSummary>()
    await this.scanClaudeProjects(projectMap, projectEncoded)
    return projectMap.get(projectEncoded)?.sessions ?? []
  }

  async readSessionContent(projectEncoded: string, sessionId: string): Promise<string> {
    const cached = this.sessionFiles.get(`${projectEncoded}/${sessionId}`)
    if (cached) return (await cached.getFile()).text()

    if (isCodexProjectId(projectEncoded)) {
      await this.scanAllProjectSessions(projectEncoded)
      const fallback = this.sessionFiles.get(`${projectEncoded}/${sessionId}`)
      if (!fallback) throw new Error(`Session file not found: ${projectEncoded}/${sessionId}`)
      return (await fallback.getFile()).text()
    }

    const projectsDir = await this.findClaudeProjectsDir()
    const projectDir = await projectsDir.getDirectoryHandle(projectEncoded)
    const fileHandle = await projectDir.getFileHandle(`${sessionId}.jsonl`)
    return (await fileHandle.getFile()).text()
  }

  async readToolResult(projectEncoded: string, sessionId: string, relativePath: string): Promise<string> {
    if (isCodexProjectId(projectEncoded)) {
      throw new Error('Tool result files are not available for Codex sessions')
    }

    const projectsDir = await this.findClaudeProjectsDir()
    const projectDir = await projectsDir.getDirectoryHandle(projectEncoded)
    const sessionDir = await projectDir.getDirectoryHandle(sessionId)
    const parts = relativePath.split('/')
    let dir: FileSystemDirectoryHandle = sessionDir
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part)
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1])
    return (await fileHandle.getFile()).text()
  }

  async getBrowserModeNotice(): Promise<string | null> {
    if (!this.browserModeNoticePromise) {
      this.browserModeNoticePromise = this.detectBrowserModeNotice()
    }
    return this.browserModeNoticePromise
  }

  async resolveSession(input: string): Promise<ResolvedSessionRef | null> {
    const trimmed = input.trim()
    if (trimmed.startsWith('topic:')) return null // Cherry needs the local server (no agents.db in browser)
    const sessionId = trimmed.toLowerCase()
    if (this.sessionFiles.size === 0) await this.scanProjects()
    // sessionFiles is fully populated before any 50-cap slice, so old sessions resolve too.
    for (const [key, handle] of this.sessionFiles) {
      const idx = key.lastIndexOf('/')
      if (idx < 0 || key.slice(idx + 1).toLowerCase() !== sessionId) continue
      const projectEncoded = key.slice(0, idx)
      const source = inferSourceFromProjectEncoded(projectEncoded)
      if (source === 'cherrystudio') return null
      const meta = await quickScanBrowserFile(await handle.getFile(), sessionId, source)
      return { source, projectEncoded, sessionId, meta }
    }
    return null
  }

  async searchSessions(): Promise<SearchResult[]> {
    throw new Error(getUnavailableSearchStatus().message)
  }

  async getSearchBackendStatus(): Promise<SearchBackendStatus> {
    return getUnavailableSearchStatus()
  }

  async analyzeSkillRecommendations(): Promise<SkillRecommendationAnalysis> {
    throw new Error(getUnavailableSkillRecommendationStatus().message)
  }

  async getSkillRecommendationBackendStatus(): Promise<SkillRecommendationBackendStatus> {
    return getUnavailableSkillRecommendationStatus()
  }

  private async scanClaudeProjects(projectMap: Map<string, ScanSummary>, onlyProject?: string): Promise<void> {
    const projectsDir = await this.findClaudeProjectsDir().catch(() => null)
    if (!projectsDir) return

    for await (const projectHandle of projectsDir.values()) {
      if (projectHandle.kind !== 'directory') continue
      const dirHandle = projectHandle as FileSystemDirectoryHandle
      if (onlyProject && dirHandle.name !== onlyProject) continue

      const fileEntries: ClaudFileEntry[] = []
      for await (const entry of dirHandle.values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
        const handle = entry as FileSystemFileHandle
        const file = await handle.getFile()
        fileEntries.push({ handle, file })
        const sessionId = file.name.replace(/\.jsonl$/i, '')
        this.sessionFiles.set(`${dirHandle.name}/${sessionId}`, handle)
      }

      if (fileEntries.length === 0) continue

      fileEntries.sort((a, b) => b.file.lastModified - a.file.lastModified)
      const recent = onlyProject ? fileEntries : fileEntries.slice(0, MAX_CLAUDE_SESSIONS_PER_PROJECT)
      const sessions: SessionMeta[] = []

      for (const { file } of recent) {
        const sessionId = file.name.replace(/\.jsonl$/i, '')
        const head = await readFileHead(file, CLAUDE_PREVIEW_BYTES)
        const meta = quickScanMetadata(head, sessionId, file.size)
        if (meta) sessions.push(meta)
      }

      if (sessions.length === 0) continue

      projectMap.set(dirHandle.name, {
        source: 'claude',
        decodedName: decodeProjectName(dirHandle.name),
        shortName: extractShortName(dirHandle.name),
        sessions: sortSessions(sessions),
        totalSessionCount: fileEntries.length > MAX_CLAUDE_SESSIONS_PER_PROJECT ? fileEntries.length : sessions.length,
      })
    }
  }

  private async scanCodexProjects(projectMap: Map<string, ScanSummary>, onlyProject?: string): Promise<void> {
    const sessionsDir = await this.findCodexSessionsDir().catch(() => null)
    if (!sessionsDir) return

    const threadIndex = await this.readCodexSessionIndex()
    const entries: CodexFileEntry[] = []
    for await (const entry of walkJsonlFiles(sessionsDir)) {
      entries.push(entry)
    }

    entries.sort((a, b) => {
      const aSessionId = extractCodexSessionId(a.file.name)
      const bSessionId = extractCodexSessionId(b.file.name)
      const aTime = threadIndex.get(aSessionId)?.updatedAt || new Date(a.file.lastModified).toISOString()
      const bTime = threadIndex.get(bSessionId)?.updatedAt || new Date(b.file.lastModified).toISOString()
      return bTime.localeCompare(aTime)
    })

    const grouped = new Map<string, SessionMeta[]>()
    const names = new Map<string, string>()

    const scannedEntries = await mapInBatches(entries, CODEX_SCAN_CONCURRENCY, async ({ handle, file }) => {
      const sessionId = extractCodexSessionId(file.name)
      const indexEntry = threadIndex.get(sessionId)
      const head = await readFileHead(file, CODEX_PREVIEW_BYTES)
      const scanned = quickScanCodexMetadata(head, sessionId, file.size, indexEntry?.threadName)
      if (!scanned) return null
      if (onlyProject && scanned.projectEncoded !== onlyProject) return null
      return { handle, sessionId, scanned }
    })

    for (const { handle, sessionId, scanned } of scannedEntries) {
      const key = `${scanned.projectEncoded}/${sessionId}`
      this.sessionFiles.set(key, handle)

      if (!grouped.has(scanned.projectEncoded)) {
        grouped.set(scanned.projectEncoded, [])
        names.set(scanned.projectEncoded, scanned.cwd)
      }
      grouped.get(scanned.projectEncoded)!.push(scanned.meta)
    }

    for (const [encodedName, sessions] of grouped) {
      const decodedName = names.get(encodedName) || encodedName.slice(CODEX_PROJECT_PREFIX.length)
      const sorted = sortSessions(sessions)
      projectMap.set(encodedName, {
        source: 'codex',
        decodedName,
        shortName: extractCodexShortName(decodedName),
        sessions: onlyProject ? sorted : selectCodexRootSessions(sorted, MAX_CODEX_GROUPS_PER_PROJECT),
        totalSessionCount: sorted.length,
      })
    }
  }

  private async findClaudeProjectsDir(): Promise<FileSystemDirectoryHandle> {
    try {
      return await this.rootHandle.getDirectoryHandle('projects')
    } catch {
      // continue
    }

    try {
      const dotClaude = await this.rootHandle.getDirectoryHandle('.claude')
      return await dotClaude.getDirectoryHandle('projects')
    } catch {
      // continue
    }

    throw new Error('Cannot find ".claude/projects". Please select your home directory or the .claude directory.')
  }

  private async findCodexRootDir(): Promise<FileSystemDirectoryHandle> {
    try {
      await this.rootHandle.getDirectoryHandle('sessions')
      return this.rootHandle
    } catch {
      // continue
    }

    try {
      await this.rootHandle.getFileHandle('session_index.jsonl')
      return this.rootHandle
    } catch {
      // continue
    }

    try {
      return await this.rootHandle.getDirectoryHandle('.codex')
    } catch {
      // continue
    }

    throw new Error('Cannot find ".codex". Please select your home directory or the .codex directory.')
  }

  private async findCodexSessionsDir(): Promise<FileSystemDirectoryHandle> {
    const codexRoot = await this.findCodexRootDir()
    return codexRoot.getDirectoryHandle('sessions')
  }

  private async readCodexSessionIndex(): Promise<Map<string, CodexThreadIndexEntry>> {
    const index = new Map<string, CodexThreadIndexEntry>()
    try {
      const codexRoot = await this.findCodexRootDir()
      const fileHandle = await codexRoot.getFileHandle('session_index.jsonl')
      const content = await (await fileHandle.getFile()).text()
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
    } catch {
      // Index is optional and incomplete.
    }
    return index
  }

  private async detectBrowserModeNotice(): Promise<string | null> {
    if (await this.hasCherryStudioData()) {
      return getCherryStudioBrowserModeNotice()
    }
    return null
  }

  private async hasCherryStudioData(): Promise<boolean> {
    const candidates: string[][] = [
      ['agents.db'],
      ['Data', 'agents.db'],
      ['CherryStudio', 'Data', 'agents.db'],
      ['CherryStudioDev', 'Data', 'agents.db'],
      ['Library', 'Application Support', 'CherryStudio', 'Data', 'agents.db'],
      ['Library', 'Application Support', 'CherryStudioDev', 'Data', 'agents.db'],
    ]

    for (const parts of candidates) {
      if (await this.hasPath(parts)) return true
    }

    return false
  }

  private async hasPath(parts: string[]): Promise<boolean> {
    let current: FileSystemDirectoryHandle = this.rootHandle
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const isLeaf = index === parts.length - 1
      try {
        if (isLeaf) {
          await current.getFileHandle(part)
          return true
        }
        current = await current.getDirectoryHandle(part)
      } catch {
        return false
      }
    }

    return false
  }
}

// --- Input fallback implementation ---

class InputFallbackStore implements FileStore {
  private claudeFiles = new Map<string, File>()
  private codexFiles = new Map<string, File>()
  private codexSessionIndexFile: File | null = null
  private browserModeNotice: string | null = null

  constructor(files: FileList) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const path = file.webkitRelativePath.replace(/\\/g, '/')
      if (!path) continue

      if ((path.includes('/.claude/projects/') || path.startsWith('projects/')) && path.endsWith('.jsonl')) {
        const parts = path.split('/')
        const projectIdx = parts.indexOf('projects')
        if (projectIdx >= 0 && projectIdx + 2 < parts.length) {
          const projectEncoded = parts[projectIdx + 1]
          const sessionId = parts[projectIdx + 2].replace(/\.jsonl$/i, '')
          this.claudeFiles.set(`${projectEncoded}/${sessionId}`, file)
        }
        continue
      }

      if ((path.includes('/.codex/sessions/') || path.startsWith('sessions/')) && path.endsWith('.jsonl')) {
        const sessionId = extractCodexSessionId(file.name)
        this.codexFiles.set(sessionId, file)
        continue
      }

      if (isCherryStudioManualPath(path)) {
        this.browserModeNotice = getCherryStudioBrowserModeNotice()
      }

      if ((path.endsWith('/session_index.jsonl') || path === 'session_index.jsonl')
        && (path.includes('.codex/') || path === 'session_index.jsonl')) {
        this.codexSessionIndexFile = file
      }
    }
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    const projectMap = new Map<string, ScanSummary>()
    await Promise.all([
      this.scanClaudeProjects(projectMap),
      this.scanCodexProjects(projectMap),
    ])
    return toProjects(projectMap)
  }

  async scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]> {
    const projectMap = new Map<string, ScanSummary>()
    if (isCodexProjectId(projectEncoded)) {
      await this.scanCodexProjects(projectMap, projectEncoded)
    } else {
      await this.scanClaudeProjects(projectMap, projectEncoded)
    }
    return projectMap.get(projectEncoded)?.sessions ?? []
  }

  async readSessionContent(projectEncoded: string, sessionId: string): Promise<string> {
    const file = isCodexProjectId(projectEncoded)
      ? this.codexFiles.get(sessionId)
      : this.claudeFiles.get(`${projectEncoded}/${sessionId}`)
    if (!file) throw new Error(`Session file not found: ${projectEncoded}/${sessionId}`)
    return file.text()
  }

  async resolveSession(input: string): Promise<ResolvedSessionRef | null> {
    const trimmed = input.trim()
    if (trimmed.startsWith('topic:')) return null // Cherry needs the local server
    const sessionId = trimmed.toLowerCase()
    if (this.claudeFiles.size === 0 && this.codexFiles.size === 0) await this.scanProjects()
    // codex files are keyed by sessionId alone — recover the project from the file head. Report a
    // definitive result here rather than falling through to the claude loop (keyed differently, it
    // can never match a codex id and would turn a present file into a false miss).
    const codexFile = this.codexFiles.get(sessionId)
    if (codexFile) {
      const scanned = quickScanCodexMetadata(await codexFile.slice(0, CODEX_PREVIEW_BYTES).text(), sessionId, codexFile.size)
      return scanned
        ? { source: 'codex', projectEncoded: scanned.projectEncoded, sessionId, meta: scanned.meta }
        : null
    }
    // claude files are keyed by `${projectEncoded}/${sessionId}`.
    for (const [key, file] of this.claudeFiles) {
      const idx = key.lastIndexOf('/')
      if (idx < 0 || key.slice(idx + 1).toLowerCase() !== sessionId) continue
      const projectEncoded = key.slice(0, idx)
      const meta = await quickScanBrowserFile(file, sessionId, 'claude')
      return { source: 'claude', projectEncoded, sessionId, meta }
    }
    return null
  }

  async readToolResult(projectEncoded: string, sessionId: string, relativePath: string): Promise<string> {
    void projectEncoded
    void sessionId
    void relativePath
    throw new Error('Tool result files are not available in input fallback mode')
  }

  async getBrowserModeNotice(): Promise<string | null> {
    return this.browserModeNotice
  }

  async searchSessions(): Promise<SearchResult[]> {
    throw new Error(getUnavailableSearchStatus().message)
  }

  async getSearchBackendStatus(): Promise<SearchBackendStatus> {
    return getUnavailableSearchStatus()
  }

  async analyzeSkillRecommendations(): Promise<SkillRecommendationAnalysis> {
    throw new Error(getUnavailableSkillRecommendationStatus().message)
  }

  async getSkillRecommendationBackendStatus(): Promise<SkillRecommendationBackendStatus> {
    return getUnavailableSkillRecommendationStatus()
  }

  private async scanClaudeProjects(projectMap: Map<string, ScanSummary>, onlyProject?: string): Promise<void> {
    const grouped = new Map<string, Array<{ sessionId: string; file: File }>>()
    for (const [key, file] of this.claudeFiles) {
      const [projectEncoded, sessionId] = key.split('/')
      if (onlyProject && projectEncoded !== onlyProject) continue
      if (!grouped.has(projectEncoded)) grouped.set(projectEncoded, [])
      grouped.get(projectEncoded)!.push({ sessionId, file })
    }

    for (const [encodedName, files] of grouped) {
      files.sort((a, b) => b.file.lastModified - a.file.lastModified)
      const sessions: SessionMeta[] = []
      for (const { sessionId, file } of (onlyProject ? files : files.slice(0, MAX_CLAUDE_SESSIONS_PER_PROJECT))) {
        const head = file.slice(0, CLAUDE_PREVIEW_BYTES)
        const meta = quickScanMetadata(await head.text(), sessionId, file.size)
        if (meta) sessions.push(meta)
      }

      if (sessions.length === 0) continue

      projectMap.set(encodedName, {
        source: 'claude',
        decodedName: decodeProjectName(encodedName),
        shortName: extractShortName(encodedName),
        sessions: sortSessions(sessions),
        totalSessionCount: files.length,
      })
    }
  }

  private async scanCodexProjects(projectMap: Map<string, ScanSummary>, onlyProject?: string): Promise<void> {
    const threadIndex = await this.readCodexSessionIndex()
    const entries = Array.from(this.codexFiles.entries())

    entries.sort((a, b) => {
      const aTime = threadIndex.get(a[0])?.updatedAt || new Date(a[1].lastModified).toISOString()
      const bTime = threadIndex.get(b[0])?.updatedAt || new Date(b[1].lastModified).toISOString()
      return bTime.localeCompare(aTime)
    })

    const grouped = new Map<string, SessionMeta[]>()
    const names = new Map<string, string>()

    const scannedEntries = await mapInBatches(entries, CODEX_SCAN_CONCURRENCY, async ([sessionId, file]) => {
      const indexEntry = threadIndex.get(sessionId)
      const head = await readFileHead(file, CODEX_PREVIEW_BYTES)
      const scanned = quickScanCodexMetadata(head, sessionId, file.size, indexEntry?.threadName)
      if (!scanned) return null
      if (onlyProject && scanned.projectEncoded !== onlyProject) return null
      return scanned
    })

    for (const scanned of scannedEntries) {
      if (!grouped.has(scanned.projectEncoded)) {
        grouped.set(scanned.projectEncoded, [])
        names.set(scanned.projectEncoded, scanned.cwd)
      }
      grouped.get(scanned.projectEncoded)!.push(scanned.meta)
    }

    for (const [encodedName, sessions] of grouped) {
      const decodedName = names.get(encodedName) || encodedName.slice(CODEX_PROJECT_PREFIX.length)
      const sorted = sortSessions(sessions)
      projectMap.set(encodedName, {
        source: 'codex',
        decodedName,
        shortName: extractCodexShortName(decodedName),
        sessions: onlyProject ? sorted : selectCodexRootSessions(sorted, MAX_CODEX_GROUPS_PER_PROJECT),
        totalSessionCount: sorted.length,
      })
    }
  }

  private async readCodexSessionIndex(): Promise<Map<string, CodexThreadIndexEntry>> {
    const index = new Map<string, CodexThreadIndexEntry>()
    if (!this.codexSessionIndexFile) return index

    const content = await this.codexSessionIndexFile.text()
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
}

// --- API-based implementation (auto-load from Vite dev server) ---

class APIFileStore implements FileStore {
  private projectSources = new Map<string, SessionSource>()
  private initialProjects: ProjectMeta[] | null

  constructor(initialProjects: ProjectMeta[] | null = null) {
    this.initialProjects = initialProjects
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    const projects = this.initialProjects ?? await (async () => {
      const res = await fetch('/api/scan')
      if (!res.ok) throw new Error(`API scan failed: ${res.status}`)
      return res.json() as Promise<ProjectMeta[]>
    })()
    this.initialProjects = null
    this.rememberProjectSources(projects)
    return projects
  }

  async scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]> {
    const source = this.resolveProjectSource(projectEncoded)
    const res = await fetch(`/api/scan-project/${source}/${encodeURIComponent(projectEncoded)}`)
    if (!res.ok) throw new Error(`Project scan failed: ${res.status}`)
    return res.json()
  }

  async readSessionContent(projectEncoded: string, sessionId: string): Promise<string> {
    const source = this.resolveProjectSource(projectEncoded)
    const res = await fetch(`/api/session/${source}/${encodeURIComponent(projectEncoded)}/${encodeURIComponent(sessionId)}`)
    if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`)
    return res.text()
  }

  async readToolResult(projectEncoded: string, sessionId: string, relativePath: string): Promise<string> {
    const source = this.resolveProjectSource(projectEncoded)
    if (source === 'codex') throw new Error('Tool result files are not available for Codex sessions')
    const res = await fetch(`/api/tool-result/${source}/${encodeURIComponent(projectEncoded)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(relativePath)}`)
    if (!res.ok) throw new Error(`Tool result fetch failed: ${res.status}`)
    return res.text()
  }

  async searchSessions(query: string, options: SearchQueryOptions = {}): Promise<SearchResult[]> {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, options }),
    })
    if (!res.ok) throw new Error(`Search request failed: ${res.status}`)
    const data = await res.json() as { results: SearchResult[] }
    return data.results
  }

  async listUserInputs(options: UserInputListOptions = {}): Promise<UserInputListPayload> {
    const res = await fetch('/api/user-inputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options }),
    })
    if (!res.ok) throw new Error(`User input request failed: ${res.status}`)
    return res.json()
  }

  async getSearchBackendStatus(): Promise<SearchBackendStatus> {
    const res = await fetch('/api/search/status')
    if (!res.ok) throw new Error(`Search status request failed: ${res.status}`)
    return res.json()
  }

  async analyzeSkillRecommendations(options: SkillRecommendationAnalyzeOptions = {}): Promise<SkillRecommendationAnalysis> {
    const res = await fetch('/api/skill-recommendations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options }),
    })
    if (!res.ok) throw new Error(await readApiErrorMessage(res, `Skill recommendation request failed: ${res.status}`))
    return res.json()
  }

  async getSkillRecommendationBackendStatus(): Promise<SkillRecommendationBackendStatus> {
    const res = await fetch('/api/skill-recommendations/status')
    if (!res.ok) throw new Error(await readApiErrorMessage(res, `Skill recommendation status request failed: ${res.status}`))
    return res.json()
  }

  async getBrowserModeNotice(): Promise<string | null> {
    return null
  }

  async resolveSession(input: string): Promise<ResolvedSessionRef | null> {
    const res = await fetch(`/api/resolve-session?id=${encodeURIComponent(input)}`)
    // 404 (no such session) and 400 (invalid id) are genuine misses; a 5xx is a server error that
    // must surface as an error, not be flattened into "not found".
    if (res.status === 404 || res.status === 400) return null
    if (!res.ok) throw new Error(`Resolve failed: ${res.status}`)
    const ref = await res.json() as ResolvedSessionRef
    // Remember the resolved source so a later readSessionContent for a not-yet-scanned project
    // (e.g. beyond the 50-cap) picks the correct API route instead of guessing from the id.
    this.projectSources.set(ref.projectEncoded, ref.source)
    return ref
  }

  private rememberProjectSources(projects: ProjectMeta[]) {
    for (const project of projects) {
      this.projectSources.set(project.encodedName, project.source)
    }
  }

  private resolveProjectSource(projectEncoded: string): SessionSource {
    return this.projectSources.get(projectEncoded) ?? inferSourceFromProjectEncoded(projectEncoded)
  }
}

// --- Factory functions ---

export function supportsDirectoryPicker(): boolean {
  return 'showDirectoryPicker' in window
}

export async function openDirectoryPicker(): Promise<FileStore> {
  const handle = await window.showDirectoryPicker({ mode: 'read' })
  return new FSAccessStore(handle)
}

export function createStoreFromFiles(files: FileList): FileStore {
  return new InputFallbackStore(files)
}

export function createStoreFromHandle(handle: FileSystemDirectoryHandle): FileStore {
  return new FSAccessStore(handle)
}

export async function tryAutoLoad(): Promise<FileStore | null> {
  try {
    const res = await fetch('/api/scan')
    if (res.ok) {
      const projects = await res.json() as ProjectMeta[]
      return new APIFileStore(projects)
    }
  } catch {
    // API not available.
  }
  return null
}
