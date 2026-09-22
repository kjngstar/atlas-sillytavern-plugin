/**
 * atlas-starter-world.ts — 0.8.2 首条消息自动建世（shujuku 式「开卡即玩」）。
 *
 * 作者 2026-09-19 反馈：「导入世界 JSON 很多余——打开角色卡、第一次发消息时
 * 就该开始建立世界观。」本模块提供**最小合法世界**的构造器：
 * - 世界名取自当前角色卡；角色卡描述存为世界描述与主角档案；
 * - **空地理**：0 地区 + 0 地点（R06：核心 schema 的 regions / points 均为可选，
 *   空数组合法；旧实现的「起点」地点是系统占位而不是地理事实）。
 *   第一轮推演的场景识别会产出真实地点，地图由剧情生长，不需要占位兜底。
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

// 64 位 FNV-1a 常量（ATLAS-18：确定性 world ID 的哈希基座）
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * ATLAS-18：同一聊天 ⇒ 同一世界 ID（首条消息自动建世必须确定性，禁 `world-${Date.now()}`）。
 *
 * - UTF-8 字节上的 64 位 FNV-1a → `world-auto-<16 位十六进制>`；
 * - 不暴露原 chatId（哈希单向），不依赖时间与随机；
 * - 同聊天重复触发（并发、重试、刷新）永远得到同一个世界，天然幂等。
 */
export function starterWorldIdForChat(chatId: string): string {
  const bytes = new TextEncoder().encode(typeof chatId === "string" ? chatId : "");
  let hash = FNV_OFFSET_64;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return `world-auto-${hash.toString(16).padStart(16, "0")}`;
}

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
    // R06：未知地区用 null，不造「起点」兜底地点。地点由推演的场景识别产出。
    currentRegionId: null,
    currentYear: 1,
    createdAt: options.now,
    updatedAt: options.now,
    regions: [],
    points: [],
    characters: [
      {
        id: "char-main",
        worldId: options.id,
        name: cardName || "主角",
        role: "主角",
        description: description.slice(0, 1000),
        currentRegionId: null,
      },
    ],
  };
}
