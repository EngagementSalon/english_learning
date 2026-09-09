// ====== 测试：v47 复制作业到其他班级（题目 / 课后小测 / 视频链接原样复制，成绩不复制） ======
// ① 管理端任务行出现「复制到」按钮；线下课行不出现
// ② 已发布作业（含题目）复制 → 目标班级出现新作业：内容一致、成绩清空、新 id、尾部追加
// ③ 视频作业复制 → 课后小测 / 链接一并复制；原截止时间已过 → 复制后清空截止
// ④ 草稿复制 → 目标班级仍为草稿（status:'draft'）
// ⑤ 线下课拒绝复制（按钮不出现 + 弹窗直接返回）；无其他班级时提示
// ⑥ i18n 双语键齐全
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
      pendingCount: () => 0,
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

function asAdmin(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name || 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  return Store
}

const NOW = Date.now()
// 两班：c1 餐饮（源班：视频 + 已发布作业 + 草稿 + 线下课），c2 房务（目标班，已有 1 个测评）
function makeDoc() {
  return { doc: { v: 1, classes: [
    { id: 'c1', name: '餐饮部', note: '', createdAt: 1, createdBy: 'admin', members: ['s1'],
      assignments: [
        { id: 'v1', type: 'video', title: '入住服务视频', desc: '', deadline: NOW - 86400000, createdAt: 1,
          videoUrl: 'https://x.mp4',
          quiz: [
            { type: 'listen', question: 'reception', options: ['前台', '餐厅', '健身房', '行李'], answer: [0], explanation: '' },
            { type: 'single', question: 'Where do guests check in?', options: ['Front desk', 'WOOBAR', 'SPA', 'Ballroom'], answer: [0], explanation: '' },
          ],
          results: { s1: { at: 1, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3 } } },
        { id: 'h1', type: 'homework', title: '客房英语 H1', desc: '', deadline: NOW + 86400000, createdAt: 1, passScore: 60,
          questions: [
            { type: 'single', difficulty: 1, question: 'Q1?', options: ['A', 'B', 'C', 'D'], answer: [0], explanation: '' },
            { type: 'judge', difficulty: 2, question: 'Q2?', options: ['正确', '错误'], answer: [0], explanation: '' },
            { type: 'listen', difficulty: 1, question: 'Q3', options: ['甲', '乙', '丙', '丁'], answer: [1], explanation: '' },
          ],
          results: { s1: { at: 1, score: 80 } } },
        { id: 'd1', type: 'homework', title: '草稿作业 D1', desc: '', deadline: NOW + 86400000, createdAt: 1, status: 'draft', passScore: 60,
          questions: [
            { type: 'single', difficulty: 1, question: 'D-Q1?', options: ['X', 'Y'], answer: [0], explanation: '' },
            { type: 'single', difficulty: 1, question: 'D-Q2?', options: ['M', 'N'], answer: [1], explanation: '' },
          ],
          results: {} },
        { id: 'off1', type: 'offline', title: '线下面授 1', desc: '', when: NOW + 86400000 * 2, createdAt: 1, results: {} },
      ] },
    { id: 'c2', name: '房务部', note: '', createdAt: 1, createdBy: 'admin', members: [],
      assignments: [
        { id: 'e2', type: 'exam', title: '既有测评 E2', desc: '', deadline: 0, createdAt: 1, duration: 20, passScore: 60,
          questions: [{ type: 'single', difficulty: 1, question: 'E2Q?', options: ['A', 'B'], answer: [0], explanation: '' }],
          results: {} },
      ] },
  ] } }
}

async function openClassAdmin(sb, cid) {
  asAdmin(sb)
  await vm.runInContext('courseTestSeedDoc()', sb)
  vm.runInContext(`courseState.adminView = true; courseState.view='class'; courseState.classId='${cid}'`, sb)
  await vm.runInContext('courseRenderClass()', sb)
  await new Promise(r => setTimeout(r, 20))
}

;(async () => {
  console.log('\n① 任务行按钮')
  const ref1 = makeDoc()
  const sb1 = makeSandbox(ref1)
  await openClassAdmin(sb1, 'c1')
  const html1 = sb1._els['page-course'].innerHTML
  assert('已发布作业行有「复制到」按钮', html1.includes("courseCopyAssignModal('c1','h1')"))
  assert('视频作业行有「复制到」按钮', html1.includes("courseCopyAssignModal('c1','v1')"))
  assert('草稿行也有「复制到」按钮', html1.includes("courseCopyAssignModal('c1','d1')"))
  assert('线下课行没有「复制到」按钮', !html1.includes("courseCopyAssignModal('c1','off1')"))
  assert('按钮带 📋 图标', html1.includes('📋'))

  console.log('\n② 已发布作业复制 → 目标班级尾部追加，内容一致、成绩清空')
  const ref2 = makeDoc()
  const sb2 = makeSandbox(ref2)
  await openClassAdmin(sb2, 'c1')
  await vm.runInContext("courseCopyAssignModal('c1','h1')", sb2)
  assert('有目标班级 → 未触发「无班级」提示', (sb2._lastAlert || '') === '')
  assert('未选班级时点击复制 → 不写入', sb2._getEl('ccTarget').value === '')
  const before = ref2.doc.classes.find(x => x.id === 'c2').assignments.length
  sb2._getEl('ccTarget').value = 'c2'
  await vm.runInContext("courseCopyAssignDo('c1','h1')", sb2)
  const after2 = await vm.runInContext('CourseStore.getDoc()', sb2)
  const c2a = after2.classes.find(x => x.id === 'c2')
  assert('目标班级作业 +1', c2a.assignments.length === before + 1)
  const cp = c2a.assignments[c2a.assignments.length - 1]
  assert('复制品排在最末', cp && cp.title === '客房英语 H1')
  assert('复制品为新 id', cp && cp.id !== 'h1' && /^a/.test(cp.id))
  assert('类型不变 homework', cp && cp.type === 'homework')
  assert('题目数量不变（3）', cp && cp.questions.length === 3)
  assert('题目内容深拷贝一致', cp && cp.questions[2].question === 'Q3' && cp.questions[2].options[1] === '乙')
  assert('成绩已清空', cp && cp.results && Object.keys(cp.results).length === 0)
  assert('未过期截止时间保留', cp && cp.deadline === NOW + 86400000)
  assert('已发布复制品无 status', cp && cp.status === undefined)
  const src2 = after2.classes.find(x => x.id === 'c1').assignments.find(a => a.id === 'h1')
  assert('源班作业未被改动（成绩仍在）', src2 && src2.results.s1 && src2.results.s1.score === 80)
  assert('提示「已复制到房务部」', (sb2._lastAlert || '').includes('房务部'))

  console.log('\n③ 视频作业复制 → 小测/链接一并复制；过期截止清空')
  const ref3 = makeDoc()
  const sb3 = makeSandbox(ref3)
  await openClassAdmin(sb3, 'c1')
  await vm.runInContext("courseCopyAssignModal('c1','v1')", sb3)
  sb3._getEl('ccTarget').value = 'c2'
  await vm.runInContext("courseCopyAssignDo('c1','v1')", sb3)
  const after3 = await vm.runInContext('CourseStore.getDoc()', sb3)
  const cpv = after3.classes.find(x => x.id === 'c2').assignments.find(a => a.title === '入住服务视频')
  assert('视频复制品存在', !!cpv)
  assert('视频链接一并复制', cpv && cpv.videoUrl === 'https://x.mp4')
  assert('课后小测一并复制（2 题）', cpv && cpv.quiz && cpv.quiz.length === 2)
  assert('小测选项深拷贝一致', cpv && cpv.quiz[0].question === 'reception' && cpv.quiz[0].options[0] === '前台')
  assert('观看成绩已清空', cpv && cpv.results && Object.keys(cpv.results).length === 0)
  assert('原截止已过 → 复制后清空截止', cpv && (cpv.deadline === 0 || cpv.deadline == null))
  const srcv = after3.classes.find(x => x.id === 'c1').assignments.find(a => a.id === 'v1')
  assert('源视频原截止仍在', srcv && srcv.deadline === NOW - 86400000)

  console.log('\n④ 草稿复制 → 目标班级仍为草稿')
  const ref4 = makeDoc()
  const sb4 = makeSandbox(ref4)
  await openClassAdmin(sb4, 'c1')
  await vm.runInContext("courseCopyAssignModal('c1','d1')", sb4)
  sb4._getEl('ccTarget').value = 'c2'
  await vm.runInContext("courseCopyAssignDo('c1','d1')", sb4)
  const after4 = await vm.runInContext('CourseStore.getDoc()', sb4)
  const cpd = after4.classes.find(x => x.id === 'c2').assignments.find(a => a.title === '草稿作业 D1')
  assert('草稿复制品存在且为 draft', cpd && cpd.status === 'draft')
  assert('草稿题目复制（2 题）', cpd && cpd.questions.length === 2)
  assert('草稿成绩空', cpd && cpd.results && Object.keys(cpd.results).length === 0)

  console.log('\n⑤ 线下课拒绝复制 / 无其他班级提示')
  const ref5 = makeDoc()
  const sb5 = makeSandbox(ref5)
  await openClassAdmin(sb5, 'c1')
  await vm.runInContext("courseCopyAssignModal('c1','off1')", sb5)
  assert('线下课 → 不弹窗（无 courseModal 元素）', !('courseModal' in sb5._els))
  const ref6 = makeDoc()
  ref6.doc.classes = [ref6.doc.classes[0]]   // 只剩 c1，无目标班级
  const sb6 = makeSandbox(ref6)
  await openClassAdmin(sb6, 'c1')
  await vm.runInContext("courseCopyAssignModal('c1','h1')", sb6)
  assert('无其他班级 → alert 提示', (sb6._lastAlert || '').includes('没有其他班级'))
  assert('无其他班级 → 不弹窗', !('courseModal' in sb6._els))

  console.log('\n⑥ i18n 双语键齐全')
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  const keys = ['courseCopyBtn', 'courseCopyTitle', 'courseCopyTargetLabel', 'courseCopyPick',
    'courseCopyNoClass', 'courseCopyHint', 'courseCopyQN', 'courseCopyQuizN', 'courseCopyQuizNone', 'courseCopyOk']
  const zhBlock = i18nSrc.slice(0, i18nSrc.indexOf("'Video'"))
  const enBlock = i18nSrc.slice(i18nSrc.indexOf("'Video'"))
  keys.forEach(k => assert(`zh.${k}`, new RegExp(k + ':').test(zhBlock)))
  keys.forEach(k => assert(`en.${k}`, new RegExp(k + ':').test(enBlock)))

  // 收尾：沙箱内 setInterval（云拉取等）会让进程挂住，必须显式退出
  process.exit(failed ? 1 : 0)
})().catch(e => { console.log('运行异常:', e); process.exit(1) })
