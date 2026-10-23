import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Resolve module imports when a real UI source is mounted through a data URL. */
export function readLegacyUiSource(path){
 // These jsdom suites cover the archived panel and shared host contracts.
 // The actual current UI is covered by atlas-reference-*.test and verify:workbench.
 const skin=readFileSync(new URL('./fixtures/legacy-ui/skin.mjs',import.meta.url),'utf8');
 const support=readFileSync(new URL('./fixtures/legacy-ui/panel-support.js.txt',import.meta.url),'utf8');
 const historical=readFileSync(new URL('./fixtures/legacy-ui/render-panel.js.txt',import.meta.url),'utf8');
 const current=readFileSync(path,'utf8').replaceAll('\r\n','\n').replace(/function renderPanel\([\s\S]*?\n}\n/, '');
 return (skin+'\n'+support+'\n'+historical.replace('function renderHistoricalPanel(', 'function renderPanel(')+'\n'+current).replace(/(from\s+["'])\.\/ui\/([^"']+)(["'])/g,
  (_,prefix,file,suffix)=>prefix+pathToFileURL(resolve(dirname(path),'ui',file)).href+suffix).replace(/(from\s+["'])\.\/legacy-modules\/([^"']+)(["'])/g,
  (_,prefix,file,suffix)=>prefix+new URL('./fixtures/legacy-ui/modules/'+file,import.meta.url).href+suffix);
}
