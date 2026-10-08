import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { SessionReader } from './components/session/SessionReader'
import {normalizeConversationPage as adapt,type ConversationPage as Page} from './lib/reader-page'
import type { ReaderJumpTarget } from './components/session/SessionView'
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
// promoted into an app route by the base URL. External origins and pure
// #fragments are untouched. Everything else same-origin is blocked: confirmed
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
function classifyAnchor(anchor:HTMLAnchorElement):{blocked:false}|{blocked:true;kind:'file'|'unknown';reference:string|null}{
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
  if(url.origin!==location.origin)return{blocked:false}
  // Route first, but only for explicitly written routes: root-relative (/…)
  // or absolute same-origin http(s). A plain relative path must never become
  // an app route just because the embed page is mounted under /reader/.
  const explicitlyWritten=href.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(href)
  if(explicitlyWritten&&isAppRoute(decodePathname(url.pathname)))return{blocked:false}
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
  const conversationView=new URLSearchParams(location.search).get('view')==='conversation'
  const endpoint=raw.startsWith('/api/') && !raw.includes('\\') && !raw.includes('#') ? raw : null
  const [page,setPage]=useState<Page|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const [target,setTarget]=useState<ReaderJumpTarget|null>(null)
  const [blockedLink,setBlockedLink]=useState<BlockedLink|null>(null)
  const captureLinkClick=useCallback((event:ReactMouseEvent)=>{
    const anchor=event.target instanceof Element ? event.target.closest('a') : null
    if(!anchor)return
    const verdict=classifyAnchor(anchor as HTMLAnchorElement)
    if(!verdict.blocked)return
    event.preventDefault()
    event.stopPropagation()
    setBlockedLink({
      label:anchor.textContent?.trim()||'（无标签链接）',
      kind:verdict.kind,
      reference:verdict.reference,
      recordId:anchor.closest('[data-source-record-id]')?.getAttribute('data-source-record-id')??null,
    })
  },[])
  const generation=useRef(0), current=useRef<Page|null>(null), navigationSequence=useRef(0)
  const read=useCallback(async (mode:string,anchor?:string)=>{
    if (!endpoint) {setError('No bound session endpoint');return}
    const version=++generation.current, previous=current.current
    setBusy(true);setError('')
    const query=new URLSearchParams({limit:'80',offset:mode==='earlier' ? String(Math.max(0,(previous?.offset ?? 0)-80)) : mode==='later' ? String(previous?.next_offset ?? 0) : mode==='first' ? '0' : '-1'})
    if (anchor) query.set('anchor',anchor)
    if (['earlier','later'].includes(mode) && previous) {
      if(previous.revision)query.set('revision',previous.revision)
      if(previous.until!=null)query.set('until',String(previous.until))
    }
    try {
      const response=await fetch(endpoint+'?'+query,{credentials:'same-origin'})
      if(!response.ok)throw new Error((await response.text()).slice(0,1000))
      const next:Page=await response.json()
      if(expectedSession && next.session_id!==expectedSession)throw new Error('Selected session identity changed')
      if(version!==generation.current)return
      if(previous && ['earlier','later'].includes(mode) && next.session_id!==previous.session_id)throw new Error('Selected session identity changed')
      const merged=mode==='earlier' && previous ? {...next,records:[...next.records,...previous.records],next_offset:previous.next_offset,has_later:previous.has_later} : mode==='later' && previous ? {...next,offset:previous.offset,has_earlier:previous.has_earlier,records:[...previous.records,...next.records]} : next
      current.current=merged;setPage(merged)
      const data=adapt(merged)
      let index=anchor ? data.messages.findIndex(message=>message.sourceRecordId===anchor) : mode==='latest' ? data.messages.length-1 : 0
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
    const response=await fetch(endpoint+'/tool-output?path='+encodeURIComponent(relativePath),{credentials:'same-origin'})
    if(!response.ok)throw new Error(await response.text())
    const output=await response.json();return String(output.content)
  },[endpoint])
  return <div className="reader-embed" onClickCapture={captureLinkClick}>
    <header className="embed-navigation"><strong>Claude Flow Viewer</strong>
      <button disabled={busy} onClick={()=>void read('first')}>从头查看</button>
      <button disabled={busy || !page?.has_earlier} onClick={()=>void read('earlier')}>加载更早的对话</button>
      <button disabled={busy || !page?.has_later} onClick={()=>void read('later')}>继续查看</button>
      <button disabled={busy} onClick={()=>void read('latest')}>刷新到最新</button>
    </header>
    <div className="embed-status" role="status">{busy?'读取中 · ':''}{page ? `第 ${page.total ? page.offset+1 : 0}–${page.next_offset} 条 / 共 ${page.total} 条 · 搜索已加载范围` : '正在读取绑定会话…'}</div>
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
    {page && <SessionReader data={adapt(page)} initialFilter={conversationView ? CONVERSATION_FILTER : undefined} activeSearchTarget={target} readToolResult={readToolResult} resourceScope={endpoint ? `${endpoint}|${page.provider}|${page.session_id}` : null} />}
    {page && <details className="embed-source"><summary>来源与读取边界</summary><p>{page.boundary}</p><p>{page.provider} · {page.session_id} · {new Date(page.read_at).toLocaleString(undefined,{hour12:false})}</p></details>}
  </div>
}
createRoot(document.getElementById('root')!).render(<ReaderEmbed />)
