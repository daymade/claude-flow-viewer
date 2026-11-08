import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {it, expect, vi} from 'vitest'
import {projectDeferredOriginalPage, hydrateDeferredOriginalRecord, DEFERRED_ORIGINAL_HASH,
  type DeferredOriginalSourcePage, type DeferredOriginalRecord, type DeferredOriginalPage} from '../deferred-original'

const sha = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const output = () => [
  {type: 'input_text', text: 'before "quoted"\n中文\\text  '},
  {type: 'input_image', image_url: 'data:image/png;base64,AQIDBA==', detail: 'high'},
  {type: 'output_text', text: '\tbetween\n'},
  {type: 'input_image', image_url: 'data:image/jpeg;base64,/wAB', detail: 'low'},
  {type: 'text', text: 'after\n'},
]
function sourcePage(): DeferredOriginalSourcePage {
  const sourceRecord = {type: 'response_item', ordinal: 124,
    payload: {type: 'custom_tool_call_output', call_id: 'same-call', output: output(), metadata: {note: 'retain metadata text'}},
    metadata: {client_authored: false}}
  return {provider: 'codex', session_id: 'synthetic-session', offset: 43, next_offset: 44, total: 100,
    has_earlier: true, has_later: true, read_at: '2026-11-08T00:00:00Z', boundary: 'original',
    identity: {node: 'synthetic-node', provider: 'codex', session_id: 'synthetic-session', source_path: '/synthetic/original.jsonl'},
    revision: 'synthetic-revision', until: 'original:100', records: [{kind: 'flow-message', id: 'original:43',
      source_session: 'synthetic-session', source_ordinal: 124, timestamp: '00:00:01',
      message: {kind: 'tool-result', sourceRecordId: 'same-call', content: JSON.stringify(sourceRecord.payload.output, null, 2),
        isError: true, timestamp: '00:00:01', sourceRecord}} as DeferredOriginalSourcePage['records'][number]]}
}
async function projectedPage(page = sourcePage()) {
  const projected = await projectDeferredOriginalPage(page, 1) as DeferredOriginalPage
  expect(projected.records[0].kind).toBe('deferred-tool-result')
  return {page, projected, record: projected.records[0] as DeferredOriginalRecord}
}
function mutate(value: unknown, path: string[], action: 'delete' | 'null' | 'damage') {
  let owner = value as Record<string, unknown>
  for (const key of path.slice(0, -1)) owner = owner[key] as Record<string, unknown>
  const key = path.at(-1)!
  if (action === 'delete') delete owner[key]
  else owner[key] = action === 'null' ? null : typeof owner[key] === 'number' ? (owner[key] as number) + 1 : 'damaged'
}

it('preserves every ordered text part and metadata without pretending to be a canonical message', async () => {
  const input = sourcePage(), before = JSON.stringify(input)
  const {projected, record} = await projectedPage(input)
  expect(JSON.stringify(input)).toBe(before)
  expect(record).not.toHaveProperty('message')
  expect(record.presentation).not.toHaveProperty('content')
  expect(record.presentation).not.toHaveProperty('sourceRecord')
  expect(record.presentation.isError).toBe(true)
  expect(record.presentation.sourceRecordId).toBe('same-call')
  expect(record.presentation.parts.map(part => part.kind)).toEqual(['text', 'image', 'text', 'image', 'text'])
  expect(record.presentation.parts.filter(part => part.kind === 'text').map(part => part.text))
    .toEqual(output().filter(part => 'text' in part).map(part => part.text))
  expect(record.presentation.sourceRecordMetadata).toEqual({type: 'response_item', ordinal: 124,
    payload: {type: 'custom_tool_call_output', call_id: 'same-call', metadata: {note: 'retain metadata text'}}, metadata: {client_authored: false}})
  expect(JSON.stringify(record)).not.toContain('base64,')
  expect(record.original.hashAlgorithm).toBe(DEFERRED_ORIGINAL_HASH)
  expect(record.original.recordSha256).toBe(sha(JSON.stringify(input.records[0])))
  const original = input.records[0]
  if (!('message' in original) || original.message.kind !== 'tool-result') throw new Error('fixture')
  expect(record.original.contentSha256).toBe(sha(original.message.content))
  expect(record.original.images.map(image => image.decodedSha256)).toEqual([sha(Buffer.from([1, 2, 3, 4])), sha(Buffer.from([255, 0, 1]))])
  const restored = await hydrateDeferredOriginalRecord(projected, record, original)
  expect(restored).not.toBe(original)
  expect(JSON.stringify(restored)).toBe(JSON.stringify(input.records[0]))
})

it('snapshots identity instead of aliasing a mutable source object', async () => {
  const {page, projected, record} = await projectedPage()
  page.identity!.source_path = '/synthetic/changed.jsonl'
  expect(record.original.binding.identity.source_path).toBe('/synthetic/original.jsonl')
  await expect(hydrateDeferredOriginalRecord({...projected, identity: page.identity}, record, page.records[0])).rejects.toThrow()
})

it('leaves all old fields and references unchanged without the explicit capability', async () => {
  const page = sourcePage()
  for (const capability of [undefined, 0, 2, null]) expect(await projectDeferredOriginalPage(page, capability as number)).toBe(page)
})

it('retains unknown, malformed, non-inline and raw-string-bearing originals in full', async () => {
  const variants: Array<(page: DeferredOriginalSourcePage) => void> = [
    page => { (page.records[0] as unknown as {message: {sourceRecordRaw: string}}).message.sourceRecordRaw = 'exact original line\n' },
    page => { (page.records[0] as unknown as {message: {content: string}}).message.content += '\n' },
    page => { (page.records[0] as unknown as {message: {extra: string}}).message.extra = 'unknown content' },
  ]
  const invalidOutputs = [
    [{type: 'unknown', text: 'must remain'}],
    [...output(), {type: 'text', text: 'must remain', extra: 'unknown'}],
    [{type: 'input_image', image_url: 'https://example.invalid/image.png'}],
    [{type: 'input_image', image_url: 'data:image/png;base64,%%%='}],
    [{type: 'input_image', image_url: 'data:image/png;base64,AQIDBB=='}],
    [{type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: null}],
    [{type: 'input_text', text: 'data:image/png;base64,AQID'}],
    [null, ...output()],
    [{type: 'input_image', image_url: 'data:image/png;base64,AQID', extra: 'unknown'}],
  ]
  for (const invalid of invalidOutputs) variants.push(page => {
    const message = (page.records[0] as unknown as {message: {content: string; sourceRecord: {payload: {output: unknown}}}}).message
    message.sourceRecord.payload.output = invalid
    message.content = JSON.stringify(invalid, null, 2)
  })
  for (const change of variants) {
    const page = sourcePage(); change(page)
    const before = JSON.stringify(page)
    expect(await projectDeferredOriginalPage(page, 1)).toBe(page)
    expect(JSON.stringify(page)).toBe(before)
  }
})

it('rejects missing, null and damaged page and physical-owner bindings', async () => {
  const {page, projected, record} = await projectedPage()
  const paths = [['provider'], ['session_id'], ['revision'], ['until'], ['offset'], ['identity'],
    ['identity', 'node'], ['identity', 'provider'], ['identity', 'session_id'], ['identity', 'source_path']]
  for (const path of paths) for (const action of ['delete', 'null', 'damage'] as const) {
    const changed = clone(projected); mutate(changed, path, action)
    await expect(hydrateDeferredOriginalRecord(changed, record, page.records[0]), `${path.join('.')}:${action}`).rejects.toThrow()
  }
})

it('rejects missing, null and damaged coordinates, all declared hashes and both image sizes', async () => {
  const {page, projected} = await projectedPage()
  const paths = [['original'], ['original', 'version'], ['original', 'hashAlgorithm'], ['original', 'binding'],
    ...['provider', 'sessionId', 'identity', 'revision', 'until', 'recordId', 'offset', 'sourceSession', 'sourceOrdinal'].map(key => ['original', 'binding', key]),
    ['original', 'recordSha256'], ['original', 'contentSha256'], ['original', 'images'],
    ...['index', 'mediaType', 'uriUtf8Bytes', 'uriSha256', 'decodedBytes', 'decodedSha256'].map(key => ['original', 'images', '0', key])]
  for (const path of paths) for (const action of ['delete', 'null', 'damage'] as const) {
    const changed = clone(projected), record = changed.records[0] as DeferredOriginalRecord
    mutate(record, path, action)
    await expect(hydrateDeferredOriginalRecord(changed, record, page.records[0]), `${path.join('.')}:${action}`).rejects.toThrow()
  }
})

it('rejects damaged presentation, incomplete candidates and same-call tool-use collisions', async () => {
  const {page, projected, record} = await projectedPage()
  for (const path of [['id'], ['source_session'], ['source_ordinal'], ['message'], ['message', 'content'],
    ['message', 'isError'], ['message', 'sourceRecordId'], ['message', 'sourceRecord'], ['message', 'sourceRecord', 'ordinal']]) {
    for (const action of ['delete', 'null', 'damage'] as const) {
      const candidate = clone(page.records[0]); mutate(candidate, path, action)
      await expect(hydrateDeferredOriginalRecord(projected, record, candidate)).rejects.toThrow()
    }
  }
  const toolUse = {kind: 'flow-message', id: 'original:42', source_session: 'synthetic-session', source_ordinal: 120,
    message: {kind: 'ai-tool-use', sourceRecordId: 'same-call', name: 'exec', input: {}, summary: 'exec'}}
  await expect(hydrateDeferredOriginalRecord(projected, record, toolUse)).rejects.toThrow()
  for (const path of [['presentation', 'isError'], ['presentation', 'parts', '0', 'text'], ['presentation', 'sourceRecordMetadata', 'ordinal']]) {
    const changed = clone(projected), tampered = changed.records[0] as DeferredOriginalRecord
    mutate(tampered, path, 'damage')
    await expect(hydrateDeferredOriginalRecord(changed, tampered, page.records[0])).rejects.toThrow()
  }
  const duplicate = {...projected, records: [record, record]}
  await expect(hydrateDeferredOriginalRecord(duplicate, record, page.records[0])).rejects.toThrow()
  const moved = {...projected, offset: 42, records: [record]}
  await expect(hydrateDeferredOriginalRecord(moved, record, page.records[0])).rejects.toThrow()
})

it('uses ordered JSON hashes and rejects changed image bytes even when text and decoded length agree', async () => {
  const {page, projected, record} = await projectedPage()
  const candidate = clone(page.records[0]) as unknown as {message: {content: string; sourceRecord: {payload: {output: ReturnType<typeof output>}}}}
  candidate.message.sourceRecord.payload.output[1].image_url = 'data:image/png;base64,AQIDBQ=='
  candidate.message.content = JSON.stringify(candidate.message.sourceRecord.payload.output, null, 2)
  await expect(hydrateDeferredOriginalRecord(projected, record, candidate)).rejects.toThrow()
  const ordered = Object.fromEntries(Object.entries(page.records[0]).reverse())
  expect(sha(JSON.stringify(ordered))).not.toBe(record.original.recordSha256)
  await expect(hydrateDeferredOriginalRecord(projected, record, ordered)).rejects.toThrow()
})

const savedPacket = process.env.DEFERRED_ORIGINAL_PACKET
it.skipIf(!savedPacket)('round-trips the saved B packet offline, retaining 80 ordered records and its colliding call IDs', async () => {
  const envelope = JSON.parse(readFileSync(savedPacket!, 'utf8'))
  const page = envelope.page as DeferredOriginalSourcePage
  expect(page.offset).toBe(27)
  expect(page.records).toHaveLength(80)
  const before = JSON.stringify(page)
  const projected = await projectDeferredOriginalPage(page, 1) as DeferredOriginalPage
  expect(JSON.stringify(page)).toBe(before)
  expect(projected.records.map(record => record.id)).toEqual(page.records.map(record => record.id))
  expect(projected.records.filter(record => record.kind === 'deferred-tool-result')).toHaveLength(1)
  const record = projected.records[16] as DeferredOriginalRecord
  expect(record.id).toBe('original:43')
  expect(record.original.binding.offset).toBe(43)
  expect(record.original.binding.sourceOrdinal).toBe(124)
  expect(record.original.images.map(image => image.decodedBytes)).toEqual([405994, 205802])
  const full = page.records[16]
  expect(record.original.recordSha256).toBe(sha(JSON.stringify(full)))
  if (!('message' in full) || full.message.kind !== 'tool-result') throw new Error('saved packet is not the expected tool result')
  expect(full.message).not.toHaveProperty('sourceRecordRaw')
  const parts = JSON.parse(full.message.content) as ReturnType<typeof output>
  for (const image of record.original.images) {
    const uri = parts[image.index].image_url!
    expect(image.uriSha256).toBe(sha(uri))
    const decoded = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
    expect(image.decodedSha256).toBe(sha(decoded))
    expect(image.uriUtf8Bytes).toBe(Buffer.byteLength(uri))
    expect(image.decodedBytes).toBe(decoded.length)
  }
  expect(record.presentation.parts.filter(part => part.kind === 'text').map(part => part.text))
    .toEqual(parts.filter(part => 'text' in part).map(part => part.text))
  const toolUse = page.records[15]
  if (!('message' in toolUse)) throw new Error('saved packet tool-use missing')
  expect(toolUse.message.sourceRecordId).toBe(full.message.sourceRecordId)
  await expect(hydrateDeferredOriginalRecord(projected, record, toolUse)).rejects.toThrow()
  expect(projected.records.filter((_, index) => index !== 16).every((value, index) => value === page.records[index < 16 ? index : index + 1])).toBe(true)
  const restored = await hydrateDeferredOriginalRecord(projected, record, full)
  expect(restored).not.toBe(full)
  expect(JSON.stringify(restored)).toBe(JSON.stringify(full))
  expect(JSON.stringify({...projected, records: projected.records.map((value, index) => index === 16 ? restored : value)})).toBe(before)
})

it('returns only the verified record snapshot when external inputs change during the final digest', async () => {
  const {page, projected, record} = await projectedPage()
  const candidate = clone(page.records[0])
  const candidateBefore = JSON.stringify(candidate)
  const descriptorBefore = clone(record.original)
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  let calls = 0
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const result = await originalDigest(...args)
    if (++calls === descriptorBefore.images.length * 2 + 2) {
      mutate(candidate, ['message', 'content'], 'damage')
      mutate(candidate, ['message', 'sourceRecord', 'payload', 'output', '0', 'text'], 'damage')
      mutate(projected, ['identity', 'source_path'], 'damage')
      mutate(projected, ['revision'], 'damage')
      mutate(record, ['original', 'binding', 'revision'], 'damage')
      mutate(record, ['presentation', 'parts', '0', 'text'], 'damage')
      projected.records[0] = {...record, id: 'original:elsewhere'}
    }
    return result
  })
  try {
    const restored = await hydrateDeferredOriginalRecord(projected, record, candidate)
    expect(calls).toBe(6)
    expect(restored).not.toBe(candidate)
    expect(JSON.stringify(restored)).toBe(candidateBefore)
    expect(restored.message.kind).toBe('tool-result')
    if (restored.message.kind !== 'tool-result') throw new Error('expected tool result')
    expect(sha(restored.message.content)).toBe(descriptorBefore.contentSha256)
    expect(sha(JSON.stringify(restored))).toBe(descriptorBefore.recordSha256)
    expect(JSON.stringify(candidate)).not.toBe(candidateBefore)
  } finally { digest.mockRestore() }
})
