// ====== 测试：v59 作业错题计入每题正确率 + 防作弊强制终止 ======
// ① coursePerQReport：线下课作业/测评交卷时按题上报 perq 事件
//    - 题目 id 与派生题库对齐（指纹 type|题干，trim 后匹配）
//    - 未作答的题不计入；题库匹配不到的题跳过；回顾轮不上报
// ② courseForceTerminate：防作弊切屏超限 → 强制终止，不写成绩/attempts/history
// ③ i18n：anticheatTerminate 双语文案；anti-cheat.js 支持 finalKey 且终止提示保留
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  const el = {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null,
    scrollIntoView() {},
    _handlers: {},
    duration: NaN, currentTime: 0, seeking: false, paused: true, ended: false,
  }
  return el
}

function makeSandbox(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = { 'eq_course_only_v43': '1' }
  const docListeners = {}
  const winListeners = {}
  const enqueued = []
  const sandbox = {
    console,
    localStorage: {
      store: lsStore,
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => mkEl(),
      body: { appendChild() {} }, title: '',
      hidden: false,
      addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn) },
      removeEventListener() {},
      visibilityState: 'visible',
    },
    window: {
      addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn) },
      removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
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
      status: 'online', onStatus() {},
      enqueue(ev) { enqueued.push(ev) },
      addDuration() {},
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
    _els: elements, _getEl: getEl, _docListeners: docListeners, _winListeners: winListeners,
    _enqueued: enqueued,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('anti-cheat.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  // 注意：不加载 course-store.js —— 其顶层 const CourseStore 会遮蔽沙箱的 mock（全局词法绑定优先于对象属性）
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
  Store.getUser = () => ({ name, dept: '' })
  return Store
}

const docRef = {
  doc: {
    v: 1,
    classes: [{
      id: 'c1', name: '测试班', note: '', createdBy: 'admin', members: ['张三'],
      assignments: [
        { id: 'h1', type: 'homework', title: '作业一', status: 'open', questions: [], results: {} },
        { id: 'e1', type: 'exam', title: '测评一', status: 'open', questions: [], results: {} },
      ],
    }],
  },
}

;(async () => {
  const BANK_QS = [
    { id: 101, type: 'single', question: 'Stem A', options: ['a1', 'a2'], answer: [0] },
    { id: 102, type: 'single', question: 'Stem B', options: ['b1', 'b2'], answer: [0] },
    { id: 103, type: 'judge', question: 'Stem C', options: ['对', '错'], answer: [0] },
  ]

  // ================= A. 每题对错上报 =================
  console.log('🧪 A. coursePerQReport：作业/测评错题计入每题正确率')
  {
    const sb = makeSandbox(docRef)
    asStudent(sb, '张三')
    // 直接替换题库查询，隔离 store 迁移逻辑
    vm.runInContext('Store.getQuestions = () => BANKQS', sb)
    sb.BANKQS = BANK_QS
    await vm.runInContext('courseTestSeedDoc()', sb)

    // 作业：4 题 —— A 答对（题干带空格验证 trim）、B 答错、C 在题库但未答（跳过）、D 不在题库（跳过）
    vm.runInContext(`courseQuiz = {
      phase: 'quiz', type: 'homework', cid: 'c1', aid: 'h1', title: '作业一',
      questions: [
        { type: 'single', question: 'Stem A ', options: ['a1', 'a2'], answer: [0] },
        { type: 'single', question: 'Stem B', options: ['b1', 'b2'], answer: [0] },
        { type: 'judge', question: 'Stem C', options: ['对', '错'], answer: [0] },
        { type: 'single', question: 'Unknown X', options: ['x1', 'x2'], answer: [0] },
      ],
      answers: [0, 1, undefined, 0],
      correct: 1, startAt: Date.now(), endAt: null, passScore: 60, submitted: false,
    }`, sb)
    await vm.runInContext('courseSaveResult(1, 4, 30)', sb)

    const perq = sb._enqueued.filter(e => e.ty === 'perq')
    assert('作业交卷上报 2 条 perq（未答/库外题跳过）', perq.length === 2, JSON.stringify(perq))
    assert('指纹 trim 匹配题库 id（Stem A → 101，答对）', perq.some(e => e.d.qid === 101 && e.d.correct === 1), JSON.stringify(perq))
    assert('答错题 correct=0（Stem B → 102）', perq.some(e => e.d.qid === 102 && e.d.correct === 0), JSON.stringify(perq))
    assert('perq 事件带学员身份', perq.every(e => e.u === '张三'), JSON.stringify(perq))
    // 正常交卷仍写成绩 + history（v56 语义不回归）
    const saved = docRef.doc.classes[0].assignments[0].results['张三']
    assert('交卷成绩已保存且 history=[本次]', !!saved && saved.score === 25 && Array.isArray(saved.history) && saved.history.length === 1, JSON.stringify(saved || {}))

    // 测评类型也上报
    sb._enqueued.length = 0
    docRef.doc.classes[0].assignments[1].results = {}
    vm.runInContext(`courseQuiz = {
      phase: 'quiz', type: 'exam', cid: 'c1', aid: 'e1', title: '测评一',
      questions: [{ type: 'single', question: 'Stem A', options: ['a1', 'a2'], answer: [0] }],
      answers: [0], correct: 1, startAt: Date.now(), endAt: null, passScore: 60, submitted: false,
    }`, sb)
    await vm.runInContext('courseSaveResult(1, 1, 10)', sb)
    const perqExam = sb._enqueued.filter(e => e.ty === 'perq')
    assert('测评交卷同样上报 perq', perqExam.length === 1 && perqExam[0].d.qid === 101 && perqExam[0].d.correct === 1, JSON.stringify(perqExam))

    // 回顾轮不上报
    sb._enqueued.length = 0
    vm.runInContext(`courseQuiz = {
      phase: 'quiz', reviewing: true, type: 'homework', cid: 'c1', aid: 'h1',
      questions: [{ type: 'single', question: 'Stem A', options: ['a1', 'a2'], answer: [0] }],
      answers: [1], correct: 0, startAt: Date.now(), endAt: null, passScore: 60, submitted: false,
    }`, sb)
    await vm.runInContext('courseSaveResult(0, 1, 5)', sb)
    assert('回顾轮（reviewing）不上报 perq', sb._enqueued.filter(e => e.ty === 'perq').length === 0, JSON.stringify(sb._enqueued))
  }

  // ================= B. 防作弊强制终止 =================
  console.log('\n🧪 B. courseForceTerminate：切屏超限强制结束不计成绩')
  {
    const sb = makeSandbox(docRef)
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)

    // 行为：强制终止 → 会话清空、成绩不落库
    docRef.doc.classes[0].assignments[0].results = {}
    vm.runInContext(`courseQuiz = {
      phase: 'quiz', type: 'homework', cid: 'c1', aid: 'h1', title: '作业一',
      questions: [{ type: 'single', question: 'Stem A', options: ['a1', 'a2'], answer: [0] }],
      answers: [0], correct: 1, startAt: Date.now(), endAt: null, passScore: 60, submitted: false,
    }`, sb)
    vm.runInContext('courseForceTerminate()', sb)
    assert('强制终止 → 会话清空（courseQuiz=null）', vm.runInContext('courseQuiz', sb) === null)
    const res = docRef.doc.classes[0].assignments[0].results['张三']
    assert('强制终止 → 不写成绩记录（不计次数）', res === undefined, JSON.stringify(res || null))
    assert('强制终止 → 无 perq 上报', sb._enqueued.filter(e => e.ty === 'perq').length === 0)

    // 防御：无会话时调用不报错
    vm.runInContext('courseForceTerminate()', sb)
    assert('无会话时幂等', true)

    // 源码级：anti-cheat 支持 finalKey 且终止提示在 stop 之后显示（不会被立即清除）
    const acSrc = fs.readFileSync(path.join(__dirname, 'anti-cheat.js'), 'utf-8')
    assert('AntiCheat 支持 finalKey 自定义文案', /cfg\.finalKey \|\| 'anticheatFinal'/.test(acSrc))
    assert('达上限：先 stop 再 showFinal（提示保留）', /const cb = cfg\.onSubmit\s*\n\s*stop\(\)\s*\n\s*showFinal\(\)/.test(acSrc))
    assert('courseStart 防作弊带 anticheatTerminate 文案', /finalKey: 'anticheatTerminate'/.test(fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')))

    // i18n 双语
    const zh = vm.runInContext('t("anticheatTerminate")', sb)
    const en = vm.runInContext('I18N.en.anticheatTerminate', sb)
    assert('zh anticheatTerminate 含「不计入成绩」', zh.includes('不计入成绩'), zh)
    assert('en anticheatTerminate 含 not be recorded', /not be recorded/.test(en), en)
    const zhWarn = vm.runInContext('t("anticheatWarnDesc")', sb)
    assert('zh anticheatWarnDesc 改为「强制结束」', zhWarn.includes('强制结束'), zhWarn)
  }

  console.log(failed ? '\n❌ 存在失败项' : '\n✅ v59 每题上报 + 防作弊强制终止 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
