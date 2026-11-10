import type {ConversationPage, FlowConversationRecord} from './reader-page'

/** Ordered JSON.stringify UTF-8, not canonical JSON or original JSONL bytes. */
export const DEFERRED_ORIGINAL_HASH = 'sha256-json-stringify-utf8-v1' as const
export const DEFERRED_ORIGINAL_VERSION = 1 as const

export type DeferredOriginalSourcePage = Omit<ConversationPage, 'until'> & {until?: number | string}
export type OriginalRecord = FlowConversationRecord & {source_session: string; source_ordinal: number}
type JsonObject = Record<string, unknown>
type OriginalPageBinding = Pick<DeferredOriginalSourcePage, 'provider' | 'session_id' | 'identity' | 'revision' | 'until' | 'offset'>

export interface DeferredOriginalImage {
  index: number
  mediaType: string
  uriUtf8Bytes: number
  uriSha256: string
  decodedBytes: number
  decodedSha256: string
}
export type DeferredOriginalPart =
  | {kind: 'text'; type: 'input_text' | 'output_text' | 'text'; text: string}
  | {kind: 'image'; type: 'input_image'; image: DeferredOriginalImage; detail?: 'auto' | 'low' | 'high'}

export interface DeferredOriginalDescriptor {
  version: 1
  hashAlgorithm: typeof DEFERRED_ORIGINAL_HASH
  binding: {
    provider: 'codex'
    sessionId: string
    identity: NonNullable<ConversationPage['identity']>
    revision: string
    until: number | string
    recordId: string
    offset: number
    sourceSession: string
    sourceOrdinal: number
  }
  recordSha256: string
  contentSha256: string
  images: DeferredOriginalImage[]
  /** Both fields are absent for the existing object-only representation. */
  representation?: 'strict-raw-utf8-v1'
  sourceRecordRaw?: {hashAlgorithm: 'sha256-utf8-v1'; utf8Bytes: number; sha256: string}
}

/** This is deliberately not a FlowConversationRecord or a SessionMessage. */
export interface DeferredOriginalRecord {
  kind: 'deferred-tool-result'
  id: string
  source_session: string
  source_ordinal: number
  timestamp?: string | null
  presentation: {
    kind: 'tool-result-presentation'
    isError: boolean
    timestamp?: string
    sourceRecordId?: string
    toolUseId?: string
    externalFile?: string
    totalSize?: string
    contentFormat: 'json-stringify-2'
    parts: DeferredOriginalPart[]
    sourceRecordMetadata: JsonObject
  }
  original: DeferredOriginalDescriptor
}

export type DeferredOriginalPage<T extends DeferredOriginalSourcePage = DeferredOriginalSourcePage> =
  Omit<T, 'records'> & {records: Array<T['records'][number] | DeferredOriginalRecord>}

/** Validate a presentation's complete shape and current page binding, never its omitted bytes. */
export function validateDeferredOriginalRecord(page: OriginalPageBinding, index: number, value: unknown): asserts value is DeferredOriginalRecord {
  const invalid = () => {throw new Error('Invalid deferred original presentation or page binding')}
  if (!object(value) || value.kind !== 'deferred-tool-result' || !object(value.original) || !object(value.presentation)) return invalid()
  const descriptor = value.original, binding = descriptor.binding, presentation = value.presentation, bound = context(page)
  if (!bound || descriptor.version !== 1 || descriptor.hashAlgorithm !== DEFERRED_ORIGINAL_HASH || !object(binding)
      || !integer(index) || binding.offset !== page.offset + index || value.id !== `original:${binding.offset}`
      || binding.recordId !== value.id || binding.sourceSession !== value.source_session || !nonempty(binding.sourceSession)
      || binding.sourceOrdinal !== value.source_ordinal || !integer(binding.sourceOrdinal)
      || orderedJson({provider: binding.provider, sessionId: binding.sessionId, identity: binding.identity, revision: binding.revision, until: binding.until}) !== orderedJson(bound)
      || presentation.kind !== 'tool-result-presentation' || presentation.contentFormat !== 'json-stringify-2'
      || typeof presentation.isError !== 'boolean' || !object(presentation.sourceRecordMetadata)
      || presentation.sourceRecordMetadata.ordinal !== binding.sourceOrdinal
      || !Array.isArray(presentation.parts) || !Array.isArray(descriptor.images) || descriptor.images.length === 0
      || ![descriptor.recordSha256, descriptor.contentSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return invalid()
  const strict = Object.hasOwn(descriptor, 'representation') || Object.hasOwn(descriptor, 'sourceRecordRaw')
  const descriptorKeys = ['version', 'hashAlgorithm', 'binding', 'recordSha256', 'contentSha256', 'images',
    ...(strict ? ['representation', 'sourceRecordRaw'] : [])]
  if (Object.keys(descriptor).some(key => !descriptorKeys.includes(key))
      || Object.hasOwn(presentation, 'sourceRecordRaw')) return invalid()
  if (strict) {
    const raw = descriptor.sourceRecordRaw
    if (descriptor.representation !== 'strict-raw-utf8-v1' || !object(raw)
        || Object.keys(raw).sort().join(',') !== 'hashAlgorithm,sha256,utf8Bytes'
        || raw.hashAlgorithm !== 'sha256-utf8-v1' || !integer(raw.utf8Bytes) || raw.utf8Bytes === 0
        || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) return invalid()
  }
  const images: unknown[] = []
  for (const [index, part] of presentation.parts.entries()) {
    if (!object(part)) return invalid()
    if (part.kind === 'text') {
      if (!['input_text', 'output_text', 'text'].includes(String(part.type)) || typeof part.text !== 'string') return invalid()
    } else if (part.kind === 'image') {
      const image = part.image
      if (part.type !== 'input_image' || !object(image) || image.index !== index || !nonempty(image.mediaType)
          || !integer(image.uriUtf8Bytes) || image.uriUtf8Bytes === 0 || !integer(image.decodedBytes) || image.decodedBytes === 0
          || ![image.uriSha256, image.decodedSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
          || ('detail' in part && !['auto', 'low', 'high'].includes(String(part.detail)))) return invalid()
      images.push(image)
    } else return invalid()
  }
  if (orderedJson(images) !== orderedJson(descriptor.images)) return invalid()
}

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const without = (value: JsonObject, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
const utf8 = (value: string) => new TextEncoder().encode(value)
const orderedJson = (value: unknown): string => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Deferred original requires a JSON representation')
  return serialized
}
const snapshot = <T>(value: T): T => JSON.parse(orderedJson(value)) as T
async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
}
const jsonHash = (value: unknown) => hash(utf8(orderedJson(value)))

function context(page: OriginalPageBinding) {
  const identity = page.identity
  if (page.provider !== 'codex' || !nonempty(page.session_id) || !nonempty(page.revision)
      || !(nonempty(page.until) || integer(page.until)) || !integer(page.offset)
      || !object(identity) || !nonempty(identity.node) || identity.provider !== 'codex'
      || identity.session_id !== page.session_id || !nonempty(identity.source_path)) return null
  return {provider: 'codex' as const, sessionId: page.session_id, identity: JSON.parse(orderedJson(identity)) as typeof identity,
    revision: page.revision, until: page.until as number | string}
}

function imageBytes(uri: string): {mediaType: string; bytes: Uint8Array<ArrayBuffer>} | null {
  // Only a known image part's image_url enters here; never scan arbitrary text.
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri)
  if (!match || !match[2] || match[2].length % 4 !== 0) return null
  try {
    const decoded = atob(match[2])
    if (btoa(decoded) !== match[2]) return null
    return {mediaType: match[1], bytes: Uint8Array.from(decoded, char => char.charCodeAt(0))}
  } catch { return null }
}

async function projectRecord(page: OriginalPageBinding, index: number, value: unknown, strictRaw = false): Promise<DeferredOriginalRecord | null> {
  const bound = context(page)
  if (!bound || !object(value) || value.kind !== 'flow-message' || !nonempty(value.id)
      || value.id !== `original:${page.offset + index}` || !nonempty(value.source_session)
      || !integer(value.source_ordinal) || !object(value.message)) return null
  const message = value.message
  if (message.kind !== 'tool-result' || typeof message.content !== 'string' || typeof message.isError !== 'boolean'
      || !object(message.sourceRecord)) return null
  if (Object.keys(message).some(key => !['kind', 'content', 'isError', 'sourceRecord', 'sourceRecordRaw', 'sourceRecordId', 'timestamp', 'toolUseId', 'externalFile', 'totalSize'].includes(key))) return null
  const source = message.sourceRecord
  const payload = source.payload
  if (source.type !== 'response_item' || source.ordinal !== value.source_ordinal || !object(payload)
      || !['custom_tool_call_output', 'function_call_output'].includes(String(payload.type))
      || !Array.isArray(payload.output) || message.content !== JSON.stringify(payload.output, null, 2)) return null
  let rawWitness: DeferredOriginalDescriptor['sourceRecordRaw']
  if (Object.hasOwn(message, 'sourceRecordRaw')) {
    if (!strictRaw) return null
    const raw = message.sourceRecordRaw
    if (typeof raw !== 'string' || raw.length === 0 || !raw.endsWith('\n')) return null
    const bytes = utf8(raw)
    // Raw is authoritative for integer tokens, -0, whitespace and unknown fields.
    // Validate its relation to the browser's object view, never rebuild the raw line.
    try {
      if (new TextDecoder('utf-8', {fatal: true}).decode(bytes) !== raw
          || orderedJson(JSON.parse(raw)) !== orderedJson(snapshot(source))) return null
    } catch { return null }
    rawWitness = {hashAlgorithm: 'sha256-utf8-v1', utf8Bytes: bytes.length, sha256: await hash(bytes)}
  }
  const parts: DeferredOriginalPart[] = [], images: DeferredOriginalImage[] = []
  for (const [index, part] of payload.output.entries()) {
    if (!object(part)) return null
    const keys = Object.keys(part)
    if (['input_text', 'output_text', 'text'].includes(String(part.type))) {
      if (keys.some(key => key !== 'type' && key !== 'text') || typeof part.text !== 'string') return null
      parts.push({kind: 'text', type: part.type as 'input_text' | 'output_text' | 'text', text: part.text})
    } else if (part.type === 'input_image') {
      if (keys.some(key => !['type', 'image_url', 'detail'].includes(key)) || typeof part.image_url !== 'string'
          || ('detail' in part && !['auto', 'low', 'high'].includes(String(part.detail)))) return null
      const decoded = imageBytes(part.image_url)
      if (!decoded) return null
      const uri = utf8(part.image_url)
      const image = {index, mediaType: decoded.mediaType, uriUtf8Bytes: uri.length, uriSha256: await hash(uri),
        decodedBytes: decoded.bytes.length, decodedSha256: await hash(decoded.bytes)}
      images.push(image)
      parts.push({kind: 'image', type: 'input_image', image,
        ...('detail' in part ? {detail: part.detail as 'auto' | 'low' | 'high'} : {})})
    } else return null
  }
  if (images.length === 0) return null
  const payloadMetadata = without(payload, ['output'])
  const messageMetadata = without(message, ['content', 'sourceRecord', 'sourceRecordRaw', 'kind'])
  const recordMetadata = without(value, ['message', 'kind'])
  return {
    ...recordMetadata,
    kind: 'deferred-tool-result', id: value.id, source_session: value.source_session, source_ordinal: value.source_ordinal,
    presentation: {...messageMetadata, kind: 'tool-result-presentation', isError: message.isError,
      contentFormat: 'json-stringify-2', parts, sourceRecordMetadata: {...source, payload: payloadMetadata}},
    original: {version: 1, hashAlgorithm: DEFERRED_ORIGINAL_HASH,
      binding: {...bound, recordId: value.id, offset: page.offset + index,
        sourceSession: value.source_session, sourceOrdinal: value.source_ordinal},
      recordSha256: await jsonHash(snapshot(value)), contentSha256: await hash(utf8(message.content)), images,
      ...(rawWitness ? {representation: 'strict-raw-utf8-v1' as const, sourceRecordRaw: rawWitness} : {})},
  }
}

/** Call only after the existing full-page and independent source-authority checks succeed.
 * No capability, unknown shape or unsupported output leaves the complete original unchanged.
 * Find/Raw completeness requires hydration; presentation.parts is not the original content.
 */
export async function projectDeferredOriginalPage<T extends DeferredOriginalSourcePage>(page: T, capability?: number): Promise<T | DeferredOriginalPage<T>> {
  if ((capability !== DEFERRED_ORIGINAL_VERSION && capability !== 2) || !context(page)) return page
  const ids = page.records.map(record => record.id)
  if (new Set(ids).size !== ids.length) return page
  let changed = false
  const records = await Promise.all(page.records.map(async (record, index) => {
    const projected = await projectRecord(page, index, record, capability === 2)
    if (projected) changed = true
    return projected ?? record
  }))
  return changed ? {...page, records} : page
}

/** Revalidate the current page binding and entire candidate before publishing any original fields.
 * Snapshot the single record, descriptor and page binding before awaiting hashes; return only
 * that verified snapshot. The caller still owns cancellation and current-page adoption.
 */
export async function hydrateDeferredOriginalRecord(
  page: Omit<DeferredOriginalSourcePage, 'records'> & {records: unknown[]},
  projected: DeferredOriginalRecord,
  candidate: unknown,
): Promise<OriginalRecord> {
  const recordSnapshot = snapshot(candidate)
  const projectedSnapshot = snapshot(projected)
  const pageBinding = snapshot({provider: page.provider, session_id: page.session_id, identity: page.identity,
    revision: page.revision, until: page.until, offset: page.offset})
  if (!object(projectedSnapshot) || !object(projectedSnapshot.original) || !object(projectedSnapshot.original.binding)) throw new Error('Invalid deferred original descriptor')
  const offset = projectedSnapshot.original.binding.offset
  if (!integer(offset) || !integer(pageBinding.offset)) throw new Error('Invalid deferred original coordinate')
  const index = offset - pageBinding.offset
  if (!integer(index) || index >= page.records.length
      || page.records.filter(record => object(record) && record.id === projectedSnapshot.id).length !== 1
      || orderedJson(snapshot(page.records[index])) !== orderedJson(projectedSnapshot)) throw new Error('Deferred original is not the unique current page record')
  const expected = await projectRecord(pageBinding, index, recordSnapshot, true)
  if (!expected || orderedJson(expected) !== orderedJson(projectedSnapshot)) throw new Error('Deferred original integrity or source binding mismatch')
  return recordSnapshot as OriginalRecord
}
