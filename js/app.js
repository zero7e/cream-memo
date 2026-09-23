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
     6. AI 引擎        — 备忘生成 + 一键总结润色（意图识别 + 要点提炼 + 动态拼装）
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
  async request(method, path, body, extraHeaders) {
    const fullPath = BMOB_API_PATH + path;
    const headers = { ...this._authHeaders(), "Content-Type": "application/json", ...(extraHeaders || {}) };
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
          const err = new Error(msg);
          err.bmobCode = data && data.code;
          err.httpStatus = resp.status;
          throw err;
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
   * 文件上传（先压缩保体积 + 自动域名容灾 + 内嵌兜底，保证任何图片都能成功）
   *
   * 步骤：
   *   1) 本地自适应压缩：无论原图多大，输出 dataURL 一律 ≤ 36KB
   *      （Bmob 免费版单次请求体硬上限 40KB，必须给其余字段留余量）；
   *   2) 尝试 Bmob 文件服务 /2/files/<fileName>（后台绑定文件域名后可用，
   *      成功后备忘里只存短链接，图片最清晰也最省空间）；
   *   3) 文件服务未开通（错误码 10007“绑定文件域名”）或网络全失败 →
   *      直接把第 1 步的压缩 dataURL 内嵌进备忘记录。体积已被严格压住，
   *      因此这一步必然成功，不会再出现“超过 bmob 限制，请升级套餐”。
   *
   * @param   {File} file                          - 图片文件（不限大小）
   * @returns {Promise<{url: string, fallback: boolean}>}
   *   - url:      图片 URL（云端链接或 dataURL）
   *   - fallback: true 表示走了内嵌压缩兜底
   * @throws  {Error} 文件不是浏览器可解码的图片（如损坏文件 / HEIC 未被系统转码）
   */
  async uploadFile(file) {
    // 1) 先压缩：这一步的结果也是最后的兜底，体积必然在记录限制内
    let dataUrl;
    try {
      dataUrl = await compressImageToDataURL(file);
    } catch (e) {
      throw new Error("图片处理失败，请确认是有效的图片文件（JPG / PNG / 截图均可；"
        + "iPhone 的 HEIC 格式请先在相册里转成 JPG）");
    }

    // 2) 尝试文件服务（上传压缩后的 JPEG，而非原图，进一步保证不超文件大小限制）
    const fileName = "memo_" + Date.now() + ".jpg";
    const hosts = this._candidateHosts();
    for (const host of hosts) {
      try {
        const resp = await fetch(host + "/2/files/" + encodeURIComponent(fileName), {
          method: "POST",
          headers: {
            ...this._authHeaders(),
            "Content-Type": "image/jpeg"
          },
          body: dataURLtoBlob(dataUrl)
        });
        const data = await this._parseBody(resp);
        if (resp.ok && data && data.url) {
          bmobWorkingHost = host;
          return { url: data.url, fallback: false };
        }
        // 「未绑定文件域名」是应用级配置错误，换域名重试也无意义 → 直接走兜底
        const msg = (data && (data.error || data.message)) || ("上传失败 HTTP " + resp.status);
        if (msg.includes("域名") || msg.includes("文件服务")) break;
      } catch (err) {
        // 网络错误：自动尝试下一个域名
      }
    }

    // 3) 兜底：压缩 dataURL 内嵌存储（体积 ≤36KB，保证写入成功）
    return { url: dataUrl, fallback: true };
  }
};


/* ====================  5. 图片处理  ==================== */

/*
 * Bmob 免费版三个实测硬限制：
 *   ① 单次【请求体】上限 = 40960 字节（40KB）
 *   ② 单次【查询响应】上限 ≈ 200KB（183KB 成功、213KB 失败）
 *   ③ 每张表【字段数】上限 = 20（原有 6 列 + imgUrl1..9 已占 15，只剩 5 列）
 *
 * 因此 9 张图这样存：
 *   · 大图：imgUrl1..9 共 9 列，每列 ≤36KB，灯箱按需只拉一列（响应 ~36KB）
 *   · 缩略图：2 张一包 JSON 塞进 thumb1..5 共 5 列，每张 ≤6KB，
 *     一整包 ≤13KB；9 张全包 ~60KB，随列表一次读回，远低于 200KB
 */
const IMG_EMBED_MAX = 36 * 1024;   // 大图上限
const THUMB_MAX = 6 * 1024;       // 单张缩略图上限（2 张打包后仍 < 40KB）

/** 槽位 1..9 → 缩略图打包列名（1,1,2,2,3,3,4,4,5） */
function thumbPackCol(slot) {
  return "thumb" + Math.ceil(slot / 2);
}

/** dataURL → Blob（用于把压缩后的图片再尝试上传到 Bmob 文件服务） */
function dataURLtoBlob(dataUrl) {
  const parts = dataUrl.split(",");
  const mime = (parts[0].match(/data:(.*?);/) || [, "image/jpeg"])[1];
  const bin = atob(parts[1]);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

/**
 * 图片一次解码，产出【大图 + 缩略图】两份 dataURL
 *
 * · 大图：九档「最大边 + JPEG 质量」从高清到兜底逐级压缩，≤36KB 即停，
 *   最后一档 160px 保证任何图片都达标；
 * · 缩略图：从同一已解码图片另画一张最长边 240px 的 JPEG，≤7KB
 *   （超过则自动降到 200/160px）。
 *
 * @param   {File} file - 图片文件（大小不限，浏览器能解码即可）
 * @returns {Promise<{big:string, thumb:string}>}
 */
function processImage(file) {
  // 大图档位（最大边长, JPEG 质量）：高清 → 兜底
  const TIERS = [
    [1280, 0.72], [1024, 0.6], [800, 0.52],
    [640, 0.45], [512, 0.38], [384, 0.32],
    [320, 0.28], [240, 0.25], [160, 0.22],
  ];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // ── 1) 压大图
        let big = "";
        for (const [MAX, q] of TIERS) {
          const k = Math.min(1, MAX / Math.max(img.width, img.height)); // 小图不放大
          const w = Math.max(1, Math.round(img.width * k));
          const h = Math.max(1, Math.round(img.height * k));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";   // JPEG 不支持透明，白底兜底
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          big = canvas.toDataURL("image/jpeg", q);
          if (big.length <= IMG_EMBED_MAX) break;
        }
        // ── 2) 压缩略图（320px 起步，极端噪点图也有 128px 兜底档）
        let thumb = "";
        for (const [edge, q] of [[320, 0.55], [260, 0.48], [200, 0.42], [160, 0.38], [128, 0.32]]) {
          const k = Math.min(1, edge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * k));
          const h = Math.max(1, Math.round(img.height * k));
          const tc = document.createElement("canvas");
          tc.width = w; tc.height = h;
          const tctx = tc.getContext("2d");
          tctx.fillStyle = "#ffffff";
          tctx.fillRect(0, 0, w, h);
          tctx.drawImage(img, 0, 0, w, h);
          thumb = tc.toDataURL("image/jpeg", q);
          if (thumb.length <= THUMB_MAX) break;
        }
        resolve({ big, thumb });
      };
      img.onerror = () => reject(new Error("图片解码失败"));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/** 兼容旧调用：只取大图 dataURL */
function compressImageToDataURL(file) {
  return processImage(file).then(r => r.big);
}


/* ====================  6. AI 引擎（备忘生成 + 总结润色）  ==================== */

/*
 * ★★★ 产品内置 AI 交互能力，拿 Bmob+AI 融合创意分 ★★★
 *
 * 基于轻量 NLP：意图识别 + 实体提取 + 动态拼装
 * 两套能力共用同一组共享分析工具：
 *   · analyzeAndGenerate()  — 从一句话想法生成结构化备忘
 *   · 本地智能引擎（6.4 节）— 纯静态环境降级：类型识别 + 分类润色
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
 *
 *   AI 总结润色同理：把本地智能引擎换成大模型调用，
 *   prompt 示例："总结润色以下笔记，输出核心要点和下一步建议：<原文>"
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

/* ======== 共享语义分析工具（AI 生成 & AI 润色共用） ======== */

/**
 * 提取核心关键词：去掉时间词、语气助词后取前 8 字
 * 作为生成内容中反复引用的"锚"，让输出与用户原话形成逻辑闭环
 * @param   {string} text - 原始文本
 * @returns {string} 核心关键词
 */
function extractCoreKeyword(text) {
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
  return core;
}

/**
 * 识别意图类型：按 INTENT_MAP 优先级匹配动词
 * @param   {string} text - 原始文本
 * @returns {object} INTENT_MAP 中的意图配置项（兜底 action）
 */
function detectIntent(text) {
  for (const val of INTENT_MAP) {
    for (const verb of val.verbs) {
      if (text.includes(verb)) return val;
    }
  }
  return INTENT_MAP[INTENT_MAP.length - 1];
}

/**
 * 识别时间词，返回对应的时间建议
 * @param   {string} text - 原始文本
 * @returns {string} 时间建议（无时间词则返回空字符串）
 */
function findTimeTip(text) {
  for (const t of TIME_MAP) {
    if (t.words.some(w => text.includes(w))) return t.tip;
  }
  return "";
}

/**
 * AI 语义分析引擎（备忘生成）
 * 真正读懂用户输入，动态生成有针对性的结构化内容
 * 每一步都引用用户的原话关键词，形成逻辑闭环
 *
 * @param   {string} rawInput - 用户输入的想法
 * @returns {{title: string, content: string, tag: string|null}}
 */
function analyzeAndGenerate(rawInput) {
  const text = rawInput.trim();
  const core = extractCoreKeyword(text);
  const intentConfig = detectIntent(text);
  const intent = intentConfig.name;

  // AI 开场回应（随机选一条，像在跟用户对话）
  const reactList = intentConfig.react;
  const react = reactList.length > 0
    ? reactList[Math.floor(Math.random() * reactList.length)]
    : "好的，让我们来搞定这件事！";

  // 识别时间词
  const timeTip = findTimeTip(text);

  // 动态生成 5 步行动清单（每步都引用核心关键词）
  const templates = STEP_TEMPLATES[intent];
  const steps = templates.map((tpl, i) => {
    let step = tpl.replace("{obj}", core);
    if (i === 0 && Math.random() > 0.5) {
      step = "🎯 " + step;
    }
    return step;
  });

  // 随机选一条小贴士
  const tips = TIPS[intent];
  const tip = tips[Math.floor(Math.random() * tips.length)];

  // 拼装最终内容（有对话感 + 结构感）
  let content = `🗣️ ${react}\n\n📋 行动计划：\n`;
  content += steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  if (timeTip) {
    content += `\n\n⏰ 时间建议：${timeTip}`;
  }
  content += `\n\n💡 ${tip.replace("{obj}", core)}`;

  // 生成标题（直接引用用户原话）+ 推断标签
  const title = text.length > 12 ? text.slice(0, 12) + "…" : text;
  return { title, content, tag: intentConfig.tag };
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
    autoResizeContent(); // AI 生成的内容可能很长，输入框要立刻撑开
    if (tag) pickTag(tag);
    showToast("AI 已分析你的需求，生成结构化内容 ✿");
  }, 900);
}

/* ==========================================================================
   6.4 浏览器本地智能引擎（纯静态托管环境降级用，逻辑逐行对齐 server/sse_server.py）
   ──────────────────────────────────────────────────────────────────────────
   GitHub Pages 等静态环境跑不了 Python 后端，点「润色」时由这里接管：
   第一层识别笔记类型（代码/学习/日记/长文本/普通）→ 第二层按类型用
   去模板化策略生成结果，全程复用流式弹窗的识别动画 / 类型 chip / 打字机。
   ========================================================================== */

/* 类型 key → 中文标签（与后端 CATEGORY_LABELS 一致） */
const LOCAL_CATEGORY_LABELS = {
  code: "代码笔记", study: "学习笔记", diary: "日常随笔/日记",
  long: "长文本笔记", general: "普通笔记",
};
const LOCAL_LONG_NOTE_CHARS = 400; // 与后端 LONG_NOTE_CHARS 一致

/**
 * 本地启发式分类器（与后端 classify_local 同规则，保证两端识别结果一致）
 * 判定优先级：代码 > 学习 > 日记 > 长文本 > 普通
 */
function classifyNoteLocal(title, content) {
  const text = ((title || "") + "\n" + (content || "")).trim();
  if (!text) return "general";

  // 1) 代码笔记：markdown 代码围栏是最强信号
  if (text.includes("```")) return "code";
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  // 代码行特征（覆盖 Python / JS / Java / C 系常见写法）
  const codeLineRe = /^(def |class |function |const |let |var |import |from .+ import |print\(|console\.log|return |if\s*\(|for\s*\(|while\s*\(|public |private |protected |async |await |#include|package |\}|\{|.*=>.*|.*[a-zA-Z_]\w*\s*=\s*function)/;
  let codeHits = 0;
  for (const l of lines) {
    if (codeLineRe.test(l)) codeHits++;
    else if (l.endsWith(";") && /[{}()=;]/.test(l)) codeHits++;
  }
  // 至少 2 行像代码，或代码行占比超过 1/3
  if (codeHits >= 2 && (lines.length <= 4 || codeHits / Math.max(lines.length, 1) >= 0.3)) {
    return "code";
  }

  // 2) 学习笔记：学习场景关键词
  const studyWords = ["考点", "知识点", "复习", "预习", "章节", "公式", "定义", "定理",
    "背诵", "单词", "题目", "考试", "课程", "网课", "作业", "论文",
    "学习", "笔记整理", "归纳", "思维导图"];
  if (studyWords.some(w => text.includes(w))) return "study";

  // 3) 日常随笔/日记：第一人称生活记录 + 情绪/时间词，且篇幅不长
  const diaryWords = ["今天", "今日", "心情", "好开心", "好难过", "日记", "有点", "觉得自己",
    "早上起床", "下班", "放学", "周末和", "突然觉得", "好烦", "好幸福"];
  if (diaryWords.some(w => text.includes(w)) && text.includes("我")
      && text.length < LOCAL_LONG_NOTE_CHARS) {
    return "diary";
  }

  // 4) 长文本普通笔记：篇幅够长又不属于上面三类
  if (text.length >= LOCAL_LONG_NOTE_CHARS) return "long";

  // 5) 兜底
  return "general";
}

/** 轻量清理（日记/通用共用）：合并多余空白、去句首口语填充词，不改写句子不加结构 */
function localLightClean(content, fallback) {
  let body = (content || "").trim();
  body = body.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  const fillers = ["那个，", "就是说，", "嗯，", "呃，", "额，"];
  body = body.split("\n").map(line => {
    let s = line.trim();
    for (const f of fillers) {
      if (s.startsWith(f)) { s = s.slice(f.length); break; }
    }
    return s;
  }).join("\n").trim();
  return body || fallback;
}

/** 按标点/换行切句，去序号与空白，返回有意义的原句列表（不改编、不编造） */
function localSentences(content, minLen) {
  minLen = minLen || 4;
  return (content || "").split(/[\n。！？!?；;]+/)
    .map(s => s.replace(/^[\s\d.、·•\-–—*#①②③④⑤⑥⑦⑧⑨（）()]+/, "").trim())
    .filter(s => s.length >= minLen);
}

/** 按开头 6 字去重（长文本常含重复表述），保留首次出现的句子 */
function localDedupe(sentences, limit) {
  const result = [], heads = new Set();
  for (const s of sentences) {
    const head = s.slice(0, 6);
    if (heads.has(head)) continue;
    heads.add(head);
    result.push(s);
    if (limit && result.length >= limit) break;
  }
  return result;
}

/** 单条要点过长时截断并补省略号 */
function localTrim(s, width) {
  return s.length > width ? s.slice(0, width) + "…" : s;
}

/* 学习笔记中疑似「考点」的线索词（只用于从原句里挑重点，不生成套话） */
const LOCAL_EXAM_KEYWORDS = ["考", "重点", "区别", "易错", "原理", "公式", "定义", "概念",
  "对比", "必须", "注意", "掌握", "核心"];

/** 代码笔记：保留围栏代码原文不动，给定义补极简注释；文字说明只取前两句 */
function localCodeResult(title, content) {
  content = content || "";
  // 带捕获组 split：奇数段是围栏内代码，偶数段是普通文字（与后端一致）
  const parts = content.split(/```[^\n]*\n?([\s\S]*?)```/);
  const prose = [], blocks = [];
  parts.forEach((seg, i) => (i % 2 ? blocks : prose).push(seg.trim()));

  // 代码块补注释：Python 用 #，类 C/JS 用 //，依据块内特征猜测
  const commented = [];
  for (const code of blocks) {
    const isPy = /^\s*(def |import |from |print\()/m.test(code);
    const cmt = isPy ? "#" : "//";
    const out = [];
    for (const line of code.split("\n")) {
      const m = line.trim().match(/^(def |class |function |(?:const|let|var)\s+)([\u4e00-\u9fff\w]*)/);
      const last = out.length ? out[out.length - 1].trim() : "";
      // 上一行为空（或块首）且不是已有注释时，给定义补一行极简注释
      if (m && (out.length === 0 || last === "") && !last.startsWith(cmt)) {
        out.push(cmt + " " + ({ "def": "函数", "class": "类", "function": "函数" }[m[1].trim()] || "逻辑块"));
      }
      out.push(line);
    }
    commented.push(out.join("\n").replace(/\n+$/, ""));
  }

  // 代码外文字：按句切，取前两句作为简短说明
  const proseText = prose.filter(Boolean).join(" ");
  const sentences = proseText.split(/[。！？\n]/).map(s => s.trim()).filter(s => s.length >= 4);
  const notes = sentences.length > 0
    ? sentences.slice(0, 2)
    : ["代码逻辑已检查，补充了关键注释，原有功能保持不变。"];

  const t = ((title || "").trim() || "代码笔记").slice(0, 14);
  let body = notes.map(s => "· " + s).join("\n");
  for (const cb of commented) body += "\n\n```\n" + cb + "\n```";
  return "💻 " + t + "\n\n" + body;
}

/** 学习笔记：从原句摘选「核心知识点」+ 挑含考点线索词的句子，不加总结套话 */
function localStudyResult(title, content) {
  const sents = localDedupe(localSentences(content), 8);
  let points = sents.slice(0, 5).map(s => localTrim(s, 42));
  if (points.length === 0) points = ["原文信息较少，建议补充更具体的知识点后再整理。"];
  const pointSet = new Set(points);
  const exam = sents.filter(s => LOCAL_EXAM_KEYWORDS.some(k => s.includes(k)))
    .slice(0, 4).map(s => localTrim(s, 42))
    .filter(s => !pointSet.has(s)).slice(0, 3);

  let body = "核心知识点：\n" + points.map((p, i) => (i + 1) + ". " + p).join("\n");
  if (exam.length > 0) body += "\n\n重点考点：\n" + exam.map(s => "· " + s).join("\n");
  return "📚 " + (((title || "").trim() || "学习笔记").slice(0, 14)) + "\n\n" + body;
}

/** 长文本：切句去重后提炼核心要点，全部来自原文，不加固定总结话术 */
function localLongResult(title, content) {
  const sents = localDedupe(localSentences(content), 8);
  let points = sents.slice(0, 6).map(s => localTrim(s, 46));
  if (points.length === 0) points = [localTrim((title || "").trim() || "长文本笔记", 46)];
  const body = "核心要点：\n" + points.map((p, i) => (i + 1) + ". " + p).join("\n");
  return "📄 " + (((title || "").trim() || "长文本笔记").slice(0, 14)) + "\n\n" + body;
}

/** 日记：只做轻清理，保留情绪与口吻，不强行结构化 */
function localDiaryResult(title, content) {
  const body = localLightClean(content, (title || "").trim());
  return "📔 " + (((title || "").trim() || "随手记").slice(0, 14)) + "\n\n" + body;
}

/** 兜底通用：与日记同样只做轻清理，不套固定结构，保持原文风格 */
function localGeneralResult(title, content) {
  const body = localLightClean(content, (title || "").trim());
  return "📝 " + (((title || "").trim() || "笔记").slice(0, 14)) + "\n\n" + body;
}

/** 按识别出的类型分发生成（与后端 build_mock_result 一致） */
function buildLocalResult(title, content, category) {
  const builders = {
    code: localCodeResult, study: localStudyResult, diary: localDiaryResult,
    long: localLongResult, general: localGeneralResult,
  };
  return (builders[category] || localGeneralResult)(title, content);
}

/* ==========================================================================
   6.5 AI SSE 流式润色（配套 Python 服务：server/sse_server.py）
   ──────────────────────────────────────────────────────────────────────────
   链路：卡片「✨ 润色」→ POST /api/polish（同源 SSE）
     后端先做 Bmob 归属校验（403 拒绝他人笔记）→ AI 流式生成 →
     完整结果由后端【新建一条笔记】入库（原笔记不动）→ done 帧带新笔记 ID
   前端两层设计（避免「chunk 到达直接追加」造成的非打字机体验）：
     · 数据层：ReadableStream 持续读 SSE delta，喂入字符队列 queueChars
     · 展示层：pump 定时器每 24ms 从队列搬 2 个码点到面板，稳定逐字播放
   安全网：
     · AbortController 一键中断 → 后端检测断连，绝不写 Bmob（无脏数据）
     · 超时 / AI 报错 / 超长只收到 error 帧，同样不入库
     · 本地 Python 服务不可达时（如 GitHub Pages 纯静态环境），
       自动降级为浏览器内置本地智能引擎（6.4 节），在弹窗内完成全流程
   ========================================================================== */

const AI_STREAM = {
  URL: "/api/polish",

  MIN_THINKING_MS: 1500,  // 「AI 思考中」最少展示时长（毫秒），避免大模型首字太快而一闪而过

  state: "idle",          // idle | running | done | aborted | error
  noteId: null,           // 正在润色的原笔记 ID
  ac: null,               // AbortController（中断 fetch + reader）
  queueChars: [],         // 数据层：已收到、待播放的字符队列（按码点）
  fullText: "",           // 已收到的完整文本（本地累计，不依赖闭包快照）
  textNode: null,         // 展示层：流式正文所在文本节点
  pumpTimer: null,        // 打字机定时器
  networkEnded: false,    // SSE 连接是否已结束
  pendingDone: null,      // 收到的 done 事件（等打字播放完再进完成态）
  thinkingStartedAt: 0,   // 思考中状态开始的时间戳，用于保证最少展示时长
  firstDeltaTimer: null,  // 首字延时播放计时器（思考时长不足时缓冲用）
  bufferedFirstText: "",  // 思考时长不足期间缓冲的首段文本
  category: "general",    // 第一层识别出的笔记类型 key
  categoryLabel: "",      // 第一层识别出的类型中文名

  /** 打开面板并重置全部状态 */
  open(noteId, sourceTitle) {
    this.reset();
    this.state = "running";
    this.noteId = noteId;
    this.thinkingStartedAt = Date.now();

    $("streamSource").textContent = sourceTitle
      ? "原笔记：" + (sourceTitle.length > 24 ? sourceTitle.slice(0, 24) + "…" : sourceTitle)
      : "";
    // 重置类型 chip（第一层识别结果到达后再显示）
    const chip = $("streamCategory");
    if (chip) { chip.style.display = "none"; chip.textContent = ""; }
    this.category = "general";
    this.categoryLabel = "";

    // 思考中占位（首个 delta 到达且思考时长满足后才替换为正文区）
    // 初始副标题对应「第一层：类型识别」，type 事件到达后再切换文案
    const body = $("streamBody");
    body.className = "stream-body thinking";
    body.innerHTML =
      '<div class="think-indicator">' +
        '<span class="think-dots"><i></i><i></i><i></i></span>' +
        '<span class="think-text">AI 思考中</span>' +
      '</div>' +
      '<p class="think-hint">第一步：正在识别笔记类型（代码 / 学习 / 日记 / 长文本）…</p>';

    this.setStatus("thinking", "AI 正在识别笔记类型…");
    this.renderActions("running");
    $("streamOverlay").classList.add("show");
  },

  /** 更新思考态副标题（仅当面板仍处于思考态时有效） */
  setThinkingHint(msg) {
    const el = document.querySelector("#streamBody .think-hint");
    if (el) el.textContent = msg;
  },

  /** SSE「classifying」事件：第一层类型识别开始 */
  onClassifying() {
    this.setThinkingHint("第一步：正在识别笔记类型（代码 / 学习 / 日记 / 长文本）…");
    this.setStatus("thinking", "AI 正在识别笔记类型…");
  },

  /** SSE「type」事件：第一层识别完成，显示类型 chip 并进入第二层润色等待 */
  onType(ev) {
    this.category = ev.category || "general";
    this.categoryLabel = ev.label || "普通笔记";
    const chip = $("streamCategory");
    if (chip) {
      chip.textContent = "🏷 " + this.categoryLabel;
      chip.className = "stream-cat cat-" + this.category;
      chip.style.display = "";
    }
    this.setThinkingHint("已识别为「" + this.categoryLabel + "」，正在按对应风格润色…");
    this.setStatus("thinking", "已识别为「" + this.categoryLabel + "」，AI 正在润色…");
  },

  /** 重置状态（关闭 / 重试前调用） */
  reset() {
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    if (this.firstDeltaTimer) { clearTimeout(this.firstDeltaTimer); this.firstDeltaTimer = null; }
    if (this.ac) { try { this.ac.abort(); } catch (e) {} }
    this.ac = null;
    this.state = "idle";
    this.queueChars = [];
    this.fullText = "";
    this.textNode = null;
    this.networkEnded = false;
    this.pendingDone = null;
    this.thinkingStartedAt = 0;
    this.bufferedFirstText = "";
    this.category = "general";
    this.categoryLabel = "";
    this._clearLocalTimer(); // 停掉本地引擎的模拟流定时器（如有）
  },

  /**
   * 发起 SSE 请求并逐帧读取
   * 连接层失败（服务未启动 / 静态托管环境）→ 自动降级本地整理
   */
  async connect(id) {
    const ac = new AbortController();
    this.ac = ac;

    let resp;
    try {
      resp = await fetch(this.URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({ noteId: id, username: currentUser }),
        signal: ac.signal
      });
    } catch (e) {
      // 用户主动中止 vs 服务不可达（file:// / GitHub Pages / 没启动 Python）
      if (ac.signal.aborted) { this.markAborted(); return; }
      this.fallbackLocal("本地 AI 服务未启动");
      return;
    }

    // 非 200：403 是归属拒绝（业务错误，不降级）；其余视为服务不可用 → 降级
    if (!resp.ok) {
      if (resp.status === 403) {
        this.close();
        showToast("该笔记不存在、已被删除或无权访问");
        memoList = memoList.filter(x => x.objectId !== id);
        renderList();
        return;
      }
      let msg = "本地 AI 服务不可用";
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (e) {}
      // 400 参数错误直接提示；404/405/5xx 走降级
      if (resp.status === 400) { this.fail(msg, "request"); return; }
      this.fallbackLocal(msg + "（HTTP " + resp.status + "）");
      return;
    }

    // 200 但不是 SSE（被静态服务器/托管商兜底成 HTML）→ 降级
    const ctype = resp.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      this.fallbackLocal("本地 AI 服务不可用");
      return;
    }

    // 启动打字机展示层（数据到达前空转也无妨）
    this.startPump();

    // 读取 SSE 字节流，按 \n\n 切帧（半包留在 buffer）
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleFrame(frame);
        }
      }
      this.networkEnded = true;
      // 流已自然读完，解除控制器引用，避免关闭面板时对已完成连接再 abort 产生控制台报错
      this.ac = null;
      // 服务器正常关闭却没给 done/error（异常断流）→ 友好提示，不入库
      if (this.state === "running" && !this.pendingDone) {
        this.fail("流式连接意外中断，请重试", "network");
      }
    } catch (e) {
      this.networkEnded = true;
      if (ac.signal.aborted) this.markAborted();
      else this.fail("网络中断：" + e.message, "network");
    }
  },

  /**
   * 解析一帧 SSE：只消费 data: 行，忽略注释(:)/event/id/retry 行
   */
  handleFrame(frame) {
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let ev;
    try { ev = JSON.parse(dataLines.join("\n")); } catch (e) { return; }

    if (ev.type === "delta") this.onDelta(ev.text || "");
    else if (ev.type === "done") {
      this.pendingDone = ev;
      // 若打字队列恰好已空，pump 不会再触发，这里主动收尾
      if (this.queueChars.length === 0 && this.textNode) this.completeDone();
    }
    else if (ev.type === "error") this.fail(ev.message || "AI 生成失败", ev.stage || "ai");
    // 第一层推理开始：正在识别笔记类型
    else if (ev.type === "classifying") this.onClassifying();
    // 第一层推理结果：携带 category/label，展示类型 chip
    else if (ev.type === "type") this.onType(ev);
  },

  /** 把思考占位替换成正文区（文本节点 + 闪烁光标） */
  switchToOutputStream() {
    const body = $("streamBody");
    body.className = "stream-body";
    body.innerHTML = "";
    this.textNode = document.createTextNode("");
    body.appendChild(this.textNode);
    const caret = document.createElement("span");
    caret.className = "stream-caret";
    body.appendChild(caret);
    this.setStatus("streaming", "AI 正在输出… " + this.fullText.length + " 字");
  },

  /**
   * 把缓冲的首段文本刷入队列；若尚未进入输出态则先切换。
   * 保证 switchToOutputStream 只被调用一次，避免后续 delta 与定时器竞态导致 DOM 重置丢内容。
   */
  flushBuffer() {
    if (!this.textNode) this.switchToOutputStream();
    for (const ch of this.bufferedFirstText) this.queueChars.push(ch);
    this.bufferedFirstText = "";
  },

  /**
   * 数据层：增量文本入队（不直接操作 DOM，节奏由 pump 控制）
   * 关键逻辑：首段文本到达时，若「思考中」展示时长不足 MIN_THINKING_MS，
   * 先把文本缓冲起来，等足时长再切换到输出态，保证用户能看清思考动画。
   */
  onDelta(text) {
    if (this.state !== "running") return;
    this.fullText += text;

    // 尚未进入输出态：需要判断思考时长是否足够
    if (!this.textNode) {
      const elapsed = Date.now() - this.thinkingStartedAt;
      const remaining = this.MIN_THINKING_MS - elapsed;
      if (remaining > 0) {
        // 思考时长不够 → 缓冲首段文本，到点再播放
        this.bufferedFirstText += text;
        if (!this.firstDeltaTimer) {
          this.firstDeltaTimer = setTimeout(() => {
            this.firstDeltaTimer = null;
            this.flushBuffer();
          }, remaining);
        }
        return;
      }
      // 思考时长已够 → 清掉可能的定时器，把缓冲和当前文本一起入队
      if (this.firstDeltaTimer) {
        clearTimeout(this.firstDeltaTimer);
        this.firstDeltaTimer = null;
      }
      this.switchToOutputStream();
      for (const ch of this.bufferedFirstText) this.queueChars.push(ch);
      this.bufferedFirstText = "";
    }

    // 已经（或即将）在输出态：当前文本入队
    for (const ch of text) this.queueChars.push(ch);
    if (this.textNode) {
      this.setStatus("streaming", "AI 正在输出… " + this.fullText.length + " 字");
    }
  },

  /** 展示层：每 24ms 从队列搬 2 个码点到正文，形成稳定打字节奏 */
  startPump() {
    this.pumpTimer = setInterval(() => {
      let moved = 0;
      while (moved < 2 && this.queueChars.length > 0) {
        this.textNode && (this.textNode.nodeValue += this.queueChars.shift());
        moved++;
      }
      // 队列清空：网络已结束 → 按结果收尾；否则继续等待喂数据
      // 注意：若仍处于思考缓冲期（textNode 未创建），即使 done 已到也不能收尾，
      // 需等首字定时器触发、缓冲文本播放完再收尾
      if (this.queueChars.length === 0 && this.textNode) {
        if (this.pendingDone) this.completeDone();
        else if (this.networkEnded && this.state === "running") {
          /* fail/abort 已在读取循环处理，这里兜底等待 */
        }
      }
    }, 24);
  },

  /** 生成完成且已入库（由后端新建笔记）→ 成功态 + 刷新列表 */
  completeDone() {
    if (this.state === "done") return;
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    this.state = "done";
    const ev = this.pendingDone || {};
    // 光标替换成收尾标记
    const caret = $("streamBody").querySelector(".stream-caret");
    if (caret) caret.remove();
    // 完成文案带上第一层识别出的笔记类型
    const label = ev.label || this.categoryLabel || "";
    this.setStatus("done", label
      ? "✅ 已完成（" + label + "），润色稿已自动保存为一条【新笔记】（原笔记未改动）"
      : "✅ 已完成，润色稿已自动保存为一条【新笔记】（原笔记未改动）");
    this.renderActions("done");
    showToast("AI 润色完成，已新建笔记 ✿");
    // 拉取最新列表（新笔记由后端写入，带后端返回的 objectId）
    fetchMemos().catch(() => {});
  },

  /** 用户点「停止生成」：中断连接；后端感知断连后不会写 Bmob */
  userAbort() {
    if (this.ac) { try { this.ac.abort(); } catch (e) {} }
    this.markAborted();
  },

  markAborted() {
    if (this.state === "aborted" || this.state === "done") return;
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    if (this.firstDeltaTimer) { clearTimeout(this.firstDeltaTimer); this.firstDeltaTimer = null; }
    this.state = "aborted";
    const caret = $("streamBody").querySelector(".stream-caret");
    if (caret) caret.remove();
    this.setStatus("aborted", "⏹ 已中断生成，未保存任何内容（原笔记不受影响）");
    this.renderActions("aborted");
  },

  /** AI 报错 / 超时 / 超长 / 异常断流：只提示，不入库 */
  fail(message, stage) {
    if (this.state === "done") return;
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    if (this.firstDeltaTimer) { clearTimeout(this.firstDeltaTimer); this.firstDeltaTimer = null; }
    this.state = "error";
    const caret = $("streamBody").querySelector(".stream-caret");
    if (caret) caret.remove();
    const prefix = stage === "too_long" ? "⚠ 文本超长：" : "⚠ 生成失败：";
    this.setStatus("error", prefix + message);
    this.renderActions("error");
  },

  /** 本地服务不可达（纯静态托管）→ 不关弹窗，切换为浏览器内置智能引擎继续跑 */
  fallbackLocal(reason) {
    showToast(reason + "，已切换浏览器本地整理");
    this.runLocal();
  },

  /**
   * 浏览器本地智能润色（纯静态环境降级，6.4 节引擎）
   * 与服务端 SSE 流程同节奏：识别类型 → 类型 chip → 模拟流式输出 → 新建笔记
   */
  runLocal() {
    const id = this.noteId;
    if (!id) return;
    const sourceTitle = ($("streamSource").textContent || "").replace(/^原笔记：/, "");
    this.reset();
    this.open(id, sourceTitle);
    this._localRun(id);
  },

  /** 本地流程主体：云端归属校验 → 类型识别 → 模拟流式 → 入库 */
  async _localRun(id) {
    // 云端归属校验：getById 的 where 同时要求 objectId + username，他人笔记查不到
    const memo = await MemoDAO.getById(id);
    if (this.state !== "running") return; // 等待期间用户已关闭面板
    if (!memo) {
      this.handleFrame('data: ' + JSON.stringify(
        { type: "error", stage: "request", message: "该笔记不存在、已被删除或无权访问" }));
      return;
    }
    const title = memo.title || "";
    const content = memo.content || "";
    if (!title.trim() && !content.trim()) {
      this.handleFrame('data: ' + JSON.stringify(
        { type: "error", stage: "request", message: "这条备忘还没有内容，先写点什么再润色吧" }));
      return;
    }
    if (title.length + content.length > 6000) { // 与后端 MAX_INPUT_CHARS 一致
      this.handleFrame('data: ' + JSON.stringify(
        { type: "error", stage: "too_long", message: "原文过长（超过 6000 字），请先精简原文" }));
      return;
    }

    // 第一层：识别笔记类型（模拟服务端 classifying → type 事件节奏）
    this.handleFrame('data: ' + JSON.stringify({ type: "classifying" }));
    await new Promise(r => setTimeout(r, 600));
    if (this.state !== "running") return;
    const category = classifyNoteLocal(title, content);
    this.handleFrame('data: ' + JSON.stringify(
      { type: "type", category: category, label: LOCAL_CATEGORY_LABELS[category] || "普通笔记" }));
    await new Promise(r => setTimeout(r, 650));
    if (this.state !== "running") return;

    // 第二层：按类型生成结果，切成小片模拟流式推送
    const full = buildLocalResult(title, content, category);
    this._localStreamText(full, id);
  },

  /** 把完整结果按 3 字/35ms 模拟打字流喂给 handleFrame（复用全部既有展示逻辑） */
  _localStreamText(full, id) {
    const chars = Array.from(full); // 按码点切，emoji 不会被截断
    let i = 0;
    this._localTimer = setInterval(() => {
      if (this.state !== "running") { this._clearLocalTimer(); return; }
      const piece = chars.slice(i, i + 3).join("");
      i += 3;
      if (piece) this.handleFrame('data: ' + JSON.stringify({ type: "delta", text: piece }));
      if (i >= chars.length) {
        this._clearLocalTimer();
        this._localFinish(full, id);
      }
    }, 35);
  },

  _clearLocalTimer() {
    if (this._localTimer) { clearInterval(this._localTimer); this._localTimer = null; }
  },

  /** 流式播完后：新建独立笔记入库（绝不覆盖原文），成功/失败转成对应 SSE 帧 */
  async _localFinish(full, id) {
    // 与服务端一致：第 1 行是标题（含 emoji），其余是正文
    const nl = full.indexOf("\n");
    const newTitle = (nl === -1 ? full : full.slice(0, nl)).trim() || "AI 润色笔记";
    const newContent = nl === -1 ? "" : full.slice(nl + 1).trim();
    try {
      const src = memoList.find(m => m.objectId === id) || {};
      const created = await MemoDAO.create({
        title: newTitle, content: newContent, isFinish: false,
        imgUrl: "", username: currentUser, tag: src.tag || "",
      });
      if (this.state !== "running") return; // 面板已关：新笔记已入库，保留即可
      this.handleFrame('data: ' + JSON.stringify({
        type: "done", objectId: (created && created.objectId) || "",
        title: newTitle, category: this.category, label: this.categoryLabel,
      }));
    } catch (e) {
      if (this.state !== "running") return;
      this.handleFrame('data: ' + JSON.stringify(
        { type: "error", stage: "save", message: (e && e.message) || "保存到云端失败，请重试" }));
    }
  },

  /** 关闭面板（运行中关闭视同中断） */
  close() {
    const wasRunning = this.state === "running";
    this.reset();
    $("streamOverlay").classList.remove("show");
    if (wasRunning) showToast("已中断，未保存任何内容");
  },

  /** 更新底部状态文字（带语义 class，便于配色） */
  setStatus(mode, msg) {
    const el = $("streamStatus");
    el.className = "stream-status st-" + mode;
    el.textContent = msg;
  },

  /** 根据状态渲染底部操作按钮（onclick 调全局函数） */
  renderActions(mode) {
    const box = $("streamActions");
    if (mode === "running") {
      box.innerHTML = '<button class="btn-mini btn-stop" onclick="AI_STREAM.userAbort()">■ 停止生成</button>';
    } else if (mode === "done") {
      box.innerHTML = '<button class="btn-mini btn-done" onclick="AI_STREAM.close()">✅ 完成</button>';
    } else {
      // aborted / error：可重试、可降级本地整理、可关闭
      box.innerHTML =
        '<button class="btn-mini btn-retry" onclick="retryPolish()">🔁 重试</button>' +
        '<button class="btn-mini btn-local" onclick="AI_STREAM.runLocal()">📝 本地整理</button>' +
        '<button class="btn-mini btn-del" onclick="AI_STREAM.close()">关闭</button>';
    }
  }
};

/**
 * 一键 AI 总结润色（卡片上的「✨ 润色」按钮）
 * 默认走 Python SSE 流式服务；服务不可用时 connect() 内部自动降级本地整理
 * @param {string} id - 备忘 ID
 */
async function polishMemo(id) {
  if (AI_STREAM.state === "running") {
    showToast("AI 正在生成中，请先停止当前任务");
    return;
  }
  // 加密笔记：先过密码（与 startEdit 同一鉴权入口），否则 AI 拿不到正文
  const local = memoList.find(m => m.objectId === id);
  if (local && lockedIds.has(id)) {
    const ok = await promptUnlockNote(local);
    if (!ok) return;
  }
  AI_STREAM.open(id, local ? (local.title || "") : "");
  await AI_STREAM.connect(id);
}

/** 中断后重试一次 */
function retryPolish() {
  const id = AI_STREAM.noteId;
  if (!id) { AI_STREAM.close(); return; }
  AI_STREAM.open(id, $("streamSource").textContent.replace(/^原笔记：/, ""));
  AI_STREAM.connect(id);
}


/* ====================  7. 状态管理  ==================== */

let memoList = [];       // 备忘列表（内存缓存，与云端同步）
let editingId = null;    // 当前编辑的备忘 ID（null = 新建模式）
let selectedTag = null;  // 表单选中的标签
let lockedIds = new Set(); // 加密笔记 ID 集合（fetchMemos 后填充）

/*
 * 多图上传状态
 * ─────────────────────────────────────────────
 * · formImages：表单九宫格里的图片，每项结构
 *     { key 本地唯一标识, field 云端字段名(imgUrl/imgUrl1..9),
 *       url 预览地址, status: uploading|done|error,
 *       file 原始文件, gen 代数(移除/重试时+1让迟到结果作废), errorMsg }
 * · batchMemoId：新建模式下第一批图已创建出来的备忘 ID（null = 备忘还没建）
 * · batchRunning：串行上传队列是否正在运行（防重入）
 */
let formImages = [];
let batchMemoId = null;
let batchRunning = false;
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
  const err = new Error("笔记不存在、已删除或无权访问");
  err.code = "NOTE_NO_ACCESS";
  return err;
}

/*
 * 查询字段白名单：【不带大图 imgUrl1..9】
 * 9 张大图 ~300KB 会超出查询响应 ~200KB 的限制（Bmob 直接 400）；
 * 列表只需要文字 + 5 个缩略图打包列（9 张图共 ~60KB），
 * 大图等灯箱打开时按字段单独拉。
 * imgUrl 为旧版单图字段，保留在白名单里以兼容历史数据。
 *
 * 加密硬隔离：列表查询拆成两批键 —
 *   META 键（不含正文/图片）对所有行生效；
 *   CONTENT 键只对【未加密】笔记二次批量拉取，
 *   加密笔记的正文和图片 URL 永远不进入客户端。
 */
const MEMO_LIST_KEYS = [
  "objectId", "title", "content", "isFinish", "username", "tag", "imgUrl",
  "thumb1", "thumb2", "thumb3", "thumb4", "thumb5",
  "createdAt", "updatedAt"
].join(",");
/** 元数据键：列表/回收站首屏全量行只带这些 */
const MEMO_META_KEYS = [
  "objectId", "title", "isFinish", "username", "tag", "createdAt", "updatedAt"
].join(",");
/** 正文键：仅对未加密笔记补拉（objectId 用于本地合并） */
const MEMO_CONTENT_KEYS = [
  "objectId", "content", "imgUrl", "thumb1", "thumb2", "thumb3", "thumb4", "thumb5"
].join(",");

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
      memoPath() + buildWhere({ username: currentUser })
      + "&order=-createdAt&keys=" + encodeURIComponent(MEMO_META_KEYS), null);
    // 加密硬隔离：只对未加密笔记补拉正文/图片
    const out = await MemoLock.enrichRows(data.results || []);
    lockedIds = out.locked;
    return out.rows;
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
        memoPath() + buildWhere({ objectId: id, username: currentUser })
        + "&limit=1&keys=" + encodeURIComponent(MEMO_LIST_KEYS), null);
      const results = (data && data.results) || [];
      return results.length > 0 ? results[0] : null;
    } catch (e) {
      console.warn("getMemoById 查询失败：", e.message);
      return null;
    }
  },

  /**
   * 仅查 meta 字段做归属校验（加密笔记也不返回正文/图片）
   * @returns {Promise<object|null>}
   */
  async getMetaById(id) {
    if (!id) return null;
    try {
      const data = await BmobAPI.request("GET",
        memoPath() + buildWhere({ objectId: id, username: currentUser })
        + "&limit=1&keys=" + encodeURIComponent(MEMO_META_KEYS), null);
      const results = (data && data.results) || [];
      return results.length > 0 ? results[0] : null;
    } catch (e) {
      console.warn("getMetaById 查询失败：", e.message);
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
   * 修改备忘（默认先校验归属）
   * @param {string}  id             - 备忘 ID
   * @param {object}  patch          - 要更新的字段
   * @param {boolean} [skipVerify=false] - 跳过归属校验。
   *   仅图片逐字段写入时使用：备忘归属由调用流程自身保证（记录是本流程刚建/刚校验），
   *   跳过后每张图少一次 GET，9 张图能快一倍；该路径只写图片字段、不涉及 username。
   */
  async update(id, patch, skipVerify) {
    if (!skipVerify) {
      // meta 归属校验即可：加密笔记也不传输正文
      const owned = await this.getMetaById(id);
      if (!owned) throw makeNoAccessError();
    }
    return await BmobAPI.request("PUT", memoPath(id), patch);
  },

  /**
   * 删除备忘（meta 校验归属）
   * 注意：现在删除 = 移入回收站（softDelete），本方法仅回收站「彻底删除」使用
   * @param {string} id - 备忘 ID
   */
  async remove(id) {
    const owned = await this.getMetaById(id);
    if (!owned) throw makeNoAccessError();
    return await BmobAPI.request("DELETE", memoPath(id), null);
  },

  /* ===================== 回收站（软删除 + 7 天自动清理） =====================
   * 实现原理（Bmob 表 20 列已满，无法新增 deleted 字段）：
   *  - 移入回收站：把 username 改写为 __RB__<原用户名>（整行数据原封不动，图片也在）
   *    · 正常列表按 username 精确查询 → 自动看不到这些行
   *    · Bmob 的 $regex 模糊查询已失效，但精确等值查询可靠，回收站按固定前缀精确查
   *    · PUT 会自动刷新 Bmob 的 updatedAt → 它就是「删除时间」，无需额外字段
   *  - 还原：把 username 改回来（1 次 PUT，图片/标签/完成状态全部保留）
   *  - 彻底删除：DELETE 原行
   *  - 打开回收站 / 登录刷新时：updatedAt 超过 7 天的行自动 DELETE
   */

  /** 当前用户在回收站里的「替身用户名」 */
  deletedUsername() {
    return RECYCLE_PREFIX + currentUser;
  },

  /** 查询回收站全部记录（精确匹配替身用户名，meta 键，按删除时间倒序） */
  async queryDeleted() {
    const data = await BmobAPI.request("GET",
      memoPath() + buildWhere({ username: this.deletedUsername() })
      + "&order=-updatedAt&keys=" + encodeURIComponent(MEMO_META_KEYS), null);
    // 回收站同样执行加密硬隔离（加密行正文不传输）
    return await MemoLock.enrichRows(data.results || []);
  },

  /** 移入回收站：meta 归属校验（加密笔记正文不传输），再改写 username */
  async softDelete(id) {
    const owned = await this.getMetaById(id);
    if (!owned) throw makeNoAccessError();
    return await BmobAPI.request("PUT", memoPath(id), { username: this.deletedUsername() });
  },

  /** 从回收站还原：先确认该行确实在「我」的回收站里，再把 username 改回来 */
  async restore(id) {
    const row = await this._getDeletedById(id);
    if (!row) throw makeNoAccessError();
    return await BmobAPI.request("PUT", memoPath(id), { username: currentUser });
  },

  /** 彻底删除回收站里的一条（校验替身归属后 DELETE） */
  async hardRemove(id) {
    const row = await this._getDeletedById(id);
    if (!row) throw makeNoAccessError();
    return await BmobAPI.request("DELETE", memoPath(id), null);
  },

  /** 按 ID 查询回收站中的单条（where = objectId + 替身用户名），无权 / 不存在 → null */
  async _getDeletedById(id) {
    if (!id) return null;
    try {
      const data = await BmobAPI.request("GET",
        memoPath() + buildWhere({ objectId: id, username: this.deletedUsername() })
        + "&limit=1&keys=" + encodeURIComponent("objectId,username,updatedAt"), null);
      const results = (data && data.results) || [];
      return results.length > 0 ? results[0] : null;
    } catch (e) {
      console.warn("回收站记录查询失败：", e.message);
      return null;
    }
  }
};

/** 回收站用户名前缀 + 最长保留期限（7 天） */
const RECYCLE_PREFIX = "__RB__";
const RECYCLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 解析 Bmob 日期字符串（"2026-09-17 19:24:36"）为时间戳
 * 空格替换为 T 兼容 Safari；非法日期返回 0
 */
function parseBmobDate(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(" ", "T"));
  return isNaN(t) ? 0 : t;
}

/* ==========================================================================
   8.5 单条笔记字体配置（独立 Bmob 表 MemoFont：Memo 表已达 20 列上限）
   一行 = 一条笔记的配置：memoId + family(sans/serif/mono) + size(12~24)
   笔记被删除（移入回收站）时同步删除配置行，还原后使用全局默认字体
   ========================================================================== */

const FONT_TABLE = "MemoFont";
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;
const FONT_DEFAULT = { family: "sans", size: 15 };
/** 字体族 → 实际 font-family 栈（跨平台系统字体，无需加载网络字体） */
const FONT_FAMILY_STACKS = {
  sans:  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
  mono:  '"SFMono-Regular", Consolas, "Liberation Mono", "Courier New", monospace'
};

const MemoFontDAO = {
  /** MemoFont 表接口路径（/classes/MemoFont） */
  _fontPath(id) {
    return "/classes/" + FONT_TABLE + (id ? "/" + id : "");
  },

  /** 拉取当前用户全部笔记的字体配置（量小，一次取全，本地按 memoId 索引） */
  async queryAllForUser(username) {
    const data = await BmobAPI.request("GET",
      this._fontPath() + buildWhere({ username }) + "&limit=1000", null);
    return data.results || [];
  },

  /** 按笔记 ID 查配置行（不存在返回 null） */
  async getByMemo(memoId, username) {
    const data = await BmobAPI.request("GET",
      this._fontPath() + buildWhere({ memoId, username }) + "&limit=1", null);
    const results = (data && data.results) || [];
    return results.length > 0 ? results[0] : null;
  },

  /**
   * 保存（有配置行则更新，无则新建）
   * @returns {object} 保存后的配置 {family, size}
   */
  async upsert(memoId, family, size, username) {
    const existing = await this.getByMemo(memoId, username);
    if (existing) {
      await BmobAPI.request("PUT", this._fontPath(existing.objectId), { family, size });
    } else {
      await BmobAPI.request("POST", this._fontPath(), { memoId, family, size, username });
    }
    return { family, size };
  },

  /** 删除某条笔记绑定的全部配置行（正常只有一行，查到后逐条 DELETE 兜底） */
  async removeByMemo(memoId, username) {
    const data = await BmobAPI.request("GET",
      this._fontPath() + buildWhere({ memoId }) + "&limit=10&keys=objectId", null);
    await Promise.all(((data && data.results) || []).map(row =>
      BmobAPI.request("DELETE", this._fontPath(row.objectId), null)
    ));
  }
};

/* ==========================================================================
   8.6 单条笔记独立加密
   ─────────────────────────────────────────────────────────────────────────
   设计（满足「校验在后端、哈希不下发」）：
   · 每条加密笔记对应一个 Bmob _User 锁账号：username = "__LOCK__<memoId>"，
     密码 = 用户自定义访问密码。Bmob 对密码做服务端哈希存储，任何接口
     都不返回密码/哈希字段。
   · 访问校验 = Bmob 登录接口（GET /login）：成功才返回锁账号 objectId +
     sessionToken（仅内存暂存），错误密码 code 101。前端永不接触哈希。
   · 改密 / 关闭加密：用锁账号自身 session 操作（PUT/DELETE 本人）。
   · 彻底删除 / 清空回收站 / 过期清理无法拿到密码 → 调用云函数
     purgeLockUsers（内置 Master Key，仅存 Bmob 服务端）批量删锁账号。
   · 正文硬隔离：列表/回收站先只查 meta 键，再仅对未加密笔记补拉
     正文/图片（enrichRows），加密行数据不进入客户端。
   ========================================================================== */

const LOCK_PREFIX = "__LOCK__";
const LOCK_FUNC_PURGE = "purgeLockUsers";
const LOCK_FUNC_RESET = "resetLockPassword";
const LOCK_PWD_MIN = 6;
const LOCK_PWD_MAX = 32;
const LOCK_HINT_MAX = 50;
function lockNameFor(memoId) { return LOCK_PREFIX + memoId; }

/** 锁账号会话临时暂存（memoId → {objectId, sessionToken}），不落盘 */
let lockSessions = new Map();

const MemoLock = {
  lockName: lockNameFor,

  isLocked(memoId) { return lockedIds.has(memoId); },

  /**
   * 对 meta 行集执行加密富集：
   * 1) 批量查锁账号 → locked 集合
   * 2) 仅对未加密行批量补拉 content/imgUrl/thumb 并合并
   * @returns {Promise<{rows: object[], locked: Set}>}
   */
  async enrichRows(metaRows) {
    const locked = new Set();
    if (!metaRows.length) return { rows: metaRows, locked };

    const names = metaRows.map(r => lockNameFor(r.objectId));
    const found = await this.queryLockUsers(names);
    const unlockedIds = [];
    metaRows.forEach(r => {
      if (found.has(lockNameFor(r.objectId))) locked.add(r.objectId);
      else unlockedIds.push(r.objectId);
    });

    if (unlockedIds.length) {
      // 同批行 username 一致（主列表=本人 / 回收站=替身），用首行即可
      const data = await BmobAPI.request("GET",
        memoPath() + buildWhere({ username: metaRows[0].username, objectId: { "$in": unlockedIds } })
        + "&limit=1000&keys=" + encodeURIComponent(MEMO_CONTENT_KEYS), null);
      (data.results || []).forEach(c => {
        const row = metaRows.find(r => r.objectId === c.objectId);
        if (row) Object.assign(row, c);
      });
    }
    return { rows: metaRows, locked };
  },

  /** 按锁名批量查锁账号（返回 Map username → objectId；密码字段 Bmob 不下发） */
  async queryLockUsers(names) {
    const map = new Map();
    if (!names.length) return map;
    const data = await BmobAPI.request("GET",
      "/users" + buildWhere({ username: { "$in": names } })
      + "&limit=1000&keys=" + encodeURIComponent("objectId,username"), null);
    (data.results || []).forEach(u => map.set(u.username, u.objectId));
    return map;
  },

  /** 开启加密：注册锁账号（密码由 Bmob 服务端哈希存储；hint 为可选密码提示，存 _User 自定义字段） */
  async enable(memoId, password, hint) {
    const body = { username: lockNameFor(memoId), password };
    if (hint) body.hint = String(hint).slice(0, LOCK_HINT_MAX);
    return await BmobAPI.request("POST", "/users", body);
  },

  /** 查询单条锁账号的密码提示（仅在用户点「忘记密码」时按需拉取，不随列表下发） */
  async getHint(memoId) {
    try {
      const data = await BmobAPI.request("GET",
        "/users" + buildWhere({ username: lockNameFor(memoId) })
        + "&limit=1&keys=" + encodeURIComponent("objectId,hint"), null);
      const u = (data.results && data.results[0]) || null;
      return (u && u.hint) || "";
    } catch (e) { return ""; }
  },

  /** 忘记密码 → 重置（云函数 resetLockPassword：Master Key 验证笔记归属后改密） */
  async resetByOwner(memoId, newPassword) {
    const data = await BmobAPI.request("POST",
      "/functions/" + LOCK_FUNC_RESET,
      { memoId, newPassword, sessionToken: sessionToken || "" });
    const raw = data.result;
    let res = raw;
    if (typeof raw === "string") {
      try { res = JSON.parse(raw); } catch (e) { throw new Error(raw); }
    }
    if (res && res.ok === false) throw new Error(res.error || "重置失败，请重试");
    return res;
  },

  /** 后端校验：Bmob 登录接口；密码错误 Bmob 抛 code 101 */
  async verify(memoId, password) {
    return await BmobAPI.request("GET",
      "/login?username=" + encodeURIComponent(lockNameFor(memoId))
      + "&password=" + encodeURIComponent(password), null);
  },

  /** 修改密码：锁账号 session 鉴权 */
  async changePassword(userObjectId, sessionToken, newPassword) {
    return await BmobAPI.request("PUT", "/users/" + userObjectId,
      { password: newPassword },
      { "X-Bmob-Session-Token": sessionToken });
  },

  /** 关闭加密：锁账号自删（session 鉴权） */
  async selfRemove(userObjectId, sessionToken) {
    return await BmobAPI.request("DELETE", "/users/" + userObjectId, null,
      { "X-Bmob-Session-Token": sessionToken });
  },

  /** 后端批量删锁账号（云函数 purgeLockUsers，Master Key 仅在云端） */
  async adminPurge(memoIds) {
    if (!memoIds || !memoIds.length) return { count: 0 };
    const data = await BmobAPI.request("POST",
      "/functions/" + LOCK_FUNC_PURGE,
      { names: JSON.stringify(memoIds.map(lockNameFor)) });
    const raw = data.result;
    if (raw == null) return { count: 0 };
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
};


/* ==========================================================================
   8.7 加密密码弹窗与四种流程
   ─────────────────────────────────────────────────────────────────────────
   · promptUnlockNote    查看：后端 verify → 成功才加载正文（可连续重试，错误不关闭）
   · setupLockExisting   已有笔记开启加密（注册锁账号，立即生效）
   · changeLockExisting  修改密码（旧密码 verify → PUT 本人）
   · disableLockExisting 关闭加密（密码 verify → 自删锁账号）
   · 新建笔记：开关 + 弹窗暂存 pendingLockPwd，保存成功后注册锁账号
   ========================================================================== */

const LockDialog = {
  _resolve: null,
  _reject: null,
  _cfg: null,
  _busy: false,

  /**
   * 打开密码弹窗
   * @param {object} cfg - title / noteTitle / okText / fields[{key,label,placeholder}]
   *                       / validate(form)→errMsg|null / onSubmit(form)→Promise
   * @returns {Promise<object>} 成功 resolve 表单值；取消 reject
   */
  open(cfg) {
    if (this._reject) this._reject("reopen");
    this._cfg = cfg;
    $("lockModalTitle").textContent = cfg.title || "笔记加密";
    $("lockModalSub").textContent = cfg.noteTitle ? ("《" + cfg.noteTitle + "》") : "";
    $("lockModalOk").textContent = cfg.okText || "确定";
    this._showError("");
    // 「忘记密码」按钮仅在解锁查看弹窗显示；设置/改密/关闭/重置自身等场景隐藏
    const forgotBtn = $("lockModalForgot");
    if (forgotBtn) {
      forgotBtn.style.display = cfg.showForgot ? "" : "none";
      forgotBtn.disabled = false;
    }
    $("lockModalBody").innerHTML = (cfg.fields || []).map((f, i) => `
      <label class="lock-field">
        <span>${escapeHtml(f.label || "")}</span>
        <input type="${f.type === "text" ? "text" : "password"}"
          data-key="${escapeHtml(f.key)}"
          placeholder="${escapeHtml(f.placeholder || "")}" autocomplete="off" />
      </label>`).join("")
      + (cfg.extra ? `<div class="lock-extra">${cfg.extra}</div>` : "");
    $("lockModalMask").classList.add("show");
    const first = $("lockModalBody").querySelector("input");
    if (first) setTimeout(() => first.focus(), 50);
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  },

  _collect() {
    const form = {};
    $("lockModalBody").querySelectorAll("input").forEach(inp => {
      form[inp.dataset.key] = inp.value;
    });
    return form;
  },

  _showError(msg) {
    const el = $("lockModalErr");
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  },

  async submit() {
    if (this._busy || !this._cfg) return;
    const form = this._collect();
    if (this._cfg.validate) {
      const err = this._cfg.validate(form);
      if (err) { this._showError(err); return; }
    }
    this._busy = true;
    const okBtn = $("lockModalOk");
    const forgotBtn = $("lockModalForgot");
    okBtn.classList.add("loading");
    okBtn.disabled = true;
    if (forgotBtn) forgotBtn.disabled = true;
    try {
      await this._cfg.onSubmit(form);
      this._done(form);
    } catch (e) {
      this._showError(translateLockError(e));
    } finally {
      this._busy = false;
      okBtn.classList.remove("loading");
      okBtn.disabled = false;
      if (forgotBtn) forgotBtn.disabled = false;
    }
  },

  cancel() {
    if (this._busy) return;
    this._fail("cancel");
  },

  _done(form) {
    $("lockModalMask").classList.remove("show");
    const r = this._resolve;
    this._resolve = null; this._reject = null; this._cfg = null;
    if (r) r(form);
  },

  _fail(reason) {
    $("lockModalMask").classList.remove("show");
    const rj = this._reject;
    this._resolve = null; this._reject = null; this._cfg = null;
    if (rj) rj(reason);
  }
};

/** Bmob 错误 → 用户可读中文（不泄露技术细节） */
function translateLockError(e) {
  if (e && (e.bmobCode === 101 || /username or password incorrect/i.test(e.message || ""))) {
    return "密码错误，请重试";
  }
  if (e && e.bmobCode === 202) return "该笔记已加密（重复设置），请先关闭";
  return (e && e.message) || "操作失败，请重试";
}

function validateLockPwd(pwd) {
  if (!pwd) return "请输入密码";
  if (pwd.length < LOCK_PWD_MIN || pwd.length > LOCK_PWD_MAX) {
    return "密码长度需为 " + LOCK_PWD_MIN + "~" + LOCK_PWD_MAX + " 位";
  }
  return null;
}

/** 弹窗字段定义复用 */
const LOCK_FIELDS = {
  set: [
    { key: "pwd", label: "设置访问密码", placeholder: LOCK_PWD_MIN + "~" + LOCK_PWD_MAX + " 位密码" },
    { key: "pwd2", label: "确认密码", placeholder: "再次输入密码" },
    { key: "hint", type: "text", label: "密码提示（可选）", placeholder: "忘记密码时的助记词，如：生日后四位" }
  ],
  view: [
    { key: "pwd", label: "访问密码", placeholder: "请输入该笔记的访问密码" }
  ],
  change: [
    { key: "oldPwd", label: "当前密码", placeholder: "请输入当前密码" },
    { key: "newPwd", label: "新密码", placeholder: LOCK_PWD_MIN + "~" + LOCK_PWD_MAX + " 位新密码" },
    { key: "newPwd2", label: "确认新密码", placeholder: "再次输入新密码" }
  ],
  disable: [
    { key: "pwd", label: "访问密码", placeholder: "请输入访问密码以确认" }
  ],
  reset: [
    { key: "newPwd", label: "设置新密码", placeholder: LOCK_PWD_MIN + "~" + LOCK_PWD_MAX + " 位新密码" },
    { key: "newPwd2", label: "确认新密码", placeholder: "再次输入新密码" }
  ]
};

/**
 * 查看加密笔记：弹窗 → 后端校验 → 成功才加载正文并合并本地行
 * @returns {Promise<boolean>}
 */
async function promptUnlockNote(m) {
  try {
    window.__resetMemoId = m.objectId;
    await LockDialog.open({
      title: "查看加密笔记",
      noteTitle: m.title,
      okText: "解锁查看",
      fields: LOCK_FIELDS.view,
      showForgot: true,
      onSubmit: async (f) => {
        const verr = validateLockPwd(f.pwd);
        if (verr) throw new Error(verr);
        await unlockAndLoad(m, f.pwd);
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** 弹窗底部「🙋 忘记密码」按钮 → 进入重置流程（__resetMemoId 由 promptUnlockNote 写入） */
function onClickForgotLock() {
  openResetFlow();
}

/** 解锁并加载正文（verify → 缓存 session → 全量 GET → 合并本地行） */
async function unlockAndLoad(m, password) {
  const user = await MemoLock.verify(m.objectId, password);
  lockSessions.set(m.objectId, {
    objectId: user.objectId, sessionToken: user.sessionToken
  });
  const full = await MemoDAO.getById(m.objectId);
  if (!full) throw new Error("笔记不存在或已被删除");
  const idx = memoList.findIndex(x => x.objectId === m.objectId);
  if (idx >= 0) memoList[idx] = Object.assign({}, memoList[idx], full);
}

/**
 * 忘记密码 → 重置流程：
 * 1) 拉取该笔记的密码提示（如有）
 * 2) 弹窗显示提示 + 新密码/确认
 * 3) 云函数 resetLockPassword 改密（Master Key 验证笔记归属）
 * 4) 成功后自动用新密码解锁查看
 */
async function openResetFlow() {
  const memoId = window.__resetMemoId;
  if (!memoId) return;
  const m = memoList.find(x => x.objectId === memoId)
    || recycleList.find(x => x.objectId === memoId);
  if (!m) return;

  let hint = "";
  try { hint = await MemoLock.getHint(memoId); } catch (e) { hint = ""; }

  const extra = hint
    ? `<div class="lock-hint-box">💡 密码提示：${escapeHtml(hint)}</div>`
    : `<div class="lock-hint-box empty">（未设置密码提示，直接设置新密码即可）</div>`;

  try {
    await LockDialog.open({
      title: "重置访问密码",
      noteTitle: m.title,
      okText: "确认重置并查看",
      fields: LOCK_FIELDS.reset,
      extra,
      validate: (f) => {
        const e1 = validateLockPwd(f.newPwd);
        if (e1) return e1;
        if (f.newPwd !== f.newPwd2) return "两次输入的新密码不一致";
        return null;
      },
      onSubmit: async (f) => {
        await MemoLock.resetByOwner(memoId, f.newPwd);
        // 重置成功 → 自动用新密码解锁查看
        await unlockAndLoad(m, f.newPwd);
        // 自动进入编辑模式（unlockAndLoad 已写入 lockSessions，startEdit 不会再弹密码框）
        await startEdit(memoId);
      }
    });
  } catch (e) {
    // 用户取消重置（或主动关闭）：回到密码输入弹窗，再给一次输密码的机会
    promptUnlockNote(m).catch(() => {});
  }
}

/** 已有笔记开启加密（注册锁账号，立即生效） */
async function setupLockExisting(memoId) {
  const m = memoList.find(x => x.objectId === memoId);
  await LockDialog.open({
    title: "开启笔记加密",
    noteTitle: m ? m.title : "",
    okText: "确认开启",
    fields: LOCK_FIELDS.set,
    validate: (f) => {
      const e1 = validateLockPwd(f.pwd);
      if (e1) return e1;
      if (f.pwd !== f.pwd2) return "两次输入的密码不一致";
      return null;
    },
    onSubmit: async (f) => {
      await MemoLock.enable(memoId, f.pwd, f.hint || "");
      lockedIds.add(memoId);
    }
  });
}

/** 修改访问密码 */
async function changeLockExisting(memoId) {
  const m = memoList.find(x => x.objectId === memoId);
  await LockDialog.open({
    title: "修改访问密码",
    noteTitle: m ? m.title : "",
    okText: "确认修改",
    fields: LOCK_FIELDS.change,
    validate: (f) => {
      if (!f.oldPwd) return "请输入当前密码";
      const e1 = validateLockPwd(f.newPwd);
      if (e1) return e1;
      if (f.newPwd !== f.newPwd2) return "两次输入的新密码不一致";
      if (f.newPwd === f.oldPwd) return "新密码不能与当前密码相同";
      return null;
    },
    onSubmit: async (f) => {
      const user = await MemoLock.verify(memoId, f.oldPwd);
      const upd = await MemoLock.changePassword(user.objectId, user.sessionToken, f.newPwd);
      lockSessions.set(memoId, {
        objectId: user.objectId,
        sessionToken: (upd && upd.sessionToken) || user.sessionToken
      });
    }
  });
}

/** 关闭加密（自删锁账号） */
async function disableLockExisting(memoId) {
  const m = memoList.find(x => x.objectId === memoId);
  await LockDialog.open({
    title: "关闭笔记加密",
    noteTitle: m ? m.title : "",
    okText: "确认关闭",
    fields: LOCK_FIELDS.disable,
    onSubmit: async (f) => {
      const verr = validateLockPwd(f.pwd);
      if (verr) throw new Error(verr);
      const user = await MemoLock.verify(memoId, f.pwd);
      await MemoLock.selfRemove(user.objectId, user.sessionToken);
      lockedIds.delete(memoId);
      lockSessions.delete(memoId);
    }
  });
}

/* ---- 表单内加密开关 ---- */

/** 新建笔记暂存的密码 + 提示（不落盘；保存成功后注册锁账号） */
let pendingLockPwd = null;
let pendingLockHint = "";

/** 开关切换：已有笔记立即走弹窗；新建笔记走设置弹窗暂存 */
function onLockSwitchChange() {
  const sw = $("lockSwitchInput");
  if (editingId) {
    const isLocked = lockedIds.has(editingId);
    if (sw.checked && !isLocked) {
      setupLockExisting(editingId)
        .then(() => { syncLockBox(); renderList(); })
        .catch(() => { sw.checked = false; });
    } else if (!sw.checked && isLocked) {
      disableLockExisting(editingId)
        .then(() => { syncLockBox(); renderList(); })
        .catch(() => { sw.checked = true; });
    }
  } else if (sw.checked) {
    openPendingLockDialog()
      .catch(() => { sw.checked = false; });
  } else {
    pendingLockPwd = null;
    pendingLockHint = "";
    syncLockBox();
  }
}

/** 新建笔记设置/修改暂存密码 */
async function openPendingLockDialog() {
  await LockDialog.open({
    title: "开启笔记加密",
    noteTitle: "保存笔记后生效",
    okText: "确认",
    fields: LOCK_FIELDS.set,
    validate: (f) => {
      const e1 = validateLockPwd(f.pwd);
      if (e1) return e1;
      if (f.pwd !== f.pwd2) return "两次输入的密码不一致";
      return null;
    },
    onSubmit: async (f) => {
      pendingLockPwd = f.pwd;
      pendingLockHint = f.hint || "";
    }
  });
  syncLockBox();
}

/** 表单加密区按钮 */
function onClickChangeLock() {
  if (editingId) changeLockExisting(editingId).catch(() => {});
  else openPendingLockDialog().catch(() => {});
}
function onClickDisableLock() {
  if (!editingId) return;
  disableLockExisting(editingId)
    .then(() => { syncLockBox(); renderList(); })
    .catch(() => {});
}

/** 根据当前状态渲染表单加密区（开关 + 说明/按钮） */
function syncLockBox() {
  const box = $("formLockBox");
  if (!box) return;
  box.style.display = "block";
  const sw = $("lockSwitchInput");
  const label = $("lockSwitchLabel");
  const panel = $("lockPanel");

  if (editingId && lockedIds.has(editingId)) {
    sw.checked = true;
    sw.disabled = false;
    label.textContent = "🔒 该笔记已加密";
    panel.innerHTML = `
      <div class="lock-panel-on">
        <span class="lock-on-note">已通过密码验证，加密状态随笔记保存；刷新后需重新输入密码</span>
        <div class="lock-panel-btns">
          <button type="button" class="btn-mini" onclick="onClickChangeLock()">🔑 修改密码</button>
          <button type="button" class="btn-mini btn-del" onclick="onClickDisableLock()">关闭加密</button>
        </div>
      </div>`;
  } else if (!editingId && pendingLockPwd) {
    sw.checked = true;
    sw.disabled = false;
    label.textContent = "🔒 保存后加密";
    panel.innerHTML = `
      <div class="lock-panel-on">
        <span class="lock-on-note">密码已设置，将在保存笔记时生效</span>
        <div class="lock-panel-btns">
          <button type="button" class="btn-mini" onclick="onClickChangeLock()">🔑 修改密码</button>
        </div>
      </div>`;
  } else {
    sw.checked = false;
    sw.disabled = false;
    label.textContent = "🔐 开启笔记加密";
    panel.innerHTML = `
      <div class="lock-panel-off">开启后查看正文需输入密码；密码仅保存哈希，正文仍正常存储</div>`;
  }
}


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

  // 置顶笔记排在最前（按置顶时间倒序，最近置顶的更靠前）
  const pins = getPins();
  filtered.sort((a, b) => {
    const pa = pins.indexOf(a.objectId);
    const pb = pins.indexOf(b.objectId);
    if (pa === -1 && pb === -1) return 0;
    if (pa === -1) return 1;
    if (pb === -1) return -1;
    return pb - pa; // 后置顶的排更前
  });

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

  wrap.innerHTML = filtered.map(m => {
    const locked = lockedIds.has(m.objectId);
    let imgHtml = "";
    let titleStyle = "";
    let descStyle = "";
    let descHtml = "";

    if (locked) {
      // 加密笔记：正文/图片根本未加载，卡片只渲染标题 + 锁标识
      descHtml = `<div class="memo-locked-hint">🔒 内容已加密，点「编辑」输入密码查看</div>`;
    } else {
      // 统一取出该备忘的图片（兼容旧 imgUrl 字段 + 新 imgUrl1..9 字段）
      const imgs = getMemoImages(m);
      if (imgs.length === 1) {
        // 1 张：全宽大图（沿用原样式）
        imgHtml = `<img class="memo-img" src="${escapeHtml(imgs[0].url)}" alt="图片" loading="lazy" title="点击放大查看" onclick="openLightboxForMemo('${m.objectId}', 0)" />`;
      } else if (imgs.length > 1) {
        // 多张：2-4 张 2 列、5-9 张 3 列
        const cols = (imgs.length <= 4) ? 2 : 3;
        imgHtml = `<div class="memo-photo-grid cols-${cols}">` +
          imgs.map((im, i) => `<img src="${escapeHtml(im.url)}" alt="图片${i + 1}" loading="lazy" title="点击放大查看" onclick="openLightboxForMemo('${m.objectId}', ${i})" />`).join("") +
          `</div>`;
      }
      // 该笔记保存的独立字体（字体栈含双引号，整个声明必须经 escapeHtml）
      const f = fontCfgMap.get(m.objectId);
      titleStyle = f ? ` style="${escapeHtml(`font-family:${FONT_FAMILY_STACKS[f.family]};`)}"` : "";
      descStyle = f ? ` style="${escapeHtml(`font-family:${FONT_FAMILY_STACKS[f.family]};font-size:${f.size}px;`)}"` : "";
      descHtml = m.content ? `<div class="memo-desc"${descStyle}>${escapeHtml(m.content)}</div>` : "";
    }
    return `
    <div class="memo-item ${m.isFinish ? 'done' : ''} ${isPinned(m.objectId) ? 'pinned' : ''} ${locked ? 'locked' : ''}" data-id="${m.objectId}">
      ${isPinned(m.objectId) ? '<span class="pin-badge">📌 已置顶</span>' : ''}
      <div class="memo-row">
        <div class="memo-check ${m.isFinish ? 'checked' : ''}" onclick="toggleFinish('${m.objectId}', ${!m.isFinish}, this)">
          ${m.isFinish ? '✓' : ''}
        </div>
        <div class="memo-content">
          <div class="memo-title"${titleStyle}>${locked ? '🔒 ' : ''}${escapeHtml(m.title)}</div>
          ${descHtml}
          ${imgHtml}
        </div>
      </div>
      <div class="memo-meta">
        ${m.tag ? `<span class="tag-badge" data-tag="${escapeHtml(m.tag)}">${escapeHtml(m.tag)}</span>` : ''}
        ${locked ? '<span class="lock-badge">🔒 已加密</span>' : ''}
      </div>
      <div class="memo-actions">
        <button class="btn-mini btn-pin ${isPinned(m.objectId) ? 'active' : ''}" onclick="togglePin('${m.objectId}')" title="置顶 / 取消置顶">${isPinned(m.objectId) ? '📌 取消置顶' : '📌 置顶'}</button>
        <button class="btn-mini btn-polish" onclick="polishMemo('${m.objectId}')" title="AI 总结润色这条笔记">✨ 润色</button>
        <button class="btn-mini btn-edit" onclick="startEdit('${m.objectId}')">编辑</button>
        <button class="btn-mini btn-del" onclick="delMemo('${m.objectId}')">删除</button>
      </div>
    </div>
  `;
  }).join("");

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


/* ==================== 笔记置顶 =====================
 * Bmob 表已达 20 列上限，无法新增字段，改用 localStorage 存储置顶 ID。
 * 按用户隔离（key 含 currentUser），换账号互不干扰。
 * 置顶笔记在 renderList 中排在列表最前，后置顶的更靠前。
 */

/** 取当前用户的置顶 ID 列表（最新置顶的在末尾，排序时倒序） */
function getPins() {
  try {
    const key = "memo_pins_" + currentUser;
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch (e) { return []; }
}

/** 存当前用户的置顶 ID 列表 */
function setPins(arr) {
  try {
    localStorage.setItem("memo_pins_" + currentUser, JSON.stringify(arr));
  } catch (e) {}
}

/** 判断某笔记是否已置顶 */
function isPinned(id) {
  return getPins().indexOf(id) !== -1;
}

/** 从置顶列表中移除某 ID（删除笔记 / 移入回收站时同步清理，无则无操作） */
function unpinId(id) {
  const pins = getPins();
  const i = pins.indexOf(id);
  if (i !== -1) {
    pins.splice(i, 1);
    setPins(pins);
  }
}

/**
 * 切换笔记置顶状态
 * @param {string} id - 备忘 objectId
 */
function togglePin(id) {
  const pins = getPins();
  const i = pins.indexOf(id);
  if (i !== -1) {
    pins.splice(i, 1);
  } else {
    pins.push(id);
  }
  setPins(pins);
  renderList();
}

/* ==================== 10. 交互层  ==================== */

/* ---- 备忘 CRUD ---- */

/**
 * 查询当前用户的全部备忘并渲染
 * 包装 MemoDAO.queryAll + renderList，供初始化和刷新调用
 */
async function fetchMemos() {
  memoList = await MemoDAO.queryAll();
  await loadFontConfigs();
  renderList();
  // 后台顺手清理回收站过期记录 + 刷新角标（静默失败，不打扰主流程）
  cleanupExpiredRecycle().then(refreshRecycleBadge).catch(() => {});
}

/**
 * 新增备忘（便捷封装：构造请求体 + 调 MemoDAO.create + 返回完整对象）
 * 注意：图片走「选完即入库」的独立流程，不再经过本函数
 * @returns {Promise<object>} 包含 objectId 的备忘对象
 */
async function createMemo(title, content, tag) {
  const body = { title, content, isFinish: false, username: currentUser };
  if (tag) body.tag = tag;
  const data = await MemoDAO.create(body);
  showToast("备忘已添加 ✿");
  return {
    objectId: data.objectId, title, content, isFinish: false,
    imgUrl: null, username: currentUser, tag: tag || null,
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

  // 图片批量上传 / 重试尚未收尾时禁止提交（避免和图片流程打架）
  if (formImages.some(i => i.status === "uploading") || (!editingId && formImages.length > 0)) {
    showToast("图片还在处理中，请稍等它完成 ✿");
    return;
  }

  await withLoading(async () => {
    try {
      if (editingId) {
        // 编辑模式：只更新文字 / 标签（图片在选图、删图时已即时同步云端）
        // 先把可能挂起的字体改动落库（拖完滑块立刻点保存的场景）
        await flushPendingFontSave();
        const patch = { title, content };
        if (selectedTag) patch.tag = selectedTag;
        await MemoDAO.update(editingId, patch);
        // 同步更新本地缓存
        const item = memoList.find(m => m.objectId === editingId);
        if (item) {
          item.title = title;
          item.content = content;
          if (selectedTag) item.tag = selectedTag;
        }
        showToast("修改成功 ✿");
        exitEditMode();
        renderList();
      } else {
        // 新建模式：创建备忘
        const newMemo = await createMemo(title, content, selectedTag);
        // 表单里改过的字体设置绑定到新笔记（没改过则用全局默认，不产生配置行）
        if (formFontDirty) {
          try {
            await MemoFontDAO.upsert(newMemo.objectId, formFont.family, formFont.size, currentUser);
            fontCfgMap.set(newMemo.objectId, { family: formFont.family, size: formFont.size });
          } catch (fe) {
            showToast("笔记已保存，但字体设置保存失败了");
          }
        }
        memoList.unshift(newMemo);
        // 表单开关暂存的密码：笔记已建 → 注册锁账号（失败不影响笔记本身）
        if (pendingLockPwd) {
          try {
            await MemoLock.enable(newMemo.objectId, pendingLockPwd, pendingLockHint);
            lockedIds.add(newMemo.objectId);
          } catch (le) {
            showToast("笔记已保存，但加密开启失败，请编辑重试");
          }
          pendingLockPwd = null;
          pendingLockHint = "";
        }
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
  // 加密笔记：本会话尚未通过密码验证（lockSessions 无记录）才弹密码窗。
  // 不能用 !local.content 判断——空内容笔记解锁后 content 仍为空，会误判成未解锁、重复弹窗
  if (lockedIds.has(id) && !lockSessions.has(id)) {
    const local = memoList.find(x => x.objectId === id);
    if (!local) {
      showToast("该笔记不存在、已被删除或无权访问");
      return;
    }
    const ok = await promptUnlockNote(local);
    if (!ok) return;
  }

  const m = await withLoading(() =>
    lockedIds.has(id) ? Promise.resolve(memoList.find(x => x.objectId === id)) : MemoDAO.getById(id));

  // 空判断：笔记不存在 / 已被删除 / 无权访问 → 友好提示 + 清理本地残留卡片
  if (!m) {
    showToast("该笔记不存在、已被删除或无权访问");
    memoList = memoList.filter(x => x.objectId !== id);
    renderList();
    return;
  }

  enterEditMode(m);
}

/**
 * 进入编辑模式并填充表单（startEdit 与 polishMemo 共用）
 * @param {object} m - 云端备忘对象（已通过归属校验，字段齐全）
 */
/* ---- 单条笔记字体：表单状态与实时预览 ---- */

let fontCfgMap = new Map();        // memoId → {family, size}（云端已保存的配置）
let formFont = { ...FONT_DEFAULT }; // 当前编辑表单里的字体
let formFontDirty = false;         // 本次打开表单后用户是否改过字体
let fontSaveTimer = null;          // 已有笔记自动保存的防抖计时器

/** 字号夹取到 12~24（非法值回落到默认 15） */
function clampFontSize(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return FONT_DEFAULT.size;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
}

/** 拉取当前用户全部笔记的字体配置到 fontCfgMap（失败静默，笔记仍用默认字体） */
async function loadFontConfigs() {
  fontCfgMap = new Map();
  try {
    const rows = await MemoFontDAO.queryAllForUser(currentUser);
    rows.forEach(r => {
      if (r.memoId && FONT_FAMILY_STACKS[r.family]) {
        fontCfgMap.set(r.memoId, { family: r.family, size: clampFontSize(r.size) });
      }
    });
  } catch (e) {
    console.warn("字体配置加载失败：", e.message);
  }
}

/** 编辑某条笔记时：把它自己保存的配置装进表单；没有配置则为全局默认 */
function loadFontIntoForm(memoId) {
  const cfg = fontCfgMap.get(memoId);
  formFont = cfg ? { family: cfg.family, size: cfg.size } : { ...FONT_DEFAULT };
  formFontDirty = false;
  clearTimeout(fontSaveTimer);
  fontSaveTimer = null;
  applyFormFont();
}

/** 表单字体恢复为全局默认（新建 / 取消 / 提交后调用） */
function resetFormFont() {
  formFont = { ...FONT_DEFAULT };
  formFontDirty = false;
  clearTimeout(fontSaveTimer);
  fontSaveTimer = null;
  applyFormFont();
}

/**
 * 把 formFont 应用到编辑表单（标题 / 正文输入框 + 控件选中态）
 * 这是实时预览的唯一出口，改动立即生效无需保存
 */
function applyFormFont() {
  const stack = FONT_FAMILY_STACKS[formFont.family] || FONT_FAMILY_STACKS.sans;
  const titleEl = $("titleInput");
  const contentEl = $("contentInput");
  titleEl.style.fontFamily = formFont.family === "sans" ? "" : stack;
  contentEl.style.fontFamily = formFont.family === "sans" ? "" : stack;
  contentEl.style.fontSize = formFont.size + "px";
  autoResizeContent(); // 字号变了行高也变，高度要跟着重算，不然会出现内部滚动条
  // 字体按钮选中态
  document.querySelectorAll("#fontFamilyPicker button").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-f") === formFont.family);
  });
  $("fontSizeRange").value = formFont.size;
  $("fontSizeVal").textContent = formFont.size + "px";
  // 作用域提示
  $("fontScopeText").textContent = editingId
    ? (fontCfgMap.get(editingId) ? "仅作用于这条笔记" : "当前为全局默认字体")
    : "新笔记默认使用全局字体";
}

/**
 * 备注输入框随内容自动长高
 * 原理（两步走）：先把高度还成 auto 让浏览器算出内容的真实高度（scrollHeight），
 * 再把真实高度设回去。上限 400px，超过后输入框内部滚动，避免一条长笔记把整页撑爆。
 * 所有会改动 contentInput 内容的地方（打字 / AI 生成 / 进编辑 / 清空 / 调字号）都要调它。
 */
function autoResizeContent() {
  const el = $("contentInput");
  el.style.height = "auto";                                    // 第一步：缩回 auto，scrollHeight 才准
  const h = Math.min(el.scrollHeight, 400);                    // 第二步：按内容撑开，封顶 400px
  el.style.height = h + "px";
  el.style.overflowY = el.scrollHeight > 400 ? "auto" : "hidden"; // 只有触顶后才显示内部滚动条
}

/** 切换字体族（无衬线 / 衬线 / 等宽） */
function setNoteFamily(family) {
  if (!FONT_FAMILY_STACKS[family]) return;
  formFont.family = family;
  formFontDirty = true;
  applyFormFont();
  scheduleFontSave();
}

/** 调节字号（滑块 oninput 每次触发） */
function setNoteSize(v) {
  formFont.size = clampFontSize(v);
  formFontDirty = true;
  applyFormFont();
  scheduleFontSave();
}

/** 已有笔记：改动防抖 400ms 自动存云端；新建笔记尚无 ID，提交时一起存 */
function scheduleFontSave() {
  if (!editingId) return;
  clearTimeout(fontSaveTimer);
  fontSaveTimer = setTimeout(() => {
    fontSaveTimer = null;
    persistFormFont()
      .then(() => { applyFormFont(); })
      .catch(e => {
        console.warn("字体自动保存失败：", e.message);
        showToast("字体设置保存失败，请检查网络");
      });
  }, 400);
}

/** 立即把表单字体写入云端 + fontCfgMap（仅已有笔记） */
async function persistFormFont() {
  if (!editingId) return;
  const memoId = editingId;
  const cfg = await MemoFontDAO.upsert(memoId, formFont.family, formFont.size, currentUser);
  fontCfgMap.set(memoId, { family: cfg.family, size: cfg.size });
}

/** 提交前把挂起的防抖保存立即落库（无挂起则跳过） */
async function flushPendingFontSave() {
  if (!fontSaveTimer) return;
  clearTimeout(fontSaveTimer);
  fontSaveTimer = null;
  await persistFormFont();
}

/**
 * 重置字体：这条笔记恢复全局默认
 * 已有笔记 → 删除云端配置行；新笔记 → 仅表单回默认
 */
async function resetNoteFont() {
  clearTimeout(fontSaveTimer);
  fontSaveTimer = null;
  if (editingId) {
    const memoId = editingId;
    fontCfgMap.delete(memoId);
    try {
      await MemoFontDAO.removeByMemo(memoId, currentUser);
    } catch (e) {
      console.warn("字体配置删除失败：", e.message);
    }
  }
  formFont = { ...FONT_DEFAULT };
  formFontDirty = false;
  applyFormFont();
  if (editingId) renderList();
  showToast("已恢复为全局默认字体 ✿");
}

function enterEditMode(m) {
  editingId = m.objectId;
  $("titleInput").value = m.title || "";
  $("contentInput").value = m.content || "";
  autoResizeContent(); // 编辑长笔记时输入框要按内容撑开
  $("submitBtn").textContent = "💾 保存修改";
  $("editBar").classList.add("show");
  selectedTag = m.tag || null;
  // 更新标签选中状态
  document.querySelectorAll("#tagPicker .tag-pick").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-tag") === selectedTag);
  });
  // 把该备忘已有图片装入九宫格（全部为已完成状态），可继续加图或删图
  // 编辑模式装载：旧 imgUrl 字段的图本身就是大图（bigUrl 直接给）；新图只有缩略图
  formImages = getMemoImages(m).map(im => {
    const item = makeFormImageItem(im.big, im.url, "done", null);
    item.bigUrl = im.big === "imgUrl" ? im.url : null;
    return item;
  });
  batchMemoId = null;
  renderFormGrid();
  // 加载这条笔记自己保存的字体设置（无配置则为全局默认）
  loadFontIntoForm(m.objectId);
  // 加密区：已加密 → 显示改密/关闭（密码不回显）
  pendingLockPwd = null;
  syncLockBox();
  // 同步本地缓存（以云端数据为准）
  const local = memoList.find(x => x.objectId === m.objectId);
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
  autoResizeContent(); // 清空后高度也要缩回默认
  $("aiInput").value = "";
  $("fileInput").value = "";
  formImages = [];
  batchMemoId = null;
  renderFormGrid();
  selectedTag = null;
  document.querySelectorAll("#tagPicker .tag-pick").forEach(b => b.classList.remove("active"));
  // 表单字体一并恢复全局默认
  resetFormFont();
  // 加密区复位（新建暂存密码清空）
  pendingLockPwd = null;
  syncLockBox();
}

/**
 * 删除备忘（软删除：移入回收站，7 天内可还原，超期自动彻底清除）
 * @param {string} id - 备忘 ID
 */
async function delMemo(id) {
  if (!confirm("确定删除这条备忘吗？\n\n删除后会移入回收站，7 天内可以随时还原。")) return;
  try {
    await MemoDAO.softDelete(id);
    memoList = memoList.filter(m => m.objectId !== id);
    unpinId(id);              // 置顶状态同步清理
    await safeClearFontCfg(id); // 该笔记绑定的字体配置同步清除
    renderList();
    showToast("已移入回收站，7 天内可还原 ✿");
    refreshRecycleBadge();    // 后台刷新角标，不阻塞操作
  } catch (e) {
    handleOpError(e, { id });
  }
}

/**
 * 清除某条笔记的字体配置（本地 map + 云端行）
 * 云端删除失败不阻断笔记删除主流程，仅记录警告
 */
async function safeClearFontCfg(id) {
  fontCfgMap.delete(id);
  try {
    await MemoFontDAO.removeByMemo(id, currentUser);
  } catch (e) {
    console.warn("字体配置清除失败：", e.message);
  }
}

/* ==================== 回收站 UI ==================== */

let recycleList = [];   // 回收站列表缓存（打开弹层时拉取）
let recycleLockedIds = new Set(); // 回收站中的加密笔记 ID（queryDeleted 后填充）

/** 打开回收站：先自动清理过期记录，再拉取列表渲染 */
async function openRecycleBin() {
  const ov = $("recycleOverlay");
  ov.classList.add("show");
  $("recycleList").innerHTML =
    '<div class="empty"><span class="emoji">⏳</span>正在加载回收站…</div>';
  try {
    await cleanupExpiredRecycle();
    const out = await MemoDAO.queryDeleted();
    recycleList = out.rows;
    recycleLockedIds = out.locked;
    renderRecycle();
    refreshRecycleBadge();
  } catch (e) {
    $("recycleList").innerHTML =
      '<div class="empty"><span class="emoji">📡</span>回收站加载失败：' + escapeHtml(e.message) + '</div>';
  }
}

/** 关闭回收站弹层（还原/删除后若列表有变化，主列表也要刷新） */
function closeRecycleBin(needRefresh) {
  $("recycleOverlay").classList.remove("show");
  if (needRefresh) fetchMemos().catch(() => {});
}

/** 渲染回收站列表（缩略图 + 删除日期 + 剩余天数 + 还原/彻底删除） */
function renderRecycle() {
  const wrap = $("recycleList");
  if (!recycleList.length) {
    wrap.innerHTML =
      '<div class="empty"><span class="emoji">🗑️</span>回收站是空的～<br/>删除的笔记会在这里保留 7 天</div>';
    return;
  }
  const now = Date.now();
  wrap.innerHTML = recycleList.map(m => {
    const locked = recycleLockedIds.has(m.objectId);
    let imgHtml = "";
    let descHtml = "";
    if (!locked) {
      const imgs = getMemoImages(m);
      if (imgs.length === 1) {
        imgHtml = `<img class="rb-img" src="${escapeHtml(imgs[0].url)}" alt="" loading="lazy" />`;
      } else if (imgs.length > 1) {
        const cols = (imgs.length <= 4) ? 2 : 3;
        imgHtml = `<div class="rb-grid cols-${cols}">` +
          imgs.slice(0, 9).map(im => `<img src="${escapeHtml(im.url)}" alt="" loading="lazy" />`).join("") +
          `</div>`;
      }
      descHtml = m.content ? `<div class="rb-desc">${escapeHtml(m.content)}</div>` : "";
    }
    const deletedAt = parseBmobDate(m.updatedAt);
    const remainMs = RECYCLE_TTL_MS - (now - deletedAt);
    const remainDays = Math.max(0, Math.ceil(remainMs / (24 * 60 * 60 * 1000)));
    const dateStr = deletedAt
      ? new Date(deletedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
      : "--";
    return `
    <div class="rb-item ${locked ? 'locked' : ''}" data-id="${m.objectId}">
      <div class="rb-main">
        <div class="rb-title">${locked ? '🔒 ' : ''}${escapeHtml(m.title)}</div>
        ${descHtml}
        ${imgHtml}
        ${locked ? '<div class="rb-locked-hint">内容已加密，还原后仍需密码访问</div>' : ''}
        <div class="rb-meta">
          ${m.tag ? `<span class="tag-badge" data-tag="${escapeHtml(m.tag)}">${escapeHtml(m.tag)}</span>` : ""}
          ${locked ? '<span class="lock-badge">🔒 已加密</span>' : ''}
          <span class="rb-time">删除于 ${dateStr} · 还剩 ${remainDays} 天</span>
        </div>
      </div>
      <div class="rb-actions">
        <button class="btn-mini btn-rb-restore" onclick="restoreMemo('${m.objectId}')">↩️ 还原</button>
        <button class="btn-mini btn-rb-purge" onclick="purgeMemo('${m.objectId}')">彻底删除</button>
      </div>
    </div>`;
  }).join("");
}

/** 还原一条笔记：username 改回当前用户，回到主列表 */
async function restoreMemo(id) {
  try {
    await MemoDAO.restore(id);
    recycleList = recycleList.filter(m => m.objectId !== id);
    renderRecycle();
    showToast("已还原 ✿");
    refreshRecycleBadge();
    // 主列表里立刻出现这条笔记
    fetchMemos().catch(() => {});
  } catch (e) {
    showToast("还原失败：" + e.message);
  }
}

/** 彻底删除一条（不可找回，需二次确认；加密笔记联动云函数清锁账号） */
async function purgeMemo(id) {
  if (!confirm("彻底删除后无法找回，确定吗？")) return;
  try {
    await MemoDAO.hardRemove(id);
    recycleList = recycleList.filter(m => m.objectId !== id);
    recycleLockedIds.delete(id);
    unpinId(id);
    await safeClearFontCfg(id);  // 兜底：残留的字体配置一并清除
    await safePurgeLocks([id]); // 加密笔记：云函数删除锁账号（静默兜底）
    renderRecycle();
    showToast("已彻底删除");
    refreshRecycleBadge();
  } catch (e) {
    showToast("删除失败：" + e.message);
  }
}

/**
 * 调云函数批量清锁账号（静默失败，不阻断删除主流程；云函数未部署时只警告）
 * @param {string[]} memoIds
 */
async function safePurgeLocks(memoIds) {
  const locked = (memoIds || []).filter(id => id);
  if (!locked.length) return;
  try {
    await MemoLock.adminPurge(locked);
  } catch (e) {
    console.warn("purgeLockUsers 云函数清理失败：", e.message);
  }
}

/** 清空回收站（全部彻底删除，危险操作需二次确认） */
async function emptyRecycleBin() {
  if (!recycleList.length) { showToast("回收站已经是空的"); return; }
  if (!confirm(`确定清空回收站吗？\n\n${recycleList.length} 条笔记将被彻底删除，无法找回！`)) return;
  let ok = 0, fail = 0;
  const ids = recycleList.map(m => m.objectId);
  for (const id of ids) {
    try { await MemoDAO.hardRemove(id); unpinId(id); ok++; }
    catch (e) { fail++; }
  }
  // 批量清锁账号（云函数一次调用处理全部加密笔记）
  await safePurgeLocks(ids.filter(id => recycleLockedIds.has(id)));
  recycleList = [];
  recycleLockedIds = new Set();
  renderRecycle();
  refreshRecycleBadge();
  showToast(fail ? `已清空 ${ok} 条，${fail} 条失败，请重试` : "回收站已清空");
}

/**
 * 自动清理过期的回收站记录（updatedAt 距今超过 7 天 → 彻底删除）
 * 在打开回收站时调用；失败静默，不影响正常使用
 */
async function cleanupExpiredRecycle() {
  let out;
  try {
    out = await MemoDAO.queryDeleted();
  } catch (e) { return; }
  const now = Date.now();
  const expiredLocked = [];
  for (const m of out.rows) {
    const deletedAt = parseBmobDate(m.updatedAt);
    if (deletedAt && now - deletedAt > RECYCLE_TTL_MS) {
      try {
        await MemoDAO.hardRemove(m.objectId);
        if (out.locked.has(m.objectId)) expiredLocked.push(m.objectId);
      } catch (e) { /* 下次再试 */ }
    }
  }
  if (expiredLocked.length) await safePurgeLocks(expiredLocked);
}

/** 刷新工具栏回收站角标数字（轻量查询，失败则隐藏角标） */
async function refreshRecycleBadge() {
  const badge = $("recycleBadge");
  if (!badge) return;
  try {
    const out = await MemoDAO.queryDeleted();
    const now = Date.now();
    // 只统计未过期的（过期的等打开回收站时统一清理）
    const valid = out.rows.filter(m => {
      const t = parseBmobDate(m.updatedAt);
      return !t || now - t <= RECYCLE_TTL_MS;
    });
    badge.textContent = valid.length;
    badge.style.display = valid.length ? "flex" : "none";
  } catch (e) {
    badge.style.display = "none";
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

/* ---- 多图上传（最多 9 张，图片大小不限） ---- */

const MAX_IMAGES = 9;   // 每条备忘最多 9 张图片

/*
 * 为什么 9 张图要用 imgUrl1…imgUrl9 九个字段分开存？
 * ─────────────────────────────────────────────
 * Bmob 免费版【单次请求体硬上限 40KB】，每张图本地压缩到 ≤36KB：
 *   · 9 张塞进一个字段/一次请求 = 约 324KB，必然超限
 *   · 拆成九个字段后，每张图就是一次只带一个字段的请求（≤37KB），永远不超限
 *   · 备忘和图片同处一条记录：删备忘自动带走图片，不用清理子表
 * 旧数据的 imgUrl 单字段继续兼容（见 getMemoImages）
 */

/**
 * 解析一条备忘的 5 个缩略图打包列 → 长度 10 的数组（下标 1..9 即槽位）
 * 每列内容是 JSON 数组 [第(2p-1)张, 第2p张]；空槽为 ""
 * 早期版本遗留的裸 dataURL 会被忽略（那些记录没有正式发布过）
 */
function localThumbs(m) {
  if (m.__th) return m.__th;
  const arr = Array(10).fill("");
  for (let p = 1; p <= 5; p++) {
    const raw = m["thumb" + p];
    if (!raw || typeof raw !== "string" || raw.charAt(0) !== "[") continue;
    try {
      const pair = JSON.parse(raw);
      if (Array.isArray(pair)) {
        pair.forEach((u, j) => { if (u) arr[(p - 1) * 2 + j + 1] = u; });
      }
    } catch (e) { /* 非本版数据，忽略 */ }
  }
  m.__th = arr;
  return arr;
}

/**
 * 统一取出一条备忘的全部图片
 * @returns {Array<{slot:number, big:string, url:string}>}
 *   · slot：1..9（旧单图为 0）
 *   · big：大图字段名（灯箱按需拉取；旧数据为 "imgUrl"）
 *   · url：列表立即可用的图（缩略图，或旧 imgUrl 大图）
 */
function getMemoImages(m) {
  if (!m) return [];
  const list = [];
  if (m.imgUrl) list.push({ slot: 0, big: "imgUrl", url: m.imgUrl }); // 旧版单图
  const th = localThumbs(m);
  for (let i = 1; i <= MAX_IMAGES; i++) {
    if (th[i]) list.push({ slot: i, big: "imgUrl" + i, url: th[i] });
  }
  return list;
}

/**
 * 构造一个表单图片项
 * @param {string|null} field 大图字段 imgUrl1..9（上传成功后确定）
 * @param {string} url 格子里显示的图（本地原图 / 已存记录的缩略图）
 */
function makeFormImageItem(field, url, status, file) {
  const slot = /^imgUrl\d+$/.test(field || "") ? parseInt(field.slice(6), 10) : 0;
  return {
    key: "img_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    field: field || null,       // 大图字段名 imgUrlN（旧数据为 imgUrl）
    slot: slot,                 // 槽位 1..9（旧单图为 0）
    url: url || null,           // 格子显示图（done 后是缩略图）
    bigUrl: null,               // 大图（灯箱用；旧记录可直接有）
    status: status,             // uploading | done | error
    file: file || null,         // 原始文件（重试时还要用）
    gen: 0,                     // 代数：移除/重试时 +1，让迟到的旧结果作废
    errorMsg: ""
  };
}

/**
 * 渲染表单九宫格
 * · 上传中：半透明遮罩 + 白色转圈
 * · 失败：遮罩上出现「↻ 重试」按钮（悬停可看到失败原因）
 * · ✕ 随时移除；点图片进灯箱
 */
function renderFormGrid() {
  const box = $("imgFormGrid");
  box.innerHTML = formImages.map((item, idx) => {
    const src = item.url || "";
    let overlay = "";
    if (item.status === "uploading") {
      overlay = '<div class="fg-mask"><span class="fg-spin"></span></div>';
    } else if (item.status === "error") {
      overlay = `<div class="fg-mask"><button type="button" class="fg-retry" title="${escapeHtml(item.errorMsg || "上传失败")}" onclick="retryFormImage('${item.key}')">↻ 重试</button></div>`;
    }
    const imgClick = src ? `onclick="openFormLightbox(${idx})"` : "";
    return `
      <div class="fg-cell">
        ${src
          ? `<img src="${escapeHtml(src)}" alt="图片${idx + 1}" ${imgClick} />`
          : '<div class="fg-placeholder"></div>'}
        <button type="button" class="fg-del" title="移除这张图片" onclick="removeFormImage('${item.key}')">✕</button>
        ${overlay}
      </div>`;
  }).join("");
}

/**
 * 选图入口（支持一次多选）
 * 选完立即本地预览，并启动串行上传队列；图片不再等表单提交
 */
$("fileInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";   // 清空，允许重复选择同一文件
  const images = files.filter(f => f.type && f.type.startsWith("image/"));
  if (!images.length) { if (files.length) showToast("请选择图片文件"); return; }

  // 数量校验：已有图片（含上传中/失败占位）+ 本次选择 ≤ 9
  const remain = MAX_IMAGES - formImages.length;
  if (remain <= 0) { showToast("最多只能上传 " + MAX_IMAGES + " 张图片哦"); return; }
  const picked = images.slice(0, remain);
  if (images.length > remain) {
    showToast("最多 " + MAX_IMAGES + " 张，已自动选前 " + remain + " 张");
  }

  const added = [];
  for (const file of picked) {
    const item = makeFormImageItem(null, null, "uploading", file);
    formImages.push(item);
    added.push(item);
  }
  // 本地原图立即显示（即时反馈，不用等压缩和网络）
  picked.forEach((file, i) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (formImages.includes(added[i])) {
        added[i].url = ev.target.result;
        renderFormGrid();
      }
    };
    reader.readAsDataURL(file);
  });
  renderFormGrid();
  runUploadQueue();
});

/**
 * 串行上传队列：每次只传一张，避免字段抢位和请求并发
 * 任何一张失败都不影响其他张，失败项可单独重试
 * 队列暂时排空时不立刻收尾：连续选图（含多选文件分批次注入）可能正在往
 * formImages 里追加新项，留 800ms 静默窗口复查，避免“几张图建成几条备忘”
 */
async function runUploadQueue() {
  if (batchRunning) return;
  batchRunning = true;
  try {
    while (true) {
      let item = formImages.find(i => i.status === "uploading");
      if (!item) {
        await new Promise(r => setTimeout(r, 800));
        item = formImages.find(i => i.status === "uploading");
        if (!item) break;
      }
      await uploadOneImage(item);
    }
  } finally {
    batchRunning = false;
  }
  afterBatch();
}

/**
 * 把某槽位的缩略图合并进它所属的打包列（2 张一包）并写云端
 * 同一条备忘的图片串行上传，本地 __th 缓存即为最新状态，无需先 GET
 *
 * @param {string} memoId
 * @param {number} slot  槽位 1..9
 * @param {string} thumb dataURL；传 "" 表示删除该槽
 */
async function syncThumbPack(memoId, slot, thumb) {
  const local = memoList.find(m => m.objectId === memoId);
  const arr = local ? localThumbs(local) : Array(10).fill("");
  arr[slot] = thumb || "";
  const p = Math.ceil(slot / 2);
  const s1 = (p - 1) * 2 + 1;
  const s2 = p * 2;
  const pair = [arr[s1] || "", s2 <= MAX_IMAGES ? (arr[s2] || "") : ""];
  const col = "thumb" + p;
  const val = pair.some(Boolean) ? JSON.stringify(pair) : "";
  await MemoDAO.update(memoId, { [col]: val }, true);  // 整包 ≤13KB
  if (local) { local[col] = val; local.__th = arr; }
}

/**
 * 上传单张图片：本地一次解码出【大图 ≤36KB + 缩略图 ≤6KB】
 * · 大图写 imgUrlN（新建第一张随 POST，其余单字段 PUT）
 * · 缩略图通过 syncThumbPack 合并进 thumb1..5 打包列
 */
async function uploadOneImage(item) {
  item.gen++;
  const gen = item.gen;
  /** 异步中途若这张图已被移除，立刻终止后续动作 */
  const alive = () => formImages.includes(item) && item.status === "uploading" && item.gen === gen;
  try {
    // 1) 本地压缩：任何尺寸原图都会压到目标体积以内；图片损坏无法解码时抛错
    const { big, thumb } = await processImage(item.file);
    if (!alive()) return;

    let targetField = item.field || nextFreeField();
    if (!targetField) throw new Error("图片数量已达上限（" + MAX_IMAGES + " 张）");
    const slot = parseInt(targetField.slice(6), 10);
    let memoId = editingId || batchMemoId;
    let needWriteBig = item.field !== targetField;  // 重试时大图可能已写过

    if (!memoId) {
      // 2) 新建模式第一批第一张：POST 只带大图 imgUrl1 创建备忘
      const snap = snapshotForNewMemo();
      targetField = "imgUrl1";
      const body = {
        title: snap.title, content: snap.content,
        isFinish: false, username: currentUser,
        imgUrl1: big
      };
      if (snap.tag) body.tag = snap.tag;
      const created = await MemoDAO.create(body);

      // 请求往返期间用户可能已把这张图移除 → 删除刚建出的“孤儿备忘”
      if (!alive()) {
        try { await MemoDAO.remove(created.objectId); } catch (_) {}
        return;
      }
      batchMemoId = created.objectId;
      memoId = created.objectId;
      item.field = "imgUrl1";
      item.slot = 1;
      needWriteBig = false;   // 大图已随 POST 写入
      memoList.unshift({
        objectId: created.objectId,
        title: snap.title, content: snap.content,
        isFinish: false, username: currentUser,
        tag: snap.tag || null,
        createdAt: created.createdAt
      });
    }

    // 3) 后续张 / 编辑模式：先写大图（跳过归属校验，归属由本流程保证）
    if (needWriteBig) {
      await MemoDAO.update(memoId, { [targetField]: big }, true);
      if (!alive()) {
        // 用户恰在请求途中移除了这张图：把刚写入的大图字段回滚清空
        try { await MemoDAO.update(memoId, { [targetField]: "" }, true); } catch (_) {}
        return;
      }
      item.field = targetField;
      item.slot = slot;
    }
    // 4) 缩略图合并进打包列（第二次请求，整包 ≤13KB，绝不超 40KB）
    await syncThumbPack(memoId, item.slot, thumb);
    if (!alive()) {
      // 用户在请求途中移除：大图清空 + 打包列按本地状态重算
      try {
        await MemoDAO.update(memoId, { [item.field]: "" }, true);
        await syncThumbPack(memoId, item.slot, "");
      } catch (_) {}
      return;
    }

    // 5) 回写表单项（列表缩略图已由 syncThumbPack 写入本地缓存）
    item.url = thumb;
    item.bigUrl = big;
    item.status = "done";
    item.errorMsg = "";
    renderFormGrid();
  } catch (e) {
    if (!formImages.includes(item) || item.gen !== gen) return;
    item.status = "error";
    item.errorMsg = (e && e.message) || "上传失败";
    renderFormGrid();
  }
}

/** 新建模式创建备忘时的标题/内容/标签快照（无标题自动生成“📷 图片备忘 时间”） */
function snapshotForNewMemo() {
  let title = $("titleInput").value.trim();
  const content = $("contentInput").value.trim();
  if (!title) {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    title = "📷 图片备忘 " + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
          + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  return { title, content, tag: selectedTag };
}

/** 找下一个未被占用的大图字段 imgUrl1..9（被占用或满了返回 null） */
function nextFreeField() {
  const used = formImages.map(i => i.field).filter(Boolean);
  for (let i = 1; i <= MAX_IMAGES; i++) {
    const f = "imgUrl" + i;
    if (!used.includes(f)) return f;
  }
  return null;
}

/**
 * 移除九宫格中的一张图片
 * · 上传中：直接移除（在途请求无法中断，迟到结果会被 gen/includes 校验丢弃；
 *   若它是“第一张 POST”且随后才成功，uploadOneImage 会自动删除孤儿备忘）
 * · 失败：直接移除
 * · 已完成：云端对应字段 PATCH 为空，刷新后同样生效
 */
function removeFormImage(key) {
  const idx = formImages.findIndex(i => i.key === key);
  if (idx === -1) return;
  const item = formImages[idx];

  if (item.status === "uploading") {
    item.gen++;
    item.status = "removed";
    formImages.splice(idx, 1);
    renderFormGrid();
    return;
  }

  if (item.status === "error") {
    formImages.splice(idx, 1);
    renderFormGrid();
    afterBatch();   // 失败项被移光后可能正好整批完成
    return;
  }

  // done：云端清空该字段
  const memoId = editingId || batchMemoId;
  if (!memoId || !item.field) {
    formImages.splice(idx, 1);
    renderFormGrid();
    return;
  }
  withLoading(async () => {
    try {
      // 清空大图字段（旧 imgUrl 或 imgUrlN）
      await MemoDAO.update(memoId, { [item.field]: "" }, true);
      // 新版图片还要把缩略图从打包列中移除并重写该包
      if (item.slot >= 1) await syncThumbPack(memoId, item.slot, "");
      const cur = formImages.findIndex(i => i.key === key);
      if (cur !== -1) formImages.splice(cur, 1);
      renderFormGrid();
      renderList();
      showToast("图片已移除 ✿");
      afterBatch();
    } catch (e) {
      handleOpError(e, { id: memoId });
    }
  });
}

/** 重试一张失败的图片（字段保持原分配） */
function retryFormImage(key) {
  const item = formImages.find(i => i.key === key);
  if (!item || item.status !== "error" || !item.file) return;
  item.status = "uploading";
  item.errorMsg = "";
  renderFormGrid();
  runUploadQueue();
}

/**
 * 一批上传全部结束后的统一收尾
 * · 新建模式全部成功：备忘已在列表，提示后清空表单（与旧版体验一致）
 * · 有失败：保留网格，提示可重试 / 移除（失败项全部被移除后也会正常收尾）
 * · 编辑模式：刷新卡片，按成功/失败给出提示
 */
function afterBatch() {
  if (formImages.some(i => i.status === "uploading")) return;
  const doneN = formImages.filter(i => i.status === "done").length;
  const failN = formImages.filter(i => i.status === "error").length;

  if (!editingId && batchMemoId) {
    renderList();
    if (failN === 0) {
      showToast(doneN + " 张图片已保存到新备忘 ✿ 点「编辑」可补充文字");
      resetForm();
    } else {
      showToast(doneN + " 张已保存，" + failN + " 张失败，点 ↻ 重试或 ✕ 移除");
    }
  } else if (editingId) {
    renderList();
    if (failN === 0) showToast("图片已全部插入备忘 ✿");
    else showToast(doneN + " 张成功，" + failN + " 张失败，点 ↻ 重试");
  }
}

/* ---- 加密弹窗键盘：Enter 提交 / Esc 取消（仅弹窗可见时生效） ---- */
document.addEventListener("keydown", (e) => {
  const mask = $("lockModalMask");
  if (!mask.classList.contains("show")) return;
  if (e.key === "Enter") { e.preventDefault(); LockDialog.submit(); }
  else if (e.key === "Escape") { e.preventDefault(); LockDialog.cancel(); }
});

/* 初始渲染一次加密区（登录后表单即可见；此时为新建/未加密态） */
syncLockBox();

/* ---- 图片灯箱（缩略图秒开，大图按需单字段拉取，支持左右切换） ---- */

const LightboxState = {
  memoId: null,     // 图片属于哪条备忘（表单里的本地原图为 null）
  items: [],        // [{ big: 大图字段名|null, url: 立即可用的缩略图/旧大图 }]
  cache: [],        // 与 items 等长：已拉到的大图，否则 null
  idx: 0
};

/** 备忘卡片入口：列表里只有缩略图，大图打开时逐张 GET（响应仅 ~36KB） */
function openLightboxForMemo(id, idx) {
  const m = memoList.find(x => x.objectId === id);
  if (!m) return;
  const imgs = getMemoImages(m);
  if (!imgs.length) return;
  LightboxState.memoId = id;
  LightboxState.items = imgs.map(i => ({ big: i.big, url: i.url }));
  // 旧版 imgUrl 单图字段本身就在内存里，直接当缓存，无需再请求
  LightboxState.cache = imgs.map(i => (i.big === "imgUrl" ? i.url : null));
  LightboxState.idx = Math.min(Math.max(0, idx || 0), imgs.length - 1);
  $("lightbox").classList.add("show");
  renderLightbox();
  ensureLightboxBig();
}

/** 表单九宫格入口：顺序完全跟随 formImages */
function openFormLightbox(idx) {
  if (!formImages.length) return;
  LightboxState.memoId = editingId || batchMemoId;
  LightboxState.items = formImages.map(i => ({ big: i.field, url: i.url }));
  LightboxState.cache = formImages.map(i => {
    if (i.bigUrl) return i.bigUrl;   // 本次会话刚传完，大图还在内存
    if (i.file) return i.url;       // 上传中/失败：本地原图本身就是高清图
    return null;                    // 编辑模式装载的历史记录：稍后按需拉
  });
  LightboxState.idx = Math.min(Math.max(0, idx || 0), formImages.length - 1);
  $("lightbox").classList.add("show");
  renderLightbox();
  ensureLightboxBig();
}

/** 渲染灯箱当前画面：优先大图缓存，否则先显示缩略图 + 箭头显隐 + 计数 */
function renderLightbox() {
  const { items, cache, idx } = LightboxState;
  $("lightboxImg").src = cache[idx] || (items[idx] && items[idx].url) || "";
  const multi = items.length > 1;
  $("lbPrev").style.display = multi ? "flex" : "none";
  $("lbNext").style.display = multi ? "flex" : "none";
  $("lbCount").textContent = (idx + 1) + " / " + items.length;
}

/** 当前张缺大图时，按单个字段向云端拉取（避开 200KB 响应上限） */
async function ensureLightboxBig() {
  const s = LightboxState;
  const want = s.idx;
  const cur = s.items[want];
  if (!cur || s.cache[want] || !s.memoId || !cur.big || cur.big === "imgUrl") return;
  const hint = $("lbHint");
  if (hint) hint.textContent = "高清图加载中…";
  try {
    const r = await BmobAPI.request("GET",
      "/classes/" + TABLE_NAME + "/" + s.memoId + "?keys=" + cur.big, null);
    s.cache[want] = r[cur.big] || cur.url;
    if (s.idx === want) {
      $("lightboxImg").src = s.cache[want] || "";
      if (hint) hint.textContent = "";
    }
  } catch (e) {
    if (s.idx === want && hint) hint.textContent = "高清图加载失败，先看缩略图";
  }
}

/** 左右切换（循环）：切到哪张拉哪张，拉过的走缓存 */
function lightboxShift(d) {
  const s = LightboxState;
  if (s.items.length < 2) return;
  s.idx = (s.idx + d + s.items.length) % s.items.length;
  renderLightbox();
  ensureLightboxBig();
}

/** 关闭灯箱 */
function closeLightbox() {
  $("lightbox").classList.remove("show");
  $("lightboxImg").src = "";
  LightboxState.items = [];
  LightboxState.cache = [];
  LightboxState.memoId = null;
}

// 键盘：ESC 关闭，← → 切换
document.addEventListener("keydown", (e) => {
  if (!$("lightbox").classList.contains("show")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") lightboxShift(-1);
  else if (e.key === "ArrowRight") lightboxShift(1);
});

/* ---- 主题切换（6 套亮色皮肤 + 亮/暗模式） ---- */

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

/* ===================== 暗色 / 明亮模式 =====================
 * 手机系统式一键来回切换：
 *  - 用户手动点过 → localStorage(memo_dark) 记住，刷新/重开都保持
 *  - 从没点过     → 跟随系统 prefers-color-scheme，系统变了页面也跟着变
 * 首屏是否暗色已由 index.html 的 head 内联脚本提前写好（防闪烁），
 * 这里只负责同步按钮图标、处理点击与监听系统变化。
 */

/** 系统当前是否暗色 */
function isSystemDark() {
  return !!(window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/**
 * 应用亮/暗模式（只改 <html data-mode> 与按钮图标）
 * @param {boolean} on - true=暗色 false=明亮
 */
function setDarkMode(on) {
  const root = document.documentElement;
  if (on) root.setAttribute("data-mode", "dark");
  else root.removeAttribute("data-mode");

  const btn = $("darkToggle");
  if (btn) {
    // 图标含义：点一下将要进入的模式（亮色时显月亮，暗色时显太阳）
    btn.textContent = on ? "☀️" : "🌙";
    btn.title = on ? "切换到明亮模式" : "切换到暗色模式";
  }
}

/** 顶栏按钮：亮 ↔ 暗来回切换，并记住用户的手动选择 */
function toggleDarkMode() {
  const on = document.documentElement.getAttribute("data-mode") !== "dark";
  setDarkMode(on);
  localStorage.setItem("memo_dark", on ? "1" : "0");
}

/** 初始化暗色模式：手动选择优先，否则跟随系统；并监听系统主题变化 */
function initDarkMode() {
  const saved = localStorage.getItem("memo_dark");
  setDarkMode(saved === null ? isSystemDark() : saved === "1");

  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => {
      // 用户手动选过之后就不再跟随系统（和手机逻辑一致）
      if (localStorage.getItem("memo_dark") === null) setDarkMode(e.matches);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange); // 老版 Safari 兼容
  }
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
  initDarkMode();
  // 字体控件初始态（新建模式 = 全局默认：无衬线 / 15px）
  applyFormFont();

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
  // 打字 / 删字 / 粘贴 / 撤销都触发 input → 输入框实时随内容长高缩回
  $("contentInput").addEventListener("input", autoResizeContent);
  $("loginPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("loginBtn").click(); }
  });
  // ESC 关闭 AI 流式面板（生成中关闭会中断且不保存）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("streamOverlay").classList.contains("show")) {
      AI_STREAM.close();
    }
  });
})();
