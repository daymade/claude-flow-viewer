// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {act} from 'react'
import {cleanup,fireEvent,screen,waitFor} from '@testing-library/react'

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
  const checked=(label:string)=>(screen.getByRole('checkbox',{name:label}) as HTMLInputElement).checked
  for(const label of ['Thinking','Tool Calls','Results'])expect(checked(label)).toBe(false)
  for(const label of ['AI Text','Team','Branches','Markers','Timeline'])expect(checked(label)).toBe(true)
  expect(screen.getAllByText('What changed?').length).toBeGreaterThan(0)
  expect(screen.getByText('The change is ready.')).toBeTruthy()
  expect(screen.queryByText('fixture tool output')).toBeNull()
  expect(ringAt(3)).toContain('ring-1')
  fireEvent.click(screen.getByRole('checkbox',{name:'Results'}))
  expect(screen.getByText('fixture tool output')).toBeTruthy()
  for(const name of ['加载更早的对话','继续查看','从头查看','刷新到最新']){
    fireEvent.click(screen.getByRole('button',{name}))
    await flush()
    expect(checked('Results')).toBe(true)
    expect(checked('Tool Calls')).toBe(false)
  }
  expect(ringAt(3)).toContain('ring-1')
  fireEvent.click(screen.getByRole('checkbox',{name:'Results'}))
  expect(screen.queryByText('fixture tool output')).toBeNull()
  await act(async()=>{sendHostMessage({type:'cfv:focus',endpoint:`/api/sessions/conversation-${provider}`,recordId:'output'})})
  await flush()
  expect(screen.getByText('fixture tool output')).toBeTruthy()
  expect(checked('Results')).toBe(false)
})

it.each(['','&view=unknown'])('preserves the legacy embed filter when no conversation view is selected (%s)',async(view)=>{
  stubFetch()
  await mountEmbed(`/?endpoint=/api/sessions/legacy-${view ? 'unknown' : 'default'}&session=sess-1${view}`)
  expect((screen.getByRole('checkbox',{name:'Thinking'}) as HTMLInputElement).checked).toBe(false)
  for(const label of ['Tool Calls','Results','AI Text','Team','Branches','Markers','Timeline']){
    expect((screen.getByRole('checkbox',{name:label}) as HTMLInputElement).checked).toBe(true)
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
