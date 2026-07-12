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

// Single neutral system (stone). Source identity is carried by the section
// label + the Structure/Diagnostics context, not by per-source color. Keeping
// one neutral here is what removes the "rainbow of sources" slop from the rail.
const NEUTRAL = {
  badgeClass: 'bg-stone-100 text-stone-600',
  projectClass: 'border-stone-200/70 text-stone-400',
  projectHoverClass: 'hover:bg-stone-100/70',
  sessionClass: 'border-l-transparent hover:bg-stone-100/60',
} as const

export const SOURCE_METADATA: Record<SessionSource, SourceMetadata> = {
  claude: {
    source: 'claude',
    label: 'Claude',
    sectionLabel: 'Claude conversations',
    ...NEUTRAL,
    viewLabel: 'Conversation view',
  },
  codex: {
    source: 'codex',
    label: 'Codex',
    sectionLabel: 'Codex tasks',
    ...NEUTRAL,
    viewLabel: 'Task workspace',
  },
  cherrystudio: {
    source: 'cherrystudio',
    label: 'Cherry Studio',
    sectionLabel: 'Cherry Studio sessions',
    ...NEUTRAL,
    viewLabel: 'Session view',
  },
}

export const SOURCE_ORDER: SessionSource[] = ['claude', 'codex', 'cherrystudio']
