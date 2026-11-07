import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { SessionReader } from './components/session/SessionReader'
import {normalizeConversationPage as adapt,resolveConversationAnchor,type ConversationPage as Page} from './lib/reader-page'
import type { ReaderJumpTarget } from './components/session/SessionView'
import { bindEmbedEndpoint, embedRequestUrl } from './lib/embed-endpoint'
import {isConversationMessage,LATEST_CONVERSATION,validateConversationWindowFocus,earlierConversationWindow} from './lib/conversation-focus'
import {resolveConversationImage,mergeConversationImageResources} from './lib/image-references'
import './index.css'
import './embed.css'
const CONVERSATION_FILTER = {thinking:false,toolCalls:false,toolResults:false}
const INVALID_INITIAL_BINDING='Invalid initial record binding'
const INVALID_WINDOW_FOCUS_BINDING='Invalid conversation window focus binding'
type SourceBinding={endpoint:string;session:string;recordId:string|null;windowFocus:typeof LATEST_CONVERSATION|null}
function isValidRecordId(value:unknown):value is string{
  if(typeof value!=='string'||value.length===0||value.length>1024||value.trim()!==value)return false
  return ![...value].some(character=>{const code=character.charCodeAt(0);return code<=31||code===127})
}
function initialSourcePage(value:unknown,binding:SourceBinding,conversationView:boolean):Page{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid initial source page')
  const next=value as Page
  if(!['claude','codex'].includes(next.provider)||next.session_id!==binding.session
    ||!Array.isArray(next.records)||!Number.isSafeInteger(next.total)||next.total<0
    ||!Number.isSafeInteger(next.offset)||next.offset<0||next.offset>next.total
    ||next.records.length!==Math.min(80,next.total-next.offset)
    ||next.next_offset!==next.offset+next.records.length
    ||next.has_earlier!==(next.offset>0)||next.has_later!==(next.next_offset<next.total)
    ||typeof next.read_at!=='string'||typeof next.boundary!=='string'
    ||next.records.some(record=>!record||typeof record!=='object'||!isValidRecordId(record.id))
    ||new Set(next.records.map(record=>record.id)).size!==next.records.length)
    throw new Error('Invalid initial source page')
  if(binding.windowFocus){
    if(!conversationView||binding.recordId||!new URL(binding.endpoint,location.origin).pathname.endsWith('/original-context'))
      throw new Error(INVALID_WINDOW_FOCUS_BINDING)
    validateConversationWindowFocus(next,80)
  }else if(next.window_focus!=null)throw new Error('Unexpected initial conversation window focus')
  adapt(next)
  if(binding.recordId&&resolveConversationAnchor(next,binding.recordId)<0)
    throw new Error('Requested source record is not uniquely available in this reading window')
  return next
}
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
  const parameters=useMemo(()=>new URLSearchParams(location.search),[])
  const mountPath=useMemo(()=>location.pathname,[])
  const raw=parameters.get('endpoint') ?? ''
  const urlSession=parameters.get('session')
  // Optional opaque binding token supplied by the host: echoed in cfv:ready so a
  // delayed ready from an old navigation cannot bless a new load of the same
  // WindowProxy/endpoint, and checked on incoming cfv:focus when present.
  const channel=parameters.get('channel')
  const hostFiles=parameters.get('file_links')==='host'
  const conversationView=parameters.get('view')==='conversation'
  const urlEndpoint=bindEmbedEndpoint(raw,mountPath,location.origin)
  const [sourceBinding,setSourceBinding]=useState<SourceBinding|null>(null)
  const sourceBindingRef=useRef<SourceBinding|null>(null)
  const endpoint=sourceBinding?sourceBinding.endpoint:urlEndpoint
  const expectedSession=sourceBinding?sourceBinding.session:urlSession
  // Birth positioning is opt-in and lives only in the embed URL, never in the
  // bound endpoint query. URLSearchParams.get() would hide duplicates, so keep
  // the complete value list and reject every incomplete or malformed binding.
  const initialValues=parameters.getAll('initial_record_id')
  const hasInitial=initialValues.length>0
  const urlRecordId=initialValues.length===1&&isValidRecordId(initialValues[0])?initialValues[0]:null
  const initialRecordId=sourceBinding?sourceBinding.recordId:urlRecordId
  const initialBindingValid=!hasInitial||Boolean(urlEndpoint&&urlRecordId&&urlSession?.trim()&&channel?.trim())
  const windowFocusValues=parameters.getAll('window_focus')
  const urlWindowFocus=windowFocusValues.length===1&&windowFocusValues[0]===LATEST_CONVERSATION?LATEST_CONVERSATION:null
  const windowFocusMode=sourceBinding?sourceBinding.windowFocus:urlWindowFocus
  const windowFocusBindingError=windowFocusValues.length>0&&(!urlWindowFocus||!conversationView||!urlEndpoint||!new URL(urlEndpoint,location.origin).pathname.endsWith('/original-context')||!urlSession?.trim()||!channel?.trim()||hasInitial)
  const handoffValues=parameters.getAll('initial_handoff'),handoffMode=handoffValues.length===1&&['1','source-page-v1'].includes(handoffValues[0])
  const deferredHandoff=handoffMode&&!parameters.has('endpoint')&&!parameters.has('session')
  const handoffBindingError=handoffValues.length>0&&(!handoffMode||!isValidRecordId(channel)||parameters.getAll('channel').length!==1
    ||(deferredHandoff?hasInitial||windowFocusValues.length>0:!urlEndpoint||!isValidRecordId(urlSession)||parameters.getAll('endpoint').length!==1||parameters.getAll('session').length!==1))
  const initialBindingError=hasInitial&&!initialBindingValid||windowFocusBindingError||handoffBindingError
  const bindingError=windowFocusBindingError?INVALID_WINDOW_FOCUS_BINDING:INVALID_INITIAL_BINDING
  const [page,setPage]=useState<Page|null>(null), [error,setError]=useState(initialBindingError?bindingError:''), [busy,setBusy]=useState(false)
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
  const handoffApplied=useRef(false)
  const handoffPacket=useRef<string|null>(null)
  const handoffClosed=useRef(false),readySent=useRef(false)
  const accept=useCallback((next:Page,mode:string,anchor:string|undefined,previous:Page|null,findVersion:number,binding?:SourceBinding)=>{
    const focused=(binding?binding.windowFocus:windowFocusMode)===LATEST_CONVERSATION&&conversationView&&mode==='latest'&&!anchor
    if(focused)validateConversationWindowFocus(next,80)
    else if(next.window_focus!=null)throw new Error('Unexpected initial conversation window focus')
    const selectedSession=binding?binding.session:expectedSession
    if(selectedSession && next.session_id!==selectedSession)throw new Error('Selected session identity changed')
    if(previous && ['earlier','later'].includes(mode) && next.session_id!==previous.session_id)throw new Error('Selected session identity changed')
    const merged=mode==='earlier' && previous ? {...next,records:[...next.records,...previous.records],next_offset:previous.next_offset,has_later:previous.has_later} : mode==='later' && previous ? {...next,offset:previous.offset,has_earlier:previous.has_earlier,records:[...previous.records,...next.records]} : next
    if(previous&&['earlier','later'].includes(mode))merged.imageResources=mergeConversationImageResources(previous,next)
    current.current=merged;setPage(merged)
    if(['earlier','later'].includes(mode) && findIntent.current.version!==findVersion && findIntent.current.query){setTarget(null);return}
    const data=adapt(merged)
    let index=anchor ? resolveConversationAnchor(merged,anchor) : mode==='latest' ? data.messages.length-1 : 0
    if(anchor && index<0){setTarget(null);throw new Error('Requested source record is not uniquely available in this reading window')}
    if(conversationView && !anchor){
      const conversationIndices=data.messages.flatMap((message,index)=>isConversationMessage(message) ? [index] : [])
      index=(mode==='latest' ? conversationIndices[conversationIndices.length-1] : conversationIndices[0]) ?? -1
    }
    setTarget(index>=0 ? {messageIndex:index, ...(mode==='question' ? {requestId:`nav-${++navigationSequence.current}`} : {})} : null)
  },[expectedSession,conversationView,windowFocusMode])
  const read=useCallback(async (mode:string,anchor?:string)=>{
    if(initialBindingError){setError(bindingError);return}
    if(handoffMode&&!handoffApplied.current)return
    const binding=sourceBindingRef.current,readEndpoint=binding?binding.endpoint:endpoint
    if (!readEndpoint) {setError('No bound session endpoint');return}
    if(mode==='earlier'&&(!current.current||current.current.offset<=0))return
    if(handoffMode)handoffClosed.current=true
    const version=++generation.current, previous=current.current,findVersion=findIntent.current.version
    setBusy(true);setError('')
    const earlier=mode==='earlier'&&previous?earlierConversationWindow(previous.offset,80):null
    const query=new URLSearchParams({limit:String(earlier?.limit??80),offset:mode==='earlier' ? String(earlier?.offset??0) : mode==='later' ? String(previous?.next_offset ?? 0) : mode==='first' ? '0' : '-1'})
    const focused=(binding?binding.windowFocus:windowFocusMode)===LATEST_CONVERSATION&&conversationView&&mode==='latest'&&!anchor
    if(focused)query.set('window_focus',LATEST_CONVERSATION)
    if (anchor) query.set('anchor',anchor)
    if (['earlier','later'].includes(mode) && previous) {
      if(previous.revision)query.set('revision',previous.revision)
      if(previous.until!=null)query.set('until',String(previous.until))
    }
    try {
      const response=await fetch(embedRequestUrl(readEndpoint,query),{credentials:'same-origin'})
      if(!response.ok)throw new Error((await response.text()).slice(0,1000))
      const next:Page=await response.json()
      if(version!==generation.current)return
      accept(next,mode,anchor,previous,findVersion,binding??undefined)
    } catch(e) {if(version===generation.current)setError(e instanceof Error ? e.message : String(e))}
    finally {if(version===generation.current)setBusy(false)}
  },[endpoint,accept,initialBindingError,bindingError,handoffMode,windowFocusMode,conversationView])
  useEffect(()=>{
    if(!initialBindingError&&!handoffMode)void read(initialRecordId?'question':'latest',initialRecordId??undefined)
    if(!handoffMode){const counter=generation;return()=>{counter.current++}}
  },[read,initialBindingError,initialRecordId,handoffMode])
  useEffect(()=>()=>{generation.current++},[])
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(initialBindingError||event.origin!==location.origin||event.source!==parent)return
      const message=event.data
      if(message?.type==='cfv:initial-source'){
        if(!handoffMode||handoffClosed.current||message.version!==1||message.channel!==channel
          ||!isValidRecordId(message.session)||typeof message.endpoint!=='string'
          ||bindEmbedEndpoint(message.endpoint,mountPath,location.origin)!==message.endpoint
          ||!Object.hasOwn(message,'recordId')||message.recordId!==null&&!isValidRecordId(message.recordId)
          ||!Object.hasOwn(message,'windowFocus')||message.windowFocus!==null&&message.windowFocus!==LATEST_CONVERSATION)return
        const binding:SourceBinding={endpoint:message.endpoint,session:message.session,recordId:message.recordId,windowFocus:message.windowFocus}
        const prior=sourceBindingRef.current
        if(prior?(Object.keys(prior) as Array<keyof SourceBinding>).some(key=>prior[key]!==binding[key])
          :!deferredHandoff&&(binding.endpoint!==urlEndpoint||binding.session!==urlSession||binding.recordId!==urlRecordId||binding.windowFocus!==urlWindowFocus))return
        const ack={type:'cfv:initial-source-ack',version:1,endpoint:binding.endpoint,channel,session:binding.session}
        try{
          const packet=JSON.stringify(message.page)
          if(!packet)return
          // An acknowledgement certifies this exact first page, not a later
          // capture that happens to reuse the same endpoint and session.
          if(handoffApplied.current){if(packet===handoffPacket.current)parent.postMessage(ack,location.origin);return}
          const next=initialSourcePage(message.page,binding,conversationView)
          generation.current++
          accept(next,binding.recordId?'question':'latest',binding.recordId??undefined,null,findIntent.current.version,binding)
          sourceBindingRef.current=binding;handoffPacket.current=packet;handoffApplied.current=true;setSourceBinding(binding);setError('');setBusy(false)
          parent.postMessage(ack,location.origin)
        }catch(e){setError(e instanceof Error?e.message:String(e))}
        return
      }
      const binding=sourceBindingRef.current
      if(message?.type!=='cfv:focus'||message.endpoint!==(binding?binding.endpoint:endpoint)||handoffMode&&!handoffApplied.current)return
      if(handoffMode){
        if(message.channel!==channel||message.session!==binding?.session)return
      }else if(initialRecordId||windowFocusMode){
        // Opt-in birth binding upgrades later host navigation to the same strict
        // identity contract; missing fields are not equivalent to a match.
        if(event.data.channel!==channel||event.data.session!==expectedSession)return
      }else{
        // Legacy hosts may omit channel/session, but an explicitly supplied
        // wrong identity must still be rejected.
        if(Object.hasOwn(event.data,'channel') && event.data.channel!==channel)return
        if(Object.hasOwn(event.data,'session') && event.data.session!==expectedSession)return
      }
      if(isValidRecordId(event.data.recordId))void read('question',event.data.recordId)
    }
    addEventListener('message',receive)
    if(!handoffMode||!readySent.current){
      parent.postMessage({type:'cfv:ready',endpoint,session:expectedSession,channel,...(!initialBindingError&&initialRecordId?{initialRecordId}:{}),...(!initialBindingError&&windowFocusMode?{windowFocusMode}:{}),...(!initialBindingError&&handoffMode?{initialHandoff:1}:{})},location.origin)
      readySent.current=true
    }
    return()=>removeEventListener('message',receive)
  },[endpoint,expectedSession,channel,read,accept,initialBindingError,initialRecordId,windowFocusMode,handoffMode,deferredHandoff,urlEndpoint,urlSession,urlRecordId,urlWindowFocus,conversationView,mountPath])
  const readToolResult=useCallback(async (relativePath:string)=>{
    if(!endpoint)throw new Error('No bound session endpoint')
    const response=await fetch(embedRequestUrl(endpoint,new URLSearchParams({path:relativePath}),'/tool-output'),{credentials:'same-origin'})
    if(!response.ok)throw new Error(await response.text())
    const output=await response.json();return String(output.content)
  },[endpoint])
  const resolveImage=useCallback((reference:string,recordId:string)=>{
    if(!endpoint||!page||expectedSession!==page.session_id)return null
    const apiPrefix=endpoint.slice(0,endpoint.indexOf('/api/')+5)
    return resolveConversationImage(page,reference,recordId,apiPrefix)
  },[endpoint,page,expectedSession])
  const closeOtherDisclosure=(open:HTMLDetailsElement)=>{
    if(!open.open)return
    for(const ref of [historyRef,sourceRef])if(ref.current!==open)ref.current?.removeAttribute('open')
  }
  const historyControls=<details className="embed-history embed-disclosure" ref={historyRef} onToggle={event=>closeOtherDisclosure(event.currentTarget)}><summary>历史</summary><div className="embed-history-actions" onClick={event=>{if(event.target instanceof HTMLButtonElement)historyRef.current?.removeAttribute('open')}}>
      <button disabled={busy||handoffMode&&!page} onClick={()=>void read('first')}>从头查看</button>
      <button disabled={busy || !page?.has_earlier} onClick={()=>void read('earlier')}>加载更早的对话</button>
      <button disabled={busy || !page?.has_later} onClick={()=>void read('later')}>继续查看</button>
      <button disabled={busy||handoffMode&&!page} onClick={()=>void read('latest')}>刷新到最新</button>
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
    {page && data ? <SessionReader data={data} initialFilter={conversationView ? CONVERSATION_FILTER : undefined} activeSearchTarget={target} onFindQueryChange={recordFindEdit} findScopeLabel="仅搜索已加载范围" readToolResult={readToolResult} resolveImage={resolveImage} resourceScope={endpoint ? `${endpoint}|${page.provider}|${page.session_id}` : null} toolbarLeading={historyControls} toolbarTrailing={sourceControls} pending={busy} emptyStateAction={page.has_earlier ? <button type="button" className="reader-empty-action" disabled={busy} onClick={()=>void read('earlier')}>加载更早的对话</button> : null} /> : <div className="session-reader-toolbar">{historyControls}{busy && <span className="embed-status" role="status">正在读取绑定会话…</span>}</div>}
  </div>
}
createRoot(document.getElementById('root')!).render(<ReaderEmbed />)
