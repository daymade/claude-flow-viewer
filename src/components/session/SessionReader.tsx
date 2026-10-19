import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { SessionView, type SessionViewProps, type ReaderJumpTarget } from './SessionView'
import { SessionToolbar } from './SessionToolbar'
import type { FilterState } from '../../types/session'
import './SessionReader.css'

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

export function SessionReader({ filter: controlledFilter, initialFilter, searchQuery: controlledQuery, onToggleFilter, onFindQueryChange, showToolbar = true, ...props }:
  Omit<SessionViewProps, 'filter' | 'searchQuery'> & {
    filter?: FilterState; initialFilter?: Partial<FilterState>; searchQuery?: string; onToggleFilter?: (key: keyof FilterState) => void; onFindQueryChange?: (query: string) => void; showToolbar?: boolean
  }) {
  const [filter, setFilter] = useState(() => ({...READER_FILTER, ...initialFilter}))
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const [panel, setPanel] = useState<'find' | 'filters' | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const findButtonRef = useRef<HTMLButtonElement>(null)
  const toolbarId = useId()
  useEffect(() => {
    if (!panel) return
    if (panel === 'find') findRef.current?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target)) setPanel(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPanel(null)
      ;(panel === 'find' ? findButtonRef : filterButtonRef).current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [panel])
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
    {showToolbar && <div className="session-reader-toolbar" ref={toolbarRef} data-export-remove>
      {controlledQuery === undefined && <button ref={findButtonRef} type="button" className="reader-find-trigger" aria-expanded={panel === 'find'} aria-controls={`${toolbarId}-find`} onClick={() => setPanel(old => old === 'find' ? null : 'find')}>Find{query && <span className="reader-control-count">{matches.length}</span>}</button>}
      <button ref={filterButtonRef} type="button" className="reader-filter-trigger" aria-expanded={panel === 'filters'} aria-controls={`${toolbarId}-filters`} onClick={() => setPanel(old => old === 'filters' ? null : 'filters')}>Filters</button>
      <div id={`${toolbarId}-filters`} className="reader-filter-panel" hidden={panel !== 'filters'}>
        <SessionToolbar filter={currentFilter} onToggle={key => onToggleFilter ? onToggleFilter(key) : setFilter(old => ({...old,[key]:!old[key]}))} />
      </div>
      {controlledQuery === undefined && <div id={`${toolbarId}-find`} className="reader-find-panel" data-open={panel === 'find'}>
        <input ref={findRef} aria-label="Find in conversation" type="search" placeholder="Find in conversation" value={query} onChange={event => {const value=event.target.value;onFindQueryChange?.(value);setQuery(value);setHit(0)}} />
        {query && <><span className="reader-match-count">{matches.length ? hit % matches.length + 1 : 0}/{matches.length}</span><button type="button" disabled={!matches.length} onClick={() => setHit(old => old + 1)}>Next</button></>}
      </div>}
    </div>}
    <SessionView {...props} filter={currentFilter} searchQuery={currentQuery} activeSearchTarget={target} />
  </div>
}
