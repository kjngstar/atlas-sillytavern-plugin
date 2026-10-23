import {mkdirSync,readdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

/** ui is generated from the authoritative source; remove retired files on incremental builds. */
export function syncUiTree(source,target,{write=writeFileSync}={}){
 mkdirSync(target,{recursive:true});
 const entries=readdirSync(source,{withFileTypes:true}),names=new Set(entries.map(e=>e.name));
 for(const name of readdirSync(target))if(!names.has(name))rmSync(join(target,name),{recursive:true,force:true});
 for(const entry of entries){const from=join(source,entry.name),to=join(target,entry.name);if(entry.isDirectory())syncUiTree(from,to,{write});else write(to,readFileSync(from));}
}
