import {projectDeferredOriginalPage} from '../src/lib/deferred-original'

try {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  // Preserve unsafe integer tokens when echoing unchanged page/unknown fields to
  // the Python authority. Browser record hashes still use its JSON object view;
  // exact original number spellings remain in sourceRecordRaw and its byte hash.
  const request = JSON.parse(input, (_key, value, context) => {
    if (typeof value === 'number') {
      if (typeof context?.source !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(context.source)) throw new Error('Deferred original numeric token support unavailable')
      if (/^-?(?:0|[1-9][0-9]*)$/.test(context.source) && !Number.isSafeInteger(value)) {
        if (typeof JSON.rawJSON !== 'function') throw new Error('Deferred original exact integer serialization unavailable')
        return JSON.rawJSON(context.source)
      }
    }
    return value
  })
  if (!request || request.version !== 1 || !request.page || !Array.isArray(request.page.records)
      || (request.capability !== undefined && request.capability !== 1 && request.capability !== 2)) throw new Error('Expected version 1, an authority-validated complete page and optional capability 1')
  const page = await projectDeferredOriginalPage(request.page, request.capability)
  process.stdout.write(JSON.stringify({version: 1, page}) + '\n')
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
