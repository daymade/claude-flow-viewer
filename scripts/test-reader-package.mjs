import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionReader, classifyUserInputContent, classifyUserInputs, parseCodexNativeRecords, parseCodexSessionContent, parseClaudeSessionContent, buildClaudeSourceAnchors, normalizeConversationPage, resolveConversationAnchor, conversationImageReferences, resolveConversationImage, isConversationMessage, hydrateDeferredOriginalRecord} from '../dist-reader/reader.mjs';
import {spawnSync} from 'node:child_process';

const readerPackage=JSON.parse(readFileSync(new URL('../dist-reader/package.json',import.meta.url),'utf8'));
assert.equal(readerPackage.capabilities.deferredOriginalPayload,1);
assert.equal(readerPackage.exports['./codex-original-payload'],'./server/codex-original-payload.mjs');
assert.deepEqual(readerPackage.capabilities.originalContextWindowFocus,['latest-conversation']);
assert.equal(readerPackage.capabilities.strictCodexOriginalStream,1);
assert.equal(typeof (await import('../dist-reader/server/codex-original-source.mjs')).readStrictCodexOriginalWindow,'function');
assert.equal(isConversationMessage({kind:'user-prompt',text:''}),true);
assert.equal(isConversationMessage({kind:'ai-text',text:'Body'}),true);
assert.equal(isConversationMessage({kind:'ai-thinking',text:'Thought'}),false);
console.log('PASS built original-window capability and shared predicate export');

// Exercise the built public export without a global React namespace. Source
// component tests and the separately compiled iframe cannot catch this failure.
assert.equal(globalThis.React, undefined);
const data = {source:'claude', messages:[{kind:'ai-text',text:'Package API body'}], prompts:[], heatmap:[], markers:{compacts:0,plans:0,clears:0,forks:0}};
const html = renderToStaticMarkup(createElement(SessionReader, {data}));
assert.ok(html.includes('Package API body'), 'The built Reader export must render the supplied body');
assert.ok(!html.includes('data-empty-state'), 'A healthy body must not render empty guidance');
console.log('PASS built Reader export renders without a global React namespace');
assert.equal(classifyUserInputContent('继续').kind, 'ordinary');
const batch={version:1,inputs:[{id:'ordinary',content:'继续'},{id:'internal',content:'<hook_prompt>Fixture check.</hook_prompt>'},{id:'missing'},
  {id:'native-image',content:[{type:'localImage',path:'/synthetic/attachment.png',detail:null}]},
  {id:'rollout-image',content:[{type:'local_image',path:'/synthetic/attachment.png'}]},
  {id:'missing-image-path',content:[{type:'localImage'}]},
  {id:'runtime-image',content:[{type:'localImage',path:'/synthetic/attachment.png'},{type:'text',text:'<system>Fixture rules.</system>'}]}]};
assert.deepEqual(classifyUserInputs(batch).classifications.slice(3).map(({kind,reason})=>({kind,reason})),[
  {kind:'ordinary',reason:'attachment'},{kind:'ordinary',reason:'attachment'},
  {kind:'unknown',reason:'malformed'},{kind:'internal',reason:'bootstrap'}]);
for(const type of ['localImage','local_image']) {
  const content=[{type,path:'/synthetic/attachment.png'},{type:'text',text:'Describe this image.'}];
  const item={type:'userMessage',content},record={id:'local-image-fixture',ordinal:1,item};
  const native=parseCodexNativeRecords([record]).messages[0];
  const rawRecord={type:'response_item',payload:{type:'message',role:'user',content}};
  const raw=parseCodexSessionContent(JSON.stringify(rawRecord)).messages[0];
  for(const message of [native,raw]) assert.equal(message.text,'[Image]\nDescribe this image.');
  assert.equal(native.sourceRecord,item);
  assert.equal(native.sourceRecordId,record.id);
  assert.deepEqual(raw.sourceRecord,rawRecord);
}
const cli=spawnSync(process.execPath,['dist-reader/server/classify-user-inputs.mjs'],{input:JSON.stringify(batch),encoding:'utf8'});
assert.equal(cli.status,0,cli.stderr);
assert.deepEqual(JSON.parse(cli.stdout),classifyUserInputs(batch));
const invalid=spawnSync(process.execPath,['dist-reader/server/classify-user-inputs.mjs'],{input:JSON.stringify({version:1,inputs:[{id:'same'},{id:'same'}]}),encoding:'utf8'});
assert.notEqual(invalid.status,0);
assert.equal(invalid.stdout,'');
console.log('PASS built classification SDK and CLI preserve batch results and fail closed');

const sourceId='11111111-2222-3333-4444-555555555555';
const sourceContent=JSON.stringify({type:'assistant',uuid:sourceId,message:{role:'assistant',content:[{type:'text',text:'Record context'},{type:'tool_use',id:'tool-1',name:'Agent',input:{}}]}})+'\n';
const parsed=parseClaudeSessionContent(sourceContent);
const sourceAnchors=buildClaudeSourceAnchors(sourceContent,parsed.messages,'package-session');
const sourcePage={provider:'claude',session_id:'package-session',records:parsed.messages.map((message,index)=>({kind:'flow-message',id:String(index),message})),sourceAnchors};
assert.equal(resolveConversationAnchor(sourcePage,sourceId),0);
assert.equal(resolveConversationAnchor(sourcePage,'1'),1);
assert.equal(normalizeConversationPage(sourcePage).messages[0].sourceRecordId,'0');
assert.equal(buildClaudeSourceAnchors(sourceContent+sourceContent,parsed.messages,'package-session').entries.length,0);
console.log('PASS built source-anchor SDK preserves raw context and numeric file owners');

const imagePage={provider:'codex',session_id:'image-fixture',revision:'revision-a',records:[{id:'image-owner',ordinal:1,item:{type:'agentMessage',text:'![Required](/synthetic/required.png)'}}]};
const imageInput={version:1,page:imagePage};
const imageCli=spawnSync(process.execPath,['dist-reader/server/image-references.mjs'],{input:JSON.stringify(imageInput),encoding:'utf8'});
assert.equal(imageCli.status,0,imageCli.stderr);
assert.deepEqual(JSON.parse(imageCli.stdout),conversationImageReferences(imagePage));
assert.deepEqual(JSON.parse(imageCli.stdout).records,[{id:'image-owner',references:['/synthetic/required.png']}]);
imagePage.imageResources={version:1,session_id:'image-fixture',revision:'revision-a',identity:null,entries:[{recordId:'image-owner',reference:'/synthetic/required.png',source:'current-file',observed_at:'2026-10-27T00:00:00Z',url:'/api/images/opaque'}]};
assert.equal(resolveConversationImage(imagePage,'/synthetic/required.png','image-owner','/api/').url,'/api/images/opaque');
assert.equal(resolveConversationImage({...imagePage,session_id:'other'},'/synthetic/required.png','image-owner','/api/'),null);
const duplicateImage=spawnSync(process.execPath,['dist-reader/server/image-references.mjs'],{input:JSON.stringify({version:1,page:{...imagePage,records:[imagePage.records[0],imagePage.records[0]]}}),encoding:'utf8'});
assert.notEqual(duplicateImage.status,0);assert.equal(duplicateImage.stdout,'');
console.log('PASS built image-reference CLI and SDK share exact ownership and reject foreign or duplicate records');

const strictTests=spawnSync(process.execPath,['--test','scripts/test-codex-original-source.mjs','dist-reader/tests/codex-original-raw.test.mjs'],{encoding:'utf8'});
assert.equal(strictTests.status,0,strictTests.stdout+'\n'+strictTests.stderr);
console.log(strictTests.stdout);

const payloadOutput=[{type:'input_text',text:'Exact text\n'},{type:'input_image',image_url:'data:image/png;base64,AQIDBA==',detail:'high'}];
const payloadPage={provider:'codex',session_id:'payload-session',revision:'payload-revision',until:'original:1',offset:0,next_offset:1,total:1,has_earlier:false,has_later:false,read_at:'2026-11-08T00:00:00Z',boundary:'synthetic',identity:{node:'synthetic',provider:'codex',session_id:'payload-session',source_path:'/synthetic/source.jsonl'},records:[{kind:'flow-message',id:'original:0',source_session:'payload-session',source_ordinal:124,message:{kind:'tool-result',content:JSON.stringify(payloadOutput,null,2),isError:false,sourceRecord:{type:'response_item',ordinal:124,payload:{type:'custom_tool_call_output',output:payloadOutput}}}}]};
const payloadCli=request=>spawnSync(process.execPath,['dist-reader/server/codex-original-payload.mjs'],{input:JSON.stringify(request),encoding:'utf8',maxBuffer:4*1024*1024});
const payload=payloadCli({version:1,page:payloadPage,capability:1});
assert.equal(payload.status,0,payload.stderr);
const payloadResult=JSON.parse(payload.stdout).page;
assert.equal(normalizeConversationPage(payloadResult).messages[0].kind,'deferred-tool-result');
assert.equal(JSON.stringify(payloadResult).includes('base64,'),false);
assert.deepEqual(await hydrateDeferredOriginalRecord(payloadResult,payloadResult.records[0],payloadPage.records[0]),payloadPage.records[0]);
const oldPayload=payloadCli({version:1,page:payloadPage});
assert.equal(oldPayload.status,0,oldPayload.stderr);assert.deepEqual(JSON.parse(oldPayload.stdout).page,payloadPage);
const invalidPayload=payloadCli({version:1,page:payloadPage,capability:null});
assert.notEqual(invalidPayload.status,0);assert.equal(invalidPayload.stdout,'');
console.log('PASS built deferred-original producer, consumer and hydration agree; legacy input stays complete and malformed capability fails closed');

const unicodeText='ASCII/汉字/😀/e\u0301\n'.repeat(20000);
const unicodePage={...payloadPage,records:[{kind:'flow-message',id:'original:0',source_session:'payload-session',source_ordinal:124,message:{kind:'ai-text',text:unicodeText}}]};
assert.ok(Buffer.byteLength(JSON.stringify({version:1,page:unicodePage,capability:1}))>4*65536);
for(const capability of [1,undefined]){
 const unicodeResult=payloadCli({version:1,page:unicodePage,capability});
 assert.equal(unicodeResult.status,0,unicodeResult.stderr);
 assert.equal(JSON.stringify(JSON.parse(unicodeResult.stdout).page)===JSON.stringify(unicodePage),true,'Built CLI must preserve large mixed UTF8 input across pipe chunks');
}
console.log('PASS built deferred-original CLI preserves large Chinese/ASCII/emoji/combining input across actual stdin pipe chunks');
