/// <reference types="node" />
// @vitest-environment jsdom
import {webcrypto} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import {SessionReader} from './SessionReader'
import {normalizeConversationPage, type ConversationPage} from '../../lib/reader-page'
import {hydrateDeferredOriginalRecord, projectDeferredOriginalPage, type DeferredOriginalRecord, type OriginalRecord} from '../../lib/deferred-original'

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {observe() {} disconnect() {}}, IntersectionObserver: class {observe() {} disconnect() {}}})
beforeEach(() => {vi.stubGlobal('crypto', webcrypto)})
afterEach(() => {cleanup();vi.unstubAllGlobals()})
function fullPage(): ConversationPage {
  const output = [{type: 'input_text', text: 'before image\n'}, {type: 'input_image', image_url: 'data:image/png;base64,AQIDBA==', detail: 'high'},
    {type: 'text', text: 'between images\n'}, {type: 'input_image', image_url: 'data:image/jpeg;base64,/wAB', detail: 'high'}, {type: 'text', text: 'after image\n'}]
  return {provider: 'codex', session_id: 'session-synthetic', revision: 'revision-one', until: 'original:4',
    identity: {node: 'synthetic-node', provider: 'codex', session_id: 'session-synthetic', source_path: '/synthetic/session.jsonl'},
    records: [
      {kind: 'flow-message', id: 'original:0', message: {kind: 'ai-text', text: 'Visible conversation text'}},
      {kind: 'flow-message', id: 'original:1', message: {kind: 'ai-tool-use', sourceRecordId: 'same-call', name: 'exec', summary: 'exec', input: {raw: 'original tool input'}}},
      {kind: 'flow-message', id: 'original:2', source_session: 'session-synthetic', source_ordinal: 124,
        message: {kind: 'tool-result', sourceRecordId: 'same-call', isError: false, content: JSON.stringify(output, null, 2),
          sourceRecord: {type: 'response_item', ordinal: 124, payload: {type: 'custom_tool_call_output', call_id: 'same-call', output}}}},
      {kind: 'flow-message', id: 'original:3', message: {kind: 'ai-text', text: 'Last normal text'}},
    ] as ConversationPage['records'], total: 4, offset: 0, next_offset: 4, has_earlier: false, has_later: false,
    read_at: '2026-11-08T00:00:00Z', boundary: 'synthetic exact original page'}
}
function pending<T>() {let resolve!: (value: T) => void;const promise = new Promise<T>(done => {resolve = done});return {promise, resolve}}
function open(details: HTMLDetailsElement) {act(() => {details.open = true;fireEvent(details, new Event('toggle'))})}
function resultDetails(container: HTMLElement) {return [...container.querySelectorAll('details')].find(details => details.querySelector(':scope > summary')?.textContent === 'Result')!}
function rawDetails(container: HTMLElement) {return [...container.querySelectorAll('details')].find(details => details.querySelector(':scope > summary')?.textContent === 'Original native record')!}

it('keeps explicit-target forceMount free of reads, then shares Tool, Raw and two images with one verified result', async () => {
  const full = fullPage(), projected = await projectDeferredOriginalPage(full, 1) as ConversationPage
  const read = vi.fn(async (record: DeferredOriginalRecord) => hydrateDeferredOriginalRecord(projected, record, full.records[2]))
  const {container} = render(<SessionReader data={normalizeConversationPage(projected)} activeSearchTarget={{messageIndex: 2, requestId: 'birth'}} readDeferredOriginal={read} deferredOriginalScope="endpoint|channel|session|generation-1" showTimeline={false} showPromptIndex={false}/>)
  expect(read).not.toHaveBeenCalled()
  expect(container.textContent).toContain('before image\n')
  expect(container.textContent).toContain('between images\n')
  expect(container.textContent).toContain('after image\n')
  expect(container.innerHTML).not.toContain('base64,')
  expect(container.querySelectorAll('img')).toHaveLength(0)
  open(resultDetails(container))
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
  expect(read).toHaveBeenCalledTimes(1)
  const original = full.records[2]
  if (!('message' in original) || original.message.kind !== 'tool-result') throw new Error('fixture')
  expect(resultDetails(container).querySelector('pre')?.textContent).toBe(original.message.content)
  open(rawDetails(container))
  await waitFor(() => expect(rawDetails(container).querySelector('pre')?.textContent).toBe(JSON.stringify(original.message.sourceRecord, null, 2)))
  expect(read).toHaveBeenCalledTimes(1)
  open(container.querySelector('[data-message-index="1"] details') as HTMLDetailsElement)
  expect(container.textContent).toContain('original tool input')
})

it('awaits hidden Raw/base64 Find coverage without reporting zero or resetting the input or pending scroll', async () => {
  const full = fullPage(), projected = await projectDeferredOriginalPage(full, 1) as ConversationPage
  const held = pending<OriginalRecord>()
  const read = vi.fn(() => held.promise)
  const {container} = render(<SessionReader data={normalizeConversationPage(projected)} readDeferredOriginal={read} deferredOriginalScope="owner-one" showTimeline={false} showPromptIndex={false}/>)
  fireEvent.click(screen.getByRole('button', {name: 'Find'}))
  const input = screen.getByRole('searchbox', {name: 'Find in conversation'})
  const scroller = container.querySelector('[data-export-primary]') as HTMLElement
  scroller.scrollTop = 77
  fireEvent.change(input, {target: {value: 'AQIDBA=='}})
  await waitFor(() => expect(screen.getByText('Searching complete original…')).toBeTruthy())
  expect(container.querySelector('.reader-match-count')).toBeNull()
  expect(scroller.scrollTop).toBe(77)
  const record = projected.records[2] as DeferredOriginalRecord
  const verified = await hydrateDeferredOriginalRecord(projected, record, full.records[2])
  await act(async () => {held.resolve(verified);await held.promise})
  await waitFor(() => expect(container.querySelector('.reader-match-count')?.textContent).toBe('1/1'))
  expect(input).toBe(screen.getByRole('searchbox', {name: 'Find in conversation'}))
  expect((input as HTMLInputElement).value).toBe('AQIDBA==')
  expect(read).toHaveBeenCalledTimes(1)
  expect(rawDetails(container).querySelector('pre')?.textContent).toContain('AQIDBA==')
  const old = render(<SessionReader data={normalizeConversationPage(full)} showTimeline={false} showPromptIndex={false}/>)
  fireEvent.click(within(old.container).getByRole('button', {name: 'Find'}))
  fireEvent.change(within(old.container).getByRole('searchbox'), {target: {value: 'AQIDBA=='}})
  expect(old.container.querySelector('.reader-match-count')?.textContent).toBe('1/1')
})

it('keeps an empty query read-free and retires late bytes and search counts after owner/revision changes', async () => {
  const full = fullPage(), projected = await projectDeferredOriginalPage(full, 1) as ConversationPage
  const held = pending<OriginalRecord>(), read = vi.fn(() => held.promise)
  const {container, rerender} = render(<SessionReader data={normalizeConversationPage(projected)} readDeferredOriginal={read} deferredOriginalScope="endpoint-A|channel-A|revision-one" showTimeline={false} showPromptIndex={false}/>)
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', {name: 'Find'}))
  fireEvent.change(screen.getByRole('searchbox'), {target: {value: 'AQIDBA=='}})
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  const next = {...fullPage(), revision: 'revision-two'}
  const newer = await projectDeferredOriginalPage(next, 1) as ConversationPage
  const newerRead = vi.fn(() => new Promise<OriginalRecord>(() => {}))
  rerender(<SessionReader data={normalizeConversationPage(newer)} readDeferredOriginal={newerRead} deferredOriginalScope="endpoint-B|channel-B|revision-two" showTimeline={false} showPromptIndex={false}/>)
  const verified = await hydrateDeferredOriginalRecord(projected, projected.records[2] as DeferredOriginalRecord, full.records[2])
  await act(async () => {held.resolve(verified);await held.promise})
  expect(container.innerHTML).not.toContain('base64,')
  expect(container.querySelector('.reader-match-count')).toBeNull()
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('AQIDBA==')
  expect(screen.getByText('Searching complete original…')).toBeTruthy()
})

it('reports a complete-Find failure explicitly and preserves the original controls', async () => {
  const projected = await projectDeferredOriginalPage(fullPage(), 1) as ConversationPage
  const read = vi.fn(async () => {throw new Error('source snapshot changed')})
  const {container} = render(<SessionReader data={normalizeConversationPage(projected)} readDeferredOriginal={read} deferredOriginalScope="owner" showTimeline={false} showPromptIndex={false}/>)
  fireEvent.click(screen.getByRole('button', {name: 'Find'}))
  fireEvent.change(screen.getByRole('searchbox'), {target: {value: 'missing needle'}})
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('source snapshot changed'))
  expect(container.querySelector('.reader-match-count')).toBeNull()
})

it('keeps two deferred results with the same call ID in separate record/ordinal cache entries', async () => {
  const full = fullPage(), second = JSON.parse(JSON.stringify(full.records[2]))
  second.id = 'original:3';second.source_ordinal = 128;second.message.sourceRecord.ordinal = 128
  second.message.sourceRecord.payload.output[0].text = 'SECOND result output\n'
  second.message.content = JSON.stringify(second.message.sourceRecord.payload.output, null, 2)
  full.records = [...full.records.slice(0, 3), second, {...full.records[3], id: 'original:4'}]
  full.total = 5;full.next_offset = 5;full.until = 'original:5'
  const projected = await projectDeferredOriginalPage(full, 1) as ConversationPage
  const read = vi.fn(async (record: DeferredOriginalRecord) => hydrateDeferredOriginalRecord(projected, record, full.records[record.original.binding.offset]))
  const {container} = render(<SessionReader data={normalizeConversationPage(projected)} readDeferredOriginal={read} deferredOriginalScope="collision-owner" showTimeline={false} showPromptIndex={false}/>)
  const firstRow = container.querySelector('[data-message-index="2"]') as HTMLElement
  const secondRow = container.querySelector('[data-message-index="3"]') as HTMLElement
  open(resultDetails(firstRow));await waitFor(() => expect(firstRow.querySelectorAll('img')).toHaveLength(2))
  expect(secondRow.innerHTML).not.toContain('base64,')
  open(resultDetails(secondRow));await waitFor(() => expect(secondRow.querySelectorAll('img')).toHaveLength(2))
  expect(resultDetails(firstRow).querySelector('pre')?.textContent).not.toContain('SECOND result output')
  expect(resultDetails(secondRow).querySelector('pre')?.textContent).toContain('SECOND result output')
  expect(read.mock.calls.map(([record]) => record.id)).toEqual(['original:2', 'original:3'])
})

const savedPacket = process.env.DEFERRED_ORIGINAL_PACKET
it.skipIf(!savedPacket)('renders the saved B page through the real Reader, keeping all 80 records and exact original43 Tool/Raw', async () => {
  const full = JSON.parse(readFileSync(savedPacket!, 'utf8')).page as ConversationPage
  const projected = await projectDeferredOriginalPage(full, 1) as ConversationPage
  expect(projected.records).toHaveLength(80)
  const data = normalizeConversationPage(projected), old = normalizeConversationPage(full)
  expect(data.messages).toHaveLength(80)
  for (const [index, message] of data.messages.entries()) if (index !== 16) expect(message).toEqual(old.messages[index])
  const read = vi.fn(async (record: DeferredOriginalRecord) => hydrateDeferredOriginalRecord(projected, record, full.records[16]))
  const {container} = render(<SessionReader data={data} activeSearchTarget={{messageIndex: 16, requestId: 'original43'}} readDeferredOriginal={read} deferredOriginalScope="saved-B-owner" showTimeline={false} showPromptIndex={false}/>)
  expect(read).not.toHaveBeenCalled()
  expect(container.innerHTML).not.toContain('base64,')
  const row = container.querySelector('[data-message-index="16"]') as HTMLElement
  expect(row.textContent).toContain('Script completed')
  open(resultDetails(row))
  await waitFor(() => expect(row.querySelectorAll('img')).toHaveLength(2))
  const record = full.records[16]
  if (!('message' in record) || record.message.kind !== 'tool-result') throw new Error('saved fixture')
  expect(resultDetails(row).querySelector('pre')?.textContent).toBe(record.message.content)
  open(rawDetails(row))
  expect(rawDetails(row).querySelector('pre')?.textContent).toBe(JSON.stringify(record.message.sourceRecord, null, 2))
  expect(read).toHaveBeenCalledTimes(1)
})
