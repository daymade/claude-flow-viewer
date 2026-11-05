import {open, lstat} from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash} from 'node:crypto'
import {parseCodexMessagesRecordsStreaming, type CodexMessageCoordinate} from '../src/lib/codex-parser'
import {isConversationMessage} from '../src/lib/conversation-focus'
import type {SessionMessage} from '../src/types/session'

// Match the mature bounded Reader: readline's limit includes CR and LF.
export const MAX_ORIGINAL_RECORD_BYTES = 64 << 20
export const MAX_ORIGINAL_ROLLOUT_BYTES = 1 << 30
type PhysicalIdentity = {dev:string;ino:string;uid:string}
type Source = {path:string;end_byte_offset:number;sha256:string;file_identity:PhysicalIdentity}
type ClockEvent = ['construct'|'now',number]
export type StrictOriginalRequest = {
  version:1;source:Source;session_id:string;cwd:string;offset:number;limit:number;
  bound:string|null;window_focus?:'latest-conversation'|null;clock_trace:ClockEvent[]|null
}
const object = (v:unknown):v is Record<string,unknown> => v!==null && typeof v==='object' && !Array.isArray(v)
const decimal = (v:unknown):v is string => typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v)
const decoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})
const ancestry = ['history_base','forked_from_id','parent_thread_id','subagent_history_start_ordinal']

function isBlankRecordType(value:string) {
  for(const character of value){
    const code=character.codePointAt(0)!
    if(!((code>=9&&code<=13)||(code>=28&&code<=32)||code===0x85||code===0xa0
      ||code===0x1680||(code>=0x2000&&code<=0x200a)||code===0x2028||code===0x2029
      ||code===0x202f||code===0x205f||code===0x3000))return false
  }
  return true
}

/** One decode, including exact ordinal lexeme and finite floating-point checks. */
export function decodeStrictOriginalRecord(raw:Uint8Array,index:number,session:string,cwd:string) {
  if(raw.byteLength>MAX_ORIGINAL_RECORD_BYTES)throw new Error('original record exceeds byte safety limit')
  if(raw.byteLength===0||raw[raw.byteLength-1]!==10)throw new Error('original prefix has a partial line')
  if(raw.every(v=>v===9||v===10||v===11||v===12||v===13||v===32))return null
  const line=decoder.decode(raw)
  const ordinals=new WeakMap<object,string>()
  const record:unknown=JSON.parse(line,function(this:object,key:string,value:unknown,context?:{source?:string}){
    if(typeof value==='number'){
      const token=context?.source
      if(typeof token!=='string')throw new Error('strict JSON numeric token support unavailable')
      // Integers are mathematically finite even beyond Number's representation.
      // Their original token is retained in rawLine, never reconstructed from JS.
      if(!Number.isFinite(value)&&!/^-(?:0|[1-9][0-9]*)$|^(?:0|[1-9][0-9]*)$/.test(token))
        throw new Error('original JSON contains a nonfinite floating-point value')
      if(key==='ordinal')ordinals.set(this,token)
    }
    return value
  })
  if(!object(record)||typeof record.type!=='string'||isBlankRecordType(record.type)||!object(record.payload))
    throw new Error('original record requires a type and an object payload')
  const ordinalToken=ordinals.get(record)
  if(typeof record.ordinal!=='number'||typeof ordinalToken!=='string'||!/^-(?:0|[1-9][0-9]*)$|^(?:0|[1-9][0-9]*)$/.test(ordinalToken)||BigInt(ordinalToken)!==BigInt(index))
    throw new Error('original paginated ordinal differs')
  if(index===0){
    const meta=record.payload
    if(record.type!=='session_meta'||meta.id!==session||meta.cwd!==cwd||meta.history_mode!=='paginated'
      ||'session_id' in meta&&meta.session_id!==session||ancestry.some(key=>key in meta)
      ||object(meta.source)||meta.thread_source==='subagent'||meta.thread_source==='guardian_review')
      throw new Error('strict original root identity or domain differs')
  }else if(record.type==='session_meta')throw new Error('duplicate original session metadata')
  return {record,rawLine:line}
}

function identity(stat:{dev:bigint;ino:bigint;uid:bigint}):PhysicalIdentity {
  return {dev:String(stat.dev),ino:String(stat.ino),uid:String(stat.uid)}
}
function sameIdentity(a:PhysicalIdentity,b:PhysicalIdentity) {
  return a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid
}

/** Strict I/O and the existing canonical classifier share this one consumed stream. */
export async function readStrictCodexOriginalWindow(request:StrictOriginalRequest,yieldToEventLoop:()=>Promise<void>) {
  const source=request.source,focus=request.window_focus??null
  if(request.version!==1||!source||!Number.isSafeInteger(source.end_byte_offset)||source.end_byte_offset<1
    ||source.end_byte_offset>MAX_ORIGINAL_ROLLOUT_BYTES||!/^\/[\s\S]+/.test(source.path)
    ||!/^[a-f0-9]{64}$/.test(source.sha256)||!object(source.file_identity)
    ||!['dev','ino','uid'].every(k=>decimal(source.file_identity[k as keyof PhysicalIdentity]))
    ||!Number.isSafeInteger(request.offset)||request.offset< -1||!Number.isSafeInteger(request.limit)
    ||request.limit<1||request.limit>200||request.bound!==null&&!decimal(request.bound)
    ||focus!==null&&(focus!=='latest-conversation'||request.offset!==-1)
    ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.session_id)
    ||typeof request.cwd!=='string'||!request.cwd.startsWith('/'))throw new Error('invalid strict original request')
  if(request.clock_trace!==null&&(!Array.isArray(request.clock_trace)||request.clock_trace.some(e=>
    !Array.isArray(e)||e.length!==2||!['construct','now'].includes(e[0])||!Number.isSafeInteger(e[1]))))
    throw new Error('invalid original clock trace')
  const handle=await open(source.path,constants.O_RDONLY|constants.O_NOFOLLOW)
  const opened=await handle.stat({bigint:true}),openedIdentity=identity(opened)
  let consumed=0,recordCount=0,bytePosition=0,headerRaw:string|null=null,complete=false
  let current:{record:Record<string,unknown>;rawLine:string;start:number;end:number;index:number}|null=null
  const hash=createHash('sha256')
  try{
    if(!opened.isFile()||!sameIdentity(openedIdentity,source.file_identity)||opened.size<BigInt(source.end_byte_offset))
      throw new Error('original opened file identity differs')
    async function* records() {
      const stream=handle.createReadStream({start:0,end:source.end_byte_offset-1,autoClose:false})
      let pieces:Buffer[]=[],pendingBytes=0
      try{
        for await(const rawChunk of stream){
          const chunk=rawChunk as Buffer;hash.update(chunk);consumed+=chunk.length
          let start=0
          for(let end=chunk.indexOf(10,start);end!==-1;end=chunk.indexOf(10,start)){
            const piece=chunk.subarray(start,end+1);pieces.push(piece);pendingBytes+=piece.length
            if(pendingBytes>MAX_ORIGINAL_RECORD_BYTES)throw new Error('original record exceeds byte safety limit')
            const line=pieces.length===1?pieces[0]:Buffer.concat(pieces,pendingBytes)
            const before=bytePosition;bytePosition+=pendingBytes
            pieces=[];pendingBytes=0;start=end+1
            const decoded=decodeStrictOriginalRecord(line,recordCount,request.session_id,request.cwd)
            if(decoded){
              if(recordCount===0)headerRaw=decoded.rawLine
              current={...decoded,start:before,end:bytePosition,index:recordCount++}
              yield decoded.record
            }
          }
          if(start<chunk.length){const piece=chunk.subarray(start);pieces.push(piece);pendingBytes+=piece.length}
          if(pendingBytes>MAX_ORIGINAL_RECORD_BYTES)throw new Error('original record exceeds byte safety limit')
        }
      }finally{if(!stream.readableEnded)stream.destroy()}
      if(pendingBytes||consumed!==source.end_byte_offset||bytePosition!==source.end_byte_offset||recordCount<1)
        throw new Error('original stream did not exhaust its complete prefix')
      complete=true
    }
    type Retained={message:Readonly<SessionMessage>;source_index:number;source_ordinal:number;raw_line:string;byte_start:number;byte_end:number}
    let emitted=0,total=0,focusIndex:number|null=null,focusWindow:Retained[]|null=null
    const retained:Retained[]=[],bound=request.bound===null?null:BigInt(request.bound)
    function retain(message:Readonly<SessionMessage>,coordinate:CodexMessageCoordinate) {
      if(!current||coordinate.recordIndex!==current.index||coordinate.messageIndex!==emitted++||message.sourceRecord!==current.record)
        throw new Error('original message has no consumed record')
      if(bound!==null&&BigInt(current.index)>bound)return
      const index=total++
      const item={message,source_index:current.index,source_ordinal:current.index,raw_line:current.rawLine,byte_start:current.start,byte_end:current.end}
      if(request.offset===-1){
        retained.push(item);if(retained.length>request.limit)retained.shift()
        if(focus!==null){
          if(isConversationMessage(message)){focusIndex=index;focusWindow=null}
          if(focusIndex!==null&&focusWindow===null&&index>=Math.max(request.limit-1,focusIndex+request.limit-Math.floor(request.limit/2)-1))
            focusWindow=retained.slice()
        }
      }else if(index>=request.offset&&index<request.offset+request.limit)retained.push(item)
    }
    const RealDate=Date,clockTrace:ClockEvent[]=[];let clockIndex=0
    function replay(kind:ClockEvent[0]){
      const event=request.clock_trace?.[clockIndex++]
      if(!event||event[0]!==kind)throw new Error('original clock trace differs')
      clockTrace.push(event);return event[1]
    }
    const ClockDate=new Proxy(RealDate,{
      construct(target,args,newTarget){
        const prototype=newTarget===ClockDate?target:newTarget
        if(args.length)return Reflect.construct(target,args,prototype)
        if(request.clock_trace!==null)return Reflect.construct(target,[replay('construct')],prototype)
        const value=Reflect.construct(target,args,prototype);clockTrace.push(['construct',value.getTime()]);return value
      },
      get(target,key,receiver){
        if(key==='now')return ()=>{if(request.clock_trace!==null)return replay('now');const value=target.now();clockTrace.push(['now',value]);return value}
        return Reflect.get(target,key,receiver)
      },
    })
    let summary;globalThis.Date=ClockDate
    try{summary=await parseCodexMessagesRecordsStreaming(records(),yieldToEventLoop,retain)}
    finally{globalThis.Date=RealDate}
    if(request.clock_trace!==null&&clockIndex!==request.clock_trace.length)throw new Error('original clock trace differs')
    if(!complete||summary.recordCount!==recordCount||summary.messageCount!==emitted)throw new Error('original classifier did not exhaust')
    const sha256=hash.digest('hex')
    if(sha256!==source.sha256)throw new Error('original consumed prefix changed')
    const finalFd=await handle.stat({bigint:true}),finalPath=await lstat(source.path,{bigint:true})
    if(!finalPath.isFile()||!sameIdentity(identity(finalFd),openedIdentity)||!sameIdentity(identity(finalPath),openedIdentity)
      ||finalFd.size<BigInt(source.end_byte_offset)||finalPath.size<BigInt(source.end_byte_offset))throw new Error('original file identity changed')
    const top=recordCount-1
    if(bound!==null&&bound>BigInt(top))throw new Error('original boundary unavailable')
    const selected=focus!==null?(focusWindow??retained):retained
    const start=request.offset===-1?(focusIndex!==null?Math.min(Math.max(0,focusIndex-Math.floor(request.limit/2)),Math.max(0,total-request.limit)):Math.max(0,total-request.limit)):Math.min(request.offset,total)
    return {version:1,record_count:recordCount,top,total,offset:start,
      records:selected.map(item=>({...item,message:{...item.message,sourceRecord:undefined}})),
      ...(focus===null?{}:{window_focus:{mode:focus,matched:focusIndex!==null,message_index:focusIndex}}),
      clock_trace:clockTrace,certificate:{version:1,complete:true,path:source.path,bytes:consumed,
        end_byte_offset:source.end_byte_offset,sha256,file_identity:openedIdentity,record_count:recordCount,
        ordinal_start:'0',end_ordinal_exclusive:String(recordCount),raw_header:headerRaw}}
  }finally{await handle.close()}
}
