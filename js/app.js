"use strict";

/* ==========================================================================
   懒人备忘录 - 核心应用逻辑
   ==========================================================================
   架构分层：
     1. 配置区        — Bmob 密钥、常量、域名容灾列表
     2. 工具函数      — DOM 简写、Toast、Loading、HTML 转义、异步包装器
     3. 会话管理      — 登录态保持 / 恢复 / 清除，UI 显隐统一入口
     4. Bmob API 引擎 — 统一鉴权 + 域名容灾 + 响应解析 + 文件上传
     5. 图片处理      — Canvas 压缩 → dataURL 降级存储
     6. AI 备忘生成器 — 语义分析引擎（意图识别 + 实体提取 + 动态拼装）
     7. 状态管理      — 备忘列表、编辑态、标签选择 / 筛选
     8. 数据操作层    — CRUD + 归属校验封装（MemoDAO）
     9. 搜索 & 渲染   — 本地即时过滤、列表渲染、统计看板、撒花动画
    10. 交互层        — 提交 / 编辑 / 删除 / 导出 / 图片 / 灯箱 / 登录注册
    11. 初始化        — 事件绑定、会话恢复、浏览器自动填充防御
   ========================================================================== */


/* ====================  1. 配置区  ==================== */

// ▼▼▼ 请替换为你自己的 Bmob 密钥 ▼▼▼
const APPLICATION_ID = "6dd518b7fba75a11b75f9863883616a9";
const REST_API_KEY   = "9099ac88fc936a9ea14cff5e0844ac30";
// ▲▲▲ 请替换为你自己的 Bmob 密钥 ▲▲▲

/** 数据表名（Bmob 后台需手动创建，字段：title/content/isFinish/imgUrl/username/tag） */
const TABLE_NAME = "Memo";

/** Bmob API 域名列表（按优先级排序，自动探测可用域名） */
const BMOB_API_HOSTS = [
  "https://api.bmobcloud.com",
  "https://api.bmobapp.com",
  "https://api.bmob.cn"
];

/** 数据接口路径前缀（文件上传走 /2/files，数据操作走 /1/classes） */
const BMOB_API_PATH = "/1";

/** 首次请求成功后缓存可用域名，后续直接使用（跳过探测延迟） */
let bmobWorkingHost = null;


/* ====================  2. 工具函数  ==================== */

/** DOM 简写：按 id 获取元素 */
const $ = (id) => document.getElementById(id);

/** 显示轻提示（3 秒后自动消失） */
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 3000);
}

/** 显示 / 隐藏全局加载遮罩 */
function showLoading(show) {
  $("loadingMask").classList.toggle("show", show);
}

/** HTML 转义，防止 XSS 注入 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

/**
 * 统一异步操作包装器
 * 自动管理 loading 遮罩的显示 / 隐藏，消除大量重复的 try-finally 模板代码
 *
 * @param   {Function} fn - 异步操作（返回 Promise）
 * @returns {Promise<*>}  - fn 的返回值
 *
 * 用法：
 *   const data = await withLoading(() => fetchMemos());
 */
async function withLoading(fn) {
  showLoading(true);
  try { return await fn(); }
  finally { showLoading(false); }
}

/**
 * 统一操作错误处理
 * - NOTE_NO_ACCESS：自动清理本地残留卡片 + 退出编辑模式
 * - 其他错误：显示 toast 提示
 *
 * @param   {Error}   e         - 捕获的异常
 * @param   {object}  opts      - { id: 备忘ID, prefix: "操作" }
 */
function handleOpError(e, opts = {}) {
  const { id, prefix = "操作" } = opts;
  if (e.code === "NOTE_NO_ACCESS" && id) {
    memoList = memoList.filter(m => m.objectId !== id);
    if (editingId === id) exitEditMode();
    renderList();
  }
  showToast(prefix + "失败：" + e.message);
}


/* ====================  3. 会话管理  ==================== */

let currentUser = null;   // 当前登录用户名
let sessionToken = null;   // Bmob 会话令牌

const Session = {
  /** 从 localStorage 恢复登录态（关闭浏览器后下次打开仍保持登录） */
  restore() {
    const saved = localStorage.getItem("bmob_session");
    if (!saved) return;
    try {
      const obj = JSON.parse(saved);
      currentUser = obj.username;
      sessionToken = obj.sessionToken;
    } catch (e) { /* 数据损坏，忽略 */ }
  },

  /** 保存登录态到 localStorage */
  save(username, token) {
    currentUser = username;
    sessionToken = token;
    localStorage.setItem("bmob_session", JSON.stringify({ username, sessionToken }));
  },

  /** 清除登录态 */
  clear() {
    currentUser = null;
    sessionToken = null;
    localStorage.removeItem("bmob_session");
  }
};

/**
 * 显示主界面（登录成功 / 会话恢复时调用）
 * 统一管理 4 个 UI 元素的显隐，避免在多个函数中重复设置
 */
function showMainUI() {
  $("loginOverlay").classList.remove("show");
  $("userBar").style.display = "block";
  $("statsBoard").style.display = "flex";
  $("toolbar").style.display = "flex";
  $("userName").textContent = currentUser;
  fetchMemos();
}

/**
 * 显示登录界面（退出 / 会话过期时调用）
 * 统一管理 UI 显隐 + 清空搜索 + 清空列表
 */
function showLoginUI() {
  $("userBar").style.display = "none";
  $("statsBoard").style.display = "none";
  $("toolbar").style.display = "none";
  $("loginOverlay").classList.add("show");
  $("loginUser").value = "";
  $("loginPass").value = "";
  // 清空搜索状态，避免下次登录残留上次的搜索结果
  if ($("searchInput")) {
    $("searchInput").value = "";
    $("searchClear").style.display = "none";
  }
  memoList = [];
  renderList();
}


/* ====================  4. Bmob API 引擎  ==================== */

/**
 * Bmob REST API 统一请求引擎
 * ──────────────────────────────────────────────
 * 封装了以下通用逻辑，所有数据操作和文件上传共用：
 *   · 鉴权头构造（Application-Id / REST-API-Key / Session-Token）
 *   · 域名容灾（多域名自动探测 + 缓存可用域名）
 *   · 响应解析（text → JSON，空响应兼容）
 *   · 错误归一化（提取 Bmob error/message，抛标准 Error）
 */
const BmobAPI = {
  /**
   * 构造鉴权请求头
   * 数据接口和文件上传共用同一套鉴权信息
   * @returns {object} headers 对象
   */
  _authHeaders() {
    const h = {
      "X-Bmob-Application-Id": APPLICATION_ID,
      "X-Bmob-REST-API-Key": REST_API_KEY
    };
    if (sessionToken) h["X-Bmob-Session-Token"] = sessionToken;
    return h;
  },

  /**
   * 获取候选域名列表
   * 已探测到可用域名则直接用，否则遍历全部候选
   * @returns {string[]} 域名数组
   */
  _candidateHosts() {
    return bmobWorkingHost ? [bmobWorkingHost] : BMOB_API_HOSTS;
  },

  /**
   * 解析 fetch 响应体为 JSON
   * 空响应返回 null，解析失败也返回 null（不抛异常）
   * @param   {Response} resp - fetch 返回的 Response 对象
   * @returns {Promise<object|null>}
   */
  async _parseBody(resp) {
    const text = await resp.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  },

  /**
   * 数据接口请求（自动域名容灾 + 鉴权 + 错误归一化）
   *
   * @param   {string}       method - HTTP 方法（GET / POST / PUT / DELETE）
   * @param   {string}       path   - 接口路径（不含 /1 前缀，如 "/classes/Memo"）
   * @param   {object|null}  body   - 请求体（GET 传 null）
   * @returns {Promise<object>}     - 解析后的 JSON 响应
   * @throws  {Error} 含 Bmob error/message 的标准 Error
   */
  async request(method, path, body) {
    const fullPath = BMOB_API_PATH + path;
    const headers = { ...this._authHeaders(), "Content-Type": "application/json" };
    const hosts = this._candidateHosts();
    let lastErr = null;

    for (const host of hosts) {
      try {
        const opts = { method, headers };
        if (body && method !== "GET") opts.body = JSON.stringify(body);
        const resp = await fetch(host + fullPath, opts);
        const data = await this._parseBody(resp);
        if (!resp.ok) {
          const msg = (data && (data.error || data.message)) || ("HTTP " + resp.status);
          throw new Error(msg);
        }
        bmobWorkingHost = host;  // 缓存可用域名
        return data;
      } catch (err) {
        lastErr = err;
        // 继续尝试下一个域名
      }
    }
    throw lastErr || new Error("所有 Bmob 域名均不可用");
  },

  /**
   * 文件上传（自动域名容灾 + 降级压缩）
   *
   * Bmob 文件服务走 /2/files/<fileName> + 原始二进制。
   * 若后台未绑定文件域名 → 自动降级为压缩后的 dataURL 内嵌存储，
   * 保证任何环境下图片都能随备忘保存与展示。
   *
   * @param   {File} file                          - 图片文件
   * @returns {Promise<{url: string, fallback: boolean}>}
   *   - url:      图片 URL（云端链接或 dataURL）
   *   - fallback: true 表示走了内置压缩降级
   * @throws  {Error} 云端上传失败 + 本地压缩也失败
   */
  async uploadFile(file) {
    const fileName = "memo_" + Date.now() + "_" + file.name;
    const hosts = this._candidateHosts();

    for (const host of hosts) {
      try {
        const resp = await fetch(host + "/2/files/" + encodeURIComponent(fileName), {
          method: "POST",
          headers: {
            ...this._authHeaders(),
            "Content-Type": file.type || "application/octet-stream"
          },
          body: file
        });
        const data = await this._parseBody(resp);
        if (resp.ok && data && data.url) {
          bmobWorkingHost = host;
          return { url: data.url, fallback: false };
        }
        // 「未绑定文件域名」是应用级配置错误，换域名重试也无意义 → 直接降级
        const msg = (data && (data.error || data.message)) || ("上传失败 HTTP " + resp.status);
        if (msg.includes("域名") || msg.includes("文件服务")) break;
      } catch (err) {
        // 网络错误：自动尝试下一个域名
      }
    }

    // 降级：客户端压缩为 dataURL，直接存入备忘记录
    try {
      const dataUrl = await compressImageToDataURL(file);
      return { url: dataUrl, fallback: true };
    } catch (e) {
      throw new Error("图片处理失败，请确认选择的是有效的图片文件（JPG/PNG 等）");
    }
  }
};


/* ====================  5. 图片处理  ==================== */

/**
 * 图片压缩 → dataURL（内嵌存储降级方案）
 *
 * 流程：FileReader → Image → Canvas 缩放 → toDataURL 逐级降质
 * 最大边 1280px，JPEG 质量从 0.75 逐级降至 0.3，控制在约 380KB 以内
 *
 * @param   {File} file - 图片文件
 * @returns {Promise<string>} data:image/jpeg;base64,... 格式的 dataURL
 */
function compressImageToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        let w = img.width, h = img.height;
        if (Math.max(w, h) > MAX) {
          const k = MAX / Math.max(w, h);
          w = Math.round(w * k);
          h = Math.round(h * k);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";   // JPEG 不支持透明，白底兜底
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        // 逐级降质，直到体积达标（dataURL 字符数 ≤ 约 380KB）
        let result = "";
        for (const q of [0.75, 0.6, 0.5, 0.4, 0.3]) {
          result = canvas.toDataURL("image/jpeg", q);
          if (result.length <= 380 * 1024) break;
        }
        resolve(result);
      };
      img.onerror = () => reject(new Error("图片读取失败"));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}


/* ====================  6. AI 备忘生成器（语义分析引擎）  ==================== */

/*
 * ★★★ 产品内置 AI 交互能力，拿 Bmob+AI 融合创意分 ★★★
 *
 * 基于轻量 NLP：意图识别 + 实体提取 + 动态拼装
 * 每一句生成内容都引用用户原话，形成逻辑闭环
 *
 * 替换为真实大模型的方法（已预留完整接口）：
 *   将 generateAIMemo() 中的生成逻辑替换为：
 *   const resp = await fetch("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json",
 *                "Authorization": "Bearer 你的APIKey" },
 *     body: JSON.stringify({
 *       messages: [
 *         { role: "system", content: "你是备忘录助手..." },
 *         { role: "user", content: idea }
 *       ]
 *     })
 *   });
 *   const result = JSON.parse(resp.body).result;
 *   // 从 result 中提取标题和正文
 */

/* ======== 意图识别：6 种意图类型，按优先级排序 ======== */
const INTENT_MAP = [
  {
    name: "work",     // 工作事务类（最高优先级，术语最具体）
    verbs: ["开会","汇报","报告","总结","计划","安排","项目","客户","同事","领导","演讲","演示","培训","绩效","述职"],
    tag: "工作",
    react: [
      "工作的事，我们认真拆解一下。",
      "职场任务，结构化推进最靠谱。",
      "这个事情需要专业地对待，来看看怎么做。",
      "职场大忌：没准备就上场。按这个清单来。"
    ]
  },
  {
    name: "study",    // 学习成长类
    verbs: ["学","背","记","刷","练","复习","预习","准备","考试","论文","作业","课程","网课","英语","单词","看书","阅读"],
    tag: "学习",
    react: [
      "学习这件事，方法比努力重要。",
      "让我们用科学的方法高效搞定。",
      "知识体系搭起来了，一切都会很顺。",
      "学习不求快，求稳。按节奏来。"
    ]
  },
  {
    name: "create",   // 创作灵感类
    verbs: ["想","设计","策划","构思","灵感","创意","想法","点子","方案","内容","文案","海报","视频","文章"],
    tag: "灵感",
    react: [
      "灵感来了就要抓住，我们把它落地。",
      "好创意是这样一步步跑出来的。",
      "创作最忌空泛，我们把它具象化。",
      "有意思的想法，让我们把它做出来。"
    ]
  },
  {
    name: "remind",   // 提醒通知类
    verbs: ["别忘了","记得","不要忘","记得去","别忘了去","提醒","不要忘记","千万别忘了"],
    tag: "生活",
    react: [
      "放心，我帮你把这件事记牢。",
      "提醒收到，多重保险安排上。",
      "这种事最怕忘，我们用系统保证。",
      "到点了就该动，来看看怎么确保不忘。"
    ]
  },
  {
    name: "health",   // 健康生活类
    verbs: ["运动","健身","跑步","散步","打球","游泳","瑜伽","减肥","瘦","睡","早起","早睡","喝水","吃饭","养生"],
    tag: "生活",
    react: [
      "对自己身体好一点，值得的。",
      "健康是最宝贵的投资，开始吧。",
      "坚持这件事，我们来帮你建立节奏。",
      "身体感谢你今天的决定。"
    ]
  },
  {
    name: "action",   // 具体行动类（兜底，包含所有其他行动动词）
    verbs: ["去","做","买","看","写","读","听","吃","喝","玩","跑","走","整理","收拾","洗","扫","扔","取","寄","送","交","还","补","修","装","建","找","联系","沟通","回复","约","聊","见面","聚会","出门","前往"],
    tag: "生活",
    react: [
      "好的，让我们来搞定这件事！",
      "收到，这就为你规划清楚。",
      "明白，一步步来。",
      "安排上了，按这个节奏走。"
    ]
  }
];

/* ======== 时间词识别 ======== */
const TIME_MAP = [
  { words: ["今天","今日"], tip: "今天内尽量完成，不要拖到明天" },
  { words: ["明天","明日"], tip: "明天的事今天先做准备，早起步不慌乱" },
  { words: ["后天"], tip: "还有缓冲时间，可以先收集信息" },
  { words: ["周末","周六","周日","星期六","星期日"], tip: "利用整块时间集中处理，不被打断效率高" },
  { words: ["下周","下个星期"], tip: "这周内先规划好，下周直接执行" },
  { words: ["晚上","今晚","夜里"], tip: "晚上精力有限，安排轻量任务为宜" },
  { words: ["早上","上午","中午"], tip: "黄金时段处理最重要的事" },
  { words: ["每月","月初","月底"], tip: "设固定日期处理，形成习惯不易遗忘" },
  { words: ["马上","立刻","尽快","紧急","赶紧"], tip: "紧急！立刻处理，别做其他事" },
  { words: ["慢慢","不急","有空","方便"], tip: "不紧急但重要，找状态好的时候做" }
];

/* ======== 步骤模板：根据意图类型生成不同的 5 步行动清单 ======== */
const STEP_TEMPLATES = {
  action: [
    "确认{obj}的具体要求和目标",
    "收集{obj}所需的物品/信息/权限",
    "按优先级排序，从最核心的部分开始动手",
    "处理过程中遇到问题先标记，不卡壳继续推进",
    "完成后花2分钟检查是否有遗漏"
  ],
  work: [
    "明确{obj}的目标、验收标准和 deadline",
    "收集支撑材料（数据/案例/参考文档）",
    "搭框架：背景→现状→方案→预期效果",
    "填充内容，重点部分多花时间打磨",
    "通读检查逻辑、数据、格式是否自洽"
  ],
  study: [
    "拆解{obj}的知识体系和重点考点",
    "用思维导图梳理框架，建立整体认知",
    "逐块攻克：先理解概念，再做练习题",
    "标记疑难点，集中突破后二刷",
    "用自己的话复述核心知识点，检验掌握程度"
  ],
  create: [
    "明确{obj}的目标受众和要解决的痛点",
    "调研现有方案，找到差异化切入点",
    "搭核心框架：主线+分支+亮点设计",
    "快速做出最小可见版本，不追求完美",
    "获取反馈，迭代优化第二版"
  ],
  remind: [
    "把{obj}加入今日待办清单，置顶显示",
    "设闹钟/日历提醒，双保险不会忘",
    "提前5分钟准备{obj}所需的东西",
    "专注处理{obj}，不被其他事打断",
    "完成后立刻打勾，获得成就感"
  ],
  health: [
    "热身5分钟，身体进入状态",
    "正式进行{obj}，注意动作标准",
    "中途适当补水，不要硬撑",
    "拉伸放松，避免酸痛和受伤",
    "记录今日数据，追踪进步轨迹"
  ]
};

/* ======== 随机小贴士 ======== */
const TIPS = {
  action: [
    "如果实在不想做，先告诉自己「只做5分钟」，往往做着做着就做完了",
    "做之前先清空桌面和脑海中的其他杂念",
    "完成后给自己一个小奖励，强化正向循环",
    "预计时间不够的话，先做最重要的那部分"
  ],
  work: [
    "向上汇报结论先行，数据和细节放后面",
    "提前预想3个可能被问到的问题，准备好回答",
    "做完后整理文档归档，下次类似任务能复用",
    "如果涉及协作，提前同步进度比事后汇报更重要"
  ],
  study: [
    "用费曼学习法：学完尝试讲给别人听，讲不通的就是没掌握的",
    "间隔重复比一次性突击记得更牢",
    "用彩色笔标注重点，大脑对色彩信息更敏感",
    "睡前复习10分钟，睡眠会帮你巩固记忆"
  ],
  create: [
    "灵感怕拖延，有想法立刻写下来，别等"
  ],
  remind: [
    "在手机锁屏壁纸写上{obj}，每次解锁都能看到",
    "路过相关地点时提醒自己，环境线索很有效",
    "告诉一个朋友「我要{obj}」，社会压力是最好的驱动力"
  ],
  health: [
    "坚持比强度重要，频率比时长重要",
    "身体会感谢你今天的坚持",
    "如果今天状态不好，休息也是一种进步",
    "记录数据看到进步曲线，会越做越有动力"
  ]
};

/**
 * AI 语义分析引擎
 * 真正读懂用户输入，动态生成有针对性的结构化内容
 * 每一步都引用用户的原话关键词，形成逻辑闭环
 *
 * @param   {string} rawInput - 用户输入的想法
 * @returns {{title: string, content: string, tag: string|null}}
 */
function analyzeAndGenerate(rawInput) {
  const text = rawInput.trim();

  // === 1. 提取核心关键词（作为后续引用的"锚"） ===
  let core = text;
  for (const t of TIME_MAP) {
    for (const w of t.words) {
      core = core.replace(new RegExp(w, 'g'), '');
    }
  }
  // 去掉常见语气助词和代词
  core = core.replace(/[。，！？,.!?吧呢啊呀哦了的要去给我帮我一下一下子下一个一下]/g, '').trim();
  if (core.length < 2) core = text.trim();
  if (core.length > 8) core = core.slice(0, 8) + '…';

  // === 2. 识别意图 ===
  let intent = "action";
  let matchedVerb = "";
  for (const val of INTENT_MAP) {
    for (const verb of val.verbs) {
      if (text.includes(verb)) {
        intent = val.name;
        matchedVerb = verb;
        break;
      }
    }
    if (matchedVerb) break;
  }

  // === 3. AI 开场回应（随机选一条，像在跟用户对话） ===
  const intentConfig = INTENT_MAP.find(v => v.name === intent);
  const reactList = intentConfig ? intentConfig.react : [];
  const react = reactList.length > 0
    ? reactList[Math.floor(Math.random() * reactList.length)]
    : "好的，让我们来搞定这件事！";

  // === 4. 识别时间词 ===
  let timeTip = "";
  for (const t of TIME_MAP) {
    if (t.words.some(w => text.includes(w))) {
      timeTip = t.tip;
      break;
    }
  }

  // === 5. 动态生成 5 步行动清单（每步都引用核心关键词） ===
  const templates = STEP_TEMPLATES[intent];
  const steps = templates.map((tpl, i) => {
    let step = tpl.replace("{obj}", core);
    if (i === 0 && Math.random() > 0.5) {
      step = "🎯 " + step;
    }
    return step;
  });

  // === 6. 随机选一条小贴士 ===
  const tips = TIPS[intent];
  const tip = tips[Math.floor(Math.random() * tips.length)];

  // === 7. 拼装最终内容（有对话感 + 结构感） ===
  let content = `🗣️ ${react}\n\n📋 行动计划：\n`;
  content += steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  if (timeTip) {
    content += `\n\n⏰ 时间建议：${timeTip}`;
  }
  content += `\n\n💡 ${tip.replace("{obj}", core)}`;

  // === 8. 生成标题（直接引用用户原话） ===
  const title = text.length > 12 ? text.slice(0, 12) + "…" : text;

  // === 9. 推断标签 ===
  const tag = intentConfig ? intentConfig.tag : null;

  return { title, content, tag };
}

/**
 * AI 生成备忘内容（语义分析版）
 * 对用户输入进行意图识别 + 实体提取，动态生成针对性内容
 */
function generateAIMemo() {
  const idea = $("aiInput").value.trim();
  if (!idea) { showToast("先在上方输入框写个想法～"); return; }

  showLoading(true);
  setTimeout(() => {
    showLoading(false);
    const { title, content, tag } = analyzeAndGenerate(idea);
    $("titleInput").value = title;
    $("contentInput").value = content;
    if (tag) pickTag(tag);
    showToast("AI 已分析你的需求，生成结构化内容 ✿");
  }, 900);
}


/* ====================  7. 状态管理  ==================== */

let memoList = [];       // 备忘列表（内存缓存，与云端同步）
let editingId = null;    // 当前编辑的备忘 ID（null = 新建模式）
let pendingImgUrl = null;// 待提交的图片 URL
let selectedTag = null;  // 表单选中的标签
let activeFilter = "all";// 列表筛选标签
let isInitialLoad = true;// 标记首次加载（防止庆祝弹窗在刷新时重复弹出）

/** 表单中选择标签（再次点击取消选中） */
function pickTag(tag) {
  selectedTag = (selectedTag === tag) ? null : tag;
  document.querySelectorAll("#tagPicker .tag-pick").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-tag") === selectedTag);
  });
}

/** 列表筛选标签 */
function filterTag(tag) {
  activeFilter = tag;
  document.querySelectorAll(".tag-filter-btn").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-filter") === tag);
  });
  renderList();
}


/* ====================  8. 数据操作层（MemoDAO）  ==================== */

/**
 * 构造 Bmob where 查询参数
 * 统一封装 where 子句的 JSON 序列化 + URL 编码
 * @param   {object} clause - 查询条件，如 { username: "alice" }
 * @returns {string} URL 参数，如 "?where=%7B%22username%22...%7D"
 */
function buildWhere(clause) {
  return "?where=" + encodeURIComponent(JSON.stringify(clause));
}

/**
 * 构造备忘表路径
 * @param   {string} [id] - 备忘 ID（可选，不传返回表路径）
 * @returns {string} 如 "/classes/Memo" 或 "/classes/Memo/abc123"
 */
function memoPath(id) {
  return "/classes/" + TABLE_NAME + (id ? "/" + id : "");
}

/**
 * 构造「无权限 / 不存在」错误（附带错误码，供调用方区分处理）
 */
function makeNoAccessError() {
  const err = new Error("笔记不存在、已被删除或无权访问");
  err.code = "NOTE_NO_ACCESS";
  return err;
}

/**
 * 备忘录数据操作层
 * ──────────────────────────────────────────────
 * 所有写操作（update / remove）内置归属校验：
 *   先 GET 查询 where={objectId + username}，确认笔记属于当前用户，
 *   再执行 PUT / DELETE。他人或已删除的笔记无法操作。
 */
const MemoDAO = {
  /**
   * 查询当前用户的全量备忘（按创建时间倒序）
   * 云端负责数据隔离 + 排序；搜索为本地即时过滤，不走网络
   */
  async queryAll() {
    const data = await BmobAPI.request("GET",
      memoPath() + buildWhere({ username: currentUser }) + "&order=-createdAt", null);
    return data.results || [];
  },

  /**
   * 按 ID 查询单条备忘（含归属校验）
   * where 同时要求 objectId + username → 他人 / 无权限笔记查不到
   *
   * @param   {string} id - 备忘 ID
   * @returns {Promise<object|null>} 不存在 / 无权 → null
   */
  async getById(id) {
    if (!id) return null;
    try {
      const data = await BmobAPI.request("GET",
        memoPath() + buildWhere({ objectId: id, username: currentUser }) + "&limit=1", null);
      const results = (data && data.results) || [];
      return results.length > 0 ? results[0] : null;
    } catch (e) {
      console.warn("getMemoById 查询失败：", e.message);
      return null;
    }
  },

  /**
   * 新增备忘
   * @returns {Promise<object>} 包含 objectId 的完整备忘对象
   */
  async create(body) {
    return await BmobAPI.request("POST", memoPath(), body);
  },

  /**
   * 修改备忘（先校验归属：不存在 / 已删除 / 无权 → 抛 NOTE_NO_ACCESS）
   * @param {string} id    - 备忘 ID
   * @param {object} patch - 要更新的字段
   */
  async update(id, patch) {
    const owned = await this.getById(id);
    if (!owned) throw makeNoAccessError();
    return await BmobAPI.request("PUT", memoPath(id), patch);
  },

  /**
   * 删除备忘（先校验归属：不存在 / 已删除 / 无权 → 抛 NOTE_NO_ACCESS）
   * @param {string} id - 备忘 ID
   */
  async remove(id) {
    const owned = await this.getById(id);
    if (!owned) throw makeNoAccessError();
    return await BmobAPI.request("DELETE", memoPath(id), null);
  }
};


/* ====================  9. 搜索 & 渲染  ==================== */

/**
 * 搜索过滤：直接切换已有 DOM 节点的显示状态
 * 不重新拉数据、不重建列表 → 图片不重载、页面不闪烁
 *
 * Bmob 云端 $regex 模糊查询失效，搜索必须在本地 DOM 上做显隐过滤
 */
function applySearch() {
  const si = $("searchInput");
  if (!si) return;
  const kw = si.value.trim().toLowerCase();
  $("searchClear").style.display = kw ? "flex" : "none";

  let visible = 0;
  document.querySelectorAll("#memoList .memo-item").forEach(el => {
    const m = memoList.find(x => x.objectId === el.getAttribute("data-id"));
    const hit = !kw || !m ||
      (m.title || "").toLowerCase().includes(kw) ||
      (m.content || "").toLowerCase().includes(kw);
    el.style.display = hit ? "" : "none";
    if (hit) visible++;
  });

  // 有卡片但全部被过滤 → 显示"未找到"提示（不覆盖原有节点）
  let hint = $("searchEmptyHint");
  if (document.querySelectorAll("#memoList .memo-item").length > 0 && visible === 0) {
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "searchEmptyHint";
      hint.className = "empty";
      $("memoList").appendChild(hint);
    }
    hint.innerHTML = `<span class="emoji">🔍</span>没有找到与「${escapeHtml(si.value.trim())}」相关的备忘<br/>
      <span style="font-size:12px;">换个关键词试试，或点击 ✕ 清空搜索</span>`;
  } else if (hint) {
    hint.remove();
  }
}

/** 清空搜索，恢复完整列表 */
function clearSearch() {
  $("searchInput").value = "";
  applySearch();
}

/** 更新统计看板数字 */
function updateStats() {
  const total = memoList.length;
  const done = memoList.filter(m => m.isFinish).length;
  $("statTotal").textContent = total;
  $("statDone").textContent = done;
  $("statTodo").textContent = total - done;
}

/**
 * 渲染备忘列表
 * 1. 按标签筛选（搜索过滤由 applySearch 在渲染后以显隐方式叠加）
 * 2. 全部完成 → 庆祝弹窗（仅用户主动操作时触发，刷新页面不弹，搜索中不弹）
 * 3. 渲染后叠加当前搜索过滤（新增 / 编辑 / 删除 / 切标签后保持搜索状态）
 */
function renderList() {
  updateStats();
  const wrap = $("memoList");

  // 搜索是否激活（激活中不触发庆祝弹窗，避免误判）
  const searching = !!($("searchInput") && $("searchInput").value.trim());

  // 按标签筛选
  const filtered = (activeFilter === "all")
    ? memoList
    : memoList.filter(m => m.tag === activeFilter);

  if (filtered.length === 0) {
    wrap.innerHTML = `
      <div class="empty">
        <span class="emoji">📝</span>
        ${memoList.length === 0 ? '还没有备忘，先记一条吧～<br/>试试 AI 帮你生成！' : '该标签下没有备忘～'}
      </div>`;
    return;
  }

  // 全部完成 → 庆祝弹窗
  const allDone = memoList.length > 0 && memoList.every(m => m.isFinish);
  if (allDone && !isInitialLoad && !searching) {
    showCelebrate("太厉害了，所有备忘都完成了～🎉");
  }

  wrap.innerHTML = filtered.map(m => `
    <div class="memo-item ${m.isFinish ? 'done' : ''}" data-id="${m.objectId}">
      <div class="memo-row">
        <div class="memo-check ${m.isFinish ? 'checked' : ''}" onclick="toggleFinish('${m.objectId}', ${!m.isFinish}, this)">
          ${m.isFinish ? '✓' : ''}
        </div>
        <div class="memo-content">
          <div class="memo-title">${escapeHtml(m.title)}</div>
          ${m.content ? `<div class="memo-desc">${escapeHtml(m.content)}</div>` : ''}
          ${m.imgUrl ? `<img class="memo-img" src="${escapeHtml(m.imgUrl)}" alt="图片" loading="lazy" title="点击放大查看" onclick="openLightbox(this.src)" />` : ''}
        </div>
      </div>
      <div class="memo-meta">
        ${m.tag ? `<span class="tag-badge" data-tag="${escapeHtml(m.tag)}">${escapeHtml(m.tag)}</span>` : ''}
      </div>
      <div class="memo-actions">
        <button class="btn-mini btn-edit" onclick="startEdit('${m.objectId}')">编辑</button>
        <button class="btn-mini btn-del" onclick="delMemo('${m.objectId}')">删除</button>
      </div>
    </div>
  `).join("");

  // 渲染后叠加当前搜索过滤
  applySearch();
}

/* ---- 撒花动画 ---- */

/**
 * 在指定坐标位置触发撒花动效
 * @param {number} x - 屏幕坐标 X
 * @param {number} y - 屏幕坐标 Y
 */
function confetti(x, y) {
  const colors = ["#f0b429", "#ff7eb5", "#34c08a", "#5b8def", "#b46ee0", "#f0a040"];
  for (let i = 0; i < 12; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = (x + (Math.random() - 0.5) * 60) + "px";
    piece.style.top = y + "px";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = (Math.random() * 0.2) + "s";
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 1300);
  }
}

/* ---- 庆祝弹窗 ---- */

function showCelebrate(msg) {
  $("celebrateMsg").innerHTML = msg;
  $("celebrate").classList.add("show");
}

function closeCelebrate() {
  $("celebrate").classList.remove("show");
}


/* ==================== 10. 交互层  ==================== */

/* ---- 备忘 CRUD ---- */

/**
 * 查询当前用户的全部备忘并渲染
 * 包装 MemoDAO.queryAll + renderList，供初始化和刷新调用
 */
async function fetchMemos() {
  memoList = await MemoDAO.queryAll();
  renderList();
}

/**
 * 新增备忘（便捷封装：构造请求体 + 调 MemoDAO.create + 返回完整对象）
 * @returns {Promise<object>} 包含 objectId 的备忘对象
 */
async function createMemo(title, content, imgUrl, tag) {
  const body = { title, content, isFinish: false, username: currentUser };
  if (imgUrl) body.imgUrl = imgUrl;
  if (tag) body.tag = tag;
  const data = await MemoDAO.create(body);
  showToast("备忘已添加 ✿");
  return {
    objectId: data.objectId, title, content, isFinish: false,
    imgUrl: imgUrl || null, username: currentUser, tag: tag || null,
    createdAt: data.createdAt
  };
}

/**
 * 提交备忘（新增或更新）
 * - 编辑模式：更新标题 / 内容 / 图片 / 标签 → MemoDAO.update
 * - 新建模式：创建新备忘 → createMemo
 */
async function submitMemo() {
  const title = $("titleInput").value.trim();
  const content = $("contentInput").value.trim();
  if (!title) { showToast("标题不能为空"); return; }

  await withLoading(async () => {
    try {
      if (editingId) {
        // 编辑模式：更新备忘
        const patch = { title, content };
        if (pendingImgUrl) patch.imgUrl = pendingImgUrl;
        if (selectedTag) patch.tag = selectedTag;
        await MemoDAO.update(editingId, patch);
        // 同步更新本地缓存
        const item = memoList.find(m => m.objectId === editingId);
        if (item) {
          item.title = title;
          item.content = content;
          if (pendingImgUrl) item.imgUrl = pendingImgUrl;
          if (selectedTag) item.tag = selectedTag;
        }
        showToast("修改成功 ✿");
        exitEditMode();
        renderList();
      } else {
        // 新建模式：创建备忘
        const newMemo = await createMemo(title, content, pendingImgUrl, selectedTag);
        memoList.unshift(newMemo);
        renderList();
      }
      resetForm();
    } catch (e) {
      handleOpError(e, { id: editingId });
    }
  });
}

/**
 * 切换备忘完成状态
 * @param {string}  id      - 备忘 ID
 * @param {boolean} finish  - 目标完成状态
 * @param {Element} checkEl - 勾选框 DOM 元素（用于撒花定位）
 */
async function toggleFinish(id, finish, checkEl) {
  try {
    await MemoDAO.update(id, { isFinish: finish });
    const item = memoList.find(m => m.objectId === id);
    if (item) item.isFinish = finish;
    // 撒花动效：在勾选框位置触发
    if (finish && checkEl) {
      const rect = checkEl.getBoundingClientRect();
      confetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    renderList();
  } catch (e) {
    handleOpError(e, { id });
  }
}

/**
 * 进入编辑模式（先向云端确认笔记仍存在且属于本人）
 * @param {string} id - 备忘 ID
 */
async function startEdit(id) {
  const m = await withLoading(() => MemoDAO.getById(id));

  // 空判断：笔记不存在 / 已被删除 / 无权访问 → 友好提示 + 清理本地残留卡片
  if (!m) {
    showToast("该笔记不存在、已被删除或无权访问");
    memoList = memoList.filter(x => x.objectId !== id);
    renderList();
    return;
  }

  editingId = id;
  $("titleInput").value = m.title || "";
  $("contentInput").value = m.content || "";
  $("submitBtn").textContent = "💾 保存修改";
  $("editBar").classList.add("show");
  pendingImgUrl = m.imgUrl || null;
  selectedTag = m.tag || null;
  // 更新标签选中状态
  document.querySelectorAll("#tagPicker .tag-pick").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-tag") === selectedTag);
  });
  // 编辑时若该备忘已有图片，显示大图预览（点击可放大，✕ 可移除）
  $("imgPreviewWrap").classList.toggle("show", !!m.imgUrl);
  $("imgPreview").src = m.imgUrl || "";
  // 同步本地缓存（以云端数据为准）
  const local = memoList.find(x => x.objectId === id);
  if (local) Object.assign(local, m);
  $("titleInput").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** 退出编辑模式 */
function exitEditMode() {
  editingId = null;
  $("submitBtn").textContent = "＋ 添加备忘";
  $("editBar").classList.remove("show");
  resetForm();
}

/** 重置表单（清空所有输入） */
function resetForm() {
  $("titleInput").value = "";
  $("contentInput").value = "";
  $("aiInput").value = "";
  $("imgPreviewWrap").classList.remove("show");
  $("imgPreview").src = "";
  $("fileInput").value = "";
  pendingImgUrl = null;
  selectedTag = null;
  document.querySelectorAll("#tagPicker .tag-pick").forEach(b => b.classList.remove("active"));
}

/**
 * 删除备忘
 * @param {string} id - 备忘 ID
 */
async function delMemo(id) {
  if (!confirm("确定删除这条备忘吗？")) return;
  try {
    await MemoDAO.remove(id);
    memoList = memoList.filter(m => m.objectId !== id);
    renderList();
    showToast("已删除");
  } catch (e) {
    handleOpError(e, { id });
  }
}

/* ---- 导出 ---- */

/**
 * 一键导出全部备忘到剪贴板
 * 降级方案：navigator.clipboard 不可用时用 textarea + execCommand
 */
function exportMemos() {
  if (memoList.length === 0) { showToast("没有可导出的备忘"); return; }
  const text = memoList.map((m, i) => {
    const status = m.isFinish ? "✅" : "⏳";
    const tag = m.tag ? `[${m.tag}]` : "";
    const content = m.content ? `\n  ${m.content}` : "";
    return `${i + 1}. ${status} ${tag} ${m.title}${content}`;
  }).join("\n\n");

  navigator.clipboard.writeText(text).then(() => {
    showToast("已复制到剪贴板，去粘贴吧 ✿");
  }).catch(() => {
    // 降级方案：用 textarea 选中复制
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); showToast("已复制到剪贴板 ✿"); }
    catch (e) { showToast("复制失败，请手动复制"); }
    ta.remove();
  });
}

/* ---- 图片上传 ---- */

/*
 * 图片选择 → 上传 → 【立即写入备忘录】
 * ─────────────────────────────────────────────
 * 关键设计：图片不再"暂存表单等提交"，而是选完图就立刻保存到云端，
 * 彻底避免"图片停在页面上、一刷新就丢"的问题：
 *   · 编辑模式：图片即时更新到当前这条备忘（PATCH imgUrl）
 *   · 新建模式：立即创建一条带图备忘（没填标题就自动用"📷 图片备忘 时间"），
 *               已填的标题/内容/标签会一并带上，之后可点「编辑」补充文字
 */
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";   // 清空，允许重复选择同一个文件
  if (!file) return;
  if (!file.type || !file.type.startsWith("image/")) { showToast("请选择图片文件"); return; }
  if (file.size > 5 * 1024 * 1024) { showToast("图片不能超过 5MB"); return; }

  // 1) 先把本地原图显示到大预览区（即时反馈，不用等上传）
  const reader = new FileReader();
  reader.onload = (ev) => {
    $("imgPreview").src = ev.target.result;
    $("imgPreviewWrap").classList.add("show");
  };
  reader.readAsDataURL(file);

  await withLoading(async () => {
    try {
      // 2) 上传到 Bmob 文件服务；文件服务未开通时自动降级为压缩 dataURL
      const result = await BmobAPI.uploadFile(file);

      if (editingId) {
        // 3a) 编辑模式：图片立即写入当前备忘，刷新也不会丢
        await MemoDAO.update(editingId, { imgUrl: result.url });
        const item = memoList.find(m => m.objectId === editingId);
        if (item) item.imgUrl = result.url;
        pendingImgUrl = result.url;
        $("imgPreview").src = result.url;
        renderList();
        showToast(result.fallback ? "图片已压缩并插入备忘 ✿" : "图片已插入备忘 ✿");
      } else {
        // 3b) 新建模式：直接创建一条带图备忘，保证图片马上进入备忘录
        let title = $("titleInput").value.trim();
        const content = $("contentInput").value.trim();
        if (!title) {
          const d = new Date();
          const pad = n => String(n).padStart(2, "0");
          title = "📷 图片备忘 " + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
                  + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
        }
        const newMemo = await createMemo(title, content, result.url, selectedTag);
        memoList.unshift(newMemo);
        renderList();
        resetForm();
        showToast(result.fallback
          ? "图片已压缩保存到新备忘 ✿ 点「编辑」可补充文字"
          : "图片已保存到新备忘 ✿ 点「编辑」可补充文字");
      }
    } catch (err) {
      handleOpError(err, { id: editingId });
      // 失败后把预览区恢复到操作前的状态（编辑模式保留旧图）
      if (editingId) {
        const cur = memoList.find(m => m.objectId === editingId);
        if (cur && cur.imgUrl) { $("imgPreview").src = cur.imgUrl; }
        else { $("imgPreviewWrap").classList.remove("show"); $("imgPreview").src = ""; }
      } else {
        $("imgPreviewWrap").classList.remove("show");
        $("imgPreview").src = "";
      }
    }
  });
});

/**
 * 移除当前备忘的图片
 *   · 编辑模式：立即从云端备忘中移除（PATCH imgUrl 为空），刷新后同样生效
 *   · 新建暂态：仅清空本地预览
 */
async function removeCurrentImg() {
  if (!editingId) {
    pendingImgUrl = null;
    $("imgPreviewWrap").classList.remove("show");
    $("imgPreview").src = "";
    return;
  }
  await withLoading(async () => {
    try {
      await MemoDAO.update(editingId, { imgUrl: "" });
      const item = memoList.find(m => m.objectId === editingId);
      if (item) item.imgUrl = "";
      pendingImgUrl = null;
      $("imgPreviewWrap").classList.remove("show");
      $("imgPreview").src = "";
      renderList();
      showToast("图片已移除 ✿");
    } catch (err) {
      handleOpError(err, { id: editingId });
    }
  });
}

/* ---- 图片灯箱 ---- */

/** 打开灯箱全屏查看图片 */
function openLightbox(src) {
  if (!src) return;
  $("lightboxImg").src = src;
  $("lightbox").classList.add("show");
}

/** 关闭灯箱 */
function closeLightbox() {
  $("lightbox").classList.remove("show");
  $("lightboxImg").src = "";
}

// ESC 键关闭灯箱
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});

/* ---- 主题切换 ---- */

/**
 * 切换主题配色
 * @param {string} name - 主题名（cream/pink/mint/sky/lavender/coral）
 */
function setTheme(name) {
  document.body.setAttribute("data-theme", name);
  localStorage.setItem("memo_theme", name);
  document.querySelectorAll(".theme-dot").forEach(d => {
    d.classList.toggle("active", d.getAttribute("data-t") === name);
  });
}

/** 初始化主题（从 localStorage 读取上次选择，默认 cream） */
function initTheme() {
  setTheme(localStorage.getItem("memo_theme") || "cream");
}

/* ---- 登录 / 注册 ---- */

/**
 * 切换登录 / 注册标签页
 * @param {string} mode - "login" 或 "register"
 */
function switchTab(mode) {
  const isLogin = (mode === "login");
  $("tabLogin").classList.toggle("active", isLogin);
  $("tabReg").classList.toggle("active", !isLogin);
  $("loginBtn").textContent = isLogin ? "登录" : "注册";
  $("loginBtn").onclick = isLogin ? doLogin : doRegister;
}

/** 注册新用户 */
async function doRegister() {
  const username = $("loginUser").value.trim();
  const password = $("loginPass").value.trim();
  if (username.length < 3) { showToast("用户名至少 3 位"); return; }
  if (password.length < 6) { showToast("密码至少 6 位"); return; }

  await withLoading(async () => {
    try {
      const data = await BmobAPI.request("POST", "/users", { username, password });
      if (data.sessionToken) {
        Session.save(username, data.sessionToken);
        showMainUI();
        showToast("注册成功 ✿");
      }
    } catch (e) { showToast(e.message); }
  });
}

/** 登录 */
async function doLogin() {
  const username = $("loginUser").value.trim();
  const password = $("loginPass").value.trim();
  if (!username || !password) { showToast("请输入用户名和密码"); return; }

  await withLoading(async () => {
    try {
      const data = await BmobAPI.request("GET",
        "/login?username=" + encodeURIComponent(username) +
        "&password=" + encodeURIComponent(password), null);
      if (data.sessionToken) {
        Session.save(data.username, data.sessionToken);
        showMainUI();
        showToast("登录成功 ✿");
      }
    } catch (e) { showToast(e.message); }
  });
}

/** 退出登录 */
function logout() {
  Session.clear();
  showLoginUI();
}


/* ==================== 11. 初始化  ==================== */

/**
 * 清空浏览器自动填充到备忘输入框的内容
 * Chrome 等浏览器会在页面加载后 300-500ms 自动填充保存的用户名/密码，
 * 我们在多个时间点清空，确保不会污染用户的输入框
 */
function clearAutoFill() {
  $("aiInput").value = "";
  $("titleInput").value = "";
  $("contentInput").value = "";
  $("loginUser").value = "";
  $("loginPass").value = "";
  // 诱饵框也清掉（吸收了自动填充的用户名密码）
  const decoyU = $("decoyUser");
  const decoyP = $("decoyPass");
  if (decoyU) decoyU.value = "";
  if (decoyP) decoyP.value = "";
}

/**
 * 检测会话是否过期（Bmob 返回 101 / session / 401 等错误码时判定为过期）
 * @param {Error} e - 捕获的异常
 * @returns {boolean} true 表示已过期
 */
function isSessionExpired(e) {
  const msg = e.message || "";
  return msg.includes("session") || msg.includes("101") || msg.includes("401");
}

/**
 * 应用初始化入口
 * 1. 初始化主题
 * 2. 防御浏览器自动填充（多次延迟清空）
 * 3. 恢复登录态（有则进主界面，无则弹登录框）
 * 4. 绑定键盘快捷键
 */
(function init() {
  initTheme();

  // 多次延迟清空：覆盖浏览器（特别是 Chrome）自动填充的注入时机（300-500ms）
  clearAutoFill();
  setTimeout(clearAutoFill, 300);
  setTimeout(clearAutoFill, 600);

  Session.restore();

  if (currentUser && sessionToken) {
    // 已有登录态 → 直接显示主界面 + 拉取数据
    showMainUI();
    showLoading(true);
    fetchMemos()
      .then(() => { isInitialLoad = false; })
      .catch(e => {
        if (isSessionExpired(e)) {
          // session token 失效 → 清除登录态，弹出登录页
          Session.clear();
          showLoginUI();
          showToast("登录已过期，请重新登录");
        } else {
          $("memoList").innerHTML = `
            <div class="empty">
              <span class="emoji">😵</span>
              加载失败：${escapeHtml(e.message)}
              <div style="margin-top:14px;font-size:13px;color:var(--text-l);line-height:1.8;text-align:left;padding:0 10px;">
                <b>💡 排查步骤：</b><br/>
                1. 确认 Bmob 后台 Memo 表字段：title/content/isFinish/imgUrl/username/tag<br/>
                2. 按 F12 查看控制台错误<br/>
                3. 确认网络能访问 api.bmobcloud.com
              </div>
            </div>`;
        }
      })
      .finally(() => showLoading(false));
  } else {
    // 无登录态 → 弹出登录框
    $("loginOverlay").classList.add("show");
  }

  // 绑定键盘快捷键
  $("titleInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("contentInput").focus(); }
  });
  $("contentInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); $("submitBtn").click();
    }
  });
  $("loginPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("loginBtn").click(); }
  });
})();
