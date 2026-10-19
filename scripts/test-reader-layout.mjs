import {createServer} from 'node:http'
import {readFile,mkdir} from 'node:fs/promises'
import {resolve,extname,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import {chromium} from 'playwright'
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const root=resolve(process.argv[2]??resolve(project,'dist-reader/web'))
const out=process.argv[3]??resolve(tmpdir(),`reader-layout-${Date.now()}`)
await mkdir(out,{recursive:true})
const records=Array.from({length:40},(_,i)=>({kind:'flow-message',id:`synthetic-${i}`,message:i%2?{kind:'ai-text',text:`Response ${i}. This is a representative reading passage with enough text to exercise the body scroller.\n\nSecond paragraph for the same conversation.`}:{kind:'user-prompt',promptNum:i/2+1,text:`Question ${i}: explain the next step.`,images:[],time:'2026-10-19T00:00:00Z',decision:'none'}}))
const requests=[]
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost')
 if(url.pathname==='/api/layout-conversation'){
  requests.push(url.searchParams.get('offset'))
  res.setHeader('Content-Type','application/json')
  res.end(JSON.stringify({provider:'claude',session_id:'layout-fixture',records,total:120,offset:80,next_offset:120,has_earlier:true,has_later:false,read_at:'2026-10-19T00:00:00Z',boundary:'Synthetic layout fixture.'}));return
 }
 try{const file=resolve(root,'.'+url.pathname);assert(file.startsWith(root+'/'));const body=await readFile(file);res.setHeader('Content-Type',({'html':'text/html','js':'text/javascript','css':'text/css'})[extname(file).slice(1)]??'application/octet-stream');res.end(body)}catch{res.statusCode=404;res.end('not found')}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const address=server.address(),base=`http://127.0.0.1:${address.port}`
const browser=await chromium.launch({headless:true})
try{
 for(const [width,height]of[[338,493],[400,624],[1024,768]]){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1})
  const settle=()=>page.waitForFunction(()=>document.getAnimations().filter(a=>a.effect?.target?.checkVisibility()).every(a=>a.playState==='finished'))
  await page.goto(base+'/embed.html?'+new URLSearchParams({endpoint:'/api/layout-conversation',session:'layout-fixture',view:'conversation'}))
  await page.waitForSelector('[data-message-index="0"]')
  await page.evaluate(()=>document.fonts.ready)
  const geometry=await page.evaluate(()=>{
   const scroller=document.querySelector('[data-primary-scroll]'),r=scroller.getBoundingClientRect()
   const controls=[...document.querySelectorAll('.embed-history>summary,.embed-source>summary,.session-reader-toolbar>button')].filter(e=>e.getClientRects().length).map(e=>({label:e.textContent,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}))
   return{height:innerHeight,bodyHeight:r.height,ratio:r.height/innerHeight,bodyTop:r.top,bodyBottom:r.bottom,toolbarHeight:document.querySelector('.session-reader-toolbar').getBoundingClientRect().height,controlRows:new Set(controls.map(c=>Math.round(c.top))).size,statusVisible:document.querySelector('.embed-status').checkVisibility(),scrollTop:scroller.scrollTop,documentHeight:document.documentElement.scrollHeight,documentWidth:document.documentElement.scrollWidth,controls}
  })
  await settle()
  await page.screenshot({path:`${out}/${width}-default.png`})
  console.log({width,geometry})
  assert(geometry.ratio>=2/3,'reading body must occupy at least two thirds of the frame')
  assert.equal(geometry.controlRows,1,'default controls must share a single row')
  assert.equal(geometry.bodyTop,geometry.toolbarHeight,'no separate header band may precede the toolbar')
  assert.equal(geometry.bodyBottom,height,'no permanent footer band may displace the transcript')
  assert.equal(geometry.statusVisible,false,'loaded-range metadata belongs in its disclosure')
  assert.equal(geometry.documentHeight,height,'outer document must not scroll')
  assert.equal(geometry.documentWidth,width,'outer document must not overflow')
  assert(geometry.controls.every(e=>e.height>=44),'controls must retain touch target height')
  await page.locator('[data-primary-scroll]').hover()
  await page.mouse.wheel(0,-220)
  await page.waitForFunction(before=>document.querySelector('[data-primary-scroll]').scrollTop<before,geometry.scrollTop)
  await settle()
  await page.screenshot({path:`${out}/${width}-reading.png`})
  if(width<=640){
   await page.evaluate(()=>{window.originalReader=document.querySelector('[data-session-reader]');window.originalScroller=document.querySelector('[data-primary-scroll]')})
   await page.getByRole('button',{name:'Find',exact:true}).click()
   await page.getByLabel('Find in conversation').fill('Response')
   await page.getByRole('button',{name:'Next',exact:true}).click()
   await page.getByRole('button',{name:/^Find/}).click()
   await page.locator('[data-primary-scroll]').evaluate(e=>e.scrollTop=777)
   await page.getByRole('button',{name:'Filters',exact:true}).click()
   await page.getByRole('checkbox',{name:'Thinking',exact:true}).check()
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
   await page.locator('[data-primary-scroll]').evaluate(e=>e.scrollTop=777)
   const before=await page.locator('[data-primary-scroll]').evaluate(e=>e.scrollTop)
   const paragraphBefore=await page.locator('[data-primary-scroll]').evaluate(e=>{
    const top=e.getBoundingClientRect().top
    return [...e.querySelectorAll('[data-message-index] p')].find(p=>p.getBoundingClientRect().bottom>top)?.textContent
   })
   await settle()
  await page.screenshot({path:`${out}/${width}-filters.png`})
   await page.getByRole('button',{name:'Filters',exact:true}).click()
   await page.getByRole('button',{name:/^Find/}).click()
   await settle()
  await page.screenshot({path:`${out}/${width}-find.png`})
   assert.equal(await page.getByLabel('Find in conversation').inputValue(),'Response')
   await page.keyboard.press('Escape')
   await page.getByLabel('来源与读取边界').click()
   await page.waitForFunction(()=>document.querySelector('.embed-source').open)
   assert(await page.locator('.embed-status').isVisible())
   await settle()
   const sourcePainted=await page.locator('.embed-source-content').evaluate(e=>{
    const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)
    return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.contains(hit)
   })
   assert(sourcePainted,'source disclosure must be painted and reachable inside the viewport')
   await settle()
  await page.screenshot({path:`${out}/${width}-source.png`})
   await page.getByText('历史',{exact:true}).focus()
   await page.keyboard.press('Enter')
   await page.waitForFunction(()=>document.querySelector('.embed-history').open&&!document.querySelector('.embed-source').open)
   await page.getByRole('button',{name:/^Find/}).focus()
   await page.keyboard.press('Enter')
   await page.waitForFunction(()=>!document.querySelector('.embed-history').open)
   await page.keyboard.press('Escape')
   assert.equal(await page.getByLabel('Find in conversation').inputValue(),'Response','Escape must dismiss Find without the search input clearing itself')
   await page.getByRole('button',{name:'Filters',exact:true}).click()
   assert(await page.getByRole('checkbox',{name:'Thinking',exact:true}).isChecked())
   await page.keyboard.press('Escape')
   const retained=await page.evaluate(()=>({reader:window.originalReader===document.querySelector('[data-session-reader]'),scroller:window.originalScroller===document.querySelector('[data-primary-scroll]'),scrollTop:document.querySelector('[data-primary-scroll]').scrollTop}))
   assert(retained.reader&&retained.scroller);assert.equal(retained.scrollTop,before)
   const paragraphAfter=await page.locator('[data-primary-scroll]').evaluate(e=>{
    const top=e.getBoundingClientRect().top
    return [...e.querySelectorAll('[data-message-index] p')].find(p=>p.getBoundingClientRect().bottom>top)?.textContent
   })
   assert.equal(paragraphAfter,paragraphBefore,'closing controls must return to the same readable paragraph')
   await settle()
  await page.screenshot({path:`${out}/${width}-returned-paragraph.png`})
   await page.getByText('历史',{exact:true}).click()
   await settle()
  await page.screenshot({path:`${out}/${width}-history.png`})
   for(const name of['从头查看','加载更早的对话','继续查看','刷新到最新'])assert(await page.getByRole('button',{name,exact:true}).isVisible())
   await page.getByRole('button',{name:'加载更早的对话',exact:true}).click()
   await page.waitForFunction(()=>!document.querySelector('.embed-history').open)
   assert(requests.includes('0'))
   console.log({width,retained,historyEarlierReached:true})
  }else{
   assert(await page.getByLabel('Find in conversation').isVisible())
   await page.getByRole('button',{name:'Filters',exact:true}).click()
   assert(await page.getByRole('checkbox',{name:'Thinking',exact:true}).isVisible())
  }
  await page.close()
 }
}finally{await browser.close();await new Promise(r=>server.close(r))}
