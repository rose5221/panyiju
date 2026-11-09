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
      sub: '通读全文 → 四步抓主旨 → 5 题连做 → 结算',
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
    {
      ico: '✦',
      main: 'AI 教练',
      sub: aiReady() ? '已接好，做题时可以问' : '还没接，点这里填 API Key',
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
// 视图：通读全文 + 写主旨
// ═══════════════════════════════════════════════════════════

function viewPassage() {
  S.view = 'passage'
  const p = S.paper
  S.miStep = 0 // 主旨四步，0 = 还没开始
  S.miHistory = []
  S.miNotes = { 1: '', 2: '', 3: '', 4: '' }
  S.miJudge = ''

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
      <div class="step-tip-sub">读完跟着下面的四步走。选中文字就能划线做标记。</div>
    </div>
  `
  app.appendChild(tip)

  // 全文
  const card = el('div', 'card passage-card')
  card.id = 'passageCard'
  for (const para of p.paragraphs) {
    const row = el('div', 'passage-para')
    row.dataset.para = para.n
    row.innerHTML = `<span class="passage-no">${para.n}</span><span class="passage-txt" data-mtext="${para.n}"></span>`
    card.appendChild(row)
  }
  app.appendChild(card)

  // 划标记：选中文字就打线
  enableMarking(card, p.id, p.paragraphs, () => {
    const n = countMarks(p.id)
    const el2 = $('#markCount')
    if (el2) el2.textContent = n ? `已划 ${n} 处` : ''
  })

  // 四步引导区
  const guide = el('div')
  guide.id = 'miGuide'
  app.appendChild(guide)

  renderMainIdeaGuide()
}

// ── 主旨四步 ──────────────────────────────────────────────
const MI_STEPS = [
  {
    n: 1,
    title: '看首段和末段',
    method: '作者把结论放在这两处。先只看 P1 和最后一段，别管中间。',
    question: '这两段在谈什么对象、什么事？用你自己的话讲。',
    hint: '找这两段里反复出现的名词——那就是话题。',
  },
  {
    n: 2,
    title: '看每段第一句',
    method: '段落主题句八成在第一句。扫一遍每段开头，看文章怎么推进。',
    question: '挑三段，各用一句话说它在干什么（举例？反驳？下结论？）',
    hint: '别抄原文，用自己的话说段落"在做什么"。',
  },
  {
    n: 3,
    title: '找转折词',
    method: 'but / however / yet / in fact / actually 后面才是作者真意。前面多半是别人的观点。',
    question: '原文里有几个转折？转折后面讲了什么？',
    hint: '转折句往往就是主旨句。找到它你就抓到了七成。',
  },
  {
    n: 4,
    title: '看作者态度',
    method: '作者是支持、批评、担忧，还是中立？态度词通常藏在形容词和副词里。',
    question: '作者对这个话题什么态度？给一个理由。',
    hint: '看有没有 "should" / "unfortunately" / "rightly" 这类词。',
  },
]

function renderMainIdeaGuide() {
  const zone = $('#miGuide')
  if (!zone) return
  zone.innerHTML = ''
  const step = S.miStep

  // 已完成的步骤回看
  for (let i = 1; i <= Math.min(step, 4); i++) {
    const done = el('div', 'mi-done')
    done.innerHTML = `
      <span class="mi-done-mark">✓</span>
      <div>
        <div class="mi-done-title">第 ${i} 步 · ${MI_STEPS[i - 1].title}</div>
        <div class="mi-done-said">${esc(S.miNotes[i] || '（跳过了）')}</div>
      </div>
    `
    zone.appendChild(done)
  }

  // 当前步
  if (step < 4) {
    const cur = MI_STEPS[step]
    const card = el('div', 'card mi-card')
    card.innerHTML = `
      <div class="mi-head">
        <span class="mi-step">第 ${cur.n} 步 / 4</span>
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
    next.textContent = step === 3 ? '写主旨 →' : '下一步 →'
    next.disabled = true
    ta.oninput = () => {
      next.disabled = ta.value.trim().length < 2
    }

    const hint = el('button', 'btn btn-ghost')
    hint.textContent = '给个提示'
    hint.onclick = () => {
      const h = el('div', 'mi-hint')
      h.textContent = '提示：' + cur.hint
      card.insertBefore(h, row)
      hint.disabled = true
    }

    const askAi = el('button', 'btn btn-ghost')
    askAi.textContent = '问教练'
    askAi.onclick = () => {
      if (!aiReady()) {
        const h = el('div', 'mi-hint')
        h.textContent = '还没配 AI。去设定页填 API Key 就能问。'
        card.insertBefore(h, row)
        return
      }
      runAiMainIdea(step, ta.value.trim(), card)
    }

    next.onclick = () => {
      S.miNotes[cur.n] = ta.value.trim()
      S.miStep = step + 1
      renderMainIdeaGuide()
      // 滚动到新步骤
      setTimeout(() => {
        const g = $('#miGuide')
        if (g) g.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }, 60)
    }

    row.appendChild(next)
    row.appendChild(hint)
    row.appendChild(askAi)
    card.appendChild(row)
    zone.appendChild(card)
  } else {
    // 四步走完 → 写主旨
    renderIdeaInput(zone)
  }
}

async function runAiMainIdea(step, said, card) {
  const box = el('div', 'mi-ai')
  box.textContent = '教练正在想…'
  card.appendChild(box)
  box.scrollIntoView({ block: 'center', behavior: 'smooth' })

  try {
    let full = ''
    const h = S.miHistory || []
    if (said) h.push({ role: 'user', content: said })
    await aiTeachMainIdea(S.paper, step + 1, said, h, (d, acc) => {
      full = acc
      box.textContent = acc
    })
    h.push({ role: 'assistant', content: full })
    S.miHistory = h
  } catch (e) {
    box.textContent = '出错了：' + e.message
  }
}

function renderIdeaInput(zone) {
  const ideaBox = el('div', 'card idea-card')

  // 标题行：左边写主旨，右边告诉你划了几处
  const head = el('div', 'row-between')
  head.appendChild(el('h3', 'h-sec', '现在，一句话写出主旨'))
  const cnt = el('span', 'mark-count')
  cnt.id = 'markCount'
  const refreshCnt = () => {
    const n = countMarks(S.paper.id)
    cnt.textContent = n ? `已划 ${n} 处` : ''
  }
  refreshCnt()
  head.appendChild(cnt)
  ideaBox.appendChild(head)

  // 把四步笔记摆出来，方便他合成
  const notes = el('div', 'mi-notes')
  for (let i = 1; i <= 4; i++) {
    if (!S.miNotes[i]) continue
    const n = el('div', 'mi-note')
    n.innerHTML = `<span class="mi-note-k">${MI_STEPS[i - 1].title}</span><span class="mi-note-v">${esc(S.miNotes[i])}</span>`
    notes.appendChild(n)
  }
  ideaBox.appendChild(notes)

  const ta = el('textarea')
  ta.className = 'idea-input'
  ta.rows = 3
  ta.placeholder = '例：作者认为自动化让中产受损，政策却没跟上。'
  ta.value = S.mainIdea || ''

  const btn = el('button', 'btn btn-primary btn-block mt-14')
  btn.textContent = '开始做题 →'
  btn.disabled = (S.mainIdea || '').trim().length < 6

  ta.oninput = () => {
    S.mainIdea = ta.value
    btn.disabled = ta.value.trim().length < 6
  }
  ideaBox.appendChild(ta)

  // 让 AI 判一下（可选）
  const judgeRow = el('div', 'mi-actions')
  const judgeBtn = el('button', 'btn btn-ghost')
  judgeBtn.textContent = '让教练看看我写的'
  judgeBtn.onclick = async () => {
    if (!aiReady()) {
      const h = el('div', 'mi-hint')
      h.textContent = '还没配 AI。去设定页填 API Key。'
      ideaBox.insertBefore(h, judgeRow)
      return
    }
    const idea = ta.value.trim()
    if (idea.length < 6) return
    const box = el('div', 'mi-ai')
    box.textContent = '教练正在看…'
    ideaBox.insertBefore(box, judgeRow)
    box.scrollIntoView({ block: 'center', behavior: 'smooth' })
    try {
      let full = ''
      await aiJudgeMainIdea(S.paper, idea, (d, acc) => {
        full = acc
        box.textContent = acc
      })
      S.miJudge = full
    } catch (e) {
      box.textContent = '出错了：' + e.message
    }
  }
  judgeRow.appendChild(judgeBtn)
  ideaBox.appendChild(judgeRow)

  btn.onclick = () => {
    S.mainIdea = ta.value.trim()
    startQuiz()
  }
  ideaBox.appendChild(btn)
  ideaBox.appendChild(
    el('div', 'tiny mt-8', '写不出来就写"没读懂"——那也是一个诚实的判断。')
  )
  zone.appendChild(ideaBox)
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
  S.aiHistory = []

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

  // 看原文按钮 —— 做题时随时能回原文，这是硬需求
  const passageBtn = el('button', 'passage-peek')
  passageBtn.innerHTML = `<span class="peek-ico">▤</span><span>看原文</span>`
  passageBtn.onclick = () => openPassageDrawer()
  app.appendChild(passageBtn)

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

  // 底部两个入口：提示 / 问教练
  const tools = el('div', 'quiz-tools')

  const hintBtn = el('button', 'tool-btn')
  hintBtn.innerHTML = `<span class="tool-ico">?</span><span>规则提示</span>`
  hintBtn.onclick = () => useHint()
  tools.appendChild(hintBtn)

  const aiBtn = el('button', 'tool-btn tool-btn-ai')
  aiBtn.innerHTML = `<span class="tool-ico">✦</span><span>问教练</span>`
  aiBtn.onclick = () => openCoach()
  tools.appendChild(aiBtn)

  app.appendChild(tools)

  askGate1()
}

// ═══════════════════════════════════════════════════════════
// 原文抽屉：从底部滑上来，定位后可高亮某段
// ═══════════════════════════════════════════════════════════

function openPassageDrawer(highlightPara) {
  const p = S.paper
  const old = $('#drawer')
  if (old) old.remove()

  const d = el('div', 'drawer')
  d.id = 'drawer'
  d.innerHTML = `
    <div class="drawer-mask"></div>
    <div class="drawer-panel">
      <div class="drawer-grip"></div>
      <div class="drawer-head">
        <span class="drawer-title">${esc(paperName(p))}</span>
        <button class="drawer-close" aria-label="收起">收起</button>
      </div>
      <div class="drawer-body"></div>
    </div>
  `
  const body = $('.drawer-body', d)
  for (const para of p.paragraphs) {
    const row = el('div', 'drawer-para')
    row.dataset.para = para.n
    if (highlightPara === para.n) row.classList.add('is-hit')
    row.innerHTML = `<span class="drawer-no">${para.n}</span><span class="drawer-txt" data-mtext="${para.n}"></span>`
    body.appendChild(row)
  }

  document.body.appendChild(d)
  document.body.style.overflow = 'hidden'
  // 抽屉里也能划线，跟通读页共用同一份标记
  enableMarking(body, p.id, p.paragraphs)
  requestAnimationFrame(() => d.classList.add('open'))

  const close = () => {
    d.classList.remove('open')
    document.body.style.overflow = ''
    setTimeout(() => d.remove(), 260)
  }
  $('.drawer-mask', d).onclick = close
  $('.drawer-close', d).onclick = close

  if (highlightPara) {
    setTimeout(() => {
      const hit = $(`.drawer-para[data-para="${highlightPara}"]`, d)
      if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 280)
  }
}

// ═══════════════════════════════════════════════════════════
// AI 教练面板（引导模式：模型拿不到答案）
// ═══════════════════════════════════════════════════════════

function openCoach() {
  if (!aiReady()) {
    ZHOU.say('还没配 AI。去设定页填一个 API Key，就能问我了。', [
      { label: '去设定', primary: true, on: () => viewSettings() },
      { label: '先不用', quiet: true, on: () => renderZhouForGate() },
    ])
    return
  }

  const q = curQ()
  const old = $('#coach')
  if (old) old.remove()

  const c = el('div', 'coach')
  c.id = 'coach'
  c.innerHTML = `
    <div class="coach-mask"></div>
    <div class="coach-panel">
      <div class="coach-head">
        <span class="coach-title">教练</span>
        <button class="drawer-close" id="coachClose">收起</button>
      </div>
      <div class="coach-log" id="coachLog"></div>
      <div class="coach-input">
        <textarea id="coachInput" rows="2" placeholder="说说你现在卡在哪，或者你的想法…"></textarea>
        <button class="coach-send" id="coachSend">问</button>
      </div>
      <div class="coach-tip">教练只引导，不给答案。答案得你自己找。</div>
    </div>
  `
  document.body.appendChild(c)
  document.body.style.overflow = 'hidden'
  requestAnimationFrame(() => c.classList.add('open'))

  const close = () => {
    c.classList.remove('open')
    document.body.style.overflow = ''
    setTimeout(() => c.remove(), 260)
  }
  $('.coach-mask', c).onclick = close
  $('#coachClose').onclick = close

  const log = $('#coachLog')
  const input = $('#coachInput')
  const sendBtn = $('#coachSend')

  const addMsg = (role, text) => {
    const m = el('div', 'coach-msg coach-' + role)
    m.textContent = text
    log.appendChild(m)
    log.scrollTop = log.scrollHeight
    return m
  }

  // 开场白：按当前关卡自动问
  // 开场白按当前关卡给。S.gate 在进题时是 0，得跟 1/2 一起算作"还没定题型"。
  const g = S.gate || 0
  const opener =
    g <= 1
      ? '这题你先别急着看选项。它问的是什么？你判断是哪个题型，为什么这么判断？'
      : g === 2
      ? '题干里哪个词最能帮你在原文定位？你打算怎么找？说说你的思路。'
      : '你已经找到依据了。先把那句话用大白话讲一遍，再看看哪个选项在说同一件事。'
  addMsg('ai', opener)

  let busy = false
  const ask = async () => {
    const text = input.value.trim()
    if (!text || busy) return
    input.value = ''
    addMsg('me', text)
    busy = true
    sendBtn.disabled = true

    const bubble = addMsg('ai', '')
    bubble.classList.add('typing')

    try {
      const hist = S.aiHistory || []
      hist.push({ role: 'user', content: text })
      let full = ''
      await aiGuideQuestion(S.paper, q, S.gate < 1 ? 1 : S.gate, text, hist, (delta, acc) => {
        full = acc
        bubble.textContent = acc
        log.scrollTop = log.scrollHeight
      })
      if (!bubble.textContent) bubble.textContent = full
      bubble.classList.remove('typing')
      hist.push({ role: 'assistant', content: full })
      S.aiHistory = hist
    } catch (e) {
      bubble.textContent = '出错了：' + e.message
      bubble.classList.remove('typing')
    } finally {
      busy = false
      sendBtn.disabled = false
      log.scrollTop = log.scrollHeight
    }
  }

  sendBtn.onclick = ask
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask()
  })
  setTimeout(() => input.focus(), 320)
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
    <div class="located-head">
      第 ${q.locate.para} 段 · 依据句
      <button class="loc-open">看整段</button>
    </div>
    <div class="located-text">${esc(q.locate.text)}</div>
  `
  $('.loc-open', box).onclick = () => openPassageDrawer(q.locate.para)
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

  // 这一篇的划线留着（下次重做还能看到），也可以主动清掉
  const mc = countMarks(p.id)
  if (mc) {
    const b3 = el('button', 'btn btn-ghost btn-block mt-8')
    b3.textContent = `清除这一篇的 ${mc} 处划线`
    b3.onclick = () => {
      if (!confirm(`清掉这篇的 ${mc} 处划线？`)) return
      clearPaperMarks(p.id)
      b3.remove()
      toast('已清除')
    }
    wrap.appendChild(b3)
  }

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

// ═══════════════════════════════════════════════════════════
// 视图：AI 设定
// ═══════════════════════════════════════════════════════════

function viewSettings() {
  S.view = 'settings'
  S.paper = null
  ZHOU.hide()
  $('#btnBack').hidden = false
  $('#btnBack').onclick = viewHome
  $('#barTitle').textContent = 'AI 教练'
  $('#barRight').textContent = ''
  window.scrollTo({ top: 0 })

  const cfg = loadAIConfig()
  const app = $('#app')
  app.innerHTML = ''

  // 说明
  const intro = el('div', 'card')
  intro.appendChild(el('h3', 'h-sec', '它做什么'))
  intro.innerHTML += `
    <div class="tiny" style="line-height:1.8">
      · 通读后带你走四步抓主旨，每步先讲方法再问你<br>
      · 做题卡住时给你引导，<b style="color:var(--ink)">但不给答案</b><br>
      · 答完才帮你复盘
    </div>
  `
  intro.appendChild(
    el(
      'div',
      'tiny mt-14',
      'Key 只存在你自己浏览器里，直接连你填的接口。不经过我这里，也没有任何中转。'
    )
  )
  app.appendChild(intro)

  // 预设
  const presetCard = el('div', 'card')
  presetCard.appendChild(el('h3', 'h-sec', '选一个'))
  const presetRow = el('div', 'preset-row')
  for (const pr of AI_PRESETS) {
    const isDeep = pr.id === 'deepseek'
    const b = el('button', 'preset-btn' + (isDeep ? ' preset-main' : ''))
    b.innerHTML = `
      <span class="preset-name">${pr.name}${isDeep ? ' <span class="preset-tag">推荐</span>' : ''}</span>
      <span class="preset-note">${pr.note}</span>
    `
    b.onclick = () => {
      fUrl.input.value = pr.baseUrl
      fModel.input.value = pr.models[0]
      // 模型下拉也跟着换
      renderModelOptions(pr.models, pr.models[0])
    }
    presetRow.appendChild(b)
  }
  presetCard.appendChild(presetRow)
  app.appendChild(presetCard)

  // 表单
  const form = el('div', 'card')
  form.appendChild(el('h3', 'h-sec', '接口设置'))

  const mk = (label, key, type, placeholder, hint) => {
    const box = el('div', 'mt-14')
    box.appendChild(el('label', 'set-label', label))
    const input = el('input')
    input.className = 'set-input'
    input.type = type
    input.placeholder = placeholder
    input.value = cfg[key] || ''
    box.appendChild(input)
    if (hint) box.appendChild(el('div', 'tiny mt-8', hint))
    return { box, input, key }
  }

  const fUrl = mk(
    '接口地址',
    'baseUrl',
    'text',
    'https://api.deepseek.com',
    '末尾不用带 /chat/completions，带了也认。'
  )
  const fKey = mk(
    'API Key',
    'apiKey',
    'password',
    'sk-…',
    '去 platform.deepseek.com 申请。只存在你这台设备上。'
  )

  // 模型：下拉 + 可手填
  const modelBox = el('div', 'mt-14')
  modelBox.appendChild(el('label', 'set-label', '模型'))
  const modelSel = el('select')
  modelSel.className = 'set-input set-select'
  modelBox.appendChild(modelSel)
  const modelFree = el('input')
  modelFree.className = 'set-input mt-8'
  modelFree.type = 'text'
  modelFree.placeholder = '或者手填模型名'
  modelFree.value = cfg.model || ''
  modelFree.style.display = 'none'
  modelBox.appendChild(modelFree)

  const toggleFree = el('button', 'set-link')
  toggleFree.textContent = '手动填模型名'
  toggleFree.onclick = () => {
    const showing = modelFree.style.display !== 'none'
    modelFree.style.display = showing ? 'none' : 'block'
    toggleFree.textContent = showing ? '手动填模型名' : '收回，用下拉'
  }
  modelBox.appendChild(toggleFree)

  function renderModelOptions(models, current) {
    modelSel.innerHTML = ''
    for (const m of models) {
      const o = el('option')
      o.value = m
      o.textContent = m
      if (m === current) o.selected = true
      modelSel.appendChild(o)
    }
    modelFree.value = current || models[0]
  }

  // 初始：按当前 baseUrl 猜预设
  const guess = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl) || AI_PRESETS[0]
  renderModelOptions(guess.models, cfg.model || guess.models[0])
  if (!guess.models.includes(cfg.model)) {
    modelFree.style.display = 'block'
    modelFree.value = cfg.model || ''
  }
  modelSel.onchange = () => {
    modelFree.value = modelSel.value
  }

  for (const f of [fUrl, fKey]) form.appendChild(f.box)
  form.appendChild(modelBox)

  // 取当前生效的模型
  const currentModel = () =>
    (modelFree.style.display !== 'none' ? modelFree.value : modelSel.value).trim() ||
    AI_DEFAULT.model

  app.appendChild(form)

  // 开关
  const sw = el('div', 'card')
  const swRow = el('div', 'row-between')
  swRow.innerHTML = `
    <div>
      <div style="font-size:15px;font-weight:600">启用 AI 教练</div>
      <div class="tiny mt-8">关掉就只用本地规则提示，其他功能照常</div>
    </div>
  `
  const toggle = el('button', 'switch' + (cfg.enabled ? ' on' : ''))
  toggle.innerHTML = '<span class="switch-dot"></span>'
  toggle.onclick = () => {
    cfg.enabled = !cfg.enabled
    toggle.classList.toggle('on', cfg.enabled)
    // 立刻存，避免用户以为开了其实没存
    saveAIConfig({
      ...loadAIConfig(),
      enabled: toggle.classList.contains('on'),
    })
    toast(toggle.classList.contains('on') ? 'AI 已启用' : 'AI 已关闭')
  }
  swRow.appendChild(toggle)
  sw.appendChild(swRow)
  app.appendChild(sw)

  // 按钮
  const acts = el('div', 'mt-20')

  const save = el('button', 'btn btn-primary btn-block')
  save.textContent = '保存'
  save.onclick = () => {
    const next = {
      ...cfg,
      baseUrl: fUrl.input.value.trim() || AI_DEFAULT.baseUrl,
      apiKey: fKey.input.value.trim(),
      model: currentModel(),
      enabled: toggle.classList.contains('on'),
    }
    saveAIConfig(next)
    toast('已保存')
  }
  acts.appendChild(save)

  const test = el('button', 'btn btn-block mt-8')
  test.textContent = '测试连通'
  test.onclick = async () => {
    const next = {
      ...cfg,
      baseUrl: fUrl.input.value.trim() || AI_DEFAULT.baseUrl,
      apiKey: fKey.input.value.trim(),
      model: currentModel(),
      enabled: true,
    }
    if (!next.apiKey) {
      toast('先填 API Key')
      return
    }
    saveAIConfig(next)
    test.disabled = true
    test.textContent = '测试中…'
    test.style.color = ''
    test.style.borderColor = ''
    try {
      const r = await aiPing()
      test.textContent = '通了 · ' + r.slice(0, 16)
      test.style.borderColor = 'var(--ok)'
      test.style.color = 'var(--ok)'
    } catch (e) {
      test.textContent = '没通'
      test.style.borderColor = 'var(--bad)'
      test.style.color = 'var(--bad)'
      const old = $('.set-err')
      if (old) old.remove()
      const msg = el('div', 'tiny mt-14 set-err')
      msg.style.color = 'var(--bad)'
      msg.style.lineHeight = '1.7'
      msg.textContent = e.message
      acts.appendChild(msg)
    } finally {
      test.disabled = false
    }
  }
  acts.appendChild(test)

  app.appendChild(acts)

  // 帮助
  const faq = el('div', 'card mt-20')
  faq.appendChild(el('h3', 'h-sec', '怎么拿 Key'))
  faq.innerHTML += `
    <div class="tiny" style="line-height:1.8">
      1. 打开 platform.deepseek.com 注册<br>
      2. 左侧「API keys」→ 创建<br>
      3. 复制那串 sk- 开头的，粘上面<br>
      4. 点「测试连通」
    </div>
  `
  faq.appendChild(
    el(
      'div',
      'tiny mt-14',
      'DeepSeek 实测允许网页直接调用，不用架服务器。如果哪天报 CORS，告诉我。'
    )
  )
  app.appendChild(faq)
}


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
