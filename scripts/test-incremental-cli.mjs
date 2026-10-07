// CLI-level tamper matrix for the incremental reader parser.
// Builds no fixtures on disk beyond a mktemp dir; run after `npm run build:reader`:
//   node scripts/test-incremental-cli.mjs
// Every case must end in a full-parse-equivalent outcome: either the CLI goes
// incremental with identical bytes, or it falls back — never wrong output.
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const PARSER = new URL('../dist-reader/server/parse-claude.mjs', import.meta.url).pathname
const SID = '11111111-2222-3333-4444-555555555555'
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')

const rec = (type, parent, extra) => JSON.stringify({uuid: uuid(), parentUuid: parent, type, sessionId: SID, timestamp: '2026-10-07T10:00:00.000Z', ...extra})
const up = (t, p) => rec('user', p, {message: {role: 'user', content: t}})
const as = (b, p) => rec('assistant', p, {message: {role: 'assistant', content: b}})

function buildSession() {
  seq = 0
  const lines = []
  const p1 = JSON.parse(up('第一个问题', null)); lines.push(JSON.stringify(p1))
  const a1 = JSON.parse(as([{type: 'text', text: '回答一'}], p1.uuid)); lines.push(JSON.stringify(a1))
  const p2 = JSON.parse(up('第二个问题', a1.uuid)); lines.push(JSON.stringify(p2))
  const a2 = JSON.parse(as([{type: 'text', text: '回答二'}], p2.uuid)); lines.push(JSON.stringify(a2))
  const part1 = lines.join('\n') + '\n'
  const more = [up('追加的问题', a2.uuid), as([{type: 'text', text: '追加回答'}], a2.uuid + '')]
  // fix parent chain for the appended assistant
  more[1] = as([{type: 'text', text: '追加回答'}], JSON.parse(more[0]).uuid)
  const full = part1 + more.join('\n') + '\n'
  return {part1, full}
}

function run(args, opts = {}) {
  return execFileSync('node', [PARSER, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts})
}
function mode(args) {
  try {
    execFileSync('node', [PARSER, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
    return 'ok'
  } catch (e) {
    return String(e.stderr || e.message)
  }
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS ${name}`)
  else { console.log(`  FAIL ${name} ${detail}`); failures++ }
}

const dir = mkdtempSync(join(tmpdir(), 'cli-matrix-'))
const {part1, full} = buildSession()
const fPart = join(dir, 'part.jsonl'), fFull = join(dir, 'full.jsonl')
writeFileSync(fPart, part1); writeFileSync(fFull, full)
const sha = 'matrixsha'

// boot: full parse of part1 with state
run([fPart, join(dir, 'p.json'), SID, join(dir, 'p.state'), '', sha])
const refOut = join(dir, 'ref.json')
run([fFull, refOut, SID])
const ref = readFileSync(refOut, 'utf8')

// control: genuine continuation must be incremental and byte-identical
{
  const out = join(dir, 'c.json')
  run([fFull, out, SID, join(dir, 'p.state'), join(dir, 'p.json'), sha])
  check('control incremental byte-identical', readFileSync(out, 'utf8') === ref)
}

// helper: fresh boot state per case
function freshState(name) {
  const d = mkdtempSync(join(tmpdir(), name + '-'))
  writeFileSync(join(d, 'part.jsonl'), part1)
  writeFileSync(join(d, 'full.jsonl'), full)
  run([join(d, 'part.jsonl'), join(d, 'p.json'), SID, join(d, 'p.state'), '', sha])
  return d
}
function tamper(d, fn) {
  const p = join(d, 'p.state')
  const s = JSON.parse(readFileSync(p, 'utf8'))
  fn(s)
  writeFileSync(p, JSON.stringify(s))
  return s
}
function expectFallback(name, d, detailCheck) {
  const out = join(d, 'c.json')
  const stderrLines = []
  try {
    execFileSync('node', [PARSER, join(d, 'full.jsonl'), out, SID, join(d, 'p.state'), join(d, 'p.json'), sha], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  } catch (e) {
    stderrLines.push(String(e.stderr))
  }
  const produced = readFileSync(out, 'utf8')
  const identical = produced === ref
  check(name, identical && (!detailCheck || detailCheck(produced)), identical ? '' : '(output differs)')
}

// C2: frozenMessageCount + 1 (outputSha must catch)
{
  const d = freshState('c2')
  tamper(d, (s) => { s.frozenMessageCount += 1 })
  expectFallback('C2 frozenMessageCount+1 -> fallback', d)
}
// C3: deliveredPromptIndex wiped (outputSha must catch)
{
  const d = freshState('c3')
  tamper(d, (s) => { s.deliveredPromptIndex = {} })
  expectFallback('C3 wiped deliveredPromptIndex -> fallback', d)
}
// C5: previous replaced with a foreign session's output (outputSha must catch)
{
  const d = freshState('c5')
  const foreign = JSON.parse(readFileSync(join(d, 'p.json'), 'utf8'))
  foreign.messages.push({kind: 'ai-text', text: '外部会话内容', timestamp: ''})
  writeFileSync(join(d, 'p.json'), JSON.stringify(foreign))
  expectFallback('C5 foreign previous -> fallback', d, (out) => !out.includes('外部会话内容'))
}
// C6: source carries a foreign-session line inside the consumed prefix; forged state must not bypass identity
{
  const d = freshState('c6')
  const foreignLine = JSON.stringify({uuid: uuid(), parentUuid: null, type: 'user', sessionId: '99999999-9999-9999-9999-999999999999', timestamp: '2026-10-07T10:00:01.000Z', message: {role: 'user', content: '外来会话'}})
  writeFileSync(join(d, 'full.jsonl'), foreignLine + '\n' + full)
  // forge a state claiming everything is consumed and valid
  const content = readFileSync(join(d, 'full.jsonl'), 'utf8')
  const genuine = JSON.parse(readFileSync(join(d, 'p.state'), 'utf8'))
  genuine.consumedLength = foreignLine.length + 1
  genuine.windowOffset = foreignLine.length + 1
  genuine.frozenMessageCount = 0
  genuine.frozenPromptCount = 0
  genuine.windowRecordUuid = null
  genuine.lastUuid = null
  genuine.prefixSha256 = sha256(content.slice(0, genuine.consumedLength))
  genuine.outputSha256 = sha256(JSON.stringify({messages: [], prompts: [], deliveredPromptIndex: genuine.deliveredPromptIndex, compactBoundaries: genuine.compactBoundaries, compactSummaries: genuine.compactSummaries}))
  writeFileSync(join(d, 'p.state'), JSON.stringify(genuine))
  const result = mode([join(d, 'full.jsonl'), join(d, 'c.json'), SID, join(d, 'p.state'), join(d, 'p.json'), sha])
  check('C6 forged state -> identity mismatch still raised', /identity mismatch/.test(result), `(got: ${result})`)
}
// C7: lastUuid rewritten to an earlier uuid (backward scan must catch)
{
  const d = freshState('c7')
  tamper(d, (s) => { s.lastUuid = 'ffffffff-0000-4000-8000-000000000000' })
  expectFallback('C7 lastUuid tampered -> fallback', d)
}
// C1: windowOffset rolled to a different record (windowRecordUuid must catch)
{
  const d = freshState('c1')
  tamper(d, (s) => { s.windowOffset = 0 })
  expectFallback('C1 windowOffset rolled back -> fallback', d)
}

rmSync(dir, {recursive: true, force: true})
if (failures) {
  console.error(`${failures} case(s) failed`)
  process.exit(1)
}
console.log('CLI tamper matrix: all cases pass')
