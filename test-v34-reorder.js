// ====== 测试：v34 任务排序（调整「作业 / 线下课」在班级内的先后顺序） ======
// ① 班级详情任务表每行有 ↕ 排序按钮（↑ 上移 / ↓ 下移），首行 ↑ 禁用、末行 ↓ 禁用
// ② courseMoveAssign 上移/下移 → 交换云端 classes[].assignments 顺序；边界 no-op
// ③ 排序后管理端表格行顺序随之变化（作业 + 线下课混排）
// ④ 学员「我的学习进度」按排序后的数组顺序渲染节点路径 + 下一步引导
// ⑤ i18n 双语键齐全
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null,
    scrollIntoView() {},
  }
}

function makeSandbox(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let lastCreated = null
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const sandbox = {
    console,
    localStorage: {
      store: {},
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

function asAdmin(sb) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  return Store
}
function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
  Store.getUser = () => ({ name, dept: '' })
  return Store
}

function idsOf(sb, cid) {
  return vm.runInContext('(courseState.doc.classes.find(c => c.id === "' + cid + '").assignments || []).map(a => a.id)', sb)
}

// 班级文档：作业 h1 / 线下课 o1 / 作业 h2 / 视频 v1（用户要能调整「线下课作业和课程」混合顺序）
const docMix = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1'],
  assignments: [
    { id: 'h1', type: 'homework', title: '第一课作业', desc: '', deadline: 0, createdAt: 1, results: {} },
    { id: 'o1', type: 'offline', title: '点餐服务', topicId: 3, custom: false, desc: '三楼培训室', date: 0, createdAt: 2, held: false, heldAt: 0, results: {} },
    { id: 'h2', type: 'homework', title: '第二课作业', desc: '', deadline: 0, createdAt: 3, results: {} },
    { id: 'v1', type: 'video', title: '服务礼仪视频', desc: '', deadline: 0, createdAt: 4, url: '', results: {} },
  ] }] } }

// 学员视角文档：h1 已做（80 分）+ o2 已下课标注 + o1 待上课（顺序被管理员调整为 h1 → o2 → o1）
const docPath = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', members: ['s1'],
  assignments: [
    { id: 'h1', type: 'homework', title: '第一课作业', deadline: 0, createdAt: 1, results: { s1: { at: 1, score: 80, correct: 1, total: 1, usedSec: 10, attempts: 1 } } },
    { id: 'o2', type: 'offline', title: '宾客抵达与接待', topicId: 1, custom: false, date: 0, createdAt: 2, held: true, heldAt: 5, results: { s1: { done: true, at: 5, by: 'admin' } } },
    { id: 'o1', type: 'offline', title: '点餐服务', topicId: 3, custom: false, date: 0, createdAt: 3, held: false, heldAt: 0, results: {} },
  ] }] } }

;(async () => {
  console.log('\n🧪 v34 任务排序（作业 / 线下课先后顺序）回归测试\n')

  console.log('① 纯函数：排序按钮渲染 + 边界禁用')
  const sbA = makeSandbox({ doc: {} })
  const up0 = vm.runInContext('courseSortBtns("c1","h1",0,3)', sbA)
  assert('首行：↑ 禁用、↓ 可点击（onclick 带 +1）', up0.includes('disabled') && up0.includes("courseMoveAssign('c1','h1',1)") && !up0.includes("courseMoveAssign('c1','h1',-1)"), up0)
  const mid = vm.runInContext('courseSortBtns("c1","h2",1,3)', sbA)
  assert('中间行：↑↓ 均可点击', mid.includes("courseMoveAssign('c1','h2',-1)") && mid.includes("courseMoveAssign('c1','h2',1)") && !mid.includes('disabled'), mid)
  const last = vm.runInContext('courseSortBtns("c1","v1",3,4)', sbA)
  assert('末行：↓ 禁用、↑ 可点击', last.includes('disabled') && last.includes("courseMoveAssign('c1','v1',-1)") && !last.includes("courseMoveAssign('c1','v1',1)"), last)
  assert('按钮带 title 提示（上移/下移）', up0.includes('title="上移"') && up0.includes('title="下移"'), up0)

  console.log('\n② 管理端：上移 / 下移交换 assignments 顺序（云端入库）')
  const sbB = makeSandbox(JSON.parse(JSON.stringify(docMix)))
  asAdmin(sbB)
  await vm.runInContext('courseTestSeedDoc()', sbB)
  // 管理员先进入班级详情页（排序按钮所在的表格页）
  vm.runInContext('courseState.view = "class"; courseState.classId = "c1"', sbB)
  assert('初始顺序 = [h1, o1, h2, v1]', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h1', 'o1', 'h2', 'v1']), JSON.stringify(idsOf(sbB, 'c1')))
  // h2（作业）上移一位 → 越过 o1（线下课）
  await vm.runInContext('courseMoveAssign("c1","h2",-1)', sbB)
  assert('h2 上移后 = [h1, h2, o1, v1]', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h1', 'h2', 'o1', 'v1']), JSON.stringify(idsOf(sbB, 'c1')))
  // h1（作业）下移一位 → 到 h2 之后
  await vm.runInContext('courseMoveAssign("c1","h1",1)', sbB)
  assert('h1 下移后 = [h2, h1, o1, v1]', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'h1', 'o1', 'v1']), JSON.stringify(idsOf(sbB, 'c1')))
  // v1（视频）从末位连上移两次：越过 o1、h1
  await vm.runInContext('courseMoveAssign("c1","v1",-1)', sbB)
  assert('v1 上移一次后 = [h2, h1, v1, o1]', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'h1', 'v1', 'o1']), JSON.stringify(idsOf(sbB, 'c1')))
  await vm.runInContext('courseMoveAssign("c1","v1",-1)', sbB)
  assert('v1 连上移两次后 = [h2, v1, h1, o1]', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'v1', 'h1', 'o1']), JSON.stringify(idsOf(sbB, 'c1')))
  // 边界：v1 上移一次后仍可下移回原位
  await vm.runInContext('courseMoveAssign("c1","v1",1)', sbB)
  assert('v1 下移一次 = [h2, h1, v1, o1]（可回退）', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'h1', 'v1', 'o1']), JSON.stringify(idsOf(sbB, 'c1')))
  // 边界：首位元素再上移 no-op
  await vm.runInContext('courseMoveAssign("c1","h2",-1)', sbB)
  assert('首元素再上移 = 顺序不变', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'h1', 'v1', 'o1']), JSON.stringify(idsOf(sbB, 'c1')))
  // 边界：末位元素再下移 no-op
  await vm.runInContext('courseMoveAssign("c1","o1",1)', sbB)
  assert('末元素再下移 = 顺序不变', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'h1', 'v1', 'o1']), JSON.stringify(idsOf(sbB, 'c1')))
  // 不存在 id：no-op 不报错
  await vm.runInContext('courseMoveAssign("c1","nope",-1)', sbB)
  assert('不存在的任务 id 移动 = 顺序不变', JSON.stringify(idsOf(sbB, 'c1')) === JSON.stringify(['h2', 'h1', 'v1', 'o1']), JSON.stringify(idsOf(sbB, 'c1')))

  console.log('\n③ 管理端表格：排序后行顺序变化 + ↕ 列存在')
  const html = sbB._getEl('page-course').innerHTML
  assert('班级详情表格含 ↕ 顺序列（4 行 sort-cell + 4 组 sort-btns）',
    (html.match(/course-sort-cell/g) || []).length === 4 && (html.match(/course-sort-btns/g) || []).length === 4,
    'cells=' + (html.match(/course-sort-cell/g) || []).length + ' btns=' + (html.match(/course-sort-btns/g) || []).length)
  assert('表格含排序按钮 onclick', html.includes('courseMoveAssign'), '')
  assert('表格下方含排序提示（我的学习进度按此顺序）', html.includes('我的学习进度') && html.includes('按此顺序'), html.slice(0, 300))
  // 行顺序应按新数组：h2 → h1 → v1 → o1
  const t1 = html.indexOf('第二课作业'), t2 = html.indexOf('第一课作业'), t3 = html.indexOf('服务礼仪视频'), t4 = html.indexOf('点餐服务')
  assert('表格行顺序 = 第二课作业 → 第一课作业 → 服务礼仪视频 → 点餐服务', t1 >= 0 && t1 < t2 && t2 < t3 && t3 < t4, 'idx=' + t1 + ',' + t2 + ',' + t3 + ',' + t4)
  // 末行（o1）的 ↓ 按钮禁用
  const rowStart = html.lastIndexOf('<tr', t4)
  const o1row = html.slice(rowStart, html.indexOf('</tr>', t4))
  assert('末行 o1 的 ↓ 禁用（disabled 且无 +1 onclick）', o1row.includes('course-sort-cell') && o1row.includes('disabled') && !o1row.includes("courseMoveAssign('c1','o1',1)"), o1row.slice(0, 200))

  console.log('\n④ 学员端：线性学习进度按排序后的顺序展示')
  const sbD = makeSandbox(JSON.parse(JSON.stringify(docPath)))
  asStudent(sbD, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbD)
  vm.runInContext('renderCourseStudent()', sbD)
  const shtml = sbD._getEl('page-course').innerHTML
  const p1 = shtml.indexOf('第一课作业'), p2 = shtml.indexOf('宾客抵达与接待'), p3 = shtml.indexOf('点餐服务')
  assert('路径节点顺序 = 第一课作业 → 宾客抵达与接待 → 点餐服务', p1 >= 0 && p1 < p2 && p2 < p3, 'idx=' + p1 + ',' + p2 + ',' + p3)
  assert('进度 = 2 / 3 完成（67%）', shtml.includes('2 / 3 完成') && shtml.includes('width:67%'), '')
  assert('下一步引导 = 最后一个未完成节点「点餐服务」', shtml.includes('cp-node next') && /cp-node next[\s\S]*?点餐服务/.test(shtml), shtml.slice(0, 400))
  assert('完成节点间连线高亮（cp-conn on）', shtml.includes('cp-conn on'), '')

  console.log('\n⑤ i18n 双语键')
  const sbE = makeSandbox({ doc: {} })
  assert('zh：上移 / 下移 / 排序提示键就绪', vm.runInContext('t("courseMoveUp") + "/" + t("courseMoveDown")', sbE) === '上移/下移' && vm.runInContext('t("courseOrderHint")', sbE).includes('线下课'), '')
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  assert('en：Move up / Move down / order hint 键就绪', i18nSrc.includes("courseMoveUp: 'Move up'") && i18nSrc.includes("courseMoveDown: 'Move down'") && i18nSrc.includes('courseOrderHint:'), '')

  console.log('\n' + (failed ? '❌ 有失败项' : '✅ 全部通过'))
  process.exit(failed ? 1 : 0)
})()
