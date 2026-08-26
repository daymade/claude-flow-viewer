import { describe, expect, it } from 'vitest'

import { detectDecision } from '../decision-detector'

describe('detectDecision', () => {
  it.each([
    '你理解错了我的需求，我要的是从新到旧列原话',
    '不要擅自开启新一轮试错，先读以前的成功经验',
    '我并没有要求你蒸馏我的判断',
    '你的上下文没有获取充足，历史记录也没有读',
  ])('recognizes Chinese interaction corrections: %s', (text) => {
    expect(detectDecision(text, 2)).toBe('correction')
  })

  it('does not label the first task request as a correction', () => {
    expect(detectDecision('我的需求是列出最近的用户输入', 1)).toBe('none')
  })

  it('does not treat ordinary domain negation as interaction feedback', () => {
    expect(detectDecision('这家公司不是传统硬件公司，而是服务商', 3)).toBe('none')
  })

  it.each([
    '为什么没有包含 Codex',
    '找一个最新的用户输入，有这么麻烦吗',
    '别派审查了，赶紧提交吧',
    '你是不是遗漏了问题啊',
  ])('recognizes concise Chinese course corrections: %s', (text) => {
    expect(detectDecision(text, 3)).toBe('correction')
  })

  it('keeps explicit interruption markers distinct', () => {
    expect(detectDecision('[Request interrupted by user]', 0)).toBe('interrupt')
  })
})
