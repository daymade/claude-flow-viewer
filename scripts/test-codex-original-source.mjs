import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {appendFile,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {decodeStrictOriginalRecord,MAX_ORIGINAL_RECORD_BYTES,readStrictCodexOriginalWindow} from '../dist-reader/server/codex-original-source.mjs'

const root=dirname(dirname(fileURLToPath(import.meta.url)))
const compiled=await build({absWorkingDir:root,entryPoints:['src/lib/codex-parser.ts'],bundle:true,platform:'node',format:'esm',target:'node22',write:false})
const {parseCodexSessionContent}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const sid='11111111-2222-3333-4444-555555555555',cwd='/fixture'
const header={ordinal:0,type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id:sid,cwd,history_mode:'paginated'}}
const message={ordinal:1,type:'response_item',timestamp:'2026-01-01T00:00:01Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'exact input'}]}}
const encode=rows=>Buffer.from(rows.map(row=>typeof row==='string'?row:JSON.stringify(row)).join('\n')+'\n')

async function read(data,{mutate,onYield=async()=>{},offset=-1,limit=80,bound=null,clockTrace=null}={}) {
  const directory=await mkdtemp(join(tmpdir(),'strict-codex-original-'))
  try {
    const path=join(directory,'rollout.jsonl');await writeFile(path,data)
    const info=await stat(path,{bigint:true})
    const request={version:1,source:{path,end_byte_offset:data.length,sha256:createHash('sha256').update(data).digest('hex'),file_identity:{dev:String(info.dev),ino:String(info.ino),uid:String(info.uid)}},session_id:sid,cwd,offset,limit,bound,clock_trace:clockTrace}
    if(mutate)await mutate(request,path)
    return await readStrictCodexOriginalWindow(request,()=>onYield(request,path))
  } finally {await rm(directory,{recursive:true,force:true})}
}

const canonicalRows=[
  header,message,
  {ordinal:2,type:'response_item',timestamp:'2026-01-01T00:00:02Z',payload:{type:'function_call',name:'exec_command',call_id:'call-one',arguments:'{"cmd":"pwd"}'}},
  {ordinal:3,type:'response_item',timestamp:'2026-01-01T00:00:03Z',payload:{type:'function_call_output',call_id:'call-one',output:'/exact/path\n'}},
  {ordinal:4,type:'event_msg',timestamp:'2026-01-01T00:00:04Z',payload:{type:'mcp_tool_call_end',id:'paired',invocation:{server:'synthetic',tool:'read',arguments:{path:'/exact'}},result:{content:[{type:'text',text:'paired result'}]}}},
  {ordinal:5,type:'response_item',timestamp:'2026-01-01T00:00:05Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'exact answer'}]}},
]
const publicMessage=message=>{const copy={...message};delete copy.sourceRecord;delete copy.sourceRecordRaw;return copy}

test('complete strict page uses the common classifier and preserves multi-output records',async()=>{
  const bytes=encode(canonicalRows),result=await read(bytes),expected=parseCodexSessionContent(bytes.toString('utf8'))
  assert.equal(result.certificate.complete,true)
  assert.equal(result.certificate.record_count,canonicalRows.length)
  assert.equal(result.certificate.bytes,bytes.length)
  assert.equal(result.certificate.sha256,createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.total,expected.messages.length)
  assert.ok(result.total>canonicalRows.length-1,'the MCP end record must emit both call and result')
  assert.deepEqual(result.records.map(row=>publicMessage(row.message)),expected.messages.map(publicMessage))
  for(const row of result.records){
    assert.equal(row.raw_line,JSON.stringify(canonicalRows[row.source_index])+'\n')
    assert.equal(row.source_ordinal,row.source_index)
    assert.equal(Buffer.byteLength(row.raw_line),row.byte_end-row.byte_start)
  }
  assert.equal(result.records.filter(row=>row.source_index===4).length,2)
})

test('strict windows compose without omissions or duplicates',async()=>{
  const bytes=encode(canonicalRows),complete=await read(bytes),paged=[]
  for(let offset=0;offset<complete.total;offset+=2){
    const page=await read(bytes,{offset,limit:2})
    assert.equal(page.offset,offset);paged.push(...page.records)
  }
  assert.deepEqual(paged.map(row=>publicMessage(row.message)),complete.records.map(row=>publicMessage(row.message)))
  assert.deepEqual(paged.map(row=>row.raw_line),complete.records.map(row=>row.raw_line))
})

test('CRLF and ASCII blank lines preserve the consumed raw bytes',async()=>{
  const bytes=Buffer.from(JSON.stringify(header)+'\r\n\t \v\f\r\n'+JSON.stringify(message)+'\r\n')
  const result=await read(bytes)
  assert.equal(result.record_count,2)
  assert.equal(result.records[0].raw_line,JSON.stringify(message)+'\r\n')
  assert.equal(result.certificate.sha256,createHash('sha256').update(bytes).digest('hex'))
})

test('strict reader rejects malformed tails, fatal UTF8, split cuts and hash drift',async t=>{
  const good=encode([header,message])
  const cases=[
    ['completed malformed off-page tail',encode([header,message,'{bad}'])],
    ['off-page nonfinite number',encode([header,message,'{"ordinal":2,"type":"event_msg","payload":{},"n":1e400}'])],
    ['unterminated tail',good.subarray(0,-1)],
    ['fatal UTF8',Buffer.concat([encode([header]),Buffer.from([0xff,10])])],
    ['BOM',Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),good])],
    ['Unicode blank line',encode([header,'\u00a0',message])],
  ]
  for(const [name,data] of cases)await t.test(name,()=>assert.rejects(read(data,{offset:0,limit:1})))
  await t.test('split cut',()=>assert.rejects(read(good,{mutate:request=>{request.source.end_byte_offset-=1}})))
  await t.test('consumed hash differs',()=>assert.rejects(read(good,{mutate:request=>{request.source.sha256='0'.repeat(64)}})))
})

test('strict validation rejects identity, metadata, ancestry and ordinal damage',async t=>{
  const line=value=>Buffer.from((typeof value==='string'?value:JSON.stringify(value))+'\n')
  const bad=[
    ['duplicate metadata',{...header,ordinal:1},1],
    ['foreign session',{...header,payload:{...header.payload,id:'00000000-0000-0000-0000-000000000000'}},0],
    ['foreign cwd',{...header,payload:{...header.payload,cwd:'/foreign'}},0],
    ['ordinal gap',message,2],
    ['ordinal decimal',JSON.stringify(message).replace('"ordinal":1','"ordinal":1.0'),1],
    ['ordinal exponent',JSON.stringify(message).replace('"ordinal":1','"ordinal":1e0'),1],
    ['overflow float',JSON.stringify(message).replace('"payload":{','"probe":1e400,"payload":{'),1],
    ['non-object payload',{ordinal:1,type:'response_item',payload:null},1],
  ]
  for(const key of ['history_base','forked_from_id','parent_thread_id','subagent_history_start_ordinal'])bad.push([key+' null',{...header,payload:{...header.payload,[key]:null}},0])
  for(const [name,value,index] of bad)await t.test(name,()=>assert.throws(()=>decodeStrictOriginalRecord(line(value),index,sid,cwd)))
  assert.ok(decodeStrictOriginalRecord(line(header),0,sid,cwd))
})

test('large integer lexemes remain readable through exact raw lines',()=>{
  const digits='9'.repeat(400)
  const raw=JSON.stringify(message).replace('"payload":{','"probe":'+digits+',"payload":{')+'\n'
  assert.equal(decodeStrictOriginalRecord(Buffer.from(raw),1,sid,cwd).rawLine,raw)
})

test('record type whitespace matches Python boundaries without treating BOM as blank',()=>{
  const points=[9,10,11,12,13,28,29,30,31,32,0x85,0xa0,0x1680,
    ...Array.from({length:11},(_,index)=>0x2000+index),0x2028,0x2029,0x202f,0x205f,0x3000]
  const whitespace=new Set(points)
  const decodeType=type=>decodeStrictOriginalRecord(Buffer.from(JSON.stringify({...message,type})+'\n'),1,sid,cwd)
  assert.throws(()=>decodeType(''))
  assert.throws(()=>decodeType(points.map(code=>String.fromCodePoint(code)).join('')))
  for(const code of points)assert.throws(()=>decodeType(String.fromCodePoint(code)),String(code))
  const neighbors=new Set(points.flatMap(code=>[code-1,code+1]).filter(code=>!whitespace.has(code)))
  for(const code of [...neighbors,0xfeff,0x180e])assert.ok(decodeType(String.fromCodePoint(code)),String(code))
  assert.ok(decodeType('\u001c event_msg\u0085'))
  assert.ok(decodeType(' \ufeff\t'))
})

test('64MiB record limit includes LF and CR and rejects one extra byte',()=>{
  const prefix=JSON.stringify(header),exact=Buffer.alloc(MAX_ORIGINAL_RECORD_BYTES,32)
  exact.write(prefix);exact[exact.length-2]=13;exact[exact.length-1]=10
  assert.ok(decodeStrictOriginalRecord(exact,0,sid,cwd))
  const tooLarge=Buffer.alloc(MAX_ORIGINAL_RECORD_BYTES+1,32)
  tooLarge.write(prefix);tooLarge[tooLarge.length-1]=10
  assert.throws(()=>decodeStrictOriginalRecord(tooLarge,0,sid,cwd),/byte safety limit/)
})

test('same bytes reopened under another inode fail the FD witness',async()=>{
  await assert.rejects(read(encode([header,message]),{mutate:async(_request,path)=>{
    await writeFile(path+'.new',await readFile(path));await rename(path+'.new',path)
  }}),/identity/)
})

test('append beyond a frozen cut does not change the validated page',async()=>{
  const bytes=encode([header,message]),first=await read(bytes)
  const appended=await read(bytes,{mutate:async(_request,path)=>appendFile(path,'{unfinished tail outside frozen cut')})
  assert.deepEqual(appended.records,first.records)
  assert.equal(appended.certificate.sha256,first.certificate.sha256)
})

test('consumed content ABA is rejected even after the original path bytes are restored',async()=>{
  const rows=[header,message]
  for(let ordinal=2;ordinal<=3001;ordinal++)rows.push({ordinal,type:'event_msg',payload:{type:'unclassified',padding:'unchanged'}})
  const bytes=encode(rows),changed=Buffer.from(bytes.toString().replace('exact input','other input'))
  let restored=false
  assert.equal(changed.length,bytes.length)
  await assert.rejects(read(bytes,{offset:0,limit:1,
    mutate:async(_request,path)=>writeFile(path,changed),
    onYield:async(_request,path)=>{if(!restored){await writeFile(path,bytes);restored=true}},
  }),/consumed prefix changed/)
  assert.equal(restored,true,'restore occurred during the actual shared classifier scan')
})
