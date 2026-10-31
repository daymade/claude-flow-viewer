// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {act} from 'react'
import {cleanup,fireEvent,screen,waitFor,within} from '@testing-library/react'

// Records every adapt(page) call the embed makes, so tests can prove a pure
// UI re-render never rebuilds the SessionData/messages behind the real reader.
const adaptSpy=vi.hoisted(()=>({calls:[] as Array<{page:unknown;data:{messages:ReadonlyArray<unknown>}}>}))
vi.mock('./lib/reader-page',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('./lib/reader-page')>()
  return {
    ...actual,
    normalizeConversationPage:(pageArg:Parameters<typeof actual.normalizeConversationPage>[0])=>{
      const data=actual.normalizeConversationPage(pageArg)
      adaptSpy.calls.push({page:pageArg,data})
      return data
    },
  }
})

Object.assign(globalThis,{
  IS_REACT_ACT_ENVIRONMENT:true,
  ResizeObserver:class{observe(){} disconnect(){}},
  IntersectionObserver:class{observe(){} disconnect(){}},
})
HTMLElement.prototype.scrollIntoView=vi.fn()

afterEach(()=>{
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
  window.history.replaceState(null,'','/')
  document.body.innerHTML=''
})

// Fully synthetic page; no real transcript content, paths or identifiers.
// Each test binds a distinct endpoint so listeners of embed roots mounted by
// earlier tests never match (the module-level root is intentionally left
// mounted, and the endpoint check must keep it out of later tests).
const page={
  provider:'claude',
  session_id:'sess-1',
  records:[
    {kind:'flow-message',id:'rec-1',message:{kind:'ai-text',text:'first message'}},
    {kind:'flow-message',id:'rec-2',message:{kind:'ai-text',text:'the selected question'}},
    {kind:'flow-message',id:'rec-3',message:{kind:'ai-text',text:'last message'}},
  ],
  total:3,offset:0,next_offset:3,has_earlier:false,has_later:false,
  read_at:'2026-10-05T00:00:00Z',boundary:'synthetic test boundary',
}

function filterCheckbox(name:string) {
 const trigger=screen.getByRole('button',{name:'Filters'})
 if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger)
 return screen.getByRole('checkbox',{name}) as HTMLInputElement
}

function stubFetch() {
  const fetchMock=vi.fn(async (input:RequestInfo|URL)=>{
    const url=String(input)
    if(url.includes('/tool-output'))return {ok:true,json:async()=>({content:'FULL'})} as Response
    return {ok:true,json:async()=>page} as Response
  })
  vi.stubGlobal('fetch',fetchMock)
  return fetchMock
}

async function mountEmbed(search:string) {
  window.history.replaceState(null,'',search)
  document.body.innerHTML='<div id="root"></div>'
  await act(async()=>{await import('./embed')})
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))})
}

const flush = () => act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))})
// Deliver a host message exactly the way a real parent frame would: same
// origin, parent window as source. jsdom's window.postMessage leaves
// event.source null, which the preserved parent check rightfully rejects.
const sendHostMessage = (data:Record<string,unknown>) =>
  window.dispatchEvent(new MessageEvent('message',{data,origin:location.origin,source:window}))
const anchorCalls = (fetchMock:ReturnType<typeof vi.fn>,endpoint:string) =>
  fetchMock.mock.calls.filter(([input])=>String(input).startsWith(endpoint) && String(input).includes('anchor='))
const ringAt = (index:number) => document.querySelector(`[data-message-index="${index}"]`)?.className ?? ''

const nativeRuntimeId='22222222-2222-4222-8222-222222222222'
const nativeRuntimeWitness='a'.repeat(64)
const nativeBinding=`native_runtime_id=${nativeRuntimeId}&native_runtime_witness=${nativeRuntimeWitness}`
const readyMessages=(received:unknown[])=>received.filter(data=>(data as {type?:string}|null)?.type==='cfv:ready') as Array<Record<string,unknown>>

it('uses a valid initial record for the only birth read and echoes the accepted binding',async()=>{
 const endpoint=`/minions/api/sessions/initial-valid?${nativeBinding}`,initialRecordId='rec-2'
 const fetchMock=stubFetch(),received:unknown[]=[]
 const receive=(event:MessageEvent)=>received.push(event.data)
 window.addEventListener('message',receive)
 try{
  await mountEmbed('/minions/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'birth-channel',initial_record_id:initialRecordId}))
  await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const url=new URL(String(fetchMock.mock.calls[0][0]),location.origin)
  expect(url.pathname).toBe('/minions/api/sessions/initial-valid')
  expect(url.searchParams.get('offset')).toBe('-1')
  expect(url.searchParams.get('anchor')).toBe(initialRecordId)
  expect(url.searchParams.getAll('initial_record_id')).toEqual([])
  expect(url.searchParams.getAll('native_runtime_id')).toEqual([nativeRuntimeId])
  expect(url.searchParams.getAll('native_runtime_witness')).toEqual([nativeRuntimeWitness])
  expect(readyMessages(received)).toEqual([{type:'cfv:ready',endpoint,session:'sess-1',channel:'birth-channel',initialRecordId}])
 }finally{window.removeEventListener('message',receive)}
})

it.each([
 ['c1-opaque','opaque-\u0085-record'],
 ['utf16-limit','r'.repeat(1022)+'😀'],
])('preserves the agreed opaque initial record domain: %s',async(label,initialRecordId)=>{
 const endpoint=`/api/sessions/initial-opaque-${label}`,received:unknown[]=[]
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>({ok:new URL(String(input),location.origin).pathname===endpoint,json:async()=>({...page,records:page.records.map(record=>record.id==='rec-2'?{...record,id:initialRecordId}:record)})}) as Response)
 vi.stubGlobal('fetch',fetchMock)
 const receive=(event:MessageEvent)=>received.push(event.data)
 window.addEventListener('message',receive)
 try{
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'opaque-channel',initial_record_id:initialRecordId}))
  await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(new URL(String(fetchMock.mock.calls[0][0]),location.origin).searchParams.get('anchor')).toBe(initialRecordId)
  expect(readyMessages(received)).toEqual([{type:'cfv:ready',endpoint,session:'sess-1',channel:'opaque-channel',initialRecordId}])
 }finally{window.removeEventListener('message',receive)}
})

it('keeps the legacy birth read and ready shape when initial_record_id is absent',async()=>{
 const endpoint='/api/sessions/initial-legacy',fetchMock=stubFetch(),received:unknown[]=[]
 const receive=(event:MessageEvent)=>received.push(event.data)
 window.addEventListener('message',receive)
 try{
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'legacy-channel'}))
  await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const url=new URL(String(fetchMock.mock.calls[0][0]),location.origin)
  expect(url.searchParams.get('offset')).toBe('-1')
  expect(url.searchParams.has('anchor')).toBe(false)
  expect(readyMessages(received)).toEqual([{type:'cfv:ready',endpoint,session:'sess-1',channel:'legacy-channel'}])
  expect(Object.hasOwn(readyMessages(received)[0],'initialRecordId')).toBe(false)
 }finally{window.removeEventListener('message',receive)}
})

it.each([
 ['empty',''],['leading-whitespace',' rec-2'],['trailing-whitespace','rec-2 '],
 ['del-control','rec\u007f-2'],['nul-control','rec\u0000-2'],['newline-control','rec\n-2'],['over-limit','x'.repeat(1025)],
])('rejects an invalid initial record without any read or echo: %s',async(label,initialRecordId)=>{
 const endpoint=`/api/sessions/invalid-initial-${label}`,fetchMock=stubFetch(),received:unknown[]=[]
 const receive=(event:MessageEvent)=>received.push(event.data)
 window.addEventListener('message',receive)
 try{
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'ch',initial_record_id:initialRecordId}))
  expect(screen.getByRole('alert').textContent).toBe('Invalid initial record binding')
  expect(fetchMock).not.toHaveBeenCalled()
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,channel:'ch',session:'sess-1',recordId:'rec-2'})})
  await flush()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(readyMessages(received)).toHaveLength(1)
  expect(Object.hasOwn(readyMessages(received)[0],'initialRecordId')).toBe(false)
 }finally{window.removeEventListener('message',receive)}
})

it('rejects duplicate initial_record_id parameters instead of taking the first value',async()=>{
 const endpoint='/api/sessions/invalid-initial-duplicate',fetchMock=stubFetch(),received:unknown[]=[]
 const receive=(event:MessageEvent)=>received.push(event.data)
 window.addEventListener('message',receive)
 try{
  const binding=new URLSearchParams({endpoint,session:'sess-1',channel:'ch'})
  await mountEmbed(`/reader/embed.html?${binding}&initial_record_id=rec-2&initial_record_id=rec-2`)
  expect(screen.getByRole('alert').textContent).toBe('Invalid initial record binding')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(readyMessages(received)).toHaveLength(1)
  expect(Object.hasOwn(readyMessages(received)[0],'initialRecordId')).toBe(false)
 }finally{window.removeEventListener('message',receive)}
})

it.each([
 {label:'missing-session',session:null,channel:'ch'},
 {label:'empty-session',session:'',channel:'ch'},
 {label:'missing-channel',session:'sess-1',channel:null},
 {label:'empty-channel',session:'sess-1',channel:''},
 {label:'blank-channel',session:'sess-1',channel:'   '},
 {label:'invalid-endpoint',session:'sess-1',channel:'ch',endpoint:'/api/sessions/invalid-initial-endpoint?query=1'},
])('rejects an incomplete initial binding without any read or echo: $label',async({label,session,channel,endpoint:endpointOverride})=>{
 const endpoint=endpointOverride??`/api/sessions/invalid-initial-${label}`,fetchMock=stubFetch(),received:unknown[]=[]
 const receive=(event:MessageEvent)=>received.push(event.data)
 window.addEventListener('message',receive)
 try{
  const query=new URLSearchParams({endpoint,initial_record_id:'rec-2'})
  if(session!==null)query.set('session',session)
  if(channel!==null)query.set('channel',channel)
  await mountEmbed('/reader/embed.html?'+query)
  expect(screen.getByRole('alert').textContent).toBe('Invalid initial record binding')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(readyMessages(received)).toHaveLength(1)
  expect(Object.hasOwn(readyMessages(received)[0],'initialRecordId')).toBe(false)
 }finally{window.removeEventListener('message',receive)}
})

it('requires every initial-mode focus binding and keeps later focus on the mounted reader',async()=>{
 const endpoint=`/minions/api/sessions/initial-focus?${nativeBinding}`,fetchMock=stubFetch()
 await mountEmbed('/minions/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'focus-channel',initial_record_id:'rec-2'}))
 await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
 const reader=document.querySelector('[data-session-reader]')
 const valid={type:'cfv:focus',endpoint,channel:'focus-channel',session:'sess-1',recordId:'rec-1'}
 const omit=(key:string)=>Object.fromEntries(Object.entries(valid).filter(([name])=>name!==key))
 const rejected:Array<{data:Record<string,unknown>;origin?:string;source?:MessageEventSource|null}>=[
  {data:valid,origin:'https://foreign.invalid'},
  {data:valid,source:null},
  {data:{...valid,endpoint:'/minions/api/sessions/initial-focus'}},
  {data:{...valid,channel:'wrong-channel'}},
  {data:{...valid,session:'wrong-session'}},
  {data:omit('channel')},{data:omit('session')},
  {data:{...valid,channel:null}},{data:{...valid,session:null}},
  {data:{...valid,type:'cfv:unknown'}},
 ]
 for(const {data,origin=location.origin,source=window} of rejected){
  await act(async()=>{window.dispatchEvent(new MessageEvent('message',{data,origin,source}))})
  await flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
 }
 for(const recordId of ['', ' rec-1','rec-1 ','rec\n1',42,null,'x'.repeat(1025)]){
  await act(async()=>{sendHostMessage({...valid,recordId})})
  await flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
 }
 await act(async()=>{sendHostMessage(valid)})
 await waitFor(()=>expect(ringAt(0)).toContain('ring-1'))
 expect(fetchMock).toHaveBeenCalledTimes(2)
 await act(async()=>{sendHostMessage({...valid,recordId:'rec-3'})})
 await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
 expect(fetchMock).toHaveBeenCalledTimes(3)
 expect(document.querySelector('[data-session-reader]')).toBe(reader)
 expect(anchorCalls(fetchMock,endpoint)).toHaveLength(3)
})

it('keeps legacy focus compatible with omitted fields but rejects explicitly wrong identities',async()=>{
 const endpoint='/api/sessions/legacy-focus-identities',fetchMock=stubFetch()
 await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'legacy-focus'}))
 await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
 const valid={type:'cfv:focus',endpoint,channel:'legacy-focus',session:'sess-1',recordId:'rec-1'}
 for(const data of [
  {...valid,channel:'wrong'},{...valid,session:'wrong'},
  {...valid,channel:''},{...valid,session:''},
  {...valid,channel:null},{...valid,session:null},
  {...valid,channel:undefined},{...valid,session:undefined},
 ]){
  await act(async()=>{sendHostMessage(data)})
  await flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
 }
 await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,recordId:'rec-1'})})
 await waitFor(()=>expect(ringAt(0)).toContain('ring-1'))
 expect(fetchMock).toHaveBeenCalledTimes(2)
 await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,channel:'legacy-focus',recordId:'rec-3'})})
 await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
 expect(fetchMock).toHaveBeenCalledTimes(3)
 await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,session:'sess-1',recordId:'rec-2'})})
 await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
 expect(fetchMock).toHaveBeenCalledTimes(4)
})

it('declares the loaded-window Find scope without another read or transcript adaptation',async()=>{
 const fetchMock=stubFetch()
 await mountEmbed('/reader/embed.html?endpoint=/api/sessions/find-scope&session=sess-1')
 await screen.findByText('first message')
 const input=screen.getByLabelText('Find in conversation') as HTMLInputElement
 const scope=screen.getByText('仅搜索已加载范围')
 const reader=document.querySelector('[data-session-reader]')
 const scroller=document.querySelector('[data-primary-scroll]') as HTMLElement
 const reads=fetchMock.mock.calls.length,adaptations=adaptSpy.calls.length
 expect(scope.hidden).toBe(true)
 const source=document.querySelector('.embed-source') as HTMLDetailsElement
 source.open=true
 scroller.scrollTop=73
 act(()=>input.focus())
 expect(document.activeElement).toBe(input)
 expect(source.open).toBe(false)
 expect(scope.hidden).toBe(false)
 expect(scroller.scrollTop).toBe(73)
 fireEvent.change(input,{target:{value:'not in this window'}})
 act(()=>input.blur())
 expect(screen.getByText('0/0')).toBeTruthy()
 expect(scope.hidden).toBe(false)
 expect(fetchMock).toHaveBeenCalledTimes(reads)
 expect(adaptSpy.calls).toHaveLength(adaptations)
 expect(document.querySelector('[data-session-reader]')).toBe(reader)
 expect(document.querySelector('[data-primary-scroll]')).toBe(scroller)
 fireEvent.change(input,{target:{value:''}})
 expect(scope.hidden).toBe(true)
})

it('keeps a history recovery action available after the initial read fails',async()=>{
 let reads=0
 vi.stubGlobal('fetch',vi.fn(async()=>++reads===1
  ? {ok:false,text:async()=>'Synthetic initial read failure'} as Response
  : {ok:true,json:async()=>page} as Response))
 await mountEmbed('/reader/embed.html?endpoint=/api/sessions/initial-recovery&session=sess-1')
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Synthetic initial read failure')
 expect(document.querySelector('[data-session-reader]')).toBeNull()
 fireEvent.click(screen.getByText('历史'))
 fireEvent.click(screen.getByRole('button',{name:'刷新到最新'}))
 expect(await screen.findByText('first message')).toBeTruthy()
 expect(document.querySelector('[data-session-reader]')).not.toBeNull()
 expect(screen.queryByRole('alert')).toBeNull()
 expect(document.querySelectorAll('.session-reader-toolbar')).toHaveLength(1)
 expect(document.querySelector('.session-reader-toolbar .embed-history')).not.toBeNull()
 expect(document.querySelector('.session-reader-toolbar .embed-source')).not.toBeNull()
})

it('keeps the mounted runtime binding through reads, paging, refresh, focus and full tool output',async()=>{
  const path='/minions/api/local/tasks/local-native-synthetic/conversation'
  const endpoint=`${path}?${nativeBinding}`
  const received:unknown[]=[]
  const receive=(event:MessageEvent)=>received.push(event.data)
  window.addEventListener('message',receive)
  const middle=Array.from({length:80},(_,index)=>({kind:'flow-message',id:`runtime-${index}`,message:{kind:'ai-text',text:`Bound runtime message ${index}`}}))
  const output={kind:'flow-message',id:'runtime-output',message:{kind:'tool-result',content:'short output',isError:false,externalFile:'tool-results/full output?x#y.txt',totalSize:'4 B'}}
  const middlePage={...page,provider:'codex',records:[...middle,output],total:162,offset:80,next_offset:161,has_earlier:true,has_later:true,revision:'bound-revision',until:162}
  const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input),location.origin)
    if(url.pathname.endsWith('/tool-output'))return jsonResponse({content:'FULL BOUND OUTPUT'})
    if(url.searchParams.get('anchor'))return jsonResponse(middlePage)
    if(url.searchParams.get('offset')==='0')return jsonResponse({...middlePage,offset:0,next_offset:80,has_earlier:false,records:[{kind:'flow-message',id:'runtime-earlier',message:{kind:'ai-text',text:'Bound earlier message'}}]})
    if(url.searchParams.get('offset')==='161')return jsonResponse({...middlePage,offset:161,next_offset:162,has_later:false,records:[{kind:'flow-message',id:'runtime-later',message:{kind:'ai-text',text:'Bound later message'}}]})
    return jsonResponse(middlePage)
  })
  vi.stubGlobal('fetch',fetchMock)
  try{
    await mountEmbed('/minions/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'runtime-channel'}))
    await screen.findByText('Bound runtime message 0')
    expect(received.filter(data=>(data as {type?:string}|null)?.type==='cfv:ready')).toEqual([{type:'cfv:ready',endpoint,session:'sess-1',channel:'runtime-channel'}])
    expect(new URL(String(fetchMock.mock.calls[0][0]),location.origin).searchParams.get('offset')).toBe('-1')

    for(const [name,text] of [['加载更早的对话','Bound earlier message'],['继续查看','Bound later message'],['从头查看','Bound earlier message'],['刷新到最新','Bound runtime message 0']]){
      fireEvent.click(screen.getByRole('button',{name}))
      await screen.findByText(text)
      await waitFor(()=>expect(screen.getByRole('button',{name:'刷新到最新'}).hasAttribute('disabled')).toBe(false))
    }

    const beforeFocus=fetchMock.mock.calls.length
    for(const stale of [path,endpoint.replace(nativeRuntimeWitness,'b'.repeat(64))]){
      await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:stale,channel:'runtime-channel',recordId:'runtime-4'})})
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(beforeFocus)
    }
    await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,channel:'runtime-channel',recordId:'runtime-4'})})
    await waitFor(()=>expect(ringAt(4)).toContain('ring-1'))
    expect(fetchMock).toHaveBeenCalledTimes(beforeFocus+1)
    expect(new URL(String(fetchMock.mock.calls.at(-1)![0]),location.origin).searchParams.get('anchor')).toBe('runtime-4')

    const result=screen.getByText('Result').closest('details')!
    fireEvent.click(result.querySelector('summary')!)
    fireEvent.click(screen.getByRole('button',{name:'Load full output (4 B)'}))
    await screen.findByText('FULL BOUND OUTPUT')
    const requested=fetchMock.mock.calls.map(([input])=>new URL(String(input),location.origin))
    for(const url of requested){
      expect(url.origin).toBe(location.origin)
      expect(url.searchParams.getAll('native_runtime_id')).toEqual([nativeRuntimeId])
      expect(url.searchParams.getAll('native_runtime_witness')).toEqual([nativeRuntimeWitness])
      expect(url.pathname).toBe(url===requested.at(-1)?`${path}/tool-output`:path)
    }
    const earlier=requested.find(url=>url.searchParams.get('offset')==='0')!
    expect(earlier.searchParams.get('revision')).toBe('bound-revision')
    expect(earlier.searchParams.get('until')).toBe('162')
    expect(requested.at(-1)!.searchParams.get('path')).toBe('tool-results/full output?x#y.txt')
  }finally{
    window.removeEventListener('message',receive)
  }
})

it.each([
  `native_runtime_id=${nativeRuntimeId}`,
  `native_runtime_witness=${nativeRuntimeWitness}`,
  `native_runtime_id=&native_runtime_witness=${nativeRuntimeWitness}`,
  `native_runtime_id=null&native_runtime_witness=${nativeRuntimeWitness}`,
  `native_runtime_id=${nativeRuntimeId}&native_runtime_witness=`,
  `${nativeBinding}&native_runtime_witness=${nativeRuntimeWitness}`,
  `${nativeBinding}&offset=0`,
])('does not fetch or render a mounted endpoint with an invalid runtime binding (%s)',async(query)=>{
  const fetchMock=stubFetch()
  const endpoint=`/minions/api/sessions/invalid-runtime?${query}`
  await mountEmbed('/minions/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1'}))
  expect(screen.getByRole('alert').textContent).toBe('No bound session endpoint')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(document.querySelector('[data-session-reader]')).toBeNull()
})

it.each(['claude','codex'] as const)('starts the %s conversation view with tool streams hidden and keeps toolbar choices through paging and refresh',async(provider)=>{
  const conversationPage={...page,provider,total:86,offset:80,next_offset:85,has_earlier:true,has_later:true,records:[
    {kind:'flow-message',id:'question',message:{kind:'user-prompt',promptNum:1,text:'What changed?',images:[],time:'00:00',decision:'none'}},
    {kind:'flow-message',id:'thinking',message:{kind:'ai-thinking',preview:'thinking fixture',full:'thinking fixture full'}},
    {kind:'flow-message',id:'call',message:{kind:'ai-tool-use',name:'Read',summary:'read fixture',input:{}}},
    {kind:'flow-message',id:'reply',message:{kind:'ai-text',text:'The change is ready.'}},
    {kind:'flow-message',id:'output',message:{kind:'tool-result',content:'fixture tool output',isError:false}},
  ]}
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
    const offset=new URL(String(input),location.origin).searchParams.get('offset')
    const next=offset==='0' ? {...conversationPage,offset:0,next_offset:80,has_earlier:false,records:[{kind:'flow-message',id:'earlier',message:{kind:'ai-text',text:'Earlier reply.'}}]} : offset==='85' ? {...conversationPage,offset:85,next_offset:86,has_later:false,records:[{kind:'flow-message',id:'later',message:{kind:'ai-text',text:'Later reply.'}}]} : conversationPage
    return {ok:true,json:async()=>next} as Response
  }))
  await mountEmbed(`/?endpoint=/api/sessions/conversation-${provider}&session=sess-1&view=conversation`)
  const checked=(label:string)=>(filterCheckbox(label) as HTMLInputElement).checked
  for(const label of ['Thinking','Tool Calls','Results'])expect(checked(label)).toBe(false)
  for(const label of ['AI Text','Team','Branches','Markers','Timeline'])expect(checked(label)).toBe(true)
  expect(screen.getAllByText('What changed?').length).toBeGreaterThan(0)
  expect(screen.getByText('The change is ready.')).toBeTruthy()
  expect(screen.queryByText('fixture tool output')).toBeNull()
  expect(ringAt(3)).toContain('ring-1')
  fireEvent.click(filterCheckbox('Results'))
  expect(screen.getByText('fixture tool output')).toBeTruthy()
  for(const name of ['加载更早的对话','继续查看','从头查看','刷新到最新']){
    fireEvent.click(screen.getByRole('button',{name}))
    await flush()
    expect(checked('Results')).toBe(true)
    expect(checked('Tool Calls')).toBe(false)
  }
  expect(ringAt(3)).toContain('ring-1')
  fireEvent.click(filterCheckbox('Results'))
  expect(screen.queryByText('fixture tool output')).toBeNull()
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:`/api/sessions/conversation-${provider}`,recordId:'output'})})
  await flush()
  expect(screen.getByText('fixture tool output')).toBeTruthy()
  expect(checked('Results')).toBe(false)
})

it.each(['','&view=unknown'])('preserves the legacy embed filter when no conversation view is selected (%s)',async(view)=>{
  stubFetch()
  await mountEmbed(`/?endpoint=/api/sessions/legacy-${view ? 'unknown' : 'default'}&session=sess-1${view}`)
  expect((filterCheckbox('Thinking') as HTMLInputElement).checked).toBe(false)
  for(const label of ['Tool Calls','Results','AI Text','Team','Branches','Markers','Timeline']){
    expect((filterCheckbox(label) as HTMLInputElement).checked).toBe(true)
  }
})

it('announces readiness with the bound endpoint, expected session and channel',async()=>{
  stubFetch()
  const received:unknown[]=[]
  window.addEventListener('message',event=>received.push((event as MessageEvent).data))
  await mountEmbed('/?endpoint=/api/sessions/t1&session=sess-1&channel=ch-1')
  const ready=received.filter(data=>(data as {type?:string}|null)?.type==='cfv:ready')
  expect(ready).toEqual([{type:'cfv:ready',endpoint:'/api/sessions/t1',session:'sess-1',channel:'ch-1'}])
})

it('reads and announces the mounted API endpoint and keeps focus bound to that exact prefix',async()=>{
  const endpoint='/minions/api/sessions/mounted'
  const fetchMock=stubFetch(),received:unknown[]=[]
  const receive=(event:MessageEvent)=>received.push(event.data)
  window.addEventListener('message',receive)
  await mountEmbed('/minions/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',channel:'mounted-channel'}))
  expect(String(fetchMock.mock.calls[0][0]).startsWith(endpoint+'?')).toBe(true)
  expect(received.filter(data=>(data as {type?:string}|null)?.type==='cfv:ready')).toEqual([{type:'cfv:ready',endpoint,session:'sess-1',channel:'mounted-channel'}])
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:'/api/sessions/mounted',channel:'mounted-channel',recordId:'rec-2'})})
  await flush()
  expect(anchorCalls(fetchMock,endpoint)).toHaveLength(0)
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,channel:'mounted-channel',recordId:'rec-2'})})
  await flush()
  expect(anchorCalls(fetchMock,endpoint)).toHaveLength(1)
  expect(ringAt(1)).toContain('ring-1')
  window.removeEventListener('message',receive)
})

it('accepts cfv:focus with the matching channel and ignores a stale channel',async()=>{
  const fetchMock=stubFetch()
  await mountEmbed('/?endpoint=/api/sessions/t2&session=sess-1&channel=ch-2')
  // The initial latest read focuses the last message (index 2).
  await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))

  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:'/api/sessions/t2',channel:'stale-nav',recordId:'rec-2'})})
  await flush()
  expect(anchorCalls(fetchMock,'/api/sessions/t2')).toHaveLength(0)
  expect(ringAt(2)).toContain('ring-1')
  expect(ringAt(1)).not.toContain('ring-1')

  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:'/api/sessions/t2',channel:'ch-2',recordId:'rec-2'})})
  await flush()
  const anchored=anchorCalls(fetchMock,'/api/sessions/t2')
  expect(anchored).toHaveLength(1)
  expect(String(anchored[0][0])).toContain('anchor=rec-2')
  await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
  expect(ringAt(2)).not.toContain('ring-1')
})

it('honours repeated focus to the same record via fresh request tokens and suspends the internal Find',async()=>{
  const fetchMock=stubFetch()
  await mountEmbed('/?endpoint=/api/sessions/t3&session=sess-1&channel=ch-3')
  await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:'/api/sessions/t3',channel:'ch-3',recordId:'rec-1'})})
  await flush()
  await waitFor(()=>expect(ringAt(0)).toContain('ring-1'))

  // Move the highlight away through the reader's own Find.
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'last'}})
  await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
  expect(ringAt(0)).not.toContain('ring-1')

  // A second focus to the very same record must still win over the Find.
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:'/api/sessions/t3',channel:'ch-3',recordId:'rec-1'})})
  await flush()
  expect(anchorCalls(fetchMock,'/api/sessions/t3')).toHaveLength(2)
  await waitFor(()=>expect(ringAt(0)).toContain('ring-1'))
  expect(ringAt(2)).not.toContain('ring-1')
})

it('stays backwards compatible when no channel is bound',async()=>{
  const fetchMock=stubFetch()
  await mountEmbed('/?endpoint=/api/sessions/t4&session=sess-1')
  await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:'/api/sessions/t4',recordId:'rec-2'})})
  await flush()
  expect(anchorCalls(fetchMock,'/api/sessions/t4')).toHaveLength(1)
  await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
})

// Local file references in transcripts must never navigate the embed: the host
// does not serve them and the iframe would be replaced by a browser error
// page. The shell blocks exactly those clicks, keeps the mounted reader and
// its state, and reports the boundary with per-record provenance. The link
// tests pin the page to the real production mount point /reader/embed.html,
// where plain relative hrefs would otherwise resolve under /reader/…. All
// fixture paths are synthetic (/synthetic/local/…, /Users/test/…); the shape
// mirrors the real failure without copying an actual user path.
const linkPage={
  provider:'claude',
  session_id:'sess-1',
  records:[
    {kind:'flow-message',id:'rec-link-a',message:{kind:'ai-text',text:'先看 [补齐分析](/synthetic/local/research/broader_competitors.md) 再讨论。'}},
    {kind:'flow-message',id:'rec-link-b',message:{kind:'ai-text',text:'另一份 [补齐分析](../notes/second.md) 与 [编码路径](%2FUsers%2Ftest%2Fsecret.md)。'}},
    {kind:'flow-message',id:'rec-link-c',message:{kind:'ai-text',text:'[外部文档](https://example.com/Users/test/x.md) [章节](#section) [接口](/api/sessions/abc) [Reader](/reader/embed.html) [文件协议](file:///Users/test/y.md)'}},
    {kind:'flow-message',id:'rec-link-d',message:{kind:'ai-text',text:`讨论 [明确文件](/Users/test/report.md) 与 [绝对接口](${location.origin}/api/sessions/abc) 加 [绝对阅读页](${location.origin}/reader/embed.html)。`}},
    {kind:'flow-message',id:'rec-link-e',message:{kind:'ai-text',text:'相对形状 [裸文件名](report.md)、[当前目录](./report.md) 与 [子目录](notes/report.md)。'}},
    {kind:'flow-message',id:'rec-link-f',message:{kind:'ai-text',text:'家目录 [私人笔记](~/notes.md)。'}},
  ],
  total:6,offset:0,next_offset:6,has_earlier:false,has_later:false,
  read_at:'2026-10-05T00:00:00Z',boundary:'synthetic test boundary',
}

function stubLinkFetch() {
  const fetchMock=vi.fn(async (input:RequestInfo|URL)=>{
    const url=String(input)
    if(url.includes('/tool-output'))return {ok:true,json:async()=>({content:'FULL'})} as Response
    return {ok:true,json:async()=>linkPage} as Response
  })
  vi.stubGlobal('fetch',fetchMock)
  return fetchMock
}

// A real cancelable click through the DOM, exactly as a user click arrives.
const clickAnchor=async (anchor:Element)=>{
  const event=new MouseEvent('click',{bubbles:true,cancelable:true})
  await act(async()=>{anchor.dispatchEvent(event)})
  return event
}
const linkIn=(name:string,recordId:string)=>
  screen.getAllByRole('link',{name}).find(anchor=>anchor.closest('[data-source-record-id]')?.getAttribute('data-source-record-id')===recordId)!

it('hands an opted-in file click to the bound host with its record and authored href, without reading or replacing the reader',async()=>{
 const fetchMock=stubLinkFetch(),messages=vi.spyOn(window,'postMessage')
 await mountEmbed('/reader/embed.html?endpoint=/api/sessions/host-file&session=sess-1&channel=file-channel&file_links=host')
 const anchor=await waitFor(()=>linkIn('裸文件名','rec-link-e'))
 const reader=document.querySelector('[data-session-reader]'),scroller=document.querySelector('[data-primary-scroll]') as HTMLElement
 scroller.scrollTop=87
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'相对形状'}})
 const reads=fetchMock.mock.calls.length,adaptations=adaptSpy.calls.length
 messages.mockClear()
 const event=await clickAnchor(anchor)
 expect(event.defaultPrevented).toBe(true)
 expect(messages).toHaveBeenCalledExactlyOnceWith({type:'cfv:open-file',version:1,endpoint:'/api/sessions/host-file',channel:'file-channel',session:'sess-1',recordId:'rec-link-e',revision:null,reference:'report.md'},location.origin)
 expect(document.querySelector('[data-session-reader]')).toBe(reader)
 expect(scroller.scrollTop).toBe(87)
 expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('相对形状')
 expect(fetchMock.mock.calls.length).toBe(reads)
 expect(adaptSpy.calls.length).toBe(adaptations)
 expect(document.querySelector('.embed-link-notice')).toBeNull()
 messages.mockRestore()
})

it.each([false,true])('uses only a unique loaded page coordinate for parsed originals; ambiguous=%s',async ambiguous=>{
 const original={...linkPage,provider:'codex',revision:'a'.repeat(64),records:[
  {kind:'flow-message',id:'original:21',message:{kind:'ai-text',sourceRecordId:'codex-record-90',text:'[原报告](/Users/test/report.md)'}},
  ...(ambiguous?[{kind:'flow-message',id:'original:22',message:{kind:'ai-text',sourceRecordId:'codex-record-90',text:'same raw record'}}]:[]),
 ]}
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>original})))
 const messages=vi.spyOn(window,'postMessage')
 await mountEmbed('/reader/embed.html?endpoint=/api/sessions/original-file&session=sess-1&channel=original-channel&file_links=host')
 const anchor=await screen.findByRole('link',{name:'原报告'})
 messages.mockClear();await clickAnchor(anchor)
 const files=messages.mock.calls.filter(([data])=>data?.type==='cfv:open-file')
 if(ambiguous){expect(files).toHaveLength(0);expect(screen.getByText('原报告：本地文件引用未绑定预览。')).toBeTruthy()}
 else expect(files).toEqual([[{type:'cfv:open-file',version:1,endpoint:'/api/sessions/original-file',channel:'original-channel',session:'sess-1',recordId:'original:21',revision:'a'.repeat(64),reference:'/Users/test/report.md'},location.origin]])
 messages.mockRestore()
})

it.each(['','&file_links=other','&file_links=host&channel='])('retains file blocking without a complete explicit host binding: %s',async extra=>{
 stubLinkFetch()
 const messages=vi.spyOn(window,'postMessage')
 await mountEmbed('/reader/embed.html?endpoint=/api/sessions/no-host-file&session=sess-1'+extra)
 const anchor=await waitFor(()=>linkIn('明确文件','rec-link-d'))
 messages.mockClear()
 await clickAnchor(anchor)
 expect(messages.mock.calls.some(([data])=>data?.type==='cfv:open-file')).toBe(false)
 expect(screen.getByText('明确文件：本地文件引用未绑定预览。')).toBeTruthy()
 messages.mockRestore()
})

it('blocks a confirmed local file link without remounting the reader, resetting state, or fetching the file',async()=>{
  const fetchMock=stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links&session=sess-1')
  const anchor=await waitFor(()=>linkIn('明确文件','rec-link-d'))
  const readerNode=document.querySelector('[data-session-reader]')
  const scroller=document.querySelector('[data-primary-scroll]') as HTMLElement
  scroller.scrollTop=123
  fireEvent.click(filterCheckbox('Results'))
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'讨论'}})
  expect(screen.getByText(/第 1–6 条 \/ 共 6 条/)).toBeTruthy()
  const callsBefore=fetchMock.mock.calls.length

  const event=await clickAnchor(anchor)
  expect(event.defaultPrevented).toBe(true)

  // Same mounted reader node, same scroll, filter, Find and loaded range.
  expect(document.querySelector('[data-session-reader]')).toBe(readerNode)
  expect(scroller.scrollTop).toBe(123)
  expect((filterCheckbox('Results') as HTMLInputElement).checked).toBe(false)
  expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('讨论')
  expect(screen.getByText(/第 1–6 条 \/ 共 6 条/)).toBeTruthy()
  // No refetch of the session and never a fetch of the referenced file.
  expect(fetchMock.mock.calls.length).toBe(callsBefore)
  expect(fetchMock.mock.calls.some(([input])=>String(input).includes('report.md')||String(input).includes('/Users/'))).toBe(false)

  // Dismissible boundary notice; path and identities stay folded in 引用来源.
  expect(screen.getByText('明确文件：本地文件引用未绑定预览。')).toBeTruthy()
  expect(screen.getByText('路径：/Users/test/report.md')).toBeTruthy()
  expect(screen.getByText('来源记录：rec-link-d')).toBeTruthy()
  expect(screen.getByText('会话：sess-1')).toBeTruthy()

  fireEvent.click(screen.getByRole('button',{name:'关闭'}))
  expect(screen.queryByText('明确文件：本地文件引用未绑定预览。')).toBeNull()
  expect(document.querySelector('[data-session-reader]')).toBe(readerNode)
})

it('blocks unknown same-origin references and keeps the original href verbatim in per-record provenance',async()=>{
  const fetchMock=stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links-unknown&session=sess-1')
  const readerNode=document.querySelector('[data-session-reader]')

  // An absolute same-origin path the host does not serve is an unbound
  // reference, not a confirmed local file.
  const absolute=await waitFor(()=>linkIn('补齐分析','rec-link-a'))
  const callsBefore=fetchMock.mock.calls.length
  const event=await clickAnchor(absolute)
  expect(event.defaultPrevented).toBe(true)
  expect(screen.getByText('补齐分析：该引用未绑定预览。')).toBeTruthy()
  expect(screen.getByText('路径：/synthetic/local/research/broader_competitors.md')).toBeTruthy()
  expect(screen.getByText('来源记录：rec-link-a')).toBeTruthy()

  // A relative reference keeps the author's original href verbatim — the
  // browser-resolved pathname must not be presented as a local file path.
  const event2=await clickAnchor(linkIn('补齐分析','rec-link-b'))
  expect(event2.defaultPrevented).toBe(true)
  expect(screen.getByText('路径：../notes/second.md')).toBeTruthy()
  expect(screen.getByText('来源记录：rec-link-b')).toBeTruthy()
  // The same label in another record carries its own provenance; nothing crosses.
  expect(screen.queryByText('来源记录：rec-link-a')).toBeNull()
  expect(screen.queryByText('路径：/synthetic/local/research/broader_competitors.md')).toBeNull()

  // Blocking never reads the referenced file and the reader survives both clicks.
  expect(fetchMock.mock.calls.length).toBe(callsBefore)
  expect(fetchMock.mock.calls.some(([input])=>String(input).includes('second.md')||String(input).includes('broader_competitors'))).toBe(false)
  expect(document.querySelector('[data-session-reader]')).toBe(readerNode)
})

it('blocks encoded and file-scheme references with an explicit boundary instead of a guess',async()=>{
  stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links-encoded&session=sess-1')
  const encoded=await screen.findByRole('link',{name:'编码路径'})
  const event=await clickAnchor(encoded)
  expect(event.defaultPrevented).toBe(true)
  expect(screen.getByText('编码路径：本地文件引用未绑定预览。')).toBeTruthy()
  expect(screen.getByText('路径：/Users/test/secret.md')).toBeTruthy()
  expect(screen.getByText('来源记录：rec-link-b')).toBeTruthy()

  // react-markdown sanitizes the file: URL to an empty href; the shell still
  // stops the state-losing reload and reports the reference as unknown.
  const fileScheme=screen.getByText('文件协议').closest('a')!
  expect(fileScheme.getAttribute('href')??'').toBe('')
  const event2=await clickAnchor(fileScheme)
  expect(event2.defaultPrevented).toBe(true)
  expect(screen.getByText('文件协议：该引用未绑定预览。')).toBeTruthy()
  expect(screen.getByText('路径：unknown')).toBeTruthy()
  expect(screen.getByText('来源记录：rec-link-c')).toBeTruthy()
})

it('keeps pure fragments and host /api and /reader routes on their default behavior in relative and absolute form',async()=>{
  stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links-allowed&session=sess-1')
  const api=await screen.findByRole('link',{name:'接口'})
  const reader=screen.getByRole('link',{name:'Reader'})
  const absoluteApi=screen.getByRole('link',{name:'绝对接口'})
  const absoluteReader=screen.getByRole('link',{name:'绝对阅读页'})
  const fragment=screen.getByRole('link',{name:'章节'})
  for(const anchor of [api,reader,absoluteApi,absoluteReader,fragment]){
    const event=await clickAnchor(anchor)
    expect(event.defaultPrevented).toBe(false)
    expect(anchor.getAttribute('target')).toBeNull()
  }
  expect(screen.queryByText(/未绑定预览/)).toBeNull()
})

it('opens web links outside the embed while preserving the mounted reader and reading state',async()=>{
  const fetchMock=stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/web-links&session=sess-1')
  const anchor=await screen.findByRole('link',{name:'外部文档'})
  const readerNode=document.querySelector('[data-session-reader]')
  const scroller=document.querySelector('[data-export-primary]') as HTMLElement
  fireEvent.click(filterCheckbox('Results'))
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'讨论'}})
  scroller.scrollTop=123
  const callsBefore=fetchMock.mock.calls.length
  const dataBefore=adaptSpy.calls.length
  for(const href of ['https://example.test/Users/test/report.html','http://127.0.0.1:61401/review.html',`${location.origin}/review.html`,'//example.test/review.html']){
    anchor.setAttribute('href',href)
    anchor.setAttribute('target','_self')
    anchor.setAttribute('rel','author')
    const event=await clickAnchor(anchor)
    // Let the browser follow a real anchor into a separate browsing context.
    expect(event.defaultPrevented).toBe(false)
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')?.split(/\s+/)).toEqual(expect.arrayContaining(['author','noopener','noreferrer']))
    expect(document.querySelector('[data-session-reader]')).toBe(readerNode)
    expect(scroller.scrollTop).toBe(123)
  }
  expect((filterCheckbox('Results') as HTMLInputElement).checked).toBe(false)
  expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('讨论')
  expect(screen.getByText(/第 1–6 条 \/ 共 6 条/)).toBeTruthy()
  expect(fetchMock.mock.calls.length).toBe(callsBefore)
  expect(adaptSpy.calls.length).toBe(dataBefore)
  expect(screen.queryByText(/未绑定预览/)).toBeNull()
})

it('preserves missing href and special-protocol behavior and blocks empty references',async()=>{
  stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/web-links-boundary&session=sess-1')
  const anchor=await screen.findByRole('link',{name:'外部文档'})
  anchor.removeAttribute('href')
  expect((await clickAnchor(anchor)).defaultPrevented).toBe(false)
  expect(anchor.getAttribute('target')).toBeNull()
  for(const href of ['mailto:reader@example.test','tel:+10000000000','?section=two']){
    anchor.setAttribute('href',href)
    expect((await clickAnchor(anchor)).defaultPrevented).toBe(false)
    expect(anchor.getAttribute('target')).toBeNull()
  }
  for(const href of ['','   ']){
    anchor.setAttribute('href',href)
    expect((await clickAnchor(anchor)).defaultPrevented).toBe(true)
    expect(screen.getByText('外部文档：该引用未绑定预览。')).toBeTruthy()
    expect(screen.getByText('路径：unknown')).toBeTruthy()
  }
})

it.each([{target:null,rel:null},{target:'',rel:''},{target:'named-result',rel:'author'}])('restores shell-added web attributes when a reused anchor becomes a host route (%j)',async(original)=>{
  let currentPage={...page,records:[{kind:'flow-message',id:'reused-link',message:{kind:'ai-text',text:'[same record link](https://example.test/review.html)'}}],total:1,next_offset:1}
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>currentPage} as Response)))
  await mountEmbed(`/reader/embed.html?endpoint=/api/sessions/retarget-${original.target??'missing'}&session=sess-1`)
  const anchor=await screen.findByRole('link',{name:'same record link'})
  for(const name of ['target','rel'] as const){
    if(original[name]!=null)anchor.setAttribute(name,original[name])
  }
  await clickAnchor(anchor)
  expect(anchor.getAttribute('target')).toBe('_blank')
  currentPage={...currentPage,records:[{kind:'flow-message',id:'reused-link',message:{kind:'ai-text',text:'[same record link](/api/sessions/synthetic)'}}]}
  fireEvent.click(screen.getByRole('button',{name:'刷新到最新'}))
  await waitFor(()=>expect(screen.getByRole('link',{name:'same record link'}).getAttribute('href')).toBe('/api/sessions/synthetic'))
  const reused=screen.getByRole('link',{name:'same record link'})
  expect(reused).toBe(anchor)
  expect((await clickAnchor(reused)).defaultPrevented).toBe(false)
  expect(reused.getAttribute('target')).toBe(original.target)
  expect(reused.getAttribute('rel')).toBe(original.rel)
})

it('keeps downstream target and rel changes when a previously external anchor is retargeted',async()=>{
  let currentPage={...page,records:[{kind:'flow-message',id:'reused-downstream',message:{kind:'ai-text',text:'[same record link](https://example.test/review.html)'}}],total:1,next_offset:1}
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>currentPage} as Response)))
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/retarget-downstream&session=sess-1')
  const anchor=await screen.findByRole('link',{name:'same record link'})
  await clickAnchor(anchor)
  anchor.setAttribute('target','_top')
  anchor.setAttribute('rel','alternate')
  currentPage={...currentPage,records:[{kind:'flow-message',id:'reused-downstream',message:{kind:'ai-text',text:'[same record link](/reader/embed.html)'}}]}
  fireEvent.click(screen.getByRole('button',{name:'刷新到最新'}))
  await waitFor(()=>expect(anchor.getAttribute('href')).toBe('/reader/embed.html'))
  expect(screen.getByRole('link',{name:'same record link'})).toBe(anchor)
  expect((await clickAnchor(anchor)).defaultPrevented).toBe(false)
  expect(anchor.getAttribute('target')).toBe('_top')
  expect(anchor.getAttribute('rel')).toBe('alternate')
})

it('blocks relative text-file shapes at the real /reader/embed.html base instead of letting them resolve into app routes',async()=>{
  const fetchMock=stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links-relative&session=sess-1')
  const readerNode=document.querySelector('[data-session-reader]')
  const scroller=document.querySelector('[data-primary-scroll]') as HTMLElement
  scroller.scrollTop=77
  fireEvent.click(filterCheckbox('Results'))
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'相对'}})
  expect(screen.getByText(/第 1–6 条 \/ 共 6 条/)).toBeTruthy()
  const callsBefore=fetchMock.mock.calls.length

  // At the production base these plain relative hrefs resolve under
  // /reader/…; they must still be blocked as unbound references carrying the
  // author's original href verbatim, never the base-derived pathname.
  for(const [name,recordId,href] of [['裸文件名','rec-link-e','report.md'],['当前目录','rec-link-e','./report.md'],['子目录','rec-link-e','notes/report.md']] as const){
    const event=await clickAnchor(linkIn(name,recordId))
    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByText(`${name}：该引用未绑定预览。`)).toBeTruthy()
    expect(screen.getByText(`路径：${href}`)).toBeTruthy()
    expect(screen.getByText(`来源记录：${recordId}`)).toBeTruthy()
  }

  // ~ is an explicit local form: confirmed file reference, reported with the
  // actual reference — not the /reader/~/… pathname the base would derive.
  const tilde=await clickAnchor(linkIn('私人笔记','rec-link-f'))
  expect(tilde.defaultPrevented).toBe(true)
  expect(screen.getByText('私人笔记：本地文件引用未绑定预览。')).toBeTruthy()
  expect(screen.getByText('路径：~/notes.md')).toBeTruthy()
  expect(screen.getByText('来源记录：rec-link-f')).toBeTruthy()

  // Reader node, scroll, filter, Find and loaded range survive every blocked
  // click; blocking never refetches the session or reads the referenced file.
  expect(document.querySelector('[data-session-reader]')).toBe(readerNode)
  expect(scroller.scrollTop).toBe(77)
  expect((filterCheckbox('Results') as HTMLInputElement).checked).toBe(false)
  expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('相对')
  expect(screen.getByText(/第 1–6 条 \/ 共 6 条/)).toBeTruthy()
  expect(fetchMock.mock.calls.length).toBe(callsBefore)
  expect(fetchMock.mock.calls.some(([input])=>String(input).includes('report.md')||String(input).includes('notes.md'))).toBe(false)
})

// The real content scroller inside the reader is [data-export-primary]; a
// blocked-link notice opening or closing must not re-center it. This test runs
// the real SessionReader/SessionView with an active Find, counts actual
// scrollTop writes on that element plus the adapt(page) rebuilds behind the
// reader, and proves refresh/paging still replace the session data.
const scrollPage={
  provider:'claude',
  session_id:'sess-1',
  records:[
    {kind:'flow-message',id:'rec-scroll-1',message:{kind:'ai-text',text:'第一条说明。'}},
    {kind:'flow-message',id:'rec-scroll-2',message:{kind:'ai-text',text:'中间内容 讨论 的上下文。'}},
    {kind:'flow-message',id:'rec-scroll-3',message:{kind:'ai-text',text:'再看 [补齐分析](/Users/test/analysis.md) 并继续 讨论。'}},
  ],
  total:4,offset:1,next_offset:4,has_earlier:true,has_later:false,
  read_at:'2026-10-05T00:00:00Z',boundary:'synthetic test boundary',
}

function stubScrollFetch() {
  let latestReads=0
  const fetchMock=vi.fn(async (input:RequestInfo|URL)=>{
    const url=new URL(String(input),location.origin)
    if(url.pathname.includes('/tool-output'))return {ok:true,json:async()=>({content:'FULL'})} as Response
    if(url.searchParams.get('offset')==='0'){
      return {ok:true,json:async()=>({...scrollPage,offset:0,next_offset:1,has_earlier:false,records:[{kind:'flow-message',id:'rec-scroll-0',message:{kind:'ai-text',text:'更早的一条。'}}]})} as Response
    }
    // A fresh object per read: refresh must publish a new page identity.
    latestReads++
    const records=scrollPage.records.map(record=>latestReads>1 && record.id==='rec-scroll-1'
      ? {...record,message:{...record.message,text:'刷新后的正文。'}}
      : {...record})
    return {ok:true,json:async()=>({...scrollPage,records})} as Response
  })
  vi.stubGlobal('fetch',fetchMock)
  return fetchMock
}

function countScrollTopWrites(element:HTMLElement){
  let owner:object|null=element
  let descriptor:PropertyDescriptor|undefined
  while(owner && !(descriptor=Object.getOwnPropertyDescriptor(owner,'scrollTop')))owner=Object.getPrototypeOf(owner)
  if(!descriptor?.get || !descriptor.set)throw new Error('scrollTop accessor not found')
  const read=descriptor.get, write=descriptor.set
  const writes:number[]=[]
  Object.defineProperty(element,'scrollTop',{
    configurable:true,
    get(){return read.call(this)},
    set(value:number){writes.push(value);write.call(this,value)},
  })
  return writes
}

it('keeps the real content scroller and session data stable across the blocked-link notice, and still updates on refresh and paging',async()=>{
  stubScrollFetch()
  // Run rAF callbacks synchronously so any scheduled scroll positioning is
  // captured deterministically by the scrollTop write counter below.
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(performance.now());return 0})
  vi.stubGlobal('cancelAnimationFrame',()=>{})
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/scroll-steady&session=sess-1')
  await waitFor(()=>expect(ringAt(2)).toContain('ring-1'))

  // An active Find owns the current jump target.
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'讨论'}})
  await waitFor(()=>expect(ringAt(1)).toContain('ring-1'))
  expect(ringAt(2)).not.toContain('ring-1')

  const scroller=document.querySelector('[data-export-primary]') as HTMLElement
  scroller.scrollTop=456
  const writes=countScrollTopWrites(scroller)
  const adaptCallsBefore=adaptSpy.calls.length
  const dataBefore=adaptSpy.calls[adaptCallsBefore-1].data

  const event=await clickAnchor(linkIn('补齐分析','rec-scroll-3'))
  expect(event.defaultPrevented).toBe(true)
  expect(screen.getByText('补齐分析：本地文件引用未绑定预览。')).toBeTruthy()

  // Opening the notice is pure UI: no re-positioning of the real content
  // scroller and no rebuild of the session data/messages behind the reader.
  expect(writes).toEqual([])
  expect(scroller.scrollTop).toBe(456)
  expect(document.querySelector('[data-export-primary]')).toBe(scroller)
  expect(adaptSpy.calls.length).toBe(adaptCallsBefore)

  fireEvent.click(screen.getByRole('button',{name:'关闭'}))
  expect(screen.queryByText('补齐分析：本地文件引用未绑定预览。')).toBeNull()
  expect(writes).toEqual([])
  expect(scroller.scrollTop).toBe(456)
  expect(adaptSpy.calls.length).toBe(adaptCallsBefore)
  expect(adaptSpy.calls[adaptSpy.calls.length-1].data).toBe(dataBefore)
  expect(adaptSpy.calls[adaptSpy.calls.length-1].data.messages).toBe(dataBefore.messages)

  // Folding the sources panel is pure UI too.
  fireEvent.click(screen.getByLabelText('来源与读取边界'))
  expect(writes).toEqual([])
  expect(adaptSpy.calls.length).toBe(adaptCallsBefore)

  // The Find still owns the target and the loaded range is untouched.
  expect(ringAt(1)).toContain('ring-1')
  expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('讨论')
  expect(screen.getByText(/第 2–4 条 \/ 共 4 条/)).toBeTruthy()

  // A real refresh publishes a new page identity, so the session data MUST be
  // rebuilt — the memo is bound to the page, not frozen.
  fireEvent.click(screen.getByRole('button',{name:'刷新到最新'}))
  await flush()
  expect(adaptSpy.calls.length).toBeGreaterThan(adaptCallsBefore)
  const refreshed=adaptSpy.calls[adaptSpy.calls.length-1].data
  expect(screen.getByText('刷新后的正文。')).toBeTruthy()
  expect(screen.queryByText('第一条说明。')).toBeNull()
  expect(refreshed).not.toBe(dataBefore)
  expect(refreshed.messages).not.toBe(dataBefore.messages)
  expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('讨论')

  // Paging earlier also replaces the data and extends the loaded range.
  fireEvent.click(screen.getByRole('button',{name:'加载更早的对话'}))
  await flush()
  expect(adaptSpy.calls[adaptSpy.calls.length-1].data).not.toBe(refreshed)
  expect(screen.getByText('更早的一条。')).toBeTruthy()
  expect(screen.getByText('刷新后的正文。')).toBeTruthy()
  expect(screen.getByText(/第 1–4 条 \/ 共 4 条/)).toBeTruthy()
})

function pagingRecord(id:string,text:string,tool=false){
  return {kind:'flow-message',id,message:tool?{kind:'ai-tool-use',name:'Read',summary:text,input:{}}:{kind:'ai-text',text}}
}
const pagingMiddle=Array.from({length:80},(_,index)=>pagingRecord(`middle-${index}`,index===1?'fresh middle match':`middle record ${index}`,index===0))
const pagingEarlier=Array.from({length:80},(_,index)=>pagingRecord(`earlier-${index}`,index===0?'fresh earlier match':`earlier record ${index}`))
const pagingLater=[pagingRecord('tail-0','fresh later match'),pagingRecord('tail-1','latest reply')]
function pagingWindow(offset:number,records:ReturnType<typeof pagingRecord>[]){
  return {...page,records,total:162,offset,next_offset:offset+records.length,has_earlier:offset>0,has_later:offset+records.length<162}
}
function deferredPagingResponse(){
  let resolve!:(response:Response)=>void
  const promise=new Promise<Response>(ok=>{resolve=ok})
  return {promise,resolve}
}
const jsonResponse=(value:unknown)=>({ok:true,json:async()=>value}) as Response
const findInput=()=>screen.getByLabelText('Find in conversation') as HTMLInputElement
const embedStatus=()=>document.querySelector('.embed-status')?.textContent??''
async function setupPagingRace(direction:'earlier'|'later',suffix:string){
  const endpoint=`/api/sessions/find-${direction}-${suffix}`,pending=deferredPagingResponse()
  const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input),location.origin),anchor=url.searchParams.get('anchor'),offset=url.searchParams.get('offset')
    if(anchor==='middle-4')return jsonResponse(pagingWindow(80,pagingMiddle))
    if(anchor==='tail-1')return jsonResponse(pagingWindow(160,pagingLater))
    if(offset===(direction==='earlier'?'0':'160'))return pending.promise
    return jsonResponse(pagingWindow(160,pagingLater))
  })
  vi.stubGlobal('fetch',fetchMock)
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',view:'conversation'}))
  await waitFor(()=>expect(embedStatus()).toMatch(/^第 161–162 条/))
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,recordId:'middle-4'})})
  await waitFor(()=>expect(embedStatus()).toMatch(/^第 81–160 条/))
  expect(ringAt(4)).toContain('ring-1')
  fireEvent.click(screen.getByRole('button',{name:direction==='earlier'?'加载更早的对话':'继续查看'}))
  await waitFor(()=>expect(embedStatus()).toMatch(/^读取中 · 第 81–160 条/))
  return {endpoint,fetchMock,pending,finish:()=>pending.resolve(jsonResponse(direction==='earlier'?pagingWindow(0,pagingEarlier):pagingWindow(160,pagingLater)))}
}

it.each(['earlier','later'] as const)('preserves newer Find through %s completion and retires the old positional navigation',async(direction)=>{
  const race=await setupPagingRace(direction,'newer-query'),input=findInput(),calls=race.fetchMock.mock.calls.length
  fireEvent.change(input,{target:{value:'fresh'}})
  expect(input.value).toBe('fresh')
  expect(input.disabled).toBe(false)
  expect(screen.getByRole('button',{name:'Next'}).hasAttribute('disabled')).toBe(false)
  expect(race.fetchMock).toHaveBeenCalledTimes(calls)
  await act(async()=>{race.finish()})
  await waitFor(()=>expect(embedStatus()).toMatch(direction==='earlier'?/^第 1–160 条/:/^第 81–162 条/))
  expect(findInput()).toBe(input)
  expect(input.value).toBe('fresh')
  expect(screen.getByRole('button',{name:'Next'}).hasAttribute('disabled')).toBe(false)
  expect(screen.getByText('1/2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'Next'}))
  const match=document.querySelector('[data-message-index].ring-1')
  expect(match?.getAttribute('data-source-record-id')).toBe(direction==='earlier'?'middle-1':'tail-0')
  fireEvent.change(input,{target:{value:''}})
  expect(document.querySelector('[data-message-index].ring-1')).toBeNull()
  expect(race.fetchMock).toHaveBeenCalledTimes(calls)
})

it.each(['earlier','later'] as const)('preserves clear/retype and a newer zero-match Find during %s',async(direction)=>{
  const race=await setupPagingRace(direction,'clear-retype'),calls=race.fetchMock.mock.calls.length
  for(const value of ['fresh','','no-match-in-this-window'])fireEvent.change(findInput(),{target:{value}})
  expect(findInput().value).toBe('no-match-in-this-window')
  expect(screen.getByRole('button',{name:'Next'}).hasAttribute('disabled')).toBe(true)
  await act(async()=>{race.finish()})
  await waitFor(()=>expect(embedStatus()).not.toMatch(/^读取中/))
  expect(findInput().value).toBe('no-match-in-this-window')
  expect(screen.getByRole('button',{name:'Next'}).hasAttribute('disabled')).toBe(true)
  expect(document.querySelector('[data-message-index].ring-1')).toBeNull()
  fireEvent.change(findInput(),{target:{value:''}})
  expect(document.querySelector('[data-message-index].ring-1')).toBeNull()
  expect(race.fetchMock).toHaveBeenCalledTimes(calls)
})

it.each(['earlier','later'] as const)('retains ordinary %s navigation when no newer nonempty Find owns the read',async(direction)=>{
  const race=await setupPagingRace(direction,'cleared-query')
  fireEvent.change(findInput(),{target:{value:'fresh'}})
  fireEvent.change(findInput(),{target:{value:''}})
  await act(async()=>{race.finish()})
  await waitFor(()=>expect(embedStatus()).not.toMatch(/^读取中/))
  expect(findInput().value).toBe('')
  expect(ringAt(direction==='earlier'?0:1)).toContain('ring-1')
})

it('lets explicit host focus invalidate pending pagination and preserves that real target after Find is cleared',async()=>{
  const race=await setupPagingRace('earlier','host-supersedes')
  fireEvent.change(findInput(),{target:{value:'fresh'}})
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:race.endpoint,recordId:'tail-1'})})
  await waitFor(()=>expect(embedStatus()).toMatch(/^第 161–162 条/))
  expect(findInput().value).toBe('')
  expect(ringAt(1)).toContain('ring-1')
  fireEvent.change(findInput(),{target:{value:'fresh'}})
  await act(async()=>{race.finish()})
  expect(embedStatus()).toMatch(/^第 161–162 条/)
  expect(findInput().value).toBe('fresh')
  fireEvent.change(findInput(),{target:{value:''}})
  expect(ringAt(1)).toContain('ring-1')
})

it('keeps refresh-to-latest as explicit navigation even when Find is edited while its response is pending',async()=>{
  const endpoint='/api/sessions/find-refresh-explicit',pending=deferredPagingResponse();let latestReads=0
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input),location.origin)
    if(url.searchParams.get('anchor')==='middle-4')return jsonResponse(pagingWindow(80,pagingMiddle))
    if(++latestReads>1)return pending.promise
    return jsonResponse(pagingWindow(160,pagingLater))
  }))
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',view:'conversation'}))
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,recordId:'middle-4'})})
  await waitFor(()=>expect(embedStatus()).toMatch(/^第 81–160 条/))
  fireEvent.click(screen.getByRole('button',{name:'刷新到最新'}))
  fireEvent.change(findInput(),{target:{value:'fresh'}})
  await act(async()=>{pending.resolve(jsonResponse(pagingWindow(160,pagingLater)))})
  await waitFor(()=>expect(embedStatus()).toMatch(/^第 161–162 条/))
  expect(findInput().value).toBe('')
  expect(ringAt(1)).toContain('ring-1')
})

it('does not publish a different session from a pending page or discard the current Find on identity failure',async()=>{
  const race=await setupPagingRace('earlier','identity-failure')
  fireEvent.change(findInput(),{target:{value:'fresh'}})
  await act(async()=>{race.pending.resolve(jsonResponse({...pagingWindow(0,pagingEarlier),session_id:'other-synthetic-session'}))})
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Selected session identity changed'))
  expect(embedStatus()).toMatch(/^第 81–160 条/)
  expect(findInput().value).toBe('fresh')
  expect(document.querySelector('[data-source-record-id="earlier-0"]')).toBeNull()
})

// ─── Empty-range and fully-filtered guidance ───
//
// A native tail of reasoning/commandExecution/subAgentActivity records under
// view=conversation (thinking/toolCalls/results off) yields zero genuinely
// rendered transcript nodes. That is not "no data": the guidance must say the
// filter hides everything and offer ways out, while a truly empty read range
// gets a distinct message. All fixtures are synthetic ids/text.

const nativeTailRecords=Array.from({length:80},(_,index)=>{
  if(index%3===0)return {id:`tail-${index}`,ordinal:index,item:{type:'reasoning',content:`synthetic reasoning ${index}`,summary:''}}
  if(index%3===1)return {id:`tail-${index}`,ordinal:index,item:{type:'commandExecution',command:`run synthetic-step-${index}`,aggregatedOutput:`synthetic output ${index}`,exitCode:0}}
  return {id:`tail-${index}`,ordinal:index,item:{type:'subAgentActivity',agent:`synthetic-agent-${index}`,status:'running'}}
})
const nativeTailPage={
  provider:'codex',session_id:'sess-1',records:nativeTailRecords,
  total:160,offset:80,next_offset:160,has_earlier:true,has_later:false,
  read_at:'2026-10-05T00:00:00Z',boundary:'synthetic test boundary',
}
const emptyActions=()=>within(document.querySelector('.reader-empty-actions') as HTMLElement)

it('guides through an entirely filtered 80-record native tail: adjust filters reveals existing output, loading earlier issues once and shows the returned body',async()=>{
  const earlierRecords=[
    {id:'earlier-0',ordinal:0,item:{type:'userMessage',content:'synthetic earlier question'}},
    {id:'earlier-1',ordinal:1,item:{type:'agentMessage',text:'synthetic earlier answer body'}},
  ]
  const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input),location.origin)
    if(url.searchParams.get('offset')==='0')return jsonResponse({...nativeTailPage,offset:0,next_offset:80,has_earlier:false,records:earlierRecords})
    return jsonResponse(nativeTailPage)
  })
  vi.stubGlobal('fetch',fetchMock)
  const endpoint='/api/sessions/native-tail'
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',view:'conversation'}))

  // Nonempty loaded range, zero genuinely rendered records: guidance, not a bare toolbar.
  expect(await screen.findByText('当前筛选没有可见记录')).toBeTruthy()
  expect(screen.queryByText('当前读取范围没有记录')).toBeNull()
  expect(document.querySelectorAll('[data-message-index]')).toHaveLength(0)
  // The loaded-range status still reports the real window: filtered-empty ≠ session empty.
  expect(screen.getByText(/第 81–160 条 \/ 共 160 条/)).toBeTruthy()
  expect(emptyActions().getByRole('button',{name:'加载更早的对话'})).toBeTruthy()

  // 调整筛选 opens the existing Filters panel without toggling any filter;
  // enabling Results reveals the tool output already in the loaded window.
  fireEvent.click(screen.getByRole('button',{name:'调整筛选'}))
  expect(screen.getByRole('button',{name:'Filters'}).getAttribute('aria-expanded')).toBe('true')
  expect(filterCheckbox('Tool Calls').checked).toBe(false)
  expect(filterCheckbox('Results').checked).toBe(false)
  fireEvent.click(filterCheckbox('Results'))
  expect(screen.getByText('synthetic output 1')).toBeTruthy()
  expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()

  // Back to the filtered-empty state, then load earlier from the guidance:
  // exactly one normal earlier request, and the returned original body renders.
  fireEvent.click(filterCheckbox('Results'))
  expect(await screen.findByText('当前筛选没有可见记录')).toBeTruthy()
  const callsBefore=fetchMock.mock.calls.length
  fireEvent.click(emptyActions().getByRole('button',{name:'加载更早的对话'}))
  expect(await screen.findByText('synthetic earlier answer body')).toBeTruthy()
  expect(fetchMock.mock.calls.length).toBe(callsBefore+1)
  const earlierUrl=new URL(String(fetchMock.mock.calls.at(-1)![0]),location.origin)
  expect(earlierUrl.searchParams.get('offset')).toBe('0')
  expect(screen.getAllByText('synthetic earlier question').length).toBeGreaterThan(0)
  expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
  // The merge has no earlier pages left, so the empty-state slot is retired too.
  expect(document.querySelector('.reader-empty-actions')).toBeNull()
})

it('renders an explicitly focused record from an otherwise fully filtered native tail',async()=>{
  const fetchMock=vi.fn(async()=>jsonResponse(nativeTailPage))
  vi.stubGlobal('fetch',fetchMock)
  const endpoint='/api/sessions/native-tail-focus'
  await mountEmbed('/reader/embed.html?'+new URLSearchParams({endpoint,session:'sess-1',view:'conversation'}))
  expect(await screen.findByText('当前筛选没有可见记录')).toBeTruthy()

  // tail-1 is a commandExecution record: hidden by the conversation filter, but
  // explicit host focus must render it through the focus bypass.
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint,recordId:'tail-1'})})
  await flush()
  expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
  expect(document.querySelectorAll('[data-message-index]')).toHaveLength(1)
  expect(ringAt(1)).toContain('ring-1')
  expect(screen.getByText('run synthetic-step-1')).toBeTruthy()
})

it('shows a distinct zero-records message and never displays success-empty while a read is in flight',async()=>{
  const pending=deferredPagingResponse()
  let reads=0
  const fetchMock=vi.fn(async()=>++reads===1
    ? jsonResponse({...page,records:[],total:0,offset:0,next_offset:0})
    : pending.promise)
  vi.stubGlobal('fetch',fetchMock)
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/empty-range&session=sess-1')

  // A completed read with zero records is distinct from the filtered state.
  expect(await screen.findByText('当前读取范围没有记录')).toBeTruthy()
  expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
  expect(document.querySelector('.reader-empty-actions')).toBeNull()

  // While the refresh is in flight the success-empty guidance is suspended.
  fireEvent.click(screen.getByRole('button',{name:'刷新到最新'}))
  await waitFor(()=>expect(screen.queryByText('当前读取范围没有记录')).toBeNull())
  expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()

  // The returned body renders once the read completes.
  await act(async()=>{pending.resolve(jsonResponse({...page,records:[{kind:'flow-message',id:'returned-1',message:{kind:'ai-text',text:'returned original body'}}],total:1,offset:0,next_offset:1}))})
  expect(await screen.findByText('returned original body')).toBeTruthy()
  expect(screen.queryByText('当前读取范围没有记录')).toBeNull()
})

it('focuses an original Claude UUID through its numeric owner while preserving numeric focus',async()=>{
 const endpoint='/api/sessions/source-anchor'
 const uuid='11111111-2222-3333-4444-555555555555'
 const anchored={...page,records:page.records.map((record,index)=>({...record,id:String(140+index),message:{...record.message,sourceRecordId:index===1 ? uuid : `other-${index}`}})),
  sourceAnchors:{version:1,session_id:'sess-1',entries:[{sourceRecordId:uuid,messageIndex:141}]}}
 const fetchMock=vi.fn(async()=>jsonResponse(anchored));vi.stubGlobal('fetch',fetchMock)
 await mountEmbed(`/reader/embed.html?endpoint=${endpoint}&session=sess-1&channel=anchor-proof`)
 await screen.findByText('the selected question')
 act(()=>sendHostMessage({type:'cfv:focus',endpoint,channel:'anchor-proof',recordId:uuid}))
 await waitFor(()=>expect(ringAt(1)).toContain('ring-'))
 expect(anchorCalls(fetchMock,endpoint)).toHaveLength(1)
 act(()=>sendHostMessage({type:'cfv:focus',endpoint,channel:'anchor-proof',recordId:'140'}))
 await waitFor(()=>expect(ringAt(0)).toContain('ring-'))
})
it('shows an unavailable source anchor instead of silently focusing unrelated text',async()=>{
 const endpoint='/api/sessions/source-anchor-denied',uuid='11111111-2222-3333-4444-555555555555'
 vi.stubGlobal('fetch',vi.fn(async()=>jsonResponse({...page,sourceAnchors:{version:1,session_id:'foreign',entries:[{sourceRecordId:uuid,messageIndex:1}]}})))
 await mountEmbed(`/reader/embed.html?endpoint=${endpoint}&session=sess-1&channel=anchor-proof`)
 await screen.findByText('first message')
 act(()=>sendHostMessage({type:'cfv:focus',endpoint,channel:'anchor-proof',recordId:uuid}))
 await screen.findByText('Requested source record is not uniquely available in this reading window')
 expect(document.querySelector('[data-message-index].ring-1')).toBeNull()
})
it('retires an accepted raw focus when the next page cannot certify the same source anchor',async()=>{
 const endpoint='/api/sessions/source-anchor-retired',uuid='11111111-2222-3333-4444-555555555555'
 const first={...page,records:[
  {kind:'flow-message',id:'140',message:{kind:'ai-tool-use',name:'Agent',summary:'First certified Agent context',input:{description:'First certified Agent context'},sourceRecordId:uuid}},
  {kind:'flow-message',id:'141',message:{kind:'ai-text',text:'First context tail'}},
 ],sourceAnchors:{version:1,session_id:'sess-1',entries:[{sourceRecordId:uuid,messageIndex:140}]}}
 let response:unknown=first
 vi.stubGlobal('fetch',vi.fn(async()=>jsonResponse(response)))
 await mountEmbed(`/reader/embed.html?endpoint=${endpoint}&session=sess-1&channel=retired`)
 await screen.findByText('First certified Agent context')
 act(()=>sendHostMessage({type:'cfv:focus',endpoint,channel:'retired',recordId:uuid}))
 await waitFor(()=>expect(ringAt(0)).toContain('ring-'))
 response={...page,records:[{kind:'flow-message',id:'140',message:{kind:'ai-text',text:'UNRELATED replacement context',sourceRecordId:uuid}}]}
 act(()=>sendHostMessage({type:'cfv:focus',endpoint,channel:'retired',recordId:uuid}))
 await screen.findByText('Requested source record is not uniquely available in this reading window')
 expect(screen.getByText('UNRELATED replacement context')).toBeTruthy()
 expect(ringAt(0)).not.toContain('ring-')
})
