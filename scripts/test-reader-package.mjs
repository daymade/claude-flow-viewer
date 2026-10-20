import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionReader} from '../dist-reader/reader.mjs';

// Exercise the built public export without a global React namespace. Source
// component tests and the separately compiled iframe cannot catch this failure.
assert.equal(globalThis.React, undefined);
const data = {source:'claude', messages:[{kind:'ai-text',text:'Package API body'}], prompts:[], heatmap:[], markers:{compacts:0,plans:0,clears:0,forks:0}};
const html = renderToStaticMarkup(createElement(SessionReader, {data}));
assert.ok(html.includes('Package API body'), 'The built Reader export must render the supplied body');
assert.ok(!html.includes('data-empty-state'), 'A healthy body must not render empty guidance');
console.log('PASS built Reader export renders without a global React namespace');
