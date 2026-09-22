/**
 * atlas-fixtures.mjs — R00 验收夹具（不含私人聊天）。
 *
 * 计划书 §6 R00 要求的四套夹具：
 * 1. 空世界开局（starter world，无剧情）
 * 2. 截图式废墟相遇（开局文本「羽风站在废墟深处。一名未报姓名的少女正在他身旁。」）
 * 3. 已有多 NPC 世界（多人物多地点，含账本事件）
 * 4. 多层子图带底图（点 + 子图引用 + 底图 dataURL 占位）
 *
 * 全部为纯数据构造，不依赖网络与随机；供 R05–R13 验收测试复用。
 */

import { buildStarterWorld } from "../../../src/atlas-starter-world.ts";

const NOW = 1758600000000; // 固定时间戳，保证确定性

/** 1) 空世界开局：只有起点占位 + 主角实体，无任何剧情事件。 */
export function fixtureEmptyWorld() {
  return { world: buildStarterWorld({ id: "fx-empty", now: NOW, name: "空世界" }), now: NOW };
}

/** 2) 截图式废墟相遇：世界仍是起点，剧情文本已把玩家写在废墟深处。 */
export function fixtureRuinsEncounter() {
  const world = buildStarterWorld({ id: "fx-ruins", now: NOW, name: "废墟相遇" });
  return {
    world,
    now: NOW,
    conversation: {
      userText: "环顾四周",
      assistantText: "羽风站在废墟深处。一名未报姓名的少女正在他身旁。",
      expected: {
        newLocationName: "废墟深处",
        newCharacterDisplayName: "未具名少女",
        sceneTransition: "initial",
      },
    },
  };
}

/** 3) 已有多 NPC 世界：3 个地点 + 3 个 NPC + 账本移动事件。 */
export function fixtureMultiNpcWorld() {
  const world = buildStarterWorld({ id: "fx-multi", now: NOW, name: "多NPC世界" });
  world.points.push(
    { id: 2, name: "市集", x: 70, y: 40, regionId: "start" },
    { id: 3, name: "城门", x: 30, y: 70, regionId: "start" },
  );
  world.characters.push(
    { id: "npc-merchant", worldId: world.id, name: "商贩", role: "配角", description: "市集上的小贩。", currentRegionId: "start" },
    { id: "npc-guard", worldId: world.id, name: "守卫", role: "配角", description: "驻守城门。", currentRegionId: "start" },
    { id: "npc-girl", worldId: world.id, name: "少女", role: "配角", description: "身份不明。", currentRegionId: "start" },
  );
  return { world, now: NOW };
}

/** 4) 多层子图带底图：世界图 → 建筑子图 → 房间，附 1×1 dataURL 底图占位。 */
export function fixtureMultiLayerWorld() {
  const world = buildStarterWorld({ id: "fx-layers", now: NOW, name: "多层世界" });
  world.points.push(
    { id: 2, name: "酒馆", x: 60, y: 60, regionId: "start" },
    { id: 3, name: "吧台", x: 40, y: 40, regionId: "start" },
  );
  // 最小合法 1×1 透明 PNG（43 字节），不引外部资源
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  world.mapImage = { imageDataUrl: pixel, revision: 1 };
  return { world, now: NOW, submaps: [{ id: "sub-tavern", name: "酒馆内部", parentPointId: 2, points: [3] }] };
}
