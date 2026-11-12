import {build} from 'esbuild';
import {readdir,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
await rm('.test-build',{recursive:true,force:true});
await mkdir('.test-build',{recursive:true});
const files=(await readdir('tests')).filter(f=>f.endsWith('.test.ts'));
await build({entryPoints:files.map(f=>'tests/'+f),outdir:'.test-build',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
const result=spawnSync(process.execPath,['--test',...files.map(f=>'.test-build/'+f.replace(/\.ts$/,'.js'))],{stdio:'inherit'});
process.exit(result.status ?? 1);
