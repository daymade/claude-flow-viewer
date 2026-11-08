import type {DeferredOriginalRecord, OriginalRecord} from './deferred-original'

/** The bound transport must return only a fully hydrated, verified record. */
export type ReadDeferredOriginal = (record: DeferredOriginalRecord) => Promise<OriginalRecord>
export interface DeferredOriginalState {record: OriginalRecord | null; pending: boolean; error: string | null}
const EMPTY: DeferredOriginalState = {record: null, pending: false, error: null}

/** One mounted Reader's cache. Scope includes transport owner and navigation generation. */
export function createDeferredOriginalStore(read: ReadDeferredOriginal, scope: string) {
  const states = new Map<string, DeferredOriginalState>(), pending = new Map<string, Promise<OriginalRecord>>()
  const listeners = new Set<() => void>()
  let active = true, epoch = 0
  const key = (record: DeferredOriginalRecord) => `${scope}|${JSON.stringify(record.original)}`
  const publish = (id: string, state: DeferredOriginalState) => {states.set(id, state);listeners.forEach(listener => listener())}
  return {
    activate() {active = true},
    retire() {active = false;epoch++;states.clear();pending.clear()},
    subscribe(listener: () => void) {listeners.add(listener);return () => {listeners.delete(listener)}},
    get(record: DeferredOriginalRecord) {return states.get(key(record)) ?? EMPTY},
    load(record: DeferredOriginalRecord): Promise<OriginalRecord> {
      const id = key(record), current = states.get(id)
      if (!active) return Promise.reject(new Error('Original read belongs to an earlier reader source'))
      if (current?.record) return Promise.resolve(current.record)
      const inflight = pending.get(id)
      if (inflight) return inflight
      const started = epoch
      publish(id, {record: null, pending: true, error: null})
      const promise = Promise.resolve().then(() => {
        if (!active || epoch !== started) throw new Error('Original read belongs to an earlier reader source')
        return read(record)
      }).then(full => {
        if (!active || epoch !== started) throw new Error('Original read belongs to an earlier reader source')
        publish(id, {record: full, pending: false, error: null})
        return full
      }).catch((error: unknown) => {
        if (active && epoch === started) publish(id, {record: null, pending: false, error: error instanceof Error ? error.message : String(error)})
        throw error
      }).finally(() => {if (epoch === started) pending.delete(id)})
      pending.set(id, promise)
      return promise
    },
  }
}
export type DeferredOriginalStore = ReturnType<typeof createDeferredOriginalStore>
