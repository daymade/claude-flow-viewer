import {parseCodexNativeRecords, type NativeConversationRecord} from './providers/codex-native'
import {computeHeatmap} from './heatmap'
import type {SessionData,SessionMessage} from '../types/session'
export interface FlowConversationRecord {kind:'flow-message';id:string;message:SessionMessage;timestamp?:string|null}
export interface ConversationPage {
  provider:'claude'|'codex'; session_id:string
  records:Array<NativeConversationRecord | FlowConversationRecord>
  total:number;offset:number;next_offset:number;has_earlier:boolean;has_later:boolean
  revision?:string;until?:number;read_at:string;boundary:string
  identity?:{node:string;provider:string;session_id:string;manifest_sha256?:string;source_path?:string}
}
export function normalizeConversationPage(page:ConversationPage):SessionData {
  if(page.provider==='codex')return parseCodexNativeRecords(page.records.map(record=>{
    if(!('item' in record))throw new Error('Conversation page has no native item')
    return record
  }))
  if(page.provider!=='claude')throw new Error('Unsupported session format')
  const messages=page.records.map(record=>{
    if(!('message' in record) || !record.message?.kind)throw new Error('Conversation page has no parsed message')
    return {...record.message,sourceRecordId:record.id}
  })
  const prompts=messages.flatMap(message=>message.kind==='user-prompt' ? [{num:message.promptNum,preview:message.text.slice(0,100),fullText:message.text,time:message.time,timestamp:message.timestamp,decision:message.decision}] : [])
  return {source:page.provider,messages,prompts,heatmap:computeHeatmap(messages),markers:{compacts:0,plans:0,clears:0,forks:0}}
}
