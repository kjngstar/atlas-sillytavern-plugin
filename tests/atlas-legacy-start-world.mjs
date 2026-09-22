/**
 * atlas-legacy-start-world.mjs — 旧存档形状夹具（0.9.51「空地理」之前的自动建世产物）。
 *
 * R06 之后 `buildStarterWorld()` 产出**空地理**（0 地区 / 0 地点，currentRegionId=null）：
 * 系统占位「起点」不再生成。但两拨测试仍然需要旧形状：
 * - 占位指纹 / retired 迁移 / 重名跳过：对象就是「老存档里那个起点」；
 * - 移动耗时 / presence / 统一视图：需要一个已存在的起点作为移动起点。
 *
 * 本夹具原样复刻旧 buildStarterWorld 的地理部分，供上述用例使用；
 * 新世界形状的断言一律走 buildStarterWorld，不许反向依赖这里。
 */

export function legacyStartWorld(options = {}) {
  const id = options.id ?? "world-legacy";
  const now = options.now ?? 1;
  const cardName = (options.name ?? "").trim().slice(0, 60);
  const worldName = cardName ? `${cardName} 的世界` : "新世界";
  const description = (options.description ?? "").trim().slice(0, 2000);
  return {
    schemaVersion: 1,
    id,
    name: worldName,
    description,
    currentRegionId: "start",
    currentYear: 1,
    createdAt: now,
    updatedAt: now,
    regions: [
      {
        id: "start",
        worldId: id,
        name: "起点",
        type: "other",
        description: description ? description.slice(0, 500) : "故事开始的地方。",
        coordinates: { x: 0, y: 0 },
      },
    ],
    points: [{ id: 1, name: "起点", x: 50, y: 50, regionId: "start" }],
    characters: [
      {
        id: "char-main",
        worldId: id,
        name: cardName || "主角",
        role: "主角",
        description: description.slice(0, 1000),
        currentRegionId: "start",
      },
    ],
  };
}
