import {describe, expect, it} from 'vitest'
import {classifyUserInputContent as classify, classifyUserInputs} from '../user-input-classification'
import {parseCodexNativeRecords} from '../providers/codex-native'
import {parseCodexSessionContent} from '../codex-parser'

const reply = {answer:'Keep the current source', question:'Which source?', questionItemId:JSON.stringify(['request_user_input_async','call_fixture',0])}
const envelope = (value:unknown) => `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`
const internal = [
  '<peer-message protocol="1" from="codex:fixture">Coordination only.</peer-message>',
  '<codex_delegation><source_thread_id>fixture</source_thread_id><input>Coordination only.</input></codex_delegation>',
  '<codex_internal_context source="goal"><objective>Fixture objective</objective></codex_internal_context>',
  '<hook_prompt>Check fixture output.</hook_prompt>',
  'Message Type: NEW_TASK\nTask name: fixture\nSender: fixture\nPayload:\nCoordination only.',
  'Message Type: MESSAGE\nTask name: fixture\nPayload: Coordination only.',
]
const bootstrap = [
  '# AGENTS.md instructions for /synthetic/work',
  '# AGENTS.md instructions for /synthetic/work\n<INSTRUCTIONS>Fixture rules</INSTRUCTIONS>\n<environment_context>Fixture context</environment_context>',
  '<skill><name>fixture</name></skill>',
  '<permissions instructions>Fixture rules</permissions>',
]

describe('shared user input content interpretation', () => {
  it('keeps ordinary, short, quoted and explained messages', () => {
    for (const text of ['继续', '好', 'Please continue.', 'Explain <peer-message> tags.', '`<hook_prompt>`', '> <peer-message>Quoted</peer-message>\nExplain it.', '{"answer":"example","question":"example"}', envelope(reply)+'\nExplain this format.', ...internal.filter(t=>t.startsWith('<')).map(t=>t+'\nPlease explain this example.'), '<custom>Application input</custom>', '<environment_context>example</environment_context>\nExplain it.']) {
      expect(classify(text), text).toEqual({kind:'ordinary', reason:'text'})
    }
  })
  it('recognizes complete actual transport shapes with synthetic values', () => {
    for (const text of internal) expect(classify(text).kind, text).toBe('internal')
    for (const text of bootstrap) expect(classify(text), text).toEqual({kind:'internal', reason:'bootstrap'})
    for (const value of [[reply], reply, [{questionItemId:reply.questionItemId, question:reply.question, answer:reply.answer}], [{...reply,answer:''}]]) expect(classify(envelope(value))).toEqual({kind:'control',reason:'question-reply'})
    expect(classify('# Context from my IDE setup:\nFile: fixture\n## My request for Codex:\n'+envelope([reply])).kind).toBe('control')
  })
  it('keeps absent, empty, malformed controls and unsupported content explicitly unknown', () => {
    for (const value of [undefined,null]) expect(classify(value)).toEqual({kind:'unknown',reason:'missing'})
    for (const value of ['', ' \n', [], [{type:'skill',name:'fixture'}]]) expect(classify(value)).toEqual({kind:'unknown',reason:'empty'})
    for (const value of [1, {}, [null], [{type:'text',text:4}], [{type:'unfamiliar',text:'unverified'}], [{type:'image'}], [{text:'ordinary'},null]]) expect(classify(value)).toEqual({kind:'unknown',reason:'malformed'})
    for (const value of ['<hook_prompt>Incomplete', '<peer-message from="fixture">Incomplete', '<send_user_message_question_reply>Incomplete', 'Message Type: MESSAGE\nTask name: fixture', '<skill>Incomplete', '<environment_context>Incomplete', bootstrap[1]+'\n<permissions instructions>Incomplete']) expect(classify(value)).toEqual({kind:'unknown',reason:'malformed'})
    for (const value of [[], null, [{...reply,answer:null}], [{...reply,questionItemId:'not-json'}], [{...reply,questionItemId:'["request_user_input_async", "fixture", 0]'}], [{...reply,questionItemId:'["foreign","fixture",0]'}]]) expect(classify(envelope(value))).toEqual({kind:'unknown',reason:'malformed'})
  })
  it('recognizes canonical image-only input without loading an attachment', () => {
    for (const part of [{type:'image',url:'data:image/png;base64,AAAA'}, {type:'input_image',image_url:'https://example.invalid/fixture.png'}]) expect(classify([part])).toEqual({kind:'ordinary',reason:'attachment'})
    expect(classify([{type:'input_image',image_url:null}]).kind).toBe('unknown')
    expect(classify([{type:'text',text:internal[0]},{type:'image',url:'data:image/png;base64,AAAA'}]).kind).toBe('ordinary')
  })
  it('preserves batch IDs/order and rejects malformed or duplicate batches atomically', () => {
    expect(classifyUserInputs({version:1,inputs:[{id:'b',content:'继续'},{id:'a'}]})).toEqual({version:1,classifications:[{id:'b',kind:'ordinary',reason:'text'},{id:'a',kind:'unknown',reason:'missing'}]})
    for (const value of [null,{}, {version:1,inputs:null}, {version:2,inputs:[]}, {version:1,inputs:[{id:''}]}, {version:1,inputs:[{id:'same'},{id:'same'}]}]) expect(()=>classifyUserInputs(value)).toThrow()
  })
  it('uses one rule in raw and native projections without modifying source records', () => {
    for (const text of ['继续', ...internal, envelope([reply]), envelope([reply])+'\nExplain this.']) {
      const content = [{type:'text',text}]
      const item = {type:'userMessage',content}, record = {id:'native-fixture',ordinal:42,item}
      const before = structuredClone(record)
      const native = parseCodexNativeRecords([record]).messages.find(m=>m.kind==='user-prompt')!
      const rawRecord = {type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload:{type:'message',role:'user',content}}
      const raw = parseCodexSessionContent(JSON.stringify(rawRecord)).messages.find(m=>m.kind==='user-prompt')!
      expect(native.kind==='user-prompt' && native.inputClassification).toEqual(classify(content))
      expect(raw.kind==='user-prompt' && raw.inputClassification).toEqual(classify(content))
      expect(record).toEqual(before)
      expect(native.sourceRecord).toBe(item)
      expect(native.sourceRecordId).toBe('native-fixture')
      expect(raw.sourceRecord).toEqual(rawRecord)
    }
    const image = [{type:'input_image',image_url:'data:image/png;base64,AAAA'}]
    const native = parseCodexNativeRecords([{id:'image',ordinal:1,item:{type:'userMessage',content:image}}]).messages[0]
    const raw = parseCodexSessionContent(JSON.stringify({type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload:{type:'message',role:'user',content:image}})).messages[0]
    expect(native.kind==='user-prompt' && native.inputClassification).toEqual({kind:'ordinary',reason:'attachment'})
    expect(raw.kind==='user-prompt' && raw.inputClassification).toEqual({kind:'ordinary',reason:'attachment'})
  })
})
