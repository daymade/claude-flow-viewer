import type { SearchResult } from '../../lib/search'
import type { SearchControllerState } from '../../hooks/useSearchController'
import type { ResolvedSessionRef } from '../../types/session'
import { SOURCE_METADATA } from '../../lib/source-metadata'

function kindLabel(kind: SearchResult['kind']): string {
  switch (kind) {
    case 'metadata': return 'META'
    case 'prompt': return 'PROM'
    case 'ai-text': return 'TEXT'
    case 'thinking': return 'THK'
    case 'tool-call': return 'TOOL'
    case 'tool-result': return 'OUT'
    case 'team-message': return 'TEAM'
    case 'delegation-update': return 'DELG'
    case 'task-event': return 'TASK'
  }
}

function formatContext(result: SearchResult): string {
  if (typeof result.locator.promptNum === 'number') return `Prompt #${result.locator.promptNum}`
  if (result.locator.messageIndex >= 0) return `Message ${result.locator.messageIndex + 1}`
  return 'Session overview'
}

/**
 * The direct-open card for a session located by identifier. It sits ABOVE the full-text results
 * (additive, not a replacement) so a matched id opens directly while transcript mentions of that
 * id still show below.
 */
function ResolvedDirectCard({ resolved, onOpen }: { resolved: ResolvedSessionRef; onOpen: () => void }) {
  const sourceMeta = SOURCE_METADATA[resolved.source]
  // Cherry regular-chat ids are `topic:<id>`; strip the prefix so the card shows a real id fragment.
  const shortId = resolved.sessionId.replace(/^topic:/, '').slice(0, 8)
  const subtitle = resolved.meta?.firstPromptPreview?.trim() || resolved.projectEncoded.replace(/^codex:/, '')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 border-b border-amber-100 bg-amber-50/70 px-3 py-2.5 text-left transition-colors hover:bg-amber-100/70"
    >
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${sourceMeta.badgeClass}`}>
        {sourceMeta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-amber-900">
          Open session <span className="font-mono">{shortId}</span>
        </div>
        <div className="truncate text-[10px] text-amber-700/80">{subtitle}</div>
      </div>
      <span className="shrink-0 text-[10px] font-medium text-amber-600">Direct&nbsp;↵</span>
    </button>
  )
}

interface SearchResultsPanelProps {
  query: string
  search: SearchControllerState
  onSelectResult: (result: SearchResult) => void
  onOpenResolved: () => void
}

export function SearchResultsPanel({ query, search, onSelectResult, onOpenResolved }: SearchResultsPanelProps) {
  if (!query.trim()) return null

  return (
    <div className="mt-2 rounded-xl border border-amber-100 bg-white shadow-sm shadow-amber-100/40">
      <div className="flex items-center gap-2 border-b border-amber-50 px-3 py-2 text-[10px]">
        <span className="font-semibold uppercase tracking-[0.14em] text-amber-700">Search</span>
        <span className="text-stone-400">
          {search.status === 'checking'
            ? 'Checking local server'
            : search.status === 'searching'
              ? 'Querying SQLite index'
              : search.status === 'unavailable'
                ? 'Local server required'
                : search.results.length > 0
              ? `${search.results.length} result${search.results.length === 1 ? '' : 's'}`
              : search.status === 'error'
                ? 'Search failed'
                : 'No results yet'}
        </span>
        {search.status === 'checking' || search.status === 'searching' ? (
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
        ) : null}
      </div>

      {search.resolvedStatus === 'hit' && search.resolved ? (
        <ResolvedDirectCard resolved={search.resolved} onOpen={onOpenResolved} />
      ) : search.resolvedStatus === 'resolving' ? (
        <div className="border-b border-amber-50 px-3 py-2 text-[11px] text-stone-400">Locating session by ID…</div>
      ) : search.resolvedStatus === 'error' ? (
        <div className="border-b border-amber-50 px-3 py-2 text-[11px] text-rose-600">
          Could not resolve that ID — the local server returned an error.
        </div>
      ) : search.resolvedStatus === 'miss' ? (
        <div className="border-b border-amber-50 px-3 py-2 text-[11px] text-stone-500">
          No session found with that ID in Claude, Codex, or Cherry Studio history.
        </div>
      ) : null}

      {search.status === 'unavailable' && search.backend && !search.backend.available ? (
        <div className="px-3 py-2 text-xs text-stone-500">
          {search.backend.message}
        </div>
      ) : search.error ? (
        <div className="px-3 py-2 text-xs text-rose-600">{search.error}</div>
      ) : search.results.length > 0 ? (
        <div className="max-h-[320px] overflow-y-auto px-1 py-1">
          {search.results.map((result, index) => {
            const isActive = search.activeTarget?.chunkId === result.chunkId
            const sourceMeta = SOURCE_METADATA[result.source]
            return (
              <button
                key={result.chunkId}
                type="button"
                onClick={() => onSelectResult(result)}
                className={`block w-full rounded-lg px-2 py-2 text-left transition-colors ${
                  isActive
                    ? 'bg-amber-50'
                    : 'hover:bg-stone-50'
                }`}
              >
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="font-mono text-stone-300">{String(index + 1).padStart(2, '0')}</span>
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${
                    sourceMeta.badgeClass
                  }`}>
                    {sourceMeta.label}
                  </span>
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 font-semibold text-stone-700">
                    {kindLabel(result.kind)}
                  </span>
                  <span className="truncate text-stone-500">{result.projectShortName}</span>
                  <span className="ml-auto font-mono text-stone-300">{result.score.toFixed(1)}</span>
                </div>
                <div className="mt-1 text-[12px] font-semibold text-stone-800">
                  {result.title} · {formatContext(result)}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-stone-600">
                  {result.snippet}
                </div>
                <div className="mt-1 text-[10px] text-stone-400">
                  Match: {result.matchedText}
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-stone-500">
          {search.status === 'checking' || search.status === 'searching'
            ? 'Querying the local SQLite search service.'
            : 'No transcript matches yet.'}
        </div>
      )}
    </div>
  )
}
