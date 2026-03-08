import type { Plugin } from 'vite'
import fs from 'fs'
import path from 'path'
import os from 'os'

const MAX_SESSIONS_PER_PROJECT = 50
const PREVIEW_BYTES = 4096

export function claudeDataPlugin(): Plugin {
  const claudeDir = path.join(os.homedir(), '.claude')
  const projectsDir = path.join(claudeDir, 'projects')

  return {
    name: 'claude-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''

        if (url === '/api/scan') {
          scanAllProjects(projectsDir).then((projects) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(projects))
          }).catch((err) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          })
          return
        }

        if (url.startsWith('/api/scan-project/')) {
          const projectEncoded = decodeURIComponent(url.slice('/api/scan-project/'.length))
          scanAllProjectSessions(projectsDir, projectEncoded).then((sessions) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(sessions))
          }).catch((err) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          })
          return
        }

        if (url.startsWith('/api/tool-result/')) {
          const rest = url.slice('/api/tool-result/'.length)
          const parts = rest.split('/')
          if (parts.length < 3) {
            res.statusCode = 400
            res.end('Need /api/tool-result/:project/:session/:relativePath')
            return
          }
          const projectEncoded = decodeURIComponent(parts[0])
          const sessionId = decodeURIComponent(parts[1])
          const relativePath = decodeURIComponent(parts.slice(2).join('/'))
          // Validate path to prevent directory traversal
          if (relativePath.includes('..')) {
            res.statusCode = 400
            res.end('Invalid path')
            return
          }
          const filePath = path.join(projectsDir, projectEncoded, sessionId, relativePath)
          fs.promises.readFile(filePath, 'utf-8').then((content) => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end(content)
          }).catch(() => {
            res.statusCode = 404
            res.end('Tool result not found')
          })
          return
        }

        if (url.startsWith('/api/session/')) {
          const rest = url.slice('/api/session/'.length)
          const slashIdx = rest.indexOf('/')
          if (slashIdx < 0) {
            res.statusCode = 400
            res.end('Need /api/session/:project/:session')
            return
          }
          const projectEncoded = decodeURIComponent(rest.slice(0, slashIdx))
          const sessionId = decodeURIComponent(rest.slice(slashIdx + 1))
          const filePath = path.join(projectsDir, projectEncoded, `${sessionId}.jsonl`)
          fs.promises.readFile(filePath, 'utf-8').then((content) => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end(content)
          }).catch(() => {
            res.statusCode = 404
            res.end('Session not found')
          })
          return
        }

        next()
      })
    },
  }
}

// --- Fast scan: use fs metadata + first 4KB for preview ---

interface QuickMeta {
  id: string
  startTime: string
  startDisplay: string
  promptCount: number
  toolCount: number
  firstPromptPreview: string
  fileSize: number
  recordCount: number
}

async function scanAllProjects(projectsDir: string) {
  if (!fs.existsSync(projectsDir)) return []

  const projects = []
  const projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true })

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue

    const dirPath = path.join(projectsDir, dir.name)
    const files = await fs.promises.readdir(dirPath)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

    // Get stats for all files to sort by mtime
    const fileStats = await Promise.all(
      jsonlFiles.map(async (f) => {
        const stat = await fs.promises.stat(path.join(dirPath, f))
        return { name: f, mtime: stat.mtime, size: stat.size }
      })
    )

    // Sort by mtime descending, take most recent N
    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    const recent = fileStats.slice(0, MAX_SESSIONS_PER_PROJECT)

    const sessions: QuickMeta[] = []
    for (const { name, mtime, size } of recent) {
      const filePath = path.join(dirPath, name)
      const meta = await quickScanFile(filePath, name.replace('.jsonl', ''), mtime, size)
      if (meta) sessions.push(meta)
    }

    if (sessions.length > 0) {
      sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
      const decoded = decodeProjectName(dir.name)
      // Only report totalSessionCount > sessions.length when MAX limit actually truncated files
      const wasTruncated = fileStats.length > MAX_SESSIONS_PER_PROJECT
      projects.push({
        encodedName: dir.name,
        decodedName: decoded,
        shortName: extractShortName(dir.name),
        sessions,
        totalSessionCount: wasTruncated ? fileStats.length : sessions.length,
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

async function quickScanFile(filePath: string, sessionId: string, mtime: Date, fileSize: number): Promise<QuickMeta | null> {
  // Read only the first PREVIEW_BYTES bytes
  const fd = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(PREVIEW_BYTES)
    const { bytesRead } = await fd.read(buf, 0, PREVIEW_BYTES, 0)
    const head = buf.toString('utf-8', 0, bytesRead)

    let firstPromptPreview = ''
    let startTime: string | null = null

    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      let data: Record<string, unknown>
      try { data = JSON.parse(line) } catch { continue }

      // Extract timestamp from first parseable line
      if (!startTime) {
        const ts = data.timestamp
          || (data.snapshot as Record<string, unknown> | undefined)?.timestamp
          || (data.message as Record<string, unknown> | undefined)?.timestamp
        if (ts) startTime = typeof ts === 'string' ? ts : new Date(ts as number).toISOString()
      }

      // Find first real user prompt
      if (!firstPromptPreview && data.type === 'user' && !data.isMeta) {
        const preview = extractUserPreview(data)
        if (preview) {
          firstPromptPreview = preview
          break // Got what we need
        }
      }
    }

    // Use mtime as fallback for startTime
    if (!startTime) startTime = mtime.toISOString()
    if (!firstPromptPreview) return null

    const d = new Date(startTime)
    const pad = (n: number) => String(n).padStart(2, '0')
    const startDisplay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

    return {
      id: sessionId,
      startTime,
      startDisplay,
      promptCount: 0, // computed on full load
      toolCount: 0,
      firstPromptPreview,
      fileSize,
      recordCount: 0, // computed on full load
    }
  } finally {
    await fd.close()
  }
}

function isProtocolTag(text: string): boolean {
  return text.startsWith('<local-command') || text.startsWith('<command-')
    || text.startsWith('<teammate-message') || text.startsWith('<task-notification')
    || text.startsWith('<system-reminder>')
}

function extractUserPreview(data: Record<string, unknown>): string | null {
  const msg = data.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (typeof content === 'string') {
    const t = content.trim()
    if (t && !isProtocolTag(t)) {
      return t.slice(0, 100).replace(/\n/g, ' ')
    }
  }
  if (Array.isArray(content)) {
    if (content.every((c: unknown) => (c as Record<string, unknown>)?.type === 'tool_result')) return null
    for (const c of content) {
      const item = c as Record<string, unknown>
      if ((item.type === 'text' || item.type === 'input_text') && item.text) {
        const t = String(item.text).trim()
        if (t && !isProtocolTag(t)) {
          return t.slice(0, 100).replace(/\n/g, ' ')
        }
      }
    }
  }
  return null
}

function decodeProjectName(encoded: string): string {
  if (encoded.startsWith('-')) {
    // The encoding replaces '/' and non-ASCII chars with '-'.
    // We can only approximate: replace leading '-' with '/' then all '-' with '/'.
    // This is lossy (dashes in real names are also replaced), but acceptable for display.
    return '/' + encoded.slice(1).replaceAll('-', '/')
  }
  return encoded
}

function extractShortName(encoded: string): string {
  // Split by '-' and filter out empty segments (from consecutive dashes, e.g. Chinese chars)
  const segments = encoded.split('-').filter(Boolean)
  if (segments.length === 0) return encoded

  const last = segments[segments.length - 1]
  // If the last segment is meaningful enough (>= 3 chars), use it directly
  if (last.length >= 3) return last

  // Find the last 2 meaningful (>= 3 chars) segments, using the trailing short ones as suffix
  // e.g. [jeepay, plus, V3, 9, 2] → "jeepay/2" (last meaningful + last segment)
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i].length >= 3) {
      return segments[i] + '/' + last
    }
  }
  // All segments are short — just use the last one
  return last
}

function disambiguateShortNames(projects: Array<{ encodedName: string; shortName: string }>) {
  const countMap = new Map<string, number>()
  for (const p of projects) {
    countMap.set(p.shortName, (countMap.get(p.shortName) || 0) + 1)
  }

  for (const [name, count] of countMap) {
    if (count <= 1) continue
    const dupes = projects.filter(p => p.shortName === name)

    let disambiguated = false
    for (let depth = 1; depth <= 5; depth++) {
      const labels = dupes.map(p => {
        const segments = p.encodedName.split('-').filter(Boolean)
        const shortSegCount = name.split('/').length
        const parentIdx = segments.length - shortSegCount - depth
        return parentIdx >= 0 ? segments[parentIdx] : ''
      })
      const unique = new Set(labels)
      if (unique.size === dupes.length) {
        for (let i = 0; i < dupes.length; i++) {
          dupes[i].shortName = `${name} (${labels[i]})`
        }
        disambiguated = true
        break
      }
    }

    // If segments can't disambiguate (e.g. Chinese suffixes stripped), append index
    if (!disambiguated) {
      for (let i = 0; i < dupes.length; i++) {
        dupes[i].shortName = `${name} #${i + 1}`
      }
    }
  }
}

async function scanAllProjectSessions(projectsDir: string, projectEncoded: string): Promise<QuickMeta[]> {
  const dirPath = path.join(projectsDir, projectEncoded)
  if (!fs.existsSync(dirPath)) throw new Error(`Project not found: ${projectEncoded}`)

  const files = await fs.promises.readdir(dirPath)
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

  const fileStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const stat = await fs.promises.stat(path.join(dirPath, f))
      return { name: f, mtime: stat.mtime, size: stat.size }
    })
  )

  fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const sessions: QuickMeta[] = []
  for (const { name, mtime, size } of fileStats) {
    const filePath = path.join(dirPath, name)
    const meta = await quickScanFile(filePath, name.replace('.jsonl', ''), mtime, size)
    if (meta) sessions.push(meta)
  }

  sessions.sort((a, b) => b.startTime.localeCompare(a.startTime))
  return sessions
}
