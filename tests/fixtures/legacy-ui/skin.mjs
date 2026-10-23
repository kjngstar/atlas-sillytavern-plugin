/* Archived skin APIs for historical UI tests only. Current UI uses AtlasSkinRuntime. */
// ---------------------------------------------------------------------------
// 0.9.46 皮肤系统
// 机制 = style.css 的 .atlas-workbench 全部走 --aw-* 令牌；主题 = data-atlas-theme
// 属性切换令牌覆盖块；自定义皮肤 = 用户 CSS 覆盖任意令牌子集（注入 <style>）。
// 完整性由 tests/atlas-skin.test.mjs 门禁：style.css 定义的每个 --aw-* 必须在册。
// ---------------------------------------------------------------------------

/** 皮肤令牌注册清单（与 style.css .atlas-workbench 基座一一对应）。 */
export const ATLAS_SKIN_VARIABLES = [
  // 基座（0.9.46 之前既有）
  "--aw-paper",
  "--aw-panel",
  "--aw-ink",
  "--aw-teal",
  "--aw-teal-deep",
  "--aw-gold",
  "--aw-gold-soft",
  "--aw-gold-deep",
  "--aw-muted",
  "--aw-line",
  "--aw-rail-bg",
  "--aw-rail-text",
  "--aw-rail-dim",
  // 0.9.46 收敛新增（历史硬编码色 → 令牌）
  "--aw-ink-strong",
  "--aw-ink-soft",
  "--aw-danger",
  "--aw-danger-deep",
  "--aw-gold-busy",
  "--aw-teal-wash",
  "--aw-teal-wash-strong",
  "--aw-teal-line",
  "--aw-gold-wash",
  "--aw-gold-wash-strong",
  "--aw-gold-line",
  "--aw-gold-hairline",
  "--aw-veil",
  "--aw-veil-strong",
  "--aw-veil-soft",
  "--aw-veil-line",
  "--aw-input-bg",
  "--aw-input-dim",
  "--aw-input-disabled-bg",
  // 字体
  "--aw-serif",
  "--aw-sans",
];

/** 内置主题（id ↔ style.css 的 data-atlas-theme 值；"paper" 为缺省 = 无属性）。 */
export const ATLAS_SKIN_THEMES = [
  { id: "starmap", label: "星幕（默认）" },
  { id: "paper", label: "纸面" },
  { id: "dark", label: "深色战术" },
];

const ATLAS_CUSTOM_SKIN_LIMIT = 20000;

/** 规范化主题 id：未知值一律回退 "paper"。 */
export function normalizeAtlasSkinTheme(value) {
  return ATLAS_SKIN_THEMES.some((theme) => theme.id === value) ? value : "paper";
}

/**
 * 应用皮肤：主题属性挂根节点 + 自定义 CSS 注入 <style data-atlas-custom-skin>。
 * 幂等——重复调用只更新内容，不重复建节点。customCss 有界（≤20000 字符，超出截断）。
 */
export function applyAtlasSkin(root, { theme, customCss } = {}) {
  const normalized = normalizeAtlasSkinTheme(theme);
  if (root) {
    if (normalized === "paper") delete root.dataset.atlasTheme;
    else root.dataset.atlasTheme = normalized;
  }
  const css = typeof customCss === "string" ? customCss.slice(0, ATLAS_CUSTOM_SKIN_LIMIT) : "";
  if (typeof document === "undefined") return { theme: normalized, customCss: css };
  let styleTag = document.querySelector("style[data-atlas-custom-skin]");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.setAttribute("data-atlas-custom-skin", "");
    (document.head ?? document.body ?? root)?.append(styleTag);
  }
  styleTag.textContent = css;
  return { theme: normalized, customCss: css };
}

// ---------------------------------------------------------------------------
// 0.9.51（M07/M08）地图皮肤：--am-* 令牌注册表 + .atlas-map-skin.json 导入。
// 注册表是唯一权威（验证 / 默认 / 样例导出 / CSS 合约测试都从它派生，防多份清单漂移）。
// 继承优先级：工作台主题映射（--aw-*，含 paper/dark）→ 用户地图皮肤（--am-* 注入覆盖）
//   → 用户自定义 CSS（0.9.45 既有 <style data-atlas-custom-skin>，天然最后）。
// 皮肤只换外观：绝不触碰 metersPerCell / frame / 实体坐标 / 操作回调 / 标尺长度。
// ---------------------------------------------------------------------------

/** 地图皮肤令牌大小上限（纯令牌文件；计划 12.3 建议 64 KiB）。 */
export const ATLAS_MAP_SKIN_BYTES_MAX = 64 * 1024;
/** 令牌条数上限（注册表 31 键 + 余量；超限明确拒绝，不静默截断）。 */
export const ATLAS_MAP_SKIN_TOKENS_MAX = 64;

/** 颜色只接受 #hex（3/4/6/8 位）——不解释 rgb()/hsl()/named/任意 CSS 表达式。 */
const ATLAS_MAP_SKIN_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 地图皮肤令牌注册表：语义键 → {type, css, min/max 或 enum}。缺省令牌不注入（跟随工作台）。 */
export const ATLAS_MAP_SKIN_TOKENS = {
  "colors.canvas": { type: "color", css: "--am-canvas" },
  "colors.gridMinor": { type: "color", css: "--am-grid-minor" },
  "colors.text": { type: "color", css: "--am-text" },
  "colors.textMuted": { type: "color", css: "--am-text-muted" },
  "colors.border": { type: "color", css: "--am-border" },
  "colors.focusRing": { type: "color", css: "--am-focus-ring" },
  "colors.location": { type: "color", css: "--am-location" },
  "colors.person": { type: "color", css: "--am-person" },
  "colors.item": { type: "color", css: "--am-item" },
  "colors.popoverBg": { type: "color", css: "--am-popover-bg" },
  "colors.popoverHeaderBg": { type: "color", css: "--am-popover-header-bg" },
  "colors.rowHover": { type: "color", css: "--am-row-hover" },
  "colors.buttonBg": { type: "color", css: "--am-button-bg" },
  "colors.buttonText": { type: "color", css: "--am-button-text" },
  "colors.buttonHover": { type: "color", css: "--am-button-hover" },
  "colors.scaleText": { type: "color", css: "--am-scale-text" },
  "colors.scaleBg": { type: "color", css: "--am-scale-bg" },
  "colors.error": { type: "color", css: "--am-error" },
  "colors.estimated": { type: "color", css: "--am-estimated" },
  "metrics.popoverWidthPx": { type: "number", css: "--am-popover-width-px", min: 220, max: 480 },
  "metrics.popoverRadiusPx": { type: "number", css: "--am-popover-radius-px", min: 0, max: 24 },
  "metrics.controlRadiusPx": { type: "number", css: "--am-control-radius-px", min: 0, max: 16 },
  "metrics.controlHeightPx": { type: "number", css: "--am-control-height-px", min: 24, max: 56 },
  "metrics.bodyFontSizePx": { type: "number", css: "--am-body-font-size-px", min: 10, max: 20 },
  "metrics.titleFontSizePx": { type: "number", css: "--am-title-font-size-px", min: 11, max: 24 },
  "metrics.spacingPx": { type: "number", css: "--am-spacing-px", min: 2, max: 24 },
  "effects.shadow": { type: "enum", css: "--am-shadow", enum: ["none", "soft", "medium", "strong"] },
  "effects.motion": { type: "enum", css: "--am-motion", enum: ["none", "subtle", "normal"] },
  "fonts.family": { type: "enum", css: "--am-font-family", enum: ["system", "serif", "sans"] },
  "markers.locationShape": { type: "enum", css: "--am-marker-radius-location", enum: ["circle", "rounded-square", "square", "diamond"] },
  "markers.personShape": { type: "enum", css: "--am-marker-radius-person", enum: ["circle", "rounded-square", "square", "diamond"] },
  "markers.itemShape": { type: "enum", css: "--am-marker-radius-item", enum: ["circle", "rounded-square", "square", "diamond"] },
};

/** effects/shapes/fonts 的语义枚举 → 具体 CSS 值（转换层供值，用户字符串绝不直接拼接进 CSS）。 */
const ATLAS_MAP_SKIN_CSS_VALUES = {
  "--am-shadow": { none: "none", soft: "0 2px 8px rgba(31,42,51,0.14)", medium: "0 4px 14px rgba(31,42,51,0.18)", strong: "0 8px 24px rgba(31,42,51,0.28)" },
  "--am-motion": { none: "0s", subtle: "0.12s", normal: "0.25s" },
  "--am-font-family": { system: "var(--aw-sans)", serif: "var(--aw-serif)", sans: "var(--aw-sans)" },
  "--am-marker-radius-location": { circle: "50%", "rounded-square": "6px", square: "1px", diamond: "50% 0 50% 0" },
  "--am-marker-radius-person": { circle: "50%", "rounded-square": "6px", square: "1px", diamond: "50% 0 50% 0" },
  "--am-marker-radius-item": { circle: "50%", "rounded-square": "4px", square: "1px", diamond: "50% 0 50% 0" },
};

/**
 * 解析并校验 .atlas-map-skin.json（不可信输入；纯函数，可测）。
 * 返回 {ok:true, skin:{meta + tokens + unknownKeys}} 或 {ok:false, error, warnings}。
 * 纪律：未知版本明确拒绝；未知令牌不执行只提示；超范围数字 clamp 到边界；
 * 白名单逐键显式构造新对象——__proto__/constructor 等危险键天然进不了结果。
 */
export function parseAtlasMapSkin(raw) {
  if (typeof raw === "string") {
    if (raw.length > ATLAS_MAP_SKIN_BYTES_MAX) {
      return { ok: false, error: `皮肤文件超过 ${Math.round(ATLAS_MAP_SKIN_BYTES_MAX / 1024)} KiB 上限（纯令牌文件不该这么大）。`, warnings: [] };
    }
  }
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "皮肤文件不是合法 JSON。", warnings: [] };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "皮肤文件必须是 JSON 对象。", warnings: [] };
  }
  const record = value;
  if (record.kind !== "atlas-map-skin") {
    return { ok: false, error: "kind 必须是 \"atlas-map-skin\"（这不是阿特拉斯地图皮肤文件）。", warnings: [] };
  }
  if (record.schemaVersion !== 1 || record.skinApiVersion !== 1) {
    return { ok: false, error: `不支持的皮肤协议版本（schemaVersion=${JSON.stringify(record.schemaVersion)}，skinApiVersion=${JSON.stringify(record.skinApiVersion)}）——本插件支持版本 1。`, warnings: [] };
  }
  const meta = {
    id: String(record.id ?? "user.custom").trim().slice(0, 64) || "user.custom",
    name: String(record.name ?? "未命名地图皮肤").trim().slice(0, 40) || "未命名地图皮肤",
    version: String(record.version ?? "1.0.0").trim().slice(0, 16),
    author: String(record.author ?? "").trim().slice(0, 40),
    baseTheme: record.baseTheme === "dark" ? "dark" : record.baseTheme === "paper" ? "paper" : "",
  };
  const warnings = [];
  const rawTokens = record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens) ? record.tokens : {};
  const tokenKeys = Object.keys(rawTokens);
  if (tokenKeys.length > ATLAS_MAP_SKIN_TOKENS_MAX) {
    return { ok: false, error: `令牌条数超过上限（${tokenKeys.length} > ${ATLAS_MAP_SKIN_TOKENS_MAX}）。`, warnings: [] };
  }
  const tokens = {};
  for (const key of tokenKeys) {
    // 原型危险键：白名单查找查不到 → 落入 unknownKeys 提示，绝不进结果对象
    const spec = Object.prototype.hasOwnProperty.call(ATLAS_MAP_SKIN_TOKENS, key) ? ATLAS_MAP_SKIN_TOKENS[key] : null;
    if (!spec) {
      warnings.push(`未知令牌「${String(key).slice(0, 40)}」已忽略。`);
      continue;
    }
    const rawValue = rawTokens[key];
    if (spec.type === "color") {
      if (typeof rawValue !== "string" || !ATLAS_MAP_SKIN_COLOR_RE.test(rawValue.trim())) {
        warnings.push(`令牌「${key}」颜色值非法（只支持 #hex），已忽略。`);
        continue;
      }
      tokens[key] = rawValue.trim().toLowerCase();
    } else if (spec.type === "number") {
      const num = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (typeof rawValue !== "number" || !Number.isFinite(num)) {
        warnings.push(`令牌「${key}」必须是有限数字，已忽略。`);
        continue;
      }
      tokens[key] = Math.min(spec.max, Math.max(spec.min, num));
    } else {
      if (!spec.enum.includes(rawValue)) {
        warnings.push(`令牌「${key}」必须是 ${spec.enum.map((v) => `"${v}"`).join(" / ")} 之一，已忽略。`);
        continue;
      }
      tokens[key] = rawValue;
    }
  }
  return { ok: true, skin: { ...meta, tokens, unknownKeys: warnings.length, warnings } };
}

/** 已校验皮肤 → --am-* CSS 变量声明文本（枚举经转换层供值；未提供令牌不注入 = 跟随工作台）。 */
export function atlasMapSkinToCssVars(skin) {
  if (!skin || typeof skin !== "object") return "";
  const tokens = skin.tokens && typeof skin.tokens === "object" ? skin.tokens : {};
  const lines = [];
  for (const [key, value] of Object.entries(tokens)) {
    const spec = Object.prototype.hasOwnProperty.call(ATLAS_MAP_SKIN_TOKENS, key) ? ATLAS_MAP_SKIN_TOKENS[key] : null;
    if (!spec) continue;
    const cssValue = spec.type === "enum" ? ATLAS_MAP_SKIN_CSS_VALUES[spec.css]?.[value] : value;
    if (cssValue === undefined || cssValue === null || cssValue === "") continue;
    lines.push(`${spec.css}: ${cssValue};`);
  }
  return lines.join("\n    ");
}

/**
 * 应用地图皮肤：--am-* 变量注入 <style data-atlas-map-skin>（作用域 .atlas-workbench）。
 * skin = null → 移除注入（恢复跟随工作台主题）。幂等；系统减少动画时强制 0s。
 */
export function applyAtlasMapSkin(root, skin) {
  if (typeof document === "undefined") return skin ?? null;
  let styleTag = document.querySelector("style[data-atlas-map-skin]");
  const vars = atlasMapSkinToCssVars(skin);
  if (!vars) {
    styleTag?.remove();
    if (root) delete root.dataset.atlasMapSkin;
    return null;
  }
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.setAttribute("data-atlas-map-skin", "");
    (document.head ?? document.body ?? root)?.append(styleTag);
  }
  styleTag.textContent =
    `.atlas-workbench {\n    ${vars}\n  }\n` +
    `@media (prefers-reduced-motion: reduce) {\n    .atlas-workbench { --am-motion: 0s !important; }\n  }`;
  if (root) root.dataset.atlasMapSkin = String(skin.id ?? "custom");
  return skin;
}

/** 导出皮肤：只含主题元数据与允许的令牌（绝不包含聊天 / API 配置 / 密钥）。 */
export function exportAtlasMapSkin(skin) {
  const tokens = skin?.tokens && typeof skin.tokens === "object" ? skin.tokens : {};
  return JSON.stringify(
    {
      kind: "atlas-map-skin",
      schemaVersion: 1,
      skinApiVersion: 1,
      id: String(skin?.id ?? "user.custom"),
      name: String(skin?.name ?? "未命名地图皮肤"),
      version: String(skin?.version ?? "1.0.0"),
      author: String(skin?.author ?? ""),
      baseTheme: skin?.baseTheme === "dark" ? "dark" : skin?.baseTheme === "paper" ? "paper" : undefined,
      tokens,
    },
    null,
    2,
  );
}


/** 内置样例（M08 要求至少两个真实可导入样例）：深色战术风 / 浅色纸面风。 */
export const ATLAS_MAP_SKIN_PRESETS = [
  {
    kind: "atlas-map-skin",
    schemaVersion: 1,
    skinApiVersion: 1,
    id: "builtin.midnight-map",
    name: "夜色地图",
    version: "1.0.0",
    author: "Atlas 内置",
    baseTheme: "dark",
    tokens: {
      "colors.canvas": "#0d1017",
      "colors.gridMinor": "#202634",
      "colors.text": "#e6e8ee",
      "colors.textMuted": "#a5aec0",
      "colors.border": "#39445a",
      "colors.focusRing": "#92b5ff",
      "colors.location": "#5b8def",
      "colors.person": "#e8a757",
      "colors.item": "#b482c8",
      "colors.popoverBg": "#161a24",
      "colors.popoverHeaderBg": "#1d2230",
      "colors.rowHover": "#293248",
      "colors.buttonBg": "#1d2230",
      "colors.buttonText": "#e6e8ee",
      "colors.buttonHover": "#34415c",
      "colors.scaleText": "#e6e8ee",
      "colors.scaleBg": "#161a24",
      "colors.error": "#f08c8c",
      "colors.estimated": "#e8c27a",
      "metrics.popoverRadiusPx": 10,
      "metrics.controlRadiusPx": 6,
      "effects.shadow": "medium",
      "effects.motion": "subtle",
      "markers.locationShape": "rounded-square",
      "markers.itemShape": "diamond",
    },
  },
  {
    kind: "atlas-map-skin",
    schemaVersion: 1,
    skinApiVersion: 1,
    id: "builtin.parchment-map",
    name: "羊皮纸地图",
    version: "1.0.0",
    author: "Atlas 内置",
    baseTheme: "paper",
    tokens: {
      "colors.canvas": "#f6f0e0",
      "colors.gridMinor": "#e0d4b4",
      "colors.text": "#4a3d24",
      "colors.textMuted": "#8a7a55",
      "colors.border": "#c9b98a",
      "colors.focusRing": "#b8860b",
      "colors.location": "#fdfaf2",
      "colors.person": "#c9962a",
      "colors.item": "#8a5fa8",
      "colors.popoverBg": "#fffdf6",
      "colors.popoverHeaderBg": "#f3ecd8",
      "colors.rowHover": "#f0e8d0",
      "colors.scaleBg": "#fffdf6",
      "colors.scaleText": "#6b5a32",
      "colors.error": "#a83c3c",
      "colors.estimated": "#a8842c",
      "metrics.popoverRadiusPx": 4,
      "effects.shadow": "soft",
      "effects.motion": "subtle",
      "fonts.family": "serif",
      "markers.locationShape": "rounded-square",
      "markers.personShape": "circle",
    },
  },
];
