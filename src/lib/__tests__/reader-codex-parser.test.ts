import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Synthetic identities only — invented UUIDs, an invented cwd, invented content.
const SESSION = '11111111-2222-4333-8444-555555555555'
const OTHER_SESSION = '99999999-8888-4777-8666-555555555555'
const CWD = '/synthetic/workspace'
const TURN_A = '22222222-3333-4444-8444-666666666666'
const TURN_B = '33333333-4444-4555-8444-777777777777'

const sessionMeta = {
  timestamp: '2026-10-01T00:00:00.000Z',
  type: 'session_meta',
  payload: { id: SESSION, timestamp: '2026-10-01T00:00:00.000Z', cwd: CWD },
}
const userEvent = {
  timestamp: '2026-10-01T00:00:01.000Z',
  type: 'event_msg',
  payload: { type: 'user_message', id: 'evt-synthetic-user-1', message: 'synthetic request' },
}
const toolCallTurnA = {
  timestamp: '2026-10-01T00:00:02.000Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    call_id: 'call-turn-a-1',
    name: 'exec_command',
    arguments: '{"cmd":"ls /synthetic/workspace"}',
    internal_chat_message_metadata_passthrough: { turn_id: TURN_A },
  },
}
const toolOutputTurnA = {
  timestamp: '2026-10-01T00:00:03.000Z',
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: 'call-turn-a-1',
    output: '{"output":"synthetic listing","metadata":{"exit_code":0}}',
    internal_chat_message_metadata_passthrough: { turn_id: TURN_A },
  },
}
const toolCallTurnB = {
  timestamp: '2026-10-01T00:00:04.000Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    call_id: 'call-turn-b-1',
    name: 'exec_command',
    arguments: '{"cmd":"pwd"}',
    internal_chat_message_metadata_passthrough: { turn_id: TURN_B },
  },
}
const agentReply = {
  timestamp: '2026-10-01T00:00:05.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic done' }] },
}

function jsonl(...records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

let workspace: string
let bundle: string

function runCli(args: string[]) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8' })
}

async function writeFixture(name: string, content: string): Promise<string> {
  const file = path.join(workspace, name)
  await writeFile(file, content)
  return file
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'reader-codex-parser-'))
  bundle = path.join(workspace, 'parse-codex.mjs')
  await build({
    entryPoints: [path.join(process.cwd(), 'scripts/reader-codex-parser.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundle,
  })
}, 120000)

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('reader-codex-parser CLI', () => {
  it('parses a valid full file to SessionData with pendingTail false, written atomically with mode 0o600', async () => {
    const source = await writeFixture('full.jsonl', jsonl(sessionMeta, userEvent, toolCallTurnA, toolOutputTurnA, agentReply))
    const target = path.join(workspace, 'full.out.json')

    const run = runCli([source, target, SESSION, CWD])

    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    const output = JSON.parse(await readFile(target, 'utf8')) as {
      source: string
      pendingTail: boolean
      messages: Array<{ kind: string; sourceRecordId?: string }>
      prompts: Array<{ num: number }>
    }
    expect(output.source).toBe('codex')
    expect(output.pendingTail).toBe(false)
    expect(output.prompts).toHaveLength(1)
    expect(output.messages.some((m) => m.kind === 'ai-tool-use' && m.sourceRecordId === 'call-turn-a-1')).toBe(true)
    expect(output.messages.some((m) => m.kind === 'tool-result')).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    // Atomic rename: the temp staging file must not survive next to the output.
    expect(await readdir(workspace)).not.toContain('full.out.json.tmp')
  })

  it('filters to the explicitly turn-bound ai-tool-use messages when a turn arg is given', async () => {
    const source = await writeFixture('turn.jsonl', jsonl(sessionMeta, userEvent, toolCallTurnA, toolOutputTurnA, toolCallTurnB, agentReply))
    const target = path.join(workspace, 'turn.out.json')

    const run = runCli([source, target, SESSION, CWD, TURN_A])

    expect(run.status).toBe(0)
    const output = JSON.parse(await readFile(target, 'utf8')) as {
      source: string
      turn: string
      pendingTail: boolean
      messages: Array<{
        kind: string
        input?: Record<string, unknown>
        sourceRecordId?: string
        sourceRecord?: { payload?: { internal_chat_message_metadata_passthrough?: { turn_id?: string } } }
      }>
    }
    expect(output).toMatchObject({ source: 'codex', turn: TURN_A, pendingTail: false })
    expect(output.messages).toHaveLength(1)
    const only = output.messages[0]
    expect(only.kind).toBe('ai-tool-use')
    // The current-turn call is in; the later turn's call and the delivery/coordination
    // function_call_output (a tool-result, same turn id) are both out.
    expect(only.sourceRecordId).toBe('call-turn-a-1')
    expect(only.input).toEqual({ cmd: 'ls /synthetic/workspace' })
    expect(only.sourceRecord?.payload?.internal_chat_message_metadata_passthrough?.turn_id).toBe(TURN_A)
  })

  it('reads a single turn under a 16MiB heap without retaining the rest of the rollout', async () => {
    // Root-probe-equivalent fixture: 512 custom_tool_call records x 32KB input bound to a turn we
    // do NOT ask for, then one record bound to the requested turn whose input ends with a
    // sentinel. Under the old post-filter CLI the same shape OOMed a 16MiB heap because every
    // record materialized a retained SessionMessage; with in-classifier selection the unselected
    // 16MiB of payloads is garbage as each line is consumed.
    const sentinel = 'SELECTED_INPUT_END'
    const lines: string[] = [JSON.stringify(sessionMeta)]
    for (let i = 0; i < 512; i++) {
      lines.push(JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: `irrelevant-${i}`,
          input: 'x'.repeat(32768),
          internal_chat_message_metadata_passthrough: { turn_id: TURN_B },
        },
      }))
    }
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call-selected',
        input: 'y'.repeat(32768 - sentinel.length) + sentinel,
        internal_chat_message_metadata_passthrough: { turn_id: TURN_A },
      },
    }))
    const source = await writeFixture('heap-turn.jsonl', lines.join('\n') + '\n')
    const target = path.join(workspace, 'heap-turn.out.json')

    const run = spawnSync(
      process.execPath,
      ['--max-old-space-size=16', bundle, source, target, SESSION, CWD, TURN_A],
      { encoding: 'utf8', timeout: 60000 },
    )

    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    const output = JSON.parse(await readFile(target, 'utf8')) as {
      source: string
      turn: string
      pendingTail: boolean
      messages: Array<{ kind: string; input?: { raw?: string }; sourceRecordId?: string }>
    }
    expect(output).toMatchObject({ source: 'codex', turn: TURN_A, pendingTail: false })
    expect(output.messages).toHaveLength(1)
    expect(output.messages[0].kind).toBe('ai-tool-use')
    expect(output.messages[0].input?.raw?.endsWith(sentinel)).toBe(true)
    expect(output.messages[0].sourceRecordId).toBe('call-selected')
  }, 60000)

  it('rejects a rollout whose session id does not match', async () => {
    const source = await writeFixture('wrong-id.jsonl', jsonl(sessionMeta, userEvent))
    const run = runCli([source, path.join(workspace, 'wrong-id.out.json'), OTHER_SESSION, CWD])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('session identity mismatch')
  })

  it('rejects a rollout whose cwd does not match', async () => {
    const source = await writeFixture('wrong-cwd.jsonl', jsonl(sessionMeta, userEvent))
    const run = runCli([source, path.join(workspace, 'wrong-cwd.out.json'), SESSION, '/synthetic/other-workspace'])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('session identity mismatch')
  })

  it('rejects a rollout with a second conflicting session_meta', async () => {
    const conflicting = {
      timestamp: '2026-10-01T00:00:01.500Z',
      type: 'session_meta',
      payload: { id: OTHER_SESSION, timestamp: '2026-10-01T00:00:01.500Z', cwd: CWD },
    }
    const source = await writeFixture('conflict.jsonl', jsonl(sessionMeta, userEvent, conflicting))
    const run = runCli([source, path.join(workspace, 'conflict.out.json'), SESSION, CWD])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('session identity mismatch')
  })

  it('rejects a rollout with no session_meta at all', async () => {
    const source = await writeFixture('no-meta.jsonl', jsonl(userEvent, agentReply))
    const run = runCli([source, path.join(workspace, 'no-meta.out.json'), SESSION, CWD])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('missing session_meta')
  })

  it('rejects a malformed record in the middle of the file, naming its line', async () => {
    const content = JSON.stringify(sessionMeta) + '\n' + '{"type":"response_item","payload":' + '\n' + JSON.stringify(agentReply) + '\n'
    const source = await writeFixture('malformed.jsonl', content)
    const run = runCli([source, path.join(workspace, 'malformed.out.json'), SESSION, CWD])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Malformed session record at line 2')
  })

  it('tolerates a genuinely truncated final record (no trailing newline) as a pending tail', async () => {
    const content = jsonl(sessionMeta, userEvent, toolCallTurnA) + '{"type":"response_item","payload":{"type":"function_cal'
    const source = await writeFixture('truncated.jsonl', content)
    const target = path.join(workspace, 'truncated.out.json')

    const run = runCli([source, target, SESSION, CWD])

    expect(run.status).toBe(0)
    const output = JSON.parse(await readFile(target, 'utf8')) as { pendingTail: boolean; messages: unknown[] }
    expect(output.pendingTail).toBe(true)
    expect(output.messages.length).toBeGreaterThan(0)
  })

  it('rejects a malformed final line when the file properly ends with a newline', async () => {
    const content = JSON.stringify(sessionMeta) + '\n' + '{"type":"response_item","payload":' + '\n'
    const source = await writeFixture('malformed-tail.jsonl', content)
    const run = runCli([source, path.join(workspace, 'malformed-tail.out.json'), SESSION, CWD])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Malformed session record at line 2')
  })
})
