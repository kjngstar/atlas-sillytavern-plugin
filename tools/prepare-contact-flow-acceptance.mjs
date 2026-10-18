/** Prepare an isolated SQL acceptance world and serve the actual release UI. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import initSql from 'sql.js';
import {makeContactFlowSeed} from '../tests/fixtures/atlas-sql/contact-flows.mjs';
import {encodeSnapshot} from '../src/atlas-db-envelope.ts';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.join(root,'.tmp','contact-flow-acceptance');
const release=path.join(root,'release','atlas-ui-extension');
if(!fs.existsSync(path.join(release,'dist','atlas-ui-core.mjs')))throw Error('Run npm run pack first');
const seed=await makeContactFlowSeed(await initSql());
try{
 const database=await encodeSnapshot(seed.db.export(),{chatUid:seed.chatUid,worldUid:'contact-flow-acceptance',activeBranchId:seed.branchId,storageRevision:1});
 fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'contact-flow-snapshot.json'),JSON.stringify({atlas:{database,sqlChatEnabled:true}}));
 fs.copyFileSync(path.join(root,'tools','acceptance','contact-flow-native.html'),path.join(output,'contact-flow-native.html'));
}finally{seed.close();}
console.log('Synthetic SQL acceptance data prepared. Real Tavern chats are not accessed.');
if(process.argv.includes('--serve')){
 const requestedPort=process.argv.find(arg=>arg.startsWith('--port='))?.slice(7)??'8790';
 const port=Number(requestedPort);
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
 const mime={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.png':'image/png'};
 const server=http.createServer((req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  try{
   const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
   const synthetic=name==='/ui/contact-flow-native.html'||name==='/ui/contact-flow-snapshot.json';
   const base=synthetic?output:release;
   const file=synthetic?path.join(output,path.basename(name)):path.resolve(release,'.'+name);
   const relative=path.relative(base,file);
   if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store'});
   if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
  }catch{res.writeHead(400);res.end();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 console.log(`Open in a browser: http://127.0.0.1:${server.address().port}/ui/contact-flow-native.html`);
 console.log('Only the packaged extension and synthetic fixture are served. Stop with Ctrl+C.');
}
