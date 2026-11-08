import {projectDeferredOriginalPage} from '../src/lib/deferred-original'

try {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  if (!request || request.version !== 1 || !request.page || !Array.isArray(request.page.records)
      || (request.capability !== undefined && request.capability !== 1)) throw new Error('Expected version 1, an authority-validated complete page and optional capability 1')
  const page = await projectDeferredOriginalPage(request.page, request.capability)
  process.stdout.write(JSON.stringify({version: 1, page}) + '\n')
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
