import {describe,it,expect} from 'vitest'
import {isConversationMessage,LATEST_CONVERSATION,validateConversationWindowFocus,earlierConversationWindow} from '../conversation-focus'
import type {ConversationPage} from '../reader-page'

function page(q:number|null=7):ConversationPage {
  const total=1000,start=q===null?920:Math.min(Math.max(0,q-40),920)
  const records=Array.from({length:80},(_,i)=>({kind:'flow-message' as const,id:`original:${start+i}`,message:{kind:start+i===q?'user-prompt':'ai-thinking',text:''}}))
  return {provider:'codex',session_id:'test',records,total,offset:start,next_offset:start+80,has_earlier:start>0,has_later:start+80<total,read_at:'2026-01-01',boundary:'test',window_focus:{mode:LATEST_CONVERSATION,matched:q!==null,message_index:q}} as unknown as ConversationPage
}
describe('explicit initial conversation window',()=>{
  it('reads a non-aligned preceding window without duplicate original records',()=>{
    expect(earlierConversationWindow(60,80)).toEqual({offset:0,limit:60})
    expect(earlierConversationWindow(140,80)).toEqual({offset:60,limit:80})
    const window=earlierConversationWindow(60,80)
    const before=Array.from({length:window.limit},(_,i)=>window.offset+i)
    const current=Array.from({length:80},(_,i)=>60+i)
    expect([...before,...current]).toEqual(Array.from({length:140},(_,i)=>i))
    for(const offset of [0,-1,NaN,1.5])expect(()=>earlierConversationWindow(offset,80)).toThrow()
  })
  it('recognizes original human-facing messages without losing image-only users',()=>{
    for(const value of [{kind:'user-prompt',text:''},{kind:'ai-text',text:'正文'}])expect(isConversationMessage(value)).toBe(true)
    for(const value of [null,{kind:'ai-text',text:' \n '},{kind:'ai-thinking',text:'thought'},{kind:'tool-result',text:'tool'}])expect(isConversationMessage(value)).toBe(false)
  })
  it('accepts the earlier readable window and preserves the later tool tail',()=>{
    const data=page();expect(()=>validateConversationWindowFocus(data,80)).not.toThrow();expect(data.offset).toBe(0);expect(data.has_later).toBe(true)
    expect(()=>validateConversationWindowFocus(page(999),80)).not.toThrow()
    expect(()=>validateConversationWindowFocus(page(null),80)).not.toThrow()
  })
  it('rejects missing, malformed or contradictory applied echoes',()=>{
    for(const change of [undefined,null,{}, {mode:LATEST_CONVERSATION,matched:true,message_index:1000},{mode:LATEST_CONVERSATION,matched:false,message_index:7},{mode:LATEST_CONVERSATION,matched:true,message_index:7,extra:true}]){
      const data=page();data.window_focus=change as ConversationPage['window_focus'];expect(()=>validateConversationWindowFocus(data,80)).toThrow()
    }
  })
  it('rejects records with contradictory original coordinates',()=>{
    const wrong=page();wrong.records.forEach((record,i)=>{record.id=`original:${920+i}`})
    expect(()=>validateConversationWindowFocus(wrong,80)).toThrow()
  })
  it('rejects a claimed readable message, wrong start or incomplete tail metadata',()=>{
    const absent=page();(absent.records[7] as {message:{kind:string}}).message.kind='ai-thinking';expect(()=>validateConversationWindowFocus(absent,80)).toThrow()
    for(const field of ['offset','next_offset','has_later'] as const){const data=page();Object.assign(data,{[field]:field==='has_later'?false:1});expect(()=>validateConversationWindowFocus(data,80)).toThrow()}
    const later=page();(later.records[8] as {message:{kind:string}}).message.kind='user-prompt';expect(()=>validateConversationWindowFocus(later,80)).toThrow()
  })
})
