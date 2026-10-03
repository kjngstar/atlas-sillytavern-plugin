// Standalone release asset test. Serves only built files; no SillyTavern or model requests.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = resolve(root, 'release/atlas-ui-extension');
const requests = [];
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.push(pathname);
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Atlas SQL release verification</title>'); return; }
  const file = resolve(release, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(`${release}${sep}`) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript');
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.ATLAS_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  const outgoing = [];
  page.on('request', req => outgoing.push(req.url()));
  await page.goto(origin);
  const main = await page.evaluate(async () => {
    const mod = await import('/dist/atlas-sql.mjs');
    const metadata = {};
    let saves = 0;
    const session = await mod.openSqlSession({ chatUid: 'release_verification', chatMetadata: metadata,
      saveSession: async () => { saves++; return true; } });
    const tables = mod.userTableNames(session.repo.db);
    const fk = mod.queryBound(session.repo.db, 'PRAGMA foreign_keys')[0].foreign_keys;
    const size = (await session.repo.exportCurrent()).length;
    await mod.closeSqlSession(session);
    return { tables: tables.length, fk, size, saves, metadataUnchanged: Object.keys(metadata).length === 0 };
  });
  assert.equal(main.tables, 20); assert.equal(main.fk, 1); assert.ok(main.size > 1000);
  assert.equal(main.saves, 0); assert.equal(main.metadataUnchanged, true);
  const worker = await page.evaluate(async () => {
    const worker = new Worker('/dist/atlas-sql-worker.js');
    const pending = new Map(); let seq = 0;
    worker.onmessage = event => {
      const row = event.data;
      const waiter = pending.get(row.requestId);
      if (!waiter) return;
      pending.delete(row.requestId);
      if (row.error) waiter.reject(Error(JSON.stringify(row.error))); else waiter.resolve(row.result);
    };
    const send = row => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(row.requestId); reject(Error('Worker SQL timeout')); }, 10000);
      pending.set(row.requestId, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      worker.postMessage(row);
    });
    try {
      await send({ type: 'init', requestId: 'init', options: { chatUid: 'release_worker' } });
      await send({ type: 'request', requestId: `r${++seq}`, method: 'open', payload: {} });
      const exported = await send({ type: 'request', requestId: `r${++seq}`, method: 'export', payload: {} });
      await send({ type: 'request', requestId: `r${++seq}`, method: 'close', payload: {} });
      return { bytes: exported.byteLength, header: atob(exported.base64).slice(0, 15) };
    } finally { worker.terminate(); }
  });
  assert.ok(worker.bytes > 1000); assert.equal(worker.header, 'SQLite format 3');
  assert.ok(requests.filter(path => path === '/dist/vendor/sql-wasm.wasm').length >= 2);
  assert.equal(requests.some(path => path.includes('sql-wasm-browser.wasm')), false);
  assert.ok(outgoing.every(url => url.startsWith(origin)));
  console.log(JSON.stringify({ passed: true, main, worker, wasmRequests: requests.filter(path => path.endsWith('.wasm')) }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
