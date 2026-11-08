#!/usr/bin/env node
// 抓取英语一 2018-2024 阅读真题（Part A 四选一）的原始页面到 cache/raw/。
// 只抓一次，之后 parse.mjs 全从本地缓存读，不再联网。
//
// 用法：
//   node tools/fetch.mjs            # 抓缺的
//   node tools/fetch.mjs --force    # 全部重抓

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = resolve(ROOT, 'cache/raw')
const BASE = 'https://english-exam.lazynote.cn'

const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024]
const PARTS = [1, 2, 3, 4]

const FORCE = process.argv.includes('--force')
const DELAY_MS = 1600 // 站点会限速，1.6s 实测安全

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function grab(url, file, label) {
  if (!FORCE && existsSync(file)) {
    const buf = await readFile(file, 'utf8')
    process.stdout.write(`  skip  ${label} (${buf.length}B)\n`)
    return 'skip'
  }
  // 两次重试，退避 4s / 9s
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const html = await get(url)
      if (html.length < 20000) throw new Error(`too small: ${html.length}`)
      await writeFile(file, html, 'utf8')
      process.stdout.write(`  ok    ${label} (${html.length}B)\n`)
      return 'ok'
    } catch (e) {
      if (attempt === 2) {
        process.stdout.write(`  FAIL  ${label} ${e.message}\n`)
        return 'fail'
      }
      await sleep(4000 + attempt * 5000)
    }
  }
  return 'fail'
}

async function main() {
  await mkdir(RAW, { recursive: true })
  const tally = { ok: 0, skip: 0, fail: 0 }
  const failures = []

  for (const year of YEARS) {
    console.log(`\n=== ${year} 英语一 ===`)
    for (const part of PARTS) {
      const sec = `section2-part-a-${part}`
      const tag = `${year}-p${part}`

      const r1 = await grab(
        `${BASE}/kaoyan/sections/${year}-english-one/${sec}/`,
        resolve(RAW, `${year}-${sec}.section.html`),
        `${tag} 题目解析`
      )
      tally[r1]++
      if (r1 === 'fail') failures.push(`${tag} section`)
      await sleep(DELAY_MS)

      const r2 = await grab(
        `${BASE}/kaoyan/articles/${year}-english-one/${sec}/`,
        resolve(RAW, `${year}-${sec}.article.html`),
        `${tag} 文章精读`
      )
      tally[r2]++
      if (r2 === 'fail') failures.push(`${tag} article`)
      await sleep(DELAY_MS)
    }
  }

  console.log(`\n抓取完成：ok=${tally.ok} skip=${tally.skip} fail=${tally.fail}`)
  if (failures.length) {
    console.log('失败项（重跑本命令会只补缺的）：')
    failures.forEach((f) => console.log('  -', f))
    process.exitCode = 1
  }
}

main()
