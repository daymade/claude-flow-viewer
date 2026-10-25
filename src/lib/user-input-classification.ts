/** Content interpretation only. Source/session binding and actor authority belong to the caller. */
export interface UserInputClassification {
  kind: 'ordinary' | 'internal' | 'control' | 'unknown'
  reason: 'text' | 'attachment' | 'bootstrap' | 'peer' | 'hook' | 'question-reply' | 'missing' | 'empty' | 'malformed'
}

const result = (kind: UserInputClassification['kind'], reason: UserInputClassification['reason']): UserInputClassification => ({kind, reason})
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function questionReply(text: string): boolean {
  const envelope = text.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/)
  if (!envelope) return false
  try {
    const payload: unknown = JSON.parse(envelope[1])
    const replies = Array.isArray(payload) ? payload : [payload]
    return replies.length > 0 && replies.every(reply => {
      if (!object(reply) || typeof reply.answer !== 'string' || typeof reply.question !== 'string' || typeof reply.questionItemId !== 'string') return false
      const key: unknown = JSON.parse(reply.questionItemId)
      return Array.isArray(key) && key.length === 3 && key[0] === 'request_user_input_async'
        && typeof key[1] === 'string' && Number.isInteger(key[2]) && JSON.stringify(key) === reply.questionItemId
    })
  } catch { return false }
}

function classifyText(value: string): UserInputClassification {
  let text = value.trim()
  if (!text) return result('unknown', 'empty')
  // Native IDE context surrounds the actual request; only its explicit final request section counts.
  if (text.startsWith('# Context from my IDE setup:\n')) {
    const marker = '\n## My request for Codex:\n', at = text.lastIndexOf(marker)
    if (at >= 0) text = text.slice(at + marker.length).trim()
  }
  if (questionReply(text)) return result('control', 'question-reply')
  if (/^<send_user_message_question_reply>[\s\S]*<\/send_user_message_question_reply>$/.test(text)) return result('unknown', 'malformed')
  const frame = text.match(/^<(peer-message|codex_delegation|codex_internal_context|hook_prompt|subagent_notification)\b[^>]*>[\s\S]*<\/\1>$/i)
  if (frame) return result('internal', frame[1].toLowerCase() === 'hook_prompt' ? 'hook' : 'peer')
  const opener = text.match(/^<(send_user_message_question_reply|peer-message|codex_delegation|codex_internal_context|hook_prompt|subagent_notification)\b/i)
  if (opener && !text.toLowerCase().includes(`</${opener[1].toLowerCase()}>`)) return result('unknown', 'malformed')
  // The transport has a finite header and a terminal Payload section; mentions/quotes do not match.
  if (/^Message Type: (?:NEW_TASK|MESSAGE|FINAL_ANSWER)\r?\n(?:Task name: [^\r\n]+\r?\n)?(?:Sender: [^\r\n]+\r?\n)?Payload:[\s\S]*$/.test(text)) return result('internal', 'peer')
  if (/^Message Type: (?:NEW_TASK|MESSAGE|FINAL_ANSWER)(?:\r?\n|$)/.test(text)) return result('unknown', 'malformed')
  // Consume complete known bootstrap frames, allowing the native AGENTS + environment bundle.
  let remaining = text
  const heading = remaining.match(/^# (?:AGENTS\.md(?: instructions(?: for [^\r\n]+)?)?|CLAUDE\.md)(?:\r?\n|$)/)
  if (heading) {
    remaining = remaining.slice(heading[0].length).trim()
    if (!remaining) return result('internal', 'bootstrap')
    const instructions = remaining.match(/^<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/)
    if (!instructions) return result('unknown', 'malformed')
    remaining = remaining.slice(instructions[0].length).trim()
  }
  let consumed = Boolean(heading)
  while (remaining) {
    const block = remaining.match(/^<(skill|skills_instructions|environment_context|permissions|collaboration_mode|system|developer|user_instructions|turn_aborted)\b[^>]*>[\s\S]*?<\/\1>/)
    if (!block) break
    consumed = true
    remaining = remaining.slice(block[0].length).trim()
  }
  if (consumed && !remaining) return result('internal', 'bootstrap')
  return result('ordinary', 'text')
}

/** Accept original native/raw text content parts, never a caller-supplied classification. */
export function classifyUserInputContent(content: unknown): UserInputClassification {
  if (content === null || content === undefined) return result('unknown', 'missing')
  if (typeof content === 'string') return classifyText(content)
  const parts = Array.isArray(content) ? content : [content]
  const texts: string[] = []
  let attachment = false, malformed = false
  for (const part of parts) {
    if (typeof part === 'string') { texts.push(part); continue }
    if (!object(part)) { malformed = true; continue }
    if (['skill', 'mention'].includes(String(part.type).toLowerCase())) continue
    if ((part.type === undefined || ['text', 'input_text', 'output_text'].includes(String(part.type))) && typeof part.text === 'string') { texts.push(part.text); continue }
    // These image shapes are supported by the native and rollout Reader adapters.
    if (['image', 'input_image'].includes(String(part.type)) && (nonempty(part.url) || nonempty(part.image_url) || typeof part.data === 'string' && part.data.startsWith('data:image/'))) { attachment = true; continue }
    malformed = true
  }
  if (malformed) return result('unknown', 'malformed')
  if (attachment) return result('ordinary', 'attachment')
  return classifyText(texts.join('\n'))
}

export interface UserInputBatch {
  version: 1
  inputs: Array<{id: string; content?: unknown}>
}
export interface UserInputBatchResult {
  version: 1
  classifications: Array<UserInputClassification & {id: string}>
}
/** A bounded, identity-preserving bridge for consumers whose native reader already bound the source. */
export function classifyUserInputs(batch: unknown): UserInputBatchResult {
  if (!object(batch) || batch.version !== 1 || !Array.isArray(batch.inputs) || batch.inputs.length > 1000) throw new Error('Expected version 1 and at most 1000 inputs')
  const ids = new Set<string>()
  const classifications = batch.inputs.map(input => {
    if (!object(input) || !nonempty(input.id) || ids.has(input.id)) throw new Error('Each input requires a unique nonempty id')
    ids.add(input.id)
    return {id: input.id, ...classifyUserInputContent(input.content)}
  })
  return {version: 1, classifications}
}
