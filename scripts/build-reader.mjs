import {build} from 'esbuild';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
await mkdir('dist-reader/server',{recursive:true});
await build({entryPoints:['scripts/reader-parser.ts'],bundle:true,platform:'node',format:'esm',target:'node20',outfile:'dist-reader/server/parse-claude.mjs'});
await build({entryPoints:['src/reader.ts'],bundle:true,platform:'browser',format:'esm',external:['react','react-dom','react/jsx-runtime','react-markdown','remark-gfm'],outfile:'dist-reader/reader.mjs'});
await copyFile('LICENSE','dist-reader/LICENSE');
await writeFile('dist-reader/package.json',JSON.stringify({name:'@daymade/session-reader',version:'0.1.0',type:'module',license:'MIT',sourceCommit,repository:'https://github.com/daymade/claude-flow-viewer',files:['web','server','reader.mjs','LICENSE'],exports:{'.':'./reader.mjs','./package.json':'./package.json'},peerDependencies:{react:'^19.2.0','react-dom':'^19.2.0','react-markdown':'^10.1.0','remark-gfm':'^4.0.1'}},null,2)+'\n');
