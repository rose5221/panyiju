/* 文字标记层 —— 模拟卷面上划线
 *
 * 三种标记：下划线（重点）、高亮（主旨句）、波浪线（没读懂/存疑）
 * 选中文字 → 底部弹条 → 点一下就打上
 * 点已有的标记 → 弹「删除」
 *
 * 存储：localStorage，按 paperId 分开存
 * 渲染：把段落文字切成片段，命中的片段包一层 span，不改原文
 */

'use strict'

const MARKS_KEY = 'panyiju.marks.v1'

const MARK_TYPES = {
  underline: { cls: 'mk-underline', label: '划线', tip: '标重点' },
  highlight: { cls: 'mk-highlight', label: '高亮', tip: '标主旨句' },
  wavy: { cls: 'mk-wavy', label: '波浪线', tip: '标没读懂' },
}

let MARKS = null

/* ── 存储 ─────────────────────────────────────────────── */

function loadMarksAll() {
  if (MARKS) return MARKS
  try {
    MARKS = JSON.parse(localStorage.getItem(MARKS_KEY) || '{}')
  } catch {
    MARKS = {}
  }
  return MARKS
}

function saveMarksAll() {
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(MARKS || {}))
  } catch (e) {
    console.warn('标记保存失败', e)
  }
}

function paperMarks(paperId) {
  const all = loadMarksAll()
  if (!Array.isArray(all[paperId])) all[paperId] = []
  return all[paperId]
}

function countMarks(paperId) {
  return paperMarks(paperId).length
}

function clearPaperMarks(paperId) {
  const all = loadMarksAll()
  all[paperId] = []
  saveMarksAll()
}

function addMark(paperId, para, start, end, type) {
  const all = loadMarksAll()
  const list = paperMarks(paperId).filter(
    (m) => m.para !== para || m.end <= start || m.start >= end
  )
  list.push({ para, start, end, type })
  list.sort((a, b) => a.para - b.para || a.start - b.start)
  all[paperId] = list
  saveMarksAll()
  return list
}

function removeMark(paperId, para, start) {
  const all = loadMarksAll()
  all[paperId] = paperMarks(paperId).filter(
    (m) => !(m.para === para && m.start === start)
  )
  saveMarksAll()
}

/* ── 渲染 ─────────────────────────────────────────────── */

const escM = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

// 把一段文字按标记切成片段，命中的包 span。标记互不重叠，所以一格最多一个。
function renderMarked(node, text, marks) {
  if (!marks.length) {
    node.innerHTML = escM(text)
    return
  }
  const pts = new Set([0, text.length])
  for (const m of marks) {
    pts.add(Math.max(0, m.start))
    pts.add(Math.min(text.length, m.end))
  }
  const arr = [...pts].sort((a, b) => a - b)
  let html = ''
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i]
    const b = arr[i + 1]
    if (a >= b) continue
    const seg = escM(text.slice(a, b))
    const hit = marks.find((m) => m.start <= a && m.end >= b)
    if (hit) {
      const t = MARK_TYPES[hit.type] || MARK_TYPES.underline
      html += `<span class="mk ${t.cls}" data-mpara="${hit.para}" data-mstart="${hit.start}">${seg}</span>`
    } else {
      html += seg
    }
  }
  node.innerHTML = html
}

// container 里所有 [data-mtext] 都按标记重画
function applyMarks(container, paperId, paragraphs) {
  const marks = paperMarks(paperId)
  for (const node of container.querySelectorAll('[data-mtext]')) {
    const para = Number(node.dataset.mtext)
    const p = paragraphs.find((x) => x.n === para)
    if (!p) continue
    renderMarked(node, p.text, marks.filter((m) => m.para === para))
  }
}

/* ── 选区 → 字符偏移 ──────────────────────────────────── */

const ENTRIES = []

// 从容器起点数到当前节点偏移，得到段内字符位置
function charOffset(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let count = 0
  let n
  while ((n = walker.nextNode())) {
    if (n === node) return count + offset
    count += n.textContent.length
  }
  return -1
}

function closestTextSpan(node) {
  let e = node.nodeType === 1 ? node : node.parentElement
  while (e) {
    if (e.dataset && e.dataset.mtext) return e
    e = e.parentElement
  }
  return null
}

function currentSelection() {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  const sEl = closestTextSpan(r.startContainer)
  const eEl = closestTextSpan(r.endContainer)
  // 只允许在同一个段落内划
  if (!sEl || sEl !== eEl) return null
  const a = charOffset(sEl, r.startContainer, r.startOffset)
  const b = charOffset(sEl, r.endContainer, r.endOffset)
  if (a < 0 || b < 0) return null
  const start = Math.min(a, b)
  const end = Math.max(a, b)
  if (end - start < 2) return null
  return { para: Number(sEl.dataset.mtext), start, end }
}

/* ── 底部操作条 ───────────────────────────────────────── */

let BAR = null

function ensureBar() {
  if (BAR) return BAR
  const b = document.createElement('div')
  b.className = 'mark-bar'
  b.id = 'markBar'
  b.hidden = true
  document.body.appendChild(b)
  BAR = b

  // 点空白处收起
  document.addEventListener('click', (e) => {
    if (BAR.hidden) return
    if (BAR.contains(e.target)) return
    if (e.target.closest('.mk')) return
    hideBar()
  })
  return b
}

let barCtx = null

function showBar(ctx) {
  const b = ensureBar()
  barCtx = ctx
  b.innerHTML = ''

  if (ctx.mode === 'delete') {
    const hint = document.createElement('span')
    hint.className = 'mark-bar-hint'
    hint.textContent = '已选中的标记'
    b.appendChild(hint)

    const del = document.createElement('button')
    del.className = 'mark-btn mark-btn-danger'
    del.textContent = '删除'
    del.onclick = () => {
      const entry = ENTRIES.find((x) => x.paperId === ctx.paperId)
      removeMark(ctx.paperId, ctx.para, ctx.start)
      if (entry) applyMarks(entry.container, entry.paperId, entry.paragraphs)
      if (ctx.afterChange) ctx.afterChange()
      hideBar()
      toast('已删除')
    }
    b.appendChild(del)

    const cancel = document.createElement('button')
    cancel.className = 'mark-btn'
    cancel.textContent = '取消'
    cancel.onclick = hideBar
    b.appendChild(cancel)
  } else {
    for (const [key, t] of Object.entries(MARK_TYPES)) {
      const btn = document.createElement('button')
      btn.className = 'mark-btn mark-btn-' + key
      btn.innerHTML = `<span class="mark-swatch ${t.cls}"></span>${t.label}`
      btn.title = t.tip
      btn.onclick = () => {
        const entry = ENTRIES.find((x) => x.paperId === ctx.paperId)
        addMark(ctx.paperId, ctx.para, ctx.start, ctx.end, key)
        if (entry) applyMarks(entry.container, entry.paperId, entry.paragraphs)
        if (ctx.afterChange) ctx.afterChange()
        document.getSelection()?.removeAllRanges()
        hideBar()
      }
      b.appendChild(btn)
    }
    const cancel = document.createElement('button')
    cancel.className = 'mark-btn mark-btn-quiet'
    cancel.textContent = '收起'
    cancel.onclick = hideBar
    b.appendChild(cancel)
  }

  b.hidden = false
  requestAnimationFrame(() => b.classList.add('show'))
}

function hideBar() {
  if (!BAR) return
  BAR.classList.remove('show')
  BAR.hidden = true
  barCtx = null
}

/* ── 挂载 ─────────────────────────────────────────────── */

/**
 * @param {HTMLElement} container  包含 [data-mtext] 的容器
 * @param {string} paperId
 * @param {Array} paragraphs
 * @param {Function} [afterChange] 标记变化后回调（用来刷新计数）
 */
function enableMarking(container, paperId, paragraphs, afterChange) {
  container.classList.add('mark-scope')

  // 登记，供弹条查找
  const exist = ENTRIES.findIndex((x) => x.container === container)
  const rec = { container, paperId, paragraphs, afterChange }
  if (exist >= 0) ENTRIES[exist] = rec
  else ENTRIES.push(rec)

  applyMarks(container, paperId, paragraphs)

  // 点已有标记 → 删除
  container.addEventListener('click', (e) => {
    const mk = e.target.closest('.mk')
    if (!mk) return
    e.stopPropagation()
    showBar({
      mode: 'delete',
      paperId,
      para: Number(mk.dataset.mpara),
      start: Number(mk.dataset.mstart),
      afterChange,
    })
  })
}

// 全局选区监听：选中就弹条
let selTimer = null
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer)
  selTimer = setTimeout(() => {
    const ctx = currentSelection()
    if (!ctx) {
      // 只在没有选中时收起「新建」状态的条
      if (barCtx && barCtx.mode === 'new') hideBar()
      return
    }
    const entry = ENTRIES.find((x) => x.container.contains(document.getSelection().anchorNode))
    if (!entry) return
    showBar({
      mode: 'new',
      paperId: entry.paperId,
      para: ctx.para,
      start: ctx.start,
      end: ctx.end,
      afterChange: entry.afterChange,
    })
  }, 140)
})

// 滚动时收起，避免条飘在错位置
window.addEventListener(
  'scroll',
  () => {
    if (barCtx && barCtx.mode === 'new') hideBar()
  },
  { passive: true }
)
