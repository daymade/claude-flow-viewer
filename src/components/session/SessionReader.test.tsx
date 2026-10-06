// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react'
import {SessionReader} from './SessionReader'
import type {SessionData} from '../../types/session'
afterEach(cleanup)
Object.assign(globalThis,{ResizeObserver:class{observe(){} disconnect(){}},IntersectionObserver:class{observe(){} disconnect(){}}})
HTMLElement.prototype.scrollIntoView=vi.fn()
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
