import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {artworkPrompts} from '../tools/artwork-prompts.mjs';
const manifest=JSON.parse(readFileSync(new URL('../skins/qingkong-xinjian/manifest.json',import.meta.url),'utf8'));
test('artwork plan deduplicates shared roles and asks for transparent UI assets at their actual display size',()=>{
 const plan=artworkPrompts(manifest);assert.equal(plan.tasks.length,manifest.assets.length);
 const markers=plan.tasks.filter(task=>task.roles.some(role=>role.endsWith('Marker')));
 assert.equal(markers.length,6);for(const task of markers){assert.equal(task.transparent_background,true);assert.match(task.prompt,/24×24/);}
 const frame=plan.tasks.find(task=>task.roles.includes('panelFrame'));assert.ok(frame.roles.includes('controlFrame'));assert.equal(frame.transparent_background,true);
 const backdrop=plan.tasks.find(task=>task.roles.includes('mapBackdrop'));assert.equal(backdrop.transparent_background,false);assert.match(backdrop.prompt,/安静区域/);
 const avatar=plan.tasks.find(task=>task.roles.includes('avatarFrame'));assert.match(avatar.prompt,/四角透明/);assert.match(avatar.prompt,/38–48/);
});
test('generation plan rejects reusing the square window frame as an avatar',()=>{
 const bad=structuredClone(manifest);bad.theme.assets.avatarFrame=bad.theme.assets.windowFrame;
 assert.throws(()=>artworkPrompts(bad),/AVATAR_NEEDS_OWN_FRAME/);
});
