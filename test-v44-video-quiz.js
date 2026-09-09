// ====== 测试：v44 视频课后小测（读音题 + 选择题，最多 10 题） ======
// ① 完成判定：配了小测且未答 → 未完成；答过 → 完成；无小测行为不变
// ② 小测构建器收集：校验、空选项剔除后答案索引重映射、草稿宽松、10 题上限、空行跳过
// ③ 成绩条目构建：合并观看字段 + 测验字段、attempts 累加、逾期标记
// ④ 待补传队列 videoquiz 类型：新鲜应用 / 过期丢弃 / 保留更高观看值
// ⑤ 学员端：待答题徽标 + 去答题按钮；完成后显示测验得分；视频页去答题入口
// ⑥ 答题会话：courseVideoQuizStart / courseVideoQuizFinish 全链路写入 results
// ⑦ 管理端：任务表题数 + 编辑测验按钮；成绩详情测验列；Excel 单元格追加测验得分
// ⑧ i18n 双语键齐全
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}
function sliceBetween(s, a, b) {
  const i = s.indexOf(a)
  if (i < 0) return ''
  const j = s.indexOf(b, i + a.length)
  return j < 0 ? '' : s.slice(i, j)
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

function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
  Store.getUser = () => ({ name, dept: '' })
  return Store
}

const QUIZ = [
  { type: 'listen', question: 'reception', options: ['前台', '餐厅', '健身房', '行李'], answer: [0], explanation: '' },
  { type: 'single', question: 'Where do guests check in?', options: ['Front desk', 'WOOBAR', 'SPA', 'Ballroom'], answer: [0], explanation: '' },
]

const docBase = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1', 's2'],
  assignments: [
    { id: 'v1', type: 'video', title: '入住服务视频', desc: '', deadline: 0, createdAt: 1, videoUrl: 'https://x.mp4', quiz: JSON.parse(JSON.stringify(QUIZ)), results: {} },
    { id: 'v2', type: 'video', title: '无小测视频', desc: '', deadline: 0, createdAt: 1, videoUrl: 'https://x.mp4', results: {} },
  ] }] } }

;(async () => {
  console.log('\n🧪 v44 视频课后小测回归测试\n')

  console.log('① 完成判定与待答题判定')
  const sbA = makeSandbox({ doc: {} })
  assert('无小测 + 100% → 完成（回归不变）', vm.runInContext('courseTaskDone({ type: "video" }, { watchedPct: 100 })', sbA) === true)
  assert('无小测 + 3% → 未完成（回归不变）', vm.runInContext('courseTaskDone({ type: "video" }, { watchedPct: 3 })', sbA) === false)
  assert('配小测 + 100% 但未答 → 未完成', vm.runInContext('courseTaskDone({ type: "video", quiz: [{}] }, { watchedPct: 100 })', sbA) === false)
  assert('配小测 + 100% + 已答 → 完成', vm.runInContext('courseTaskDone({ type: "video", quiz: [{}] }, { watchedPct: 100, quizTotal: 2 })', sbA) === true)
  assert('配小测 + 无记录 → 未完成', vm.runInContext('courseTaskDone({ type: "video", quiz: [{}] }, null)', sbA) === false)
  assert('quizPending：有 quiz + 无 quizTotal → true', vm.runInContext('courseVideoQuizPending({ type: "video", quiz: [1] }, { watchedPct: 100 })', sbA) === true)
  assert('quizPending：已答 → false', vm.runInContext('courseVideoQuizPending({ type: "video", quiz: [1] }, { quizTotal: 2 })', sbA) === false)
  assert('quizPending：无 quiz → false', vm.runInContext('courseVideoQuizPending({ type: "video" }, null)', sbA) === false)
  assert('quizPending：quiz 空数组 → false', vm.runInContext('courseVideoQuizPending({ type: "video", quiz: [] }, null)', sbA) === false)

  console.log('\n② 小测构建器收集（courseQuizCollect）')
  const collect = expr => vm.runInContext(expr, sbA)
  const ok1 = collect(`courseQuizCollect('ca', [{ type:'single', question:'Q1', options:['A','','B',''], answer:[2], explanation:' x ' }], true)`)
  assert('空选项剔除 + 答案索引重映射 2→1', ok1.ok && ok1.quiz.length === 1 && ok1.quiz[0].options.length === 2 && ok1.quiz[0].answer[0] === 1 && ok1.quiz[0].explanation === 'x')
  const bad = collect(`courseQuizCollect('ca', [{ type:'single', question:'Q', options:['A',''], answer:[0], explanation:'' }], true)`)
  assert('仅 1 个有效选项 + 严格模式 → ok=false 并 alert', bad.ok === false && String(sbA._lastAlert).includes('1'))
  const loose = collect(`courseQuizCollect('ca', [{ type:'single', question:'Q', options:['A',''], answer:[0] }, { type:'single', question:'Q2', options:['A','B'], answer:[1] }], false)`)
  assert('草稿宽松：不完整行静默丢弃，完整行保留', loose.ok && loose.quiz.length === 1 && loose.quiz[0].question === 'Q2')
  const empty = collect(`courseQuizCollect('ca', [{ type:'single', question:'', options:['','','',''], answer:[0] }], true)`)
  assert('整行空白跳过 → quiz 为空数组', empty.ok && empty.quiz.length === 0)
  const ten = collect(`courseQuizCollect('ca', Array.from({length:12},(_,i)=>({ type:'single', question:'Q'+i, options:['A','B'], answer:[0] })), true)`)
  assert('最多收集 10 题（上限截断）', ten.ok && ten.quiz.length === 10)
  const listen = collect(`courseQuizCollect('ca', [{ type:'listen', question:'lobby', options:['大堂','酒吧'], answer:[0] }], true)`)
  assert('读音题类型保留 listen', listen.ok && listen.quiz[0].type === 'listen')
  const ansMissing = collect(`courseQuizCollect('ca', [{ type:'single', question:'Q', options:['A','B'], answer:[] }], true)`)
  assert('未勾选正确答案 + 严格 → ok=false', ansMissing.ok === false)

  console.log('\n③ 成绩条目构建（courseVideoQuizBuildEntry）')
  const now = Date.now()
  const e1 = vm.runInContext(`courseVideoQuizBuildEntry({ deadline: ${now + 1000} }, { watchedPct: 95, watchedSec: 300, duration: 320, difficulty: 3, attempts: 1 }, { watchedSec: 10 }, 8, 10, ${now})`, sbA)
  assert('保留 prev 观看字段（95%）', e1.watchedPct === 95 && e1.watchedSec === 300 && e1.duration === 320)
  assert('叠加测验字段', e1.quizCorrect === 8 && e1.quizTotal === 10 && e1.quizScore === 80)
  assert('attempts 累加 1→2', e1.attempts === 2)
  assert('未逾期 → 无 overdue 标记', !e1.overdue)
  const e2 = vm.runInContext(`courseVideoQuizBuildEntry({ deadline: ${now - 1000} }, null, { watchedPct: 100, watchedSec: 300, duration: 300, difficulty: 2 }, 5, 10, ${now})`, sbA)
  assert('无 prev：从 snap 构造', e2.watchedPct === 100 && e2.quizScore === 50)
  assert('逾期提交 → overdue=true', e2.overdue === true)

  console.log('\n④ 待补传队列 videoquiz 重放（course-store _applyResultOp）')
  const CS = require('./course-store.js')
  {
    const doc = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'v1', type: 'video', results: { s1: { at: 1, watched: true, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3, attempts: 1 } } }] }] }
    const r1 = CS._applyResultOp(doc, { id: 'op1', atype: 'videoquiz', cid: 'c1', aid: 'v1', u: 's1', entry: { at: 100, quizCorrect: 9, quizTotal: 10, quizScore: 90, quizAt: 100, watchedPct: 100, watchedSec: 100, attempts: 2 } })
    const rec = doc.classes[0].assignments[0].results.s1
    assert('新鲜 quiz 记录 → applied 且合并观看字段', r1 === 'applied' && rec.quizScore === 90 && rec.watchedPct === 100 && rec.watchedSec === 200 && rec.difficulty === 3)
    const doc2 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'v1', type: 'video', results: { s1: { at: 500, watchedPct: 100, quizTotal: 10, quizCorrect: 10, quizAt: 500 } } }] }] }
    const r2 = CS._applyResultOp(doc2, { id: 'op2', atype: 'videoquiz', cid: 'c1', aid: 'v1', u: 's1', entry: { at: 100, quizCorrect: 1, quizTotal: 10, quizAt: 100 } })
    assert('云端已有更新测验记录（quizAt 更大）→ drop', r2 === 'drop' && doc2.classes[0].assignments[0].results.s1.quizCorrect === 10)
    const doc3 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'v1', type: 'video', results: {} }] }] }
    const r3 = CS._applyResultOp(doc3, { id: 'op3', atype: 'videoquiz', cid: 'c1', aid: 'v1', u: 's1', entry: { at: 100, watchedPct: 90, watchedSec: 180, quizTotal: 10, quizCorrect: 7, quizScore: 70, quizAt: 100 } })
    assert('无 prev 记录 → 直接写入', r3 === 'applied' && doc3.classes[0].assignments[0].results.s1.quizScore === 70)
    const r4 = CS._applyResultOp({ v: 1, classes: [{ id: 'c1', assignments: [] }] }, { id: 'op4', atype: 'videoquiz', cid: 'c1', aid: 'gone', u: 's1', entry: {} })
    assert('任务已被删除 → drop', r4 === 'drop')
  }

  console.log('\n⑤ 学员端：卡片待答题状态 / 视频页去答题入口')
  const docStudent = JSON.parse(JSON.stringify(docBase))
  docStudent.doc.classes[0].assignments[0].results = { s1: { at: 1, watched: true, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3 } }
  const sbS = makeSandbox(docStudent)
  asStudent(sbS, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbS)
  vm.runInContext('renderCourseStudent()', sbS)
  const card = sbS._els['page-course'].innerHTML
  assert('看完未答 → 显示「待答题」徽标', card.includes('待答题'))
  assert('看完未答 → 显示「去答题」按钮', card.includes('去答题'))
  assert('看完未答 → 不显示已完成', !sliceBetween(card, 'course-card-title', 'course-card-actions').includes('courseDoneTag') && !sliceBetween(card, 'course-card-title', 'course-card-actions').includes('✓'))
  // 完成后：显示测验得分
  const docDone = JSON.parse(JSON.stringify(docBase))
  docDone.doc.classes[0].assignments[0].results = { s1: { at: 1, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3, quizCorrect: 9, quizTotal: 10, quizScore: 90 } }
  const sbD = makeSandbox(docDone)
  asStudent(sbD, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbD)
  vm.runInContext('renderCourseStudent()', sbD)
  const card2 = sbD._els['page-course'].innerHTML
  assert('答题后 → 显示完成 + 测验 9/10', card2.includes('✓') && card2.includes('9/10') && !card2.includes('待答题'))
  // 视频页 quizPending 去答题入口
  const docPend = JSON.parse(JSON.stringify(docBase))
  docPend.doc.classes[0].assignments[0].results = { s1: { at: 1, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3 } }
  const sbP = makeSandbox(docPend)
  asStudent(sbP, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbP)
  vm.runInContext("courseStartVideo('c1','v1')", sbP)
  const vpage = sbP._els['page-course'].innerHTML
  assert('视频页看完未答 → 显示去答题入口（courseVideoQuizStart）', vpage.includes('courseVideoQuizStart') && vpage.includes('回答小测题目后'))
  assert('视频页看完未答 → 不显示完成态', !vpage.includes('已完成，感谢观看'))

  console.log('\n⑥ 答题会话：courseVideoQuizStart / courseVideoQuizFinish')
  const sbQ = makeSandbox(JSON.parse(JSON.stringify(docBase)))
  asStudent(sbQ, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbQ)
  vm.runInContext(`courseVideoQuizStart('c1','v1','s1')`, sbQ)
  assert('进入答题会话 type=videoquiz', vm.runInContext('courseQuiz && courseQuiz.type === "videoquiz" && courseQuiz.phase === "quiz"', sbQ) === true)
  assert('题目数量 = 小测题数（2）', vm.runInContext('courseQuiz.questions.length', sbQ) === 2)
  assert('观看快照从已有记录构造（100%）', vm.runInContext('courseVideoQuizSnap && courseVideoQuizSnap.watchedPct', sbQ) === 100)
  // 模拟答完全部：按每题的正确答案作答（选项顺序已被打乱，读取重映射后的 answer）
  vm.runInContext('courseQuiz.questions.forEach((q, i) => { courseQuiz.answers[i] = q.answer[0] }); courseQuiz.index = courseQuiz.questions.length - 1', sbQ)
  await vm.runInContext('courseVideoQuizFinish()', sbQ)
  const qzPhase = vm.runInContext('courseQuiz.phase', sbQ)
  assert('交卷后进入结果页', qzPhase === 'result')
  assert('结果页显示小测完成标题', sbQ._els['page-course'].innerHTML.includes('小测完成'))
  assert('全对得分 100', vm.runInContext('courseQuiz.resultScore', sbQ) === 100)
  // 云端已写入（mutate 成功路径）—— 注意 courseState.doc 是进页面时的快照，需重取云端文档
  const docAfter = await vm.runInContext('CourseStore.getDoc()', sbQ)
  const rec = docAfter.classes[0].assignments[0].results.s1
  assert('云端写入观看 + 测验合一记录', rec && rec.watchedPct === 100 && rec.quizTotal === 2 && rec.quizCorrect === 2 && rec.quizScore === 100 && rec.quizAt > 0)
  assert('云端无待补传 op', (sbQ._pending || []).length === 0)

  console.log('\n⑦ 管理端：任务表 / 成绩详情 / Excel 单元格')
  const docAdmin = JSON.parse(JSON.stringify(docBase))
  docAdmin.doc.classes[0].assignments[0].results = { s1: { at: 1, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3, quizCorrect: 9, quizTotal: 10, quizScore: 90 } }
  const sbAd = makeSandbox(docAdmin)
  const StoreA = vm.runInContext('Store', sbAd)
  StoreA.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  StoreA.getUser = () => ({ name: '管理员', dept: '' })
  await vm.runInContext('courseTestSeedDoc()', sbAd)
  await vm.runInContext("courseState.adminView = true; courseOpenClass('c1')", sbAd)
  await new Promise(r => setTimeout(r, 30))
  const adminHtml = sbAd._els['page-course'].innerHTML
  assert('任务表显示小测题数 2', /video.*?<td[^>]*>2<\/td>/s.test(adminHtml) || adminHtml.includes('>2</td>'))
  assert('任务表显示「编辑测验」按钮', adminHtml.includes('courseEditQuizModal'))
  await vm.runInContext("courseAssignDetail('c1','v1')", sbAd)
  await new Promise(r => setTimeout(r, 30))
  const detail = sbAd._els['page-course'].innerHTML
  assert('成绩详情含测验列（测验表头）', detail.includes('>测验<'))
  assert('成绩详情显示 9/10', detail.includes('9/10'))
  const cell = vm.runInContext(`courseExportCell({ type:'video', quiz:[1,2] }, { watchedPct: 100, quizCorrect: 9, quizTotal: 10 })`, sbAd)
  assert('Excel 单元格：已答完 → 小测正确率 90% · 9/10（v48 替代观看完成率）', cell === '90% · 9/10')
  const cell2 = vm.runInContext(`courseExportCell({ type:'video' }, { watchedPct: 95 })`, sbAd)
  assert('无小测 Excel 单元格不变（95%）', cell2 === '95%')

  console.log('\n⑧ i18n 双语键齐全')
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  const keys = ['courseQuizLabel', 'courseQuizTypeListen', 'courseQuizTypeSingle', 'courseQuizCount', 'courseVideoQuizBtn',
    'courseVideoQuizTag', 'courseVideoQuizDoneTitle', 'courseVideoQuizDoneAlert', 'courseVideoQuizTip',
    'courseQuizBuilderTitle', 'courseQuizBuilderHint', 'courseQuizQText', 'courseQuizAddQ', 'courseQuizMaxQ',
    'courseQuizInvalid', 'courseEditQuizBtn', 'courseEditQuizTitle', 'courseQuizSaved', 'courseThQuiz']
  const zhBlock = i18nSrc.slice(0, i18nSrc.indexOf("en: {") >= 0 ? i18nSrc.indexOf("en: {") : i18nSrc.length)
  keys.forEach(k => {
    assert(`zh.${k}`, new RegExp(k + ':').test(i18nSrc.slice(0, i18nSrc.indexOf("'Video'"))))
  })
  keys.forEach(k => {
    assert(`en.${k}`, new RegExp(k + ':').test(i18nSrc.slice(i18nSrc.indexOf("'Video'"))))
  })

  // 收尾：沙箱内 setInterval（云拉取等）会让进程挂住，必须显式退出
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
