import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Only text notes below the explicitly selected root. Symlinks, hidden paths and
// unsupported files never enter capture. A bounded scan is repeatable/idempotent.
export async function scanKnowledgeFolder(root, {exclude = [], maxFiles = 100} = {}) {
  if (!path.isAbsolute(root) || !Array.isArray(exclude) || !exclude.every(x=>typeof x==='string')) throw Error('Use an absolute folder and text exclusion prefixes.');
  const resolved = path.resolve(root);
  // Reject symlink ancestors as well as entries encountered during traversal.
  for(let p=resolved;;p=path.dirname(p)) { if((await fs.lstat(p)).isSymbolicLink()) throw Error('Capture paths cannot contain symlinks.'); if(path.dirname(p)===p) break; }
  const entries=[], skipped=[];
  let truncated=false;
  async function visit(dir) {
    for(const item of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entries.length>=maxFiles){truncated=true;return;}
      const full=path.join(dir,item.name), relative=path.relative(resolved,full).split(path.sep).join('/');
      if(item.name.startsWith('.') || item.isSymbolicLink() || exclude.some(prefix=>relative===prefix || relative.startsWith(prefix+'/'))) {skipped.push(relative);continue;}
      if(item.isDirectory()){await visit(full);continue;}
      if(!item.isFile() || !['.md','.txt'].includes(path.extname(item.name).toLowerCase())){skipped.push(relative);continue;}
      const handle=await fs.open(full,'r');
      try {
        const stat=await handle.stat();
        if(stat.size>12000){skipped.push(relative);continue;}
        const bytes=await handle.readFile();
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        if(!text.trim())continue;
        entries.push({text,speaker:'unspecified',origin:`folder:${resolved}/${relative}`,recordedAt:stat.mtime.toISOString()});
      } finally {await handle.close();}
    }
  }
  await visit(resolved);
  return {entries,skipped,truncated,threadId:`folder-${createHash('sha256').update(resolved).digest('hex').slice(0,32)}`};
}
