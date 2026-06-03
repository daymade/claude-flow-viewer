/**
 * Extract the current session view as a standalone HTML file.
 * Removes sidebar, timeline, import/export buttons, inlines styles,
 * wires up prompt index anchor links, and triggers a browser download.
 */

export function exportSessionAsHTML(): void {
  const root = document.getElementById('root')
  if (!root) {
    alert('Cannot export: app root element not found.')
    return
  }

  const clone = root.cloneNode(true) as HTMLElement

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
    if (t === 'Import' || t === 'Export') {
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

  // ── 5. Wire up prompt index: convert buttons to anchor links ──
  // Find the prompt index bar (sticky bar at top of session content)
  // It contains buttons like: <button>#1 preview...</button>
  // The main content has elements with data-prompt="N"
  clone.querySelectorAll('[data-prompt]').forEach((el, idx) => {
    el.id = 'prompt-' + (idx + 1)
  })

  // Convert prompt index buttons to anchor links
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

  // ── 6. Let the page flow naturally — timeline is sticky, body scrolls ──
  const unclipStyle = document.createElement('style')
  unclipStyle.textContent = `
    .h-screen, .min-h-screen, [class*="h-screen"] { height: auto !important; min-height: auto !important; }
    .min-h-0 { min-height: auto !important; }
    /* Convert sticky elements to relative (except the timeline which stays sticky) */
    .sticky:not(.export-timeline) { position: relative !important; }
  `
  clone.insertBefore(unclipStyle, clone.firstChild)

  // ── 7. Collect all styles ──
  const styles: string[] = []
  document.querySelectorAll('style').forEach(s => {
    styles.push(s.outerHTML)
  })

  // ── 8. Build standalone HTML ──
  const html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Claude Code 对话记录</title>\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">\n' +
    styles.join('\n') + '\n' +
    '<style>\n' +
    '  html { scroll-behavior: smooth; }\n' +
    '  html, body, #root { margin: 0; padding: 0; background: #FAFAF8; height: auto !important; }\n' +
    '  body { overflow-y: auto !important; }\n' +
    '  .standalone-wrapper { max-width: 960px; margin: 0 auto; padding: 20px 24px 80px; }\n' +
    '  .h-screen, .min-h-screen, [class*="h-screen"] { height: auto !important; min-height: auto !important; }\n' +
    '  .sticky:not(.export-timeline), [class*="sticky"]:not(.export-timeline) { position: relative !important; }\n' +
    '  .min-h-0 { min-height: auto !important; }\n' +
    '  /* Highlight the jump target briefly */\n' +
    '  [data-prompt]:target { animation: flash-target 1.5s ease-out; }\n' +
    '  @keyframes flash-target {\n' +
    '    from { background: rgba(251, 191, 36, 0.25); }\n' +
    '    to { background: transparent; }\n' +
    '  }\n' +
    '  #back-to-top {\n' +
    '    position: fixed; bottom: 28px; right: 28px; z-index: 9999;\n' +
    '    width: 40px; height: 40px; border-radius: 50%;\n' +
    '    background: white; border: 1px solid #e7e5e4;\n' +
    '    box-shadow: 0 2px 8px rgba(0,0,0,0.08);\n' +
    '    cursor: pointer; display: flex; align-items: center; justify-content: center;\n' +
    '    font-size: 18px; color: #78716c; opacity: 0; pointer-events: none;\n' +
    '    transition: opacity 0.2s, transform 0.2s;\n' +
    '  }\n' +
    '  #back-to-top.visible { opacity: 1; pointer-events: auto; }\n' +
    '  #back-to-top:hover { background: #fef7f4; color: #d97756; border-color: #d97756; transform: translateY(-2px); }\n' +
    '</style>\n' +
    '</head>\n<body>\n' +
    '<div class="standalone-wrapper">\n' +
    clone.outerHTML + '\n' +
    '</div>\n' +
    '<button id="back-to-top" title="回到顶部">&#8593;</button>\n' +
    '<script>\n' +
    '(function(){\n' +
    '  var btn=document.getElementById("back-to-top");\n' +
    '  function toggle(){btn.className=window.scrollY>400?"visible":"";}\n' +
    '  window.addEventListener("scroll",toggle,{passive:true});\n' +
    '  btn.addEventListener("click",function(){window.scrollTo({top:0,behavior:"smooth"});});\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n</html>'

  // ── 9. Trigger download ──
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'claude-conversation.html'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
