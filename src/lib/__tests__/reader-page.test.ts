import {it,expect} from 'vitest'
import {normalizeConversationPage,type ConversationPage} from '../reader-page'
import type {SessionMessage} from '../../types/session'

const pageBase={session_id:'s',total:1,offset:0,next_offset:1,has_earlier:false,has_later:false,read_at:'2026-10-05T03:32:00Z',boundary:'selected only'}

it('keeps claude flow page behavior unchanged',()=>{
 const page:ConversationPage={provider:'claude',...pageBase,records:[{kind:'flow-message',id:'0',message:{kind:'ai-text',text:'full text'}}]}
 expect(normalizeConversationPage(page).messages[0]).toMatchObject({text:'full text',sourceRecordId:'0'})
})

it('accepts a codex flow page and preserves parser provenance and raw tool input intact',()=>{
 const patch='*** Begin Patch\n*** Update File: /synthetic/workspace/app.ts\n@@\n-old line\n+new line\n*** End Patch'
 const rawRecord={timestamp:'2026-10-01T00:00:02.000Z',type:'response_item',payload:{type:'custom_tool_call',call_id:'call-synthetic-1',name:'apply_patch',input:patch}}
 const message:SessionMessage={kind:'ai-tool-use',summary:'Apply patch',name:'apply_patch',input:{raw:patch},timestamp:'00:00:02',sourceRecord:rawRecord,sourceRecordId:'call-synthetic-1'}
 const page:ConversationPage={provider:'codex',...pageBase,records:[{kind:'flow-message',id:'page-row-0',message}]}
 const data=normalizeConversationPage(page)
 expect(data.source).toBe('codex')
 expect(data.messages[0]).toBe(message)
 expect(data.messages[0].sourceRecordId).toBe('call-synthetic-1')
 expect(data.messages[0].sourceRecord).toEqual(rawRecord)
 expect(data.messages[0].kind==='ai-tool-use' && data.messages[0].input.raw).toBe(patch)
 expect(data.markers).toEqual({compacts:0,plans:0,clears:0,forks:0})
})

it('falls back to the page record id only when a codex flow message has no sourceRecordId',()=>{
 const page:ConversationPage={provider:'codex',...pageBase,records:[{kind:'flow-message',id:'page-row-7',message:{kind:'ai-text',text:'synthetic reply'}}]}
 const data=normalizeConversationPage(page)
 expect(data.messages[0]).toMatchObject({text:'synthetic reply',sourceRecordId:'page-row-7'})
})

it('extracts prompts from a codex flow page the same way as the claude branch',()=>{
 const message:SessionMessage={kind:'user-prompt',promptNum:1,text:'synthetic codex question',images:[],time:'00:00:01',timestamp:'2026-10-01T00:00:01.000Z',decision:'none',sourceRecordId:'call-synthetic-2'}
 const page:ConversationPage={provider:'codex',...pageBase,records:[{kind:'flow-message',id:'page-row-2',message}]}
 const data=normalizeConversationPage(page)
 expect(data.prompts).toEqual([{num:1,preview:'synthetic codex question',fullText:'synthetic codex question',time:'00:00:01',timestamp:'2026-10-01T00:00:01.000Z',decision:'none'}])
})

it('rejects a mixed native+flow codex page as ambiguous',()=>{
 const page:ConversationPage={provider:'codex',...pageBase,records:[
  {id:'native-1',ordinal:0,item:{type:'agentMessage',text:'native'}},
  {kind:'flow-message',id:'flow-1',message:{kind:'ai-text',text:'flow'}},
 ]}
 expect(()=>normalizeConversationPage(page)).toThrow('Ambiguous mixed Codex conversation page')
})

it('rejects a codex page record that is neither a native item nor a flow message',()=>{
 const malformed={id:'row-9',ordinal:9} as unknown as ConversationPage['records'][number]
 expect(()=>normalizeConversationPage({provider:'codex',...pageBase,records:[malformed]})).toThrow('neither a native item nor a parsed flow message')
})

it('still routes a native codex page to parseCodexNativeRecords',()=>{
 const page:ConversationPage={provider:'codex',...pageBase,records:[{id:'native-1',ordinal:0,item:{type:'agentMessage',text:'native hello'}}]}
 const data=normalizeConversationPage(page)
 expect(data.source).toBe('codex')
 expect(data.messages[0]).toMatchObject({kind:'ai-text',text:'native hello',sourceRecordId:'native-1'})
})

it('normalizes an empty codex page to an empty codex session',()=>{
 const data=normalizeConversationPage({provider:'codex',...pageBase,records:[]})
 expect(data).toEqual({source:'codex',messages:[],prompts:[],heatmap:[],markers:{compacts:0,plans:0,clears:0,forks:0}})
})
