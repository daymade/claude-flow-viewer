import type { ProjectMeta, SessionMeta } from '../types/session'
import { scanSessionMetadata, quickScanMetadata, decodeProjectName, extractShortName, disambiguateShortNames } from './parser'

const MAX_SESSIONS_PER_PROJECT = 50
const PREVIEW_BYTES = 4096

export interface FileStore {
  scanProjects(): Promise<ProjectMeta[]>
  readSessionContent(projectEncoded: string, sessionId: string): Promise<string>
  scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]>
}

// --- File System Access API implementation ---

class FSAccessStore implements FileStore {
  private rootHandle: FileSystemDirectoryHandle
  constructor(rootHandle: FileSystemDirectoryHandle) {
    this.rootHandle = rootHandle
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    const projectsDir = await this.findProjectsDir()
    const projects: ProjectMeta[] = []

    for await (const projectHandle of projectsDir.values()) {
      if (projectHandle.kind !== 'directory') continue
      const dirHandle = projectHandle as FileSystemDirectoryHandle

      // Collect all jsonl file handles with basic File metadata (no content read)
      const fileEntries: { handle: FileSystemFileHandle; file: File }[] = []
      for await (const fh of dirHandle.values()) {
        if (fh.kind !== 'file' || !fh.name.endsWith('.jsonl')) continue
        const file = await (fh as FileSystemFileHandle).getFile()
        fileEntries.push({ handle: fh as FileSystemFileHandle, file })
      }

      if (fileEntries.length === 0) continue

      // Sort by lastModified descending, take most recent N
      fileEntries.sort((a, b) => b.file.lastModified - a.file.lastModified)
      const wasTruncated = fileEntries.length > MAX_SESSIONS_PER_PROJECT
      const recent = fileEntries.slice(0, MAX_SESSIONS_PER_PROJECT)

      // Read only first PREVIEW_BYTES of each file for metadata
      const sessions: import('../types/session').SessionMeta[] = []
      for (const { file } of recent) {
        const sessionId = file.name.replace('.jsonl', '')
        const headBlob = file.slice(0, PREVIEW_BYTES)
        const head = await headBlob.text()
        const meta = quickScanMetadata(head, sessionId, file.size)
        if (meta) sessions.push(meta)
      }

      if (sessions.length > 0) {
        sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
        const decoded = decodeProjectName(dirHandle.name)
        projects.push({
          encodedName: dirHandle.name,
          decodedName: decoded,
          shortName: extractShortName(dirHandle.name),
          sessions,
          totalSessionCount: wasTruncated ? fileEntries.length : sessions.length,
        })
      }
    }

    disambiguateShortNames(projects)

    return projects.sort((a, b) => {
      const aTime = a.sessions[0]?.startTime || ''
      const bTime = b.sessions[0]?.startTime || ''
      return bTime.localeCompare(aTime)
    })
  }

  async scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]> {
    const projectsDir = await this.findProjectsDir()
    const dirHandle = await projectsDir.getDirectoryHandle(projectEncoded)
    const sessions: import('../types/session').SessionMeta[] = []

    for await (const fh of dirHandle.values()) {
      if (fh.kind !== 'file' || !fh.name.endsWith('.jsonl')) continue
      const file = await (fh as FileSystemFileHandle).getFile()
      const sessionId = file.name.replace('.jsonl', '')
      const headBlob = file.slice(0, PREVIEW_BYTES)
      const head = await headBlob.text()
      const meta = quickScanMetadata(head, sessionId, file.size)
      if (meta) sessions.push(meta)
    }

    sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
    return sessions
  }

  async readSessionContent(projectEncoded: string, sessionId: string): Promise<string> {
    const projectsDir = await this.findProjectsDir()
    const projectDir = await projectsDir.getDirectoryHandle(projectEncoded)
    const fileHandle = await projectDir.getFileHandle(`${sessionId}.jsonl`)
    const file = await fileHandle.getFile()
    return file.text()
  }

  private async findProjectsDir(): Promise<FileSystemDirectoryHandle> {
    try {
      return await this.rootHandle.getDirectoryHandle('projects')
    } catch { /* not direct */ }

    try {
      const dotClaude = await this.rootHandle.getDirectoryHandle('.claude')
      return await dotClaude.getDirectoryHandle('projects')
    } catch { /* not parent either */ }

    throw new Error('Cannot find "projects" directory. Please select the .claude directory.')
  }
}

// --- Input fallback implementation ---

class InputFallbackStore implements FileStore {
  private fileMap = new Map<string, File>()

  constructor(files: FileList) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const path = file.webkitRelativePath
      if (!path.includes('/projects/') || !path.endsWith('.jsonl')) continue
      const parts = path.split('/')
      const projIdx = parts.indexOf('projects')
      if (projIdx < 0 || projIdx + 2 >= parts.length) continue
      const projectEncoded = parts[projIdx + 1]
      const sessionId = parts[projIdx + 2].replace('.jsonl', '')
      this.fileMap.set(`${projectEncoded}/${sessionId}`, file)
    }
  }

  async scanProjects(): Promise<ProjectMeta[]> {
    // Group files by project
    const projectFiles = new Map<string, { sessionId: string; file: File }[]>()
    for (const [key, file] of this.fileMap) {
      const [projectEncoded, sessionId] = key.split('/')
      if (!projectFiles.has(projectEncoded)) projectFiles.set(projectEncoded, [])
      projectFiles.get(projectEncoded)!.push({ sessionId, file })
    }

    const projects: ProjectMeta[] = []
    for (const [encoded, files] of projectFiles) {
      // Sort by lastModified descending, take most recent N
      files.sort((a, b) => b.file.lastModified - a.file.lastModified)
      const wasTruncated = files.length > MAX_SESSIONS_PER_PROJECT
      const recent = files.slice(0, MAX_SESSIONS_PER_PROJECT)

      const sessions: import('../types/session').SessionMeta[] = []
      for (const { sessionId, file } of recent) {
        const headBlob = file.slice(0, PREVIEW_BYTES)
        const head = await headBlob.text()
        const meta = quickScanMetadata(head, sessionId, file.size)
        if (meta) sessions.push(meta)
      }

      if (sessions.length > 0) {
        sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
        const decoded = decodeProjectName(encoded)
        projects.push({
          encodedName: encoded,
          decodedName: decoded,
          shortName: extractShortName(encoded),
          sessions,
          totalSessionCount: wasTruncated ? files.length : sessions.length,
        })
      }
    }

    disambiguateShortNames(projects)

    return projects.sort((a, b) => {
      const aTime = a.sessions[0]?.startTime || ''
      const bTime = b.sessions[0]?.startTime || ''
      return bTime.localeCompare(aTime)
    })
  }

  async scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]> {
    const sessions: import('../types/session').SessionMeta[] = []
    for (const [key, file] of this.fileMap) {
      const [proj, sessionId] = key.split('/')
      if (proj !== projectEncoded) continue
      const headBlob = file.slice(0, PREVIEW_BYTES)
      const head = await headBlob.text()
      const meta = quickScanMetadata(head, sessionId, file.size)
      if (meta) sessions.push(meta)
    }
    sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
    return sessions
  }

  async readSessionContent(projectEncoded: string, sessionId: string): Promise<string> {
    const file = this.fileMap.get(`${projectEncoded}/${sessionId}`)
    if (!file) throw new Error(`Session file not found: ${projectEncoded}/${sessionId}`)
    return file.text()
  }
}

// --- API-based implementation (auto-load from Vite dev server) ---

class APIFileStore implements FileStore {
  async scanProjects(): Promise<ProjectMeta[]> {
    const res = await fetch('/api/scan')
    if (!res.ok) throw new Error(`API scan failed: ${res.status}`)
    return res.json()
  }

  async scanAllProjectSessions(projectEncoded: string): Promise<SessionMeta[]> {
    const res = await fetch(`/api/scan-project/${encodeURIComponent(projectEncoded)}`)
    if (!res.ok) throw new Error(`Project scan failed: ${res.status}`)
    return res.json()
  }

  async readSessionContent(projectEncoded: string, sessionId: string): Promise<string> {
    const res = await fetch(`/api/session/${encodeURIComponent(projectEncoded)}/${encodeURIComponent(sessionId)}`)
    if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`)
    return res.text()
  }
}

// --- Factory functions ---

export async function tryAutoLoad(): Promise<FileStore | null> {
  try {
    const res = await fetch('/api/scan')
    if (res.ok) return new APIFileStore()
  } catch { /* API not available */ }
  return null
}

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
