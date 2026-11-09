/* 判一句 v4 —— 考研英语一阅读
 *
 * 流程（严格按用户的做题习惯）：
 *   ① 看 5 个题干 → 猜话题 → 写主旨假设
 *   ② 带着假设读文章（可划线）
 *   ③ 做题：原文在上、题目在下 → 选 → 停住写理由 → AI 追问
 *   ④ 交卷 → AI 逐选项拆解出题人的坑 + 判断理由错在哪
 *   ⑤ 追问到懂
 *
 * 铁律：
 *   - 作答前，代码层面拿不到答案
 *   - 选完必须停住说理由，不能直接跳
 *   - 复盘是"拆解出题人的坑"，不是罗列标签
 */

'use strict'

const FLAGS = ['无中生有', '与原文相反', '偷换概念', '过度推断', '张冠李戴', '以偏概全', '答非所问']

const S = {
  papers: [],
  view: 'home',

  paper: null,
  idx: 0,
  // 每题作答：{ letter, reason, ok }
  answers: [],
  guess: '', // 从题干猜的主旨

  // 预测阶段
  guessStep: 0,
  guessHistory: [],
  guessNotes: { 1: '', 2: '', 3: '' },

  // 当前题
  phase: 'choose', // choose | reason
  picked: null,
  reason: '',
  aiChallenged: false,

  // 复盘
  reviewIdx: 0,
  reviewOpen: {}, // qnum -> bool（是否展开深度解析）
  reviewCache: {}, // qnum -> 文本
}

let STORE = null

// ═══════════════════════════════════════════════════════════
// 存储
// ═══════════════════════════════════════════════════════════

const STORE_KEY = 'panyiju.v3'

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw)
  } catch (e) {}
  return { version: 3, attempts: [], papers: [], lastDate: null }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(STORE))
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const el = (tag, cls, html) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
const today = () => new Date().toISOString().slice(0, 10)
const paperName = (p) => `${p.year} 年 · 阅读 ${p.part}`

let toastTimer = null
function toast(msg) {
  let t = $('#toast')
  if (!t) {
    t = el('div', 'toast')
    t.id = 'toast'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800)
}

// ═══════════════════════════════════════════════════════════
// 选篇
// ═══════════════════════════════════════════════════════════

function pickPaper() {
  const done = new Set((STORE.papers || []).map((x) => x.id))
  const undone = S.papers.filter((p) => !done.has(p.id))
  const pool = undone.length ? undone : S.papers
  const p = pool[Math.floor(Math.random() * pool.length)]

  S.paper = p
  S.idx = 0
  S.answers = p.questions.map(() => null)
  S.guess = ''
  S.guessStep = 0
  S.guessHistory = []
  S.guessNotes = { 1: '', 2: '', 3: '' }
  S.phase = 'choose'
  S.picked = null
  S.reason = ''
  S.aiChallenged = false
  S.reviewIdx = 0
  S.reviewOpen = {}
  S.reviewCache = {}
  return p
}

const curQ = () => S.paper?.questions[S.idx] || null

// ═══════════════════════════════════════════════════════════
// 首页
// ═══════════════════════════════════════════════════════════

function viewHome() {
  S.view = 'home'
  S.paper = null
  $('#btnBack').hidden = true
  $('#barTitle').textContent = '判一句'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const todayCount = STORE.attempts.filter((a) => a.date === today()).length
  const donePapers = (STORE.papers || []).length

  const hero = el('div', 'hero')
  hero.innerHTML = `
    <div class="hero-num">${todayCount}<small> 题</small></div>
    <div class="hero-cap">${
      todayCount >= 5 ? '今天够了。' : todayCount > 0 ? '一篇 5 题就够。' : '一篇 5 题，约 18 分钟。'
    }</div>
    ${donePapers ? `<div class="tiny mt-8">已练 ${donePapers} 篇</div>` : ''}
  `
  app.appendChild(hero)

  const menu = el('div', 'menu')
  const items = [
    {
      ico: '◈',
      main: '开始一篇',
      sub: '看题干猜主旨 → 读文 → 做 → 说理由 → 复盘',
      on: () => {
        pickPaper()
        viewGuess()
      },
    },
    {
      ico: '◎',
      main: '错因库',
      sub: `${new Set(STORE.attempts.filter((a) => !a.ok).map((a) => a.qid)).size} 道错题`,
      on: viewWrongs,
    },
    {
      ico: '▤',
      main: '数据',
      sub: '正确率 / 错因分布',
      on: viewStats,
    },
    {
      ico: '✦',
      main: 'AI 设置',
      sub: aiReady() ? '已接好' : '还没接，点这里填 Key',
      on: viewSettings,
    },
  ]

  for (const it of items) {
    const b = el('button', 'menu-item')
    b.innerHTML = `
      <span class="menu-ico">${it.ico}</span>
      <span class="menu-main">${esc(it.main)}<span class="menu-sub">${esc(it.sub)}</span></span>
      <span class="menu-arrow">›</span>
    `
    b.onclick = it.on
    menu.appendChild(b)
  }
  app.appendChild(menu)
}

// ═══════════════════════════════════════════════════════════
// ① 看题干猜主旨
// ═══════════════════════════════════════════════════════════

const GUESS_STEPS = [
  {
    n: 1,
    title: '扫一遍 5 个题干',
    method: '别读文章。先看这 5 个题干里反复出现的名词、专有名词——那就是文章的话题。',
    question: '这些题干在问同一个什么东西？用一句话说。',
  },
  {
    n: 2,
    title: '看有没有态度题',
    method: '题干里出现 opinion / attitude / the author believes 的，说明作者有明确立场。',
    question: '你觉得作者是支持、批评、还是中立？从哪个题干看出来的？',
  },
  {
    n: 3,
    title: '猜文章怎么展开',
    method: '题干顺序通常跟着文章顺序走。看它们像"提出问题→分析→对策"，还是"观点→反驳"。',
    question: '你猜这篇文章按什么顺序写？',
  },
]

function viewGuess() {
  S.view = 'guess'
  const p = S.paper
  $('#btnBack').hidden = false
  $('#btnBack').onclick = () => {
    if (confirm('还没开始，回首页？')) viewHome()
  }
  $('#barTitle').textContent = '第 1 步 · 看题干'
  $('#barRight').textContent = paperName(p)
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const tip = el('div', 'step-tip')
  tip.innerHTML = `
    <div class="step-tip-num">1</div>
    <div>
      <div class="step-tip-title">先看题目，别读文章</div>
      <div class="step-tip-sub">从题干里能推出文章讲什么。推完再读，读得快得多。</div>
    </div>
  `
  app.appendChild(tip)

  // 5 个题干
  const card = el('div', 'card')
  card.appendChild(el('h3', 'h-sec', '这一篇的 5 个题干'))
  for (const q of p.questions) {
    const row = el('div', 'stem-item')
    row.innerHTML = `<span class="stem-no">${q.num}</span><span class="stem-txt">${esc(q.stem)}</span>`
    card.appendChild(row)
  }
  app.appendChild(card)

  const guide = el('div')
  guide.id = 'guessGuide'
  app.appendChild(guide)

  renderGuessGuide()
}

function renderGuessGuide() {
  const zone = $('#guessGuide')
  if (!zone) return
  zone.innerHTML = ''
  const step = S.guessStep

  for (let i = 1; i <= Math.min(step, 3); i++) {
    const d = el('div', 'mi-done')
    d.innerHTML = `
      <span class="mi-done-mark">✓</span>
      <div>
        <div class="mi-done-title">${GUESS_STEPS[i - 1].title}</div>
        <div class="mi-done-said">${esc(S.guessNotes[i] || '（跳过）')}</div>
      </div>
    `
    zone.appendChild(d)
  }

  if (step < 3) {
    const cur = GUESS_STEPS[step]
    const card = el('div', 'card mi-card')
    card.innerHTML = `
      <div class="mi-head">
        <span class="mi-step">第 ${cur.n} 步 / 3</span>
        <span class="mi-title">${cur.title}</span>
      </div>
      <div class="mi-method">${cur.method}</div>
      <div class="mi-q">${cur.question}</div>
    `

    const ta = el('textarea')
    ta.className = 'idea-input'
    ta.rows = 2
    ta.placeholder = '用你自己的话说…'
    card.appendChild(ta)

    const row = el('div', 'mi-actions')
    const next = el('button', 'btn btn-primary')
    next.textContent = step === 2 ? '写我的猜测 →' : '下一步 →'
    next.disabled = true
    ta.oninput = () => (next.disabled = ta.value.trim().length < 2)

    const askAi = el('button', 'btn btn-ghost')
    askAi.textContent = '问教练'
    askAi.onclick = () => runGuessAI(step + 1, ta.value.trim(), card)

    next.onclick = () => {
      S.guessNotes[cur.n] = ta.value.trim()
      S.guessStep = step + 1
      renderGuessGuide()
      setTimeout(() => $('#guessGuide')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
    }

    row.appendChild(next)
    row.appendChild(askAi)
    card.appendChild(row)
    zone.appendChild(card)
  } else {
    renderGuessInput(zone)
  }
}

async function runGuessAI(step, said, card) {
  if (!aiReady()) {
    const h = el('div', 'mi-hint')
    h.textContent = '还没配 AI。去首页「AI 设置」填 Key。'
    card.appendChild(h)
    return
  }
  const box = el('div', 'mi-ai')
  box.textContent = '教练正在想…'
  card.appendChild(box)
  box.scrollIntoView({ block: 'center', behavior: 'smooth' })
  try {
    let full = ''
    const h = S.guessHistory || []
    if (said) h.push({ role: 'user', content: said })
    await aiPredictTopic(S.paper, step, said, h, (d, acc) => {
      full = acc
      box.textContent = acc
    })
    h.push({ role: 'assistant', content: full })
    S.guessHistory = h
  } catch (e) {
    box.textContent = '出错了：' + e.message
  }
}

function renderGuessInput(zone) {
  const card = el('div', 'card idea-card')
  card.appendChild(el('h3', 'h-sec', '带着这个猜测去读文章'))

  const notes = el('div', 'mi-notes')
  for (let i = 1; i <= 3; i++) {
    if (!S.guessNotes[i]) continue
    const n = el('div', 'mi-note')
    n.innerHTML = `<span class="mi-note-k">${GUESS_STEPS[i - 1].title}</span><span class="mi-note-v">${esc(S.guessNotes[i])}</span>`
    notes.appendChild(n)
  }
  card.appendChild(notes)

  const ta = el('textarea')
  ta.className = 'idea-input'
  ta.rows = 2
  ta.placeholder = '我猜这篇文章讲的是…'
  ta.value = S.guess || ''

  const row = el('div', 'mi-actions')
  const btn = el('button', 'btn btn-primary')
  btn.textContent = '去读文章 →'
  btn.disabled = (S.guess || '').trim().length < 4
  ta.oninput = () => {
    S.guess = ta.value
    btn.disabled = ta.value.trim().length < 4
  }

  const judgeBtn = el('button', 'btn btn-ghost')
  judgeBtn.textContent = '这个猜测靠谱吗'
  judgeBtn.onclick = async () => {
    if (!aiReady()) return toast('先配 AI')
    const g = ta.value.trim()
    if (g.length < 4) return
    const box = el('div', 'mi-ai')
    box.textContent = '教练正在看…'
    card.insertBefore(box, row)
    box.scrollIntoView({ block: 'center', behavior: 'smooth' })
    try {
      let full = ''
      await aiJudgeGuess(S.paper, g, (d, acc) => {
        full = acc
        box.textContent = acc
      })
    } catch (e) {
      box.textContent = '出错了：' + e.message
    }
  }

  btn.onclick = () => {
    S.guess = ta.value.trim()
    viewRead()
  }

  row.appendChild(btn)
  row.appendChild(judgeBtn)
  card.appendChild(ta)
  card.appendChild(row)
  zone.appendChild(card)
}

// ═══════════════════════════════════════════════════════════
// ② 读文章（可划线）
// ═══════════════════════════════════════════════════════════

function viewRead() {
  S.view = 'read'
  const p = S.paper
  $('#btnBack').hidden = false
  $('#btnBack').onclick = () => {
    if (confirm('还没开始做题，回首页？')) viewHome()
  }
  $('#barTitle').textContent = '第 2 步 · 读文章'
  $('#barRight').textContent = paperName(p)
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const tip = el('div', 'step-tip')
  tip.innerHTML = `
    <div class="step-tip-num">2</div>
    <div>
      <div class="step-tip-title">读文章，验证你的猜测</div>
      <div class="step-tip-sub">选中文字可以划线。读的时候看你的猜测对不对。</div>
    </div>
  `
  app.appendChild(tip)

  // 你的猜测摆在上面，读到哪都能对照
  if (S.guess) {
    const g = el('div', 'guess-echo')
    g.innerHTML = `<span class="guess-label">你的猜测</span>${esc(S.guess)}`
    app.appendChild(g)
  }

  const card = el('div', 'card passage-card')
  for (const para of p.paragraphs) {
    const row = el('div', 'passage-para')
    row.dataset.para = para.n
    row.innerHTML = `<span class="passage-no">${para.n}</span><span class="passage-txt" data-mtext="${para.n}"></span>`
    card.appendChild(row)
  }
  app.appendChild(card)
  enableMarking(card, p.id, p.paragraphs)

  const btn = el('button', 'btn btn-primary btn-block mt-20')
  btn.textContent = '开始做题 →'
  btn.onclick = () => {
    S.idx = 0
    S.phase = 'choose'
    viewQuiz()
  }
  app.appendChild(btn)
}

// ═══════════════════════════════════════════════════════════
// ③ 做题：原文在上，题目在下
// ═══════════════════════════════════════════════════════════

function viewQuiz() {
  S.view = 'quiz'
  const p = S.paper
  const q = curQ()
  S.phase = 'choose'
  S.picked = null
  S.reason = ''
  S.aiChallenged = false

  $('#btnBack').hidden = false
  $('#btnBack').onclick = () => {
    if (confirm('这一篇做到一半，回首页？进度不保留。')) viewHome()
  }
  $('#barTitle').textContent = paperName(p)
  $('#barRight').textContent = `${S.idx + 1} / ${p.questions.length}`
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  // 进度
  const prog = el('div', 'qprog')
  for (let i = 0; i < p.questions.length; i++) {
    const d = el('span', 'qprog-dot')
    if (i < S.idx) d.classList.add('done')
    if (i === S.idx) d.classList.add('now')
    prog.appendChild(d)
  }
  app.appendChild(prog)

  // 原文在上
  const pCard = el('div', 'card passage-card compact')
  pCard.id = 'quizPassage'
  for (const para of p.paragraphs) {
    const row = el('div', 'passage-para')
    row.dataset.para = para.n
    row.innerHTML = `<span class="passage-no">${para.n}</span><span class="passage-txt" data-mtext="${para.n}"></span>`
    pCard.appendChild(row)
  }
  app.appendChild(pCard)
  enableMarking(pCard, p.id, p.paragraphs)

  // 题目在下
  const qCard = el('div', 'card quiz-card')
  qCard.id = 'quizCard'

  const stem = el('p', 'stem')
  stem.textContent = `${q.num}. ${q.stem}`
  qCard.appendChild(stem)

  const opts = el('div', 'opts')
  for (const L of ['A', 'B', 'C', 'D']) {
    const b = el('button', 'opt')
    b.dataset.letter = L
    b.innerHTML = `<span class="opt-letter">${L}</span><span>${esc(q.options[L] || '')}</span>`
    b.onclick = () => pickOption(L)
    opts.appendChild(b)
  }
  qCard.appendChild(opts)

  // 理由区（选完才出现）
  const reasonZone = el('div')
  reasonZone.id = 'reasonZone'
  qCard.appendChild(reasonZone)

  app.appendChild(qCard)
  qCard.scrollIntoView({ block: 'end', behavior: 'smooth' })
}

function pickOption(L) {
  if (S.phase !== 'choose') return
  S.picked = L
  S.phase = 'reason'

  for (const b of $$('.opt')) {
    b.classList.toggle('is-picked', b.dataset.letter === L)
    b.disabled = true
  }

  renderReasonZone()
}

// 选完停住：必须写理由才能走
function renderReasonZone() {
  const q = curQ()
  const zone = $('#reasonZone')
  if (!zone) return
  zone.innerHTML = ''

  const box = el('div', 'reason-box')
  const pickedText = q.options[S.picked] || ''

  box.innerHTML = `
    <div class="reason-head">
      <span class="reason-badge">你选了 ${S.picked}</span>
      <span class="reason-picked">${esc(pickedText)}</span>
    </div>
    <div class="reason-q">为什么选它？说出你在原文看到的依据。</div>
  `

  const ta = el('textarea')
  ta.className = 'idea-input'
  ta.rows = 3
  ta.placeholder = '第几段说……所以我选它。'
  ta.value = S.reason || ''
  box.appendChild(ta)

  const acts = el('div', 'mi-actions')
  const next = el('button', 'btn btn-primary')
  next.textContent = S.idx === S.paper.questions.length - 1 ? '交卷 →' : '下一题 →'
  next.disabled = ta.value.trim().length < 4
  ta.oninput = () => {
    S.reason = ta.value
    next.disabled = ta.value.trim().length < 4
  }

  const askAI = el('button', 'btn btn-ghost')
  askAI.textContent = '让教练看看我的理由'
  askAI.onclick = () => challengeReason(ta.value.trim(), box)

  const changeMine = el('button', 'btn btn-ghost')
  changeMine.textContent = '改选项'
  changeMine.onclick = () => {
    S.phase = 'choose'
    S.picked = null
    S.reason = ''
    renderReasonZoneClear()
    for (const b of $$('.opt')) {
      b.classList.remove('is-picked')
      b.disabled = false
    }
  }

  next.onclick = () => commitOne(ta.value.trim())
  acts.appendChild(next)
  acts.appendChild(askAI)
  acts.appendChild(changeMine)
  box.appendChild(acts)
  zone.appendChild(box)

  // 没有 AI 的情况下，理由仍然必须写（这是铁律）
  if (!aiReady()) {
    const h = el('div', 'mi-hint')
    h.textContent = '没配 AI 也能做题，理由照样得写——那是你自己在跟自己较劲。'
    box.appendChild(h)
  }

  box.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function renderReasonZoneClear() {
  const z = $('#reasonZone')
  if (z) z.innerHTML = ''
}

async function challengeReason(reason, box) {
  if (!aiReady()) return toast('先配 AI')
  if (!reason || reason.length < 4) return toast('先把理由写出来')

  const q = curQ()
  const out = el('div', 'mi-ai')
  out.textContent = '教练正在看你的理由…'
  box.appendChild(out)
  out.scrollIntoView({ block: 'center', behavior: 'smooth' })

  try {
    let full = ''
    await aiChallengeReason(S.paper, q, S.picked, reason, [], (d, acc) => {
      full = acc
      out.textContent = acc
    })
    S.aiChallenged = true

    // 追问入口
    const ask = el('button', 'btn btn-ghost mt-8')
    ask.textContent = '我还不服／还想问'
    ask.onclick = () => openFollowUp('challenge', { reason })
    box.appendChild(ask)
  } catch (e) {
    out.textContent = '出错了：' + e.message
  }
}

// 记下这一题，进下一题
function commitOne(reason) {
  const q = curQ()
  S.answers[S.idx] = {
    letter: S.picked,
    reason: reason || '',
    ok: S.picked === q.answer,
  }
  S.reason = reason || ''

  if (S.idx < S.paper.questions.length - 1) {
    S.idx++
    window.scrollTo({ top: 0 })
    viewQuiz()
  } else {
    finishPaper()
  }
}

// ═══════════════════════════════════════════════════════════
// ④ 交卷
// ═══════════════════════════════════════════════════════════

function finishPaper() {
  S.view = 'done'
  const p = S.paper
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const right = S.answers.filter((a) => a?.ok).length

  // 落库
  STORE.papers = STORE.papers || []
  STORE.papers.push({
    id: p.id,
    year: p.year,
    part: p.part,
    date: today(),
    guess: S.guess,
    right,
    total: p.questions.length,
  })
  p.questions.forEach((q, i) => {
    const a = S.answers[i]
    if (!a) return
    STORE.attempts.push({
      qid: `${p.id}#${q.num}`,
      date: today(),
      paperId: p.id,
      qnum: q.num,
      chosen: a.letter,
      answer: q.answer,
      ok: a.ok,
      reason: a.reason,
      qtype: q.qtype,
    })
  })
  saveStore()

  const app = $('#app')
  app.innerHTML = ''

  const head = el('div', 'result-head')
  head.innerHTML = `
    <div class="result-big ${right >= 3 ? 'ok' : 'bad'}">${right}<span class="result-total">/5</span></div>
    <div class="result-sub">${right >= 3 ? '过线' : '要再看'}</div>
  `
  app.appendChild(head)

  const table = el('div', 'card')
  table.appendChild(el('h3', 'h-sec', '对错'))
  const hr = el('div', 'res-row res-head')
  hr.innerHTML = `<span class="res-no">题</span><span class="res-type">题型</span><span class="res-pick">你</span><span class="res-ans">答</span><span></span>`
  table.appendChild(hr)
  for (let i = 0; i < p.questions.length; i++) {
    const q = p.questions[i]
    const a = S.answers[i]
    const row = el('div', 'res-row')
    row.innerHTML = `
      <span class="res-no">${q.num}</span>
      <span class="res-type">${esc(q.qtype)}</span>
      <span class="res-pick">${a ? a.letter : '—'}</span>
      <span class="res-ans">${q.answer}</span>
      <span class="res-mark ${a?.ok ? 'ok' : 'bad'}">${a?.ok ? '✓' : '✗'}</span>
    `
    table.appendChild(row)
  }
  app.appendChild(table)

  if (S.guess) {
    const g = el('div', 'card')
    g.appendChild(el('h3', 'h-sec', '你读之前猜的主旨'))
    g.appendChild(el('div', 'idea-echo', esc(S.guess)))
    g.appendChild(el('div', 'tiny mt-8', '现在读完也做完了，回头看看当初猜的差在哪。'))
    app.appendChild(g)
  }

  const wrap = el('div', 'mt-20')
  const b = el('button', 'btn btn-primary btn-block')
  b.textContent = '逐题深度复盘 →'
  b.onclick = () => {
    S.reviewIdx = 0
    viewReview()
  }
  wrap.appendChild(b)
  const b2 = el('button', 'btn btn-ghost btn-block mt-8')
  b2.textContent = '回首页'
  b2.onclick = viewHome
  wrap.appendChild(b2)
  app.appendChild(wrap)
}

// ═══════════════════════════════════════════════════════════
// ⑤ 深度复盘：AI 拆解出题人的坑
// ═══════════════════════════════════════════════════════════

function viewReview() {
  S.view = 'review'
  const p = S.paper
  const q = p.questions[S.reviewIdx]
  const a = S.answers[S.reviewIdx]

  $('#btnBack').hidden = false
  $('#btnBack').onclick = () => {
    if (confirm('退出复盘？')) viewHome()
  }
  $('#barTitle').textContent = '复盘'
  $('#barRight').textContent = `${S.reviewIdx + 1} / ${p.questions.length}`
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  // 题号 + 结果
  const head = el('div', 'result-head')
  head.innerHTML = `
    <div class="res-badge">第 ${q.num} 题</div>
    <div class="result-sub">你选 ${a?.letter || '—'} · 答案 ${q.answer} · ${esc(q.qtype)}</div>
  `
  app.appendChild(head)

  // 题干 + 选项（标对错）
  const qc = el('div', 'card')
  const stem = el('p', 'stem')
  stem.style.fontSize = '16.5px'
  stem.textContent = `${q.num}. ${q.stem}`
  qc.appendChild(stem)
  const opts = el('div', 'opts')
  for (const L of ['A', 'B', 'C', 'D']) {
    const row = el('div', 'opt opt-ro')
    if (L === q.answer) row.classList.add('is-right')
    else if (L === a?.letter) row.classList.add('is-wrong')
    else row.classList.add('is-dim')
    row.innerHTML = `<span class="opt-letter">${L}</span><span>${esc(q.options[L] || '')}</span>`
    row.onclick = () => openFollowUp('option', { letter: L })
    opts.appendChild(row)
  }
  qc.appendChild(opts)
  qc.appendChild(el('div', 'tiny mt-8', '点任意选项可以追问'))
  app.appendChild(qc)

  // 你的理由
  if (a?.reason) {
    const rc = el('div', 'card')
    rc.appendChild(el('h3', 'h-sec', '你当时的理由'))
    rc.appendChild(el('div', 'idea-echo', esc(a.reason)))
    app.appendChild(rc)
  }

  // AI 深度解析区
  const ac = el('div', 'card ai-card')
  const ah = el('div', 'row-between')
  ah.innerHTML = `<h3 class="h-sec" style="margin:0">出题人怎么挖的坑</h3>`
  ac.appendChild(ah)

  const out = el('div', 'ai-analysis')
  out.id = 'aiAnalysis'
  ac.appendChild(out)

  const acts = el('div', 'mi-actions')
  const runBtn = el('button', 'btn btn-primary')
  runBtn.textContent = aiReady() ? '让 AI 拆这道题' : '先配 AI'
  runBtn.onclick = () => {
    if (!aiReady()) return viewSettings()
    runDeepAnalyze(q, a, out, runBtn)
  }
  acts.appendChild(runBtn)

  const followBtn = el('button', 'btn btn-ghost')
  followBtn.textContent = '追问'
  followBtn.onclick = () => openFollowUp('option', { letter: a?.letter || q.answer })
  acts.appendChild(followBtn)

  ac.appendChild(acts)
  app.appendChild(ac)

  // 翻页
  const nav = el('div', 'mt-20')
  const prev = el('button', 'btn btn-block')
  prev.textContent = '← 上一题'
  prev.disabled = S.reviewIdx === 0
  prev.onclick = () => {
    S.reviewIdx--
    viewReview()
  }
  const next = el('button', 'btn btn-primary btn-block mt-8')
  const isLast = S.reviewIdx === p.questions.length - 1
  next.textContent = isLast ? '完成复盘 →' : '下一题 →'
  next.onclick = () => {
    if (isLast) viewReviewDone()
    else {
      S.reviewIdx++
      viewReview()
    }
  }
  nav.appendChild(prev)
  nav.appendChild(next)
  app.appendChild(nav)

  // 有缓存就直接显示
  if (S.reviewCache[q.num]) {
    out.innerHTML = mdLite(S.reviewCache[q.num])
    runBtn.textContent = '重新拆一次'
  }
}

async function runDeepAnalyze(q, a, out, btn) {
  btn.disabled = true
  btn.textContent = '拆解中…'
  out.innerHTML = '<div class="ai-loading">AI 正在分析这道题…</div>'
  try {
    let full = ''
    await aiDeepAnalyze(S.paper, q, a, (d, acc) => {
      full = acc
      out.innerHTML = mdLite(acc)
    })
    S.reviewCache[q.num] = full
    btn.textContent = '重新拆一次'
  } catch (e) {
    out.innerHTML = `<div class="ai-err">出错了：${esc(e.message)}</div>`
    btn.textContent = '重试'
  } finally {
    btn.disabled = false
  }
}

// 极简 markdown：只处理换行和 **粗体**
function mdLite(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>')
}

function viewReviewDone() {
  S.view = 'reviewDone'
  $('#barTitle').textContent = '复盘完成'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const hero = el('div', 'hero')
  hero.innerHTML = `<div class="hero-num">✓</div><div class="hero-cap">这一篇复盘完了</div>`
  app.appendChild(hero)

  // 整篇诊断
  const card = el('div', 'card ai-card')
  card.appendChild(el('h3', 'h-sec', '这一篇暴露的问题'))

  const out = el('div', 'ai-analysis')
  out.id = 'paperSummary'
  card.appendChild(out)

  const btn = el('button', 'btn btn-primary btn-block mt-14')
  btn.textContent = aiReady() ? '让 AI 总结我 5 题的通病' : '先配 AI'
  btn.onclick = async () => {
    if (!aiReady()) return viewSettings()
    btn.disabled = true
    btn.textContent = '分析中…'
    out.innerHTML = '<div class="ai-loading">AI 正在找你的通病…</div>'
    try {
      let full = ''
      await aiPaperSummary(S.paper, S.answers, (d, acc) => {
        full = acc
        out.innerHTML = mdLite(acc)
      })
      btn.textContent = '重新分析'
    } catch (e) {
      out.innerHTML = `<div class="ai-err">出错了：${esc(e.message)}</div>`
      btn.textContent = '重试'
    } finally {
      btn.disabled = false
    }
  }
  card.appendChild(btn)
  app.appendChild(card)

  const wrap = el('div', 'mt-20')
  const b = el('button', 'btn btn-primary btn-block')
  b.textContent = '再练一篇 →'
  b.onclick = () => {
    pickPaper()
    viewGuess()
  }
  wrap.appendChild(b)
  const b2 = el('button', 'btn btn-ghost btn-block mt-8')
  b2.textContent = '回首页'
  b2.onclick = viewHome
  wrap.appendChild(b2)
  app.appendChild(wrap)
}

// ═══════════════════════════════════════════════════════════
// 追问面板
// ═══════════════════════════════════════════════════════════

let FOLLOW = null

function openFollowUp(kind, ctx) {
  if (!aiReady()) {
    toast('先配 AI')
    return viewSettings()
  }
  const q = kind === 'challenge' ? curQ() : S.paper.questions[S.reviewIdx]
  const old = $('#follow')
  if (old) old.remove()

  const d = el('div', 'drawer')
  d.id = 'follow'
  d.innerHTML = `
    <div class="drawer-mask"></div>
    <div class="drawer-panel follow-panel">
      <div class="drawer-grip"></div>
      <div class="drawer-head">
        <span class="drawer-title">追问 · 第 ${q.num} 题</span>
        <button class="drawer-close" id="followClose">收起</button>
      </div>
      <div class="follow-log" id="followLog"></div>
      <div class="follow-input">
        <textarea id="followInput" rows="2" placeholder="哪里没看懂，直接问…"></textarea>
        <button class="coach-send" id="followSend">问</button>
      </div>
    </div>
  `
  document.body.appendChild(d)
  document.body.style.overflow = 'hidden'
  requestAnimationFrame(() => d.classList.add('open'))

  const close = () => {
    d.classList.remove('open')
    document.body.style.overflow = ''
    setTimeout(() => d.remove(), 260)
  }
  $('.drawer-mask', d).onclick = close
  $('#followClose').onclick = close

  const log = $('#followLog')
  const input = $('#followInput')
  const send = $('#followSend')

  const addMsg = (role, text) => {
    const m = el('div', 'coach-msg coach-' + role)
    m.textContent = text
    log.appendChild(m)
    log.scrollTop = log.scrollHeight
    return m
  }

  // 开场：把问题摆出来，方便他直接问
  const opening =
    kind === 'option'
      ? `我讲这道题的 ${ctx.letter} 项。你想问哪一个？比如：为什么它错？我怎么就没想到？这个替换我怎么看出来？`
      : `你选了 ${S.picked}。你觉得 AI 刚才说的问题你接受吗？还是哪里觉得不对？`
  addMsg('ai', opening)

  let busy = false
  const ask = async () => {
    const text = input.value.trim()
    if (!text || busy) return
    input.value = ''
    addMsg('me', text)
    busy = true
    send.disabled = true

    const bubble = addMsg('ai', '')
    bubble.classList.add('typing')

    try {
      let full = ''
      if (kind === 'option') {
        await aiAskAboutOption(S.paper, q, ctx.letter, text, [], (d2, acc) => {
          full = acc
          bubble.textContent = acc
        })
      } else {
        await aiAskAboutOption(S.paper, q, S.picked, text, [], (d2, acc) => {
          full = acc
          bubble.textContent = acc
        })
      }
      if (!bubble.textContent) bubble.textContent = full
      bubble.classList.remove('typing')
    } catch (e) {
      bubble.textContent = '出错了：' + e.message
      bubble.classList.remove('typing')
    } finally {
      busy = false
      send.disabled = false
      log.scrollTop = log.scrollHeight
    }
  }
  send.onclick = ask
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask()
  })
  setTimeout(() => input.focus(), 320)
}

// ═══════════════════════════════════════════════════════════
// 数据
// ═══════════════════════════════════════════════════════════

function viewStats() {
  S.view = 'stats'
  S.paper = null
  $('#btnBack').hidden = false
  $('#btnBack').onclick = viewHome
  $('#barTitle').textContent = '数据'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''
  const at = STORE.attempts

  if (!at.length) {
    app.innerHTML = `<div class="empty"><div class="empty-ico">◎</div><div>还没做过题。</div></div>`
    return
  }

  const right = at.filter((a) => a.ok).length
  const c = el('div', 'card')
  c.appendChild(el('h3', 'h-sec', '总览'))
  c.innerHTML += `
    <div class="stat-row"><span>做了</span><b>${at.length} 题</b></div>
    <div class="stat-row"><span>做对</span><b>${right} 题</b></div>
    <div class="stat-row"><span>正确率</span><b>${Math.round((right / at.length) * 100)}%</b></div>
  `
  app.appendChild(c)

  // 错因分布
  const counts = {}
  for (const a of at) {
    if (a.ok) continue
    const p = S.papers.find((x) => x.id === a.paperId)
    const q = p?.questions.find((x) => x.num === a.qnum)
    if (!q) continue
    const f = q.distractors[a.chosen]
    if (f) counts[f] = (counts[f] || 0) + 1
  }
  const max = Math.max(1, ...Object.values(counts))

  const c2 = el('div', 'card')
  c2.appendChild(el('h3', 'h-sec', '错在哪些类'))
  if (!Object.keys(counts).length) {
    c2.appendChild(el('div', 'tiny', '还没错过。'))
  } else {
    const bars = el('div', 'flag-bars')
    for (const f of FLAGS) {
      const v = counts[f] || 0
      const row = el('div', 'flag-row')
      row.innerHTML = `<span class="flag-name">${f}</span><span class="flag-track"><span class="flag-fill" style="width:${(v / max) * 100}%"></span></span><span class="flag-num">${v}</span>`
      bars.appendChild(row)
    }
    c2.appendChild(bars)
  }
  app.appendChild(c2)

  const c3 = el('div', 'card')
  c3.appendChild(el('h3', 'h-sec', '数据'))
  const row = el('div', 'row-between mt-14')
  const exp = el('button', 'btn', '导出')
  exp.onclick = () => {
    const blob = new Blob([JSON.stringify(STORE, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `panyiju-${today()}.json`
    a.click()
  }
  const clr = el('button', 'btn btn-ghost', '清空')
  clr.onclick = () => {
    if (!confirm('清空所有记录？')) return
    localStorage.removeItem(STORE_KEY)
    STORE = loadStore()
    viewStats()
  }
  row.appendChild(exp)
  row.appendChild(clr)
  c3.appendChild(row)
  app.appendChild(c3)
}

function viewWrongs() {
  S.view = 'wrongs'
  S.paper = null
  $('#btnBack').hidden = false
  $('#btnBack').onclick = viewHome
  $('#barTitle').textContent = '错因库'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''
  const wrongs = STORE.attempts.filter((a) => !a.ok)
  if (!wrongs.length) {
    app.innerHTML = `<div class="empty"><div class="empty-ico">◎</div><div>还没错过题。</div></div>`
    return
  }

  const byFlag = {}
  for (const a of wrongs) {
    const p = S.papers.find((x) => x.id === a.paperId)
    const q = p?.questions.find((x) => x.num === a.qnum)
    if (!q) continue
    const f = q.distractors[a.chosen] || '未归类'
    ;(byFlag[f] = byFlag[f] || []).push({ a, p, q })
  }

  for (const f of FLAGS) {
    const list = byFlag[f]
    if (!list) continue
    const c = el('div', 'card')
    const h = el('div', 'row-between')
    h.innerHTML = `<h3 class="h-sec" style="margin:0">${f}</h3><span class="chip chip-bad">${list.length}</span>`
    c.appendChild(h)
    for (const { a, p, q } of list.slice(0, 8)) {
      const item = el('div', 'mt-14')
      item.style.borderTop = '1px solid var(--line)'
      item.style.paddingTop = '11px'
      item.innerHTML = `
        <div class="tiny">${esc(paperName(p))} · 第 ${q.num} 题 · 你选 ${a.chosen}</div>
        <div style="font-family:var(--font-en);font-size:15px;margin:5px 0">${esc(q.stem)}</div>
        ${a.reason ? `<div class="tiny">你当时的理由：${esc(a.reason)}</div>` : ''}
        <div class="tiny mt-8">正确项：${esc(q.options[q.answer] || '')}</div>
      `
      c.appendChild(item)
    }
    app.appendChild(c)
  }
}

// ═══════════════════════════════════════════════════════════
// 设置
// ═══════════════════════════════════════════════════════════

function viewSettings() {
  S.view = 'settings'
  S.paper = null
  $('#btnBack').hidden = false
  $('#btnBack').onclick = viewHome
  $('#barTitle').textContent = 'AI 设置'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const cfg = loadAIConfig()
  const app = $('#app')
  app.innerHTML = ''

  const presets = el('div', 'card')
  presets.appendChild(el('h3', 'h-sec', '选接口'))
  const prow = el('div', 'preset-row')
  for (const pr of AI_PRESETS) {
    const isD = pr.id === 'deepseek'
    const b = el('button', 'preset-btn' + (isD ? ' preset-main' : ''))
    b.innerHTML = `<span class="preset-name">${pr.name}${isD ? ' <span class="preset-tag">推荐</span>' : ''}</span><span class="preset-note">${pr.note}</span>`
    b.onclick = () => {
      fUrl.input.value = pr.baseUrl
      modelSel.innerHTML = ''
      for (const m of pr.models) {
        const o = el('option')
        o.value = m
        o.textContent = m
        modelSel.appendChild(o)
      }
    }
    prow.appendChild(b)
  }
  presets.appendChild(prow)
  app.appendChild(presets)

  const form = el('div', 'card')
  form.appendChild(el('h3', 'h-sec', '参数'))

  const mkInput = (label, key, type, ph, hint) => {
    const box = el('div', 'mt-14')
    box.appendChild(el('label', 'set-label', label))
    const i = el('input')
    i.className = 'set-input'
    i.type = type
    i.placeholder = ph
    i.value = cfg[key] || ''
    box.appendChild(i)
    if (hint) box.appendChild(el('div', 'tiny mt-8', hint))
    return { box, input: i }
  }

  const fUrl = mkInput('接口地址', 'baseUrl', 'text', 'https://api.deepseek.com')
  const fKey = mkInput('API Key', 'apiKey', 'password', 'sk-…', '只存本地')
  form.appendChild(fUrl.box)
  form.appendChild(fKey.box)

  const mb = el('div', 'mt-14')
  mb.appendChild(el('label', 'set-label', '模型'))
  const modelSel = el('select')
  modelSel.className = 'set-input set-select'
  const guess = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl) || AI_PRESETS[0]
  for (const m of guess.models) {
    const o = el('option')
    o.value = m
    o.textContent = m
    if (m === cfg.model) o.selected = true
    modelSel.appendChild(o)
  }
  mb.appendChild(modelSel)
  form.appendChild(mb)
  app.appendChild(form)

  const sw = el('div', 'card')
  const swr = el('div', 'row-between')
  swr.innerHTML = `<div><div style="font-size:15px;font-weight:600">启用 AI</div><div class="tiny mt-8">关掉就只用本地流程</div></div>`
  const tg = el('button', 'switch' + (cfg.enabled ? ' on' : ''))
  tg.innerHTML = '<span class="switch-dot"></span>'
  tg.onclick = () => {
    tg.classList.toggle('on')
    saveAIConfig({ ...loadAIConfig(), enabled: tg.classList.contains('on') })
  }
  swr.appendChild(tg)
  sw.appendChild(swr)
  app.appendChild(sw)

  const acts = el('div', 'mt-20')
  const save = el('button', 'btn btn-primary btn-block', '保存')
  save.onclick = () => {
    saveAIConfig({
      ...cfg,
      baseUrl: fUrl.input.value.trim() || AI_DEFAULT.baseUrl,
      apiKey: fKey.input.value.trim(),
      model: modelSel.value || AI_DEFAULT.model,
      enabled: tg.classList.contains('on'),
    })
    toast('已保存')
  }
  const test = el('button', 'btn btn-block mt-8', '测试连通')
  test.onclick = async () => {
    saveAIConfig({
      ...cfg,
      baseUrl: fUrl.input.value.trim() || AI_DEFAULT.baseUrl,
      apiKey: fKey.input.value.trim(),
      model: modelSel.value || AI_DEFAULT.model,
      enabled: true,
    })
    if (!fKey.input.value.trim()) return toast('先填 Key')
    test.disabled = true
    test.textContent = '测试中…'
    try {
      const r = await aiPing()
      test.textContent = '通了 · ' + r.slice(0, 12)
      test.style.color = 'var(--ok)'
    } catch (e) {
      test.textContent = '没通'
      test.style.color = 'var(--bad)'
      toast(e.message)
    } finally {
      test.disabled = false
    }
  }
  acts.appendChild(save)
  acts.appendChild(test)
  app.appendChild(acts)

  const help = el('div', 'card mt-20')
  help.appendChild(el('h3', 'h-sec', '怎么拿 Key'))
  help.innerHTML += `<div class="tiny" style="line-height:1.8">platform.deepseek.com 注册 → API keys → 创建 → 复制 sk- 开头<br>DeepSeek 允许网页直连，不用架服务器。</div>`
  app.appendChild(help)
}

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

async function boot() {
  STORE = loadStore()
  if (!STORE.papers) STORE.papers = []
  if (!STORE.attempts) STORE.attempts = []

  try {
    const res = await fetch('./data/papers.json', { cache: 'force-cache' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    S.papers = await res.json()
  } catch (e) {
    $('#app').innerHTML = `<div class="empty"><div class="empty-ico">⚠</div><div>题库加载失败</div><div class="tiny mt-8">${esc(e.message)}</div></div>`
    return
  }

  viewHome()
}

boot()
