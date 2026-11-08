#!/usr/bin/env node
// 验证 DeepSeek key 能不能用，以及这套提示词的效果。
//
// 用法：
//   DEEPSEEK_KEY=sk-xxx node tools/test-ai.mjs
//   DEEPSEEK_KEY=sk-xxx node tools/test-ai.mjs --full
//
// --full 会跑完整的三场景（主旨四步 → 判题型引导 → 主旨诊断），
// 能看到真实回复质量。默认只测连通。

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = process.env.DEEPSEEK_KEY || ''
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

if (!KEY) {
  console.error('没给 key。这样跑：\n  DEEPSEEK_KEY=sk-xxx node tools/test-ai.mjs')
  process.exit(1)
}

const papers = JSON.parse(await readFile(resolve(ROOT, 'data/papers.json'), 'utf8'))
const paper = papers[0]
const q = paper.questions[0]

async function call(messages, { maxTokens = 400, stream = false } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.6,
      stream,
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`)
  }
  const j = await res.json()
  return j?.choices?.[0]?.message?.content?.trim() || ''
}

const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')

const SYS_MAINIDEA = `你是一位考研英语阅读教练，正在教学生抓文章主旨。

抓主旨的方法（按这个顺序教）：
一、看首段和末段——作者把结论通常放这两处。
二、看每段第一句——段落主题句八成在第一句。
三、找转折词（but / however / yet / in fact / actually）——转折后面才是作者真意。
四、看态度词——作者是支持、批评、担忧还是中立。

你的任务：按上面四步，一步一步带学生做这篇。每次只教一步，教完问他一个问题。
不要一次说完四步。不要替他说出主旨。最多 3 句话。`

const SYS_COACH = `你是一位考研英语阅读教练，带一个目标 45-50 分的学生。

你的铁律：
1. 你只负责引导，绝不替他做题、绝不说出任何选项字母。
2. 一次只说一件事，最多 3 句话。学生要读得下去。
3. 先肯定他答对的部分，再指出缺口，最后给一个问题让他自己往下想。
4. 不说"要努力""多练练"这类空话。
5. 用中文，英文术语保留原词。
6. 不用 markdown 列表，就写自然的话。`

function hr(t) {
  console.log('\n' + '─'.repeat(56))
  console.log(t)
  console.log('─'.repeat(56))
}

async function main() {
  const full = process.argv.includes('--full')

  console.log(`接口: ${BASE}`)
  console.log(`模型: ${MODEL}`)
  console.log(`文章: ${paper.year} 阅读 ${paper.part}（${paper.paragraphs.length} 段）`)

  hr('① 连通')
  const t0 = Date.now()
  const pong = await call([{ role: 'user', content: '只回复两个字：通了' }], { maxTokens: 20 })
  console.log(`回复: ${pong}`)
  console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // 流式测试
  hr('② 流式')
  const t1 = Date.now()
  const sres = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '用一句话说什么是同义替换' }],
      max_tokens: 100,
      stream: true,
    }),
  })
  if (!sres.ok) throw new Error(`流式失败 HTTP ${sres.status}`)
  const rd = sres.body.getReader()
  const dec = new TextDecoder()
  let chunks = 0
  let text = ''
  let buf = ''
  while (true) {
    const { done, value } = await rd.read()
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
          chunks++
          text += d
        }
      } catch {}
    }
  }
  console.log(`收到 ${chunks} 个增量块，首字延迟 ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  console.log(`内容: ${text.slice(0, 120)}`)

  if (!full) {
    console.log('\n✅ 连通和流式都正常。加 --full 看完整场景效果。')
    return
  }

  hr('③ 主旨第 1 步（应该只教一步、只问一个问题）')
  const mi = await call(
    [
      { role: 'system', content: SYS_MAINIDEA },
      {
        role: 'user',
        content: `文章：\n\n${passage}\n\n这是第 1 步：看首段和末段。请根据这两段，问他这篇文章在谈什么对象／话题。`,
      },
    ],
    { maxTokens: 450 }
  )
  console.log(mi)
  const words = mi.length
  console.log(`\n[${words} 字] ${words > 260 ? '⚠️ 偏长，学生读不下去' : '✓ 长度合适'}`)

  hr('④ 做题引导（必须不给答案，不能出现 A/B/C/D 选项字母）')
  const options = ['A', 'B', 'C', 'D'].map((L) => `${L}. ${q.options[L]}`).join('\n')
  const guide = await call(
    [
      { role: 'system', content: SYS_COACH },
      {
        role: 'user',
        content: `文章：\n${passage}\n\n题目（第 ${q.num} 题）：${q.stem}\n\n选项：\n${options}\n\n他正在判断题型。别告诉他答案，引导他看题干动词和选项形态。`,
      },
      { role: 'user', content: '我的想法：这题问的好像是原因' },
    ],
    { maxTokens: 380 }
  )
  console.log(guide)

  const leaked = /(答案|正确选项|选)\s*[（(]?\s*[ABCD]\s*[)）]?/.test(guide)
  console.log(`\n${leaked ? '❌ 疑似泄露答案字母' : '✓ 没提选项字母'}`)

  hr('⑤ 主旨诊断（应指出缺口，但不给范文）')
  const judge = await call(
    [
      { role: 'system', content: SYS_COACH },
      {
        role: 'user',
        content: `文章：\n${passage}\n\n学生写的主旨：「自动化让中产受损，政策没跟上」

请判断三件事，一次说完：
1. 他抓到的核心是什么？对不对？（对就说对在哪）
2. 他漏了什么？指到具体第几段。
3. 如果他偏了，问题出在哪一步（只看了局部／被某个例子带跑／把例子当主旨／态度读反了）。

不要写一段正确的范文给他抄。最多 4 句话。`,
      },
    ],
    { maxTokens: 400 }
  )
  console.log(judge)

  hr('汇总')
  console.log('以上四段就是你在 App 里会看到的真实效果。')
  console.log('如果哪段话太多、太像老师念稿、或者透露了答案，告诉我，我改提示词。')
}

main().catch((e) => {
  console.error('\n❌ 失败:', e.message)
  process.exit(1)
})
