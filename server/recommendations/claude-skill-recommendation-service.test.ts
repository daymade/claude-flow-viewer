import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
const stdinEndMock = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

async function writeJsonl(filePath: string, records: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
}

describe('ClaudeSkillRecommendationService', () => {
  let tempRoot = ''

  function unwrapClaudeInvocation(file: string, args: string[]) {
    if (file === 'claude') {
      return {
        file: 'claude',
        args,
        shellArgs: args,
      }
    }

    if (!/(zsh|bash)$/.test(file)) return null
    const commandIndex = args.findIndex((value) => value === 'claude')
    if (commandIndex < 0) return null
    return {
      file: 'claude',
      args: args.slice(commandIndex + 1),
      shellArgs: args,
    }
  }

  beforeEach(async () => {
    execFileMock.mockReset()
    stdinEndMock.mockReset()
    tempRoot = await fs.mkdtemp(path.join(process.cwd(), '.tmp-claude-skill-service-'))

    await writeJsonl(
      path.join(tempRoot, '.claude', 'projects', 'demo-project', 'session-1.jsonl'),
      [
        {
          type: 'user',
          timestamp: '2026-03-10T00:00:00.000Z',
          message: { role: 'user', content: 'Analyze recent history and recommend which sites should become integrations.' },
        },
        {
          type: 'assistant',
          timestamp: '2026-03-10T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'I will review GitHub issues and Claude docs.' }] },
        },
      ],
    )

    await fs.mkdir(path.join(tempRoot, '.codex', 'sessions', '2026', '03', '10'), { recursive: true })
    await writeJsonl(
      path.join(tempRoot, '.codex', 'sessions', '2026', '03', '10', 'rollout-2026-03-10T00-00-05-019cd000-0000-7000-8000-000000000001.jsonl'),
      [
        {
          timestamp: '2026-03-10T00:00:05.000Z',
          type: 'session_meta',
          payload: {
            id: '019cd000-0000-7000-8000-000000000001',
            timestamp: '2026-03-10T00:00:05.000Z',
            cwd: '/Users/test/workspace/codex-app',
          },
        },
        {
          timestamp: '2026-03-10T00:00:06.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Review recent history and list reusable sites and skills.' }],
          },
        },
      ],
    )

    execFileMock.mockImplementation((file: string, args: string[], options: object, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      void options
      const invocation = unwrapClaudeInvocation(file, args)
      if (!invocation) {
        callback(new Error(`Unexpected execFile call: ${file} ${args.join(' ')}`))
        return { stdin: { end: stdinEndMock } }
      }

      if (invocation.args[0] === '--version') {
        callback(null, '2.1.81 (Claude Code)\n', '')
        return { stdin: { end: stdinEndMock } }
      }

      const agentIndex = invocation.args.indexOf('--agent')
      const agentName = agentIndex >= 0 ? invocation.args[agentIndex + 1] : ''
      const prompt = invocation.args[invocation.args.length - 1] ?? ''

      if (agentName === 'scout' && typeof prompt === 'string' && prompt.includes('Readiness probe')) {
        callback(null, JSON.stringify({
          is_error: false,
          structured_output: { ok: true },
        }), '')
        return { stdin: { end: stdinEndMock } }
      }

      if (agentName === 'scout') {
        callback(null, JSON.stringify({
          is_error: false,
          structured_output: {
            summary: 'Recent sessions repeatedly ask which external sites or docs should become integrations.',
            patterns: [
              {
                label: 'Website integration analysis',
                evidence: ['session-1', '019cd000-0000-7000-8000-000000000001'],
              },
            ],
          },
        }), '')
        return { stdin: { end: stdinEndMock } }
      }

      if (agentName === 'skeptic') {
        callback(null, JSON.stringify({
          is_error: false,
          structured_output: {
            summary: 'Keep the website-analysis pattern because it appears across both Claude and Codex history.',
            keep: ['Website integration analysis'],
            discard: [],
          },
        }), '')
        return { stdin: { end: stdinEndMock } }
      }

      if (agentName === 'writer') {
        callback(null, JSON.stringify({
          is_error: false,
          structured_output: {
            summary: 'Convert the repeated website-analysis workflow into a reusable skill.',
            candidates: [
              {
                name: 'site-recommend',
                title: 'Website integration scout',
                summary: 'Recommend which recurring sites or docs should become integrations.',
                rationale: 'Recent history repeatedly asks for website and docs integration recommendations.',
                whenToUse: 'Use this when a thread asks which external sites should become first-class integrations.',
                steps: ['Inspect recent history', 'Cluster recurring sites', 'Recommend the strongest candidates'],
                evidence: ['github.com', 'claude.com'],
                confidence: 'high',
              },
            ],
          },
        }), '')
        return { stdin: { end: stdinEndMock } }
      }

      callback(new Error(`Unexpected execFile call: ${file} ${args.join(' ')}`))
      return { stdin: { end: stdinEndMock } }
    })
  })

  afterEach(async () => {
    process.env.SHELL = '/bin/zsh'
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('uses local Claude custom agents to build skill recommendations from recent history', async () => {
    const { ClaudeSkillRecommendationService } = await import('./claude-skill-recommendation-service')

    const service = new ClaudeSkillRecommendationService({
      claudeProjectsDir: path.join(tempRoot, '.claude', 'projects'),
      codexRootDir: path.join(tempRoot, '.codex'),
      codexSessionsDir: path.join(tempRoot, '.codex', 'sessions'),
    })

    const status = await service.getStatus()
    expect(status.available).toBe(true)

    const analysis = await service.analyzeRecentHistory()
    expect(analysis.scope).toBe('smart')
    expect(analysis.requestedProjectEncoded).toBeNull()
    expect(analysis.scopeLabel).toBe('Smart scope')
    expect(analysis.targetLabel).toBeNull()
    expect(analysis.analyzedSessionCount).toBe(2)
    expect(analysis.discussion.map((point) => point.agent)).toEqual(['scout', 'skeptic', 'writer'])
    expect(analysis.recommendations[0]).toMatchObject({
      name: 'site-recommend',
      title: 'Website integration scout',
      confidence: 'high',
    })

    const agentCalls = execFileMock.mock.calls
      .map(([file, args]) => unwrapClaudeInvocation(file as string, args as string[]))
      .filter((value): value is { file: string; args: string[]; shellArgs: string[] } => Boolean(value))
      .filter((value) => value.args.includes('--agent'))
    expect(agentCalls).toHaveLength(4)
    expect(stdinEndMock).toHaveBeenCalled()
    expect(agentCalls.every((call) => call.args.includes('--agents'))).toBe(true)
    expect(agentCalls.every((call) => call.shellArgs.some((arg) => arg.includes('source ~/.zprofile')))).toBe(true)
    expect(agentCalls.map((call) => {
      const argv = call.args
      const index = argv.indexOf('--agent')
      return index >= 0 ? argv[index + 1] : null
    })).toEqual(['scout', 'scout', 'skeptic', 'writer'])
  })

  it('can constrain the analysis to the active project', async () => {
    const { ClaudeSkillRecommendationService } = await import('./claude-skill-recommendation-service')

    const service = new ClaudeSkillRecommendationService({
      claudeProjectsDir: path.join(tempRoot, '.claude', 'projects'),
      codexRootDir: path.join(tempRoot, '.codex'),
      codexSessionsDir: path.join(tempRoot, '.codex', 'sessions'),
    })

    const analysis = await service.analyzeRecentHistory({
      scope: 'project',
      projectEncoded: 'demo-project',
    })

    expect(analysis.scope).toBe('project')
    expect(analysis.requestedProjectEncoded).toBe('demo-project')
    expect(analysis.scopeLabel).toBe('Current project')
    expect(analysis.targetLabel).toBe('project')
    expect(analysis.analyzedSessionCount).toBe(1)

    const scoutPrompt = execFileMock.mock.calls
      .map(([file, args]) => unwrapClaudeInvocation(file as string, args as string[]))
      .find((call) => call?.args.includes('--agent') && call.args.includes('scout'))
    expect(scoutPrompt?.args[scoutPrompt.args.length - 1]).toContain('Analyze recent history and recommend which sites should become integrations.')
    expect(scoutPrompt?.args[scoutPrompt.args.length - 1]).not.toContain('Review recent history and list reusable sites and skills.')
  })

  it('reports not-ready when the Claude readiness probe fails', async () => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((file: string, args: string[], options: object, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      void options
      const invocation = unwrapClaudeInvocation(file, args)
      if (!invocation) {
        callback(new Error(`Unexpected execFile call: ${file} ${args.join(' ')}`))
        return { stdin: { end: stdinEndMock } }
      }

      if (invocation.args[0] === '--version') {
        callback(null, '2.1.81 (Claude Code)\n', '')
        return { stdin: { end: stdinEndMock } }
      }

      callback(Object.assign(new Error('Not logged in · Please run /login'), {
        stdout: '{"result":"Not logged in · Please run /login"}',
      }))
      return { stdin: { end: stdinEndMock } }
    })

    const { ClaudeSkillRecommendationService } = await import('./claude-skill-recommendation-service')

    const service = new ClaudeSkillRecommendationService({
      claudeProjectsDir: path.join(tempRoot, '.claude', 'projects'),
      codexRootDir: path.join(tempRoot, '.codex'),
      codexSessionsDir: path.join(tempRoot, '.codex', 'sessions'),
    })

    const status = await service.getStatus()
    expect(status.available).toBe(false)
    if (!status.available) {
      expect(status.reason).toBe('not-ready')
      expect(status.message).toContain('not logged in')
    }
  })

  it('uses bash startup files when the user shell is bash', async () => {
    process.env.SHELL = '/bin/bash'
    vi.resetModules()

    const { ClaudeSkillRecommendationService } = await import('./claude-skill-recommendation-service')

    const service = new ClaudeSkillRecommendationService({
      claudeProjectsDir: path.join(tempRoot, '.claude', 'projects'),
      codexRootDir: path.join(tempRoot, '.codex'),
      codexSessionsDir: path.join(tempRoot, '.codex', 'sessions'),
    })

    await service.getStatus()

    const firstCall = execFileMock.mock.calls
      .map(([file, args]) => unwrapClaudeInvocation(file as string, args as string[]))
      .find((call) => Boolean(call))

    expect(firstCall?.shellArgs.some((arg) => arg.includes('source ~/.bash_profile'))).toBe(true)
    expect(firstCall?.shellArgs.some((arg) => arg.includes('source ~/.bashrc'))).toBe(true)
  })
})
