// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {act,render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react'
import {SessionReader} from './SessionReader'
import type {SessionData} from '../../types/session'
afterEach(cleanup)
function filterCheckbox(name:string) {
 const trigger=screen.getByRole('button',{name:'Filters'})
 if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger)
 return screen.getByRole('checkbox',{name}) as HTMLInputElement
}

Object.assign(globalThis,{ResizeObserver:class{observe(){} disconnect(){}},IntersectionObserver:class{observe(){} disconnect(){}}})
HTMLElement.prototype.scrollIntoView=vi.fn()
it('seeds only the initial filter and preserves toolbar choices when data or the seed changes',()=>{
 const data:SessionData={source:'claude',messages:[{kind:'ai-text',text:'visible reply'},{kind:'ai-tool-use',name:'Read',summary:'read fixture',input:{}},{kind:'tool-result',content:'fixture output',isError:false}],prompts:[],heatmap:[],markers:{compacts:0,plans:0,clears:0,forks:0}}
 const {rerender}=render(<SessionReader data={data} initialFilter={{toolCalls:false,toolResults:false}}/>)
 const checked=(label:string)=>(filterCheckbox(label) as HTMLInputElement).checked
 expect(checked('Thinking')).toBe(false)
 expect(checked('Tool Calls')).toBe(false)
 expect(checked('Results')).toBe(false)
 for(const label of ['AI Text','Team','Branches','Markers','Timeline'])expect(checked(label)).toBe(true)
 expect(screen.queryByText('fixture output')).toBeNull()
 fireEvent.click(filterCheckbox('Results'))
 expect(screen.getByText('fixture output')).toBeTruthy()
 rerender(<SessionReader data={{...data,messages:[...data.messages,{kind:'ai-text',text:'new page'}]}} initialFilter={{toolCalls:true,toolResults:false}}/>)
 expect(checked('Tool Calls')).toBe(false)
 expect(checked('Results')).toBe(true)
 expect(screen.getByText('fixture output')).toBeTruthy()
})

it('uses the full reader without the standalone AppState and loads its bound external tool output',async()=>{
 const load=vi.fn(async()=> 'FULL external output END')
 const data:SessionData={source:'claude',messages:[{kind:'user-prompt',promptNum:1,text:'Find the selected question',images:[],time:'2026-10-05',decision:'none'},{kind:'tool-result',content:'preview',isError:false,externalFile:'tool-results/a.txt'}],prompts:[{num:1,preview:'Find',fullText:'Find the selected question',time:'2026-10-05',decision:'none'}],heatmap:[1],markers:{compacts:0,plans:0,clears:0,forks:0}}
 const {container}=render(<SessionReader data={data} readToolResult={load}/>)
 expect(container.querySelector('[data-session-reader="claude-flow-viewer"]')).not.toBeNull()
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'preview'}})
 const button=screen.getByRole('button',{name:/load full/i})
 fireEvent.click(button)
 await waitFor(()=>expect(load).toHaveBeenCalledWith('tool-results/a.txt'))
 expect(await screen.findByText('FULL external output END')).toBeTruthy()
})

it('retains the standalone controlled search target instead of choosing the first match',()=>{
 const data:SessionData={source:'claude',messages:[{kind:'ai-text',text:'match one'},{kind:'ai-text',text:'match two'}],prompts:[],heatmap:[],markers:{compacts:0,plans:0,clears:0,forks:0}}
 const {container}=render(<SessionReader data={data} searchQuery="match" activeSearchTarget={{messageIndex:1}} showToolbar={false}/>)
 expect(container.querySelector('[data-message-index="1"]')?.className).toContain('ring-1')
 expect(container.querySelector('[data-message-index="0"]')?.className).not.toContain('ring-1')
})

it('keeps search navigation inside its reader and exposes the start of an oversized message',async()=>{
 const outerScroll=vi.spyOn(HTMLElement.prototype,'scrollIntoView')
 outerScroll.mockClear()
 const data:SessionData={source:'claude',messages:[{kind:'ai-text',text:'first'},{kind:'ai-text',text:'long selected question'}],prompts:[],heatmap:[],markers:{compacts:0,plans:0,clears:0,forks:0}}
 const {container,rerender}=render(<SessionReader data={data} showToolbar={false}/>)
 const reader=container.querySelector('[data-primary-scroll]') as HTMLElement, target=container.querySelector('[data-message-index="1"]') as HTMLElement
 Object.defineProperty(reader,'clientHeight',{value:200})
 Object.defineProperty(target,'offsetHeight',{value:300})
 reader.getBoundingClientRect=()=>({top:100}) as DOMRect
 target.getBoundingClientRect=()=>({top:500}) as DOMRect
 rerender(<SessionReader data={data} showToolbar={false} activeSearchTarget={{messageIndex:1}}/>)
 await waitFor(()=>expect(reader.scrollTop).toBe(400))
 expect(outerScroll).not.toHaveBeenCalled()
})

const FOCUS_DATA:SessionData={source:'claude',messages:[{kind:'ai-text',text:'match first'},{kind:'ai-text',text:'unrelated'},{kind:'ai-text',text:'match pending question'}],prompts:[],heatmap:[],markers:{compacts:0,plans:0,clears:0,forks:0}}
const ringAt=(container:HTMLElement,index:number)=>container.querySelector(`[data-message-index="${index}"]`)?.className ?? ''

it('shows the host Find scope on real input focus with an empty query and no open Find panel',()=>{
 const {container}=render(<SessionReader data={FOCUS_DATA} findScopeLabel="仅搜索已加载范围" toolbarTrailing={<details open><summary>Source fixture</summary><p>Bound source</p></details>}/>)
 const input=screen.getByLabelText('Find in conversation') as HTMLInputElement
 const scope=screen.getByText('仅搜索已加载范围')
 const scroller=container.querySelector('[data-primary-scroll]') as HTMLElement
 scroller.scrollTop=73
 expect(scope.hidden).toBe(true)
 expect(screen.getByRole('button',{name:'Find'}).getAttribute('aria-expanded')).toBe('false')
 act(()=>input.focus())
 expect(document.activeElement).toBe(input)
 expect(scope.hidden).toBe(false)
 expect(input.getAttribute('aria-describedby')).toBe(scope.id)
 expect(container.querySelector('details')?.open).toBe(false)
 expect(input.value).toBe('')
 expect(screen.queryByText('0/0')).toBeNull()
 expect(container.querySelector('[data-primary-scroll]')).toBe(scroller)
 expect(scroller.scrollTop).toBe(73)
})

it('keeps a nonempty Find scope outside the collapsed panel used by narrow containers',()=>{
 const {container}=render(<SessionReader data={FOCUS_DATA} findScopeLabel="仅搜索已加载范围"/>)
 const input=screen.getByLabelText('Find in conversation') as HTMLInputElement
 fireEvent.click(screen.getByRole('button',{name:'Find'}))
 fireEvent.change(input,{target:{value:'match'}})
 fireEvent.click(screen.getByRole('button',{name:'Next'}))
 expect(screen.getByText('2/2')).toBeTruthy()
 const scroller=container.querySelector('[data-primary-scroll]') as HTMLElement
 scroller.scrollTop=73
 fireEvent.click(screen.getByRole('button',{name:/^Find/}))
 act(()=>input.blur())
 const panel=input.closest('.reader-find-panel')!
 const scope=screen.getByText('仅搜索已加载范围')
 expect(panel.getAttribute('data-open')).toBe('false')
 // Container-query painting is checked in the built iframe, not by jsdom.
 // The scope must escape the existing narrow-container hidden panel.
 expect(panel.contains(scope)).toBe(false)
 expect(scope.hidden).toBe(false)
 expect(input.value).toBe('match')
 expect(ringAt(container,2)).toContain('ring-1')
 expect(container.querySelector('[data-primary-scroll]')).toBe(scroller)
 expect(scroller.scrollTop).toBe(73)
})

it('retires the Find scope after clearing and leaving the input, but retains it while focused',()=>{
 render(<SessionReader data={FOCUS_DATA} findScopeLabel="仅搜索已加载范围"/>)
 const input=screen.getByLabelText('Find in conversation') as HTMLInputElement
 const scope=screen.getByText('仅搜索已加载范围')
 fireEvent.change(input,{target:{value:'missing text'}})
 expect(screen.getByText('0/0')).toBeTruthy()
 expect(scope.hidden).toBe(false)
 act(()=>input.focus())
 fireEvent.change(input,{target:{value:''}})
 expect(scope.hidden).toBe(false)
 expect(screen.queryByText('0/0')).toBeNull()
 act(()=>input.blur())
 expect(scope.hidden).toBe(true)
})

it('leaves ordinary and controlled hosts free of an undeclared internal Find scope',()=>{
 const {container,rerender}=render(<SessionReader data={FOCUS_DATA}/>)
 const input=screen.getByLabelText('Find in conversation') as HTMLInputElement
 act(()=>input.focus())
 fireEvent.change(input,{target:{value:'match'}})
 fireEvent.click(screen.getByRole('button',{name:'Next'}))
 expect(ringAt(container,2)).toContain('ring-1')
 expect(input.getAttribute('aria-describedby')).toBeNull()
 expect(container.querySelector('.reader-find-scope')).toBeNull()
 rerender(<SessionReader data={FOCUS_DATA} searchQuery="match" activeSearchTarget={{messageIndex:2}} findScopeLabel="External search scope"/>)
 expect(screen.queryByLabelText('Find in conversation')).toBeNull()
 expect(screen.queryByText('External search scope')).toBeNull()
 expect(ringAt(container,2)).toContain('ring-1')
})

it('lets a new external target override the internal Find, and Find + Next still work afterwards',()=>{
 const {container,rerender}=render(<SessionReader data={FOCUS_DATA}/>)
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'match'}})
 expect(ringAt(container,0)).toContain('ring-1')
 expect(ringAt(container,2)).not.toContain('ring-1')

 rerender(<SessionReader data={FOCUS_DATA} activeSearchTarget={{messageIndex:2}}/>)
 expect(ringAt(container,2)).toContain('ring-1')
 expect(ringAt(container,0)).not.toContain('ring-1')

 // The internal Find was suspended: re-entering it starts from the first match again.
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'match'}})
 expect(ringAt(container,0)).toContain('ring-1')
 fireEvent.click(screen.getByRole('button',{name:'Next'}))
 expect(ringAt(container,2)).toContain('ring-1')
})

it('counts repeated same-index external navigation as new only when the request id changes',()=>{
 const {container,rerender}=render(<SessionReader data={FOCUS_DATA} activeSearchTarget={{messageIndex:2,requestId:'r1'}}/>)
 expect(ringAt(container,2)).toContain('ring-1')

 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'match'}})
 expect(ringAt(container,0)).toContain('ring-1')

 // A fresh object carrying the same request id is the same navigation: no incidental reset.
 rerender(<SessionReader data={FOCUS_DATA} activeSearchTarget={{messageIndex:2,requestId:'r1'}}/>)
 expect(ringAt(container,0)).toContain('ring-1')

 // A new request id for the same index suspends the internal Find again.
 rerender(<SessionReader data={FOCUS_DATA} activeSearchTarget={{messageIndex:2,requestId:'r2'}}/>)
 expect(ringAt(container,2)).toContain('ring-1')
 expect(ringAt(container,0)).not.toContain('ring-1')
})

it('does not reset the internal Find when an identical positional target is re-rendered',()=>{
 const {container,rerender}=render(<SessionReader data={FOCUS_DATA}/>)
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'match'}})
 expect(ringAt(container,0)).toContain('ring-1')

 // First sight of this position is a navigation and wins over the Find.
 rerender(<SessionReader data={FOCUS_DATA} activeSearchTarget={{messageIndex:2}}/>)
 expect(ringAt(container,2)).toContain('ring-1')

 // A re-rendered identical positional target must not reset a new Find.
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'match'}})
 expect(ringAt(container,0)).toContain('ring-1')
 rerender(<SessionReader data={FOCUS_DATA} activeSearchTarget={{messageIndex:2}}/>)
 expect(ringAt(container,0)).toContain('ring-1')
})

it('notifies actual Find edits synchronously, including clear, without reporting external navigation as a user edit',()=>{
 const edits=vi.fn()
 const {rerender}=render(<SessionReader data={FOCUS_DATA} onFindQueryChange={edits}/>)
 expect(edits).not.toHaveBeenCalled()
 for(const value of ['match','','pending']){
  fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value}})
  expect(edits).toHaveBeenLastCalledWith(value)
 }
 expect(edits).toHaveBeenCalledTimes(3)
 rerender(<SessionReader data={FOCUS_DATA} onFindQueryChange={edits} activeSearchTarget={{messageIndex:2,requestId:'host-navigation'}}/>)
 expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('')
 expect(edits).toHaveBeenCalledTimes(3)
})

it('discloses controls without replacing the reader, search, filter choices or scroll position',()=>{
 const {container}=render(<SessionReader data={FOCUS_DATA}/>)
 const reader=container.querySelector('[data-session-reader]')
 const scroller=container.querySelector('[data-primary-scroll]') as HTMLElement
 const input=screen.getByLabelText('Find in conversation') as HTMLInputElement
 fireEvent.change(input,{target:{value:'match'}})
 fireEvent.click(screen.getByRole('button',{name:/^Find/}))
 const filter=filterCheckbox('Thinking')
 fireEvent.click(filter)
 scroller.scrollTop=73
 for(let i=0;i<2;i++){
  fireEvent.click(screen.getByRole('button',{name:'Filters'}))
  fireEvent.click(screen.getByRole('button',{name:/^Find/}))
 }
 expect(container.querySelector('[data-session-reader]')).toBe(reader)
 expect(container.querySelector('[data-primary-scroll]')).toBe(scroller)
 expect(screen.getByLabelText('Find in conversation')).toBe(input)
 expect(input.value).toBe('match')
 expect(filter.checked).toBe(true)
 expect(scroller.scrollTop).toBe(73)
 fireEvent.keyDown(document,{key:'Escape'})
 expect(screen.getByRole('button',{name:/^Find/}).getAttribute('aria-expanded')).toBe('false')
 expect(document.activeElement).toBe(screen.getByRole('button',{name:/^Find/}))
})

it('opens the original record for a Find hit hidden by the result filter without altering its source',async()=>{
 const sourceRecord={type:'commandExecution',command:'cat /synthetic/worker-fixture/input.txt',commandActions:[{command:'cat /synthetic/worker-fixture/input.txt',path:'/synthetic/worker-fixture/input.txt'}],exitCode:0}
 const data:SessionData={source:'codex',messages:[{kind:'ai-text',text:'Worker prose match'},{kind:'tool-result',content:'Process exited with code 0',isError:false,sourceRecord}],prompts:[],heatmap:[],markers:{compacts:0,plans:0,clears:0,forks:0}}
 const {container}=render(<SessionReader data={data} initialFilter={{toolResults:false}}/>)
 const reader=container.querySelector('[data-session-reader]')
 const scroller=container.querySelector('[data-primary-scroll]') as HTMLElement
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'Worker'}})
 fireEvent.click(screen.getByRole('button',{name:'Next'}))
 const native=container.querySelector('[data-message-index="1"] details:last-child') as HTMLDetailsElement
 await waitFor(()=>expect(native.open).toBe(true))
 expect(native.querySelector('pre')?.textContent).toBe(JSON.stringify(sourceRecord,null,2))
 expect(filterCheckbox('Results').checked).toBe(false)
 scroller.scrollTop=73
 fireEvent.click(screen.getByRole('button',{name:'Filters'}))
 fireEvent.click(screen.getByRole('button',{name:/^Find/}))
 fireEvent.keyDown(document,{key:'Escape'})
 expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('Worker')
 expect(native.open).toBe(true)
 expect(container.querySelector('[data-session-reader]')).toBe(reader)
 expect(container.querySelector('[data-primary-scroll]')).toBe(scroller)
 expect(scroller.scrollTop).toBe(73)
})

it('keeps toolbar slots and Find in one reader while switching between their disclosures',()=>{
 const slots=()=>({toolbarLeading:<details data-leading><summary>History slot</summary><button>Earlier slot</button></details>,toolbarTrailing:<details data-trailing><summary>Source slot</summary><p>Bound source</p></details>})
 const {container,rerender}=render(<SessionReader data={FOCUS_DATA} {...slots()}/>)
 const reader=container.querySelector('[data-session-reader]')
 const scroller=container.querySelector('[data-primary-scroll]') as HTMLElement
 const leading=container.querySelector('[data-leading]') as HTMLDetailsElement
 const trailing=container.querySelector('[data-trailing]') as HTMLDetailsElement
 fireEvent.change(screen.getByLabelText('Find in conversation'),{target:{value:'match'}})
 fireEvent.click(screen.getByRole('button',{name:/^Find/}))
 fireEvent.click(screen.getByText('History slot'))
 expect(screen.getByRole('button',{name:/^Find/}).getAttribute('aria-expanded')).toBe('false')
 leading.open=true
 fireEvent.click(screen.getByRole('button',{name:'Filters'}))
 expect(leading.open).toBe(false)
 expect(filterCheckbox('Thinking').checked).toBe(false)
 trailing.open=true
 fireEvent.click(screen.getByRole('button',{name:/^Find/}))
 expect(trailing.open).toBe(false)
 trailing.open=true
 fireEvent.focus(screen.getByLabelText('Find in conversation'))
 expect(trailing.open).toBe(false)
 scroller.scrollTop=73
 rerender(<SessionReader data={FOCUS_DATA} {...slots()}/>)
 expect(container.querySelector('[data-leading]')).toBe(leading)
 expect(container.querySelector('[data-trailing]')).toBe(trailing)
 expect(container.querySelector('[data-session-reader]')).toBe(reader)
 expect(container.querySelector('[data-primary-scroll]')).toBe(scroller)
 expect((screen.getByLabelText('Find in conversation') as HTMLInputElement).value).toBe('match')
 expect(scroller.scrollTop).toBe(73)
})

const EMPTY_MARKERS={compacts:0,plans:0,clears:0,forks:0}

it('guides through a 3+ tool group that is entirely filtered out, and adjusting filters reveals the existing output',()=>{
 // A grouped run of tool calls is the case where the render array holds a
 // ToolGroup element that itself returns null: guidance must come from
 // genuinely rendered nodes, not from the array looking nonempty.
 const data:SessionData={source:'claude',messages:[
  {kind:'ai-tool-use',name:'Read',summary:'read synthetic a',input:{}},
  {kind:'tool-result',content:'synthetic group output',isError:false},
  {kind:'ai-tool-use',name:'Edit',summary:'edit synthetic b',input:{}},
  {kind:'tool-result',content:'edit synthetic ok',isError:false},
  {kind:'ai-tool-use',name:'Bash',summary:'run synthetic c',input:{}},
 ],prompts:[],heatmap:[],markers:EMPTY_MARKERS}
 render(<SessionReader data={data} initialFilter={{toolCalls:false,toolResults:false}}/>)
 expect(screen.queryByText(/tool calls/)).toBeNull()
 expect(screen.getByText('当前筛选没有可见记录')).toBeTruthy()
 expect(screen.queryByText('当前读取范围没有记录')).toBeNull()

 // 调整筛选 opens the existing Filters panel without toggling any filter.
 expect(screen.getByRole('button',{name:'Filters'}).getAttribute('aria-expanded')).toBe('false')
 fireEvent.click(screen.getByRole('button',{name:'调整筛选'}))
 expect(screen.getByRole('button',{name:'Filters'}).getAttribute('aria-expanded')).toBe('true')
 expect(filterCheckbox('Thinking').checked).toBe(false)
 expect(filterCheckbox('Tool Calls').checked).toBe(false)
 expect(filterCheckbox('Results').checked).toBe(false)

 // Enabling a filter reveals the existing tool output and retires the guidance.
 fireEvent.click(filterCheckbox('Results'))
 expect(screen.getByText('synthetic group output')).toBeTruthy()
 expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
})

it('distinguishes zero loaded records from a fully filtered body and renders the host action slot',()=>{
 const data:SessionData={source:'codex',messages:[],prompts:[],heatmap:[],markers:EMPTY_MARKERS}
 const {rerender}=render(<SessionReader data={data} emptyStateAction={<button type="button">加载更早的对话</button>}/>)
 expect(screen.getByText('当前读取范围没有记录')).toBeTruthy()
 expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
 expect(screen.getByRole('button',{name:'加载更早的对话'})).toBeTruthy()
 // 调整筛选 belongs to the filtered state only: with zero records there is nothing to reveal.
 expect(screen.queryByRole('button',{name:'调整筛选'})).toBeNull()

 // A read still in flight is not success-empty: no guidance while pending.
 rerender(<SessionReader data={data} pending emptyStateAction={<button type="button">加载更早的对话</button>}/>)
 expect(screen.queryByText('当前读取范围没有记录')).toBeNull()
 expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
})

it('keeps the healthy body free of empty-state guidance',()=>{
 const data:SessionData={source:'claude',messages:[{kind:'user-prompt',promptNum:1,text:'synthetic question',images:[],time:'00:00',decision:'none'},{kind:'ai-text',text:'ordinary reply'}],prompts:[{num:1,preview:'synthetic question',fullText:'synthetic question',time:'00:00',decision:'none'}],heatmap:[0],markers:EMPTY_MARKERS}
 render(<SessionReader data={data}/>)
 expect(screen.getByText('ordinary reply')).toBeTruthy()
 expect(screen.queryByText('当前筛选没有可见记录')).toBeNull()
 expect(screen.queryByText('当前读取范围没有记录')).toBeNull()
})
