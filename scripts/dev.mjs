import {spawn} from 'node:child_process';
// Preserve the existing root Worker development command. The supervised
// preview's host/port flags select the disposable product QA fixture.
const args=process.argv.slice(2),preview=args.includes('--host');
const child=spawn(process.execPath,preview?['scripts/preview-care.mjs',...args]:['node_modules/wrangler/bin/wrangler.js','dev','--local',...args],{stdio:'inherit'});
child.on('exit',code=>process.exit(code||0));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
