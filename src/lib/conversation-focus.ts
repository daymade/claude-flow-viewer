import type {ConversationPage} from './reader-page'

export const LATEST_CONVERSATION='latest-conversation'
export interface AppliedConversationWindowFocus {
  mode:typeof LATEST_CONVERSATION
  matched:boolean
  message_index:number|null
}

/** Human-facing canonical messages; image-only original user inputs qualify. */
export function isConversationMessage(message:unknown):boolean {
  if(!message||typeof message!=='object')return false
  const value=message as {kind?:unknown;text?:unknown}
  return value.kind==='user-prompt'||value.kind==='ai-text'&&typeof value.text==='string'&&value.text.trim().length>0
}

/** Earlier windows stop exactly at the first already-loaded message. */
export function earlierConversationWindow(offset:number,limit:number):{offset:number;limit:number} {
  if(!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1||limit>200)
    throw new Error('Invalid earlier conversation window')
  return {offset:Math.max(0,offset-limit),limit:Math.min(limit,offset)}
}

/** A requested initial mode needs an explicit applied echo and a continuous window. */
export function validateConversationWindowFocus(page:ConversationPage,limit:number):void {
  const focus=page.window_focus
  const invalid=()=>{throw new Error('Conversation window focus was not confirmed')}
  if(page.provider!=='codex'||!Number.isSafeInteger(limit)||limit<1||limit>200
    ||!focus||typeof focus!=='object'||Array.isArray(focus)
    ||Object.keys(focus).sort().join(',')!=='matched,message_index,mode'
    ||focus.mode!==LATEST_CONVERSATION||typeof focus.matched!=='boolean'
    ||!Number.isSafeInteger(page.total)||page.total<0||!Number.isSafeInteger(page.offset)||page.offset<0
    ||!Array.isArray(page.records))return invalid()
  const q=focus.message_index
  if(focus.matched? !Number.isSafeInteger(q)||q===null||q<0||q>=page.total : q!==null)return invalid()
  const start=q===null?Math.max(0,page.total-limit):Math.min(Math.max(0,q-Math.floor(limit/2)),Math.max(0,page.total-limit))
  if(page.offset!==start||page.records.length!==Math.min(limit,page.total-start)
    ||page.next_offset!==start+page.records.length||page.has_earlier!==(start>0)
    ||page.has_later!==(page.next_offset<page.total))return invalid()
  if(page.records.some((record,index)=>record.id!==`original:${start+index}`))return invalid()
  const messages=page.records.map(record=>'message' in record&&record.kind==='flow-message'?record.message:null)
  if(messages.some(message=>message===null))return invalid()
  if(q!==null){
    const at=q-start
    if(!isConversationMessage(messages[at])||messages.slice(at+1).some(isConversationMessage))return invalid()
  }else if(messages.some(isConversationMessage))return invalid()
}
