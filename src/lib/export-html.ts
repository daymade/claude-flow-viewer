/**
 * Extract the current viewer state as a standalone, read-only share artifact.
 * The export path intentionally clones the current readable session surface first.
 * Export must follow the viewer/renderers instead of maintaining a separate
 * presentation layer that drifts from what users see in the app.
 */

type ExportAction = 'download' | 'print' | 'share'

interface ShareResponse {
  url: string
  id: string
}

export function exportSessionAsHTML(): void {
  void exportSessionSnapshot('download')
}

export function exportSessionAsPDF(): void {
  void exportSessionSnapshot('print')
}

export async function shareSessionSnapshot(): Promise<string | null> {
  return exportSessionSnapshot('share')
}

async function exportSessionSnapshot(action: ExportAction): Promise<string | null> {
  const html = await buildStandaloneHTML()
  if (!html) return null

  if (action === 'print') {
    openPrintWindow(html)
    return null
  }

  if (action === 'share') {
    return uploadShareSnapshot(html)
  }

  downloadHTML(html)
  return null
}

export async function buildStandaloneHTML(): Promise<string | null> {
  const root = document.getElementById('root')
  if (!root) {
    alert('Cannot export: app root element not found.')
    return null
  }

  const primarySource = document.querySelector('[data-export-primary]') as HTMLElement | null
  const liveSource = document.querySelector('[data-export-live]') as HTMLElement | null
  const snapshotSource = document.querySelector('[data-export-snapshot]') as HTMLElement | null
  const source = primarySource || liveSource || snapshotSource
  const clone = source
    ? prepareExportSnapshot(source.cloneNode(true) as HTMLElement)
    : prepareLegacyAppClone(root.cloneNode(true) as HTMLElement)

  wirePromptAnchors(clone)
  normalizeDetails(clone)

  const styles = await collectStyles()
  const title = exportTitle(clone, source === liveSource ? null : liveSource)
  const privacyWarnings = detectPrivacyWarnings(clone.outerHTML)
  const html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    styles.join('\n') + '\n' +
    '<style>\n' + exportCss() + '\n</style>\n' +
    '</head>\n<body>\n' +
    '<div class="standalone-wrapper">\n' +
    privacyWarningBanner(privacyWarnings) +
    clone.outerHTML + '\n' +
    '</div>\n' +
    '<button id="back-to-top" title="回到顶部" aria-label="回到顶部">&#8593;</button>\n' +
    '<script>\n' + exportScript() + '\n</script>\n' +
    '</body>\n</html>'

  return redactLocalPaths(html)
}

function prepareExportSnapshot(clone: HTMLElement): HTMLElement {
  clone.classList.remove('hidden')
  clone.removeAttribute('hidden')
  clone.removeAttribute('aria-hidden')
  clone.setAttribute('data-export-active', 'true')
  clone.querySelectorAll('[data-export-remove]').forEach((el) => el.remove())
  clone.querySelectorAll('button').forEach((btn) => {
    const text = btn.textContent?.trim() ?? ''
    if (/^Load full output/.test(text)) {
      const note = document.createElement('span')
      note.className = 'export-static-note'
      note.textContent = 'Full output was not loaded in the app before this snapshot; this export includes the visible preview.'
      btn.replaceWith(note)
    } else if (text === 'Collapse to preview') {
      btn.remove()
    }
  })
  return clone
}

function prepareLegacyAppClone(clone: HTMLElement): HTMLElement {
  // ── 1. Remove sidebar ──
  const flexContainer = clone.querySelector(':scope > div')
  if (flexContainer && flexContainer.children.length >= 2) {
    let sidebarRemoved = false
    for (let i = 0; i < flexContainer.children.length; i++) {
      const child = flexContainer.children[i] as HTMLElement
      const text = child.textContent || ''
      if (text.includes('Decision Flow') && text.includes('sessions')) {
        child.remove()
        sidebarRemoved = true
        break
      }
    }
    if (!sidebarRemoved && flexContainer.children.length >= 2) {
      flexContainer.children[0].remove()
    }
  }

  // ── 2. Remove Import/Export buttons ──
  clone.querySelectorAll('button').forEach(btn => {
    const t = btn.textContent?.trim()
    if (t === 'Import' || t === 'Export' || t === 'HTML' || t === 'Print/PDF' || t === 'Share') {
      // Remove the whole button group container
      const container = btn.closest('div.flex.items-center.gap-1\\.5, div[class*="items-center"][class*="gap-1"]')
      if (container) {
        container.remove()
      } else {
        btn.remove()
      }
    }
  })
  // Also remove the hidden file input
  clone.querySelectorAll('input[type="file"][accept*=".jsonl"]').forEach(el => el.remove())

  // ── 3. Fix Timeline: make prompt dots clickable, remove dead interaction ──
  clone.querySelectorAll('div').forEach(div => {
    // Identify timeline container: 72px wide with a vertical track line
    const hasTrackLine = div.querySelector('[class*="bg-stone-200"]')
    // Timeline buttons use the `absolute` Tailwind class + flex-col layout
    const timelineButtons = div.querySelectorAll('button.absolute.flex-col, button[class*="absolute"][class*="flex-col"]')
    if (timelineButtons.length < 2 || !hasTrackLine) return

    // 3a. Remove viewport indicator (amber band — dead without React scroll state)
    div.querySelectorAll('[class*="amber-50\\/80"], [class*="cursor-grab"]').forEach(el => el.remove())

    // 3b. Convert prompt dot <button> elements to <a> links
    let promptIdx = 0
    div.querySelectorAll('button[class*="absolute"][class*="flex-col"], button.absolute').forEach(btn => {
      promptIdx++
      const a = document.createElement('a')
      a.href = '#prompt-' + promptIdx
      // Copy classes (keep cursor-pointer so dots look clickable)
      a.className = btn.className
      a.setAttribute('style', btn.getAttribute('style') || '')
      a.innerHTML = btn.innerHTML
      a.style.cssText = (a.style.cssText || '') + '; text-decoration: none !important;'
      a.title = 'Jump to prompt #' + promptIdx
      btn.replaceWith(a)
    })

    // 3d. Make timeline sticky so it stays visible filling the viewport
    // (like the live app) instead of stretching with content height
    div.classList.add('export-timeline')
    div.style.setProperty('position', 'sticky', 'important')
    div.style.setProperty('top', '0', 'important')
    div.style.setProperty('height', '100vh', 'important')
    div.style.setProperty('align-self', 'flex-start', 'important')
    // Remove the fixed pixel height set on parent — not needed with sticky timeline
    const sessionView = div.parentElement
    if (sessionView) {
      sessionView.style.setProperty('height', 'auto', 'important')
      sessionView.style.setProperty('overflow', 'visible', 'important')
    }
  })

  // ── 4. Remove skill recommendations panel ──
  const skillPanel = clone.querySelector('[class*="Skill"]')
  if (skillPanel && skillPanel.textContent?.includes('SKILL IDEAS')) {
    skillPanel.remove()
  }

  return clone
}

function wirePromptAnchors(clone: HTMLElement): void {
  clone.querySelectorAll('[data-prompt]').forEach((el, idx) => {
    if (!el.id) el.id = 'prompt-' + (idx + 1)
  })

  clone.querySelectorAll('button').forEach(btn => {
    const text = btn.textContent || ''
    const match = text.match(/^#(\d+)/)
    if (match) {
      const num = match[1]
      // Replace this button with an anchor link
      const a = document.createElement('a')
      a.href = '#prompt-' + num
      a.className = btn.className
      a.setAttribute('style', btn.getAttribute('style') || '')
      // Copy inner HTML but remove any nested <button> if present
      a.innerHTML = btn.innerHTML
      a.style.cssText = (a.style.cssText || '') + '; text-decoration: none !important;'
      // Ensure it has the same appearance as the button
      btn.replaceWith(a)
    }
  })
}

function normalizeDetails(clone: HTMLElement): void {
  clone.querySelectorAll('details[data-export-open], [data-export-open] details').forEach((el) => {
    if (el instanceof HTMLDetailsElement) el.open = true
  })
}

async function collectStyles(): Promise<string[]> {
  const styles: string[] = []
  document.querySelectorAll('style').forEach(s => {
    styles.push(s.outerHTML)
  })
  const linkedStyles = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))
  for (const link of linkedStyles) {
    const href = link.href
    if (!href) continue

    const url = new URL(href, window.location.href)
    if (url.origin !== window.location.origin) {
      styles.push(link.outerHTML)
      continue
    }

    try {
      const response = await fetch(url.href)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const css = (await response.text()).replace(/<\/style/gi, '<\\/style')
      styles.push(`<style data-export-inlined-stylesheet="${escapeHtml(url.href)}">\n${css}\n</style>`)
    } catch {
      styles.push(link.outerHTML)
    }
  }
  return styles
}

function exportTitle(clone: HTMLElement, fallback?: HTMLElement | null): string {
  const explicit = clone.getAttribute('data-export-title')
  if (explicit?.trim()) return explicit.trim()
  const heading = clone.querySelector('h1, h2, [data-export-heading]')?.textContent?.trim()
  if (heading) return heading
  const fallbackTitle = fallback?.getAttribute('data-export-title')?.trim()
  if (fallbackTitle) return fallbackTitle
  const fallbackHeading = fallback?.querySelector('h1, h2, [data-export-heading]')?.textContent?.trim()
  return fallbackHeading || 'Decision Flow snapshot'
}

function exportFilename(): string {
  const sources = [
    document.querySelector('[data-export-primary]') as HTMLElement | null,
    document.querySelector('[data-export-live]') as HTMLElement | null,
    document.querySelector('[data-export-snapshot]') as HTMLElement | null,
  ]
  for (const source of sources) {
    const explicit = source?.getAttribute('data-export-filename')?.trim()
    if (explicit) return explicit
  }
  return 'decision-flow-snapshot.html'
}

function detectPrivacyWarnings(raw: string): string[] {
  const warnings: string[] = []
  const checks: Array<[string, RegExp]> = [
    ['local filesystem paths', /\/Users\/[^/\s<>"']+\//],
    ['secret-like tokens', /\bsk-[A-Za-z0-9_-]{16,}\b/],
    ['environment variable assignments', /\b[A-Z][A-Z0-9_]{2,}\s*=\s*["']?[^"'\s<]{8,}/],
  ]

  for (const [label, pattern] of checks) {
    if (pattern.test(raw)) warnings.push(label)
  }
  return warnings
}

function privacyWarningBanner(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return '<div class="privacy-warning">' +
    '<strong>Privacy check:</strong> This snapshot appears to contain ' +
    escapeHtml(warnings.join(', ')) +
    '. Review before forwarding the file or link.' +
    '</div>\n'
}

function downloadHTML(html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = exportFilename()
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function openPrintWindow(html: string): void {
  const frame = document.createElement('iframe')
  frame.setAttribute('title', 'Print session snapshot')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.style.visibility = 'hidden'

  const removeFrame = () => {
    window.setTimeout(() => frame.remove(), 1000)
  }

  frame.addEventListener('load', () => {
    const win = frame.contentWindow
    if (!win) {
      alert('Cannot open print preview for this snapshot.')
      removeFrame()
      return
    }
    win.focus()
    window.setTimeout(() => {
      win.print()
      removeFrame()
    }, 250)
  }, { once: true })

  document.body.appendChild(frame)
  const doc = frame.contentDocument
  if (!doc) {
    alert('Cannot prepare print preview for this snapshot.')
    removeFrame()
    return
  }
  doc.open()
  doc.write(html)
  doc.close()
}

async function uploadShareSnapshot(html: string): Promise<string | null> {
  const response = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: exportTitle(
        (document.querySelector('[data-export-primary]') as HTMLElement | null)
        || (document.querySelector('[data-export-live]') as HTMLElement | null)
        || (document.querySelector('[data-export-snapshot]') as HTMLElement | null)
        || document.body,
        document.querySelector('[data-export-live]') as HTMLElement | null,
      ),
      html,
    }),
  })

  if (!response.ok) {
    const message = await response.text().catch(() => 'Unknown share error')
    alert(`Share link failed: ${message}`)
    return null
  }

  const payload = await response.json() as ShareResponse
  const absoluteUrl = new URL(payload.url, window.location.href).href
  await navigator.clipboard?.writeText(absoluteUrl).catch(() => undefined)
  alert(`Share link ready and copied:\n${absoluteUrl}`)
  return absoluteUrl
}

function exportCss(): string {
  return `
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    html, body, #root { margin: 0; padding: 0; background: #FAFAF8; height: auto !important; }
    body { overflow-y: auto !important; color: #0f172a; }
    .standalone-wrapper { max-width: 1180px; margin: 0 auto; padding: 24px 24px 88px; }
    .h-screen, .min-h-screen, .h-full, [class*="h-screen"] { height: auto !important; min-height: auto !important; }
    .min-h-0 { min-height: auto !important; }
    .overflow-hidden, .overflow-y-auto, .overflow-auto { overflow: visible !important; }
    .sticky:not(.export-timeline), [class*="sticky"]:not(.export-timeline) { position: relative !important; top: auto !important; }
    [data-export-primary], [data-export-live], [data-export-snapshot] { display: block !important; }
    .privacy-warning {
      margin: 0 0 18px;
      padding: 12px 14px;
      border: 1px solid #fed7aa;
      border-radius: 12px;
      background: #fff7ed;
      color: #9a3412;
      font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .privacy-warning strong { color: #7c2d12; }
    .export-static-note {
      display: inline-block;
      margin-top: 4px;
      color: #78716c;
      font: 12px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    [data-export-section] { scroll-margin-top: 28px; }
    [data-prompt]:target, [data-export-section]:target { animation: flash-target 1.5s ease-out; }
    @keyframes flash-target {
      from { background: rgba(251, 191, 36, 0.25); }
      to { background: transparent; }
    }
    #back-to-top {
      position: fixed; bottom: 28px; right: 28px; z-index: 9999;
      width: 40px; height: 40px; border-radius: 50%;
      background: white; border: 1px solid #e7e5e4;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      font-size: 18px; color: #78716c; opacity: 0; pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
    }
    #back-to-top.visible { opacity: 1; pointer-events: auto; }
    #back-to-top:hover { background: #fef7f4; color: #d97756; border-color: #d97756; transform: translateY(-2px); }
    @media (max-width: 640px) {
      .standalone-wrapper { width: 100%; padding: 14px 12px 72px; }
    }
    @media print {
      body { background: white !important; }
      .standalone-wrapper { max-width: none; padding: 0; }
      #back-to-top, [data-export-no-print] { display: none !important; }
      [data-export-section], section, details { break-inside: avoid; }
      a { color: inherit; text-decoration: none; }
    }
  `
}

function exportScript(): string {
  return `
    (function(){
      var btn=document.getElementById("back-to-top");
      function toggle(){btn.className=window.scrollY>400?"visible":"";}
      window.addEventListener("scroll",toggle,{passive:true});
      btn.addEventListener("click",function(){window.scrollTo({top:0,behavior:"smooth"});});
    })();
  `
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/\/Users\/[^/\s"'<>]+/g, '~')
    .replace(/\/home\/[^/\s"'<>]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/g, '~')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
