import { useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionMessage, FilterState } from '../../types/session'
import { formatTokens } from '../../lib/timeline'
import { useAppState } from '../../hooks/useSessionStore'

const REMARK_PLUGINS = [remarkGfm]

// ━━━ L0: User Prompt ━━━ Chat Bubble ━━━

export function PromptBlock({ msg, searchQuery }: {
  msg: Extract<SessionMessage, { kind: 'user-prompt' }>
  searchQuery: string
}) {
  const matches = !searchQuery || msg.text.toLowerCase().includes(searchQuery.toLowerCase())

  let bubbleBg = 'bg-blue-50/80'
  let numColor = 'text-blue-400'
  let badge: React.ReactNode = null

  if (msg.decision === 'interrupt') {
    bubbleBg = 'bg-amber-50/80'
    numColor = 'text-amber-500'
    badge = <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 uppercase tracking-wide">Interrupt</span>
  } else if (msg.decision === 'correction') {
    bubbleBg = 'bg-rose-50/80'
    numColor = 'text-rose-500'
    badge = <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 uppercase tracking-wide">Decision</span>
  }

  return (
    <div
      data-prompt={msg.promptNum}
      className={`mt-14 mb-5 ml-auto w-fit max-w-[85%] ${bubbleBg} rounded-2xl rounded-br-sm px-5 py-4 shadow-sm scroll-mt-[30vh] transition-opacity prompt-enter ${
        matches ? 'opacity-100' : 'opacity-20'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`text-[11px] font-semibold ${numColor} tabular-nums`}>#{msg.promptNum}</span>
        {badge}
        <span className="text-[10px] text-gray-400 font-mono ml-auto tabular-nums">{msg.time}</span>
      </div>
      <div className="text-[15px] leading-[1.75] whitespace-pre-wrap break-words text-gray-800">{msg.text}</div>
      {msg.images.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {msg.images.map((img, i) => (
            <a key={i} href={img.dataUrl} target="_blank" rel="noopener noreferrer" className="block">
              <img
                src={img.dataUrl}
                alt={`Attached image ${i + 1}`}
                className="max-w-full max-h-[400px] rounded-xl border border-white/50 shadow-sm cursor-zoom-in"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ━━━ L1: AI Text ━━━ Main Content ━━━

export function AiTextBlock({ msg }: { msg: Extract<SessionMessage, { kind: 'ai-text' }> }) {
  return (
    <div className="mt-3 mb-2 pl-6 pr-2 text-[15px] leading-[1.8] text-gray-700 break-words prose prose-gray max-w-none prose-p:my-2 prose-headings:mt-5 prose-headings:mb-2.5 prose-headings:text-gray-900 prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:text-sm prose-pre:leading-relaxed prose-pre:rounded-md prose-code:text-sm prose-code:bg-gray-100 prose-code:text-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-table:text-sm [&_table]:block [&_table]:overflow-x-auto prose-th:px-3 prose-th:py-2 prose-th:bg-gray-50 prose-th:text-left prose-th:whitespace-nowrap prose-td:px-3 prose-td:py-2 prose-td:border-gray-200 prose-td:whitespace-nowrap prose-blockquote:border-l-gray-300 prose-blockquote:text-gray-600 prose-hr:my-5 prose-img:rounded-md prose-strong:text-gray-900">
      <Markdown remarkPlugins={REMARK_PLUGINS}>{msg.text}</Markdown>
    </div>
  )
}

// ━━━ L2: AI Thinking ━━━ Collapsed ━━━

export function ThinkingHint({ msg }: { msg: Extract<SessionMessage, { kind: 'ai-thinking' }> }) {
  return (
    <details className="mt-1.5 ml-6">
      <summary className="cursor-pointer py-1 text-xs text-gray-400 italic select-none hover:text-gray-500 transition-colors flex items-center gap-1.5 whitespace-nowrap">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-50">
          <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate min-w-0 max-w-[600px]">{msg.preview}...</span>
      </summary>
      <pre className="mt-1 p-4 bg-gray-50 rounded-md text-[13px] max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-gray-500 leading-relaxed">{msg.full}</pre>
    </details>
  )
}

// ━━━ L3: Tool Call ━━━

export function ToolCallLine({ msg }: { msg: Extract<SessionMessage, { kind: 'ai-tool-use' }> }) {
  const isAgent = msg.name === 'Agent' || msg.name === 'Task'

  if (isAgent) {
    const agentType = String(msg.input.subagent_type || msg.input.type || 'general')
    const desc = String(msg.input.description || '')
    const prompt = String(msg.input.prompt || '')
    return (
      <details className="mt-2 ml-6">
        <summary className="cursor-pointer py-1 text-sm text-gray-500 select-none hover:text-gray-700 transition-colors flex items-center gap-2 whitespace-nowrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 shrink-0">
            <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[11px] font-medium uppercase shrink-0">{agentType}</span>
          <span className="truncate min-w-0 font-medium">{desc || msg.summary}</span>
        </summary>
        {prompt && (
          <div className="mt-1 ml-6 pl-3 border-l border-gray-200 py-2 text-xs text-gray-500 leading-relaxed max-h-[200px] overflow-auto whitespace-pre-wrap break-words">{prompt.slice(0, 500)}{prompt.length > 500 ? '...' : ''}</div>
        )}
      </details>
    )
  }

  return (
    <details className="mt-0.5 ml-6">
      <summary className="cursor-pointer py-1 text-sm text-gray-500 font-mono select-none hover:text-gray-700 transition-colors flex items-center gap-1.5 whitespace-nowrap">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 shrink-0">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate min-w-0">{msg.summary}</span>
      </summary>
      <pre className="mt-1 ml-5 p-3 bg-gray-50 rounded text-[13px] max-h-[200px] overflow-auto leading-relaxed text-gray-500">{truncateInput(msg.input)}</pre>
    </details>
  )
}

// ━━━ L4: Tool Result ━━━

export function ToolResultBlock({ msg }: { msg: Extract<SessionMessage, { kind: 'tool-result' }> }) {
  const { state } = useAppState()
  const [fullContent, setFullContent] = useState<string | null>(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadFull = useCallback(async () => {
    if (!msg.externalFile || !state.fileStore || !state.activeProjectEncoded || !state.activeSessionId) return
    setLoadingFull(true)
    setLoadError(null)
    try {
      // externalFile is "tool-results/filename.txt" (relative to session dir)
      const content = await state.fileStore.readToolResult(
        state.activeProjectEncoded,
        state.activeSessionId,
        msg.externalFile,
      )
      setFullContent(content)
    } catch {
      setLoadError('Failed to load full content')
    } finally {
      setLoadingFull(false)
    }
  }, [msg.externalFile, state.fileStore, state.activeProjectEncoded, state.activeSessionId])

  const displayContent = fullContent ?? msg.content
  const hasExternal = Boolean(msg.externalFile)
  const showingFull = fullContent !== null

  return (
    <details className="ml-6">
      <summary className={`cursor-pointer py-0.5 pl-5 text-xs select-none transition-colors flex items-center gap-1.5 whitespace-nowrap ${
        msg.isError ? 'text-red-500 hover:text-red-600' : 'text-gray-400 hover:text-gray-500'
      }`}>
        {msg.isError ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
            <circle cx="12" cy="12" r="10" /><path d="m15 9-6 6m0-6 6 6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span>{msg.isError ? 'Error' : 'Result'}</span>
        {hasExternal && !showingFull && (
          <span className="text-amber-500 font-normal ml-1">({msg.totalSize} on disk)</span>
        )}
      </summary>
      <pre className={`mt-0.5 ml-5 p-3 rounded text-[13px] max-h-[400px] overflow-auto whitespace-pre-wrap break-words leading-relaxed ${
        msg.isError ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-500'
      }`}>{displayContent}</pre>
      {hasExternal && !showingFull && (
        <div className="ml-5 mt-1">
          <button
            onClick={loadFull}
            disabled={loadingFull}
            className="text-xs text-blue-500 hover:text-blue-700 hover:underline disabled:text-gray-400"
          >
            {loadingFull ? 'Loading...' : `Load full output (${msg.totalSize})`}
          </button>
          {loadError && <span className="text-xs text-red-500 ml-2">{loadError}</span>}
        </div>
      )}
      {showingFull && (
        <div className="ml-5 mt-1">
          <button
            onClick={() => setFullContent(null)}
            className="text-xs text-gray-400 hover:text-gray-600 hover:underline"
          >
            Collapse to preview
          </button>
        </div>
      )}
    </details>
  )
}

// ─── Team Message ───

const TEAM_COLORS: Record<string, { badge: string; border: string }> = {
  green:  { badge: 'bg-emerald-100 text-emerald-700', border: 'border-l-emerald-400' },
  blue:   { badge: 'bg-sky-100 text-sky-700', border: 'border-l-sky-400' },
  purple: { badge: 'bg-purple-100 text-purple-700', border: 'border-l-purple-400' },
}

export function TeamMessageBlock({ msg }: { msg: Extract<SessionMessage, { kind: 'team-message' }> }) {
  const palette = TEAM_COLORS[msg.color] || TEAM_COLORS.blue

  if (msg.isProtocol) {
    return (
      <div className="mt-1.5 ml-6 py-1 flex items-center gap-2 text-xs text-gray-400 whitespace-nowrap">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${palette.badge}`}>{msg.from}</span>
        <span className="italic truncate min-w-0">{msg.summary || msg.content.slice(0, 80)}</span>
      </div>
    )
  }

  return (
    <details className="mt-2.5 ml-6">
      <summary className={`cursor-pointer border-l-2 ${palette.border} pl-3 py-2 flex items-center gap-2 select-none hover:bg-gray-50 rounded-r transition-colors whitespace-nowrap`}>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${palette.badge}`}>{msg.from}</span>
        <span className="text-sm text-gray-600 truncate min-w-0">{msg.summary || msg.content.slice(0, 80)}</span>
      </summary>
      <pre className="ml-[2px] pl-3 border-l border-gray-200 mt-1 py-2 text-[13px] max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-gray-600 leading-relaxed">{msg.content}</pre>
    </details>
  )
}

// ─── Task Event ───

export function TaskEventBlock({ msg }: { msg: Extract<SessionMessage, { kind: 'task-event' }> }) {
  return (
    <div className="mt-1.5 ml-6 py-1 flex items-center gap-2 text-xs text-gray-400 whitespace-nowrap">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-mono text-gray-500 shrink-0">Task #{msg.taskId}</span>
      <span className="shrink-0">{msg.status}</span>
      {msg.summary && <span className="truncate min-w-0">{msg.summary}</span>}
    </div>
  )
}

// ─── Fork Indicator ───

export function ForkIndicator({ msg, filter, searchQuery, MessageBlock }: {
  msg: Extract<SessionMessage, { kind: 'fork-indicator' }>
  filter: FilterState
  searchQuery: string
  MessageBlock: React.ComponentType<{ msg: SessionMessage; filter: FilterState; searchQuery: string }>
}) {
  const isToolError = msg.reason === 'tool-error'

  return (
    <div className={`my-8 rounded-lg border overflow-hidden ${
      isToolError
        ? 'border-gray-200 bg-gray-50/30'
        : 'border-amber-200 bg-amber-50/30'
    }`}>
      <details>
        <summary className={`cursor-pointer px-5 py-3 flex items-center gap-3 select-none group transition-colors whitespace-nowrap ${
          isToolError ? 'hover:bg-gray-50/60' : 'hover:bg-amber-50/60'
        }`}>
          {isToolError ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 shrink-0">
              <path d="M4 4l7.07 17 2.51-7.39L21 11.07z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            /* Branching tree icon — decision tree metaphor */
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500 shrink-0">
              <circle cx="12" cy="5" r="2.5" />
              <circle cx="6" cy="19" r="2.5" />
              <circle cx="18" cy="19" r="2.5" />
              <path d="M12 7.5V12M12 12L6 16.5M12 12L18 16.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span className={`text-sm font-semibold shrink-0 ${
            isToolError ? 'text-gray-500' : 'text-amber-700'
          }`}>{isToolError ? 'Retried' : 'Decision Point'}</span>
          <span className={`text-xs font-mono shrink-0 tabular-nums ${
            isToolError ? 'text-gray-400' : 'text-amber-600/70'
          }`}>{msg.timestamp}</span>
          <span className={`ml-auto text-xs shrink-0 ${
            isToolError ? 'text-gray-400' : 'text-amber-600/60'
          }`}>
            {msg.abandonedMessages.length} rejected message{msg.abandonedMessages.length !== 1 ? 's' : ''}
          </span>
        </summary>

        <div className="px-5 pb-3">
          <div className={`text-xs mb-2 italic ${
            isToolError ? 'text-gray-400' : 'text-amber-600/70'
          }`}>
            {isToolError
              ? 'Tool call failed; retried with a different approach.'
              : 'The expert interrupted and chose a different approach below.'}
          </div>
          {msg.abandonedPreview && (
            <div className="text-xs text-gray-500 mb-2 truncate">
              Preview: "{msg.abandonedPreview}..."
            </div>
          )}
          {/* Branching visual: dashed connector + abandoned branch */}
          <div className="relative">
            {!isToolError && (
              <div className="absolute left-[7px] top-0 bottom-0 w-px border-l-2 border-dashed border-amber-300/40" />
            )}
            <div className={`pl-5 opacity-60 ${
              isToolError ? 'border-l-2 border-gray-300/60 pl-4' : ''
            }`}>
              {msg.abandonedMessages.map((m, i) => (
                <MessageBlock key={i} msg={m} filter={filter} searchQuery={searchQuery} />
              ))}
            </div>
          </div>
        </div>
      </details>
    </div>
  )
}

// ─── Clear Divider ───

export function ClearDivider({ msg }: { msg: Extract<SessionMessage, { kind: 'clear-divider' }> }) {
  return (
    <div className="my-12 flex items-center gap-3">
      <div className="flex-1 h-px bg-gray-300" />
      <span className="text-[11px] text-gray-400 font-medium uppercase tracking-widest">
        Context Cleared · <span className="font-mono normal-case tracking-normal">{msg.timestamp}</span>
      </span>
      <div className="flex-1 h-px bg-gray-300" />
    </div>
  )
}

// ─── Compact Boundary Divider ───

export function CompactBoundaryDivider({ msg }: { msg: Extract<SessionMessage, { kind: 'compact-boundary' }> }) {
  const tokenDisplay = msg.preTokens > 0
    ? `${formatTokens(msg.preTokens)} tokens`
    : null

  return (
    <div className="my-10">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-teal-300/60" />
        <span className="text-[11px] text-teal-600 font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="17 21 17 13 7 13 7 21" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="7 3 7 8 15 8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Context Compacted
          {tokenDisplay && <span className="font-mono text-[10px] text-teal-500">· {tokenDisplay}</span>}
          <span className="font-mono text-[10px] text-teal-400">· {msg.trigger}</span>
          <span className="font-mono text-[10px] text-teal-400">· {msg.timestamp}</span>
        </span>
        <div className="flex-1 h-px bg-teal-300/60" />
      </div>

      {msg.summaryText && (
        <details className="mt-2 ml-8">
          <summary className="cursor-pointer text-xs text-teal-500 hover:text-teal-600 transition-colors select-none">
            Continuation summary
          </summary>
          <pre className="mt-1 p-3 bg-teal-50/50 rounded text-[12px] max-h-[200px] overflow-auto whitespace-pre-wrap break-words text-teal-700/70 leading-relaxed">{msg.summaryText}</pre>
        </details>
      )}
    </div>
  )
}

// ─── Plan Mode Markers ───

export function PlanStartMarker({ msg }: { msg: Extract<SessionMessage, { kind: 'plan-start' }> }) {
  return (
    <div className="mt-4 ml-6 flex items-center gap-2 text-xs text-gray-400">
      <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-500 font-medium text-[11px] uppercase tracking-wide">Plan Mode</span>
      <span className="font-mono text-[11px]">{msg.timestamp}</span>
    </div>
  )
}

export function PlanEndMarker({ msg }: { msg: Extract<SessionMessage, { kind: 'plan-end' }> }) {
  return (
    <details className="mt-2.5 ml-6">
      <summary className="cursor-pointer flex items-center gap-2 text-xs text-gray-400 select-none hover:text-gray-500 transition-colors whitespace-nowrap">
        <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-500 font-medium text-[11px] uppercase tracking-wide shrink-0">Plan Complete</span>
        <span className="font-mono text-[11px] shrink-0">{msg.timestamp}</span>
      </summary>
      {msg.planPreview && (
        <pre className="mt-1 p-4 bg-gray-50 rounded text-[13px] max-h-[250px] overflow-auto whitespace-pre-wrap break-words leading-relaxed text-gray-500">{msg.planPreview}</pre>
      )}
    </details>
  )
}

// ─── Utility ───

function truncateInput(input: Record<string, unknown>): string {
  const display: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    const sv = String(v)
    display[k] = sv.length > 300 ? sv.slice(0, 300) + '...' : v
  }
  const json = JSON.stringify(display, null, 2)
  return json.length > 800 ? json.slice(0, 800) + '\n...' : json
}
