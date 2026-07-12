import fs from 'node:fs'
import path from 'node:path'

import type { SessionMeta, SessionSource } from '../../src/types/session'

const CACHE_VERSION = 3

type CachedScanEntry =
  | {
      source: 'claude'
      meta: SessionMeta
    }
  | {
      source: 'codex'
      cwd: string
      projectEncoded: string
      meta: SessionMeta
    }

type PersistedCacheEntry = {
  version: number
  source: SessionSource
  mtimeMs: number
  size: number
  fingerprint?: string
  scan: CachedScanEntry
}

type PersistedCacheFile = {
  version: number
  entries: Record<string, PersistedCacheEntry>
}

function resolveCacheDir(homeDir: string): string {
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Caches', 'decision-flow-viewer')
  }

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local')
    return path.join(base, 'decision-flow-viewer')
  }

  const base = process.env.XDG_CACHE_HOME || path.join(homeDir, '.cache')
  return path.join(base, 'decision-flow-viewer')
}

export function getSessionScanCachePath(homeDir: string): string {
  return path.join(resolveCacheDir(homeDir), `session-scan-cache-v${CACHE_VERSION}.json`)
}

export class SessionScanCache {
  private readonly filePath: string
  private readonly entries = new Map<string, PersistedCacheEntry>()
  private loaded = false
  private dirty = false
  private loadPromise: Promise<void> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      try {
        const raw = await fs.promises.readFile(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw) as PersistedCacheFile
        if (parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
          return
        }

        for (const [filePath, entry] of Object.entries(parsed.entries)) {
          if (!entry || typeof entry !== 'object') continue
          if (entry.version !== CACHE_VERSION) continue
          this.entries.set(filePath, entry)
        }
      } catch {
        // Missing or malformed cache should not block scanning.
      } finally {
        this.loaded = true
        this.loadPromise = null
      }
    })()

    return this.loadPromise
  }

  get(filePath: string, stat: { mtimeMs: number; size: number; fingerprint?: string }): CachedScanEntry | null {
    const entry = this.entries.get(filePath)
    if (!entry) return null
    if (entry.version !== CACHE_VERSION) return null
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return null
    if ((entry.fingerprint ?? '') !== (stat.fingerprint ?? '')) return null
    return entry.scan
  }

  set(filePath: string, stat: { mtimeMs: number; size: number; fingerprint?: string }, scan: CachedScanEntry) {
    this.entries.set(filePath, {
      version: CACHE_VERSION,
      source: scan.source,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      fingerprint: stat.fingerprint,
      scan,
    })
    this.dirty = true
  }

  async persist(): Promise<void> {
    if (!this.loaded || !this.dirty) return

    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: PersistedCacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries.entries()),
    }
    await fs.promises.writeFile(this.filePath, JSON.stringify(payload), 'utf-8')
    this.dirty = false
  }
}
