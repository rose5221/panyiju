#!/usr/bin/env node
// 把 cache/raw/ 的 56 个页面解析成 data/papers.json，并输出校验报告。
//
// 只提取「结构化事实」：原文段落、题干、选项、答案、题型、干扰项类型、替换对、定位偏移。
// 不收录站方的成段中文解析（那是别人的原创内容），错因提示由本站模板自生成。
//
// 用法：node tools/parse.mjs

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = resolve(ROOT, 'cache/raw')
const OUT = resolve(ROOT, 'data')

// ── 小工具 ────────────────────────────────────────────────
const stripTags = (s) => s.replace(/<[^>]+>/g, '')
const decode = (s) =>
  stripTags(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
const clean = (s) => decode(s).replace(/\s+/g, ' ').trim()
const dropCid = (s) => s.replace(/ data-(?:astro-)?[a-z0-9-]+="[^"]*"/g, '')

// 官方 7 类干扰项；长尾写法归并到最近的一类
const FLAG_CANON = [
  ['无中生有', '无中生有'],
  ['与原文相反', '与原文相反'],
  ['偷换概念', '偷换概念'],
  ['过度推断', '过度推断'],
  ['张冠李戴', '张冠李戴'],
  ['以偏概全', '以偏概全'],
  ['答非所问', '答非所问'],
]
const canonFlag = (raw) => {
  const t = raw.trim()
  for (const [needle, out] of FLAG_CANON) if (t.includes(needle)) return out
  // 归并长尾：伪装因果 → 偷换概念；程度偷改 → 过度推断；情感跑偏 → 与原文相反
  if (t.includes('原因')) return '偷换概念'
  if (t.includes('程度')) return '过度推断'
  if (t.includes('情感')) return '与原文相反'
  return null
}

// ── 解析页面内嵌 JSON（定位偏移的权威来源）────────────────
function readIsland(html) {
  const m = html.match(
    /<script type="application\/json" data-pdh-data>([\s\S]*?)<\/script>/
  )
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

// ── 解析文章页：段落 ──────────────────────────────────────
function parseParagraphs(html) {
  const out = []
  const re = /id="para-(\d+)"/g
  let m
  while ((m = re.exec(html))) {
    const n = Number(m[1])
    const seg = html.slice(m.index, m.index + 90000)
    const p = seg.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    if (p) out.push({ n, text: clean(p[1]) })
  }
  // 去重保序
  const seen = new Set()
  return out.filter((p) => (seen.has(p.n) ? false : (seen.add(p.n), true)))
}

// ── 解析题目解析页：题目 + 选项 + 答案 + 标签 + 替换对 ──────
function parseQuestions(html) {
  const blocks = []
  const re = /<div id="q-(\d+)"[^>]*class="lqp-unit"[\s\S]*?(?=<div id="q-\d+"[^>]*class="lqp-unit"|<\/section>|<footer)/g
  let m
  while ((m = re.exec(html))) blocks.push({ num: Number(m[1]), html: m[0] })

  return blocks.map(({ num, html: b }) => {
    // 英文题干（data-pdh-stem 更干净）
    let stem = ''
    const sm = b.match(/data-pdh-stem[^>]*>([\s\S]*?)<\/span>/)
    if (sm) stem = clean(sm[1])
    if (!stem) {
      const sm2 = b.match(/id="qp-\d+"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>\s*<div/)
      if (sm2) stem = clean(sm2[1]).replace(/^\d+\.\s*/, '')
    }

    // 英文选项
    const options = {}
    const optRe = /data-pdh-letter="([A-D])"[^>]*>([\s\S]*?)<\/span>/g
    let om
    while ((om = optRe.exec(b))) options[om[1]] = clean(om[2])

    // 答案 + 题型
    const am = b.match(/<strong class="rp-ans"[^>]*>([A-D])<\/strong>\s*<span class="rp-qtype"[^>]*>（([^）]+)）<\/span>/)
    const answer = am ? am[1] : null
    const qtype = am ? am[2].trim() : null

    // 每个选项的判定：ok / bad + 标签 + 替换对
    const verdicts = {}
    const vRe = /<li class="(is-ok|is-bad) rp-verdict"[\s\S]*?(?=<li class="(?:is-ok|is-bad) rp-verdict"|<\/ul>\s*<\/li>|<\/div>\s*<\/div>\s*<\/div>)/g
    let vm
    while ((vm = vRe.exec(b))) {
      const chunk = vm[0]
      const lm = chunk.match(/rp-verdict-letter"[^>]*>([A-D])\)/)
      if (!lm) continue
      const letter = lm[1]
      const fm = chunk.match(/rp-flag[^>]*>([^<]+)</)
      const rawFlag = fm ? fm[1].trim() : ''
      const isOk = vm[1] === 'is-ok' || rawFlag.includes('✓')
      const pairs = []
      const pRe = /rp-pair-orig"[^>]*>([\s\S]*?)<\/span>[\s\S]*?rp-pair-opt"[^>]*>([\s\S]*?)<\/span>/g
      let pm
      while ((pm = pRe.exec(chunk))) {
        pairs.push({ orig: clean(pm[1]), opt: clean(pm[2]) })
      }
      verdicts[letter] = {
        ok: isOk,
        rawFlag: isOk ? null : rawFlag,
        flag: isOk ? null : canonFlag(rawFlag),
        pairs,
      }
    }

    return { num, stem, options, answer, qtype, verdicts }
  })
}

// ── 定位句：用内嵌 JSON 的段落偏移切原文 ───────────────────
function locate(island, paragraphs) {
  if (!island?.ques) return null
  const map = new Map(paragraphs.map((p) => [p.n, p.text]))
  const out = {}
  for (const [q, v] of Object.entries(island.ques)) {
    const loc = (v.g || []).find((g) => g.t === 'loc')
    if (!loc?.r?.length) continue
    const { p, s, e } = loc.r[0]
    const text = map.get(p)
    if (typeof text !== 'string') continue
    // 越界就退到整段，不硬切
    const slice = e <= text.length ? text.slice(s, e) : text
    out[q] = { para: p, start: s, end: e, text: slice.trim(), exact: e <= text.length }
  }
  return out
}

// ── 兜底定位：用正确项的替换对原文片段反查所在段与所在句 ────
// 只对「本该有定位句却没给」的细节/推断题用；主旨/态度题不兜底。
const NEEDS_LOCATE = new Set(['细节题', '推断题', '例证目的题', '词义句意题'])

function fallbackLocate(q, paragraphs) {
  if (!NEEDS_LOCATE.has(q.qtype)) return null
  const pairs = q.verdicts[q.answer]?.pairs || []
  // 挑最长的原文片段，命中概率最高
  const needles = pairs
    .map((p) => p.orig)
    .filter((s) => s && s.length >= 16)
    .sort((a, b) => b.length - a.length)

  for (const needle of needles) {
    for (const para of paragraphs) {
      const lower = para.text.toLowerCase()
      const idx = lower.indexOf(needle.toLowerCase())
      if (idx < 0) continue
      // 扩到整句：向左右找句末标点
      let s = idx
      while (s > 0 && !/[.!?]/.test(para.text[s - 1])) s--
      let e = idx + needle.length
      while (e < para.text.length && !/[.!?]/.test(para.text[e - 1])) e++
      const text = para.text.slice(s, e).trim()
      if (text.length < 20) continue
      return { para: para.n, start: s, end: e, text, exact: true, derived: true }
    }
  }
  return null
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const files = (await readdir(RAW)).filter((f) => f.endsWith('.html'))
  const papers = []
  const problems = []

  const ids = [...new Set(files.map((f) => f.split('.')[0]))].sort()

  for (const id of ids) {
    const mm = id.match(/^(\d{4})-(section2-part-a-(\d))$/)
    const [, year, , part] = mm || []
    if (!year) {
      problems.push(`无法识别文件名: ${id}`)
      continue
    }
    const secHtml = await readFile(resolve(RAW, `${id}.section.html`), 'utf8')
    const artHtml = await readFile(resolve(RAW, `${id}.article.html`), 'utf8')

    const paragraphs = parseParagraphs(artHtml)
    const questions = parseQuestions(secHtml)
    const island = readIsland(secHtml)
    const located = locate(island, paragraphs) || {}

    // —— 校验 ——
    if (questions.length !== 5) problems.push(`${id}: 题数 ${questions.length} ≠ 5`)
    if (paragraphs.length < 3) problems.push(`${id}: 段数 ${paragraphs.length} 偏少`)

    // 先把兜底定位算好，避免 map 里再回头查
    const derived = {}
    for (const q of questions) {
      if (located[q.num]) continue
      const fb = fallbackLocate(q, paragraphs)
      if (fb) derived[q.num] = fb
    }

    for (const q of questions) {
      const tag = `${id} Q${q.num}`
      if (!q.stem) problems.push(`${tag}: 题干空`)
      for (const L of ['A', 'B', 'C', 'D']) {
        if (!q.options[L]) problems.push(`${tag}: 选项 ${L} 空`)
      }
      if (!q.answer) problems.push(`${tag}: 答案缺失`)
      if (!q.qtype) problems.push(`${tag}: 题型缺失`)
      const bad = Object.entries(q.verdicts).filter(([, v]) => !v.ok)
      if (bad.length !== 3) problems.push(`${tag}: 错误选项 ${bad.length} 个 ≠ 3`)
      for (const [L, v] of bad) {
        if (!v.flag) problems.push(`${tag}: 选项 ${L} 标签未归类 "${v.rawFlag}"`)
      }
      const okV = Object.entries(q.verdicts).find(([, v]) => v.ok)
      if (!okV) problems.push(`${tag}: 未找到正确项判定`)
      else if (q.answer && okV[0] !== q.answer)
        problems.push(`${tag}: 答案 ${q.answer} 与正确项 ${okV[0]} 不一致`)
      // 主旨/态度题无定位句属正常；其余题型必须能定位（原生或兜底）
      if (!located[q.num] && !derived[q.num] && q.qtype !== '主旨题' && q.qtype !== '态度题')
        problems.push(`${tag}: ${q.qtype} 无定位句且兜底失败`)
    }

    papers.push({
      id,
      year: Number(year),
      part: Number(part),
      paragraphs,
      questions: questions.map((q) => ({
        num: q.num,
        stem: q.stem,
        options: q.options,
        answer: q.answer,
        qtype: q.qtype,
        distractors: Object.fromEntries(
          Object.entries(q.verdicts)
            .filter(([, v]) => !v.ok)
            .map(([L, v]) => [L, v.flag])
        ),
        pairs: q.verdicts[q.answer]?.pairs || [],
        locate: located[q.num] || derived[q.num] || null,
      })),
    })
  }

  papers.sort((a, b) => a.year - b.year || a.part - b.part)

  // —— 统计 ——
  const allQ = papers.flatMap((p) => p.questions)
  const withLocate = allQ.filter((q) => q.locate)
  const exactLocate = withLocate.filter((q) => q.locate.exact)
  const byType = {}
  const byFlag = {}
  for (const q of allQ) {
    byType[q.qtype] = (byType[q.qtype] || 0) + 1
    for (const f of Object.values(q.distractors)) byFlag[f] = (byFlag[f] || 0) + 1
  }

  const report = {
    generatedAt: new Date().toISOString(),
    papers: papers.length,
    questions: allQ.length,
    paragraphs: papers.reduce((n, p) => n + p.paragraphs.length, 0),
    locate: {
      total: allQ.length,
      present: withLocate.length,
      exact: exactLocate.length,
      missing: allQ.length - withLocate.length,
    },
    byType,
    byFlag,
    problems,
  }

  await mkdir(OUT, { recursive: true })
  await writeFile(resolve(OUT, 'papers.json'), JSON.stringify(papers, null, 1), 'utf8')
  await writeFile(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

  console.log(`\n篇数 ${report.papers}  题数 ${report.questions}  段数 ${report.paragraphs}`)
  console.log(
    `定位句：${report.locate.present}/${report.locate.total} 有，其中精确 ${report.locate.exact}，缺 ${report.locate.missing}（主旨/态度题为正常缺失）`
  )
  console.log('题型：', byType)
  console.log('干扰项：', byFlag)
  if (problems.length) {
    console.log(`\n⚠️  校验问题 ${problems.length} 条：`)
    problems.slice(0, 30).forEach((p) => console.log('  -', p))
    if (problems.length > 30) console.log(`  …另有 ${problems.length - 30} 条`)
    process.exitCode = 1
  } else {
    console.log('\n✅ 全部校验通过')
  }
}

main()
