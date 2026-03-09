import { useState, useMemo, useEffect } from 'react'
import type { ProjectMeta } from '../../types/session'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

interface SidebarProps {
  projects: ProjectMeta[]
  activeSessionId: string | null
  activeProjectEncoded: string | null
  searchQuery: string
  activeHeatmap: number[] | null
  onSelectSession: (projectEncoded: string, sessionId: string) => void
  onLoadAllSessions: (projectEncoded: string) => void
}

export function Sidebar({ projects, activeSessionId, activeProjectEncoded, searchQuery, activeHeatmap, onSelectSession, onLoadAllSessions }: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>())

  // Auto-expand the project containing the active session, or first project on initial load
  useEffect(() => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (activeProjectEncoded && !prev.has(activeProjectEncoded)) {
        next.add(activeProjectEncoded)
      }
      if (next.size === 0 && projects.length > 0) {
        next.add(activeProjectEncoded || projects[0].encodedName)
      }
      return next.size === prev.size ? prev : next
    })
  }, [activeProjectEncoded, projects])

  const filteredProjects = useMemo(() => {
    if (!searchQuery) return projects
    const q = searchQuery.toLowerCase()
    return projects
      .map((p) => ({
        ...p,
        sessions: p.sessions.filter(
          (s) =>
            s.firstPromptPreview.toLowerCase().includes(q) ||
            s.startDisplay.includes(q) ||
            s.id.toLowerCase().includes(q)
        ),
      }))
      .filter((p) => p.sessions.length > 0)
  }, [projects, searchQuery])

  const toggleProject = (encodedName: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(encodedName)) next.delete(encodedName)
      else next.add(encodedName)
      return next
    })
  }

  return (
    <div className="flex flex-col">
      {filteredProjects.map((project) => {
        const isExpanded = expanded.has(project.encodedName) || Boolean(searchQuery)
        const isActiveProject = project.encodedName === activeProjectEncoded
        const sessionCount = project.sessions.length
        const totalCount = project.totalSessionCount
        const isTruncated = totalCount > sessionCount

        return (
          <div key={project.encodedName} className="border-b border-slate-100">
            {/* Project header */}
            <div
              className={`px-3 py-2.5 text-xs font-semibold cursor-pointer flex items-center gap-2 transition-colors group ${
                isActiveProject ? 'bg-violet-50/80' : 'bg-slate-50/80 hover:bg-slate-100'
              }`}
              onClick={() => toggleProject(project.encodedName)}
              title={`${project.decodedName}\n${sessionCount}/${totalCount} sessions loaded`}
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
                className={`text-slate-400 shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
              >
                <path d="M3 1l5 4-5 4V1z" />
              </svg>
              <span className="truncate text-slate-700 flex-1 min-w-0">{project.shortName}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 tabular-nums ${
                isActiveProject ? 'bg-violet-200 text-violet-700' : 'bg-slate-200 text-slate-500'
              }`}>
                {isTruncated ? `${sessionCount}/${totalCount}` : sessionCount}
              </span>
            </div>

            {/* Sessions list */}
            {isExpanded && (
              <div className="pb-1">
                {project.sessions.map((session) => {
                  const isActive = session.id === activeSessionId
                  return (
                    <div
                      key={session.id}
                      className={`mx-1.5 mb-0.5 px-2.5 py-2 cursor-pointer rounded-lg border-l-[3px] transition-all duration-100 ${
                        isActive
                          ? 'bg-violet-50 border-l-violet-600 shadow-sm shadow-violet-100'
                          : 'border-l-transparent hover:bg-slate-50'
                      }`}
                      onClick={() => onSelectSession(project.encodedName, session.id)}
                      title={`Session: ${session.id}\nFile: ${session.fileSize ? formatFileSize(session.fileSize) : '?'}\nRecords: ${session.recordCount || '?'}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-[11px] font-semibold text-slate-700">{session.startDisplay}</div>
                        {session.fileSize > 0 && (
                          <div className="text-[10px] text-slate-400 tabular-nums shrink-0">
                            {formatFileSize(session.fileSize)}
                          </div>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5 leading-snug">{session.firstPromptPreview}</div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400 tabular-nums font-mono">
                        {session.promptCount > 0 && (
                          <span>{session.promptCount}p</span>
                        )}
                        {session.toolCount > 0 && (
                          <span>{session.toolCount}t</span>
                        )}
                        {session.recordCount > 0 && (
                          <span>{session.recordCount}r</span>
                        )}
                        <span className="ml-auto text-slate-300">{session.id.slice(0, 8)}</span>
                      </div>
                      {isActive && activeHeatmap && activeHeatmap.length > 0 && (
                        <HeatmapBar values={activeHeatmap} />
                      )}
                    </div>
                  )
                })}
                {isTruncated && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onLoadAllSessions(project.encodedName) }}
                    className="mx-1.5 mb-0.5 px-2.5 py-2 w-[calc(100%-12px)] text-center text-[11px] text-violet-600 hover:bg-violet-50 rounded-lg cursor-pointer transition-colors font-medium"
                  >
                    Load all {totalCount} sessions (+{totalCount - sessionCount} more)
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function HeatmapBar({ values }: { values: number[] }) {
  const w = 100
  const h = 6
  const barWidth = Math.max(1, w / values.length)

  return (
    <svg width={w} height={h} className="mt-1.5 rounded-sm overflow-hidden" viewBox={`0 0 ${w} ${h}`}>
      <rect width={w} height={h} fill="#f1f5f9" />
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * barWidth}
          y={0}
          width={barWidth}
          height={h}
          fill={heatColor(v)}
        />
      ))}
    </svg>
  )
}

function heatColor(intensity: number): string {
  if (intensity < 0.1) return '#f1f5f9'
  if (intensity < 0.3) return '#bfdbfe'
  if (intensity < 0.5) return '#93c5fd'
  if (intensity < 0.7) return '#60a5fa'
  if (intensity < 0.9) return '#3b82f6'
  return '#2563eb'
}
