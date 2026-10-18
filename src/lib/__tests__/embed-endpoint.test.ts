import { describe, expect, it } from 'vitest'
import { bindEmbedEndpoint, embedRequestUrl } from '../embed-endpoint'

const origin = 'https://reader.example.test'
const runtimeId = '22222222-2222-4222-8222-222222222222'
const witness = 'a'.repeat(64)
const binding = `native_runtime_id=${runtimeId}&native_runtime_witness=${witness}`
describe('embed endpoint binding', () => {
  it.each([
    ['/reader/embed.html', '/api/tasks/example/conversation'],
    ['/embed.html', '/api/tasks/example/conversation'],
    ['/minions/reader/embed.html', '/minions/api/tasks/example/conversation'],
    ['/nested/app/reader/embed.html', '/nested/app/api/tasks/example/conversation'],
  ])('preserves the exact API endpoint for mount %s', (mount, endpoint) => {
    expect(bindEmbedEndpoint(endpoint, mount, origin)).toBe(endpoint)
    expect(bindEmbedEndpoint(`${endpoint}?${binding}`, mount, origin)).toBe(`${endpoint}?${binding}`)
  })
  it('preserves either literal binding order and all canonical UUID versions', () => {
    const endpoint = `/minions/api/sessions/example?native_runtime_witness=${witness}&native_runtime_id=00000000-0000-0000-0000-000000000000`
    expect(bindEmbedEndpoint(endpoint, '/minions/reader/embed.html', origin)).toBe(endpoint)
  })
  it.each([
    '', 'native_runtime_id', 'native_runtime_witness',
    `native_runtime_id=${runtimeId}`, `native_runtime_witness=${witness}`,
    `native_runtime_id=&native_runtime_witness=${witness}`,
    `native_runtime_id=null&native_runtime_witness=${witness}`,
    `native_runtime_id=${runtimeId}&native_runtime_witness=`,
    `native_runtime_id=${runtimeId}&native_runtime_witness=null`,
    `native_runtime_id=AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA&native_runtime_witness=${witness}`,
    `native_runtime_id=${runtimeId.replaceAll('-', '')}&native_runtime_witness=${witness}`,
    `native_runtime_id=${runtimeId}&native_runtime_witness=${'A'.repeat(64)}`,
    `native_runtime_id=${runtimeId}&native_runtime_witness=${'a'.repeat(63)}`,
    `${binding}&native_runtime_id=${runtimeId}`, `${binding}&native_runtime_witness=${witness}`,
    `${binding}&unknown=1`, `${binding}&offset=0`, `${binding}&limit=80`,
    `${binding}&anchor=record`, `${binding}&revision=revision`, `${binding}&until=3`,
    `${binding}&`, `&${binding}`, `${binding}&&`,
    binding.replace('native_runtime_id', 'native_runtime_%69d'),
    binding.replace(runtimeId, runtimeId.replace('2', '%32')),
    binding.replace(witness, '%61'.repeat(64)),
    `${binding}#record`, `${binding}%23record`, `${binding}%00`, `${binding}%0a`,
  ])('rejects an incomplete, nonliteral or extended runtime binding: %s', query => {
    expect(bindEmbedEndpoint(`/minions/api/tasks/example?${query}`, '/minions/reader/embed.html', origin)).toBeNull()
  })
  it.each([
    '', '/api/tasks/example', '/other/api/tasks/example',
    'https://foreign.example.test/minions/api/tasks/example', '//foreign.example.test/minions/api/tasks/example',
    '/minions/api/tasks/example#record', '/minions/api/tasks/example?query=1',
    '/minions/api/../outside', '/minions/api/%2e%2e/outside',
    '/minions/api/tasks%2f..%2f..%2foutside', '/minions/api/tasks%5coutside',
    '/minions/api/tasks\\\\outside', '/minions/api/tasks%00outside',
    '/minions/api/tasks%0aoutside', '/minions/api/tasks%FFoutside',
  ])('rejects a missing, foreign or escaping binding: %s', endpoint => {
    expect(bindEmbedEndpoint(endpoint, '/minions/reader/embed.html', origin)).toBeNull()
    expect(bindEmbedEndpoint(`${endpoint}?${binding}`, '/minions/reader/embed.html', origin)).toBeNull()
  })
})

describe('embed request URLs', () => {
  it.each(['', `?${binding}`, `?native_runtime_witness=${witness}&native_runtime_id=${runtimeId}`])('appends read parameters and tool paths without replacing the binding (%s)', suffix => {
    const endpoint = `/minions/api/sessions/encoded%20session${suffix}`
    const url = new URL(embedRequestUrl(endpoint, new URLSearchParams({offset:'-1',anchor:'record?x#y'})), origin)
    expect(url.pathname).toBe('/minions/api/sessions/encoded%20session')
    expect(url.searchParams.get('offset')).toBe('-1')
    expect(url.searchParams.get('anchor')).toBe('record?x#y')
    expect(url.searchParams.getAll('native_runtime_id')).toEqual(suffix ? [runtimeId] : [])
    expect(url.searchParams.getAll('native_runtime_witness')).toEqual(suffix ? [witness] : [])
    const tool = new URL(embedRequestUrl(endpoint, new URLSearchParams({path:'tool-results/full output?x#y.txt'}), '/tool-output'), origin)
    expect(tool.pathname).toBe('/minions/api/sessions/encoded%20session/tool-output')
    expect(tool.searchParams.get('path')).toBe('tool-results/full output?x#y.txt')
    expect(tool.searchParams.getAll('native_runtime_id')).toEqual(suffix ? [runtimeId] : [])
    expect(tool.searchParams.getAll('native_runtime_witness')).toEqual(suffix ? [witness] : [])
  })
  it.each(['native_runtime_id', 'native_runtime_witness'])('refuses a per-read parameter that could change the binding (%s)', key => {
    expect(() => embedRequestUrl(`/api/sessions/example?${binding}`, new URLSearchParams({[key]:'replacement'}))).toThrow('Cannot replace the bound runtime identity')
  })
})
