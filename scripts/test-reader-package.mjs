import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionReader, classifyUserInputContent, classifyUserInputs} from '../dist-reader/reader.mjs';
import {spawnSync} from 'node:child_process';

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
const cli=spawnSync(process.execPath,['dist-reader/server/classify-user-inputs.mjs'],{input:JSON.stringify(batch),encoding:'utf8'});
assert.equal(cli.status,0,cli.stderr);
assert.deepEqual(JSON.parse(cli.stdout),classifyUserInputs(batch));
const invalid=spawnSync(process.execPath,['dist-reader/server/classify-user-inputs.mjs'],{input:JSON.stringify({version:1,inputs:[{id:'same'},{id:'same'}]}),encoding:'utf8'});
assert.notEqual(invalid.status,0);
assert.equal(invalid.stdout,'');
console.log('PASS built classification SDK and CLI preserve batch results and fail closed');
