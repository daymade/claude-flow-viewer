import {useCallback, useSyncExternalStore} from 'react'
import type {DeferredOriginalRecord} from '../../lib/deferred-original'
import {useSessionResources} from './SessionResources'
import {DeferredDetails} from './DeferredDetails'

const EMPTY = {record: null, pending: false, error: null}
const noSubscribe = () => () => {}
function useDeferredOriginal(record: DeferredOriginalRecord) {
  const resources = useSessionResources()
  const store = resources && typeof resources !== 'function' ? resources.deferredOriginal : null
  const get = useCallback(() => store?.get(record) ?? EMPTY, [store, record])
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, get, get)
  const load = () => {if (store) void store.load(record).catch(() => {})}
  return {...state, load, available: Boolean(store)}
}
export function DeferredToolResult({record, forceMount = false}: {record: DeferredOriginalRecord; forceMount?: boolean}) {
  const state = useDeferredOriginal(record)
  const full = state.record?.message
  const output = full?.sourceRecord?.payload as {output?: Array<{image_url?: string}>} | undefined
  return <DeferredDetails className="ml-6" forceMount={forceMount} onOpen={state.load}>
    <summary className="cursor-pointer py-0.5 pl-5 text-xs text-stone-500">{record.presentation.isError ? 'Error' : 'Result'}</summary>
    {() => <>
      {full?.kind === 'tool-result'
        ? <pre className="mt-0.5 ml-5 p-3 bg-stone-50 text-[13px] max-h-[400px] overflow-auto whitespace-pre-wrap break-words">{full.content}</pre>
        : <div className="ml-5 whitespace-pre-wrap text-[13px]">{record.presentation.parts.map((part, index) => part.kind === 'text'
          ? <span key={index}>{part.text}</span>
          : <button type="button" className="block text-amber-700" key={index} onClick={state.load} disabled={!state.available}>Load image {record.original.images.findIndex(image => image.index === index) + 1} ({part.image.mediaType}, {part.image.decodedBytes} bytes)</button>)}</div>}
      {full && record.original.images.map((image, index) => {
        const uri = output?.output?.[image.index]?.image_url
        return typeof uri === 'string' ? <img key={image.index} alt={`Tool output image ${index + 1}`} src={uri} className="ml-5 max-w-full max-h-[400px] object-contain"/> : null
      })}
      {state.pending && <p role="status" className="ml-5 text-xs text-stone-500">Loading original…</p>}
      {state.error && <p role="alert" className="ml-5 text-xs text-rose-700">{state.error} <button type="button" onClick={state.load}>Retry</button></p>}
      {!state.available && <p role="status" className="ml-5 text-xs text-stone-500">Complete original is unavailable in this reader.</p>}
    </>}
  </DeferredDetails>
}
export function DeferredSourceRecord({record, forceMount = false}: {record: DeferredOriginalRecord; forceMount?: boolean}) {
  const state = useDeferredOriginal(record), message = state.record?.message
  return <DeferredDetails forceMount={forceMount} onOpen={state.load} className="ml-6 my-2 text-[11px] text-stone-400">
    <summary className="cursor-pointer">Original native record</summary>
    {() => message ? <pre className="p-3 whitespace-pre-wrap break-words max-h-80 overflow-auto bg-stone-50">{message.sourceRecordRaw ?? JSON.stringify(message.sourceRecord, null, 2)}</pre>
      : <div><p role={state.error ? 'alert' : 'status'}>{state.error ?? (state.pending ? 'Loading original…' : 'Complete original has not been loaded.')}</p><button type="button" onClick={state.load} disabled={!state.available || state.pending}>Load original</button></div>}
  </DeferredDetails>
}
