import {expect,it} from 'vitest'
import {parseClaudeSessionContent,buildClaudeSourceAnchors} from './claude'
const session='11111111-2222-3333-4444-555555555555'
const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const raw=(uuid:unknown)=>({type:'assistant',uuid,sessionId:session,message:{role:'assistant',content:[{type:'text',text:'context'},{type:'tool_use',id:'tool-1',name:'Agent',input:{description:'Plan'}}]}})
it('one raw record with several content blocks resolves to its first actual parsed container',()=>{
 const content=JSON.stringify(raw(id))+'\n'
 const data=parseClaudeSessionContent(content)
 expect(data.messages).toHaveLength(2)
 expect(buildClaudeSourceAnchors(content,data.messages,session)).toEqual({version:1,session_id:session,entries:[{sourceRecordId:id,messageIndex:0}]})
})
it('does not certify duplicate raw UUIDs even if tree parsing retains only one record',()=>{
 const content=[raw(id),raw(id)].map(record=>JSON.stringify(record)).join('\n')+'\n'
 const data=parseClaudeSessionContent(content)
 expect(buildClaudeSourceAnchors(content,data.messages,session).entries).toEqual([])
})
it('missing, null and wrong-type UUIDs grant no source anchor',()=>{
 for(const uuid of [undefined,null,42,'',false]){
  const content=JSON.stringify(raw(uuid))+'\n'
  expect(buildClaudeSourceAnchors(content,parseClaudeSessionContent(content).messages,session).entries).toEqual([])
 }
})
