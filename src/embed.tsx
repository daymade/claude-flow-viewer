import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SessionReader } from './components/session/SessionReader'
import {normalizeConversationPage as adapt,type ConversationPage as Page} from './lib/reader-page'
import type { ReaderJumpTarget } from './components/session/SessionView'
import './index.css'
import './embed.css'
export function ReaderEmbed() {
  const raw=new URLSearchParams(location.search).get('endpoint') ?? ''
  const expectedSession=new URLSearchParams(location.search).get('session')
  // Optional opaque binding token supplied by the host: echoed in cfv:ready so a
  // delayed ready from an old navigation cannot bless a new load of the same
  // WindowProxy/endpoint, and checked on incoming cfv:focus when present.
  const channel=new URLSearchParams(location.search).get('channel')
  const endpoint=raw.startsWith('/api/') && !raw.includes('\\') && !raw.includes('#') ? raw : null
  const [page,setPage]=useState<Page|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const [target,setTarget]=useState<ReaderJumpTarget|null>(null)
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
      const data=adapt(merged), index=anchor ? data.messages.findIndex(message=>message.sourceRecordId===anchor) : mode==='latest' ? data.messages.length-1 : 0
      // Explicit host navigation (cfv:focus → 'question') gets a fresh stable
      // token per request so repeated jumps to the same position still count.
      setTarget(index>=0 ? {messageIndex:index, ...(mode==='question' ? {requestId:`nav-${++navigationSequence.current}`} : {})} : null)
    } catch(e) {if(version===generation.current)setError(e instanceof Error ? e.message : String(e))}
    finally {if(version===generation.current)setBusy(false)}
  },[endpoint,expectedSession])
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
  return <div className="reader-embed">
    <header className="embed-navigation"><strong>Claude Flow Viewer</strong>
      <button disabled={busy} onClick={()=>void read('first')}>从头查看</button>
      <button disabled={busy || !page?.has_earlier} onClick={()=>void read('earlier')}>加载更早的对话</button>
      <button disabled={busy || !page?.has_later} onClick={()=>void read('later')}>继续查看</button>
      <button disabled={busy} onClick={()=>void read('latest')}>刷新到最新</button>
    </header>
    <div className="embed-status" role="status">{busy?'读取中 · ':''}{page ? `第 ${page.total ? page.offset+1 : 0}–${page.next_offset} 条 / 共 ${page.total} 条 · 搜索已加载范围` : '正在读取绑定会话…'}</div>
    {error && <p role="alert" className="embed-error">{error}</p>}
    {page && <SessionReader data={adapt(page)} activeSearchTarget={target} readToolResult={readToolResult} resourceScope={endpoint ? `${endpoint}|${page.provider}|${page.session_id}` : null} />}
    {page && <details className="embed-source"><summary>来源与读取边界</summary><p>{page.boundary}</p><p>{page.provider} · {page.session_id} · {new Date(page.read_at).toLocaleString(undefined,{hour12:false})}</p></details>}
  </div>
}
createRoot(document.getElementById('root')!).render(<ReaderEmbed />)
