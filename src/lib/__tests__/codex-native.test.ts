import {describe,it,expect} from 'vitest'
import {parseCodexNativeRecords} from '../providers/codex-native'
describe('native selected-thread adapter',()=>{
  it('preserves question options, timestamps, full tool bodies and unfamiliar records',()=>{
    const stamp='2026-10-05T03:32:00Z', full='BODY-'.repeat(1500)+'TAIL'
    const result=parseCodexNativeRecords([
      {id:'u',ordinal:1,timestamp:stamp,item:{type:'userMessage',content:[{type:'text',text:'Continue the selected repository'}]}},
      {id:'a',ordinal:2,timestamp:stamp,item:{type:'agentMessage',text:'Please choose',questions:[{title:'Which result?',options:[{label:'Keep',description:'retain original'},{label:'Replace',description:'use new source'}]}]}},
      {id:'c',ordinal:3,timestamp:stamp,item:{type:'commandExecution',command:'read selected file',aggregatedOutput:full,exitCode:0}},
      {id:'r',ordinal:4,item:{type:'reasoning',content:[{text:full}]}},
      {id:'x',ordinal:5,item:{type:'newNativeKind',payload:full}},
    ])
    expect(result.prompts[0].timestamp).toBe(stamp)
    expect(result.messages.filter(m=>m.sourceRecordId==='a')[0]).toMatchObject({kind:'ai-text',text:expect.stringContaining('Keep: retain original')})
    expect(result.messages.filter(m=>m.kind==='tool-result')[0]).toMatchObject({content:full,sourceRecordId:'c'})
    expect(result.messages.filter(m=>m.kind==='ai-thinking')[0]).toMatchObject({full})
    expect(result.messages.at(-1)).toMatchObject({input:{payload:full}})
    expect(result.messages.at(-1)).not.toHaveProperty('timestamp')
  })
})
