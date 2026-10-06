import { useMemo, useState } from 'react'
import { SessionView, type SessionViewProps } from './SessionView'
import { SessionToolbar } from './SessionToolbar'
import type { FilterState } from '../../types/session'

const READER_FILTER: FilterState = {thinking:false,toolCalls:true,toolResults:true,aiText:true,team:true,branches:true,markers:true,timeline:true}

export function SessionReader({ filter: controlledFilter, searchQuery: controlledQuery, onToggleFilter, showToolbar = true, ...props }:
  Omit<SessionViewProps, 'filter' | 'searchQuery'> & {
    filter?: FilterState; searchQuery?: string; onToggleFilter?: (key: keyof FilterState) => void; showToolbar?: boolean
  }) {
  const [filter, setFilter] = useState(READER_FILTER)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const currentFilter = controlledFilter ?? filter
  const currentQuery = controlledQuery ?? query
  const matches = useMemo(() => currentQuery ? props.data.messages.flatMap((message, i) => JSON.stringify(message).toLowerCase().includes(currentQuery.toLowerCase()) ? [i] : []) : [], [props.data.messages, currentQuery])
  const target = controlledQuery !== undefined ? props.activeSearchTarget : currentQuery ? (matches.length ? {messageIndex:matches[hit % matches.length]} : null) : props.activeSearchTarget
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
