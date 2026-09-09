// ====== 测试：v46 视频「已观看」进度真实跟踪（浮点有效观看秒）======
// 背景：v39 的覆盖式统计用「整秒取整区间」记账，只有单次采样跨过 ≥1 整秒才记 1 秒；
// 真实浏览器 timeupdate ≈4Hz（250ms 一跳）+ 1s 兜底定时器相位错开 → 几乎记不上整秒
// → 视频播到 100% 但「已观看」恒 0%、无法确认、进不了课后小测（v45 只修 seeking 卡死，未治本）。
// v46：有效观看秒 effSec 浮点累计（真实播放每跳直接累加）+ 单次前进 >3s 视为拖动跳段不计，
// 不再依赖 paused/seeking 标志（部分安卓/内嵌浏览器播放中卡 true）。
// ① coursePctBySec / courseEndedTrustedBySec 纯函数语义
// ② 核心回归：250ms（4Hz）细采样全程看完 → 进度 25%→100%、出确认、ended、提交进小测、合一记录
// ③ paused 恒 true 异常设备 → 照常累计
// ④ seeking 恒 true + paused 恒 true 双重异常 → 照常累计
// ⑤ 全屏/系统播放器接管：退出全屏回填接管期间播放量 → 出确认
// ⑥ 无时长视频（跨域元数据受限）：诚实看到结尾位置即解锁；拖到结尾不放行
// ⑦ 回归：单次大跳（拖动快进）不计入、补看可恢复
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
    addEventListener(ev, fn) { (el._handlers[ev] = el._handlers[ev] || []).push(fn) },
    removeEventListener() {},
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
  const lsStore = {}
  const docListeners = {}
  const winListeners = {}
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
    _els: elements, _getEl: getEl, _docListeners: docListeners, _winListeners: winListeners,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('anti-cheat.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)   // escHtml 等公共 helper 定义在 app.js
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
  Store.getUser = () => ({ name, dept: '' })
  return Store
}

function makeDocRef(withQuiz) {
  const assign = { id: 'v1', type: 'video', title: '服务礼仪视频', videoUrl: 'https://example.com/v.mp4', results: {} }
  if (withQuiz) {
    assign.quiz = [
      { type: 'listen', question: 'reception', options: ['前台', '餐厅', '健身房', '行李'], answer: [0] },
      { type: 'single', question: 'What is the front desk called?', options: ['A', 'B', 'C', 'D'], answer: [0] },
    ]
  }
  return { doc: { v: 1, classes: [{ id: 'c1', name: '测试班', note: '', createdBy: 'admin', members: ['张三'], assignments: [assign] }] } }
}

// 以 dt 秒为步进连续播放到 to（模拟真实 timeupdate 采样节拍），返回累计调用前可在 context 内执行
function playScript(from, to, dt) {
  const steps = []
  for (let t = from + dt; t <= to + 1e-9; t += dt) steps.push(t)
  return `(() => {
    const v = _els.courseVideoEl
    const h = v._handlers['timeupdate'] || []
    const arr = ${JSON.stringify(steps.map(s => +s.toFixed(3)))}
    for (let i = 0; i < arr.length; i++) { v.currentTime = arr[i]; for (let k = 0; k < h.length; k++) h[k]() }
  })()`
}

;(async () => {
  // ============ A. 纯函数（浮点口径） ============
  console.log('\n🧪 A. coursePctBySec / courseEndedTrustedBySec 语义')
  {
    const sb = makeSandbox(makeDocRef())
    const r = vm.runInContext(`(() => {
      const out = {}
      out.pct50 = coursePctBySec(50, 100)          // 看 50 秒 / 100 → 50%
      out.pctFull = coursePctBySec(99.75, 100)     // 细采样看到结尾 → 100%（旧整秒口径下是 0%）
      out.pctOver = coursePctBySec(150, 100)       // 重复观看超过时长 → 封顶 100%
      out.pctNoDur = coursePctBySec(50, NaN)       // 无时长 → 0（走秒数兜底）
      out.endDurOk = courseEndedTrustedBySec(90, 100, 180, 100)   // 有时长 90% → 可信
      out.endDurNo = courseEndedTrustedBySec(30, 100, 180, 100)   // 有时长 30% → 不可信
      out.endNoDurHonest = courseEndedTrustedBySec(119, 0, 180, 120)  // 无时长诚实到结尾 → 可信
      out.endNoDurDrag = courseEndedTrustedBySec(2, 0, 180, 120)      // 无时长拖到结尾 → 不可信
      out.endNoDurNoPos = courseEndedTrustedBySec(180, 0, 180, 0)     // 位置缺失 → 累计秒兜底达标
      return out
    })()`, sb)
    assert('看 50/100 秒 → 50%', r.pct50 === 50, `got ${r.pct50}`)
    assert('细采样看到结尾（99.75s）→ 100%（v46 核心）', r.pctFull === 100, `got ${r.pctFull}`)
    assert('重复观看超过时长 → 封顶 100%', r.pctOver === 100, `got ${r.pctOver}`)
    assert('无时长 → pct 0（走秒数兜底）', r.pctNoDur === 0, `got ${r.pctNoDur}`)
    assert('有时长 90% → ended 可信', r.endDurOk === true, `got ${r.endDurOk}`)
    assert('有时长 30% → ended 不可信（拖到结尾场景）', r.endDurNo === false, `got ${r.endDurNo}`)
    assert('无时长诚实看到结尾 → ended 可信', r.endNoDurHonest === true, `got ${r.endNoDurHonest}`)
    assert('无时长拖到结尾（2s）→ 不可信', r.endNoDurDrag === false, `got ${r.endNoDurDrag}`)
    assert('无时长位置缺失 → 累计秒兜底达标', r.endNoDurNoPos === true, `got ${r.endNoDurNoPos}`)
  }

  // ============ B. 核心回归：250ms（≈4Hz）细采样全程看完 → 全链路 ============
  console.log('\n🧪 B. 250ms 细采样全程看完 → 进度 25%→100% → 确认 → 进课后小测')
  {
    const ref = makeDocRef(true)
    const sb = makeSandbox(ref)
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb)
    const fire = ev => vm.runInContext('(el, ev) => (el._handlers[ev] || []).forEach(f => f())', sb)(videoEl, ev)
    const progText = () => vm.runInContext('_els.courseVideoProgress.textContent', sb)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    videoEl.duration = 100
    videoEl.paused = false
    fire('loadedmetadata')
    // 播放到 25s（100 个 250ms tick）→ 中途抽查：进度应 ≈25%（旧实现此处恒 0%）
    vm.runInContext(playScript(0, 25, 0.25), sb)
    const m25 = progText()
    assert('细采样看到 25s → 进度 ≈25%（不再恒 0）', /2[0-9]%/.test(m25), `got "${m25}"`)
    assert('25% 未出确认按钮', !confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 60))
    // 继续细采样到 100 → 100% 出确认
    vm.runInContext(playScript(25, 100, 0.25), sb)
    const m100 = progText()
    assert('细采样看到 100s → 进度 100%', /100%/.test(m100), `got "${m100}"`)
    assert('进度达标 → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
    // 自然播完 → 快照升级为「自然播完 100%」（90% 已出过确认按钮，ended 后升级，提交不记成 90%）
    fire('ended')
    assert('ended → 进度显示 100%', /100%/.test(progText()), `got "${progText()}"`)
    const snap = vm.runInContext('courseVideoSnap', sb)
    assert('ended 后快照升级为 100% / ended', snap && snap.ended === true && snap.watchedPct === 100 && snap.watchedSec === 100, JSON.stringify(snap || {}))
    // 打分提交 → 配小测 → 直接进入答题
    vm.runInContext("courseVideoShowRating('c1','v1','张三')", sb)
    vm.runInContext("_els.courseVideoConfirmArea.dataset.rate = '5'", sb)
    await vm.runInContext("courseVideoSubmitRating('c1','v1','张三')", sb)
    const phase = vm.runInContext('courseQuiz && courseQuiz.phase', sb)
    assert('提交后进入课后小测（phase=quiz）', phase === 'quiz', `got ${phase}`)
    // 云端观看记录：ended 升级 → 100%，小测待答
    const rec0 = ref.doc.classes[0].assignments[0].results['张三']
    assert('观看记录云端写入 100%（小测待答）', rec0 && Number(rec0.watchedPct) === 100 && rec0.watchedSec === 100 && rec0.quizTotal == null, JSON.stringify(rec0 || {}))
    // 答完全对交卷 → 合一记录
    vm.runInContext('courseQuiz.questions.forEach((q, i) => { courseQuiz.answers[i] = q.answer[0] })', sb)
    vm.runInContext('courseQuiz.index = courseQuiz.questions.length - 1', sb)
    await vm.runInContext('courseVideoQuizFinish()', sb)
    const rec = ref.doc.classes[0].assignments[0].results['张三']
    assert('交卷合一：观看 100% + 测验 2/2 满分', rec && Number(rec.watchedPct) === 100 && rec.quizTotal === 2 && rec.quizCorrect === 2 && rec.quizScore === 100, JSON.stringify(rec || {}))
  }

  // ============ C. paused 恒 true（异常设备）→ 照常累计 ============
  console.log('\n🧪 C. paused 恒 true 卡死设备：进度照常累计')
  {
    const sb = makeSandbox(makeDocRef())
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    const progText = () => vm.runInContext('_els.courseVideoProgress.textContent', sb)
    videoEl.duration = 100
    videoEl.paused = true    // 异常：实际在播放但 paused 恒 true（不复位）
    fireLoaded(sb, videoEl)
    vm.runInContext(playScript(0, 95, 1), sb)   // 逐秒真实播放 0→95
    assert('paused 卡 true 下真实播放 95s → 进度 95%', /95%/.test(progText()), `got "${progText()}"`)
    assert('达标 → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
  }
  function fireLoaded(sb, el) {
    vm.runInContext('(el) => (el._handlers["loadedmetadata"] || []).forEach(f => f())', sb)(el)
  }

  // ============ D. seeking 恒 true + paused 恒 true 双重异常 → 照常累计 ============
  console.log('\n🧪 D. seeking+paused 双重卡死设备：进度照常累计到 100%')
  {
    const sb = makeSandbox(makeDocRef())
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb)
    const progText = () => vm.runInContext('_els.courseVideoProgress.textContent', sb)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    videoEl.duration = 100
    videoEl.paused = true     // 异常 1
    videoEl.seeking = true    // 异常 2：seek 后永不复位
    fireLoaded(sb, videoEl)
    vm.runInContext(playScript(0, 100, 1), sb)
    assert('双重异常下真实播放 100s → 进度 100%', /100%/.test(progText()), `got "${progText()}"`)
    assert('达标 → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
  }

  // ============ E. 全屏/系统播放器接管：退出回填 ============
  console.log('\n🧪 E. 全屏播放器接管（页面无 timeupdate）：退出回填可确认')
  {
    const sb = makeSandbox(makeDocRef())
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb)
    const fire = ev => vm.runInContext('(el, ev) => (el._handlers[ev] || []).forEach(f => f())', sb)(videoEl, ev)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    const progText = () => vm.runInContext('_els.courseVideoProgress.textContent', sb)
    videoEl.duration = 100
    videoEl.paused = false
    fireLoaded(sb, videoEl)
    // 内联看 0→10s
    vm.runInContext(playScript(0, 10, 1), sb)
    assert('全屏前内联看到 10s', /10%/.test(progText()), `got "${progText()}"`)
    // 进入全屏（iOS Safari webkitbeginfullscreen / x5videoenterfullscreen）
    fire('webkitbeginfullscreen')
    // 全屏接管期间无任何 timeupdate：直接快进播放到 95 后退出全屏
    videoEl.currentTime = 95
    fire('webkitendfullscreen')
    assert('退出全屏回填 → 进度 ≈95%', /9[0-9]%/.test(progText()), `got "${progText()}"`)
    assert('回填达标 → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
    const snapSec = vm.runInContext('courseVideoSnap && courseVideoSnap.watchedSec', sb)
    assert('回填快照观看秒 ≈95', snapSec >= 93 && snapSec <= 95, `got ${snapSec}`)
  }

  // ============ F. 无时长视频（跨域受限）：看到结尾位置即解锁，拖到结尾不放行 ============
  console.log('\n🧪 F. 无时长视频：诚实看到结尾解锁；拖动到结尾不放行')
  {
    // F1 诚实观看
    const sb1 = makeSandbox(makeDocRef())
    asStudent(sb1, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb1)
    vm.runInContext(`courseStart('c1', 'v1')`, sb1)
    const videoEl1 = vm.runInContext('_els.courseVideoEl', sb1)
    const prog1 = () => vm.runInContext('_els.courseVideoProgress.textContent', sb1)
    const confirm1 = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb1)
    videoEl1.duration = NaN    // 跨域元数据受限：读不到时长
    videoEl1.paused = false
    fireLoaded(sb1, videoEl1)
    // 诚实看到 60s（短视频 60s）
    vm.runInContext(playScript(0, 60, 1), sb1)
    const m1 = prog1()
    assert('无时长：进度显示累计秒（60s / 180s）', /60\s*秒/.test(m1), `got "${m1}"`)
    assert('无时长：看到结尾位置（覆盖 85%+）→ 解锁确认', confirm1().includes('courseVideoShowRating'), confirm1().slice(0, 80))
    // F2 拖动到结尾
    const sb2 = makeSandbox(makeDocRef())
    asStudent(sb2, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb2)
    vm.runInContext(`courseStart('c1', 'v1')`, sb2)
    const videoEl2 = vm.runInContext('_els.courseVideoEl', sb2)
    const confirm2 = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb2)
    videoEl2.duration = NaN
    videoEl2.paused = false
    fireLoaded(sb2, videoEl2)
    videoEl2.currentTime = 60   // 直接拖到结尾（单次大跳）
    vm.runInContext('(el) => (el._handlers["timeupdate"] || []).forEach(f => f())', sb2)(videoEl2)
    assert('无时长：拖动到结尾只累计 ~0 秒 → 不放行', !confirm2().includes('courseVideoShowRating'), confirm2().slice(0, 80))
  }

  // ============ G. 回归：单次大跳（拖动快进）不计入、补看可恢复 ============
  console.log('\n🧪 G. 回归：拖动快进不计入；拖回补看可恢复确认')
  {
    const sb = makeSandbox(makeDocRef())
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb)
    const fire = ev => vm.runInContext('(el, ev) => (el._handlers[ev] || []).forEach(f => f())', sb)(videoEl, ev)
    const progText = () => vm.runInContext('_els.courseVideoProgress.textContent', sb)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    videoEl.duration = 100
    videoEl.paused = false
    fireLoaded(sb, videoEl)
    vm.runInContext(playScript(0, 45, 1), sb)   // 诚实看 45s
    assert('诚实看到 45s → 45%', /45%/.test(progText()), `got "${progText()}"`)
    videoEl.currentTime = 96   // 拖动快进到 96（单次大跳）
    fire('timeupdate')
    const m2 = progText()
    assert('拖动快进后进度仍 45%（跳段不计）', /45%/.test(m2), `got "${m2}"`)
    assert('拖动快进未出确认按钮', !confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 60))
    // 拖回 45 诚实补看至 100 → 累计 100 → 出确认
    vm.runInContext(playScript(45, 100, 1), sb)
    assert('拖回补看至结尾 → 出确认', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
  }

  console.log(failed ? '\n❌ v46 测试存在失败项' : '\n✅ v46 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('运行异常', e); process.exit(1) })
