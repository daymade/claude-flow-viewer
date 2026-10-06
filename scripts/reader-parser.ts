import {readFile,writeFile,rename} from 'node:fs/promises'
import {parseClaudeSessionContent} from '../src/lib/providers/claude'
const [source,target,session]=process.argv.slice(2)
if(!source||!target||!session)throw new Error('source, private cache target and exact session required')
const content=await readFile(source,'utf8'), lines=content.split('\n')
let pendingTail=false
for(let i=0;i<lines.length;i++){
  if(!lines[i].trim())continue
  try{const record=JSON.parse(lines[i]);if(record.sessionId&&record.sessionId!==session)throw new Error('session identity mismatch')}
  catch(error){
    if(error instanceof Error && error.message==='session identity mismatch')throw error
    if(i===lines.length-1&&!content.endsWith('\n')){lines[i]='';pendingTail=true}
    else throw new Error(`Malformed session record at line ${i+1}`)
  }
}
const data=parseClaudeSessionContent(lines.join('\n'))
await writeFile(target+'.tmp',JSON.stringify({...data,pendingTail}),{mode:0o600})
await rename(target+'.tmp',target)
