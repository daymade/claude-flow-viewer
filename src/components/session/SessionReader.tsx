import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { SessionView, type SessionViewProps, type ReaderJumpTarget } from './SessionView'
import { SessionToolbar } from './SessionToolbar'
import type { FilterState } from '../../types/session'
import {createDeferredOriginalStore, type ReadDeferredOriginal} from '../../lib/deferred-original-store'
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

export function SessionReader({ filter: controlledFilter, initialFilter, searchQuery: controlledQuery, onToggleFilter, onFindQueryChange, findScopeLabel, showToolbar = true, toolbarLeading, toolbarTrailing, emptyStateAction = null, readDeferredOriginal, deferredOriginalScope, ...props }:
  Omit<SessionViewProps, 'filter' | 'searchQuery'> & {
    filter?: FilterState; initialFilter?: Partial<FilterState>; searchQuery?: string; onToggleFilter?: (key: keyof FilterState) => void; onFindQueryChange?: (query: string) => void; showToolbar?: boolean; toolbarLeading?: ReactNode; toolbarTrailing?: ReactNode
    /** Host-declared scope shown during internal Find. */
    findScopeLabel?: string
    /** Optional host action rendered inside the empty-state guidance (e.g. load earlier). Unset by default. */
    emptyStateAction?: ReactNode
    readDeferredOriginal?: ReadDeferredOriginal | null
    /** Endpoint/channel/session/navigation generation plus the page's source snapshot. */
    deferredOriginalScope?: string | null
  }) {
  const [filter, setFilter] = useState(() => ({...READER_FILTER, ...initialFilter}))
  const [query, setQuery] = useState('')
  const [findFocused, setFindFocused] = useState(false)
  const [hit, setHit] = useState(0)
  const [panel, setPanel] = useState<'find' | 'filters' | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const findButtonRef = useRef<HTMLButtonElement>(null)
  const findPanelRef = useRef<HTMLDivElement>(null)
  const filterPanelRef = useRef<HTMLDivElement>(null)
  const toolbarId = useId()
  const closeDisclosures = () => {
    toolbarRef.current?.querySelectorAll('details[open]').forEach(details => details.removeAttribute('open'))
  }
  const togglePanel = (next: 'find' | 'filters') => {
    closeDisclosures()
    setPanel(old => old === next ? null : next)
  }
  // 调整筛选 opens the existing Filters panel; it never toggles any filter.
  const openFilters = () => {
    closeDisclosures()
    setPanel('filters')
  }
  useEffect(() => {
    if (!panel) return
    if (panel === 'find') findRef.current?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      const activePanel = panel === 'find' ? findPanelRef : filterPanelRef
      const trigger = panel === 'find' ? findButtonRef : filterButtonRef
      if (!activePanel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPanel(null)
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
  const originals = useMemo(() => readDeferredOriginal && deferredOriginalScope
    ? createDeferredOriginalStore(readDeferredOriginal, deferredOriginalScope) : null, [readDeferredOriginal, deferredOriginalScope])
  useEffect(() => {originals?.activate();return () => originals?.retire()}, [originals])
  const deferred = useMemo(() => props.data.messages.filter(message => message.kind === 'deferred-tool-result'), [props.data.messages])
  const [completeFind, setCompleteFind] = useState<{messages: typeof props.data.messages;query: string;store: typeof originals;matches: number[];error: string | null} | null>(null)
  const needsOriginals = Boolean(currentQuery && deferred.length)
  useEffect(() => {
    if (!currentQuery || deferred.length === 0) return
    let current = true
    const messages = props.data.messages, needle = currentQuery.toLowerCase()
    if (!originals) return
    Promise.all(deferred.map(message => originals.load(message.deferred))).then(records => {
      if (!current) return
      const full = new Map(records.map(record => [record.id, record.message]))
      const matches = messages.flatMap((message, index) => JSON.stringify(message.kind === 'deferred-tool-result' ? full.get(message.deferred.id) : message).toLowerCase().includes(needle) ? [index] : [])
      setCompleteFind({messages, query: currentQuery, store: originals, matches, error: null})
    }).catch((error: unknown) => {if (current) setCompleteFind({messages, query: currentQuery, store: originals, matches: [], error: error instanceof Error ? error.message : String(error)})})
    return () => {current = false}
  }, [currentQuery, deferred, originals, props.data.messages])
  const findResult = completeFind?.messages === props.data.messages && completeFind.query === currentQuery && completeFind.store === originals ? completeFind : null
  const findPending = needsOriginals && Boolean(originals) && !findResult
  const findError = needsOriginals ? !originals ? 'Complete original search is unavailable.' : findResult?.error : null
  const findReady = !needsOriginals || Boolean(findResult && !findResult.error)
  const [previousFindTarget, setPreviousFindTarget] = useState<{store: typeof originals;target: ReaderJumpTarget | null;query: string} | null>(null)
  const showFindScope = Boolean(findScopeLabel && controlledQuery === undefined && (findFocused || currentQuery))
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

  const matches = useMemo(() => needsOriginals ? findResult?.matches ?? [] : currentQuery ? props.data.messages.flatMap((message, i) => JSON.stringify(message).toLowerCase().includes(currentQuery.toLowerCase()) ? [i] : []) : [], [props.data.messages, currentQuery, needsOriginals, findResult])
  // Controlled search keeps precedence: the host drives both query and target.
  const resolvedTarget = useMemo<ReaderJumpTarget | null>(() => {
    if (controlledQuery !== undefined) return externalTarget
    if (!currentQuery) return externalTarget
    return matches.length ? {messageIndex:matches[hit % matches.length]} : null
  }, [controlledQuery, currentQuery, matches, hit, externalTarget])
  const target = findReady ? resolvedTarget : previousFindTarget?.store === originals ? previousFindTarget.target : externalTarget
  const viewQuery = findReady ? currentQuery : previousFindTarget?.store === originals ? previousFindTarget.query : ''
  if (findReady && currentQuery && (previousFindTarget?.store !== originals || previousFindTarget.target !== resolvedTarget || previousFindTarget.query !== currentQuery))
    setPreviousFindTarget({store: originals, target: resolvedTarget, query: currentQuery})
  return <div className="flex min-h-0 flex-1 flex-col" data-session-reader="claude-flow-viewer">
    {showToolbar && <div className="session-reader-toolbar" ref={toolbarRef} data-export-remove data-find-scope={showFindScope} onClickCapture={event => {
      if (event.target instanceof Element && event.target.closest('summary')) setPanel(null)
    }}>
      {toolbarLeading}
      {controlledQuery === undefined && <button ref={findButtonRef} type="button" className="reader-find-trigger" aria-expanded={panel === 'find'} aria-controls={`${toolbarId}-find`} onClick={() => togglePanel('find')}>Find{query && findReady && <span className="reader-control-count">{matches.length}</span>}</button>}
      <button ref={filterButtonRef} type="button" className="reader-filter-trigger" aria-expanded={panel === 'filters'} aria-controls={`${toolbarId}-filters`} onClick={() => togglePanel('filters')}>Filters</button>
      <div ref={filterPanelRef} id={`${toolbarId}-filters`} className="reader-filter-panel" hidden={panel !== 'filters'}>
        <SessionToolbar filter={currentFilter} onToggle={key => onToggleFilter ? onToggleFilter(key) : setFilter(old => ({...old,[key]:!old[key]}))} />
      </div>
      {controlledQuery === undefined && <div ref={findPanelRef} id={`${toolbarId}-find`} className="reader-find-panel" data-open={panel === 'find'}>
        <input ref={findRef} aria-label="Find in conversation" aria-describedby={findScopeLabel ? `${toolbarId}-find-scope` : undefined} type="search" placeholder="Find in conversation" value={query} onFocus={() => {closeDisclosures();setFindFocused(true)}} onBlur={() => setFindFocused(false)} onChange={event => {const value=event.target.value;onFindQueryChange?.(value);setQuery(value);setHit(0)}} />
        {query && <>{findPending ? <span role="status">Searching complete original…</span> : findError ? <span role="alert">{findError}</span> : <span className="reader-match-count">{matches.length ? hit % matches.length + 1 : 0}/{matches.length}</span>}<button type="button" disabled={!findReady || !matches.length} onClick={() => setHit(old => old + 1)}>Next</button></>}
      </div>}
      {toolbarTrailing}
      {controlledQuery === undefined && findScopeLabel && <span id={`${toolbarId}-find-scope`} className="reader-find-scope" hidden={!showFindScope}>{findScopeLabel}</span>}
    </div>}
    <SessionView
      {...props}
      deferredOriginal={originals}
      filter={currentFilter}
      searchQuery={viewQuery}
      activeSearchTarget={target}
      filteredEmptyActions={showToolbar || emptyStateAction
        ? <>{showToolbar && <button type="button" className="reader-empty-action" onClick={openFilters}>调整筛选</button>}{emptyStateAction}</>
        : null}
      rangeEmptyActions={emptyStateAction}
    />
  </div>
}
