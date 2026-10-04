import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Resolve module imports when a real UI source is mounted through a data URL. */
export function readUiSource(path){
 return readFileSync(path,'utf8').replace(/(from\s+["'])\.\/ui\/([^"']+)(["'])/g,
  (_,prefix,file,suffix)=>prefix+pathToFileURL(resolve(dirname(path),'ui',file)).href+suffix);
}
