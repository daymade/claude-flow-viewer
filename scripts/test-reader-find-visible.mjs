import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,mkdir} from 'node:fs/promises'
import {resolve,dirname,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {chromium} from 'playwright'
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const root=resolve(process.argv[2]??resolve(project,'dist-reader/web'))
const out=process.argv[3]??resolve(tmpdir(),`reader-find-${Date.now()}`)
await mkdir(out,{recursive:true})
const padding=Array.from({length:100},(_,i)=>`Unrelated line ${i}`).join('\n')
const command='cat /synthetic/worker-continuity/input.txt'
const nativeRecord=process.env.READER_FIND_NATIVE_RECORD
 ? JSON.parse(await readFile(process.env.READER_FIND_NATIVE_RECORD,'utf8'))
 : {type:'commandExecution',padding,command,commandActions:[{command,path:'/synthetic/worker-continuity/input.txt'}]}
const records=[
 {kind:'flow-message',id:'prose',message:{kind:'ai-text',text:'Worker visible conversation text.'}},
 {kind:'flow-message',id:'native-result',message:{kind:'tool-result',content:'Process exited with code 0',isError:false,sourceRecord:nativeRecord}},
 {kind:'flow-message',id:'result-body',message:{kind:'tool-result',content:`${padding}\nWorker result body match.`,isError:false}},
 {kind:'flow-message',id:'thinking-body',message:{kind:'ai-thinking',preview:'Reasoning preview',full:`${padding}\nWorker thinking body match.`}},
]
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost')
 if(url.pathname==='/api/find-conversation'){
  res.setHeader('Content-Type','application/json')
  res.end(JSON.stringify({provider:'claude',session_id:'find-fixture',records,total:records.length,offset:0,next_offset:records.length,has_earlier:false,has_later:false,read_at:'2026-10-19T00:00:00Z',boundary:'Synthetic Find fixture.'}));return
 }
 try{const path=resolve(root,'.'+url.pathname);assert(path.startsWith(root+'/'));const body=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(path)]??'application/octet-stream');res.end(body)}catch{res.statusCode=404;res.end('not found')}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true})
try{
 for(const [width,height]of[[400,624],[338,493],[1024,768]]){
  const page=await browser.newPage({viewport:{width,height}})
  await page.goto(origin+'/embed.html?'+new URLSearchParams({endpoint:'/api/find-conversation',session:'find-fixture',view:'conversation'}))
  await page.waitForSelector('[data-session-reader]')
  await page.evaluate(()=>{window.reader=document.querySelector('[data-session-reader]');window.scroller=document.querySelector('[data-primary-scroll]')})
  if(width<=640)await page.getByRole('button',{name:'Find',exact:true}).click()
  await page.getByLabel('Find in conversation').fill('Worker')
  for(const index of[0,1,2,3]){
   if(index)await page.getByRole('button',{name:'Next',exact:true}).click()
   await page.waitForFunction(i=>document.querySelector(`[data-message-index="${i}"]`)?.className.includes('ring-1'),index)
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
   await page.waitForFunction(()=>document.getAnimations().filter(a=>a.effect?.target?.checkVisibility()).every(a=>a.playState==='finished'))
   const state=await page.evaluate(i=>{
    const wrapper=document.querySelector(`[data-message-index="${i}"]`),scroller=document.querySelector('[data-primary-scroll]'),viewport=scroller.getBoundingClientRect()
    const walker=document.createTreeWalker(wrapper,NodeFilter.SHOW_TEXT),matches=[]
    for(let node=walker.nextNode();node;node=walker.nextNode()){
     const offset=node.textContent.toLowerCase().indexOf('worker');if(offset<0)continue
     const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+6)
     const rect=range.getBoundingClientRect();let visible=rect.height>0&&rect.top>=viewport.top&&rect.bottom<=viewport.bottom
     for(let parent=node.parentElement;parent&&wrapper.contains(parent);parent=parent.parentElement){
      if(parent.tagName==='DETAILS'&&!parent.open)visible=false
      const box=parent.getBoundingClientRect(),style=getComputedStyle(parent)
      if(/auto|scroll|hidden/.test(style.overflowY)&&(rect.top<box.top||rect.bottom>box.bottom))visible=false
     }
     const x=Math.max(viewport.left,rect.left)+Math.min(rect.width,16)/2,y=rect.top+rect.height/2
     const hit=document.elementFromPoint(x,y)
     if(!hit||!wrapper.contains(hit))visible=false
     matches.push({visible,top:rect.top,bottom:rect.bottom,context:node.textContent.slice(Math.max(0,offset-30),offset+70)})
    }
    return{index:i,matches,details:[...wrapper.querySelectorAll('details')].map(d=>({summary:d.querySelector('summary')?.innerText,open:d.open})),query:document.querySelector('[aria-label="Find in conversation"]').value,readerRetained:window.reader===document.querySelector('[data-session-reader]'),scrollerRetained:window.scroller===scroller,outerHeight:document.documentElement.scrollHeight}
   },index)
   await page.screenshot({path:`${out}/${width}-hit-${index}.png`})
   const report=process.env.READER_FIND_NATIVE_RECORD ? {...state,matches:state.matches.map(({context,...match})=>({...match,contextPresent:Boolean(context)}))} : state
   console.log(JSON.stringify({width,...report}))
   assert(state.matches.some(m=>m.visible),`hit ${index} must expose matching text in the actual reader viewport`)
   assert.equal(state.query,'Worker');assert(state.readerRetained&&state.scrollerRetained);assert.equal(state.outerHeight,height)
  }
  await page.close()
 }
}finally{await browser.close();await new Promise(r=>server.close(r))}
