// @vitest-environment jsdom
import {afterEach,it,expect} from 'vitest'
import {render,cleanup} from '@testing-library/react'
import {ToolCallLine} from './MessageRenderers'
import type {SessionMessage} from '../../types/session'

afterEach(cleanup)

type ToolUseMessage = Extract<SessionMessage,{kind:'ai-tool-use'}>
// Non-agent tool name so the generic ToolUseBlock <pre> branch renders.
const toolMsg = (input: Record<string, unknown>): ToolUseMessage =>
  ({kind:'ai-tool-use',summary:'apply patch',name:'apply_patch',input})

const renderedPre = (input: Record<string, unknown>) => {
  const {container} = render(<ToolCallLine msg={toolMsg(input)}/>)
  const pre = container.querySelector('pre')
  if (!pre) throw new Error('generic tool-use renderer did not produce a <pre>')
  return {container,pre}
}

// A sole string `raw` field is the verbatim tool payload (e.g. an apply-patch
// body). Mix a true newline, a literal backslash-n sequence, quotes,
// HTML-looking text with &, a long unbroken path/token, and a terminal sentinel.
const RAW = [
  '*** Begin Patch',
  '*** Update File: /synthetic/work/a/very/long/unbroken/path/segment/that/keeps/going/without-any-spaces-or-breakpoints/src/components/session/MessageRenderers.tsx',
  '@@',
  '-const label = "old <b>Tom & Jerry</b> text"',
  '+const label = "new text keeping a literal backslash-n: \\n plus "quoted" bits"',
  '*** End Patch',
  'END_OF_RAW_SENTINEL',
].join('\n')

it('renders a sole string raw input verbatim, character for character',()=>{
  const {pre} = renderedPre({raw: RAW})
  expect(pre.textContent).toBe(RAW)
})

it('keeps true newlines true and literal backslash-n sequences literal',()=>{
  const {pre} = renderedPre({raw: RAW})
  expect(pre.textContent).toContain('\n*** End Patch\n')
  expect(pre.textContent).toContain('\\n')
  expect(pre.textContent).not.toContain('"raw"')
  expect(pre.textContent?.endsWith('END_OF_RAW_SENTINEL')).toBe(true)
})

it('treats HTML-looking raw content as text, never as markup',()=>{
  const {container,pre} = renderedPre({raw: RAW})
  expect(pre.textContent).toBe(RAW)
  expect(pre.textContent).toContain('<b>Tom & Jerry</b>')
  expect(pre.querySelector('b')).toBeNull()
  expect(container.querySelector('b')).toBeNull()
})

it('carries the wrapping classes that let overflow-wrap:anywhere be the effective value',()=>{
  const {pre} = renderedPre({raw: RAW})
  // Effective-property contract: in the built reader.css the compiled rule for
  // .break-words (overflow-wrap:break-word) is emitted AFTER the rule for
  // .[overflow-wrap:anywhere] (overflow-wrap:anywhere). Both are single-class
  // selectors of equal specificity, so when both classes sit on this pre,
  // break-word wins the cascade and [overflow-wrap:anywhere] is dead code.
  // The generic pre must therefore carry whitespace-pre-wrap plus
  // [overflow-wrap:anywhere] and must NOT carry break-words, so that
  // overflow-wrap:anywhere is the effective value for long unbroken tokens.
  expect(pre.className).toContain('whitespace-pre-wrap')
  expect(pre.className).toContain('[overflow-wrap:anywhere]')
  expect(pre.className).not.toContain('break-words')
  expect(pre.className).toContain('max-h-[200px]')
  expect(pre.className).toContain('overflow-auto')
})

it('still renders complete JSON when raw shares the input with other fields',()=>{
  const input = {raw: 'patch text',extra: 'keep-me'}
  const {pre} = renderedPre(input)
  expect(pre.textContent).toBe(JSON.stringify(input,null,2))
  expect(pre.textContent).toContain('"raw": "patch text"')
  expect(pre.textContent).toContain('"extra": "keep-me"')
})

it('still renders JSON when raw is not a string',()=>{
  const input = {raw: 195}
  const {pre} = renderedPre(input)
  expect(pre.textContent).toBe(JSON.stringify(input,null,2))
})

it('renders ordinary structured input unchanged',()=>{
  const input = {command: 'git status',timeout: 120000,nested: {flags: ['--short']}}
  const {pre} = renderedPre(input)
  expect(pre.textContent).toBe(JSON.stringify(input,null,2))
})

it('renders an empty raw string as an empty pre, not as JSON',()=>{
  const {pre} = renderedPre({raw: ''})
  expect(pre.textContent).toBe('')
})

it('renders an empty input object unchanged',()=>{
  const {pre} = renderedPre({})
  expect(pre.textContent).toBe('{}')
})
