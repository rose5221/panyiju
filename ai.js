/* AI 教练层 v2
 *
 * 三个阶段的铁律：
 *   ① 预测/阅读/作答阶段：模型拿不到答案（请求里没有 answer 字段）
 *   ② 作答后说理由阶段：模型仍然拿不到答案，只能追问思路
 *   ③ 交卷复盘阶段：答案已公开，模型拿到全部数据做深度拆解
 *
 * 这个边界靠数据结构保证，不靠提示词。
 */

'use strict'

const AI_CONFIG_KEY = 'panyiju.ai.v2'

// 默认接 DeepSeek。实测它允许浏览器跨域直连，Key 完全留本地。
const AI_DEFAULT = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 0.6,
}

const AI_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    note: '国内直连快，支持浏览器调用',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    note: '需要能访问 openai.com',
  },
]

function loadAIConfig() {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY)
    if (raw) return { ...AI_DEFAULT, ...JSON.parse(raw) }
  } catch (e) {}
  return { ...AI_DEFAULT }
}

function saveAIConfig(cfg) {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg))
  } catch (e) {}
}

function aiReady() {
  const c = loadAIConfig()
  return !!(c.enabled && c.apiKey && c.baseUrl && c.model)
}

/* ── 请求 ─────────────────────────────────────────────── */

async function aiChat(messages, onDelta, opts = {}) {
  const cfg = loadAIConfig()
  if (!cfg.apiKey) throw new Error('还没填 API Key')

  let base = (cfg.baseUrl || '').trim().replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'

  const body = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? 2000,
    stream: !!onDelta,
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 90000)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new Error('请求超时')
    throw new Error('连不上接口：' + e.message)
  }

  if (!res.ok) {
    clearTimeout(timer)
    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || JSON.stringify(j).slice(0, 200)
    } catch {
      detail = await res.text().catch(() => '')
    }
    throw new Error(friendlyError(res.status, detail))
  }

  // 非流式：检查 finish_reason，别把截断当成功。
  // deepseek-flash 是推理模型，会先花几百 token 内部思考，额度不够就返回空。
  if (!onDelta) {
    clearTimeout(timer)
    const j = await res.json()
    const ch = j?.choices?.[0]
    const text = ch?.message?.content?.trim() || ''
    const reasoning = j?.usage?.completion_tokens_details?.reasoning_tokens || 0

    if (ch?.finish_reason === 'length') {
      throw new Error(
        `回复被截断（模型思考用掉 ${reasoning} token，额度不够）。把问题问得具体一点，或换 deepseek-v4-pro 再试。`
      )
    }
    if (!text) {
      throw new Error(
        reasoning > 0
          ? `模型把额度全用在推理上了（${reasoning} token），没产出正文。再试一次，或换 deepseek-v4-pro。`
          : '接口返回了空内容，再试一次。'
      )
    }
    return text
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const pl = t.slice(5).trim()
        if (pl === '[DONE]') continue
        try {
          const j = JSON.parse(pl)
          const d = j?.choices?.[0]?.delta?.content
          if (d) {
            full += d
            onDelta(d, full)
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return full.trim()
}

function friendlyError(status, detail) {
  const d = (detail || '').toLowerCase()
  if (status === 401 || d.includes('authentication') || d.includes('invalid api key'))
    return 'Key 不对。检查是否复制完整（sk- 开头那一整串）。'
  if (status === 402 || d.includes('insufficient balance'))
    return '账户余额不够了。去 DeepSeek 后台充值。'
  if (status === 429 || d.includes('rate limit')) return '请求太频繁，等十几秒再试。'
  if (status === 404 || d.includes('model not found'))
    return '模型名不对。可用 deepseek-flash 或 deepseek-v4-pro。'
  if (status >= 500) return `对方服务器出错（${status}），稍后再试。`
  return `接口返回 ${status}：${detail}`
}

/* ── 通用人格 ─────────────────────────────────────────── */

const SYS_COACH = `你是考研英语阅读教练，带一个目标 45-50 分的学生。你的风格像老练的阅卷老师，话直接、不客套。

铁律：
1. 作答阶段你只引导，绝不说出任何选项字母，绝不说"选 X 对"。
2. 一次只说一件事，最多 3 句话。
3. 学生说错了不要安慰式开场，直接指出缺口在哪，再给一个问题。
4. 不说"要努力""多练练"这类空话。
5. 用中文，英文术语保留原词。
6. 不用 markdown 列表符号，用自然段落。`

/* ══════════════════════════════════════════════════════
   阶段一：只看题干，预测文章讲什么
   ══════════════════════════════════════════════════════ */

/**
 * 用 5 个题干推断话题。这是"先看题再读文"的关键一步。
 * 注意：不传选项内容，不传答案，只传题干。
 */
async function aiPredictTopic(paper, step, said, history = [], onDelta) {
  const stems = paper.questions.map((q) => `${q.num}. ${q.stem}`).join('\n')

  const stepTask = [
    '',
    '这是第 1 步。让学生看这 5 个题干里的重复名词和专有名词，说出这篇文章大概在讨论什么话题。问他一个问题就好。',
    '这是第 2 步。让学生从题干里找"作者态度"的线索（问 opinion / attitude / author believes 的题），推断作者倾向。问他一个问题。',
    '这是第 3 步。让学生把这 5 个题干串成一句话：这篇文章按什么顺序展开（现象→原因→对策？还是观点→反驳？）。问他一个问题。',
  ][step]

  const messages = [
    {
      role: 'system',
      content:
        SYS_COACH +
        '\n现在是"只看题干猜主旨"阶段。你手里只有题干，没有文章，绝对不要假装知道文章内容，也不要编造具体细节。',
    },
    {
      role: 'user',
      content: `这是一篇考研英语一阅读的 5 个题干（${paper.year} 年，第 ${paper.part} 篇）：\n\n${stems}\n\n${stepTask}`,
    },
    ...history.slice(-6),
  ]
  if (said) messages.push({ role: 'user', content: `我的回答：${said}` })

  return aiChat(messages, onDelta, { maxTokens: 1200 })
}

/** 学生写完"猜的主旨"后，让他先说，AI 只做诊断，不给答案（因为文章还没读） */
async function aiJudgeGuess(paper, guess, onDelta) {
  const stems = paper.questions.map((q) => `${q.num}. ${q.stem}`).join('\n')
  const messages = [
    {
      role: 'system',
      content:
        SYS_COACH +
        '\n学生还没读文章，只看了题干就猜了主旨。你要判断这个猜测是否从题干里合理推得，而不是判断它对不对——你也不知道对不对。',
    },
    {
      role: 'user',
      content: `题干：\n${stems}\n\n学生从题干推测的主旨：「${guess}」\n\n请说两件事：一、他这个推测是从题干里的哪些词推出来的（指出来）。二、读文章时他该重点验证什么。不超过 3 句话。`,
    },
  ]
  return aiChat(messages, onDelta, { maxTokens: 1200 })
}

/* ══════════════════════════════════════════════════════
   阶段二：作答后说理由，AI 追问
   ⚠️ 这里绝不传 answer / distractors / pairs
   ══════════════════════════════════════════════════════ */

async function aiChallengeReason(paper, q, picked, reason, history = [], onDelta) {
  const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')
  const options = ['A', 'B', 'C', 'D'].map((L) => `${L}. ${q.options[L]}`).join('\n')

  const messages = [
    {
      role: 'system',
      content:
        SYS_COACH +
        '\n学生刚选了一个选项并给出了理由。你不知道正确答案，也不要猜哪个对。你只做一件事：检查他的理由是否站得住——他引的依据在原文里真的支持这个选项吗？有没有跳步、有没有把例子当观点。指出具体问题后，问他一个能让他自己发现问题的问题。',
    },
    {
      role: 'user',
      content: `文章：\n${passage}\n\n题目（第 ${q.num} 题）：${q.stem}\n\n选项：\n${options}\n\n学生选了 ${picked}。他的理由：「${reason}」\n\n请判断：他的理由和他在原文找到的依据之间，链条完整吗？哪一步是跳过去的？最多说 3 句话，最后留一个问题给他。`,
    },
    ...history.slice(-4),
  ]
  return aiChat(messages, onDelta, { maxTokens: 1400 })
}

/* ══════════════════════════════════════════════════════
   阶段三：交卷后深度复盘（答案已公开，可以全给）
   ══════════════════════════════════════════════════════ */

/**
 * 单题深度拆解：出题人怎么挖坑。
 * @param {object} q      完整题（含 answer / distractors / pairs / locate）
 * @param {object} ans    学生作答 { letter, reason }
 */
async function aiDeepAnalyze(paper, q, ans, onDelta) {
  const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')
  const options = ['A', 'B', 'C', 'D']
    .map((L) => {
      const tag = L === q.answer ? '【正确答案】' : `【出题人的坑：${q.distractors[L] || '未知'}】`
      return `${L}. ${q.options[L]}  ${tag}`
    })
    .join('\n')

  const pairs = (q.pairs || [])
    .map((p) => `原文「${p.orig}」＝选项「${p.opt}」`)
    .join('\n')
  const locate = q.locate
    ? `第 ${q.locate.para} 段：「${q.locate.text}」`
    : '（本题为主旨/态度题，依据贯穿全文）'

  const studentPick = ans?.letter || '未作答'
  const studentReason = ans?.reason || '（没写理由）'

  const messages = [
    {
      role: 'system',
      content: `你是考研英语一阅读的阅卷老师，正在给一个 45 分目标的学生做逐题复盘。

你的输出必须像"手术刀"，不能像流水账。禁止这样写：
- "A 项无中生有"然后只给一句通用解释
- 复述选项原文
- 说"注意定位""多练"这类空话

必须做到：
1. 每个错误选项，说清出题人动了原文的哪个词、改成了什么样、专门骗哪类考生。
2. 正确选项，给出完整的替换链：原文哪句 → 换成了选项里哪几个词。
3. 最后判断学生的理由错在哪一步，具体到"他以为 X，其实原文是 Y"。

用中文，自然段落，不要 markdown 列表符号。总长度控制在 400 字内，但每句都要有信息量。`,
    },
    {
      role: 'user',
      content: `文章：\n${passage}\n\n题目（第 ${q.num} 题，${q.qtype}）：${q.stem}\n\n选项（已标注出题人的坑）：\n${options}\n\n正确答案：${q.answer}\n\n依据句：${locate}\n\n官方替换对：\n${pairs || '（无）'}\n\n学生选了 ${studentPick}，他给的理由是：「${studentReason}」

请做这件事：
第一段，写正确答案为什么对，把替换链一步步摆出来。
第二段，逐个说错误选项的坑——出题人对原文做了什么手脚，这个坑专骗哪种思路。
第三段，直接说学生的理由错在哪一步：他如果是因为误读了哪个词、或者跳过了哪一步才选错的。

不要写"希望你继续努力"这类结尾。`,
    },
  ]
  return aiChat(messages, onDelta, { maxTokens: 3000, temperature: 0.4 })
}

/** 学生追问某个选项：只针对一个选项往深里说 */
async function aiAskAboutOption(paper, q, letter, question, history = [], onDelta) {
  const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')
  const isRight = letter === q.answer
  const flag = isRight ? '正确答案' : q.distractors[letter] || '错误选项'

  const messages = [
    {
      role: 'system',
      content: `你是考研英语阅读阅卷老师，学生正在追问一个选项。回答要具体、贴着原文，不要泛泛而谈。不许说"多读几遍就懂了"。用中文自然段落，最多 300 字。`,
    },
    {
      role: 'user',
      content: `文章：\n${passage}\n\n题目（第 ${q.num} 题）：${q.stem}\n\n选项 ${letter}：${q.options[letter]}（${flag}）\n正确答案是 ${q.answer}。\n\n学生问：「${question}」`,
    },
    ...history.slice(-6),
  ]
  return aiChat(messages, onDelta, { maxTokens: 2000, temperature: 0.4 })
}

/** 整篇总结：这 5 题暴露了什么共性问题 */
async function aiPaperSummary(paper, records, onDelta) {
  const lines = paper.questions
    .map((q, i) => {
      const a = records[i]
      if (!a) return ''
      return `第 ${q.num} 题（${q.qtype}）：学生选 ${a.letter}，答案 ${q.answer}，${a.ok ? '对' : '错'}。他的理由：「${a.reason || '没写'}」`
    })
    .filter(Boolean)
    .join('\n')

  const messages = [
    {
      role: 'system',
      content: `你是阅卷老师，正在做一个整体诊断。你要找出这个学生反复犯的同一个错误，而不是把 5 题各说一遍。用中文自然段落，最多 250 字。`,
    },
    {
      role: 'user',
      content: `这篇（${paper.year} 年英语一阅读 ${paper.part}，共 5 题）：\n\n${lines}\n\n请回答：他在这 5 题里反复出现的思维习惯问题是什么？举出第几题和第几题是同一个毛病。给一句可执行的改法。`,
    },
  ]
  return aiChat(messages, onDelta, { maxTokens: 2000, temperature: 0.4 })
}

/* ── 连通测试 ─────────────────────────────────────────── */

// 连通测试。deepseek-flash 是推理模型，光思考就要几十 token，
// 所以这里给 300 而不是 20——否则会误报"没通"。
async function aiPing() {
  return aiChat(
    [
      {
        role: 'system',
        content: '你只需要回答。不要解释，不要思考过程，直接给结果。',
      },
      { role: 'user', content: '回复两个字：通了' },
    ],
    null,
    { maxTokens: 300, timeout: 30000, temperature: 0 }
  )
}
