import { useMemo, useState } from 'react'
import { SessionView, type SessionViewProps, type ReaderJumpTarget } from './SessionView'
import { SessionToolbar } from './SessionToolbar'
import type { FilterState } from '../../types/session'

const READER_FILTER: FilterState = {thinking:false,toolCalls:true,toolResults:true,aiText:true,team:true,branches:true,markers:true,timeline:true}

/**
 * Stable identity of one external navigation: the request token when the
 * host supplies one, otherwise the target position. Re-rendering with a
 * fresh object that carries the same token/position is the SAME navigation
 * and must not reset the reader's internal Find.
 */
function navigationIdentity(target: ReaderJumpTarget | null): string | null {
  if (!target) return null
  return target.requestId != null
    ? `req:${String(target.requestId)}`
    : `pos:${target.messageIndex}:${target.promptNum ?? ''}`
}

export function SessionReader({ filter: controlledFilter, initialFilter, searchQuery: controlledQuery, onToggleFilter, showToolbar = true, ...props }:
  Omit<SessionViewProps, 'filter' | 'searchQuery'> & {
    filter?: FilterState; initialFilter?: Partial<FilterState>; searchQuery?: string; onToggleFilter?: (key: keyof FilterState) => void; showToolbar?: boolean
  }) {
  const [filter, setFilter] = useState(() => ({...READER_FILTER, ...initialFilter}))
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const currentFilter = controlledFilter ?? filter
  const currentQuery = controlledQuery ?? query
  const externalTarget = props.activeSearchTarget ?? null

  // A NEW external navigation suspends the internal Find so the host's focus
  // wins; the user can re-enter Find afterwards and Next keeps working.
  const navigation = navigationIdentity(externalTarget)
  const [lastNavigation, setLastNavigation] = useState<string | null>(navigation)
  if (navigation !== lastNavigation) {
    setLastNavigation(navigation)
    if (navigation !== null && query) {
      setQuery('')
      setHit(0)
    }
  }

  const matches = useMemo(() => currentQuery ? props.data.messages.flatMap((message, i) => JSON.stringify(message).toLowerCase().includes(currentQuery.toLowerCase()) ? [i] : []) : [], [props.data.messages, currentQuery])
  // Controlled search keeps precedence: the host drives both query and target.
  const target = useMemo<ReaderJumpTarget | null>(() => {
    if (controlledQuery !== undefined) return externalTarget
    if (!currentQuery) return externalTarget
    return matches.length ? {messageIndex:matches[hit % matches.length]} : null
  }, [controlledQuery, currentQuery, matches, hit, externalTarget])
  return <div className="flex min-h-0 flex-1 flex-col" data-session-reader="claude-flow-viewer">
    {showToolbar && <div className="shrink-0 border-b border-stone-200 bg-white px-3 py-2 flex flex-wrap items-center gap-2">
      <SessionToolbar filter={currentFilter} onToggle={key => onToggleFilter ? onToggleFilter(key) : setFilter(old => ({...old,[key]:!old[key]}))} />
      {controlledQuery === undefined && <div className="flex items-center gap-2 w-full text-xs">
        <input aria-label="Find in conversation" type="search" placeholder="Find in conversation" value={query} onChange={event => {setQuery(event.target.value);setHit(0)}} className="flex-1 min-w-0 border border-stone-200 rounded px-2 py-1" />
        {query && <><span>{matches.length ? hit % matches.length + 1 : 0}/{matches.length}</span><button disabled={!matches.length} onClick={() => setHit(old => old + 1)}>Next</button></>}
      </div>}
    </div>}
    <SessionView {...props} filter={currentFilter} searchQuery={currentQuery} activeSearchTarget={target} />
  </div>
}
