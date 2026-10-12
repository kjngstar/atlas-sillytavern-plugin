import test from 'node:test';
import assert from 'node:assert/strict';
import { IDS, makeSeedWith } from './fixtures/atlas-sql/seed.mjs';
import { loadSqlModule } from '../src/atlas-db-runtime.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { locationSpaceSize, resolveMapSpaceSize } from '../src/atlas-space-canonical.ts';

const SQL = await loadSqlModule();
for (const mpp of [0.24, 100]) {
  test(`确认 SQL 格轮廓在 mpp=${mpp} 时按所属父图换算物理尺寸`, async () => {
    const seed = await makeSeedWith(SQL);
    try {
      const db = seed.db;
      db.run('UPDATE maps SET scale_min_meters_per_cell=NULL,scale_max_meters_per_cell=NULL,meters_per_cell=? WHERE branch_id=? AND id=?', [mpp, IDS.branchMain, IDS.M2]);
      const area = {kind:'polygon', quality:'confirmed', points:[
        {x:0,y:0}, {x:8/mpp,y:0}, {x:8/mpp,y:6/mpp}, {x:0,y:6/mpp},
      ]};
      db.run('UPDATE locations SET map_id=?,area_geometry_json=? WHERE branch_id=? AND id=?',
        [IDS.M2, JSON.stringify(area), IDS.branchMain, IDS.L3]);
      const tables = createTableReadPort(db);
      const maps = tables.selectWhere('maps', {branch_id:IDS.branchMain});
      const locations = tables.selectWhere('locations', {branch_id:IDS.branchMain});
      const local = locationSpaceSize({maps,locations,locationId:IDS.L3,branchId:IDS.branchMain});
      assert.equal(local.widthM, 8);
      assert.equal(local.heightM, 6);
      const child = resolveMapSpaceSize({maps,locations,branchId:IDS.branchMain,
        mapRow:{id:'unit-child',container_location_id:IDS.L3,meters_per_cell:999}});
      assert.equal(child.resolution.widthM, 8, '使用父图尺度，不能用子图尺度');
      assert.equal(child.resolution.heightM, 6);
      assert.equal(child.resolution.quality, 'confirmed');
    } finally { seed.close(); }
  });
}

test('所属图未标定时，确认格轮廓不能被认作确认米制尺寸', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    seed.db.run('UPDATE maps SET meters_per_cell=NULL WHERE branch_id=? AND id=?', [IDS.branchMain, IDS.M2]);
    seed.db.run('UPDATE locations SET map_id=?,area_geometry_json=? WHERE branch_id=? AND id=?',
      [IDS.M2,JSON.stringify({kind:'polygon',quality:'confirmed',points:[
        {x:0,y:0},{x:8,y:0},{x:8,y:6},{x:0,y:6}]}), IDS.branchMain, IDS.L3]);
    const tables = createTableReadPort(seed.db);
    const resolved = resolveMapSpaceSize({maps:tables.selectWhere('maps',{branch_id:IDS.branchMain}),
      locations:tables.selectWhere('locations',{branch_id:IDS.branchMain}),branchId:IDS.branchMain,
      mapRow:{id:'unit-child',container_location_id:IDS.L3},firstEstimate:{widthM:12,heightM:10}});
    assert.equal(resolved.resolution.source,'first-estimate');
    assert.equal(resolved.resolution.quality,'estimated');
    assert.equal(resolved.resolution.widthM,12);
  } finally { seed.close(); }
});
