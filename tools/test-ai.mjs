#!/usr/bin/env node
// 验证 DeepSeek key + 这套提示词的真实效果。
//
//   DEEPSEEK_KEY=sk-xxx node tools/test-ai.mjs --full
//
// --full 会跑四个真实场景，打出 AI 的原文。

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = process.env.DEEPSEEK_KEY || ''
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

if (!KEY) {
  console.error('用法：DEEPSEEK_KEY=sk-xxx node tools/test-ai.mjs --full')
  process.exit(1)
}

const papers = JSON.parse(await readFile(resolve(ROOT, 'data/papers.json'), 'utf8'))
const paper = papers.find((p) => p.questions.every((q) => q.locate)) || papers[0]
const q = paper.questions[0]
const passage = paper.paragraphs.map((p) => `[P${p.n}] ${p.text}`).join('\n\n')

async function call(messages, maxTokens = 2000) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.5 }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const ch = j?.choices?.[0]
  const txt = ch?.message?.content?.trim() || ''
  const reason = j?.usage?.completion_tokens_details?.reasoning_tokens || 0
  if (ch?.finish_reason === 'length') {
    console.log(`  ⚠️ 被截断（思考用掉 ${reason} token）`)
  } else if (!txt) {
    console.log(`  ⚠️ 空回复（思考用掉 ${reason} token）`)
  }
  return txt
}

const hr = (t) => {
  console.log('\n' + '═'.repeat(58))
  console.log(t)
  console.log('═'.repeat(58))
}

async function main() {
  const full = process.argv.includes('--full')
  console.log(`接口 ${BASE} / 模型 ${MODEL}`)
  console.log(`样例：${paper.year} 阅读 ${paper.part}，第 ${q.num} 题`)

  hr('① 连通')
  const t0 = Date.now()
  const pong = await call([{ role: 'user', content: '回复两个字：通了' }], 300)
  console.log(`${pong}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  if (!full) {
    console.log('\n加 --full 看四个场景的真实效果。')
    return
  }

  // ① 只看题干猜话题
  hr('② 只看题干猜话题（不能编造文章内容）')
  const stems = paper.questions.map((x) => `${x.num}. ${x.stem}`).join('\n')
  const r2 = await call([
    {
      role: 'system',
      content:
        '你是考研英语阅读教练。现在是"只看题干猜主旨"阶段，你手里只有题干，没有文章，绝对不要假装知道文章内容，也不要编造具体细节。一次最多 3 句话。用中文自然段落。',
    },
    {
      role: 'user',
      content: `5 个题干：\n\n${stems}\n\n这是第 1 步。让学生看重复名词，说出文章大概在讨论什么话题。问他一个问题就好。`,
    },
  ])
  console.log(r2)
  console.log(`\n[${r2.length} 字] ${r2.length > 240 ? '⚠️ 偏长' : '✓ 长度合适'}`)

  // ② 追问理由（不给答案）
  hr('③ 学生说理由，AI 追问（必须不泄露答案字母）')
  const options = ['A', 'B', 'C', 'D'].map((L) => `${L}. ${q.options[L]}`).join('\n')
  const r3 = await call([
    {
      role: 'system',
      content:
        '你是考研英语阅读教练。学生刚选了一个选项并给出理由。你不知道正确答案，也不要猜哪个对。你只检查他的理由是否站得住——他引的依据在原文里真的支持这个选项吗？有没有跳步、有没有把例子当观点。指出具体问题后，问他一个能让他自己发现问题的问题。最多 3 句话。用中文自然段落。',
    },
    {
      role: 'user',
      content: `文章：\n${passage}\n\n题目（第 ${q.num} 题）：${q.stem}\n\n选项：\n${options}\n\n学生选了 ${q.answer}。他的理由：「我觉得这段话说的是同一个意思，所以选这个」\n\n请判断：他的理由和他在原文找到的依据之间，链条完整吗？哪一步是跳过去的？`,
    },
  ])
  console.log(r3)
  const leaked = /(正确(答案|选项)是|答案(是|为)|应该选)\s*[（(]?\s*[ABCD]/.test(r3)
  console.log(`\n${leaked ? '❌ 疑似泄露答案' : '✓ 没泄露答案'}`)

  // ③ 深度复盘（这是重点）
  hr('④ 深度复盘：拆出题人的坑（不能流水账）')
  const optsTagged = ['A', 'B', 'C', 'D']
    .map((L) => {
      const tag = L === q.answer ? '【正确答案】' : `【坑：${q.distractors[L] || '未知'}】`
      return `${L}. ${q.options[L]}  ${tag}`
    })
    .join('\n')
  const pairs = (q.pairs || []).map((p) => `原文「${p.orig}」＝选项「${p.opt}」`).join('\n')
  const r4 = await call(
    [
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
        content: `文章：\n${passage}\n\n题目（第 ${q.num} 题，${q.qtype}）：${q.stem}\n\n选项（已标注出题人的坑）：\n${optsTagged}\n\n正确答案：${q.answer}\n\n依据句：第 ${q.locate.para} 段：「${q.locate.text}」\n\n官方替换对：\n${pairs || '（无）'}\n\n学生选了一个错误项，他给的理由是：「这段提到的东西和这个选项差不多」

请做这件事：
第一段，写正确答案为什么对，把替换链一步步摆出来。
第二段，逐个说错误选项的坑——出题人对原文做了什么手脚，这个坑专骗哪种思路。
第三段，直接说学生的理由错在哪一步：他如果是因为误读了哪个词、或者跳过了哪一步才选错的。

不要写"希望你继续努力"这类结尾。`,
      },
    ],
    3000
  )
  console.log(r4)
  console.log(`\n[${r4.length} 字]`)

  const checks = [
    ['提到了替换链/原文具体词', /(替换|原文.{0,10}「|＝|↔)/.test(r4)],
    ['逐个说到错误选项', ['A', 'B', 'C', 'D'].filter((L) => r4.includes(L + '.') || r4.includes(L + '项')).length >= 2],
    ['没有空话', !/(多练|加油|继续努力|相信自己)/.test(r4)],
    ['不是纯复述标签', !/^(A 项无中生有。B 项)/.test(r4)],
  ]
  console.log('\n自检：')
  checks.forEach(([n, v]) => console.log((v ? '✓ ' : '⚠️ ') + n))

  hr('⑤ 追问一个选项')
  const r5 = await call(
    [
      {
        role: 'system',
        content:
          '你是考研英语阅读阅卷老师，学生正在追问一个选项。回答要具体、贴着原文，不要泛泛而谈。不许说"多读几遍就懂了"。用中文自然段落，最多 300 字。',
      },
      {
        role: 'user',
        content: `文章：\n${passage}\n\n题目：${q.stem}\n\n选项 A：${q.options.A}（${q.answer === 'A' ? '正确答案' : q.distractors.A || '错误'}）\n正确答案是 ${q.answer}。\n\n学生问：「我就是觉得 A 也对啊，原文哪里排除了它？」`,
      },
    ],
    2000
  )
  console.log(r5)

  hr('汇总')
  console.log('以上五段就是你在 App 里会看到的真实效果。')
  console.log('哪段啰嗦、哪段像流水账、哪段泄露了答案，告诉我，我改提示词。')
}

main().catch((e) => {
  console.error('\n❌', e.message)
  process.exit(1)
})
