// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {act} from 'react'
import {render,cleanup,screen,waitFor} from '@testing-library/react'
import {AiTextBlock,PromptBlock} from './MessageRenderers'
import {SessionResources} from './SessionResources'
import type {ResolveImage} from './SessionResources'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
const path='/synthetic/required-image.png'
it('does not emit a broken raw filesystem image request and preserves remote and inline images',()=>{
 const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock)
 const {container}=render(<AiTextBlock msg={{kind:'ai-text',sourceRecordId:'record-a',text:`![Required](${path}) ![Remote](https://example.com/healthy.png) ![Inline](data:image/png;base64,AA==)`}}/>)
 expect(screen.getByText('Required：本地图片未绑定预览')).toBeTruthy()
 expect([...container.querySelectorAll('img')].map(img=>img.getAttribute('src'))).toEqual(['https://example.com/healthy.png','data:image/png;base64,AA=='])
 expect(fetchMock).not.toHaveBeenCalled()
})
it('loads the authenticated bound image and retires a late old source before it can display',async()=>{
 const create=vi.fn(()=> 'blob:synthetic-image'),revoke=vi.fn();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke}))
 let deliver!:(value:Response)=>void
 const fetchMock=vi.fn(()=>new Promise<Response>(resolve=>deliver=resolve));vi.stubGlobal('fetch',fetchMock)
 const msg={kind:'ai-text' as const,sourceRecordId:'record-a',text:`![Required](${path})`}
 const resolver:ResolveImage=()=>({state:'readable',url:'/api/images/opaque',source:'current-file',observed_at:'2026-10-27T00:00:00Z',scope:'source-a'})
 const {rerender}=render(<SessionResources.Provider value={{resolveImage:resolver}}><AiTextBlock msg={msg}/></SessionResources.Provider>)
 expect(fetchMock).toHaveBeenCalledWith('/api/images/opaque',expect.objectContaining({credentials:'same-origin'}))
 rerender(<SessionResources.Provider value={{resolveImage:()=>null}}><AiTextBlock msg={msg}/></SessionResources.Provider>)
 await act(async()=>deliver({ok:true,blob:async()=>new Blob(['image'],{type:'image/png'})} as Response))
 expect(screen.queryByRole('img',{name:'Required'})).toBeNull();expect(create).not.toHaveBeenCalled()
})
it('renders a healthy authenticated Blob and a concrete stale-resource failure',async()=>{
 const create=vi.fn(()=> 'blob:synthetic-image'),revoke=vi.fn();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke}))
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,blob:async()=>new Blob(['image'],{type:'image/png'})})))
 const resolver:ResolveImage=()=>({state:'readable',url:'/api/images/opaque',source:'current-file',observed_at:'2026-10-27T00:00:00Z',scope:'source-a'})
 const msg={kind:'user-prompt' as const,promptNum:1,text:'See the attached image',sourceRecordId:'owner',images:[{mediaType:'',dataUrl:'',reference:path}],time:'00:00',decision:'none' as const}
 const view=render(<SessionResources.Provider value={{resolveImage:resolver}}><PromptBlock msg={msg} searchQuery=""/></SessionResources.Provider>)
 await waitFor(()=>expect(screen.getByRole('img',{name:'Attached image 1'}).getAttribute('src')).toBe('blob:synthetic-image'))
 view.unmount();expect(revoke).toHaveBeenCalledWith('blob:synthetic-image')
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:409,json:async()=>({detail:'image_changed'})})))
 render(<SessionResources.Provider value={{resolveImage:resolver}}><AiTextBlock msg={{kind:'ai-text',sourceRecordId:'owner',text:`![Required](${path})`}}/></SessionResources.Provider>)
 await screen.findByText('Required：图片已变化，请重新读取原记录')
})

it('sends the original Unicode/space Markdown reference through the same resolver as the official CLI',async()=>{
 const reference='/synthetic/需查看 image.png'
 const resolveImage=vi.fn(()=>({state:'unavailable' as const,reason:'image_missing' as const,scope:'scope'}))
 render(<SessionResources.Provider value={{resolveImage}}><AiTextBlock msg={{kind:'ai-text',sourceRecordId:'owner',text:`![Required](<${reference}>)`}}/></SessionResources.Provider>)
 expect(resolveImage).toHaveBeenCalledWith(reference,'owner')
 expect(screen.getByText('Required：原记录引用的图片已不存在')).toBeTruthy()
})
