import {parseCodexNativeRecords, type NativeConversationRecord} from './providers/codex-native'
import type {ClaudeSourceAnchors} from './providers/claude'
import {computeHeatmap} from './heatmap'
import type {SessionData,SessionMessage} from '../types/session'
export interface FlowConversationRecord {kind:'flow-message';id:string;message:SessionMessage;timestamp?:string|null}
export interface ConversationPage {
  provider:'claude'|'codex'; session_id:string
  records:Array<NativeConversationRecord | FlowConversationRecord>
  total:number;offset:number;next_offset:number;has_earlier:boolean;has_later:boolean
  sourceAnchors?:ClaudeSourceAnchors
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

/** Resolve only coordinates certified by this session's official parser snapshot. */
export function resolveConversationAnchor(page:ConversationPage,anchor:string):number {
  if(page.provider==='codex')return normalizeConversationPage(page).messages.findIndex(message=>message.sourceRecordId===anchor)
  const direct=page.records.flatMap((record,index)=>record.id===anchor ? [index] : [])
  if(direct.length===1)return direct[0]
  if(direct.length>1)return -1
  const packet=page.sourceAnchors
  if(!packet || packet.version!==1 || packet.session_id!==page.session_id || !Array.isArray(packet.entries))return -1
  const matches=packet.entries.filter(entry=>entry?.sourceRecordId===anchor)
  if(matches.length!==1)return -1
  const coordinate=matches[0].messageIndex
  if(!Number.isSafeInteger(coordinate) || coordinate<0)return -1
  const records=page.records.flatMap((record,index)=>record.id===String(coordinate) ? [{record,index}] : [])
  if(records.length!==1)return -1
  const {record,index}=records[0]
  if(!('message' in record) || record.kind!=='flow-message' || record.message?.sourceRecordId!==anchor)return -1
  return index
}
