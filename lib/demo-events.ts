// LT-003 v1：演示世界模板数据集
// 设计：基础演示模板 + 1 个完整体验模板。完整体验模板额外含地点、正史、IF 与可阅读正文，
// 用于新用户在不改动自己世界的前提下体验完整工作流。
// 复用现有 hardcoded regions（north / capital / isles），仅做 events 多样化，避免动 schema
// schemaVersion 保持 1（events 字段 P0-006 已有，UIEvent 形状不变；UI-004 v1 加 characters: Character[]）

import type {
  UIEvent,
  Character,
  MapPoint,
  Region,
  Story,
  World,
  WorldTrigger,
  WorldAction,
  WorldOutcome,
  MapTravelSettings,
  CharacterMemory,
  CharacterState,
  StoryRuntime,
  StoryAgentSession,
} from "./world-schema";
import { SCHEMA_VERSION, normalizeEventIds } from "./world-schema.ts";
import type { StoryEntryAnchor } from "./world-schema.ts";

export type DemoTemplateId = "aurelia" | "aelan" | "stars" | "fog" | "chronicle";

export interface DemoTemplate {
  id: DemoTemplateId;
  name: string;
  description: string;
  defaultYear: number;
  events: Record<string, UIEvent[]>;
  // UI-004 v1：4 个人物（每个模板：1 主角 + 1 反派 + 2 配角），跨 3 地区
  characters: Character[];
  // B1 v1：每个模板独立的 3 个地区（不能与 Aurelia 共享；worldId 占位，新建时由 createNewWorld 替换）
  regions: Array<Omit<Region, "worldId">>;
  // LT-006：可选的地图地点与故事线。创建世界时深拷贝并把 worldId 改为新世界。
  points?: MapPoint[];
  stories?: Array<Omit<Story, "worldId">>;
  // --- W0-07：无需世界规则条目即可游玩的完整演示世界 ---
  // 地图标定：把可见网格转为可计算的旅行尺度，移动即可产生真实距离/时长（无需世界书）。
  mapTravelSettings?: MapTravelSettings;
  // 人物动态状态（与 Character 档案分离）：NPC 当前地区 / 地点 / 状态摘要。
  characterStates?: CharacterState[];
  // 人物记忆（含 branchId）：第一人称镜头按时间 + 分支过滤知识，不泄露未来/他人记忆。
  characterMemories?: CharacterMemory[];
  // 预置运行态：正史 / IF 创建后立即可游玩（带 currentTime / 当前地点 / 行动日志）。
  storyRuntimes?: StoryRuntime[];
  // 预置会话：两种阅读镜头（第一人称视觉小说 / 阅读式叙事）的演示预设。
  agentSessions?: StoryAgentSession[];
  // 可运行的事件钩子（世界书只负责静态设定，触发器才负责「这次会不会发生」）。
  triggers?: WorldTrigger[];
  // 预置已游玩的行动日志与结果：让演示世界的阅读镜头立即可见「已发生的事」。
  actions?: WorldAction[];
  outcomes?: WorldOutcome[];
  // N3：预置故事入口锚点（把导入卡放到地图 / 时间轴可进入的位置）
  entryAnchors?: StoryEntryAnchor[];
}

const aurelianEvents: Record<string, UIEvent[]> = {
  north: [
    { year: "312.04", title: "要塞陷落", summary: "黑潮军在暴雪中抵达城下，要塞守军在第三日城破。", branches: 3 },
    { year: "309.11", title: "寒鸦盟约", summary: "七位领主在无火大厅宣誓，共抗黑潮。", branches: 1 },
    { year: "307.02", title: "北境大疫", summary: "霜热病从边境村庄蔓延，三千人病亡。", branches: 0 },
    { year: "303.08", title: "白狼现世", summary: "守夜人报告城北雪原出现双头白狼。", branches: 2 },
    { year: "298.05", title: "寒铁开采", summary: "矿工在冰层下发现寒铁矿脉，可铸永不生锈的刀剑。", branches: 0 },
    { year: "295.12", title: "雪原狼群", summary: "狼群规模空前，袭击商队，迫使商路改道。", branches: 0 },
    { year: "291.07", title: "北境粮荒", summary: "连续两年歉收，北境出现饥荒。", branches: 0 },
    { year: "287.03", title: "守夜人叛乱", summary: "守夜人指挥官率部哗变，被镇压。", branches: 0 },
  ],
  capital: [
    { year: "312.06", title: "白塔政变", summary: "王冠在黎明前更换了主人，旧王被软禁。", branches: 4 },
    { year: "304.02", title: "开放天门", summary: "失传百年的浮空梯再度运转，星环城向天空开放。", branches: 0 },
    { year: "310.09", title: "御前会议", summary: "新王召开御前会议，重组内阁。", branches: 0 },
    { year: "308.11", title: "冬日祭典", summary: "一年一度的星环城冬日祭典，吸引十万游客。", branches: 0 },
    { year: "305.05", title: "白塔大火", summary: "白塔顶层失火，皇家图书馆三分之二藏书被毁。", branches: 2 },
    { year: "300.08", title: "御花园建成", summary: "新王下令在星环城中心修建御花园。", branches: 0 },
    { year: "296.10", title: "王后加冕", summary: "现任王后加冕，开启长达 20 年的盛世。", branches: 0 },
    { year: "292.04", title: "浮空议会", summary: "议会通过《浮空法案》，正式承认浮空城邦自治。", branches: 1 },
  ],
  isles: [
    { year: "313.01", title: "群舰叛乱", summary: "十二艘战舰熄灭帝国旗灯，宣布独立。", branches: 2 },
    { year: "298.08", title: "蓝鲸回游", summary: "海民在鲸鸣中找到了新航路。", branches: 1 },
    { year: "306.06", title: "潮汐神祭", summary: "海民举行三年一度的潮汐神祭，祈求风调雨顺。", branches: 0 },
    { year: "302.11", title: "无名之王", summary: "群岛出现一位自称无名之王的神秘人物。", branches: 3 },
    { year: "299.04", title: "海上丝路", summary: "群岛与南方大陆开通海上丝路，商贸繁荣。", branches: 0 },
    { year: "294.09", title: "海盗联盟", summary: "群岛海盗组成联盟，袭击帝国商船。", branches: 1 },
    { year: "289.12", title: "暴风季", summary: "连续 90 天暴风，群岛与世隔绝。", branches: 0 },
  ],
};

const aelanEvents: Record<string, UIEvent[]> = {
  north: [
    { year: "1120.05", title: "龙脊山会战", summary: "龙脊山三大部族联军与帝国先锋军决战。", branches: 2 },
    { year: "1118.09", title: "雪山朝圣", summary: "数千信徒徒步前往龙脊山朝圣。", branches: 0 },
    { year: "1115.11", title: "石巨人苏醒", summary: "矿工在雪山深处挖出沉睡千年的石巨人。", branches: 3 },
    { year: "1110.02", title: "永夜降临", summary: "龙脊山以北出现连续 30 天极夜。", branches: 1 },
    { year: "1105.07", title: "冰原商道", summary: "新开辟的冰原商道连通帝国与北方蛮族。", branches: 0 },
    { year: "1100.04", title: "北风之歌", summary: "吟游诗人传唱北风之歌，名动帝国。", branches: 0 },
    { year: "1095.10", title: "雪狼盟约", summary: "蛮族与帝国签订为期十年的雪狼盟约。", branches: 0 },
    { year: "1090.06", title: "雪山崩塌", summary: "龙脊山主峰崩塌，掩埋三个村庄。", branches: 1 },
  ],
  capital: [
    { year: "1121.01", title: "圣城加冕", summary: "新任大主教在圣城加冕，开启改革时代。", branches: 1 },
    { year: "1119.04", title: "金叶议会", summary: "帝国议会通过《金叶法案》，税制改革。", branches: 0 },
    { year: "1117.10", title: "白塔学园", summary: "帝国最高学府白塔学园建成，招收首批学生。", branches: 0 },
    { year: "1114.03", title: "圣战宣告", summary: "大主教宣告对异端发动圣战。", branches: 2 },
    { year: "1110.08", title: "圣城大火", summary: "圣城遭遇不明原因大火，半城被毁。", branches: 1 },
    { year: "1106.11", title: "金叶王朝", summary: "金叶王朝建立，结束了长达 50 年的乱世。", branches: 0 },
    { year: "1101.05", title: "金币发行", summary: "帝国发行统一金币，取代地方铸币。", branches: 0 },
    { year: "1096.09", title: "御前改制", summary: "新王推行御前改制，削弱贵族权力。", branches: 0 },
  ],
  isles: [
    { year: "1119.07", title: "海神祭典", summary: "群岛举行盛大海神祭典，祈求渔获丰收。", branches: 0 },
    { year: "1116.12", title: "深海渔场", summary: "群岛发现深海渔场，可支撑十年口粮。", branches: 0 },
    { year: "1112.04", title: "海盗之王", summary: "传说中的海盗之王再度现身，袭击商船。", branches: 2 },
    { year: "1108.08", title: "海市蜃楼", summary: "群岛海域出现持续一周的海市蜃楼。", branches: 1 },
    { year: "1103.02", title: "珊瑚迷宫", summary: "渔民发现海底珊瑚迷宫，疑为古代遗迹。", branches: 3 },
    { year: "1098.10", title: "海风之乱", summary: "群岛出现神秘海风，引发动乱。", branches: 0 },
    { year: "1092.05", title: "潮汐异变", summary: "群岛海域潮汐异变，渔村被迫迁移。", branches: 0 },
  ],
};

const starsEvents: Record<string, UIEvent[]> = {
  north: [
    { year: "2347.11", title: "极光站建成", summary: "人类在北极建成第一座极光观测站。", branches: 1 },
    { year: "2345.06", title: "冰下文明", summary: "科考队在冰层下发现疑似远古文明遗迹。", branches: 3 },
    { year: "2342.03", title: "极昼危机", summary: "北极出现持续 60 天的极昼，动植物异变。", branches: 0 },
    { year: "2338.10", title: "极光通讯", summary: "科学家发现极光可携带信号，实现跨极通讯。", branches: 0 },
    { year: "2335.04", title: "冰原基地", summary: "人类在冰原建成第一座永久基地。", branches: 0 },
    { year: "2330.09", title: "冰芯样本", summary: "科考队钻取百万年冰芯，发现气候周期。", branches: 0 },
    { year: "2326.01", title: "极夜实验", summary: "极夜期间进行的 30 天科学实验，成果丰硕。", branches: 0 },
  ],
  capital: [
    { year: "2348.02", title: "星际港落成", summary: "首都星际港落成，可同时停泊 100 艘飞船。", branches: 1 },
    { year: "2346.07", title: "联邦议会", summary: "人类联邦召开首次跨星球议会。", branches: 0 },
    { year: "2343.11", title: "时空跃迁", summary: "联邦科学家实现首次时空跃迁试航。", branches: 2 },
    { year: "2340.05", title: "能源革命", summary: "首都宣布掌握可控聚变，能源价格降至 1/100。", branches: 0 },
    { year: "2336.10", title: "星际联邦", summary: "地球、火星、木卫二联合组建星际联邦。", branches: 0 },
    { year: "2332.04", title: "首艘星舰", summary: "联邦首艘星舰「星环号」下水。", branches: 0 },
    { year: "2328.08", title: "轨道电梯", summary: "首都建成首条太空轨道电梯。", branches: 0 },
    { year: "2324.12", title: "首都迁都", summary: "人类正式将首都迁至新首都（现首都）。", branches: 0 },
  ],
  isles: [
    { year: "2347.08", title: "深空信号", summary: "木卫二接收疑似外星文明信号。", branches: 4 },
    { year: "2344.05", title: "海洋世界", summary: "探测器发现木卫二冰下海洋存在生命迹象。", branches: 2 },
    { year: "2341.09", title: "冰下基地", summary: "人类在木卫二冰下建成第一座研究基地。", branches: 0 },
    { year: "2337.03", title: "外星细菌", summary: "木卫二海洋中发现外星细菌，引发争议。", branches: 1 },
    { year: "2333.11", title: "冰下航行", summary: "无人潜艇完成木卫二冰下 100 公里航行。", branches: 0 },
    { year: "2329.06", title: "潮汐能站", summary: "木卫二建成首座潮汐能发电站。", branches: 0 },
    { year: "2325.10", title: "远航计划", summary: "联邦启动「远航计划」，目标半人马座。", branches: 0 },
  ],
};

const fogEvents: Record<string, UIEvent[]> = {
  north: [
    { year: "1923.10", title: "雾门开启", summary: "雾都北区的雾门传说中第一次被打开。", branches: 3 },
    { year: "1920.05", title: "北境探案", summary: "私家侦探接手北境失踪案，揭开百年阴谋。", branches: 2 },
    { year: "1918.02", title: "雾中小屋", summary: "北境发现一座无人小屋，屋内钟表停在凌晨 3 点。", branches: 1 },
    { year: "1915.09", title: "白色访客", summary: "北境居民报告看见白色访客，疑为亡灵。", branches: 2 },
    { year: "1912.04", title: "雾号列车", summary: "北境最后一班雾号列车神秘失踪。", branches: 1 },
    { year: "1908.11", title: "北境雾歌", summary: "吟游诗人传唱北境雾歌，凡听者皆泪流。", branches: 0 },
  ],
  capital: [
    { year: "1924.07", title: "雾都议会", summary: "雾都议会通过《雾中法案》，允许监控一切异象。", branches: 2 },
    { year: "1921.11", title: "侦探事务所", summary: "雾都最著名的侦探事务所开张。", branches: 0 },
    { year: "1919.06", title: "雾钟敲响", summary: "雾都中心的雾钟敲响十三声，预言末日。", branches: 3 },
    { year: "1917.03", title: "红衣女子", summary: "雾都红衣女子在多个地点同时出现，案件悬而未决。", branches: 2 },
    { year: "1914.10", title: "雾中剧院", summary: "雾都剧院上演《雾中奇谭》，观众席出现空椅。", branches: 1 },
    { year: "1910.08", title: "雾都建城", summary: "雾都正式建立，命名「雾都」以警示后人。", branches: 0 },
    { year: "1906.01", title: "大雾之夜", summary: "雾都遭遇史上最浓大雾，能见度不足 1 米。", branches: 0 },
  ],
  isles: [
    { year: "1922.04", title: "雾船迷航", summary: "群岛渔民发现一艘无人雾船，船上留有半瓶墨水。", branches: 2 },
    { year: "1919.09", title: "雾灯熄灭", summary: "群岛灯塔的雾灯同时熄灭，疑为超自然现象。", branches: 1 },
    { year: "1916.12", title: "无名岛", summary: "群岛海域出现一座无名岛，岛上有房屋但无人。", branches: 3 },
    { year: "1913.05", title: "海雾之门", summary: "渔民在海雾中发现一座门，跨过后回到过去。", branches: 2 },
    { year: "1910.10", title: "群岛雾咒", summary: "群岛遭受持续三年的雾咒，民不聊生。", branches: 1 },
    { year: "1907.02", title: "海雾升起", summary: "群岛海域首次记录到海雾升起现象。", branches: 0 },
  ],
};

// LT-006：这个模板不是把短摘要假装成小说，而是提供可在两种阅读器中阅读的事件正文。
// 覆盖路径：地图地点 → 地区 / 人物 / 时间轴 → 无故事线事件详情 → 单线事件 →
// 特异点事件的正史 + 两条 IF → 视觉小说 / 书籍阅读器。AI 连接不预置端点或密钥。
const completeExperienceEvents: Record<string, UIEvent[]> = {
  north: [
    {
      id: "chronicle-letter",
      year: "418.02",
      title: "霜原来信",
      summary: "雪线驿站送来一封没有署名的信：白塔将在七次月落后响起不该存在的第十三声。",
      content: "雪停在午夜。薇尔·星环站在雪线驿站的檐下，手里那封信没有蜡印，纸却仍带着温度。\n\n信上只写了一句话：\"第十三声响起时，不要让任何人握住钟锤。\"\n\n塔尔说这像个拙劣的圈套；薇尔却认出了信纸边缘的潮盐。群岛有人冒着封海，把答案送到了北境。她把信折回胸前，决定先去无火大厅。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c3"],
    },
    {
      id: "chronicle-hall",
      year: "418.04",
      title: "无火大厅",
      summary: "北境三位守望者在熄灭的壁炉前交出旧王留下的半枚钥匙。",
      content: "无火大厅没有窗，只有三面被烟熏黑的墙。守望者们把半枚钥匙放在石桌中央，钥匙的切面像一道没有愈合的伤。\n\n\"白塔的钟不是报时，\"最年长的守望者说，\"它在替某个世界记住没有发生过的事。\"\n\n薇尔收下钥匙时，远方冰原传来第一声鲸鸣。那声音不该越过群山，却准确地叫出了她的名字。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c3"],
    },
  ],
  capital: [
    {
      id: "chronicle-bell",
      year: "418.07",
      title: "白塔第十三声",
      summary: "白塔在正午敲响第十三声，整座王都在同一瞬间记起了彼此矛盾的昨天。",
      content: "第十二声结束后，王都所有的影子都先于人群转过了身。\n\n第十三声随即落下。市场里的母亲认得一个从未出生的孩子；卫兵拔剑，却说不清自己是在保护王冠还是推翻它。伊莱恩站在钟锤旁，像早已等候这一刻。\n\n薇尔将半枚钥匙嵌进钟座，听见海潮从石头深处涌来。她可以放下钟锤，让这座城忘记一切；也可以再敲一次，让所有被抹去的可能性都有名字。",
      branches: 2,
      singularity: true,
      characterIds: ["chronicle-c1", "chronicle-c2", "chronicle-c4"],
    },
    {
      id: "chronicle-key",
      year: "418.08",
      title: "钥匙交接",
      summary: "白塔钟声之后，伊莱恩将另一半钥匙交给薇尔，承认自己一直在阻止更坏的结局。",
      content: "钟声散去时，伊莱恩没有逃。他把另一半钥匙放在台阶上，手背满是被钟锤震裂的血痕。\n\n\"我不是来夺走王冠的，\"他说，\"我是来替所有已经失去王冠的你们守门。\"\n\n薇尔没有立刻相信他，却把钥匙拾起。两枚钥匙合拢的一刻，白塔地下的潮门显出一道细缝，缝隙另一端是正在退潮的群岛。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c2"],
    },
    {
      id: "chronicle-lantern",
      year: "418.10",
      title: "玻璃温室的灯",
      summary: "一个与主线无关的温室守夜人点亮旧灯，留下可单独阅读的事件详情样本。",
      content: "玻璃温室位于王都最安静的角落。钟声之后，守夜人把一盏从未点过的蓝灯挂在藤架上。\n\n他不知道白塔发生了什么，也不知道这盏灯会不会引来什么人；他只记得园丁曾说，世界越乱，越要给晚归的人留一扇看得见的窗。\n\n这不是任何故事线的一步。它只是一个地点、一个人和一个晚上留下的记录。",
      branches: 0,
      characterIds: ["chronicle-c2"],
    },
    {
      id: "chronicle-garden",
      year: "418.12",
      title: "静默花园",
      summary: "选择放下钟锤后，王都保住了秩序，却开始遗忘所有无法被证明的奇迹。",
      content: "薇尔放下钟锤。第十四声没有到来，王都的街道重新安静，仿佛那十三次震动只是集体的幻觉。\n\n只有温室里的蓝灯还在燃烧。赛芙说，海会记住这一天，但陆地会把它忘得很干净。\n\n薇尔把两枚钥匙埋进花园，决定让人们继续过平常的日子；代价是，那些本可以被拯救的世界线，只能在梦里敲门。",
      branches: 1,
      characterIds: ["chronicle-c1", "chronicle-c4"],
    },
    {
      id: "chronicle-fourteenth",
      year: "418.12",
      title: "第十四声之后",
      summary: "选择再敲一次钟后，王都看见了无数相互重叠的自己。",
      content: "第十四声没有声音。它像一滴墨落进水里，王都的每一扇窗都映出另一座王都。\n\n薇尔看见自己在不同的世界里戴冠、流亡、死去，又在每一次结尾回到钟座前。伊莱恩跪在石阶上，终于承认他怕的从来不是混乱，而是人们拥有选择。\n\n潮门彻底打开。赛芙在海那边唱起引航歌，歌里说：记得所有可能的人，必须亲手选择自己要失去哪一种。",
      branches: 1,
      characterIds: ["chronicle-c1", "chronicle-c2", "chronicle-c4"],
    },
  ],
  isles: [
    {
      id: "chronicle-departure",
      year: "418.11",
      title: "潮门启航",
      summary: "钥匙开启潮门，薇尔与赛芙驾船前往鲸骨档案馆寻找王都记忆的源头。",
      content: "潮门不是一扇门，而是一片竖起来的海。船穿过它时，甲板上的雪融成盐，北境的寒风从桅杆间退去。\n\n赛芙把耳朵贴在船舷上，说鲸群正在替所有迷路的世界唱同一首歌。塔尔第一次离开群山，却没有回头。\n\n他们驶向鲸骨档案馆。那里收藏的不是书，而是每一个被放弃的结局留下的骨白色回声。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c3", "chronicle-c4"],
    },
    {
      id: "chronicle-whale",
      year: "418.13",
      title: "鲸骨档案",
      summary: "档案馆证实白塔钟声是三百年前一场未完成的选择，且每个选择都仍在等待归属。",
      content: "鲸骨档案馆的穹顶像一艘倒扣的船。每一根骨梁都刻着一座已经不存在的城名。\n\n薇尔在最深处找到一页没有写完的航海日志：三百年前，有人第一次听见第十三声，却在敲下第十四声前把钟锤沉进海里。于是所有分歧被封存，没有消失。\n\n赛芙问薇尔：\"现在轮到你了。你是要替它们选一个结局，还是让每一个结局都自己活下去？\"",
      branches: 1,
      characterIds: ["chronicle-c1", "chronicle-c4"],
    },
    {
      id: "chronicle-return",
      year: "419.01",
      title: "归航的晨星",
      summary: "众人带着可被选择的未来回到王都，白塔不再替任何人决定结局。",
      content: "新年的第一束光穿过潮门时，王都的钟没有响。人们仍然记得混乱，也仍然记得彼此不同的昨天，但再没有谁要求另一个人忘掉。\n\n薇尔把两枚钥匙交给守夜人、园丁和船夫，让它们不再属于王冠，也不再属于白塔。\n\n晨星升起，赛芙说这不是最好的结局，只是一个被所有人共同写下的结局。薇尔望向海面，第一次相信未被选择的世界也许并没有死去。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c2", "chronicle-c3", "chronicle-c4"],
    },
  ],
};

const completeExperienceTemplate: DemoTemplate = {
  id: "chronicle",
  name: "完整体验 · 星环余烬",
  description: "可完整阅读的示例世界：3 地区、6 地点、10 事件、4 人物、1 条正史与 2 条 IF。用于体验地图、时间轴、事件详情、特异点与两种阅读器；不含 API 密钥。",
  defaultYear: 418,
  events: completeExperienceEvents,
  characters: [
    { id: "chronicle-c1", worldId: "demo", name: "薇尔·星环", role: "持钥人", description: "流亡王族的后裔。她想守住王都，却不愿再让一个人的选择替所有人决定未来。", currentRegionId: "capital", tags: ["主角", "持钥人", "王族"] },
    { id: "chronicle-c2", worldId: "demo", name: "伊莱恩·莫尔", role: "白塔守钟人", description: "看守第十三声多年的守钟人。他既是阻止者，也是把选择推到薇尔面前的人。", currentRegionId: "capital", tags: ["守钟人", "灰色角色", "白塔"] },
    { id: "chronicle-c3", worldId: "demo", name: "塔尔·霜铁", role: "北境守望者", description: "无火大厅的最后一位年轻守望者，习惯用最实际的方式保护看不见的承诺。", currentRegionId: "north", tags: ["北境", "守望者", "同伴"] },
    { id: "chronicle-c4", worldId: "demo", name: "赛芙·潮歌", role: "群岛引航人", description: "能听懂鲸鸣中的旧航线。她相信每个被放弃的结局都值得拥有自己的名字。", currentRegionId: "isles", tags: ["群岛", "引航人", "神秘"] },
  ],
  regions: [
    { id: "north", name: "霜线北境", type: "mountain", description: "雪线驿站与无火大厅所在的边境。这里的人负责守住王都不愿记起的旧约。", coordinates: { x: 28, y: 24 }, subtitle: "北境", tone: "#b7d1d1" },
    { id: "capital", name: "白塔王都", type: "city", description: "钟塔、玻璃温室与潮门都藏在这座曾经只相信唯一历史的城市里。", coordinates: { x: 54, y: 47 }, subtitle: "王都", tone: "#e4c77f" },
    { id: "isles", name: "鲸歌群岛", type: "sea", description: "潮门彼端的群岛；鲸骨档案馆在这里保存被放弃的可能性。", coordinates: { x: 77, y: 72 }, subtitle: "群岛", tone: "#85bcc8" },
  ],
  points: [
    { id: 4101, name: "雪线驿站", x: 20, y: 20, regionId: "north" },
    { id: 4102, name: "无火大厅", x: 34, y: 28, regionId: "north" },
    { id: 4103, name: "白塔钟座", x: 53, y: 42, regionId: "capital" },
    { id: 4104, name: "玻璃温室", x: 63, y: 54, regionId: "capital" },
    { id: 4105, name: "潮门港", x: 71, y: 68, regionId: "isles" },
    { id: 4106, name: "鲸骨档案馆", x: 82, y: 76, regionId: "isles" },
  ],
  stories: [
    {
      id: "chronicle-canon",
      mode: "canon",
      title: "正史 · 星环余烬",
      steps: [
        { eventId: "chronicle-letter", choice: null },
        { eventId: "chronicle-hall", choice: null },
        { eventId: "chronicle-bell", choice: null },
        { eventId: "chronicle-key", choice: null },
        { eventId: "chronicle-departure", choice: null },
        { eventId: "chronicle-return", choice: null },
      ],
      chapters: [
        { id: "chronicle-canon-c1", title: "第一章 · 雪线来信", fromStep: 0 },
        { id: "chronicle-canon-c2", title: "第二章 · 白塔回声", fromStep: 2 },
        { id: "chronicle-canon-c3", title: "第三章 · 潮门归航", fromStep: 4 },
      ],
    },
    {
      id: "chronicle-if-silence",
      mode: "if",
      title: "IF · 静默花园",
      parentStoryId: "chronicle-canon",
      divergenceEventId: "chronicle-bell",
      steps: [
        { eventId: "chronicle-letter", choice: null },
        { eventId: "chronicle-hall", choice: null },
        { eventId: "chronicle-bell", choice: "放下钟锤，保全沉默" },
        { eventId: "chronicle-garden", choice: "把钥匙埋进温室" },
        { eventId: "chronicle-return", choice: "让未被书写的名字随潮水离去" },
      ],
      chapters: [
        { id: "chronicle-if-silence-c1", title: "分歧 · 没有第十四声的夜", fromStep: 0 },
        { id: "chronicle-if-silence-c2", title: "结局 · 被保全的平静", fromStep: 3 },
      ],
    },
    {
      id: "chronicle-if-echo",
      mode: "if",
      title: "IF · 第十四声之后",
      parentStoryId: "chronicle-canon",
      divergenceEventId: "chronicle-bell",
      steps: [
        { eventId: "chronicle-letter", choice: null },
        { eventId: "chronicle-hall", choice: null },
        { eventId: "chronicle-bell", choice: "敲响第十四声，接受回响" },
        { eventId: "chronicle-fourteenth", choice: "允许所有可能性显形" },
        { eventId: "chronicle-whale", choice: "让每个结局自己寻找归宿" },
        { eventId: "chronicle-return", choice: "带着多重记忆归航" },
      ],
      chapters: [
        { id: "chronicle-if-echo-c1", title: "分歧 · 所有窗都映出另一座城", fromStep: 0 },
        { id: "chronicle-if-echo-c2", title: "结局 · 选择仍在继续", fromStep: 3 },
      ],
    },
  ],
  // --- W0-07：无需世界规则条目即可游玩的完整演示世界 ---
  // 地图标定：移动即可产生真实距离/时长，不依赖任何世界书条目。
  mapTravelSettings: {
    enabled: true,
    distancePerCell: 2,
    distanceUnit: "里",
    defaultSpeed: 8,
    terrainFactors: { north: 1.4, capital: 1, isles: 1.2 },
  },
  // 人物动态状态（与 Character 档案分离）：4 人物各处的当前地区/地点。
  characterStates: [
    { characterId: "chronicle-c1", currentRegionId: "capital", currentPointId: "4103", status: "持钥人，已在白塔钟座", updatedAt: 0 },
    { characterId: "chronicle-c2", currentRegionId: "capital", currentPointId: "4103", status: "白塔守钟人，等待第十三声", updatedAt: 0 },
    { characterId: "chronicle-c3", currentRegionId: "north", currentPointId: "4102", status: "无火大厅守望者", updatedAt: 0 },
    { characterId: "chronicle-c4", currentRegionId: "isles", currentPointId: "4105", status: "潮门引航人", updatedAt: 0 },
  ],
  // 人物记忆（含 branchId）：第一人称镜头按时间+分支过滤，不泄露未来/他人记忆。
  characterMemories: [
    {
      id: "chronicle-mem-c1-hall",
      characterId: "chronicle-c1",
      at: 418.04,
      content: "无火大厅里，三位守望者交出旧王留下的半枚钥匙；鲸鸣越过群山叫出了我的名字。",
      regionId: "north",
      pointId: "4102",
      eventId: "chronicle-hall",
      important: true,
      createdAt: 0,
      branchId: null,
    },
    {
      id: "chronicle-mem-c1-silence",
      characterId: "chronicle-c1",
      at: 418.12,
      content: "我放下钟锤，把两枚钥匙埋进温室花园——王都保住了秩序，却开始遗忘所有无法被证明的奇迹。",
      regionId: "capital",
      pointId: "4104",
      eventId: "chronicle-garden",
      important: true,
      createdAt: 0,
      branchId: "chronicle-if-silence",
    },
    {
      id: "chronicle-mem-c4-whale",
      characterId: "chronicle-c4",
      at: 418.13,
      content: "鲸骨档案馆证实：三百年前有人第一次听见第十三声，却在敲下第十四声前把钟锤沉进海里。",
      regionId: "isles",
      pointId: "4106",
      eventId: "chronicle-whale",
      important: true,
      createdAt: 0,
      branchId: "chronicle-if-echo",
    },
  ],
  // 预置运行态：正史 + 两条 IF 创建后立即可游玩（带当前时间/地点/日志）。
  storyRuntimes: [
    {
      storyId: "chronicle-canon",
      currentTime: 418.07,
      currentRegionId: "capital",
      currentPointId: "4103",
      worldFlags: ["bell-rung"],
      actionLog: ["act-c-letter", "act-c-hall", "act-c-bell"],
      updatedAt: 0,
    },
    {
      storyId: "chronicle-if-silence",
      currentTime: 418.12,
      currentRegionId: "capital",
      currentPointId: "4104",
      worldFlags: ["key-buried"],
      actionLog: [],
      snapshotFrom: "chronicle-canon",
      updatedAt: 0,
    },
    {
      storyId: "chronicle-if-echo",
      currentTime: 418.13,
      currentRegionId: "isles",
      currentPointId: "4106",
      worldFlags: ["echo-open"],
      actionLog: [],
      snapshotFrom: "chronicle-canon",
      updatedAt: 0,
    },
  ],
  // 预置会话：两种阅读镜头演示预设（第一人称视觉小说 / 阅读式叙事）。
  agentSessions: [
    {
      storyId: "chronicle-canon",
      presentationMode: "reader",
      knowledgeScope: "全知作者视角：展示整条正史分支",
      updatedAt: 0,
    },
    {
      storyId: "chronicle-if-silence",
      presentationMode: "firstPerson",
      viewpointCharacterId: "chronicle-c1",
      updatedAt: 0,
    },
    {
      storyId: "chronicle-if-echo",
      presentationMode: "firstPerson",
      viewpointCharacterId: "chronicle-c1",
      updatedAt: 0,
    },
  ],
  // 可运行事件钩子：抵达王都时触发「白塔余响」（不依赖世界书，演示触发路径）。
  triggers: [
    {
      id: "chronicle-trig-bell",
      enabled: true,
      title: "白塔余响",
      conditionSummary: "抵达王都（capital）时，钟座残留第十三声的回响",
      condition: { regionId: "capital" },
      outcomeTemplate: "钟座深处传来第十三声的余响，薇尔指尖一颤。",
      // N1：outcomeTags 与运行态 worldFlags 必须同名，否则「哪个行动产生了哪个标记」
      // 无法回溯，历史时点投影也就无法撤销锚点之后的标记。
      outcomeTags: ["bell-rung"],
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  // 预置已游玩行动：让「正史·星环余烬」的阅读镜头立即可见已发生的事（无需用户先手动游玩）。
  actions: [
    {
      id: "act-c-letter",
      at: 418.02,
      kind: "interact",
      actorId: "chronicle-c1",
      fromRegionId: "north",
      fromPointId: "4101",
      toRegionId: "north",
      toPointId: "4101",
      duration: 1,
      durationSource: "baseline",
      baselineVersion: "dtb-1",
      startedAt: 418.02,
      endedAt: 419.02,
      outcomeId: "out-c-letter",
    },
    {
      id: "act-c-hall",
      at: 418.04,
      kind: "move",
      actorId: "chronicle-c1",
      fromRegionId: "north",
      fromPointId: "4101",
      toRegionId: "north",
      toPointId: "4102",
      duration: 2,
      durationSource: "baseline",
      baselineVersion: "dtb-1",
      startedAt: 419.02,
      endedAt: 421.02,
      outcomeId: "out-c-hall",
    },
    {
      id: "act-c-bell",
      at: 418.07,
      kind: "choice",
      actorId: "chronicle-c1",
      fromRegionId: "capital",
      fromPointId: "4103",
      toRegionId: "capital",
      toPointId: "4103",
      duration: 1,
      durationSource: "baseline",
      baselineVersion: "dtb-1",
      startedAt: 421.02,
      endedAt: 422.02,
      outcomeId: "out-c-bell",
    },
  ],
  outcomes: [
    { id: "out-c-letter", actionId: "act-c-letter", kind: "nothing", result: "薇尔读到无火大厅的来信，决定前往北境。", reason: "已确收信件" },
    { id: "out-c-hall", actionId: "act-c-hall", kind: "nothing", result: "北境雪原，薇尔在无火大厅接过旧王留下的半枚钥匙。", reason: "抵达无火大厅" },
    // N1：changeRefs 记录「这个标记由哪次行动的结果产生」，历史时点投影据此撤销锚点之后的标记。
    { id: "out-c-bell", actionId: "act-c-bell", kind: "trigger", triggerId: "chronicle-trig-bell", result: "白塔第十三声落下；余响在钟座深处震动，王都记起了彼此矛盾的昨天。", reason: "抵达王都触发白塔余响", changeRefs: ["trigger:chronicle-trig-bell", "flag:bell-rung"] },
  ],
  // N3：预置一个「故事中段导入」入口锚点，演示地图 / 时间轴进入同一入口
  entryAnchors: [
    {
      id: "anc-chronicle-letter",
      sourceCardId: "chronicle-letter",
      cardType: "event",
      eventId: "chronicle-letter",
      at: 200.5,
      regionId: "north",
      pointId: "4101",
      x: 20,
      y: 20,
      entryPolicy: "import-moment",
      completenessNote: "中段导入：雪线来信的正文与北境背景",
      createdAt: 0,
    },
  ],
};

export const DEMO_TEMPLATES: DemoTemplate[] = [
  completeExperienceTemplate,
  {
    id: "aurelia",
    name: "Aurelia",
    description: "帝国末期 3 大地区：北境要塞、星环王都、潮汐群岛。30+ 事件覆盖政治、军事、宗教、神秘。",
    defaultYear: 312,
    events: aurelianEvents,
    // UI-004 v1：4 人物（主角 + 反派 + 2 配角），跨 3 地区
    characters: [
      { id: "aurelia-c1", worldId: "demo", name: "艾兰·星环", role: "末代公主", description: "星环王都末代公主，黑潮入侵后流亡北境，召集七领主抵抗。", currentRegionId: "north", tags: ["主角", "皇室", "法师"] },
      { id: "aurelia-c2", worldId: "demo", name: "黑潮将军", role: "反派首领", description: "北方黑潮军首领，真实身份为被流放的皇室血脉。", currentRegionId: "north", tags: ["反派", "将军", "皇室"] },
      { id: "aurelia-c3", worldId: "demo", name: "守夜人总长", role: "北境守将", description: "北境要塞守夜人总长，坚守要塞 30 年。", currentRegionId: "north", tags: ["配角", "军人"] },
      { id: "aurelia-c4", worldId: "demo", name: "群岛女祭司", role: "海神代言人", description: "潮汐群岛海神祭司，能听懂鲸鸣中的预言。", currentRegionId: "isles", tags: ["配角", "祭司", "神秘"] },
    ],
    // B1 v1：每个模板独立的 3 个地区（不能与 Aurelia 共享；worldId 占位由 createNewWorld 替换）
    regions: [
      { id: "north", name: "北境要塞", type: "mountain", description: "冬日王冠的最后防线，黑潮军三度叩关。", coordinates: { x: 35, y: 24 }, subtitle: "北境", tone: "#b6d9d1" },
      { id: "capital", name: "星环王都", type: "city", description: "帝国心脏与浮空之城，白塔议事厅所在。", coordinates: { x: 57, y: 48 }, subtitle: "王都", tone: "#e7c982" },
      { id: "isles", name: "潮汐群岛", type: "sea", description: "风暴、商船与无名之王的群岛。", coordinates: { x: 76, y: 72 }, subtitle: "群岛", tone: "#8bc0cc" },
    ],
  },
  {
    id: "aelan",
    name: "埃兰大陆",
    description: "金叶王朝治下 3 大地区：龙脊山、圣城、群岛。30+ 事件聚焦宗教改革、王朝更替、海洋探索。",
    defaultYear: 1120,
    events: aelanEvents,
    characters: [
      { id: "aelan-c1", worldId: "demo", name: "金叶王子", role: "改革派", description: "金叶王朝王子，推行税制改革削弱大主教权力。", currentRegionId: "capital", tags: ["主角", "皇室", "改革派"] },
      { id: "aelan-c2", worldId: "demo", name: "大主教", role: "保守派首领", description: "圣城大主教，垄断宗教权威，反对任何改革。", currentRegionId: "capital", tags: ["反派", "祭司", "保守派"] },
      { id: "aelan-c3", worldId: "demo", name: "雪山贤者", role: "龙脊山智者", description: "龙脊山隐居贤者，发现石巨人苏醒真相。", currentRegionId: "north", tags: ["配角", "贤者", "神秘"] },
      { id: "aelan-c4", worldId: "demo", name: "群岛海盗王", role: "海洋霸主", description: "群岛海盗联盟首领，传说中为无名之王的后裔。", currentRegionId: "isles", tags: ["配角", "海盗", "传奇"] },
    ],
    regions: [
      { id: "north", name: "龙脊山", type: "mountain", description: "永夜降临之地，部族与雪山贤者隐居其间。", coordinates: { x: 30, y: 18 }, subtitle: "龙脊", tone: "#a5b3a3" },
      { id: "capital", name: "圣城", type: "city", description: "金叶王朝都城，大主教驻锡之地。", coordinates: { x: 55, y: 42 }, subtitle: "圣城", tone: "#c9b687" },
      { id: "isles", name: "群岛", type: "sea", description: "海盗联盟领地，无名之王传说的源头。", coordinates: { x: 78, y: 70 }, subtitle: "群岛", tone: "#7faab5" },
    ],
  },
  {
    id: "stars",
    name: "群星历险记",
    description: "2348 年星际联邦时代 3 大地区：极光站、星际首都、木卫二基地。30+ 事件聚焦星际探索、能源革命、外星生命。",
    defaultYear: 2348,
    events: starsEvents,
    characters: [
      { id: "stars-c1", worldId: "demo", name: "星际舰长", role: "远航者", description: "联邦「星环号」舰长，带领团队首次完成半人马座远航。", currentRegionId: "capital", tags: ["主角", "舰长", "探索者"] },
      { id: "stars-c2", worldId: "demo", name: "科学狂人", role: "AI 失控者", description: "联邦首席科学家，私自开发外星细菌武器。", currentRegionId: "capital", tags: ["反派", "科学家", "狂人"] },
      { id: "stars-c3", worldId: "demo", name: "极光站长", role: "北极守望者", description: "极光站站长，发现跨极通讯的科学家。", currentRegionId: "north", tags: ["配角", "科学家", "守望者"] },
      { id: "stars-c4", worldId: "demo", name: "外星先知", role: "外星接触者", description: "首个与外星信号建立对话的人类，开启星际外交。", currentRegionId: "isles", tags: ["配角", "外星", "先知"] },
    ],
    regions: [
      { id: "north", name: "极光站", type: "plain", description: "北极首座永久基地，极光通讯的源头。", coordinates: { x: 32, y: 20 }, subtitle: "极光", tone: "#3b4a52" },
      { id: "capital", name: "星际首都", type: "city", description: "联邦首府，星际港与议会大厦所在。", coordinates: { x: 58, y: 50 }, subtitle: "首都", tone: "#4d6a72" },
      { id: "isles", name: "木卫二基地", type: "sea", description: "冰下海洋研究基地，外星细菌的发现地。", coordinates: { x: 72, y: 75 }, subtitle: "木卫二", tone: "#6e7d8c" },
    ],
  },
  {
    id: "fog",
    name: "雾都异闻",
    description: "1920s 雾都 3 大地区：北境探案、雾都议会、群岛雾咒。30+ 事件聚焦超自然现象、悬案、神秘预言。",
    defaultYear: 1924,
    events: fogEvents,
    characters: [
      { id: "fog-c1", worldId: "demo", name: "雾都侦探", role: "私家侦探", description: "雾都最负盛名的私家侦探，专接超自然案件。", currentRegionId: "capital", tags: ["主角", "侦探", "理性派"] },
      { id: "fog-c2", worldId: "demo", name: "红衣女子", role: "超自然实体", description: "雾都传说中的超自然实体，真身无人知晓。", currentRegionId: "capital", tags: ["反派", "超自然", "神秘"] },
      { id: "fog-c3", worldId: "demo", name: "北境守林人", role: "雾门守护者", description: "北境守林人，世代守护传说中的雾门。", currentRegionId: "north", tags: ["配角", "守林人", "神秘"] },
      { id: "fog-c4", worldId: "demo", name: "群岛祭司", role: "海雾术士", description: "群岛唯一能施海雾咒的术士，可召唤雾船迷航。", currentRegionId: "isles", tags: ["配角", "术士", "海雾"] },
    ],
    regions: [
      { id: "north", name: "北境探案", type: "plain", description: "雾都北境，守林人与雾门传说的源头。", coordinates: { x: 28, y: 22 }, subtitle: "北境", tone: "#7a7670" },
      { id: "capital", name: "雾都议会", type: "city", description: "雾都中心，议会与雾钟所在。", coordinates: { x: 52, y: 48 }, subtitle: "议会", tone: "#9e9489" },
      { id: "isles", name: "群岛雾咒", type: "sea", description: "群岛海雾术士与无名岛传说的核心。", coordinates: { x: 74, y: 72 }, subtitle: "群岛", tone: "#8a8b7e" },
    ],
  },
];

export function getDemoTemplate(id: string): DemoTemplate | null {
  return DEMO_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function getDemoTemplateByName(name: string): DemoTemplate | null {
  return DEMO_TEMPLATES.find((t) => t.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// W0-07：模板 → 世界 的纯函数构建（深拷贝，不共享引用）
// ---------------------------------------------------------------------------
// 把只读蓝图转为可游玩世界：所有数组深拷贝、注入新 worldId、事件 id 归一化。
// worldAgent 故意不在此预置——演示世界「可选」当前世界 Agent，默认按基线游玩，
// 用户可在界面发起一次世界级初始化请求后再 attach（见 W0-07 验收路径）。
export interface BuildDemoWorldOptions {
  /** 新世界 id（调用方生成，例如 `world-${Date.now()}`） */
  id: string;
  /** 覆盖模板默认名（用户可填） */
  name?: string;
  /** 覆盖模板默认描述 */
  description?: string;
  /** 创建 / 更新时间戳（调用方注入，禁止内部 Date.now） */
  now: number;
  /**
   * 默认选中地区；不传则取模板第一个地区。
   * 显式传 null 表示空白世界无选中地区（本函数不用于空白世界，仅保留语义）。
   */
  regionId?: string | null;
}

function cloneTravelSettings(src?: MapTravelSettings): MapTravelSettings | undefined {
  if (!src) return undefined;
  return {
    enabled: src.enabled,
    distancePerCell: src.distancePerCell,
    distanceUnit: src.distanceUnit,
    defaultSpeed: src.defaultSpeed,
    ...(src.terrainFactors ? { terrainFactors: { ...src.terrainFactors } } : {}),
  };
}

export function buildWorldFromTemplate(template: DemoTemplate, opts: BuildDemoWorldOptions): World {
  const worldId = opts.id;
  const regions = template.regions.map((r) => ({ ...r, worldId }));
  const events = normalizeEventIds(
    Object.fromEntries(
      Object.entries(template.events).map(([regionId, evs]) => [
        regionId,
        evs.map((event) => ({
          ...event,
          ...(event.characterIds ? { characterIds: [...event.characterIds] } : {}),
        })),
      ]),
    ),
  );
  const characters = template.characters.map((character) => ({
    ...character,
    worldId,
    ...(character.tags ? { tags: [...character.tags] } : {}),
  }));
  const points = template.points?.map((p) => ({ ...p }));
  const stories = template.stories?.map((story) => ({
    ...story,
    worldId,
    steps: story.steps.map((step) => ({ ...step })),
    ...(story.chapters ? { chapters: story.chapters.map((chapter) => ({ ...chapter })) } : {}),
  }));
  const characterStates = template.characterStates?.map((s) => ({ ...s }));
  const characterMemories = template.characterMemories?.map((m) => ({ ...m }));
  const storyRuntimes = template.storyRuntimes?.map((rt) => ({
    ...rt,
    ...(rt.companions ? { companions: [...rt.companions] } : {}),
    ...(rt.worldFlags ? { worldFlags: [...rt.worldFlags] } : {}),
    ...(rt.actionLog ? { actionLog: [...rt.actionLog] } : {}),
  }));
  const agentSessions = template.agentSessions?.map((s) => ({
    ...s,
    ...(s.openThreads ? { openThreads: [...s.openThreads] } : {}),
    ...(s.activeCardSessionIds ? { activeCardSessionIds: [...s.activeCardSessionIds] } : {}),
  }));
  const triggers = template.triggers?.map((t) => ({ ...t }));
  const actions = template.actions?.map((a) => ({
    ...a,
    ...(a.viaPointIds ? { viaPointIds: [...a.viaPointIds] } : {}),
    ...(a.candidateSources ? { candidateSources: [...a.candidateSources] } : {}),
  }));
  const outcomes = template.outcomes?.map((o) => ({ ...o }));
  const entryAnchors = template.entryAnchors?.map((a) => ({ ...a }));
  const travelSettings = cloneTravelSettings(template.mapTravelSettings);
  const defaultRegionId =
    opts.regionId === null || (typeof opts.regionId === "string" && opts.regionId.length > 0)
      ? opts.regionId
      : (regions[0]?.id ?? null);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: worldId,
    name: opts.name?.trim() || template.name,
    description: opts.description?.trim() || template.description,
    currentRegionId: defaultRegionId,
    currentYear: template.defaultYear,
    createdAt: opts.now,
    updatedAt: opts.now,
    regions,
    events,
    characters,
    ...(points ? { points } : {}),
    ...(stories ? { stories } : {}),
    ...(characterStates ? { characterStates } : {}),
    ...(characterMemories ? { characterMemories } : {}),
    ...(storyRuntimes ? { storyRuntimes } : {}),
    ...(agentSessions ? { agentSessions } : {}),
    ...(triggers ? { triggers } : {}),
    ...(actions ? { actions } : {}),
    ...(outcomes ? { outcomes } : {}),
    ...(entryAnchors ? { entryAnchors } : {}),
    ...(travelSettings ? { travelSettings } : {}),
  };
}
