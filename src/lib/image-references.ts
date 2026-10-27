import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import {normalizeConversationPage,type ConversationPage} from './reader-page'
import type {SessionMessage} from '../types/session'

const unsafe=(value:string,space=false)=>[...value].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127||space&&character===' ')
export type ImageReferenceKind='local'|'inline'|'remote'|'unsupported'
export function classifyImageReference(reference:unknown):ImageReferenceKind {
  if(typeof reference!=='string'||!reference.trim()||unsafe(reference))return 'unsupported'
  if(/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(reference))return 'inline'
  if(/^https?:\/\//i.test(reference)||reference.startsWith('//'))return 'remote'
  if(/^[a-z]:[\\/]/i.test(reference)||/^file:\/\//i.test(reference))return 'local'
  if(/^[a-z][a-z0-9+.-]*:/i.test(reference)||reference.startsWith('#')||reference.startsWith('?'))return 'unsupported'
  return 'local'
}

type MarkdownNode={type:string;url?:string;identifier?:string;children?:MarkdownNode[];data?:{hProperties?:Record<string,unknown>}}
const markdownParser=unified().use(remarkParse).use(remarkGfm)
function visitImages(tree:MarkdownNode,callback:(node:MarkdownNode,reference:string)=>void) {
  const definitions=new Map<string,string>()
  const visit=(node:MarkdownNode,fn:(node:MarkdownNode)=>void)=>{fn(node);node.children?.forEach(child=>visit(child,fn))}
  visit(tree,node=>{
    if(node.type==='definition'&&node.identifier&&node.url){
      const key=node.identifier.toUpperCase()
      if(!definitions.has(key))definitions.set(key,node.url)
    }
  })
  visit(tree,node=>{
    if(node.type==='image'&&node.url)callback(node,node.url)
    if(node.type==='imageReference'&&node.identifier){const reference=definitions.get(node.identifier.toUpperCase());if(reference)callback(node,reference)}
  })
}
/** Carry the original image reference through Markdown URI normalization. */
export function remarkImageReferences() {
  return (tree:MarkdownNode)=>visitImages(tree,(node,reference)=>{
    node.data={...node.data,hProperties:{...node.data?.hProperties,'data-image-reference':reference}}
  })
}
export function imageReferencesForMessage(message:SessionMessage):string[] {
  const references=new Set<string>()
  const add=(value:unknown)=>{if(classifyImageReference(value)==='local')references.add(value as string)}
  if(message.kind==='ai-text'||message.kind==='user-prompt'){
    if(typeof message.text!=='string')throw new Error('Image reference message has no text')
    visitImages(markdownParser.parse(message.text) as MarkdownNode,(_node,reference)=>add(reference))
    if(message.kind==='user-prompt')message.images?.forEach(image=>add(image.reference))
  }
  return [...references]
}

export function conversationImageReferences(page:ConversationPage):{version:1;records:Array<{id:string;references:string[]}>} {
  if(!page||!Array.isArray(page.records)||typeof page.session_id!=='string'||!page.session_id)throw new Error('An exact conversation page is required')
  normalizeConversationPage(page)
  const ids=new Set<string>()
  return {version:1,records:page.records.map(record=>{
    if(typeof record.id!=='string'||!record.id||ids.has(record.id))throw new Error('Image reference page record IDs must be unique')
    ids.add(record.id)
    const messages=normalizeConversationPage({...page,records:[record]}).messages
    return {id:record.id,references:[...new Set(messages.flatMap(imageReferencesForMessage))]}
  })}
}

export const IMAGE_REASONS={
  image_missing:'原记录引用的图片已不存在',
  image_not_physical:'图片不是可验证的普通文件',
  image_outside_scope:'图片不在当前来源可读取范围',
  image_too_large:'图片超过允许读取大小',
  image_not_supported:'该文件不是支持的图片',
  image_changed:'图片已变化，请重新读取原记录',
  image_source_unavailable:'图片来源暂不可读取',
} as const
export type ImageFailureReason=keyof typeof IMAGE_REASONS
export type ImageResource={state:'readable';url:string;scope:string;source:'current-file';observed_at:string}|{state:'unavailable';reason:ImageFailureReason;scope:string}
export interface ConversationImageResources {
  version:1;session_id:string;revision:string;identity:ConversationPage['identity']|null
  entries:Array<{recordId:string;reference:string;state?:'readable';url:string;source:'current-file';observed_at:string}|{recordId:string;reference:string;state:'unavailable';reason:ImageFailureReason}>
}
function identityKey(identity:ConversationPage['identity']|null|undefined):string|null {
  if(identity==null)return 'null'
  const keys=['node','provider','session_id','manifest_sha256','source_path']
  if(Object.keys(identity).some(key=>!keys.includes(key))||['node','provider','session_id'].some(key=>typeof identity[key as keyof typeof identity]!=='string'||!identity[key as keyof typeof identity]))return null
  return JSON.stringify(keys.map(key=>identity[key as keyof typeof identity]??null))
}
export function resolveConversationImage(page:ConversationPage,reference:string,sourceRecordId:string,apiPrefix:string):ImageResource|null {
  if(classifyImageReference(reference)!=='local')return null
  const packet=page.imageResources
  if(!packet||packet.version!==1||packet.session_id!==page.session_id||!page.revision||packet.revision!==page.revision
    ||!Object.hasOwn(packet,'identity')||!Array.isArray(packet.entries))return null
  const identity=identityKey(page.identity)
  if(identity===null||identity!==identityKey(packet.identity))return null
  if(page.identity&&(page.identity.session_id!==page.session_id||page.identity.provider!==page.provider))return null
  const owners=page.records.filter(record=>record.id===sourceRecordId||'message'in record&&record.message.sourceRecordId===sourceRecordId)
  if(owners.length!==1)return null
  const owner=owners[0]
  const references=conversationImageReferences({...page,records:[owner]}).records[0].references
  if(!references.includes(reference))return null
  const entries=packet.entries.filter(entry=>entry?.recordId===owner.id&&entry.reference===reference)
  if(entries.length!==1)return null
  const entry=entries[0],scope=JSON.stringify([page.session_id,page.revision,identity,owner.id,reference])
  if(entry.state==='unavailable')return Object.hasOwn(IMAGE_REASONS,entry.reason)?{state:'unavailable',reason:entry.reason,scope}:null
  if(entry.state!=null&&entry.state!=='readable')return null
  if(entry.source!=='current-file'||typeof entry.observed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(entry.observed_at)||!Number.isFinite(Date.parse(entry.observed_at)))return null
  const url=entry.url
  if(typeof url!=='string'||!/^\/(?!\/)(?:[a-z0-9_-]+\/)*api\/$/i.test(apiPrefix)||!url.startsWith(apiPrefix)||/[?#\\]/.test(url)||unsafe(url,true))return null
  try{const decoded=decodeURIComponent(url);if(decoded.includes('\\')||unsafe(decoded,true)||decoded.split('/').some(part=>part==='.'||part==='..'))return null}catch{return null}
  return {state:'readable',url,scope,source:entry.source,observed_at:entry.observed_at}
}

export function mergeConversationImageResources(previous:ConversationPage,next:ConversationPage):ConversationImageResources|undefined {
  const a=previous.imageResources,b=next.imageResources
  if(!a||!b||a.version!==1||b.version!==1||a.session_id!==b.session_id||a.revision!==b.revision||identityKey(a.identity)!==identityKey(b.identity))return b
  const entries=[...new Map([...a.entries,...b.entries].map(entry=>[JSON.stringify(entry),entry])).values()]
  return {...b,entries}
}
