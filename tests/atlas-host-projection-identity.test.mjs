import test from 'node:test';
import assert from 'node:assert/strict';
import {atlasFloorIdentity,atlasNarrativeIdentityText} from '../ui/atlas-host-context.mjs';

const projection=value=>`\n\n<!-- qrf-world-simulation-projection:v2:start -->\n<div hidden class="qrf-world-simulation-projection" style="display:none">${value}</div>\n<!-- qrf-world-simulation-projection:v2:end -->`;
const floor=text=>({is_user:false,mes:text,swipe_id:0,swipes:[text]});
test('appending or replacing shujuku guidance does not change the visible story identity',()=>{
 const base='主角留在大厅。',a=atlasFloorIdentity(floor(base),1),b=atlasFloorIdentity(floor(base+projection('后台信号')),1);
 assert.deepEqual(a,b);
 assert.deepEqual(a,atlasFloorIdentity(floor(base+projection('另一个后台信号')),1));
 assert.equal(atlasNarrativeIdentityText(base+projection('后台信号')),base);
 assert.notEqual(a.contentHash,atlasFloorIdentity(floor('主角进入工具库。'+projection('后台信号')),1).contentHash);
 const swipe=floor(base+projection('后台信号'));swipe.swipe_id=1;swipe.swipes.push(swipe.mes);
 assert.notEqual(a.variantKey,atlasFloorIdentity(swipe,1).variantKey);
});
test('ordinary HTML, incomplete or mismatched projection blocks and user messages stay significant',()=>{
 for(const text of ['<div hidden>真实资料</div>','<!-- qrf-world-simulation-projection:v2:start -->未结束',
  '<!-- qrf-world-simulation-projection:v2:start -->资料<!-- qrf-world-simulation-projection:v1:end -->'])
  assert.equal(atlasNarrativeIdentityText(text),text);
 assert.notEqual(atlasFloorIdentity({is_user:true,mes:'行动'},0).contentHash,
  atlasFloorIdentity({is_user:true,mes:'行动'+projection('用户原文')},0).contentHash);
});
