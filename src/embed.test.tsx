// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {act} from 'react'
import {cleanup,fireEvent,screen,waitFor} from '@testing-library/react'

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

it('blocks a confirmed local file link without remounting the reader, resetting state, or fetching the file',async()=>{
  const fetchMock=stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links&session=sess-1')
  const anchor=await waitFor(()=>linkIn('明确文件','rec-link-d'))
  const readerNode=document.querySelector('[data-session-reader]')
  const scroller=document.querySelector('[data-primary-scroll]') as HTMLElement
  scroller.scrollTop=123
  fireEvent.click(screen.getByRole('checkbox',{name:'Results'}))
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'讨论'}})
  expect(screen.getByText(/第 1–6 条 \/ 共 6 条/)).toBeTruthy()
  const callsBefore=fetchMock.mock.calls.length

  const event=await clickAnchor(anchor)
  expect(event.defaultPrevented).toBe(true)

  // Same mounted reader node, same scroll, filter, Find and loaded range.
  expect(document.querySelector('[data-session-reader]')).toBe(readerNode)
  expect(scroller.scrollTop).toBe(123)
  expect((screen.getByRole('checkbox',{name:'Results'}) as HTMLInputElement).checked).toBe(false)
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

it('keeps external links, pure fragments and host /api and /reader routes on their default behavior in relative and absolute form',async()=>{
  stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links-allowed&session=sess-1')
  // Even an external https URL whose pathname contains /Users/ stays external.
  const external=await screen.findByRole('link',{name:'外部文档'})
  const api=screen.getByRole('link',{name:'接口'})
  const reader=screen.getByRole('link',{name:'Reader'})
  const absoluteApi=screen.getByRole('link',{name:'绝对接口'})
  const absoluteReader=screen.getByRole('link',{name:'绝对阅读页'})
  const fragment=screen.getByRole('link',{name:'章节'})
  for(const anchor of [external,api,reader,absoluteApi,absoluteReader,fragment]){
    const event=await clickAnchor(anchor)
    expect(event.defaultPrevented).toBe(false)
  }
  expect(screen.queryByText(/未绑定预览/)).toBeNull()
})

it('blocks relative text-file shapes at the real /reader/embed.html base instead of letting them resolve into app routes',async()=>{
  const fetchMock=stubLinkFetch()
  await mountEmbed('/reader/embed.html?endpoint=/api/sessions/local-links-relative&session=sess-1')
  const readerNode=document.querySelector('[data-session-reader]')
  const scroller=document.querySelector('[data-primary-scroll]') as HTMLElement
  scroller.scrollTop=77
  fireEvent.click(screen.getByRole('checkbox',{name:'Results'}))
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
  expect((screen.getByRole('checkbox',{name:'Results'}) as HTMLInputElement).checked).toBe(false)
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
  fireEvent.click(screen.getByText('来源与读取边界'))
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
