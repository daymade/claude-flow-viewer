export function bindEmbedEndpoint(raw: string, pathname: string, origin: string): string | null {
  const mount = '/reader/embed.html'
  const prefix = pathname.endsWith(mount) ? pathname.slice(0, -mount.length) : ''
  const unsafe = (value: string) => [...value].some(character => character === '\\' || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  if (!raw.startsWith(prefix + '/api/') || raw.includes('?') || raw.includes('#') || unsafe(raw)) return null
  try {
    const endpoint = new URL(raw, origin)
    const decoded = decodeURIComponent(endpoint.pathname)
    if (endpoint.origin !== origin || endpoint.pathname !== raw || unsafe(decoded)
      || decoded.split('/').some(segment => segment === '.' || segment === '..')) return null
    return raw
  } catch {
    return null
  }
}
