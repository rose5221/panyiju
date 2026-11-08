/* AI 教练层
 *
 * 安全设计（改代码前必读）：
 *   引导模式下，**绝不把答案发给模型**。请求体里没有 answer 字段，
 *   所以模型物理上不可能泄露答案。这不是靠提示词约束，是靠数据结构。
 *   只有复盘阶段（答案已公开）才把 answer 传进去。
 *
 * 配置存 localStorage，只在你自己的浏览器里，不上传任何服务器。
 */

'use strict'

const AI_CONFIG_KEY = 'panyiju.ai.v1'

const AI_DEFAULT = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.5,
}

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

/* ────────────────────────────────────────────────────────────
   核心请求（支持流式，打字机效果）
   ──────────────────────────────────────────────────────────── */

async function aiChat(messages, onDelta, opts = {}) {
  const cfg = loadAIConfig()
  if (!cfg.apiKey) throw new Error('还没填 API Key')

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? 700,
    stream: !!onDelta,
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 60000)

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
    if (e.name === 'AbortError') throw new Error('请求超时（60 秒）')
    throw new Error('连不上接口：' + e.message + '（可能是 CORS 或地址填错）')
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
    throw new Error(`接口返回 ${res.status}：${detail}`)
  }

  // 非流式
  if (!onDelta) {
    clearTimeout(timer)
    const j = await res.json()
    return j?.choices?.[0]?.message?.content?.trim() || ''
  }

  // 流式
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
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
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

/* ────────────────────────────────────────────────────────────
   提示词
   ──────────────────────────────────────────────────────────── */

const SYS_COACH = `你是一位考研英语阅读教练，带一个目标 45-50 分的学生。

你的铁律：
1. 你只负责引导，绝不替他做题、绝不说出任何选项字母。
2. 一次只说一件事，最多 3 句话。学生要读得下去。
3. 先肯定他答对的部分，再指出缺口，最后给一个问题让他自己往下想。
4. 不说"要努力""多练练"这类空话。
5. 用中文，英文术语保留原词。
6. 不用 markdown 列表，就写自然的话。`

const SYS_MAINIDEA = `你是一位考研英语阅读教练，正在教学生抓文章主旨。

抓主旨的方法（按这个顺序教）：
一、看首段和末段——作者把结论通常放这两处。
二、看每段第一句——段落主题句八成在第一句。
三、找转折词（but / however / yet / in fact / actually）——转折后面才是作者真意。
四、看态度词——作者是支持、批评、担忧还是中立。

你的任务：按上面四步，一步一步带学生做这篇。每次只教一步，教完问他一个问题。
不要一次说完四步。不要替他说出主旨。最多 3 句话。`

/* ────────────────────────────────────────────────────────────
   场景一：教找主旨（分步）
   ──────────────────────────────────────────────────────────── */

/**
 * @param {object} paper   当前文章
 * @param {number} step    第几步（1-4）
 * @param {string} said    学生这一步说的话
 * @param {Array}  history 之前的对话
 */
async function aiTeachMainIdea(paper, step, said, history = [], onDelta) {
  const passage = paper.paragraphs
    .map((p) => `[P${p.n}] ${p.text}`)
    .join('\n\n')

  const stepTask = [
    '',
    '这是第 1 步：看首段和末段。请根据这两段，问他这篇文章在谈什么对象／话题。',
    '这是第 2 步：看每段第一句。请让他用一句话概括每段在干什么（不用全部写完，挑 3 段就行）。',
    '这是第 3 步：找转折词。请让他在原文里找出所有 but / however / yet / in fact，然后说说转折后面讲了什么。',
    '这是第 4 步：看态度。请让他判断作者对这个话题是支持、批评、担忧还是中立，并给出理由。',
  ][step]

  const messages = [
    { role: 'system', content: SYS_MAINIDEA },
    {
      role: 'user',
      content: `文章（${paper.year} 英语一阅读 ${paper.part}）：\n\n${passage}\n\n${stepTask}`,
    },
    ...history.slice(-6),
  ]

  if (said) {
    messages.push({ role: 'user', content: `我的回答：${said}` })
  }

  return aiChat(messages, onDelta, { maxTokens: 450 })
}

/**
 * 最后一步：评估他写的主旨，只诊断，不给范文
 */
async function aiJudgeMainIdea(paper, idea, onDelta) {
  const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')

  const messages = [
    { role: 'system', content: SYS_COACH },
    {
      role: 'user',
      content: `文章：\n${passage}\n\n学生写的主旨：「${idea}」

请判断三件事，一次说完：
1. 他抓到的核心是什么？对不对？（对就说对在哪）
2. 他漏了什么？指到具体第几段。
3. 如果他偏了，问题出在哪一步（只看了局部／被某个例子带跑／把例子当主旨／态度读反了）。

不要写一段正确的范文给他抄。最多 4 句话。`,
    },
  ]
  return aiChat(messages, onDelta, { maxTokens: 400 })
}

/* ────────────────────────────────────────────────────────────
   场景二：做题时引导
   ⚠️ 这里构造的请求体里没有 answer 字段，模型拿不到答案。
   ──────────────────────────────────────────────────────────── */

async function aiGuideQuestion(paper, q, gate, said, history = [], onDelta) {
  const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')

  // 故意不传 q.answer / q.distractors / q.pairs
  const options = ['A', 'B', 'C', 'D']
    .map((L) => `${L}. ${q.options[L]}`)
    .join('\n')

  const gateTask =
    gate === 1
      ? '他正在判断题型。别告诉他答案，引导他看题干动词和选项形态。'
      : gate === 2
      ? '他正在定位。别告诉他第几段，引导他从题干关键词去原文找。'
      : '他正在选答案。别告诉他哪个对。引导他把定位句改写成大白话，再逐项比对。'

  const messages = [
    { role: 'system', content: SYS_COACH },
    {
      role: 'user',
      content: `文章：\n${passage}\n\n题目（第 ${q.num} 题）：${q.stem}\n\n选项：\n${options}\n\n${gateTask}`,
    },
    ...history.slice(-6),
  ]

  if (said) messages.push({ role: 'user', content: `我的想法：${said}` })

  return aiChat(messages, onDelta, { maxTokens: 380 })
}

/* ────────────────────────────────────────────────────────────
   连通性测试
   ──────────────────────────────────────────────────────────── */

async function aiPing() {
  const r = await aiChat(
    [{ role: 'user', content: '只回复两个字：通了' }],
    null,
    { maxTokens: 20, timeout: 20000 }
  )
  return r
}
