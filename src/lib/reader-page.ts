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
function promptsFromMessages(messages:SessionMessage[]):SessionData['prompts'] {
  return messages.flatMap(message=>message.kind==='user-prompt' ? [{num:message.promptNum,preview:message.text.slice(0,100),fullText:message.text,time:message.time,timestamp:message.timestamp,decision:message.decision}] : [])
}
export function normalizeConversationPage(page:ConversationPage):SessionData {
  if(page.provider==='codex'){
    // A Codex page is exactly one shape: native-item records (projected items, rendered by
    // parseCodexNativeRecords) OR flow-message records (already parsed by the official raw
    // parser, provenance attached there). A page mixing the two cannot be ordered or
    // de-duplicated honestly, so it is rejected instead of silently picking a lane.
    const nativeRecords:NativeConversationRecord[]=[], flowRecords:FlowConversationRecord[]=[]
    for(const record of page.records){
      if('item' in record)nativeRecords.push(record)
      else if('message' in record && record.message?.kind)flowRecords.push(record)
      else throw new Error('Conversation page record is neither a native item nor a parsed flow message')
    }
    if(nativeRecords.length>0 && flowRecords.length>0)throw new Error('Ambiguous mixed Codex conversation page: native items and parsed flow messages must not share one page')
    if(nativeRecords.length>0)return parseCodexNativeRecords(nativeRecords)
    // Flow messages keep their parser-attached provenance; record.id only fills in when the
    // message arrived without a sourceRecordId. message.input is never touched.
    const messages=flowRecords.map(record=>record.message.sourceRecordId!=null ? record.message : {...record.message,sourceRecordId:record.id})
    return {source:'codex',messages,prompts:promptsFromMessages(messages),heatmap:computeHeatmap(messages),markers:{compacts:0,plans:0,clears:0,forks:0}}
  }
  if(page.provider!=='claude')throw new Error('Unsupported session format')
  const messages=page.records.map(record=>{
    if(!('message' in record) || !record.message?.kind)throw new Error('Conversation page has no parsed message')
    return {...record.message,sourceRecordId:record.id}
  })
  const prompts=promptsFromMessages(messages)
  return {source:page.provider,messages,prompts,heatmap:computeHeatmap(messages),markers:{compacts:0,plans:0,clears:0,forks:0}}
}
