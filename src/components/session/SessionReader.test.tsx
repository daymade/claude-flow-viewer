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
 const {container}=render(<SessionReader data={data} searchQuery="match" activeSearchTarget={{chunkId:'second',projectEncoded:'p',sessionId:'s',messageIndex:1}} showToolbar={false}/>)
 expect(container.querySelector('[data-message-index="1"]')?.className).toContain('ring-1')
 expect(container.querySelector('[data-message-index="0"]')?.className).not.toContain('ring-1')
})
