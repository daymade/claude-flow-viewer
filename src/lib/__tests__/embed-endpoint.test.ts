import { describe, expect, it } from 'vitest'
import { bindEmbedEndpoint } from '../embed-endpoint'

const origin = 'https://reader.example.test'
describe('embed endpoint binding', () => {
  it.each([
    ['/reader/embed.html', '/api/tasks/example/conversation'],
    ['/embed.html', '/api/tasks/example/conversation'],
    ['/minions/reader/embed.html', '/minions/api/tasks/example/conversation'],
    ['/nested/app/reader/embed.html', '/nested/app/api/tasks/example/conversation'],
  ])('preserves the exact API endpoint for mount %s', (mount, endpoint) => {
    expect(bindEmbedEndpoint(endpoint, mount, origin)).toBe(endpoint)
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
  })
})
