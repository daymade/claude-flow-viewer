import {useEffect,useState} from 'react'
import {useSessionResources} from './SessionResources'
import {classifyImageReference,IMAGE_REASONS,type ImageFailureReason} from '../../lib/image-references'

function failureText(value:unknown):string|null {
  if(typeof value==='string'&&Object.hasOwn(IMAGE_REASONS,value))return IMAGE_REASONS[value as ImageFailureReason]
  return null
}
export function SessionImage({reference,sourceRecordId,alt='',title,className}:{reference:string;sourceRecordId?:string;alt?:string;title?:string;className?:string}) {
  const resources=useSessionResources()
  const kind=classifyImageReference(reference)
  const resource=kind==='local'&&sourceRecordId&&resources&&typeof resources!=='function' ? resources.resolveImage?.(reference,sourceRecordId)??null : null
  const key=resource?.state==='readable'?JSON.stringify([resource.scope,resource.url]):null
  const url=resource?.state==='readable'?resource.url:null
  const [loaded,setLoaded]=useState<{key:string;ticket:object;url?:string;error?:string}|null>(null)
  const [generation,setGeneration]=useState({key,ticket:{}})
  if(generation.key!==key)setGeneration({key,ticket:{}})
  const ticket=generation.ticket
  useEffect(()=>{
    if(!url||!key)return
    const controller=new AbortController()
    let active=true,objectUrl:string|null=null
    void (async()=>{
      try{
        const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:controller.signal})
        if(!response.ok){
          let detail:unknown=null
          try{const body=await response.json();detail=body.detail}catch{/* The HTTP status remains a concrete failure. */}
          throw new Error(failureText(detail)??`图片读取失败（HTTP ${response.status}）`)
        }
        const blob=await response.blob()
        if(!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(blob.type)||!blob.size)throw new Error('来源未返回有效图片')
        if(!active)return
        objectUrl=URL.createObjectURL(blob)
        setLoaded({key,ticket,url:objectUrl})
      }catch(error){if(active)setLoaded({key,ticket,error:error instanceof Error?error.message:'图片读取失败'})}
    })()
    return()=>{active=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[url,key,ticket])
  const current=loaded?.key===key&&loaded.ticket===ticket?loaded:null
  const label=alt||'原记录图片'
  if(kind==='remote'||kind==='inline')return <img className={className} src={reference} alt={alt} title={title}/>
  let notice=kind==='unsupported'?'图片引用格式不受支持':'本地图片未绑定预览'
  if(resource?.state==='unavailable')notice=IMAGE_REASONS[resource.reason]
  else if(key)notice=current?.error?current.error:'正在读取原记录图片…'
  if(key&&current?.url)return <span className="inline-flex max-w-full flex-col"><img className={className} src={current.url} alt={alt} title={title} onError={()=>setLoaded({key,ticket:current.ticket,error:'来源图片无法解码'})}/><span className="text-xs text-stone-500" title={resource?.state==='readable'?resource.observed_at:undefined}>当前源文件</span></span>
  return <span role="status" data-image-reference={reference}>{label}：{notice}</span>
}
