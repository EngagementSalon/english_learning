// ====== 测试：v40 云端写入失败 → 成绩暂存本机，网络恢复后自动补传 ======
// ① CourseStore 待补传队列：enqueuePending 持久化 / pendingCount / 上限
// ② _applyResultOp 重放合并规则（幂等）：
//    - 班级/任务已删除 → drop；云端已有更新记录（at）→ drop
//    - video：只接受更高完成度；homework：云端已有更高分 → 保留高分
// ③ flushPending：成功 → 重放进云端并清空队列；网络仍失败 → 队列保留
// ④ 行为级：courseSaveResult 在 mutate 抛错/重试用尽时入队并返回 false，
//    courseFinishHomework 置 savedLocal、结果页出现「已暂存本机」提示
// ⑤ 行为级视频：courseVideoSubmitRating 失败 → 入队 + alert 暂存文案
// ⑥ i18n 三个新词条（zh/en）齐全
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
  const j = b ? s.indexOf(b, i + a.length) : s.length
  return j < 0 ? s.slice(i) : s.slice(i, j)
}

function mkEl() {
  const el = {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
  return el
}

function makeSandbox(preKeys) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  if (preKeys) Object.keys(preKeys).forEach(k => { lsStore[k] = preKeys[k] })
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
      addEventListener() {}, removeEventListener() {},
      visibilityState: 'visible',
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
    // 默认 fetch 永远失败（模拟离线）——需要联网的用例单独覆盖
    fetch: async () => { throw new Error('network down') },
    AbortController,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, addDuration() {}, flushDuration() {}, pushPending: async () => {} },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('course-store.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)   // escHtml 等公共 helper
  return sandbox
}

// 授予学员会话
function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
}

async function main() {
  // ---------- ① 队列持久化 ----------
  console.log('\n[1] enqueuePending 持久化 / pendingCount / 上限')
  {
    const sb = makeSandbox()
    const r1 = await vm.runInContext(`
      (async () => {
        const ok = CourseStore.enqueuePending({ atype: 'homework', cid: 'c1', aid: 'a1', u: 'stu', entry: { at: 1, score: 80 } })
        const bad = CourseStore.enqueuePending({ atype: 'homework' })   // 缺字段 → 拒绝
        return { ok, bad, count: CourseStore.pendingCount(), ls: localStorage.getItem('eq_course_pending') }
      })()
    `, sb)
    assert('合法 op 入队成功', r1.ok === true)
    assert('缺字段 op 被拒绝', r1.bad === false)
    assert('pendingCount=1', r1.count === 1, 'got ' + r1.count)
    assert('队列持久化到 localStorage eq_course_pending', /"u":"stu"/.test(r1.ls || ''))
    // 上限 100 条
    const cnt = await vm.runInContext(`
      (async () => {
        for (let i = 0; i < 150; i++) CourseStore.enqueuePending({ atype: 'homework', cid: 'c', aid: 'a' + i, u: 'u', entry: { at: i } })
        return CourseStore.pendingCount()
      })()
    `, sb)
    assert('队列上限 100 条（超出丢弃最旧）', cnt === 100, 'got ' + cnt)
  }

  // ---------- ② _applyResultOp 重放合并规则 ----------
  console.log('\n[2] _applyResultOp 重放合并规则')
  {
    const sb = makeSandbox()
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: '班', members: ['stu'], assignments: [
        { id: 'hw', type: 'homework', title: '作业', results: { stu: { at: 500, score: 90, correct: 9, total: 10, attempts: 1 } } },
        { id: 'vd', type: 'video', title: '视频', results: { stu: { at: 500, watched: true, watchedPct: 95 } } }
      ] } ] }
    `, sb)
    // apply 在 vm 内对 doc 副本执行，返回 { ret, doc } 供检查
    const apply = (doc, op) => vm.runInContext(
      `(() => { const d = ${JSON.stringify(doc)}; const ret = CourseStore._applyResultOp(d, ${JSON.stringify(op)}); return { ret, doc: d } })()`, sb)
    // 班级被删
    assert('班级已删除 → drop', apply({ v: 1, classes: [] }, { id: 'x', atype: 'homework', cid: 'cX', aid: 'hw', u: 'stu', entry: { at: 999, score: 10 } }).ret === 'drop')
    // 云端更新记录
    const d1 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'hw', type: 'homework', results: { stu: { at: 1000, score: 60, attempts: 3 } } }] }] }
    assert('云端已有更新记录(at 更大) → drop', apply(d1, { id: 'x', atype: 'homework', cid: 'c1', aid: 'hw', u: 'stu', entry: { at: 500, score: 80, attempts: 1 } }).ret === 'drop')
    // homework 云端更高分 → 保留高分
    const d2 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'hw', type: 'homework', results: { stu: { at: 100, score: 95, correct: 9, total: 10, attempts: 2 } } }] }] }
    const out2 = apply(d2, { id: 'x', atype: 'homework', cid: 'c1', aid: 'hw', u: 'stu', entry: { at: 999, score: 70, correct: 7, total: 10, attempts: 1 } })
    const hwRes = out2.doc.classes[0].assignments[0].results.stu
    assert('homework 重放保留云端更高分', out2.ret === 'applied' && hwRes.score === 95 && hwRes.correct === 9 && hwRes.at === 999, JSON.stringify(hwRes))
    // video 只接受更高完成度
    const d3 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'vd', type: 'video', results: { stu: { at: 100, watched: true, watchedPct: 95 } } }] }] }
    assert('video 云端已完成度更高 → drop', apply(d3, { id: 'x', atype: 'video', cid: 'c1', aid: 'vd', u: 'stu', entry: { at: 999, watchedPct: 80 } }).ret === 'drop')
    const d4 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'vd', type: 'video', results: { stu: { at: 100, watched: true, watchedPct: 60 } } }] }] }
    const out4 = apply(d4, { id: 'x', atype: 'video', cid: 'c1', aid: 'vd', u: 'stu', entry: { at: 999, watched: true, watchedPct: 100 } })
    assert('video 更高完成度 → applied 且覆盖（自愈升级）',
      out4.ret === 'applied' && out4.doc.classes[0].assignments[0].results.stu.watchedPct === 100)
    // exam 直接写入（首次成绩语义）
    const d5 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'ex', type: 'exam', results: {} }] }] }
    const out5 = apply(d5, { id: 'x', atype: 'exam', cid: 'c1', aid: 'ex', u: 'stu', entry: { at: 999, score: 88, attempts: 1 } })
    assert('exam 无冲突 → applied', out5.ret === 'applied' && out5.doc.classes[0].assignments[0].results.stu.score === 88)
  }

  // ---------- ③ flushPending 成功 / 失败 ----------
  console.log('\n[3] flushPending 补传成功清空 / 失败保留')
  {
    // 失败路径：fetch 永远抛错
    const sbFail = makeSandbox()
    const CSF = vm.runInContext('CourseStore', sbFail)
    CSF.status = 'online'
    CSF.enqueuePending({ atype: 'homework', cid: 'c1', aid: 'a1', u: 'stu', entry: { at: 1, score: 80 } })
    await CSF.flushPending()
    assert('网络仍失败 → 队列保留（不丢数据）', CSF.pendingCount() === 1, 'got ' + CSF.pendingCount())

    // 成功路径：mock 云文档读写
    const sbOk = makeSandbox()
    const CSO = vm.runInContext('CourseStore', sbOk)
    CSO.status = 'online'
    let cloud = { v: 1, classes: [{ id: 'c1', name: '班', members: ['stu'], assignments: [{ id: 'a1', type: 'homework', title: '作业', results: {} }] }] }
    let putCount = 0
    CSO._fetchDoc = async () => cloud
    CSO._put = async body => { cloud = JSON.parse(body); putCount++ }
    CSO.enqueuePending({ atype: 'homework', cid: 'c1', aid: 'a1', u: 'stu', entry: { at: 900, score: 85, correct: 8, total: 10, attempts: 1 } })
    await CSO.flushPending()
    const res = cloud.classes[0].assignments[0].results.stu
    assert('补传后云端写入成绩', putCount === 1 && res && res.score === 85, JSON.stringify({ putCount, res }))
    assert('补传成功 → 队列清空', CSO.pendingCount() === 0, 'got ' + CSO.pendingCount())

    // 离线状态下 flushPending 直接跳过（不丢队列）
    CSO.status = 'offline'
    CSO.enqueuePending({ atype: 'exam', cid: 'c1', aid: 'a1', u: 'stu', entry: { at: 901, score: 70, attempts: 1 } })
    await CSO.flushPending()
    assert('离线状态下不尝试补传（队列保留）', CSO.pendingCount() === 1)
  }

  // ---------- ④ 行为级：作业提交失败 → 入队 + 结果页提示 ----------
  console.log('\n[4] courseFinishHomework 失败入队 + 结果页提示')
  {
    const sb = makeSandbox()   // fetch 全部失败 → mutate 抛错
    asStudent(sb, 'stu')
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: '班', members: ['stu'], assignments: [
        { id: 'hw1', type: 'homework', title: '英语作业', questions: [
          { type: 'judge', question: 'q1', options: ['A','B'], answer: [0], explanation: '' },
          { type: 'judge', question: 'q2', options: ['A','B'], answer: [0], explanation: '' }
        ], results: {} } ] } ] }
      courseQuiz = { phase: 'quiz', type: 'homework', cid: 'c1', aid: 'hw1', passScore: 60,
        startAt: Date.now() - 60000, index: 1, correct: 1, submitted: false,
        questions: courseState.doc.classes[0].assignments[0].questions, answers: [0, 0] }
    `, sb)
    const AntiCheatMock = { started: false, stopped: false, start() { this.started = true }, stop() { this.stopped = true } }
    sb.AntiCheat = AntiCheatMock
    await vm.runInContext('courseFinishHomework()', sb)
    const CS = vm.runInContext('CourseStore', sb)
    const qz = vm.runInContext('courseQuiz', sb)
    const q = vm.runInContext('JSON.parse(localStorage.getItem("eq_course_pending"))', sb)
    assert('云端写入失败 → 成绩入待补传队列', CS.pendingCount() === 1 && q[0].atype === 'homework' && q[0].u === 'stu')
    assert('队列中的成绩分数正确（1/2=50 分）', q[0].entry.score === 50, JSON.stringify(q[0].entry))
    assert('courseSaveResult 返回 false（未上云）', qz.savedLocal === true)
    const pageHtml = sb.document.getElementById('page-course').innerHTML
    assert('结果页出现「已暂存本机」提示',
      pageHtml.includes('暂存在本机') || pageHtml.includes('saved on this device'),
      pageHtml.slice(0, 200))
    assert('防作弊监听已停止', AntiCheatMock.stopped === true)
  }

  // ---------- ⑤ 行为级：视频提交失败 → 入队 + alert 暂存文案 ----------
  console.log('\n[5] courseVideoSubmitRating 失败入队')
  {
    const sb = makeSandbox()
    asStudent(sb, 'stu')
    vm.runInContext(`
      courseState.doc = { v: 1, classes: [ { id: 'c1', name: '班', members: ['stu'], assignments: [
        { id: 'vd1', type: 'video', title: '视频课', results: {} } ] } ] }
    `, sb)
    // DOM：确认区已选 3 星
    sb.document.getElementById('courseVideoConfirmArea').dataset.rate = '3'
    vm.runInContext('courseVideoSnap = { cid: "c1", aid: "vd1", ended: true, watchedPct: 100, watchedSec: 300, duration: 300 }', sb)
    await vm.runInContext(`courseVideoSubmitRating('c1', 'vd1', 'stu')`, sb)
    const CS = vm.runInContext('CourseStore', sb)
    const q = vm.runInContext('JSON.parse(localStorage.getItem("eq_course_pending"))', sb)
    assert('视频提交失败 → 完成记录入待补传队列', CS.pendingCount() === 1 && q[0].atype === 'video')
    assert('队列中的视频记录 watchedPct=100', q[0].entry.watchedPct === 100 && q[0].entry.difficulty === 3, JSON.stringify(q[0].entry))
    const I18N = vm.runInContext('I18N', sb)
    const wantAlert = I18N.zh.courseSaveQueuedAlert
    assert('alert 显示「已暂存本机」文案', sb._lastAlert === wantAlert, sb._lastAlert)
  }

  // ---------- ⑥ i18n 词条齐全 ----------
  console.log('\n[6] i18n 新词条（zh/en）')
  {
    const sb = makeSandbox()
    const I18N = vm.runInContext('I18N', sb)
    const keys = ['courseSaveQueuedTip', 'courseSaveQueuedAlert', 'coursePendingUpload']
    keys.forEach(k => {
      assert(`zh.${k} 存在`, !!(I18N.zh && I18N.zh[k]))
      assert(`en.${k} 存在`, !!(I18N.en && I18N.en[k]))
    })
    assert('coursePendingUpload 可带数量参数', I18N.zh.coursePendingUpload(2).includes('2'))
  }

  // ---------- ⑦ 源码接线断言 ----------
  console.log('\n[7] 源码接线断言')
  {
    const store = fs.readFileSync(path.join(__dirname, 'course-store.js'), 'utf-8')
    assert('course-store.js：getDoc 成功后调度补传', store.includes('this._schedulePendingFlush(2000)'))
    assert('course-store.js：后台重试成功后调度补传', store.split('_schedulePendingFlush(2000)').length >= 3)
    assert('course-store.js：浏览器 online 事件触发补传', store.includes("window.addEventListener('online'"))
    const app = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('course-app.js：courseSaveResult 失败入队', app.includes('CourseStore.enqueuePending({'))
    assert('course-app.js：结果页暂存提示', app.includes('courseSaveQueuedTip'))
    assert('course-app.js：学员列表待上传横幅', app.includes('coursePendingUpload'))
  }

  console.log(failed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(failed ? 1 : 0)   // 必须显式退出：沙箱内定时器句柄会阻止进程自然退出
}

main().catch(e => { console.error('测试执行异常：', e); process.exit(1) })
