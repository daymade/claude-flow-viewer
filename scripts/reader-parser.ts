import {readFile,writeFile,rename} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {parseClaudeSessionWithState,continueClaudeSessionWithState} from '../src/lib/providers/claude'

// reader-parser <source> <target> <session> [statePath previousPath parserSha]
// Without the optional trio: full parse, no state (the original contract).
// With them: continue from the previous snapshot when the source only appended
// complete lines on the active conversation path. Any doubt — hash mismatch,
// stale or foreign state, a fork from frozen history — falls back to a full
// parse, so the published output is always exactly what a full parse produces.
const [source,target,session,statePath,previousPath,parserSha]=process.argv.slice(2)
if(!source||!target||!session)throw new Error('source, private cache target and exact session required')
const content=await readFile(source,'utf8')
const allowPartialTail=!content.endsWith('\n')

// Strict per-line validation: every record must parse and carry this session's
// identity when it declares one. A malformed final line is allowed only as a
// partial tail (file not newline-terminated) and is reported, never parsed.
function validateRecords(text:string,lineBase:number):boolean{
  const lines=text.split('\n')
  let pendingTail=false
  for(let i=0;i<lines.length;i++){
    if(!lines[i].trim())continue
    try{const record=JSON.parse(lines[i]);if(record.sessionId&&record.sessionId!==session)throw new Error('session identity mismatch')}
    catch(error){
      if(error instanceof Error && error.message==='session identity mismatch')throw error
      if(i===lines.length-1&&allowPartialTail){pendingTail=true}
      else throw new Error(`Malformed session record at line ${lineBase+i+1}`)
    }
  }
  return pendingTail
}

const sha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')

let outcome:{data:Record<string,unknown>,state:Record<string,unknown>}|null=null
let pendingTail=false
let mode='full'
if(statePath&&previousPath&&parserSha){
  try{
    const state=JSON.parse(await readFile(statePath,'utf8'))
    const previous=JSON.parse(await readFile(previousPath,'utf8'))
    if(state?.version===1&&state.parserSha===parserSha
      &&typeof state.consumedLength==='number'&&content.length>state.consumedLength
      &&sha256(content.slice(0,state.consumedLength))===state.prefixSha256){
      pendingTail=validateRecords(content.slice(state.consumedLength),0)
      outcome=continueClaudeSessionWithState(content,previous,state) as typeof outcome
      mode=outcome?'incremental':'full(fork-or-history-fallback)'
    }
  }catch{outcome=null}
}
if(!outcome){
  pendingTail=validateRecords(content,0)
  outcome=parseClaudeSessionWithState(content,parserSha??'') as typeof outcome
}
const {data,state}=outcome as NonNullable<typeof outcome>
if(statePath)process.stderr.write(`reader-parser: ${mode}\n`)
await writeFile(target+'.tmp',JSON.stringify({...data,pendingTail}),{mode:0o600})
await rename(target+'.tmp',target)
if(statePath){
  // State is stamped after the output rename: a crash between the two leaves an
  // older state beside a newer snapshot, which the next continuation still
  // handles correctly (frozen output is immutable, it just re-parses more).
  state.prefixSha256=sha256(content.slice(0,state.consumedLength as number))
  if(parserSha)state.parserSha=parserSha
  await writeFile(statePath+'.tmp',JSON.stringify(state),{mode:0o600})
  await rename(statePath+'.tmp',statePath)
}
