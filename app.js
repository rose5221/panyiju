/* 判一句 —— 考研英语一阅读 · 整篇训练
 *
 * 流程（照用户的实际做题习惯设计）：
 *   ① 通读全文，自己写一句主旨
 *   ② 逐题做：判题型 → 定段 → 自己选答案（不给对错）
 *   ③ 5 题全做完 → 统一结算
 *   ④ 只对错题做排错项（验证，不是答题前的排除）
 *
 * 铁律：
 *   - 老周只问不答。任何会提前泄露答案的行为都是 bug。
 *   - 5 题全做完才结算，中间不告诉你对错——考场就是这样。
 *   - 排错项永远在「你已经选完答案」之后。
 */

'use strict'

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

const FLAGS = ['无中生有', '与原文相反', '偷换概念', '过度推断', '张冠李戴', '以偏概全', '答非所问']

const FLAG_HINT = {
  无中生有: '原文压根没提这回事，选项自己编的。',
  与原文相反: '原文说了，但意思反了——否定变肯定、肯定变否定。',
  偷换概念: '词还在，但对象或范围被换了手。',
  过度推断: '原文只说了半步，选项替它走完了一步。',
  张冠李戴: '话是原文的话，但安到了错的人/事头上。',
  以偏概全: '部分说成了整体，个例说成了通例。',
  答非所问: '选项本身没错，但没回答题干问的那个问题。',
}

const QTYPES = ['细节题', '推断题', '主旨题', '态度题', '例证目的题', '词义句意题']

// ═══════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════

const S = {
  papers: [],
  view: 'home',

  // 当前这一篇
  paper: null,
  idx: 0, // 第几题（0-4）
  answers: [], // 每题 { letter, typeFirstTry, paraFirstTry, hints, blocked }
  mainIdea: '', // 用户写的全文主旨

  // 当前题的关卡
  gate: 0, // 0未开始 1判题型 2定段 3作答
  hintsUsed: 0,
  blockedCount: 0,
  gate1Missed: false,
  gate1FirstTry: false,
  gate2Missed: false,
  gate2FirstTry: false,

  // 复盘
  reviewQueue: [], // 待复盘的错题索引
  reviewPos: 0,
  reviewTagTries: 0,
  reviewTagFirstRight: 0,
  reviewFlagsPicked: {}, // qnum -> flag

  // 全文是否已读
  passageRead: false,
}

let STORE = null

// ═══════════════════════════════════════════════════════════
// 本地存储
// ═══════════════════════════════════════════════════════════

const STORE_KEY = 'panyiju.v2'

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw)
    // 兼容 v1 的记录
    const old = localStorage.getItem('panyiju.v1')
    if (old) {
      const o = JSON.parse(old)
      return {
        version: 2,
        attempts: (o.attempts || []).map((a) => ({ ...a, kind: 'card' })),
        papers: [],
        lastDate: o.lastDate || null,
      }
    }
  } catch (e) {
    console.warn('读取本地记录失败', e)
  }
  return { version: 2, attempts: [], papers: [], lastDate: null }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(STORE))
  } catch (e) {
    console.warn('保存失败', e)
  }
}

// ═══════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
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

// ═══════════════════════════════════════════════════════════
// 选篇：优先没做过的
// ═══════════════════════════════════════════════════════════

function pickPaper() {
  const doneSet = new Set((STORE.papers || []).map((x) => x.id))
  const undone = S.papers.filter((p) => !doneSet.has(p.id))
  const pool = undone.length ? undone : S.papers
  const picked = pool[Math.floor(Math.random() * pool.length)]

  S.paper = picked
  S.idx = 0
  S.answers = picked.questions.map(() => null)
  S.mainIdea = ''
  S.passageRead = false
  S.gate = 0
  S.hintsUsed = 0
  S.blockedCount = 0
  S.gate1Missed = false
  S.gate1FirstTry = false
  S.gate2Missed = false
  S.gate2FirstTry = false
  S.reviewQueue = []
  S.reviewPos = 0
  S.reviewTagTries = 0
  S.reviewTagFirstRight = 0
  S.reviewFlagsPicked = {}
  return picked
}

function curQ() {
  return S.paper?.questions[S.idx] || null
}

// ═══════════════════════════════════════════════════════════
// 老周
// ═══════════════════════════════════════════════════════════

const ZHOU = {
  say(text, acts = []) {
    const wrap = $('#zhou')
    $('#zhouSay').textContent = text
    $('#zhouStep').textContent = S.view === 'quiz' ? ZHOU.stepLabel() : ''

    const box = $('#zhouActs')
    box.innerHTML = ''
    for (const a of acts) {
      const b = el('button', 'zhou-act' + (a.primary ? ' primary' : a.quiet ? ' quiet' : ''))
      b.textContent = a.label
      b.onclick = a.on
      box.appendChild(b)
    }
    wrap.hidden = false
    ZHOU.reserve()
  },

  stepLabel() {
    if (!S.paper) return ''
    const n = S.idx + 1
    const total = S.paper.questions.length
    const g = ['', '· 判题型', '· 定段', '· 作答'][S.gate] || ''
    return `第 ${n}/${total} 题 ${g}`
  },

  reserve() {
    const wrap = $('#zhou')
    if (!wrap || wrap.hidden) {
      document.body.style.paddingBottom = ''
      return
    }
    document.body.style.paddingBottom = `${wrap.offsetHeight + 28}px`
  },

  hide() {
    $('#zhou').hidden = true
    document.body.style.paddingBottom = ''
  },
}

// ═══════════════════════════════════════════════════════════
// 视图：首页
// ═══════════════════════════════════════════════════════════

function viewHome() {
  S.view = 'home'
  S.paper = null
  ZHOU.hide()
  $('#btnBack').hidden = true
  $('#barTitle').textContent = '判一句'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const todayCount = STORE.attempts.filter((a) => a.date === today()).length
  const papersDone = (STORE.papers || []).length

  const hero = el('div', 'hero')
  hero.innerHTML = `
    <div class="hero-num">${todayCount}<small> 题</small></div>
    <div class="hero-cap">${
      todayCount >= 5
        ? '今天做过了。够了。'
        : todayCount > 0
        ? '一天一篇（5 题）就够，别贪多。'
        : '一篇 5 题，约 18 分钟。'
    }</div>
    ${papersDone ? `<div class="tiny mt-8">已练 ${papersDone} 篇</div>` : ''}
  `
  app.appendChild(hero)

  const menu = el('div', 'menu')

  const items = [
    {
      ico: '◈',
      main: '开始一篇',
      sub: '通读全文 → 抓主旨 → 5 题连做 → 结算',
      on: () => {
        pickPaper()
        viewPassage()
      },
    },
    {
      ico: '◎',
      main: '错因库',
      sub: `你错过的 ${new Set(STORE.attempts.filter((a) => !a.ok).map((a) => a.qid)).size} 题`,
      on: viewWrongs,
    },
    {
      ico: '▤',
      main: '三条能力',
      sub: '判题型 / 定段位 / 排错项',
      on: viewStats,
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
// 视图：通读全文 + 写主旨
// ═══════════════════════════════════════════════════════════

function viewPassage() {
  S.view = 'passage'
  const p = S.paper
  $('#btnBack').hidden = false
  $('#btnBack').onclick = () => {
    if (confirm('这一篇还没开始做，回首页？')) viewHome()
  }
  $('#barTitle').textContent = paperName(p)
  $('#barRight').textContent = `${p.questions.length} 题`
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  // 说明
  const tip = el('div', 'step-tip')
  tip.innerHTML = `
    <div class="step-tip-num">1</div>
    <div>
      <div class="step-tip-title">先通读，别做题</div>
      <div class="step-tip-sub">读完在下面写一句主旨。写完才开始做题。</div>
    </div>
  `
  app.appendChild(tip)

  // 全文
  const card = el('div', 'card passage-card')
  for (const para of p.paragraphs) {
    const row = el('div', 'passage-para')
    row.innerHTML = `<span class="passage-no">${para.n}</span><span class="passage-txt">${esc(para.text)}</span>`
    card.appendChild(row)
  }
  app.appendChild(card)

  // 主旨输入
  const ideaBox = el('div', 'card idea-card')
  ideaBox.appendChild(el('h3', 'h-sec', '这篇文章在说什么？（一句话）'))
  const ta = el('textarea')
  ta.className = 'idea-input'
  ta.rows = 3
  ta.placeholder = '例：作者认为自动化让中产受损，政策却没跟上。'
  ta.value = S.mainIdea || ''
  ta.oninput = () => {
    S.mainIdea = ta.value
    btn.disabled = ta.value.trim().length < 6
  }
  ideaBox.appendChild(ta)

  const btn = el('button', 'btn btn-primary btn-block mt-14')
  btn.textContent = '开始做题 →'
  btn.disabled = (S.mainIdea || '').trim().length < 6
  btn.onclick = () => {
    S.mainIdea = ta.value.trim()
    startQuiz()
  }
  ideaBox.appendChild(btn)
  ideaBox.appendChild(
    el('div', 'tiny mt-8', '写不出来就写"没读懂"——那也是一个诚实的判断。')
  )
  app.appendChild(ideaBox)
}

// ═══════════════════════════════════════════════════════════
// 开始做题
// ═══════════════════════════════════════════════════════════

function startQuiz() {
  S.idx = 0
  S.view = 'quiz'
  window.scrollTo({ top: 0 })
  viewQuiz()
}

function viewQuiz() {
  S.view = 'quiz'
  const p = S.paper
  const q = curQ()
  S.gate = 0
  S.hintsUsed = 0
  S.blockedCount = 0
  S.gate1Missed = false
  S.gate1FirstTry = false
  S.gate2Missed = false
  S.gate2FirstTry = false

  $('#btnBack').hidden = false
  $('#btnBack').onclick = () => {
    if (confirm('这一篇做到一半，回首页？进度不保留。')) viewHome()
  }
  $('#barTitle').textContent = paperName(p)
  $('#barRight').textContent = `第 ${S.idx + 1} / ${p.questions.length} 题`
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  // 进度点
  const prog = el('div', 'qprog')
  for (let i = 0; i < p.questions.length; i++) {
    const d = el('span', 'qprog-dot')
    if (i < S.idx) d.classList.add('done')
    if (i === S.idx) d.classList.add('now')
    prog.appendChild(d)
  }
  app.appendChild(prog)

  // 题干
  const stem = el('p', 'stem')
  stem.textContent = `${q.num}. ${q.stem}`
  app.appendChild(stem)

  // 选项
  const opts = el('div', 'opts')
  for (const L of ['A', 'B', 'C', 'D']) {
    const b = el('button', 'opt')
    b.dataset.letter = L
    b.innerHTML = `<span class="opt-letter">${L}</span><span>${esc(q.options[L] || '')}</span>`
    b.onclick = () => onChoose(L, b)
    opts.appendChild(b)
  }
  app.appendChild(opts)

  // 提示区
  const hintZone = el('div', 'hint-ladder')
  hintZone.id = 'hintZone'
  app.appendChild(hintZone)

  // 提示按钮（始终可见）
  const hintBtn = el('button', 'btn btn-ghost btn-block mt-14')
  hintBtn.id = 'hintBtn'
  hintBtn.textContent = '卡住了？要一格提示'
  hintBtn.onclick = () => useHint()
  app.appendChild(hintBtn)

  askGate1()
}

// ═══════════════════════════════════════════════════════════
// 三关（第 3 关是「自己作答」，不是排错项）
// ═══════════════════════════════════════════════════════════

function askGate1() {
  const q = curQ()
  ZHOU.say('第 1 关。这题问的是什么？先判题型。', [])

  const box = $('#zhouActs')
  box.innerHTML = ''
  for (const t of QTYPES) {
    const b = el('button', 'zhou-act')
    b.textContent = t
    b.onclick = () => {
      if (t === q.qtype) {
        S.gate = 2
        if (!S.gate1Missed) S.gate1FirstTry = true
        b.style.background = 'var(--ok-bg)'
        b.style.borderColor = 'var(--ok)'
        b.style.color = 'var(--ok)'
        setTimeout(() => askGate2(), 360)
      } else {
        S.gate1Missed = true
        b.style.background = 'var(--bad-bg)'
        b.style.borderColor = 'var(--bad)'
        b.style.color = 'var(--bad)'
        b.disabled = true
        ZHOU.say(`不是「${t}」。再看题干——问事实、问原因，还是问推断？`, [
          { label: '我再试', primary: true, on: () => askGate1() },
          { label: '给个提示', on: () => useHint() },
        ])
      }
    }
    box.appendChild(b)
  }
  ZHOU.reserve()
}

function askGate2() {
  const p = S.paper
  const q = curQ()
  if (!q.locate) {
    S.gate = 3
    return askGate3()
  }
  const correct = q.locate.para
  ZHOU.say('第 2 关。依据在第几段？想想上一题到哪了，顺着往下找。', [])

  const box = $('#zhouActs')
  box.innerHTML = ''
  const total = p.paragraphs.length
  for (let n = 1; n <= total; n++) {
    const b = el('button', 'zhou-act')
    b.textContent = `${n}`
    b.onclick = () => {
      if (n === correct) {
        S.gate = 3
        if (!S.gate2Missed) S.gate2FirstTry = true
        b.style.background = 'var(--ok-bg)'
        b.style.borderColor = 'var(--ok)'
        b.style.color = 'var(--ok)'
        // 定位成功后，把那一句亮出来
        showLocatedSentence(q)
        setTimeout(() => askGate3(), 360)
      } else {
        S.gate2Missed = true
        b.style.background = 'var(--bad-bg)'
        b.style.borderColor = 'var(--bad)'
        b.style.color = 'var(--bad)'
        b.disabled = true
        const dir = n < correct ? '往后' : '往前'
        ZHOU.say(`不是第 ${n} 段。${dir}看。`, [
          { label: '我再找', primary: true, on: () => askGate2() },
          { label: '给个提示', on: () => useHint() },
        ])
      }
    }
    box.appendChild(b)
  }
  ZHOU.reserve()
}

// 第 3 关：自己选答案。不判对错，选完就进下一题。
function askGate3() {
  S.gate = 3
  ZHOU.say('第 3 关。按你找到的依据，自己选。选完直接下一题，不告诉你对错。', [
    { label: '给个提示', quiet: true, on: () => useHint() },
  ])
}

// 定位成功后把原文那句高亮出来
function showLocatedSentence(q) {
  if (!q.locate) return
  const zone = $('#locatedZone')
  if (zone) zone.remove()
  const box = el('div', 'located-box')
  box.id = 'locatedZone'
  box.innerHTML = `
    <div class="located-head">第 ${q.locate.para} 段 · 依据句</div>
    <div class="located-text">${esc(q.locate.text)}</div>
  `
  const anchor = $('#hintZone')
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor)
  else $('#app').appendChild(box)
  ZHOU.reserve()
}

// ═══════════════════════════════════════════════════════════
// 提示阶梯
// ═══════════════════════════════════════════════════════════

function hintFor(gate) {
  const q = curQ()
  const para = q.locate?.para
  const lv = S.hintsUsed

  if (gate <= 1) {
    const ladder = [
      '看题干怎么问：what / which 是细节，imply / suggest / learn 是推断，main idea / title 是主旨，attitude / tone 是态度。',
      '题干里有没有 "mentioned to" / "in order to"？有的话是例证目的题。',
      '再看一遍选项。四个都是完整句子且互相接近 → 多半是推断；四个都是短语 → 多半是细节。',
      `这题是 ${q.qtype}。`,
      `这题是 ${q.qtype}。`,
      `这题是 ${q.qtype}。`,
    ]
    return ladder[Math.min(lv - 1, 5)]
  }

  if (gate === 2) {
    const ladder = [
      '题干报段号了吗（Paragraph 2 / the last paragraph）？报了直接用。',
      '没报就看关键词——题干里那个专有名词，去原文找它第一次出现的地方。',
      para ? `大致在第 ${para} 段附近。` : '按顺序找，题号顺序通常和段落一致。',
      para ? `就在第 ${para} 段。` : '',
      para ? `第 ${para} 段。` : '',
      para ? `第 ${para} 段。` : '',
    ]
    return ladder[Math.min(lv - 1, 5)]
  }

  // 第 3 关：只帮到"找替换"，不给答案
  const p = q.pairs?.[0]
  const ladder = [
    '把定位句改写成一句大白话，再看哪个选项跟它意思一样。',
    '同一个意思会用不同的词说。找同义替换，不是找原词。',
    '逐项排除：原文没提的划掉，意思反了的划掉。',
    p ? `原文这边是「${p.orig}」——哪个选项在说这件事？` : '找那个长得最不像原文的选项。',
    p ? `「${p.orig}」＝「${p.opt}」。` : '',
    '',
  ]
  return ladder[Math.min(lv - 1, 4)] || ''
}

function useHint() {
  if (S.hintsUsed >= 6) {
    ZHOU.say('提示用完了。按你现在的判断选吧。', [
      { label: '好', primary: true, on: () => askGate3() },
    ])
    return
  }
  S.hintsUsed++
  const line = hintFor(S.gate)
  const zone = $('#hintZone')
  if (zone) {
    const n = el('div', 'hint-line is-fresh')
    n.textContent = `提示 ${S.hintsUsed}/6 · ${line}`
    zone.appendChild(n)
    n.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  ZHOU.reserve()
}

// ═══════════════════════════════════════════════════════════
// 选答案
// ═══════════════════════════════════════════════════════════

function onChoose(letter, btn) {
  if (S.gate < 3) {
    S.blockedCount++
    btn.classList.add('blocked')
    setTimeout(() => btn.classList.remove('blocked'), 340)
    ZHOU.say(
      S.gate === 1
        ? '先别选。这题问的是什么，你还没判。'
        : '先别选。依据在第几段，你还没定。',
      [
        { label: '好，我回去想', primary: true, on: () => (S.gate === 1 ? askGate1() : askGate2()) },
        { label: '给个提示', on: () => useHint() },
      ]
    )
    return
  }

  const q = curQ()
  S.answers[S.idx] = {
    letter,
    typeFirstTry: !!S.gate1FirstTry,
    paraFirstTry: !!S.gate2FirstTry,
    hints: S.hintsUsed,
    blocked: S.blockedCount,
    ok: letter === q.answer,
  }

  // 立刻下一题——不揭示对错
  nextQuestion()
}

function nextQuestion() {
  if (S.idx < S.paper.questions.length - 1) {
    S.idx++
    window.scrollTo({ top: 0 })
    viewQuiz()
  } else {
    finishQuiz()
  }
}

// ═══════════════════════════════════════════════════════════
// 结算
// ═══════════════════════════════════════════════════════════

function finishQuiz() {
  S.view = 'result'
  const p = S.paper
  ZHOU.hide()
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  // 落库
  const rightCount = S.answers.filter((a) => a?.ok).length
  STORE.papers = STORE.papers || []
  STORE.papers.push({
    id: p.id,
    year: p.year,
    part: p.part,
    date: today(),
    mainIdea: S.mainIdea,
    right: rightCount,
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
      hints: a.hints,
      blocked: a.blocked,
      typeFirstTry: a.typeFirstTry,
      paraFirstTry: a.paraFirstTry,
      kind: 'paper',
      flagPicked: null,
      tagTries: 0,
      tagFirstRight: 0,
    })
  })
  STORE.lastDate = today()
  saveStore()

  // 错题排队
  S.reviewQueue = p.questions
    .map((q, i) => (S.answers[i] && !S.answers[i].ok ? i : -1))
    .filter((i) => i >= 0)
  S.reviewPos = 0

  const app = $('#app')
  app.innerHTML = ''

  const head = el('div', 'result-head')
  const grade =
    rightCount === 5 ? '满分' : rightCount >= 3 ? '过线' : '要再看'
  head.innerHTML = `
    <div class="result-big ${rightCount >= 3 ? 'ok' : 'bad'}">${rightCount}<span class="result-total">/5</span></div>
    <div class="result-sub">${grade}</div>
  `
  app.appendChild(head)

  // 逐题对错表
  const table = el('div', 'card')
  table.appendChild(el('h3', 'h-sec', '这篇的结果'))
  const headRow = el('div', 'res-row res-head')
  headRow.innerHTML = `
    <span class="res-no">题</span>
    <span class="res-type">题型</span>
    <span class="res-pick">你</span>
    <span class="res-ans">答</span>
    <span></span>
  `
  table.appendChild(headRow)
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

  // 主旨对照
  const idea = el('div', 'card')
  idea.appendChild(el('h3', 'h-sec', '你写的主旨'))
  idea.appendChild(el('div', 'idea-echo', esc(S.mainIdea || '（没写）')))
  idea.appendChild(
    el(
      'div',
      'tiny mt-8',
      '对照一下：你做完 5 题之后，回头改主旨会更准。这是训练的一部分。'
    )
  )
  app.appendChild(idea)

  // 按钮
  const wrap = el('div', 'mt-20')
  if (S.reviewQueue.length) {
    const b = el('button', 'btn btn-primary btn-block')
    b.textContent = `复盘 ${S.reviewQueue.length} 道错题 →`
    b.onclick = () => {
      S.reviewPos = 0
      viewReview()
    }
    wrap.appendChild(b)
  } else {
    const b = el('button', 'btn btn-primary btn-block')
    b.textContent = '全对。再练一篇 →'
    b.onclick = () => {
      pickPaper()
      viewPassage()
    }
    wrap.appendChild(b)
  }

  const b2 = el('button', 'btn btn-ghost btn-block mt-8')
  b2.textContent = '回首页'
  b2.onclick = viewHome
  wrap.appendChild(b2)
  app.appendChild(wrap)
}

// ═══════════════════════════════════════════════════════════
// 复盘：只对错题，先看答案再排错项
// ═══════════════════════════════════════════════════════════

function viewReview() {
  if (S.reviewPos >= S.reviewQueue.length) return viewReviewDone()

  S.view = 'review'
  const p = S.paper
  const qi = S.reviewQueue[S.reviewPos]
  const q = p.questions[qi]
  const a = S.answers[qi]

  $('#barTitle').textContent = '复盘'
  $('#barRight').textContent = `${S.reviewPos + 1} / ${S.reviewQueue.length}`
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  ZHOU.say('这题错了。先看正确答案，然后把三个错项各归一类。', [])

  const head = el('div', 'result-head')
  head.innerHTML = `
    <div class="res-badge">第 ${q.num} 题</div>
    <div class="result-sub">你选 ${a.letter} · 答案 ${q.answer} · ${esc(q.qtype)}</div>
  `
  app.appendChild(head)

  // 题干 + 选项（标出对错）
  const card = el('div', 'card')
  const stem = el('p', 'stem')
  stem.style.fontSize = '16.5px'
  stem.textContent = `${q.num}. ${q.stem}`
  card.appendChild(stem)

  const opts = el('div', 'opts')
  for (const L of ['A', 'B', 'C', 'D']) {
    const row = el('div', 'opt opt-ro')
    if (L === q.answer) row.classList.add('is-right')
    else if (L === a.letter) row.classList.add('is-wrong')
    else row.classList.add('is-dim')
    row.innerHTML = `<span class="opt-letter">${L}</span><span>${esc(q.options[L] || '')}</span>`
    opts.appendChild(row)
  }
  card.appendChild(opts)
  app.appendChild(card)

  // 依据句
  if (q.locate) {
    const lb = el('div', 'card')
    lb.appendChild(el('h3', 'h-sec', `依据句 · 第 ${q.locate.para} 段`))
    lb.appendChild(el('div', 'located-text', esc(q.locate.text)))
    app.appendChild(lb)
  }

  // 替换对
  if (q.pairs?.length) {
    const pc = el('div', 'card')
    pc.appendChild(el('h3', 'h-sec', '正确项为什么对'))
    const list = el('div', 'pair-list')
    for (const pr of q.pairs) {
      const n = el('div', 'pair')
      n.innerHTML = `<div class="pair-a">${esc(pr.orig)}</div><div class="pair-b">${esc(pr.opt)}</div>`
      list.appendChild(n)
    }
    pc.appendChild(list)
    app.appendChild(pc)
  }

  // 贴标签
  const tc = el('div', 'card')
  tc.appendChild(el('h3', 'h-sec', '三个错项各错在哪一类'))
  const wrongLetters = ['A', 'B', 'C', 'D'].filter((L) => L !== q.answer)
  const remain = new Set(wrongLetters)
  let missedAny = {}

  for (const L of wrongLetters) {
    const item = el('div', 'tag-item pending')
    item.innerHTML = `
      <div class="tag-item-letter">${L}</div>
      <div class="tag-item-body">
        <div class="tag-item-text">${esc(q.options[L] || '')}</div>
        <div class="tag-grid"></div>
      </div>
    `
    const grid = $('.tag-grid', item)
    const body = $('.tag-item-body', item)
    for (const f of FLAGS) {
      const b = el('button', 'tag-btn')
      b.textContent = f
      b.onclick = () => {
        S.reviewTagTries++
        if (f === q.distractors[L]) {
          if (!missedAny[L]) S.reviewTagFirstRight++
          item.classList.remove('pending')
          item.classList.add('done')
          b.classList.add('picked')
          for (const x of $$('button', grid)) x.disabled = true
          const ok = el('div', 'rev-ok')
          ok.textContent = `✓ ${f}`
          body.appendChild(ok)
          if (FLAG_HINT[f]) {
            const hint = el('div', 'rev-note ok-note')
            hint.textContent = FLAG_HINT[f]
            body.appendChild(hint)
          }
          S.reviewFlagsPicked[q.num] = (S.reviewFlagsPicked[q.num] || 0) + 1
          remain.delete(L)
          if (remain.size === 0) showNextReviewBtn()
        } else {
          missedAny[L] = true
          b.classList.add('picked', 'wrong')
          b.disabled = true
          const n = el('div', 'rev-note')
          n.textContent = `「${f}」不对，再想。`
          body.appendChild(n)
        }
      }
      grid.appendChild(b)
    }
    tc.appendChild(item)
  }
  app.appendChild(tc)

  const nextZone = el('div', 'mt-20')
  nextZone.id = 'reviewNext'
  app.appendChild(nextZone)
}

function showNextReviewBtn() {
  const zone = $('#reviewNext')
  if (!zone || $('#revNext')) return
  const b = el('button', 'btn btn-primary btn-block')
  b.id = 'revNext'
  b.textContent =
    S.reviewPos + 1 < S.reviewQueue.length ? '下一道错题 →' : '完成复盘 →'
  b.onclick = () => {
    S.reviewPos++
    viewReview()
  }
  zone.appendChild(b)
}

function viewReviewDone() {
  // 把复盘计量写回记录
  const p = S.paper
  for (const qi of S.reviewQueue) {
    const q = p.questions[qi]
    const rec = [...STORE.attempts].reverse().find((x) => x.qid === `${p.id}#${q.num}`)
    if (!rec) continue
    rec.flagPicked = S.reviewFlagsPicked[q.num] ? true : null
    rec.tagTries = S.reviewTagTries
    rec.tagFirstRight = S.reviewTagFirstRight
  }
  saveStore()

  S.view = 'reviewDone'
  ZHOU.hide()
  window.scrollTo({ top: 0 })
  $('#barTitle').textContent = '复盘完成'
  $('#barRight').textContent = ''

  const app = $('#app')
  app.innerHTML = ''

  const done = el('div', 'hero')
  done.innerHTML = `
    <div class="hero-num">✓</div>
    <div class="hero-cap">这一篇复盘完了</div>
  `
  app.appendChild(done)

  const card = el('div', 'card')
  card.appendChild(el('h3', 'h-sec', '下一步'))
  card.appendChild(
    el(
      'div',
      'tiny',
      '同一天别重复做同一篇。明天再做新的一篇，错因库会自动带你回到这类题。'
    )
  )
  app.appendChild(card)

  const wrap = el('div', 'mt-20')
  const b = el('button', 'btn btn-primary btn-block')
  b.textContent = '再练一篇 →'
  b.onclick = () => {
    pickPaper()
    viewPassage()
  }
  wrap.appendChild(b)
  const b2 = el('button', 'btn btn-ghost btn-block mt-8')
  b2.textContent = '回首页'
  b2.onclick = viewHome
  wrap.appendChild(b2)
  app.appendChild(wrap)
}

// ═══════════════════════════════════════════════════════════
// 视图：三条能力
// ═══════════════════════════════════════════════════════════

function viewStats() {
  S.view = 'stats'
  S.paper = null
  ZHOU.hide()
  $('#btnBack').hidden = false
  $('#btnBack').onclick = viewHome
  $('#barTitle').textContent = '三条能力'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const attempts = STORE.attempts
  const judged = attempts.filter((a) => typeof a.typeFirstTry === 'boolean')
  const located = attempts.filter((a) => typeof a.paraFirstTry === 'boolean')

  let tagTries = 0
  let tagFirst = 0
  for (const a of attempts) {
    if (!a.tagTries) continue
    tagTries += a.tagTries
    tagFirst += a.tagFirstRight || 0
  }

  const rate = (list, key) =>
    list.length ? Math.round((list.filter((a) => a[key]).length / list.length) * 100) : 0

  const rows = [
    {
      name: '判题型',
      pct: rate(judged, 'typeFirstTry'),
      n: judged.length,
      cls: 's1',
      note: '第 1 关第一次就选对题型的比例',
    },
    {
      name: '定段位',
      pct: rate(located, 'paraFirstTry'),
      n: located.length,
      cls: 's2',
      note: '第 2 关第一次就指对段落的比例',
    },
    {
      name: '排错项',
      pct: tagTries ? Math.round((tagFirst / tagTries) * 100) : 0,
      n: tagTries,
      cls: 's3',
      note: tagTries ? `贴标签一次就对的比例（${tagTries} 次贴）` : '复盘时贴错项标签，一次贴对才算',
    },
  ]

  const c = el('div', 'card')
  c.appendChild(el('h3', 'h-sec', '三条能力'))
  if (!attempts.length) {
    c.appendChild(el('div', 'tiny', '还没做过题。做一篇就有数了。'))
  } else {
    for (const r of rows) {
      const row = el('div', 'skill')
      row.innerHTML = `
        <div class="skill-top">
          <span class="skill-name">${r.name}</span>
          <span class="skill-val">${r.pct}%${r.n ? ` · ${r.n}` : ''}</span>
        </div>
        <div class="skill-track"><div class="skill-fill ${r.cls}" style="width:${r.pct}%"></div></div>
        <div class="tiny mt-8">${r.note}</div>
      `
      c.appendChild(row)
    }
  }
  app.appendChild(c)

  // 错因分布
  const counts = {}
  for (const a of attempts) {
    if (a.ok) continue
    const p = S.papers.find((x) => x.id === a.paperId)
    const q = p?.questions.find((x) => x.num === a.qnum)
    if (!q) continue
    const f = q.distractors[a.chosen]
    if (f) counts[f] = (counts[f] || 0) + 1
  }
  const max = Math.max(1, ...Object.values(counts))

  const c2 = el('div', 'card')
  c2.appendChild(el('h3', 'h-sec', '你错在哪些类'))
  if (!Object.keys(counts).length) {
    c2.appendChild(el('div', 'tiny', '还没错过题。'))
  } else {
    const bars = el('div', 'flag-bars')
    for (const f of FLAGS) {
      const v = counts[f] || 0
      const row = el('div', 'flag-row')
      row.innerHTML = `
        <span class="flag-name">${f}</span>
        <span class="flag-track"><span class="flag-fill" style="width:${(v / max) * 100}%"></span></span>
        <span class="flag-num">${v}</span>
      `
      bars.appendChild(row)
    }
    c2.appendChild(bars)
    c2.appendChild(el('div', 'tiny mt-14', '最高的那一格就是你最该练的那一格。'))
  }
  app.appendChild(c2)

  // 做过的篇
  const pl = STORE.papers || []
  if (pl.length) {
    const c3 = el('div', 'card')
    c3.appendChild(el('h3', 'h-sec', `做过的 ${pl.length} 篇`))
    for (const x of pl.slice(-10).reverse()) {
      const row = el('div', 'row-between')
      row.style.marginBottom = '8px'
      row.innerHTML = `<span class="tiny">${x.year} 年 · 阅读 ${x.part}</span><span class="chip ${x.right >= 3 ? 'chip-ok' : 'chip-bad'}">${x.right}/5</span>`
      c3.appendChild(row)
    }
    app.appendChild(c3)
  }

  // 数据
  const c4 = el('div', 'card')
  c4.appendChild(el('h3', 'h-sec', '数据'))
  c4.appendChild(el('div', 'tiny', `共 ${attempts.length} 次作答，存在这个浏览器里。`))
  const row = el('div', 'row-between mt-14')
  const exp = el('button', 'btn', '导出 JSON')
  exp.onclick = () => {
    const blob = new Blob([JSON.stringify({ store: STORE, at: new Date().toISOString() }, null, 2)], {
      type: 'application/json',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `panyiju-${today()}.json`
    a.click()
  }
  const clr = el('button', 'btn btn-ghost', '清空记录')
  clr.onclick = () => {
    if (confirm('清空所有作答记录？不能撤销。')) {
      localStorage.removeItem(STORE_KEY)
      STORE = loadStore()
      viewStats()
    }
  }
  row.appendChild(exp)
  row.appendChild(clr)
  c4.appendChild(row)
  app.appendChild(c4)
}

// ═══════════════════════════════════════════════════════════
// 视图：错因库
// ═══════════════════════════════════════════════════════════

function viewWrongs() {
  S.view = 'wrongs'
  S.paper = null
  ZHOU.hide()
  $('#btnBack').hidden = false
  $('#btnBack').onclick = viewHome
  $('#barTitle').textContent = '错因库'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const app = $('#app')
  app.innerHTML = ''

  const wrongs = STORE.attempts.filter((a) => !a.ok)
  if (!wrongs.length) {
    const e = el('div', 'empty')
    e.innerHTML = `<div class="empty-ico">◎</div><div>还没错过题。</div>`
    app.appendChild(e)
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
    c.appendChild(el('div', 'tiny mt-8', FLAG_HINT[f] || ''))

    for (const { a, p, q } of list.slice(0, 6)) {
      const item = el('div', 'mt-14')
      item.style.borderTop = '1px solid var(--line)'
      item.style.paddingTop = '11px'
      item.innerHTML = `
        <div class="tiny">${esc(paperName(p))} · 第 ${q.num} 题 · 你选 ${a.chosen}</div>
        <div style="font-family:var(--font-en);font-size:15px;margin:5px 0">${esc(q.stem)}</div>
        <div class="tiny">正确项：${esc(q.options[q.answer] || '')}</div>
      `
      c.appendChild(item)
    }
    app.appendChild(c)
  }
}

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

async function boot() {
  STORE = loadStore()
  if (!STORE.papers) STORE.papers = []

  try {
    const res = await fetch('./data/papers.json', { cache: 'force-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    S.papers = await res.json()
  } catch (e) {
    $('#app').innerHTML = `
      <div class="empty">
        <div class="empty-ico">⚠</div>
        <div>题库加载失败</div>
        <div class="tiny mt-8">${esc(e.message)}</div>
        <div class="tiny mt-8">如果是 file:// 打开的，请用本地服务器。</div>
      </div>`
    return
  }

  if (!S.papers.length) {
    $('#app').innerHTML = `<div class="empty">题库是空的。</div>`
    return
  }

  viewHome()
}

boot()
