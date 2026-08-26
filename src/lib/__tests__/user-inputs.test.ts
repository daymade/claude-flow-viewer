import { describe, expect, it } from 'vitest'

import {
  buildFeedbackEvidenceMarkdown,
  isHumanAuthoredHistoryInput,
  type UserInputRecord,
} from '../user-inputs'

function input(overrides: Partial<UserInputRecord> = {}): UserInputRecord {
  return {
    id: 'project:session:1:prompt',
    source: 'claude',
    projectEncoded: 'project',
    projectLabel: '/Users/test/project',
    projectShortName: 'project',
    sessionId: 'session-1',
    sessionStartTime: '2026-08-23T07:00:00.000Z',
    text: '你不要重新开始试错',
    timestamp: '2026-08-23T07:51:43.000Z',
    timeRangeStart: null,
    timeRangeEnd: null,
    origin: 'direct',
    decision: 'correction',
    promptNum: 2,
    sortTimestamp: '2026-08-23T07:51:43.000Z',
    ordinal: null,
    ...overrides,
  }
}

describe('feedback evidence packet', () => {
  it('keeps exact user text and stable source identity', () => {
    const markdown = buildFeedbackEvidenceMarkdown([
      input(),
      input({
        id: 'codex:session:compacted',
        source: 'codex',
        sessionId: 'session-2',
        text: '先读取以前成功的经验\n再继续',
        timestamp: null,
        timeRangeStart: '2026-08-26T00:26:51.000Z',
        timeRangeEnd: '2026-08-26T02:42:07.000Z',
        origin: 'compacted',
        decision: 'none',
        sortTimestamp: '2026-08-26T02:42:07.000Z',
        ordinal: 5,
      }),
    ], '2026-08-26T12:00:00.000Z')

    expect(markdown).toContain('schema: claude-flow-feedback-evidence/v1')
    expect(markdown).toContain('Session: session-2')
    expect(markdown).toContain('2026-08-26T00:26:51.000Z → 2026-08-26T02:42:07.000Z')
    expect(markdown).toContain('> 先读取以前成功的经验\n> 再继续')
    expect(markdown).toContain('> 你不要重新开始试错')
  })
})

describe('isHumanAuthoredHistoryInput', () => {
  it('rejects the Codex UserPromptSubmit hook envelope', () => {
    expect(isHumanAuthoredHistoryInput(
      '• UserPromptSubmit (blocked) says: Codex session is fused.\n  feedback: Start a new chat.',
    )).toBe(false)
  })

  it('keeps human prose that discusses the same hook by name', () => {
    expect(isHumanAuthoredHistoryInput(
      '你看一下 UserPromptSubmit 为什么拦住了我，不要直接重试',
    )).toBe(true)
  })

  it('rejects the injected documentation-governance template', () => {
    expect(isHumanAuthoredHistoryInput(
      '这次任务如果涉及代码、脚本、配置、环境变量、端口、路径、部署方式、认证方式、测试方式或操作流程的变化，请把文档更新视为交付的一部分。\n必须显式更新 `CLAUDE.md`。\n交付时请明确给出：修改了哪些文件。',
    )).toBe(false)
  })

  it('keeps a user quoting an assistant bullet to identify its session', () => {
    expect(isHumanAuthoredHistoryInput(
      '• 已停止，进程退出码 130。没有生成或修改文件。\n上面这段话是哪一个 session?',
    )).toBe(true)
  })
})
