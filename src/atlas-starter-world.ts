/**
 * atlas-starter-world.ts — 0.8.2 首条消息自动建世（shujuku 式「开卡即玩」）。
 *
 * 作者 2026-09-19 反馈：「导入世界 JSON 很多余——打开角色卡、第一次发消息时
 * 就该开始建立世界观。」本模块提供**最小合法世界**的构造器：
 * - 世界名取自当前角色卡；角色卡描述存为世界描述与主角档案；
 * - 1 个地区（起点）+ 1 个地点（起点）+ 1 个主角实体；
 * - 世界观随回合推演逐步生长（每轮 commit 的 lorebook 规划会往 Atlas 世界书写条目）。
 *
 * 产出必须能通过 lib/world-schema.ts 的 parseWorld（/worlds/import 服务端校验同款），
 * 因此字段集保持最小、类型严格对齐 schema；任何扩展字段都先过 schema 再加。
 */

import type { World } from "../lib/world-schema.ts";

export interface StarterWorldOptions {
  /** 世界 id（index.js 用 world-${Date.now()}；调用方保证唯一）。 */
  id: string;
  /** 创建时间戳（createdAt / updatedAt）。 */
  now: number;
  /** 角色卡名（酒馆 name2）；缺省回退「新世界」。 */
  name?: string | null;
  /** 角色卡描述（character.description）；可为空。 */
  description?: string | null;
}

const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 2000;

/** 由角色卡信息构造最小合法世界（parseWorld 必过；失败只会来自调用方传入非法 id）。 */
export function buildStarterWorld(options: StarterWorldOptions): World {
  const cardName = (options.name ?? "").trim().slice(0, MAX_NAME_CHARS);
  const worldName = cardName ? `${cardName} 的世界` : "新世界";
  const description = (options.description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARS);
  return {
    schemaVersion: 1,
    id: options.id,
    name: worldName,
    description,
    currentRegionId: "start",
    currentYear: 1,
    createdAt: options.now,
    updatedAt: options.now,
    regions: [
      {
        id: "start",
        worldId: options.id,
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
        worldId: options.id,
        name: cardName || "主角",
        role: "主角",
        description: description.slice(0, 1000),
        currentRegionId: "start",
      },
    ],
  };
}
