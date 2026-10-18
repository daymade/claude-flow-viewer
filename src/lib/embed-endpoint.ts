const runtimeId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const runtimeWitness = '[0-9a-f]{64}'
const runtimeBinding = new RegExp(`^(?:native_runtime_id=${runtimeId}&native_runtime_witness=${runtimeWitness}|native_runtime_witness=${runtimeWitness}&native_runtime_id=${runtimeId})$`)

export function bindEmbedEndpoint(raw: string, pathname: string, origin: string): string | null {
  const mount = '/reader/embed.html'
  const prefix = pathname.endsWith(mount) ? pathname.slice(0, -mount.length) : ''
  const unsafe = (value: string) => [...value].some(character => character === '\\' || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  if (!raw.startsWith(prefix + '/api/') || raw.includes('#') || unsafe(raw)) return null
  const separator = raw.indexOf('?')
  const rawPath = separator < 0 ? raw : raw.slice(0, separator)
  if (separator >= 0 && !runtimeBinding.test(raw.slice(separator + 1))) return null
  try {
    const endpoint = new URL(raw, origin)
    const decoded = decodeURIComponent(endpoint.pathname)
    if (endpoint.origin !== origin || endpoint.pathname !== rawPath || unsafe(decoded)
      || decoded.split('/').some(segment => segment === '.' || segment === '..')) return null
    return raw
  } catch {
    return null
  }
}

// Only a bound endpoint reaches this composer. Keep its identity query apart
// from per-read parameters, and add resource paths before either query.
export function embedRequestUrl(endpoint: string, query: URLSearchParams, suffix: '' | '/tool-output' = ''): string {
  const separator = endpoint.indexOf('?')
  const pathname = separator < 0 ? endpoint : endpoint.slice(0, separator)
  const parameters = new URLSearchParams(separator < 0 ? '' : endpoint.slice(separator + 1))
  for (const [key, value] of query) {
    if (key === 'native_runtime_id' || key === 'native_runtime_witness') throw new Error('Cannot replace the bound runtime identity')
    parameters.append(key, value)
  }
  return pathname + suffix + (parameters.size ? '?' + parameters : '')
}
