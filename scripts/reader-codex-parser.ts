import {createReadStream} from 'node:fs'
import {open,writeFile,rename} from 'node:fs/promises'
import {createInterface} from 'node:readline'
import {parseCodexSessionContentStreaming} from '../src/lib/codex-parser'

// Thin CLI around the shared Codex parser (same entry point the local API uses), so a private
// cache reader gets byte-faithful SessionData for a rollout without this package growing a
// second parser. Top-level throw on any rejection, exactly like reader-parser.ts.
const [source,target,session,cwd,turn]=process.argv.slice(2)
if(!source||!target||!session||!cwd)throw new Error('source, private cache target, exact session id and exact cwd required')

// A rollout is only "truncated" when its final byte is not a newline: a completed line always
// ends with one. Checked up front with a 1-byte positioned read so the streaming pass below can
// decide the last line's fate the moment the stream ends.
const probe=await open(source,'r')
let endsWithNewline=false
try{
  const {size}=await probe.stat()
  if(size>0){
    const tail=Buffer.alloc(1)
    await probe.read(tail,0,1,size-1)
    endsWithNewline=tail[0]===0x0a
  }
}finally{
  await probe.close()
}

class MalformedRecord extends Error{}

let pendingTail=false
let sessionMetaCount=0
function validateLine(line:string,lineNumber:number):void{
  let record:Record<string,unknown>
  try{record=JSON.parse(line) as Record<string,unknown>}
  catch{throw new MalformedRecord(`Malformed session record at line ${lineNumber}`)}
  if(record.type!=='session_meta')return
  sessionMetaCount++
  const payload=record.payload&&typeof record.payload==='object' ? record.payload as Record<string,unknown> : {}
  if(payload.id!==session||payload.cwd!==cwd)throw new Error(`session identity mismatch at line ${lineNumber}`)
}

// Lines stream through with a one-line lag: whether a malformed line is tolerable depends on
// nothing after it existing, which only the arrival of the next line (or EOF) can prove.
async function* validatedLines():AsyncIterable<string>{
  const reader=createInterface({input:createReadStream(source,{encoding:'utf8'}),crlfDelay:Infinity})
  let held:{line:string,number:number}|null=null,lineNumber=0
  for await(const line of reader){
    lineNumber++
    if(held){
      if(held.line.trim())validateLine(held.line,held.number)
      yield held.line
    }
    held={line,number:lineNumber}
  }
  if(held&&held.line.trim()){
    try{validateLine(held.line,held.number)}
    catch(error){
      if(error instanceof MalformedRecord&&!endsWithNewline){pendingTail=true;held=null}
      else throw error
    }
  }
  if(held)yield held.line
}

// Turn filtering binds ONLY through the record payload's explicit turn metadata — never through
// time, latest, or prompt guessing. The predicate runs INSIDE the streaming classifier (as
// recordSelection), not as a post-filter over fully classified messages: every line is still
// strictly validated above and every record is still counted and folded into session bookkeeping,
// but a record from another turn never materializes a SessionMessage, so a turn-scoped read does
// not pin the whole rollout's payloads in memory. Missing payload/metadata means not selected;
// comparison is exact string equality on turn_id.
const recordSelection=turn
  ? (record:Record<string,unknown>):boolean=>{
      const payload=record.payload
      if(!payload||typeof payload!=='object')return false
      const metadata=(payload as Record<string,unknown>).internal_chat_message_metadata_passthrough
      if(!metadata||typeof metadata!=='object')return false
      return (metadata as Record<string,unknown>).turn_id===turn
    }
  : undefined

const data=await parseCodexSessionContentStreaming(validatedLines(),()=>new Promise<void>(resolve=>setImmediate(resolve)),recordSelection?{recordSelection}:undefined)
if(sessionMetaCount===0)throw new Error('missing session_meta')

// Only ai-tool-use messages qualify: tool-result messages come from
// function_call_output/custom_tool_call_output delivery records and are excluded even when they
// carry the same turn id (those records legitimately classify under the selection above).
const output=turn
  ? {source:'codex' as const,turn,pendingTail,messages:data.messages.filter(message=>message.kind==='ai-tool-use')}
  : {...data,pendingTail}
await writeFile(target+'.tmp',JSON.stringify(output),{mode:0o600})
await rename(target+'.tmp',target)
