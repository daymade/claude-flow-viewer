import { describe, expect, it } from 'vitest'

import type { SessionData, SessionMeta } from '../../types/session'
import { SearchEngine, extractSearchChunks, normalizeSearchText, type SearchSessionRecord, type SemanticSearchProvider } from '../search'

function makeSessionRecord(overrides: Partial<SearchSessionRecord> = {}): SearchSessionRecord {
  const meta: SessionMeta = {
    source: 'claude',
    id: 'session-1',
    startTime: '2026-03-09T10:00:00.000Z',
    startDisplay: '2026-03-09 18:00',
    promptCount: 1,
    toolCount: 1,
    firstPromptPreview: 'Paint a watercolor fox in a neon city',
    fileSize: 512,
    recordCount: 10,
    agentName: 'atlas',
    agentRole: 'research',
  }

  const data: SessionData = {
    source: 'claude',
    prompts: [
      {
        num: 1,
        preview: 'Paint a watercolor fox',
        fullText: 'Paint a watercolor fox in a neon city',
        time: '10:00:00',
        decision: 'none',
      },
    ],
    messages: [
      {
        kind: 'user-prompt',
        promptNum: 1,
        text: 'Paint a watercolor fox in a neon city',
        images: [],
        time: '10:00:00',
        decision: 'none',
      },
      {
        kind: 'ai-text',
        text: 'I can turn that into a moody illustration brief with rim lighting.',
        timestamp: '10:00:10',
      },
      {
        kind: 'ai-thinking',
        preview: 'Preparing the art direction',
        full: 'Need a cinematic alley palette and stronger rim lighting.',
        timestamp: '10:00:12',
      },
      {
        kind: 'ai-tool-use',
        name: 'web_search',
        summary: 'Search for watercolor fox references',
        input: { query: 'watercolor fox references' },
        timestamp: '10:00:15',
      },
      {
        kind: 'tool-result',
        content: 'Found a strong reference board for watercolor animal posters.',
        isError: false,
        timestamp: '10:00:20',
      },
      {
        kind: 'team-message',
        from: 'designer',
        color: 'emerald',
        summary: 'Palette options',
        content: 'Amber highlights and teal shadows worked best.',
        isProtocol: false,
      },
      {
        kind: 'delegation-update',
        agentId: 'worker-1',
        status: 'completed',
        summary: 'Generated the first illustration brief.',
        timestamp: '10:00:30',
      },
      {
        kind: 'task-event',
        taskId: 'task-7',
        status: 'completed',
        summary: 'Illustration brief approved.',
        timestamp: '10:00:40',
      },
    ],
    heatmap: [0.5],
    markers: {
      compacts: 0,
      plans: 0,
      clears: 0,
      forks: 0,
    },
  }

  return {
    projectEncoded: 'project-alpha',
    projectLabel: '/Users/example/project-alpha',
    projectShortName: 'project-alpha',
    meta,
    data,
    ...overrides,
  }
}

describe('search extract', () => {
  it('extracts metadata and searchable message chunks', () => {
    const chunks = extractSearchChunks(makeSessionRecord())

    expect(chunks.some((chunk) => chunk.kind === 'metadata')).toBe(true)
    expect(chunks.some((chunk) => chunk.kind === 'prompt' && chunk.locator.promptNum === 1)).toBe(true)
    expect(chunks.some((chunk) => chunk.kind === 'tool-result')).toBe(true)
    expect(chunks.some((chunk) => chunk.kind === 'delegation-update')).toBe(true)
    expect(chunks.some((chunk) => chunk.kind === 'task-event')).toBe(true)
  })

  it('keeps Cherry Studio chunks source-aware and searchable', () => {
    const session = makeSessionRecord({
      projectEncoded: 'cherrystudio:/Users/test/Library/Application Support/CherryStudioDev',
      projectLabel: '/Users/test/Library/Application Support/CherryStudioDev',
      projectShortName: 'Cherry Studio',
      meta: {
        ...makeSessionRecord().meta,
        source: 'cherrystudio',
        id: 'cs-session-1',
        startTime: '2026-03-09T11:00:00.000Z',
        startDisplay: '2026-03-09 19:00',
        firstPromptPreview: 'Map amber reflections across the harbor',
        agentName: 'Cherry Analyst',
        agentRole: 'topic',
      },
      data: {
        source: 'cherrystudio',
        prompts: [{
          num: 1,
          preview: 'Map amber reflections',
          fullText: 'Map amber reflections across the harbor',
          time: '11:00:00',
          decision: 'none',
        }],
        messages: [
          {
            kind: 'user-prompt',
            promptNum: 1,
            text: 'Map amber reflections across the harbor',
            images: [],
            time: '11:00:00',
            decision: 'none',
          },
          {
            kind: 'ai-text',
            text: 'Cherry Studio rendered amber reflections with blue water shadows.',
            timestamp: '11:00:05',
          },
        ],
        heatmap: [0.75],
        markers: {
          compacts: 0,
          plans: 0,
          clears: 0,
          forks: 0,
        },
      },
    })

    const chunks = extractSearchChunks(session)
    expect(chunks.every((chunk) => chunk.source === 'cherrystudio')).toBe(true)

    const engine = new SearchEngine()
    engine.addChunks(chunks)

    const results = engine.search('amber reflections', { limit: 3 })
    expect(results[0]?.source).toBe('cherrystudio')
    expect(results[0]?.sessionId).toBe('cs-session-1')
    expect(results[0]?.projectShortName).toBe('Cherry Studio')
  })
})

describe('SearchEngine', () => {
  it('finds exact phrase matches and returns precise locators', () => {
    const engine = new SearchEngine()
    engine.addSession(makeSessionRecord())

    const results = engine.search('watercolor fox in a neon city', { limit: 3 })

    expect(results[0]?.kind).toBe('prompt')
    expect(results[0]?.locator.promptNum).toBe(1)
    expect(results[0]?.matchedText.toLowerCase()).toContain('watercolor fox')
    expect(results[0]?.snippet.toLowerCase()).toContain('neon city')
  })

  it('supports fuzzy trigram recall for misspelled recollection queries', () => {
    const engine = new SearchEngine()
    engine.addSession(makeSessionRecord())

    const results = engine.search('cinamatic alley palete', { limit: 5 })

    expect(results.some((result) => result.kind === 'thinking' || result.kind === 'team-message')).toBe(true)
  })

  it('searches metadata and session tags in addition to transcript content', () => {
    const engine = new SearchEngine()
    engine.addSession(makeSessionRecord())

    const results = engine.search('atlas research', { limit: 5 })

    expect(results[0]?.kind).toBe('metadata')
    expect(results[0]?.projectEncoded).toBe('project-alpha')
  })

  it('accepts a semantic provider seam without extra dependencies', () => {
    const semanticProvider: SemanticSearchProvider = {
      name: 'test-provider',
      score(chunk, context) {
        return normalizeSearchText(chunk.text).includes(context.normalizedQuery) ? 0 : 0.5
      },
    }

    const engine = new SearchEngine(semanticProvider)
    engine.addSession(makeSessionRecord({
      meta: {
        ...makeSessionRecord().meta,
        id: 'session-2',
        firstPromptPreview: 'Draft an architectural migration plan',
      },
      data: {
        ...makeSessionRecord().data,
        messages: [
          {
            kind: 'ai-text',
            text: 'This migration plan focuses on durable search architecture.',
            timestamp: '11:00:00',
          },
        ],
      },
    }))

    const results = engine.search('durable search architecture', { limit: 3 })

    expect(results[0]?.reasons.semantic).toBeGreaterThanOrEqual(0)
  })

  it('hydrates directly from persisted chunk rows and can replace a session corpus', () => {
    const engine = new SearchEngine()
    const original = makeSessionRecord()
    const replacement = makeSessionRecord({
      meta: {
        ...makeSessionRecord().meta,
        id: 'session-1',
        firstPromptPreview: 'Draft a migration checklist',
      },
      data: {
        ...makeSessionRecord().data,
        messages: [
          {
            kind: 'ai-text',
            text: 'Migration checklist for durable local search storage.',
            timestamp: '12:00:00',
          },
        ],
      },
    })

    engine.addChunks(extractSearchChunks(original))
    expect(engine.search('watercolor fox').length).toBeGreaterThan(0)

    const replacementChunks = extractSearchChunks(replacement)
    engine.replaceSessionChunks('claude:project-alpha:session-1', replacementChunks)

    expect(engine.getChunks().some((chunk) => chunk.text.includes('watercolor fox'))).toBe(false)
    const replacementResults = engine.search('migration checklist', { limit: 3 })
    expect(replacementResults[0]?.sessionId).toBe('session-1')
    expect(replacementResults[0]?.kind).toBe('ai-text')
  })

  it('uses the default co-occurrence semantic scorer to surface related chunks', () => {
    const engine = new SearchEngine()

    engine.addSession(makeSessionRecord({
      meta: {
        ...makeSessionRecord().meta,
        id: 'session-metropolis',
        firstPromptPreview: 'Metropolis skyline study',
      },
      data: {
        ...makeSessionRecord().data,
        messages: [
          {
            kind: 'ai-text',
            text: 'Design a neon metropolis skyline with rain reflections.',
            timestamp: '09:00:00',
          },
        ],
      },
    }))

    engine.addSession(makeSessionRecord({
      meta: {
        ...makeSessionRecord().meta,
        id: 'session-city',
        firstPromptPreview: 'City skyline study',
      },
      data: {
        ...makeSessionRecord().data,
        messages: [
          {
            kind: 'ai-text',
            text: 'Sketch a city skyline with rain reflections and amber glow.',
            timestamp: '09:05:00',
          },
        ],
      },
    }))

    const results = engine.search('metropolis', { limit: 5 })
    const semanticHit = results.find((result) => result.sessionId === 'session-city')

    expect(semanticHit).toBeTruthy()
    expect(semanticHit?.reasons.semantic).toBeGreaterThan(0)
  })

  it('incorporates external BM25 and embedding signals into the final rank', () => {
    const engine = new SearchEngine()
    const session = makeSessionRecord()
    const chunks = extractSearchChunks(session)
    engine.addChunks(chunks)

    const promptChunk = chunks.find((chunk) => chunk.kind === 'prompt')
    const aiChunk = chunks.find((chunk) => chunk.kind === 'ai-text')
    expect(promptChunk).toBeTruthy()
    expect(aiChunk).toBeTruthy()

    const results = engine.search('neutral anchor', {
      limit: 5,
      candidateChunkIds: [promptChunk!.id, aiChunk!.id],
      externalSignals: {
        [promptChunk!.id]: { bm25: 0.5 },
        [aiChunk!.id]: { embedding: 9 },
      },
    })

    expect(results[0]?.chunkId).toBe(aiChunk?.id)
    expect(results[0]?.reasons.embedding).toBeGreaterThan(0)
  })
})
