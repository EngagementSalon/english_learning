// ====== 测试 v56：作业做多遍 → 记录并展示每一次真实成绩 ======
// 数据层（courseBuildResultEntry / courseHistoryOf）：
//   ① 首次作答 → history = [本次]；判定字段 = 本次
//   ② 重做低分（homework）→ 判定 score/correct 保留最高那次，但 history 追加本次真实低分，attempts 累加
//   ③ 重做更高分 → 判定字段升级为本次，history 3 条
//   ④ 老记录（无 history）升级：下次重做时既有成绩补为第 1 条
//   ⑤ history 上限 20 条截断（保留最近）
// 展示层：
//   ⑥ 全班成绩矩阵 dash-cell：attempts>1 且有 history → 直接列历次分数（96→88），替代 ×N
//   ⑦ 管理员作业详情成员行：状态列下方 course-hist 历次（第 1 次 96 分 → 第 2 次 88 分）
// 离线补传重放（真实 course-store.js _applyResultOp）：
//   ⑧ homework 云端更高分合并 → entry.score 回写高分，history 仍追加本轮真实分
//   ⑨ 云端已有更新记录（prev.at >= entry.at）→ drop 不改
//   ⑩ exam 补传合并 history
//   ⑪ renameUser 账号合并 → 两账号 history 合并去重按时间排序
//   ⑫ i18n 双语键齐全
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}

// ---------- 沙箱 A：course-app 数据层 + 渲染（mock CourseStore） ----------
function makeSandboxA(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let lastCreated = null
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const sandbox = {
    console,
    localStorage: {
      store: { eq_bank_version: '999', eq_course_only_v43: '1' },
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { lastCreated = mkEl(); return lastCreated },
      body: { appendChild() {} }, title: '',
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [], recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    CourseStore: {
      status: 'online',
      newId: () => 'aX' + Math.floor(Math.random() * 1e6),
      findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
      findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
      getDoc: async () => JSON.parse(JSON.stringify(courseDocRef.doc)),
      mutate: async fn => {
        const doc = JSON.parse(JSON.stringify(courseDocRef.doc))
        const ret = fn(doc)
        if (ret === false) return null
        courseDocRef.doc = doc
        return true
      },
      enqueuePending: op => { (sandbox._pending = sandbox._pending || []).push(op); return true },
      pendingCount: () => (sandbox._pending || []).length,
    },
    _els: elements, _getEl: getEl, _lastCreated: () => lastCreated,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

const run = (sb, code) => vm.runInContext(code, sb)

// ---------- 沙箱 B：真实 course-store.js（_applyResultOp / renameUser） ----------
function makeSandboxB(docRef) {
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const sandbox = {
    console,
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    window: { addEventListener() {} },
    setTimeout, clearTimeout,
    AbortController,
    TextEncoder, TextDecoder,
    Date, JSON, Math, String, Number, Array, Object, parseInt, parseFloat,
    fetch: async (url, opt) => {
      if (opt && opt.method === 'POST') {
        docRef.doc = JSON.parse(opt.body)
        return { ok: true, text: async () => 'ok' }
      }
      return { ok: true, text: async () => JSON.stringify(docRef.doc) }
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('course-store.js'), sandbox)
  // course-store.js 顶层用 const 声明（词法全局，不挂在 globalThis 上）→ 显式取引用
  sandbox.CourseStore = vm.runInContext('CourseStore', sandbox)
  return sandbox
}

async function main() {
  // ===== 数据层：courseBuildResultEntry / courseHistoryOf =====
  const a = { id: 'a1', type: 'homework' }
  const t1 = 1000, t2 = 2000, t3 = 3000

  // ① 首次作答
  const docRefA = { doc: { v: 1, classes: [] } }
  const sbA = makeSandboxA(docRefA)
  const e1 = run(sbA, `JSON.stringify(courseBuildResultEntry(${JSON.stringify(a)}, null, 96, 10, 10, 100, ${t1}, null))`)
  const r1 = JSON.parse(e1)
  assert('首次作答: history=[96]', r1.attempts === 1 && Array.isArray(r1.history) && r1.history.length === 1 && r1.history[0].score === 96 && r1.history[0].at === t1 && r1.score === 96)

  // ② 重做低分：判定保留最高分那次，history 追加真实低分
  const prev2 = { at: t1, score: 96, correct: 10, total: 10, usedSec: 100, attempts: 1 }
  const e2 = run(sbA, `JSON.stringify(courseBuildResultEntry(${JSON.stringify(a)}, ${JSON.stringify(prev2)}, 88, 8, 10, 90, ${t2}, null))`)
  const r2 = JSON.parse(e2)
  assert('重做低分: 判定保留 96、history=[96,88]、attempts=2', r2.score === 96 && r2.correct === 10 && r2.attempts === 2 && r2.history.length === 2 && r2.history[0].score === 96 && r2.history[1].score === 88 && r2.history[1].at === t2)

  // ③ 重做更高分
  const prev3 = { at: t2, score: 96, correct: 10, total: 10, usedSec: 90, attempts: 2, history: [{ at: t1, score: 96, correct: 10, total: 10, usedSec: 100 }, { at: t2, score: 88, correct: 8, total: 10, usedSec: 90 }] }
  const e3 = run(sbA, `JSON.stringify(courseBuildResultEntry(${JSON.stringify(a)}, ${JSON.stringify(prev3)}, 98, 10, 10, 80, ${t3}, null))`)
  const r3 = JSON.parse(e3)
  assert('重做更高分: 判定 98、history 3 条升序', r3.score === 98 && r3.attempts === 3 && r3.history.length === 3 && r3.history.map(h => h.score).join() === '96,88,98')

  // ④ 老记录升级：无 history 的旧记录在下次重做时补为首条
  const prev4 = { at: t1, score: 80, correct: 8, total: 10, usedSec: 120, attempts: 1 }
  const e4 = run(sbA, `JSON.stringify(courseBuildResultEntry(${JSON.stringify(a)}, ${JSON.stringify(prev4)}, 90, 9, 10, 110, ${t2}, null))`)
  const r4 = JSON.parse(e4)
  assert('老记录升级: history=[80,90]', r4.history.length === 2 && r4.history[0].score === 80 && r4.history[0].at === t1 && r4.history[1].score === 90)

  // ⑤ history 上限 20 条（从第 1 次到第 21 次 → 只剩最近 20，含本轮）
  const longHist = Array.from({ length: 20 }, (_, i) => ({ at: t1 + i, score: 60 + i, correct: 6, total: 10, usedSec: 10 }))
  const prev5 = { at: t1 + 100, score: 79, correct: 7, total: 10, usedSec: 10, attempts: 20, history: longHist }
  const e5 = run(sbA, `JSON.stringify(courseBuildResultEntry(${JSON.stringify(a)}, ${JSON.stringify(prev5)}, 59, 5, 10, 10, ${t3}, null))`)
  const r5 = JSON.parse(e5)
  assert('history 上限 20 条截断', Array.isArray(r5.history) && r5.history.length === 20 && r5.history[19].score === 59)

  // ===== 展示层 =====
  // 种子班级：u1 已完成 homework，u2 未交
  const seedDoc = {
    v: 1,
    classes: [{
      id: 'c1', name: '一班', members: ['u1', 'u2'],
      assignments: [{
        id: 'a1', type: 'homework', title: 'Unit 1', status: 'open',
        questions: [{ type: 'single', difficulty: 1, question: 'Q?', options: ['A', 'B'], answer: [0], explanation: '' }],
        results: {
          u1: { at: t2, score: 96, correct: 10, total: 10, usedSec: 90, attempts: 2, history: [{ at: t1, score: 96, correct: 10, total: 10, usedSec: 100 }, { at: t2, score: 88, correct: 8, total: 10, usedSec: 90 }] },
        },
      }],
    }],
  }
  const docRefUI = { doc: seedDoc }
  const sbUI = makeSandboxA(docRefUI)
  await run(sbUI, 'courseTestSeedDoc()')

  // ⑥ 全班成绩矩阵：dash-cell 直接列历次 96→88
  await run(sbUI, 'renderCourseDashboard()')
  const dashHtml = sbUI._getEl('page-course').innerHTML
  assert('看板 dash-cell 展示历次 96→88', dashHtml.indexOf('96→88') >= 0 && dashHtml.indexOf('dash-hist') >= 0)
  assert('看板不再显示裸 ×2', dashHtml.indexOf('>×2<') < 0)

  // ⑦ 管理员作业详情：状态列下 course-hist 第 1 次 96 分 → 第 2 次 88 分
  await run(sbUI, "courseAssignDetail('c1','a1')")
  const detHtml = sbUI._getEl('page-course').innerHTML
  assert('作业详情展示历次成绩文本', detHtml.indexOf('course-hist') >= 0 && detHtml.indexOf('第 1 次 96 分') >= 0 && detHtml.indexOf('第 2 次 88 分') >= 0)
  assert('作业详情次数列仍保留', detHtml.indexOf('courseThTries') >= 0 || detHtml.indexOf('次数') >= 0 || detHtml.indexOf('Tries') >= 0)

  // ===== 离线补传重放：真实 course-store.js =====
  const docRefB = { doc: { v: 1, classes: [{ id: 'c1', members: ['u1'], assignments: [{ id: 'a1', type: 'homework', title: 'H', questions: [{ type: 'single', question: 'Q', options: ['A', 'B'], answer: [0] }], results: { u1: { at: t1, score: 96, correct: 10, total: 10, usedSec: 100, attempts: 1 } } }] }] } }
  const sbB = makeSandboxB(docRefB)
  const csB = sbB.CourseStore

  // ⑧ homework 重放：云端高分 96 保留判定，本轮低分 88 仍进 history
  const appliedDoc8 = JSON.parse(JSON.stringify(docRefB.doc))   // _applyResultOp 就地改传入 doc
  let st = csB._applyResultOp(appliedDoc8, {
    id: 'op1', ts: t2, atype: 'homework', cid: 'c1', aid: 'a1', u: 'u1',
    entry: { at: t2, score: 88, correct: 8, total: 10, usedSec: 90, attempts: 2 },
  })
  const resB1 = st === 'applied' ? csB.findClass(appliedDoc8, 'c1').assignments[0].results.u1 : null
  assert('重放 homework 高分合并: 判定 96 + history=[96,88]', st === 'applied' && resB1 && resB1.score === 96 && resB1.attempts === 2 && Array.isArray(resB1.history) && resB1.history.length === 2 && resB1.history[0].score === 96 && resB1.history[1].score === 88)

  // ⑨ prev.at >= entry.at → drop
  docRefB.doc.classes[0].assignments[0].results.u1 = { at: t3, score: 99, correct: 10, total: 10, usedSec: 1, attempts: 1 }
  st = csB._applyResultOp(JSON.parse(JSON.stringify(docRefB.doc)), {
    id: 'op2', ts: t2, atype: 'homework', cid: 'c1', aid: 'a1', u: 'u1',
    entry: { at: t2, score: 88, correct: 8, total: 10, usedSec: 90, attempts: 1 },
  })
  assert('重放旧记录被丢弃 drop', st === 'drop')

  // ⑩ exam 补传合并 history
  docRefB.doc = { v: 1, classes: [{ id: 'c1', members: ['u1'], assignments: [{ id: 'x1', type: 'exam', title: 'E', questions: [], results: { u1: { at: t1, score: 60, correct: 6, total: 10, usedSec: 200, attempts: 1 } } }] }] }
  const appliedDoc10 = JSON.parse(JSON.stringify(docRefB.doc))
  st = csB._applyResultOp(appliedDoc10, {
    id: 'op3', ts: t3, atype: 'exam', cid: 'c1', aid: 'x1', u: 'u1',
    entry: { at: t3, score: 75, correct: 8, total: 10, usedSec: 150, attempts: 1 },
  })
  const resB3 = st === 'applied' ? csB.findClass(appliedDoc10, 'c1').assignments[0].results.u1 : null
  assert('重放 exam 合并: history=[60,75]', st === 'applied' && resB3 && resB3.score === 75 && resB3.history.length === 2 && resB3.history.map(h => h.score).join() === '60,75')

  // ⑪ renameUser：两账号成绩合并，history 合并排序
  docRefB.doc = {
    v: 1,
    classes: [{ id: 'c1', members: ['u1', 'old'], createdBy: 'u1', assignments: [{ id: 'a1', type: 'homework', title: 'H', createdBy: 'u1', questions: [],
      results: {
        u1: { at: t3, score: 90, correct: 9, total: 10, usedSec: 80, attempts: 2, history: [{ at: t1, score: 80, correct: 8, total: 10, usedSec: 100 }, { at: t3, score: 90, correct: 9, total: 10, usedSec: 80 }] },
        old: { at: t2, score: 85, correct: 8, total: 10, usedSec: 90, attempts: 1, history: [{ at: t2, score: 85, correct: 8, total: 10, usedSec: 90 }] },
      } }] }],
  }
  const okRename = await csB.renameUser('old', 'u1')
  const resB4 = csB.findClass(docRefB.doc, 'c1').assignments[0].results.u1
  assert('renameUser 合并 history 按时间升序', okRename === true && resB4 && resB4.attempts === 3 && resB4.history.length === 3 && resB4.history.map(h => h.score).join() === '80,85,90' && !csB.findClass(docRefB.doc, 'c1').assignments[0].results.old)

  // ===== i18n =====
  const zhT = run(sbA, `(k) => t(k)`)
  const histTitleZh = run(sbA, `t('courseHistTitle')`)
  const histTryZh = run(sbA, `t('courseHistTryFmt', 1, 96)`)
  assert('i18n zh 词条', histTitleZh.indexOf('历次') >= 0 && histTryZh.indexOf('第 1 次 96 分') >= 0)
  run(sbA, `setLang('en')`)
  const histTitleEn = run(sbA, `t('courseHistTitle')`)
  const histTryEn = run(sbA, `t('courseHistTryFmt', 1, 96)`)
  assert('i18n en 词条', histTitleEn.indexOf('Attempt history') >= 0 && histTryEn.indexOf('Try 1: 96') >= 0)

  // ===== 收尾 =====
  if (failed) { console.log('\n✗ v56 test FAILED'); process.exit(1) }
  console.log('\n✓ v56 attempt-history: all assertions passed')
  process.exit(0)   // 沙箱内注册的心跳 interval 会挂住事件循环 → 显式退出
}

main().catch(e => { console.error('✗ 异常:', e); process.exit(1) })
