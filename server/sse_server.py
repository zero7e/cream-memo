# -*- coding: utf-8 -*-
"""
================================================================================
 懒人备忘录 · AI 总结润色 SSE 流式服务（Python 零依赖版）
================================================================================
✅ 只用 Python 标准库（http.server / urllib / json / threading），
   无需 pip install 任何东西，Windows 双击 start-server.bat 即可运行。

本服务同时承担两个职责（同源部署，前端无 CORS 问题）：
  1. 静态文件服务：把上一级目录（index.html / css / js 所在目录）当作网站根目录
  2. AI 流式接口：POST /api/polish  →  text/event-stream（SSE 服务端推送）

接口流程（严格按顺序，任一步失败都不会产生脏数据）：
  ① 归属校验  GET Bmob /classes/Memo?where={objectId,username}
     —— 笔记不存在 / 已删除 / 不属于该用户 → HTTP 403，直接拒绝，不进入 AI
  ② AI 流式生成（两种模式，在下方配置区选择）
     a. 配了 LLM_API_KEY：调用 OpenAI 兼容接口（DeepSeek / 豆包 / Kimi 等），
        逐 token 读取上游 SSE 并立即转发给浏览器（真·大模型流式）
     b. 没配密钥（默认）：内置规则引擎复刻前端 summarizeAndPolish 的整理逻辑，
        把结果切成 2~4 字的小片逐片推送 + 短延迟，模拟大模型打字机效果
  ③ 完整生成且未超长 → POST 一条【全新】笔记到 Bmob（绝不修改原笔记）
     再推送 done 事件（带新笔记 objectId）
  ④ 任何超时 / AI 报错 / 超长 / 客户端中断 → 推送 error 或直接断链，
     且【绝不】写入 Bmob

SSE 帧协议（前端 app.js 按同一协议解析，勿随意改字段名）：
  data: {"type":"start"}\n\n                                    流开始
  data: {"type":"delta","text":"片段"}\n\n                      增量文本（可多帧）
  data: {"type":"done","objectId":"xxx","title":"..."}\n\n      完成且已入库
  data: {"type":"error","stage":"...","message":"..."}\n\n      出错（不入库）
  （以半角冒号开头的行是 SSE 注释/心跳，前端自动忽略）

运行：python sse_server.py        默认端口 8001
访问：http://localhost:8001/index.html
================================================================================
"""

import os
import re
import sys
import json
import time
import socket
import threading
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# ============================================================================
# ★★★ 配置区（手动粘贴，和 js/app.js 顶部保持一致） ★★★
# ============================================================================

# Bmob 应用密钥（从 Bmob 后台 → 设置 → 应用密钥 复制）
APPLICATION_ID = "6dd518b7fba75a11b75f9863883616a9"
REST_API_KEY   = "9099ac88fc936a9ea14cff5e0844ac30"

# Bmob 数据表名
TABLE_NAME = "Memo"

# Bmob 域名容灾列表（按优先级尝试，与前端一致）
BMOB_HOSTS = [
    "https://api.bmobcloud.com",
    "https://api.bmobapp.com",
    "https://api.bmob.cn",
]

# ---- 大模型（可选）----------------------------------------------------------------
# 留空 → 使用内置规则引擎，零配置即可体验完整流式效果
# 填入 OpenAI 兼容密钥后 → 自动切换为真实大模型流式输出
# 当前接入：DeepSeek（platform.deepseek.com 创建的 API Key，格式 sk-xxxx）
LLM_BASE_URL = "https://api.deepseek.com/v1"
LLM_API_KEY  = ""            # ←←← 在这里粘贴你的 DeepSeek API Key
LLM_MODEL    = "deepseek-chat"

# ---- 限流 / 超时配置（一般不用改）------------------------------------------------
LISTEN_PORT       = 8001    # 本地服务端口
BMOB_TIMEOUT      = 15      # Bmob 归属校验 / 入库单次请求超时（秒）
LLM_CONNECT_TO    = 15      # 大模型建连超时（秒）
CLASSIFY_TIMEOUT  = 20      # 第一层「笔记类型识别」超时（秒），超时走本地启发式兜底
LLM_TOTAL_DEADLINE = 90     # 第二层润色整体生成最长耗时（秒），超时判失败不入库
MAX_INPUT_CHARS   = 6000    # 原文（标题+内容）超过该长度 → 直接报错，不请求 AI
MAX_OUTPUT_CHARS  = 4000    # AI 输出超过该长度 → 判超长错误，不入库
MOCK_CHUNK_DELAY  = 0.035   # 内置引擎每片推送间隔（秒），越小打字越快
LONG_NOTE_CHARS   = 400     # 本地分类：正文超过该字数且不属于其他类型 → 长文本笔记


# ============================================================================
# 一、Bmob REST 封装（归属校验 + 新建笔记，三域名容灾）
# ============================================================================

class BmobError(Exception):
    """Bmob 应用层错误（带后端返回的 error 文案）"""


def _bmob_headers():
    return {
        "X-Bmob-Application-Id": APPLICATION_ID,
        "X-Bmob-REST-API-Key": REST_API_KEY,
        "Content-Type": "application/json",
    }


def bmob_request(method, path, body=None, timeout=BMOB_TIMEOUT):
    """
    向 Bmob 发请求，自动遍历 BMOB_HOSTS 容灾。
    :param method: GET / POST / PUT / DELETE
    :param path:   /1 之后的路径，如 /classes/Memo?where=...
    :param body:   dict（自动 JSON 序列化）或 None
    :return:       解析后的 dict；空响应返回 {}
    :raises BmobError / 原生网络异常（全部域名失败时抛最后一个错误）
    """
    last_err = None
    for host in BMOB_HOSTS:
        url = host + "/1" + path
        data = None
        if body is not None:
            # ensure_ascii=False 后再 encode，保证中文不以 \uXXXX 传输
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in _bmob_headers().items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            # 尝试解析 Bmob 返回的错误文案
            try:
                detail = json.loads(e.read().decode("utf-8"))
                msg = detail.get("error") or detail.get("message") or ("HTTP %s" % e.code)
            except Exception:
                msg = "Bmob HTTP %s" % e.code
            # 401/403 是确定性的鉴权错误，换域名也无意义 → 立即抛出
            if e.code in (401, 403):
                raise BmobError(msg)
            last_err = BmobError(msg)
            continue  # 404/5xx 可能是该域名路径差异 → 尝试下一域名
        except Exception as e:
            # DNS / 超时 / 连接重置等网络层错误 → 尝试下一域名
            last_err = e
            continue
    raise last_err if last_err else BmobError("所有 Bmob 域名均不可用")


def verify_ownership(note_id, username):
    """
    归属校验：只查 objectId + username 同时命中的笔记。
    :return: 笔记 dict
    :raises BmobError: 不存在 / 已删除 / 不属于该用户
    """
    where = json.dumps({"objectId": note_id, "username": username}, ensure_ascii=False)
    path = "/classes/%s?where=%s&limit=1" % (
        TABLE_NAME, urllib.parse.quote(where, safe=""))
    data = bmob_request("GET", path)
    results = data.get("results") or []
    if not results:
        raise BmobError("笔记不存在、已被删除或无权访问")
    return results[0]


def create_polished_note(title, content, username, tag):
    """
    把完整的润色结果【新建】为一条独立笔记（绝不 PUT 原笔记）。
    :return: 新建结果 dict（含 objectId / createdAt）
    """
    body = {
        "title": title,
        "content": content,
        "isFinish": False,
        "imgUrl": "",
        "username": username,
        "tag": tag or "",
    }
    return bmob_request("POST", "/classes/%s" % TABLE_NAME, body)


# ============================================================================
# 二、内置规则引擎（未配置大模型密钥时使用；逻辑对齐前端 summarizeAndPolish）
# ============================================================================

# 意图表：(类型, 标签, 触发词)
_INTENTS = [
    ("work", "工作", ["开会", "汇报", "报告", "总结", "计划", "安排", "项目", "客户",
                      "同事", "领导", "演讲", "演示", "培训", "绩效", "述职"]),
    ("study", "学习", ["学", "背", "记", "刷", "练", "复习", "预习", "准备", "考试",
                       "论文", "作业", "课程", "网课", "英语", "单词", "看书", "阅读"]),
    ("create", "灵感", ["想", "设计", "策划", "构思", "灵感", "创意", "想法", "点子",
                        "方案", "内容", "文案", "海报", "视频", "文章"]),
    ("remind", "生活", ["别忘了", "记得", "不要忘", "提醒", "不要忘记", "千万别忘了"]),
    ("health", "生活", ["运动", "健身", "跑步", "散步", "打球", "游泳", "瑜伽", "减肥",
                        "瘦", "睡", "早起", "早睡", "喝水", "吃饭", "养生"]),
    ("action", "生活", ["去", "做", "买", "看", "写", "读", "听", "吃", "喝", "玩",
                        "跑", "走", "整理", "收拾", "洗", "扫", "扔", "取", "寄", "送",
                        "交", "还", "补", "修", "装", "建", "找", "联系", "沟通", "回复",
                        "约", "聊", "见面", "聚会", "出门", "前往"]),
]

# 时间提示词
_TIME_TIPS = [
    (["今天", "今日"], "今天内尽量完成，不要拖到明天"),
    (["明天", "明日"], "明天的事今天先做准备，早起步不慌乱"),
    (["后天"], "还有缓冲时间，可以先收集信息"),
    (["周末", "周六", "周日", "星期六", "星期日"], "利用整块时间集中处理，不被打断效率高"),
    (["下周", "下个星期"], "这周内先规划好，下周直接执行"),
    (["晚上", "今晚", "夜里"], "晚上精力有限，安排轻量任务为宜"),
    (["早上", "上午", "中午"], "黄金时段处理最重要的事"),
    (["马上", "立刻", "尽快", "紧急", "赶紧"], "紧急！立刻处理，别做其他事"),
]

# 各意图的下一步行动模板（{obj} 会替换成核心关键词）
_STEP_TEMPLATES = {
    "work": ["明确{obj}的目标、验收标准和 deadline",
             "收集支撑材料（数据 / 案例 / 参考文档）",
             "搭框架：背景 → 现状 → 方案 → 预期效果"],
    "study": ["拆解{obj}的知识体系和重点考点",
              "用思维导图梳理框架，建立整体认知",
              "逐块攻克：先理解概念，再做练习题"],
    "create": ["明确{obj}的目标受众和要解决的痛点",
               "调研现有方案，找到差异化切入点",
               "搭核心框架：主线 + 分支 + 亮点设计"],
    "remind": ["把{obj}加入今日待办清单，置顶显示",
               "设闹钟 / 日历提醒，双保险不会忘",
               "提前 5 分钟准备{obj}所需的东西"],
    "health": ["热身 5 分钟，身体进入状态",
               "正式进行{obj}，注意动作标准",
               "中途适当补水，不要硬撑"],
    "action": ["确认{obj}的具体要求和目标",
               "收集{obj}所需的物品 / 信息 / 权限",
               "按优先级排序，从最核心的部分开始动手"],
}

_TAG_EMOJI = {"工作": "💼", "生活": "🏡", "学习": "📚", "灵感": "✨"}
_PUNCT = "。，！？,.!?；;：:、\n\r\t 0123456789.·•-–—*#"


def _detect_intent(text):
    for name, tag, verbs in _INTENTS:
        for v in verbs:
            if v in text:
                return name, tag
    return "action", "生活"


def _find_time_tip(text):
    for words, tip in _TIME_TIPS:
        if any(w in text for w in words):
            return tip
    return ""


def _extract_core(text, fallback):
    """去掉时间词、标点、语气碎片后取前 8 个字作为核心关键词"""
    core = text
    for words, _ in _TIME_TIPS:
        for w in words:
            core = core.replace(w, "")
    for ch in _PUNCT + "吧呢啊呀哦了的要去给我帮一下":
        core = core.replace(ch, "")
    core = core.strip()
    if len(core) < 2:
        core = fallback.strip()
    return core[:8] + "…" if len(core) > 8 else core


def build_polish_text(title, content, tag_hint=""):
    """
    根据原文生成润色稿（标题行 + 空行 + 正文）。
    标题放第 1 行，方便入库时按行拆分；整体也会逐字推送给前端展示。
    :return: (full_text, tag)
    """
    title = (title or "").strip()
    content = (content or "").strip()
    text = (title + " " + content).strip()

    intent, tag = _detect_intent(text)
    if tag_hint:
        tag = tag_hint  # 沿用原笔记标签，保持归类连续
    core = _extract_core(text, title or content)
    time_tip = _find_time_tip(text)

    # 1) 提炼核心要点：按标点/换行切分 → 去序号 → 去重 → 最多 4 条
    raw_lines = []
    buf = ""
    for ch in content:
        if ch in "\n。；;！!？?":
            raw_lines.append(buf)
            buf = ""
        else:
            buf += ch
    if buf:
        raw_lines.append(buf)

    points, seen_heads = [], []
    for line in raw_lines:
        s = line.lstrip(" \t0123456789.、·•-–—*#").strip()
        if len(s) < 4:
            continue
        head = s[:4]
        if head in seen_heads:  # 开头 4 字相同视为重复
            continue
        seen_heads.append(head)
        points.append(s[:30] + "…" if len(s) > 30 else s)
        if len(points) >= 4:
            break
    if not points:
        points.append(title[:30] if title else core)

    # 2) 下一步建议（前 3 条模板，引用核心关键词）
    steps = [tpl.replace("{obj}", core) for tpl in _STEP_TEMPLATES[intent][:3]]

    # 3) 标题：emoji 前缀 + 原标题，过长截断
    emoji = _TAG_EMOJI.get(tag, "📝")
    new_title = title or core
    if len(new_title) > 14:
        new_title = new_title[:14] + "…"
    new_title = emoji + " " + new_title

    # 4) 拼装正文
    body = "✨ AI 润色整理\n\n"
    body += "📌 核心要点：\n" + "\n".join(
        "%d. %s" % (i + 1, p) for i, p in enumerate(points))
    body += "\n\n🎯 下一步建议：\n" + "\n".join(
        "%d. %s" % (i + 1, s) for i, s in enumerate(steps))
    if time_tip:
        body += "\n\n⏰ 时间提示：" + time_tip

    return new_title + "\n\n" + body, tag


# ============================================================================
# 三、动态提示词路由（第一层识别类型 → 第二层按类型润色）
# ============================================================================

# 笔记类型 key → 中文标签（会通过 SSE「type」事件推给前端展示）
CATEGORY_LABELS = {
    "code":    "代码笔记",
    "study":   "学习笔记",
    "diary":   "日常随笔/日记",
    "long":    "长文本笔记",
    "general": "普通笔记",
}

# 4 套专属系统提示词 + 1 套兜底（严格按需求原文嵌入，核心：去模板化、保留作者风格）
CATEGORY_PROMPTS = {
    "code": (
        "你是代码助手，分析笔记内的代码。检查代码错误，补充清晰注释，精简冗余代码，"
        "不要修改原有业务逻辑。描述文字尽量简洁直白，不要使用模板化套话。"
    ),
    "study": (
        "你是学习助手，整理这份笔记，提炼核心知识点与重点考点，结构清晰。"
        "行文自然平实，避免“综上所述、由此可得”这类生硬模板话术，保留原文核心含义。"
    ),
    "diary": (
        "你是文字润色助手，优化语句流畅度。重点：保留原文情绪、个人想法与原本的语气，"
        "不要强行改成规整的书面范文，不要增加模板化的总结段落，只优化语病与不通顺的地方。"
    ),
    "long": (
        "你是文本总结助手，梳理长内容，剔除重复冗余信息，提炼原文核心要点。"
        "语言自然，不要用固定模板式的总结套话，忠于原文信息。"
    ),
    "general": (
        "优化文本语句，保持原文的写作风格，不要套用固定模板、不要增加多余套话，"
        "忠于原文的信息与情绪。"
    ),
}

# 所有类型共用的轻量格式约束（只约定标题行位置，不约束正文结构，避免重新模板化）
_FORMAT_SUFFIX = (
    "\n输出格式仅做两点约定：第 1 行只写标题（可在原标题前加一个贴切的 emoji 和一个空格，"
    "总长不超过 16 字）；第 2 行空行；第 3 行起是正文，正文的写法完全遵循上面的要求，"
    "不要输出任何额外解释或寒暄。"
)

# 第一层分类的系统提示词：强约束只回一个词，方便鲁棒解析
CLASSIFY_SYSTEM_PROMPT = (
    "你是笔记类型识别器。判断用户给出的笔记属于以下哪一类，且只能回复类别词本身，"
    "不要输出任何其他字、标点或解释：\n"
    "代码：含有程序代码、函数、命令或配置片段；\n"
    "学习：课程、考试、知识点、考点、公式、读书笔记等学习内容；\n"
    "日记：第一人称记录当天/近期的生活、心情、随想；\n"
    "长文本：篇幅较长的普通资料、会议记录、事项汇总。\n"
    "无法判断时回复：普通"
)

# 分类回答 → 内部 key 的映射（模型可能回复「代码笔记」等带后缀写法，做包含匹配）
_CLASSIFY_KEYWORDS = [
    ("code",    ("代码", "程序", "编程")),
    ("study",   ("学习", "课程", "考点", "读书")),
    ("diary",   ("日记", "随笔", "心情")),
    ("long",    ("长文本", "长文", "长篇")),
    ("general", ("普通", "一般", "其他")),
]


def parse_category(text):
    """
    鲁棒解析大模型的分类回答：在文本中按优先级找类别关键词。
    解析不出返回 None（调用方再走本地启发式 / 兜底）。
    """
    if not text:
        return None
    t = text.strip()
    for key, words in _CLASSIFY_KEYWORDS:
        if any(w in t for w in words):
            return key
    return None


def classify_local(title, content):
    """
    本地启发式分类器（无大模型密钥 / 大模型分类失败时使用），保证永远能返回一个类型。
    判定优先级：代码 > 学习 > 日记 > 长文本 > 普通
    :return: CATEGORY_LABELS 中的某个 key
    """
    text = ((title or "") + "\n" + (content or "")).strip()
    if not text:
        return "general"

    # 1) 代码笔记：markdown 代码围栏是最强信号
    if "```" in text:
        return "code"
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    # 代码行特征（正则覆盖 Python / JS / Java / C 系常见写法）
    code_line_re = re.compile(
        r"^(def |class |function |const |let |var |import |from .+ import |"
        r"print\(|console\.log|return |if\s*\(|for\s*\(|while\s*\(|"
        r"public |private |protected |async |await |#include|package |"
        r"\}|\{|.*=>.*|.*[a-zA-Z_]\w*\s*=\s*function)"
    )
    code_hits = 0
    for l in lines:
        if code_line_re.match(l):
            code_hits += 1
        elif l.endswith(";") and re.search(r"[{}()=;]", l):
            code_hits += 1
    # 至少 2 行像代码，或代码行占比超过 1/3
    if code_hits >= 2 and (len(lines) <= 4 or code_hits / max(len(lines), 1) >= 0.3):
        return "code"

    # 2) 学习笔记：学习场景关键词
    study_words = ("考点", "知识点", "复习", "预习", "章节", "公式", "定义", "定理",
                   "背诵", "单词", "题目", "考试", "课程", "网课", "作业", "论文",
                   "学习", "笔记整理", "归纳", "思维导图")
    if any(w in text for w in study_words):
        return "study"

    # 3) 日常随笔/日记：第一人称生活记录 + 情绪/时间词，且篇幅不长
    diary_words = ("今天", "今日", "心情", "好开心", "好难过", "日记", "有点", "觉得自己",
                   "早上起床", "下班", "放学", "周末和", "突然觉得", "好烦", "好幸福")
    first_person = ("我" in text)
    if (any(w in text for w in diary_words) and first_person
            and len(text) < LONG_NOTE_CHARS):
        return "diary"

    # 4) 长文本普通笔记：篇幅够长又不属于上面三类
    if len(text) >= LONG_NOTE_CHARS:
        return "long"

    # 5) 兜底
    return "general"


def classify_with_llm(title, content):
    """
    第一层推理：调用大模型识别笔记类型（非流式，要求只回一个类别词）。
    :return: 类型 key；网络失败 / 超时 / 回答无法解析时返回 None，由调用方兜底
    """
    url = LLM_BASE_URL.rstrip("/") + "/chat/completions"
    payload = {
        "model": LLM_MODEL,
        "stream": False,
        "temperature": 0,               # 分类要稳定，不要发散
        "max_tokens": 20,               # 只回一个词，防止模型啰嗦导致超时
        "messages": [
            {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
            {"role": "user",
             "content": "笔记标题：%s\n笔记正文：%s" % (title, content[:3000])},
        ],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + LLM_API_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=CLASSIFY_TIMEOUT) as resp:
        obj = json.loads(resp.read().decode("utf-8"))
    answer = (obj["choices"][0]["message"].get("content") or "").strip()
    return parse_category(answer)


# ---- 无大模型密钥时的「按类型 mock 生成」-------------------------------------
# 内置引擎不可能真正“理解”代码/情绪，因此 mock 仅演示路由效果：
# 代码类保留原代码并加极简注释；日记类只做轻清理、保持原味；其余走结构化整理。

def build_code_mock(title, content):
    """
    代码笔记 mock：保留围栏代码块原文不动，给函数/类定义补一行极简注释；
    代码外的自然语言只保留前两句简短说明，避免编造。
    :return: 完整文本（首行标题 + 空行 + 正文）
    """
    content = content or ""
    # re.split 带捕获组时：奇数段是围栏内代码，偶数段是普通文字
    parts = re.split(r"```[^\n]*\n?(.*?)```", content, flags=re.S)
    prose, blocks = [], []
    for i, seg in enumerate(parts):
        (blocks if i % 2 else prose).append(seg.strip())

    # 代码块补注释：Python 用 #，类 C/JS 用 //，依据块内特征猜测
    commented_blocks = []
    for code in blocks:
        out = []
        lang = "py" if re.search(r"^\s*(def |import |from |print\()", code, re.M) else "js"
        cmt = "#" if lang == "py" else "//"
        for line in code.split("\n"):
            m = re.match(r"^(def |class |function |(?:const|let|var)\s+)([一-鿿\w]*)",
                         line.strip())
            last = out[-1].strip() if out else ""
            # 上一行为空（或块首）且不是已有注释时，给定义补一行极简注释
            if m and (not out or last == "") and not last.startswith(cmt):
                out.append("%s %s" % (cmt, {"def": "函数", "class": "类",
                                            "function": "函数"}.get(
                    m.group(1).strip(), "逻辑块")))
            out.append(line)
        commented_blocks.append("\n".join(out).strip("\n"))

    # 代码外文字：按句切，取前两句作为简短说明
    prose_text = " ".join(p for p in prose if p)
    sentences = [s.strip() for s in re.split(r"[。！？\n]", prose_text) if len(s.strip()) >= 4]
    notes = sentences[:2] if sentences else ["代码逻辑已检查，补充了关键注释，原有功能保持不变。"]

    new_title = "💻 " + ((title or "代码笔记").strip()[:14])
    body = "\n".join("· " + s for s in notes)
    for cb in commented_blocks:
        body += "\n\n```\n" + cb + "\n```"
    return new_title + "\n\n" + body


def _light_clean_text(content, fallback=""):
    """
    轻量文字清理（日记 / 兜底通用类共用）：合并多余空白与空行、去掉句首口语填充词，
    不改写句子、不加任何结构，最大化保留原文语气。
    """
    body = (content or "").strip()
    body = re.sub(r"[ \t]{2,}", " ", body)
    body = re.sub(r"\n{3,}", "\n\n", body)
    fillers = ("那个，", "就是说，", "嗯，", "呃，", "额，")
    cleaned = []
    for line in body.split("\n"):
        s = line.strip()
        for f in fillers:
            if s.startswith(f):
                s = s[len(f):]
        cleaned.append(s)
    return "\n".join(cleaned).strip() or fallback


def _mock_sentences(content, min_len=4):
    """按标点/换行切句，去序号与空白，返回有意义的原句列表（不改写、不编造）。"""
    out = []
    for raw in re.split(r"[\n。！？!?；;]+", content or ""):
        s = raw.lstrip(" \t0123456789.、·•-–—*#①②③④⑤⑥⑦⑧⑨（）()").strip()
        if len(s) >= min_len:
            out.append(s)
    return out


def _dedupe_sentences(sentences, limit=None):
    """按开头 6 字去重（长文本常含重复表述），保留首次出现的句子。"""
    result, heads = [], set()
    for s in sentences:
        head = s[:6]
        if head in heads:
            continue
        heads.add(head)
        result.append(s)
        if limit and len(result) >= limit:
            break
    return result


def _trim_point(s, width):
    """单条要点过长时截断并补省略号，短于限制则原样保留。"""
    return s[:width] + "…" if len(s) > width else s


# 学习笔记中疑似「考点」的线索词（只用于从原句里挑重点，不生成套话）
_EXAM_KEYWORDS = ("考", "重点", "区别", "易错", "原理", "公式", "定义", "概念",
                  "对比", "必须", "注意", "掌握", "核心")


def build_study_mock(title, content):
    """
    学习笔记 mock：从原文句子里提炼「核心知识点」，再挑含考点线索词的句子作为
    「重点考点」。只做摘选与去重，行文沿用原句，不加“综上所述”等总结套话。
    :return: 完整文本（首行标题 + 空行 + 正文）
    """
    sents = _dedupe_sentences(_mock_sentences(content), limit=8)
    points = [_trim_point(s, 42) for s in sents[:5]]
    if not points:
        points = ["原文信息较少，建议补充更具体的知识点后再整理。"]
    # 考点：含线索词、且未与要点重复的句子，最多 3 条
    point_set = set(points)
    exam = [_trim_point(s, 42) for s in sents
            if any(k in s for k in _EXAM_KEYWORDS)]
    exam = [s for s in exam[:4] if s not in point_set][:3]

    body = "核心知识点：\n" + "\n".join(
        "%d. %s" % (i + 1, p) for i, p in enumerate(points))
    if exam:
        body += "\n\n重点考点：\n" + "\n".join("· %s" % s for s in exam)
    new_title = "📚 " + ((title or "学习笔记").strip()[:14])
    return new_title + "\n\n" + body


def build_long_mock(title, content):
    """
    长文本笔记 mock：切句去重后挑出核心要点，剔除重复冗余信息；
    要点全部来自原文，语言自然平实，不加固定总结话术与行动建议。
    :return: 完整文本（首行标题 + 空行 + 正文）
    """
    sents = _dedupe_sentences(_mock_sentences(content), limit=8)
    points = [_trim_point(s, 46) for s in sents[:6]]
    if not points:
        points = [_trim_point((title or "长文本笔记").strip(), 46)]
    body = "核心要点：\n" + "\n".join(
        "%d. %s" % (i + 1, p) for i, p in enumerate(points))
    new_title = "📄 " + ((title or "长文本笔记").strip()[:14])
    return new_title + "\n\n" + body


def build_diary_mock(title, content):
    """
    日记 mock：只做保守的文字清理（合并多余空白/换行、去掉句首口语填充词），
    不增加任何结构化标题，最大化保留原文情绪与口吻。
    :return: 完整文本（首行标题 + 空行 + 正文）
    """
    body = _light_clean_text(content, (title or "").strip())
    new_title = "📔 " + (((title or "").strip() or "随手记")[:14])
    return new_title + "\n\n" + body


def build_general_mock(title, content):
    """
    兜底通用 mock：与日记同样只做轻量清理，不套固定结构，保持原文风格。
    :return: 完整文本（首行标题 + 空行 + 正文）
    """
    body = _light_clean_text(content, (title or "").strip())
    new_title = "📝 " + (((title or "").strip() or "笔记")[:14])
    return new_title + "\n\n" + body


def build_mock_result(title, content, tag_hint, category):
    """
    按识别出的类型选择 mock 生成方式（去模板化：各类型输出对齐对应专属提示词的目标）。
    :return: (full_text, tag)
    """
    builders = {
        "code": build_code_mock,
        "study": build_study_mock,
        "diary": build_diary_mock,
        "long": build_long_mock,
        "general": build_general_mock,
    }
    builder = builders.get(category, build_general_mock)
    return builder(title, content), tag_hint


# ============================================================================
# 三-2、大模型流式调用（OpenAI 兼容 /chat/completions，stream=True）
# ============================================================================

def stream_from_llm(title, content, system_prompt):
    """
    第二层推理：用「按类型动态选中的系统提示词」调用大模型，逐块 yield 文本增量。
    :param system_prompt: CATEGORY_PROMPTS[category] + _FORMAT_SUFFIX
    :raises Exception: 建连失败 / 上游报错 / 整体超时 / 输出超长
    """
    url = LLM_BASE_URL.rstrip("/") + "/chat/completions"
    payload = {
        "model": LLM_MODEL,
        "stream": True,
        "temperature": 0.7,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "原标题：%s\n原文：%s" % (title, content)},
        ],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + LLM_API_KEY,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )

    deadline = time.monotonic() + LLM_TOTAL_DEADLINE
    total_len = 0
    # timeout 同时约束建连与每次 socket 读取（单次最长 30s），
    # 整体再用 deadline 封顶（LLM_TOTAL_DEADLINE 秒）
    with urllib.request.urlopen(req, timeout=max(LLM_CONNECT_TO, 30)) as resp:
        if resp.status != 200:
            raise Exception("AI 接口返回 HTTP %s" % resp.status)
        for raw_line in resp:
            # 两次读取之间检查整体截止时间
            if time.monotonic() > deadline:
                raise Exception("AI 生成超时（超过 %d 秒）" % LLM_TOTAL_DEADLINE)

            line = raw_line.decode("utf-8", errors="ignore").strip()
            if not line or not line.startswith("data:"):
                continue  # 忽略 SSE 注释行 / event 行 / 空行
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except Exception:
                continue  # 半包/异常包跳过
            # OpenAI 兼容协议：choices[0].delta.content
            try:
                piece = obj["choices"][0]["delta"].get("content") or ""
            except (KeyError, IndexError, TypeError):
                # 上游用 error 字段报错的情况
                if obj.get("error"):
                    raise Exception(str(obj["error"].get("message") or obj["error"]))
                continue
            if piece:
                total_len += len(piece)
                if total_len > MAX_OUTPUT_CHARS:
                    raise Exception("AI 输出超长（超过 %d 字），已中止" % MAX_OUTPUT_CHARS)
                yield piece


# ============================================================================
# 四、SSE 处理器 + 静态文件服务
# ============================================================================

# 常见静态文件 MIME（Windows 注册表有时缺 .js，这里显式给全，避免 MIME 嗅探问题）
_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".webp": "image/webp", ".woff2": "font/woff2", ".md": "text/plain; charset=utf-8",
    ".bat": "text/plain; charset=utf-8",
}

# 网站根目录 = 本文件所在目录的上一级（index.html 所在处）
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class MemoHandler(BaseHTTPRequestHandler):
    server_version = "CreamMemoSSE/1.0"

    # 关掉默认往控制台刷屏的访问日志，改为打印一行简洁中文日志
    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---------- 工具方法 ----------

    def _json_response(self, code, obj):
        """返回普通 JSON 响应（用于 400/403/健康检查等非 SSE 场景）"""
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _sse_headers(self):
        """
        SSE 三要素：正确的 Content-Type + 禁缓存 + 帧边界。
        这里显式 Connection: close：本服务是 HTTP/1.0 模型、不做 chunked 编码，
        生成结束关闭连接即通知客户端「流正常结束」，避免客户端傻等更多数据。
        X-Accel-Buffering: no 防止 Nginx 类代理攒包，保证逐字推送。
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

    def _sse_send(self, event):
        """
        推送一帧 SSE。客户端已关闭连接时 write 会抛异常，由上层捕获并中止生成。
        :param event: dict，自动序列化为 data: {...}\n\n
        """
        frame = "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
        self.wfile.write(frame.encode("utf-8"))
        self.wfile.flush()  # 必须立即 flush，否则浏览器攒包看不到打字机效果

    # ---------- GET：静态文件 + 健康检查 ----------

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/health":
            self._json_response(200, {"ok": True, "llm": bool(LLM_API_KEY)})
            return

        # 默认首页
        rel = urllib.parse.unquote(path.lstrip("/")) or "index.html"
        # 防目录穿越：规范化后必须仍在 WEB_ROOT 内
        full = os.path.normpath(os.path.join(WEB_ROOT, rel))
        if not full.startswith(WEB_ROOT + os.sep) and full != WEB_ROOT:
            self._json_response(403, {"error": "禁止访问"})
            return
        if not os.path.isfile(full):
            self._json_response(404, {"error": "文件不存在: %s" % rel})
            return

        ctype = _MIME.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self._json_response(500, {"error": "文件读取失败"})
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # HTML/JS/CSS 禁缓存，保证改完代码刷新立即生效
        if ctype.startswith(("text/", "application/javascript")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    # ---------- POST /api/polish：SSE 流式润色主流程 ----------

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/polish":
            self._json_response(404, {"error": "未知接口"})
            return

        # ① 解析请求体
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            self._json_response(400, {"error": "请求体不是合法 JSON"})
            return

        note_id = str(payload.get("noteId") or "").strip()
        username = str(payload.get("username") or "").strip()
        if not note_id or not username:
            self._json_response(400, {"error": "缺少 noteId 或 username"})
            return

        # ② 归属校验（在建立 SSE 之前完成，不合格直接 403，绝不进入 AI）
        try:
            note = verify_ownership(note_id, username)
        except Exception as e:
            self.log_message("归属校验失败 note=%s user=%s err=%s", note_id, username, e)
            self._json_response(403, {"code": "NO_ACCESS",
                                      "error": "笔记不存在、已被删除或无权访问"})
            return

        title = note.get("title") or ""
        content = note.get("content") or ""
        tag_hint = note.get("tag") or ""

        # ③ 原文超长拦截：在请求 AI 之前就挡下
        if len(title) + len(content) > MAX_INPUT_CHARS:
            self._sse_headers()
            self._sse_send({"type": "error", "stage": "too_long",
                            "message": "原文过长（超过 %d 字），请先精简原文" % MAX_INPUT_CHARS})
            return

        # ④ 建立 SSE 长连接，开始两层推理
        self._sse_headers()
        try:
            self._sse_send({"type": "start"})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return  # 建立瞬间就被客户端关掉了

        full_text = ""
        category = "general"
        try:
            # ---- 第一层：识别笔记类型 --------------------------------------
            self._sse_send({"type": "classifying"})
            if LLM_API_KEY:
                # 4a. 大模型分类；任何失败（超时/网络/解析不出）都降级为本地启发式，
                #     本地启发式保证必有结果，最差为 general，流程不中断
                try:
                    category = classify_with_llm(title, content) or classify_local(title, content)
                except Exception as ce:
                    self.log_message("大模型分类失败，降级本地识别 user=%s err=%s",
                                     username, ce)
                    category = classify_local(title, content)
            else:
                # 4b. 无密钥：本地识别，留 0.6s 让前端展示「正在识别类型…」
                time.sleep(0.6)
                category = classify_local(title, content)

            # 推送识别结果（前端显示类型 chip + 切换思考文案）
            self._sse_send({"type": "type",
                            "category": category,
                            "label": CATEGORY_LABELS.get(category, "普通笔记")})

            # ---- 第二层：按类型动态选择提示词，执行润色 --------------------
            if LLM_API_KEY:
                # 真实大模型：专属提示词 + 轻量格式约定，上游来一片立即转推一片
                system_prompt = CATEGORY_PROMPTS.get(category, CATEGORY_PROMPTS["general"]) \
                    + _FORMAT_SUFFIX
                for piece in stream_from_llm(title, content, system_prompt):
                    full_text += piece
                    self._sse_send({"type": "delta", "text": piece})
            else:
                # 内置引擎：按类型构造结果，再切片逐片推送，模拟打字机
                full_text, tag_hint = build_mock_result(
                    title, content, tag_hint, category)
                # “思考中”留白：给前端展示思考动画的时间
                time.sleep(0.8)
                self._mock_stream_text(full_text)

            # ⑤ 生成成功 → 拆出标题行与正文，校验非空
            lines = full_text.split("\n", 1)
            new_title = lines[0].strip() or title or "AI 润色笔记"
            new_content = lines[1].strip() if len(lines) > 1 else ""
            if not new_content:
                raise Exception("AI 生成内容为空")

            # ⑥ 新建一条独立笔记到 Bmob（原笔记保持不变）
            created = create_polished_note(new_title, new_content, username, tag_hint)

            # ⑦ 通知前端完成（带新笔记 ID 与识别类型）
            self._sse_send({"type": "done",
                            "objectId": created.get("objectId", ""),
                            "title": new_title,
                            "category": category,
                            "label": CATEGORY_LABELS.get(category, "普通笔记")})
            self.log_message("润色完成 user=%s 类型=%s 新笔记=%s 字数=%d",
                             username, category, created.get("objectId"), len(full_text))

        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # 用户点了「停止生成」/ 关了面板 → 不报错、不入库
            self.log_message("客户端中断 user=%s，未写入 Bmob", username)
        except Exception as e:
            self.log_message("AI 流式失败 user=%s err=%s", username, e)
            # 任何 AI / 入库失败都不产生脏数据：仅推送错误事件
            try:
                stage = "save" if "Bmob" in str(e) else "ai"
                self._sse_send({"type": "error", "stage": stage, "message": str(e)})
            except Exception:
                pass

    def _mock_stream_text(self, text):
        """
        把完整文本切成 2~4 字的小片顺序推送（含 emoji 按码点切，避免切坏）。
        每片之间短延迟，形成打字机节奏；客户端断开时异常向上抛，终止生成。
        """
        chars = list(text)  # 按 Unicode 码点拆分，emoji 不会被切成半个
        i = 0
        step = 2
        while i < len(chars):
            # 在 2~4 字之间变化，节奏更像真人打字
            n = step + (i % 3)
            piece = "".join(chars[i:i + n])
            self._sse_send({"type": "delta", "text": piece})
            i += n
            time.sleep(MOCK_CHUNK_DELAY)


class _ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True   # 端口释放后立即可重启，开发时方便
    daemon_threads = True        # 主进程退出时 SSE 长连接线程自动结束


def main():
    # Windows 控制台默认 GBK，统一切成 UTF-8，防止打印中文/emoji 报错
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    os.chdir(WEB_ROOT)
    server = _ReusableServer(("127.0.0.1", LISTEN_PORT), MemoHandler)
    print("=" * 60)
    print("  懒人备忘录 · AI SSE 流式服务已启动")
    print("  访问地址 : http://localhost:%d/index.html" % LISTEN_PORT)
    print("  网站根目录: %s" % WEB_ROOT)
    print("  AI 模式  : %s" % ("真实大模型（%s）" % LLM_MODEL if LLM_API_KEY
                              else "内置规则引擎（配置 LLM_API_KEY 可切换大模型）"))
    print("  按 Ctrl+C 停止服务")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
