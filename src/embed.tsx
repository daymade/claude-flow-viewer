import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { SessionReader } from './components/session/SessionReader'
import {normalizeConversationPage as adapt,resolveConversationAnchor,type ConversationPage as Page} from './lib/reader-page'
import type { ReaderJumpTarget } from './components/session/SessionView'
import { bindEmbedEndpoint, embedRequestUrl } from './lib/embed-endpoint'
import './index.css'
import './embed.css'
const CONVERSATION_FILTER = {thinking:false,toolCalls:false,toolResults:false}
// Transcript anchors pointing at local files (absolute paths, relative text
// files, encoded paths, file: URLs) must never navigate the embed: the host
// does not serve them and the iframe would be replaced by a browser error
// page, discarding the mounted reader. The shell captures clicks and first
// classifies explicit local forms from the author's own href — ~, drive
// letters, raw or percent-encoded filesystem roots, file: URLs. Those are
// confirmed file references and report the actual reference, never the
// pathname the /reader/embed.html base URL would derive. App routes keep
// default behavior only when explicitly written — root-relative (/…) or
// absolute same-origin http(s) URLs for the host's own /api and /reader
// routes; a plain relative path (report.md, ./x, notes/y.md) is never
// promoted into an app route by the base URL. Pure #fragments keep their
// default behavior. Explicit http(s) and protocol-relative
// web links open a new tab without replacing the mounted reader. Everything
// else same-origin is blocked: confirmed
// filesystem paths are reported as local file references, anything else as an
// unbound reference carrying the author's original href verbatim.
// Blocking only reports the boundary — it never reads the referenced file.
const FILESYSTEM_ROOTS=['/Users/','/home/','/root/','/private/','/Volumes/','/Library/','/Applications/','/System/','/tmp/','/var/','/etc/','/usr/','/opt/','/srv/','/mnt/','/media/']
type BlockedLink={label:string;kind:'file'|'unknown';reference:string|null;recordId:string|null}
function decodePathname(pathname:string){
  // Encoded slashes decode next to the literal leading slash (`/%2FUsers/…` →
  // `//Users/…`); collapse duplicate slashes so filesystem roots still match
  // and the reported path reads as the referenced file.
  try{return decodeURIComponent(pathname).replace(/\/{2,}/g,'/')}catch{return pathname}
}
function isFilesystemPath(path:string){return path.startsWith('~')||/^[A-Za-z]:[\\/]/.test(path)||FILESYSTEM_ROOTS.some(root=>path.startsWith(root))}
function isAppRoute(path:string){return path.startsWith('/api/')||path==='/reader'||path.startsWith('/reader/')||path.startsWith('/reader.')}
function classifyAnchor(anchor:HTMLAnchorElement):{blocked:false;newTab?:true}|{blocked:true;kind:'file'|'unknown';reference:string|null}{
  const raw=anchor.getAttribute('href')
  if(raw==null)return{blocked:false}
  const href=raw.trim()
  if(!href)return{blocked:true,kind:'unknown',reference:null}
  if(href.startsWith('#')||href.startsWith('?'))return{blocked:false}
  // Explicit local forms are recognized on the author's own href, before the
  // embed base URL can turn them into /reader/… paths: ~, drive letters and
  // raw or percent-encoded filesystem roots are confirmed file references and
  // keep that actual (decoded) reference.
  const decodedHref=decodePathname(href)
  if(isFilesystemPath(decodedHref))return{blocked:true,kind:'file',reference:decodedHref}
  let url:URL
  try{url=new URL(href,location.href)}catch{return{blocked:true,kind:'unknown',reference:null}}
  if(url.protocol==='file:')return{blocked:true,kind:'file',reference:decodePathname(url.pathname)}
  // Route first, but only for explicitly written routes: root-relative (/…)
  // or absolute same-origin http(s). A plain relative path must never become
  // an app route just because the embed page is mounted under /reader/.
  const explicitlyWritten=href.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(href)
  if(url.origin===location.origin&&explicitlyWritten&&isAppRoute(decodePathname(url.pathname)))return{blocked:false}
  if((url.protocol==='http:'||url.protocol==='https:')&&(/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('//')))return{blocked:false,newTab:true}
  if(url.origin!==location.origin)return{blocked:false}
  // Every other same-origin reference is blocked as unbound, and the
  // provenance keeps the author's original href verbatim instead of
  // pretending the resolved pathname is a confirmed local file path.
  return{blocked:true,kind:'unknown',reference:href}
}
export function ReaderEmbed() {
  const raw=new URLSearchParams(location.search).get('endpoint') ?? ''
  const expectedSession=new URLSearchParams(location.search).get('session')
  // Optional opaque binding token supplied by the host: echoed in cfv:ready so a
  // delayed ready from an old navigation cannot bless a new load of the same
  // WindowProxy/endpoint, and checked on incoming cfv:focus when present.
  const channel=new URLSearchParams(location.search).get('channel')
  const hostFiles=new URLSearchParams(location.search).get('file_links')==='host'
  const conversationView=new URLSearchParams(location.search).get('view')==='conversation'
  const endpoint=bindEmbedEndpoint(raw,location.pathname,location.origin)
  const [page,setPage]=useState<Page|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const [target,setTarget]=useState<ReaderJumpTarget|null>(null)
  const [blockedLink,setBlockedLink]=useState<BlockedLink|null>(null)
  const historyRef=useRef<HTMLDetailsElement>(null)
  const sourceRef=useRef<HTMLDetailsElement>(null)
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{
      if(!(event.target instanceof Node))return
      for(const ref of [historyRef,sourceRef])if(!ref.current?.contains(event.target))ref.current?.removeAttribute('open')
    }
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape')return
      const open=[historyRef,sourceRef].find(ref=>ref.current?.open)?.current
      if(open){event.preventDefault();event.stopPropagation();open.open=false;open.querySelector('summary')?.focus()}
    }
    document.addEventListener('pointerdown',dismiss)
    document.addEventListener('keydown',escape)
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape)}
  },[])
  // Session data is bound to the page's identity: pure UI state (the
  // blocked-link notice opening/closing, folded sources, busy/error) must not
  // rebuild it. A fresh SessionData/messages reference would invalidate
  // SessionReader's Find matches and SessionView's rendered memo, re-firing
  // the [activeSearchTarget, rendered] effect and re-centering the real
  // content scroller ([data-export-primary]) on every notice toggle. Refresh
  // and paging publish a new page object, so they still rebuild the data.
  const data=useMemo(()=>page ? adapt(page) : null,[page])
  const webLinkAttributes=useRef(new WeakMap<HTMLAnchorElement,{original:{target:string|null;rel:string|null};applied:{target:string;rel:string}}>())
  const captureLinkClick=useCallback((event:ReactMouseEvent)=>{
    const anchor=event.target instanceof Element ? event.target.closest('a') : null
    if(!anchor)return
    // ReactMarkdown can reuse an anchor when refreshed text changes its href.
    // Undo only the attributes still owned by this shell before classifying
    // the new destination; preserve any later downstream attribute changes.
    const previous=webLinkAttributes.current.get(anchor)
    if(previous){
      for(const name of ['target','rel'] as const){
        if(anchor.getAttribute(name)!==previous.applied[name])continue
        const original=previous.original[name]
        if(original==null)anchor.removeAttribute(name)
        else anchor.setAttribute(name,original)
      }
      webLinkAttributes.current.delete(anchor)
    }
    const verdict=classifyAnchor(anchor as HTMLAnchorElement)
    if(!verdict.blocked){
      if(verdict.newTab){
        const original={target:anchor.getAttribute('target'),rel:anchor.getAttribute('rel')}
        const applied={target:'_blank',rel:[...new Set([...(original.rel??'').split(/\s+/).filter(Boolean),'noopener','noreferrer'])].join(' ')}
        webLinkAttributes.current.set(anchor,{original,applied})
        anchor.setAttribute('target',applied.target)
        anchor.setAttribute('rel',applied.rel)
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const sourceRecordId=anchor.closest('[data-source-record-id]')?.getAttribute('data-source-record-id')??null
    const owners=page?.records.filter(record=>record.id===sourceRecordId
      ||'message' in record&&record.kind==='flow-message'&&record.message.sourceRecordId===sourceRecordId)??[]
    const recordId=owners.length===1?owners[0].id:null
    const reference=anchor.getAttribute('href')
    if(hostFiles&&endpoint&&channel&&expectedSession&&page?.session_id===expectedSession
      &&recordId&&reference?.trim()){
      // The host must re-read this exact source record before granting a file
      // preview. Preserve the rendered author's href, never the resolved URL.
      parent.postMessage({type:'cfv:open-file',version:1,endpoint,channel,session:expectedSession,recordId,revision:page.revision??null,reference},location.origin)
      setBlockedLink(null)
      return
    }
    setBlockedLink({
      label:anchor.textContent?.trim()||'（无标签链接）',
      kind:verdict.kind,
      reference:verdict.reference,
      recordId:sourceRecordId,
    })
  },[hostFiles,endpoint,channel,expectedSession,page])
  const generation=useRef(0), current=useRef<Page|null>(null), navigationSequence=useRef(0)
  const findIntent=useRef({version:0,query:''})
  const recordFindEdit=useCallback((query:string)=>{findIntent.current={version:findIntent.current.version+1,query}},[])
  const read=useCallback(async (mode:string,anchor?:string)=>{
    if (!endpoint) {setError('No bound session endpoint');return}
    const version=++generation.current, previous=current.current,findVersion=findIntent.current.version
    setBusy(true);setError('')
    const query=new URLSearchParams({limit:'80',offset:mode==='earlier' ? String(Math.max(0,(previous?.offset ?? 0)-80)) : mode==='later' ? String(previous?.next_offset ?? 0) : mode==='first' ? '0' : '-1'})
    if (anchor) query.set('anchor',anchor)
    if (['earlier','later'].includes(mode) && previous) {
      if(previous.revision)query.set('revision',previous.revision)
      if(previous.until!=null)query.set('until',String(previous.until))
    }
    try {
      const response=await fetch(embedRequestUrl(endpoint,query),{credentials:'same-origin'})
      if(!response.ok)throw new Error((await response.text()).slice(0,1000))
      const next:Page=await response.json()
      if(expectedSession && next.session_id!==expectedSession)throw new Error('Selected session identity changed')
      if(version!==generation.current)return
      if(previous && ['earlier','later'].includes(mode) && next.session_id!==previous.session_id)throw new Error('Selected session identity changed')
      const merged=mode==='earlier' && previous ? {...next,records:[...next.records,...previous.records],next_offset:previous.next_offset,has_later:previous.has_later} : mode==='later' && previous ? {...next,offset:previous.offset,has_earlier:previous.has_earlier,records:[...previous.records,...next.records]} : next
      current.current=merged;setPage(merged)
      if(['earlier','later'].includes(mode) && findIntent.current.version!==findVersion && findIntent.current.query){
        // Prepending changes message indexes; a retired navigation must not revive when Find is cleared.
        setTarget(null)
        return
      }
      const data=adapt(merged)
      let index=anchor ? resolveConversationAnchor(merged,anchor) : mode==='latest' ? data.messages.length-1 : 0
      if(anchor && index<0)throw new Error('Requested source record is not uniquely available in this reading window')
      if(conversationView && !anchor){
        const conversationIndices=data.messages.flatMap((message,index)=>message.kind==='ai-text' || message.kind==='user-prompt' ? [index] : [])
        index=(mode==='latest' ? conversationIndices[conversationIndices.length-1] : conversationIndices[0]) ?? -1
      }
      // Explicit host navigation (cfv:focus → 'question') gets a fresh stable
      // token per request so repeated jumps to the same position still count.
      setTarget(index>=0 ? {messageIndex:index, ...(mode==='question' ? {requestId:`nav-${++navigationSequence.current}`} : {})} : null)
    } catch(e) {if(version===generation.current)setError(e instanceof Error ? e.message : String(e))}
    finally {if(version===generation.current)setBusy(false)}
  },[endpoint,expectedSession,conversationView])
  useEffect(()=>{void read('latest');const counter=generation;return()=>{counter.current++}},[read])
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!==location.origin || event.source!==parent || event.data?.type!=='cfv:focus' || event.data.endpoint!==endpoint)return
      if(event.data.channel!=null && event.data.channel!==channel)return
      if(typeof event.data.recordId==='string')void read('question',event.data.recordId)
    }
    addEventListener('message',receive)
    parent.postMessage({type:'cfv:ready',endpoint,session:expectedSession,channel},location.origin)
    return()=>removeEventListener('message',receive)
  },[endpoint,expectedSession,channel,read])
  const readToolResult=useCallback(async (relativePath:string)=>{
    if(!endpoint)throw new Error('No bound session endpoint')
    const response=await fetch(embedRequestUrl(endpoint,new URLSearchParams({path:relativePath}),'/tool-output'),{credentials:'same-origin'})
    if(!response.ok)throw new Error(await response.text())
    const output=await response.json();return String(output.content)
  },[endpoint])
  const closeOtherDisclosure=(open:HTMLDetailsElement)=>{
    if(!open.open)return
    for(const ref of [historyRef,sourceRef])if(ref.current!==open)ref.current?.removeAttribute('open')
  }
  const historyControls=<details className="embed-history embed-disclosure" ref={historyRef} onToggle={event=>closeOtherDisclosure(event.currentTarget)}><summary>历史</summary><div className="embed-history-actions" onClick={event=>{if(event.target instanceof HTMLButtonElement)historyRef.current?.removeAttribute('open')}}>
      <button disabled={busy} onClick={()=>void read('first')}>从头查看</button>
      <button disabled={busy || !page?.has_earlier} onClick={()=>void read('earlier')}>加载更早的对话</button>
      <button disabled={busy || !page?.has_later} onClick={()=>void read('later')}>继续查看</button>
      <button disabled={busy} onClick={()=>void read('latest')}>刷新到最新</button>
      </div></details>
  const sourceControls=page && <details className="embed-source embed-disclosure" ref={sourceRef} onToggle={event=>closeOtherDisclosure(event.currentTarget)}><summary aria-label="来源与读取边界">来源</summary><div className="embed-source-content">
    <div className="embed-status" role="status">{busy?'读取中 · ':''}{`第 ${page.total ? page.offset+1 : 0}–${page.next_offset} 条 / 共 ${page.total} 条 · 搜索已加载范围`}</div>
    <p>{page.boundary}</p><p>{page.provider} · {page.session_id} · {new Date(page.read_at).toLocaleString(undefined,{hour12:false})}</p>
  </div></details>
  return <div className="reader-embed" onClickCapture={captureLinkClick} aria-busy={busy}>
    {error && <p role="alert" className="embed-error">{error}</p>}
    {blockedLink && <div className="embed-link-notice" role="status">
      <span>{blockedLink.label}：{blockedLink.kind==='file' ? '本地文件引用未绑定预览。' : '该引用未绑定预览。'}</span>
      <details className="embed-link-source"><summary>引用来源</summary>
        <p>路径：{blockedLink.reference ?? 'unknown'}</p>
        <p>来源记录：{blockedLink.recordId ?? 'unknown'}</p>
        <p>会话：{page?.session_id ?? expectedSession ?? 'unknown'}</p>
      </details>
      <button type="button" onClick={()=>setBlockedLink(null)}>关闭</button>
    </div>}
    {page && data ? <SessionReader data={data} initialFilter={conversationView ? CONVERSATION_FILTER : undefined} activeSearchTarget={target} onFindQueryChange={recordFindEdit} findScopeLabel="仅搜索已加载范围" readToolResult={readToolResult} resourceScope={endpoint ? `${endpoint}|${page.provider}|${page.session_id}` : null} toolbarLeading={historyControls} toolbarTrailing={sourceControls} pending={busy} emptyStateAction={page.has_earlier ? <button type="button" className="reader-empty-action" disabled={busy} onClick={()=>void read('earlier')}>加载更早的对话</button> : null} /> : <div className="session-reader-toolbar">{historyControls}{busy && <span className="embed-status" role="status">正在读取绑定会话…</span>}</div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<ReaderEmbed />)
