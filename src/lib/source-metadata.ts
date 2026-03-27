import type { SessionSource } from '../types/session'

export interface SourceMetadata {
  source: SessionSource
  label: string
  sectionLabel: string
  badgeClass: string
  projectClass: string
  projectHoverClass: string
  sessionClass: string
  viewLabel: string
}

export const SOURCE_METADATA: Record<SessionSource, SourceMetadata> = {
  claude: {
    source: 'claude',
    label: 'Claude',
    sectionLabel: 'Claude conversations',
    badgeClass: 'bg-sky-100 text-sky-800',
    projectClass: 'bg-sky-50/60 text-sky-800 border-sky-100',
    projectHoverClass: 'bg-sky-50/30 hover:bg-sky-50/50',
    sessionClass: 'border-l-sky-400/60 hover:bg-sky-50/40',
    viewLabel: 'Conversation view',
  },
  codex: {
    source: 'codex',
    label: 'Codex',
    sectionLabel: 'Codex tasks',
    badgeClass: 'bg-emerald-100 text-emerald-800',
    projectClass: 'bg-emerald-50/60 text-emerald-800 border-emerald-100',
    projectHoverClass: 'bg-emerald-50/40 hover:bg-emerald-50/60',
    sessionClass: 'border-l-emerald-400/60 hover:bg-emerald-50/40',
    viewLabel: 'Learning map',
  },
  cherrystudio: {
    source: 'cherrystudio',
    label: 'Cherry Studio',
    sectionLabel: 'Cherry Studio sessions',
    badgeClass: 'bg-orange-100 text-orange-800',
    projectClass: 'bg-orange-50/60 text-orange-800 border-orange-100',
    projectHoverClass: 'bg-orange-50/30 hover:bg-orange-50/50',
    sessionClass: 'border-l-orange-400/60 hover:bg-orange-50/40',
    viewLabel: 'Session view',
  },
}

export const SOURCE_ORDER: SessionSource[] = ['claude', 'codex', 'cherrystudio']
