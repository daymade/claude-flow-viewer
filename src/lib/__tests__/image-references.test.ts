import {expect,it} from 'vitest'
import {classifyImageReference,conversationImageReferences,imageReferencesForMessage,resolveConversationImage,mergeConversationImageResources} from '../image-references'
import type {ConversationPage} from '../reader-page'
const path='/synthetic/required-image.png'
const page=():ConversationPage=>({provider:'claude',session_id:'synthetic',revision:'rev-a',records:[{kind:'flow-message',id:'140',message:{kind:'ai-text',sourceRecordId:'raw-uuid',text:`![Required](${path})`}}],total:1,offset:140,next_offset:141,has_earlier:false,has_later:false,read_at:'2026-10-27',boundary:'fixture',imageResources:{version:1,session_id:'synthetic',revision:'rev-a',identity:null,entries:[{recordId:'140',reference:path,url:'/api/images/opaque',source:'current-file',observed_at:'2026-10-27T00:00:00Z'}]}})
it('uses real Markdown images and reference images, excluding ordinary links and code',()=>{
 const text='![one](/synthetic/one.png)\n![two][IMAGE]\n\n[image]: ./two.png\n\n`![fake](/synthetic/not-image.png)`\n[ordinary](/synthetic/not-image.png)\n![remote](https://example.com/image.png)'
 expect(imageReferencesForMessage({kind:'ai-text',text})).toEqual(['/synthetic/one.png','./two.png'])
 expect(classifyImageReference('javascript:alert(1)')).toBe('unsupported')
 expect(classifyImageReference('data:image/png;base64,AA==')).toBe('inline')
})
it('uses the official native adapter and retains local attachment refs',()=>{
 const native={...page(),provider:'codex' as const,records:[{id:'native-1',ordinal:1,item:{type:'userMessage',content:[{type:'localImage',path},{type:'local_image',path:'./relative.png'}]}}]}
 expect(conversationImageReferences(native)).toEqual({version:1,records:[{id:'native-1',references:[path,'./relative.png']}]})
 expect(()=>conversationImageReferences({...native,records:[native.records[0],native.records[0]]})).toThrow('unique')
})
it('resolves only the exact owner, reference, session, revision and identity packet',()=>{
 const p=page();expect(resolveConversationImage(p,path,'140','/api/')).toMatchObject({state:'readable',url:'/api/images/opaque',source:'current-file',observed_at:'2026-10-27T00:00:00Z'})
 const invalid=[{...p,imageResources:undefined},{...p,imageResources:{...p.imageResources!,session_id:'other'}},{...p,imageResources:{...p.imageResources!,revision:'other'}},{...p,identity:{node:'other',provider:'claude',session_id:'synthetic'}},{...p,imageResources:{...p.imageResources!,entries:[...p.imageResources!.entries,...p.imageResources!.entries]}}]
 for(const bad of invalid)expect(resolveConversationImage(bad,path,'140','/api/')).toBeNull()
 expect(resolveConversationImage(p,path,'wrong','/api/')).toBeNull()
 expect(resolveConversationImage(p,'/synthetic/not-in-record.png','140','/api/')).toBeNull()
 for(const url of ['https://example.com/image.png','//example.com/api/image','/api/../secret','/api/%2e%2e/secret','/api/image?path=arbitrary','/api/image#fragment']){
  p.imageResources!.entries=[{recordId:'140',reference:path,url,source:'current-file',observed_at:'2026-10-27T00:00:00Z'}]
  expect(resolveConversationImage(p,path,'140','/api/')).toBeNull()
 }
})
it('preserves a specific unavailable reason without creating a read URL',()=>{
 const p=page();p.imageResources!.entries=[{recordId:'140',reference:path,state:'unavailable',reason:'image_missing'}]
 expect(resolveConversationImage(p,path,'140','/api/')).toMatchObject({state:'unavailable',reason:'image_missing'})
})

it('preserves the first Markdown definition and the original reference through URI encoding',()=>{
 const text='![one][Straße]\n\n[STRASSE]: </synthetic/需查看 image.png>\n[STRASSE]: /synthetic/not-rendered.png'
 expect(imageReferencesForMessage({kind:'ai-text',text})).toEqual(['/synthetic/需查看 image.png'])
})
it('retains earlier image bindings only within the same frozen source identity',()=>{
 const first=page(),second=page()
 second.imageResources!.entries=[{recordId:'141',reference:'./second.png',url:'/api/images/two',source:'current-file',observed_at:'2026-10-27T00:00:00Z'}]
 expect(mergeConversationImageResources(first,second)?.entries).toHaveLength(2)
 second.imageResources!.revision='changed'
 expect(mergeConversationImageResources(first,second)?.entries).toHaveLength(1)
})
