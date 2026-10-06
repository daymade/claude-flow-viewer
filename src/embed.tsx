import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SessionReader } from './components/session/SessionReader'
import { parseCodexNativeRecords, type NativeConversationRecord } from './lib/providers/codex-native'
import type { SessionData, SessionMessage } from './types/session'
import type { SearchJumpTarget } from './hooks/useSearchController'
import {computeHeatmap} from './lib/heatmap'
import './index.css'
import './embed.css'
interface Page {
  provider: 'claude' | 'codex'; session_id: string; records: Array<NativeConversationRecord & {message?:SessionMessage}>
  total:number; offset:number; next_offset:number; has_earlier:boolean; has_later:boolean
  revision?:string; until?:number; read_at:string; boundary:string
}
function adapt(page:Page):SessionData {
  if (page.provider==='codex') return parseCodexNativeRecords(page.records)
  const messages=page.records.map(record=>({...record.message!,sourceRecordId:record.id}))
  const prompts=messages.flatMap(message=>message.kind==='user-prompt' ? [{num:message.promptNum,preview:message.text.slice(0,100),fullText:message.text,time:message.time,timestamp:message.timestamp,decision:message.decision}] : [])
  return {source:page.provider,messages,prompts,heatmap:computeHeatmap(messages),markers:{compacts:0,plans:0,clears:0,forks:0}}
}
export function ReaderEmbed() {
  const raw=new URLSearchParams(location.search).get('endpoint') ?? ''
  const endpoint=raw.startsWith('/api/') && !raw.includes('\\') && !raw.includes('#') ? raw : null
  const [page,setPage]=useState<Page|null>(null), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const [target,setTarget]=useState<SearchJumpTarget|null>(null)
  const generation=useRef(0), current=useRef<Page|null>(null)
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
      if(version!==generation.current)return
      if(previous && ['earlier','later'].includes(mode) && next.session_id!==previous.session_id)throw new Error('Selected session identity changed')
      const merged=mode==='earlier' && previous ? {...next,records:[...next.records,...previous.records],next_offset:previous.next_offset,has_later:previous.has_later} : mode==='later' && previous ? {...next,offset:previous.offset,has_earlier:previous.has_earlier,records:[...previous.records,...next.records]} : next
      current.current=merged;setPage(merged)
      const data=adapt(merged), index=anchor ? data.messages.findIndex(message=>message.sourceRecordId===anchor) : mode==='latest' ? data.messages.length-1 : 0
      setTarget(index>=0 ? {chunkId:anchor ?? mode+'-'+version,sessionId:next.session_id,projectEncoded:'',messageIndex:index} : null)
    } catch(e) {if(version===generation.current)setError(e instanceof Error ? e.message : String(e))}
    finally {if(version===generation.current)setBusy(false)}
  },[endpoint])
  useEffect(()=>{void read('latest');const counter=generation;return()=>{counter.current++}},[read])
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!==location.origin || event.source!==parent || event.data?.type!=='cfv:focus' || event.data.endpoint!==endpoint)return
      if(typeof event.data.recordId==='string')void read('question',event.data.recordId)
    }
    addEventListener('message',receive)
    parent.postMessage({type:'cfv:ready',endpoint},location.origin)
    return()=>removeEventListener('message',receive)
  },[endpoint,read])
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
    {page && <SessionReader data={adapt(page)} activeSearchTarget={target} readToolResult={readToolResult} />}
    {page && <details className="embed-source"><summary>来源与读取边界</summary><p>{page.boundary}</p><p>{page.provider} · {page.session_id} · {new Date(page.read_at).toLocaleString(undefined,{hour12:false})}</p></details>}
  </div>
}
createRoot(document.getElementById('root')!).render(<ReaderEmbed />)
