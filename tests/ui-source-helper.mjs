import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Resolve module imports when a real UI source is mounted through a data URL. */
export function readUiSource(path){
 // These jsdom suites cover the archived panel and shared host contracts.
 // The actual current UI is covered by atlas-reference-*.test and verify:workbench.
 const historical=readFileSync(new URL('./fixtures/legacy-ui/render-panel.js.txt',import.meta.url),'utf8');
 const current=readFileSync(path,'utf8').replaceAll('\r\n','\n').replace(/function renderPanel\([\s\S]*?\n}\n/, '');
 return (historical.replace('function renderHistoricalPanel(', 'function renderPanel(')+'\n'+current).replace(/(from\s+["'])\.\/ui\/([^"']+)(["'])/g,
  (_,prefix,file,suffix)=>prefix+pathToFileURL(resolve(dirname(path),'ui',file)).href+suffix);
}
