// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildStandaloneHTML } from '../export-html'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('buildStandaloneHTML', () => {
  it('inlines same-origin linked CSS and exports the primary readable surface', async () => {
    const stylesheetHref = new URL('/assets/app.css', window.location.href).href
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('.styled { color: rgb(15, 23, 42); }', {
        status: 200,
        headers: { 'Content-Type': 'text/css' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    document.head.innerHTML = '<link rel="stylesheet" href="/assets/app.css">'
    document.body.innerHTML = `
      <div id="root">
        <div data-export-live data-export-title="Outer app shell">
          <button data-export-remove>HTML</button>
          <div data-export-primary>
            <h2>Readable conversation</h2>
            <p class="styled">Visible transcript text</p>
            <button>Load full output (8 KB)</button>
          </div>
          <section>Structure-only workspace</section>
        </div>
      </div>
    `

    const html = await buildStandaloneHTML()

    expect(fetchMock).toHaveBeenCalledWith(stylesheetHref)
    expect(html).toContain('<title>Readable conversation</title>')
    expect(html).toContain('.styled { color: rgb(15, 23, 42); }')
    expect(html).toContain('Readable conversation')
    expect(html).toContain('Visible transcript text')
    expect(html).toContain('Full output was not loaded in the app before this snapshot')
    expect(html).not.toContain('Structure-only workspace')
    expect(html).not.toContain('HTML</button>')
    expect(html).not.toContain('[data-export-primary] * { min-width')
  })

  it('falls back to live export metadata for standalone titles without cloning the app shell', async () => {
    vi.stubGlobal('fetch', vi.fn())
    document.body.innerHTML = `
      <div id="root">
        <div data-export-live data-export-title="Codex · Human readable session">
          <div data-export-primary>
            <p>Visible transcript without heading</p>
          </div>
          <section>Hidden app shell context</section>
        </div>
      </div>
    `

    const html = await buildStandaloneHTML()

    expect(html).toContain('<title>Codex · Human readable session</title>')
    expect(html).toContain('Visible transcript without heading')
    expect(html).not.toContain('Hidden app shell context')
  })
})
