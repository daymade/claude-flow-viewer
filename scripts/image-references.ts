import {conversationImageReferences} from '../src/lib/image-references'
let input=''
for await(const chunk of process.stdin)input+=chunk
const request=JSON.parse(input)
if(!request||request.version!==1||!request.page)throw new Error('Expected version 1 and an exact conversation page')
const result=conversationImageReferences(request.page)
process.stdout.write(JSON.stringify(result)+'\n')
