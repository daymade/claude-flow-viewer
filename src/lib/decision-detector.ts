import type { DecisionMarker } from '../types/session'

const CORRECTION_KEYWORDS = [
  'no ', 'not ', 'wrong', 'stop', "don't", 'instead',
  'actually', 'wait', 'cancel',
]

// Keep this intentionally narrower than generic negative sentiment. These patterns describe
// the user's interaction with the agent (stop, correction, scope reset, or missing context),
// not ordinary domain prose that happens to contain words such as "不是".
const CHINESE_CORRECTION_PATTERNS = [
  /(?:你|这|刚才).{0,16}(?:理解错|搞错|做错|答错|错了|没理解|没有理解|忘了|失忆|遗漏|漏了)/,
  /(?:不要|别(?:再|派|继续|做|改|删|发|推|跑|试|猜|问|解释|展开|重做|开始)|先别|停止|停下来|打断|取消|不许|禁止).{0,20}/,
  /(?:我说的是|我要的是|我要的需求|我的需求(?:是|很简单)|不是让你|并没有要求|你理解的是什么)/,
  /(?:擅自|又开始|重新).{0,16}(?:试错|猜测|探索|重做|开一轮)/,
  /(?:上下文|历史记录|以前的经验|成功的经验).{0,16}(?:没(?:有)?读|没(?:有)?看|没(?:有)?获取|不足|不够|丢失|忘了|未复用)/,
  /为什么(?:没有|没).{0,20}(?:包含|列出|找到|读取|复用|看到)/,
  /(?:有这么麻烦吗|看起来很费劲|换行太多|还不如你一开始)/,
]

export function detectDecision(text: string, promptNum: number): DecisionMarker {
  if (text.includes('[Request interrupted by user]')) return 'interrupt'
  if (promptNum > 1) {
    const lower = text.toLowerCase()
    if (
      CORRECTION_KEYWORDS.some(kw => lower.includes(kw))
      || CHINESE_CORRECTION_PATTERNS.some(pattern => pattern.test(text))
    ) return 'correction'
  }
  return 'none'
}
