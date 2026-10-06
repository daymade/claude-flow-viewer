import type { FilterState } from '../../types/session'

const FILTER_LABELS: { key: keyof FilterState; label: string }[] = [
  { key: 'thinking', label: 'Thinking' }, { key: 'toolCalls', label: 'Tool Calls' },
  { key: 'toolResults', label: 'Results' }, { key: 'aiText', label: 'AI Text' },
  { key: 'team', label: 'Team' }, { key: 'branches', label: 'Branches' },
  { key: 'markers', label: 'Markers' }, { key: 'timeline', label: 'Timeline' },
]

export function SessionToolbar({ filter, onToggle }: {
  filter: FilterState; onToggle: (key: keyof FilterState) => void
}) {
  return <div data-export-remove className="flex items-center gap-1 text-[11px] flex-wrap justify-start sm:ml-auto sm:justify-end">
    {FILTER_LABELS.map(({ key, label }) => <label key={key} className={`cursor-pointer flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors select-none ${filter[key] ? 'bg-stone-100 text-stone-700' : 'text-stone-400 hover:text-stone-500 hover:bg-stone-50'}`}>
      <input type="checkbox" checked={filter[key]} onChange={() => onToggle(key)} className="accent-stone-600 w-3 h-3" />
      <span>{label}</span>
    </label>)}
  </div>
}
