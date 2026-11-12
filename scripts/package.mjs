import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const version=JSON.parse(await readFile('package.json','utf8')).version;
await mkdir('release',{recursive:true});
// Dependency-free standard ZIP writer (stored entries, CRC32, deterministic timestamp).
const table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc(data){let c=0xffffffff;for(const b of data)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
async function walk(base,prefix=''){
  const entries=[];
  for(const name of (await readdir(base)).sort()){
    if(name.startsWith('.'))continue;
    const relative=path.posix.join(prefix,name),file=path.join(base,name);
    if((await stat(file)).isDirectory())entries.push(...await walk(file,relative));
    else entries.push({name:relative,data:await readFile(file)});
  }
  return entries;
}
async function zip(destination,entries){
  const locals=[],centrals=[];let offset=0;
  for(const{name,data}of entries){
    const filename=Buffer.from(name),checksum=crc(data),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(0x21,12);
    local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(0x21,14);
    central.writeUInt32LE(checksum,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,filename,data);centrals.push(central,filename);offset+=local.length+filename.length+data.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const buffer=Buffer.concat([...locals,directory,end]);await writeFile(destination,buffer);
  return `${createHash('sha256').update(buffer).digest('hex')}  ${path.basename(destination)}`;
}
const extension=await walk('dist');
const sources=[];
for(const directory of ['src','public','scripts','tests','dist'])for(const entry of await walk(directory,directory))sources.push(entry);
// Explicit publication allowlist: private live screenshots and raw logs stay local.
const publicDocs=[
  'research.md','privacy.md','troubleshooting.md','limitations.md','test-report.md',
  'test-coverage.md','authorization-fix.md','card-warning-fix.md','token-expiration.md',
  'screenshots/light-desktop-confirmation.png','screenshots/dark-mobile-confirmation.png',
  'screenshots/modern-historical-mention.png',
  'screenshots/settings-expiration-light.png','screenshots/settings-expiration-dark-mobile.png',
];
for(const file of publicDocs)sources.push({name:`docs/${file}`,data:await readFile(path.join('docs',file))});
for(const file of ['README.md','package.json','package-lock.json','tsconfig.json','.gitignore'])sources.push({name:file,data:await readFile(file)});
const checksums=[];
checksums.push(await zip(`release/trello-guest-awareness-${version}.zip`,extension));
checksums.push(await zip(`release/trello-guest-awareness-${version}-source.zip`,sources));
await writeFile('release/SHA256SUMS.txt',checksums.join('\n')+'\n');
console.log(checksums.join('\n'));
