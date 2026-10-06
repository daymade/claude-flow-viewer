import type { SessionData, SessionMessage, PromptIndexEntry, EmbeddedImage } from '../../types/session'
import { detectDecision } from '../decision-detector'
import {computeHeatmap} from '../heatmap'

export interface NativeConversationRecord {
  id: string
  ordinal: number
  timestamp?: string | null
  item: Record<string, unknown>
}
function display(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(display).join('\n')
  if (value && typeof value === 'object' && 'text' in value) return String(value.text)
  return value == null ? '' : JSON.stringify(value, null, 2)
}
/** Native item projection is distinct from rollout JSONL. Preserve unsupported items as inspectable tool records. */
export function parseCodexNativeRecords(records: NativeConversationRecord[]): SessionData {
  const messages: SessionMessage[] = [], prompts: PromptIndexEntry[] = []
  let count = 0
  for (const record of records) {
    const item = record.item, type = item.type
    const base = {sourceRecordId:record.id, ...(record.timestamp ? {timestamp:record.timestamp} : {})}
    if (type === 'userMessage') {
      const parts = Array.isArray(item.content) ? item.content : [item.content]
      const images: EmbeddedImage[] = []
      const text = parts.map(part => {
        if (part && typeof part === 'object' && ['image','input_image'].includes(part.type)) {
          const url = part.url ?? part.image_url
          if (typeof url === 'string' && url.startsWith('data:image/')) images.push({mediaType:url.slice(5,url.indexOf(';')),dataUrl:url})
          else return display(part)
          return ''
        }
        return display(part)
      }).filter(Boolean).join('\n')
      const promptNum=++count, decision=detectDecision(text,promptNum)
      const time=record.timestamp ? new Date(record.timestamp).toLocaleString(undefined,{hour12:false}) : 'Time not recorded'
      messages.push({...base,kind:'user-prompt',promptNum,text,images,time,decision})
      prompts.push({num:promptNum,preview:text.slice(0,100),fullText:text,time,decision,...(record.timestamp ? {timestamp:record.timestamp} : {})})
    } else if (type === 'agentMessage') {
      let text=display(item.text)
      if (Array.isArray(item.questions)) for (const question of item.questions) {
        if (!question || typeof question !== 'object') continue
        const title=display(question.title), options=Array.isArray(question.options) ? question.options : []
        if (!text.includes(title)) text+='\n\n'+title
        for (const option of options) {
          const label=typeof option === 'string' ? option : display(option.label ?? option.title)
          if (label && !text.includes(label)) text+='\n- '+label+(option.description ? ': '+display(option.description) : '')
        }
      }
      messages.push({...base,kind:'ai-text',text})
    } else if (type === 'reasoning') {
      const full=[display(item.content),display(item.summary)].filter(Boolean).join('\n')
      messages.push({...base,kind:'ai-thinking',preview:full.slice(0,120),full})
    } else if (type === 'commandExecution') {
      messages.push({...base,kind:'ai-tool-use',name:'commandExecution',summary:display(item.command).slice(0,100),input:{command:item.command}})
      messages.push({...base,kind:'tool-result',content:display(item.aggregatedOutput),isError:typeof item.exitCode === 'number' && item.exitCode!==0})
    } else if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
      const name=[item.server,item.tool ?? item.toolName ?? type].filter(Boolean).join('/')
      messages.push({...base,kind:'ai-tool-use',name,summary:name,input:{arguments:item.arguments}})
      const output=item.result ?? item.output ?? item.error
      messages.push({...base,kind:'tool-result',content:display(output),isError:Boolean(item.error)})
    } else {
      messages.push({...base,kind:'ai-tool-use',name:String(type ?? 'Native record'),summary:String(type ?? 'Native record'),input:item})
    }
  }
  return {source:'codex',messages,prompts,heatmap:computeHeatmap(messages),markers:{compacts:0,plans:0,clears:0,forks:0}}
}
