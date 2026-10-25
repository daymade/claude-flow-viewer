import {classifyUserInputs} from '../src/lib/user-input-classification'

// One JSON batch on stdin; no filesystem/session discovery, stdout only on complete success.
const chunks: Buffer[] = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > 16 * 1024 * 1024) throw new Error('Input batch exceeds 16 MiB')
  chunks.push(chunk)
}
process.stdout.write(JSON.stringify(classifyUserInputs(JSON.parse(Buffer.concat(chunks).toString('utf8')))) + '\n')
