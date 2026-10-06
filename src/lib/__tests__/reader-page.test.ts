import {it,expect} from 'vitest'
import {normalizeConversationPage,type ConversationPage} from '../reader-page'
it('shares page normalization while rejecting mismatched source records',()=>{
 const page:ConversationPage={provider:'claude',session_id:'s',records:[{kind:'flow-message',id:'0',message:{kind:'ai-text',text:'full text'}}],total:1,offset:0,next_offset:1,has_earlier:false,has_later:false,read_at:'2026-10-05T03:32:00Z',boundary:'selected only'}
 expect(normalizeConversationPage(page).messages[0]).toMatchObject({text:'full text',sourceRecordId:'0'})
 expect(()=>normalizeConversationPage({...page,provider:'codex'})).toThrow('no native item')
})
