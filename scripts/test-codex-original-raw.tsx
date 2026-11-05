import assert from 'node:assert/strict'
import test from 'node:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {SourceRecordDetails} from '../src/components/session/SessionView'
import {ToolCallLine} from '../src/components/session/MessageRenderers'
import type {SessionMessage} from '../src/types/session'

test('original details render exact raw numeric lexemes and escape source text',()=>{
  const raw='{"ordinal":1,"payload":{"n":9007199254740993,"f":1.0,"z":-0.0,"text":"</pre><script>bad</script>"}}\r\n'
  const html=renderToStaticMarkup(<SourceRecordDetails msg={{kind:'ai-text',text:'example',sourceRecord:JSON.parse(raw),sourceRecordRaw:raw}} forceMount/>)
  assert.ok(html.includes('9007199254740993'));assert.ok(!html.includes('9007199254740992'))
  assert.ok(html.includes('1.0'));assert.ok(html.includes('-0.0'))
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'))
})

test('original details retain the legacy object fallback',()=>{
  const html=renderToStaticMarkup(<SourceRecordDetails msg={{kind:'ai-text',text:'legacy',sourceRecord:{value:'old source'}}} forceMount/>)
  assert.ok(html.includes('old source'))
})

test('tool Input preserves original arguments instead of displaying rounded derived input',()=>{
  const argumentsRaw='{"n":9007199254740993,"float":1.0,"text":"<unsafe>"}'
  const msg:Extract<SessionMessage,{kind:'ai-tool-use'}>={kind:'ai-tool-use',name:'example_tool',summary:'call',input:JSON.parse(argumentsRaw),sourceRecord:{type:'response_item',payload:{type:'function_call',arguments:argumentsRaw}}}
  const html=renderToStaticMarkup(<ToolCallLine msg={msg} forceMount/>)
  assert.ok(html.includes('9007199254740993'));assert.ok(!html.includes('9007199254740992'))
  assert.ok(html.includes('1.0'));assert.ok(html.includes('&lt;unsafe&gt;'))
})

test('ordinary tool Input preserves the existing raw field behavior',()=>{
  const msg:Extract<SessionMessage,{kind:'ai-tool-use'}>={kind:'ai-tool-use',name:'example_tool',summary:'call',input:{raw:'line one\nline two'}}
  const html=renderToStaticMarkup(<ToolCallLine msg={msg} forceMount/>)
  assert.ok(html.includes('line one\nline two'))
})
