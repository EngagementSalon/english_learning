// ====== 测试：v45 视频「播放到 100% 但进度 0%、进不了课后小测」修复 ======
// 症状：部分安卓/内嵌浏览器 seek 结束后 seeking 标志卡死为 true，
//       v39 的 !v.seeking 判定让整段真实播放零累计 → 进度恒 0%、播完无法确认 → 进不了课后题
// ① courseEndedTrusted 5 参（endPos）语义：无时长视频诚实看到结尾 → 解锁；
//    拖到结尾覆盖≈0 → 不放行；4 参旧调用行为不变（兼容）
// ② 行为级：seeking 卡 true 时连续真实播放 tick → 第 3 个 tick 起恢复累计 →
//    进度达 90% 出确认 → ended 记 100% → 配了小测直接进入答题（courseQuiz.phase==='quiz'）
// ③ 回归：单次拖动 seek（1-2 个 tick）仍不累计（v39 防快进语义保持）
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

function makeSandbox(courseDocRef, preKeys) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  if (preKeys) Object.keys(preKeys).forEach(k => { lsStore[k] = preKeys[k] })
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

// 视频配了课后小测（listen 读音题 + single 选择题），reception→前台
// 每段测试用独立夹具（makeDocRef），避免前段写入的观看/测验记录污染后段状态
function makeDocRef() {
  return { doc: {
    v: 1,
    classes: [{
      id: 'c1', name: '测试班', note: '', createdBy: 'admin', members: ['张三'],
      assignments: [
        { id: 'v1', type: 'video', title: '服务礼仪视频', videoUrl: 'https://example.com/v.mp4',
          quiz: [
            { type: 'listen', question: 'reception', options: ['前台', '餐厅', '健身房', '行李'], answer: [0] },
            { type: 'single', question: 'What is the front desk called?', options: ['A', 'B', 'C', 'D'], answer: [0] },
          ],
          results: {} },
      ],
    }],
  } }
}

;(async () => {
  // ============ A. courseEndedTrusted endPos（无时长自然播完解锁） ============
  console.log('\n🧪 A. courseEndedTrusted 无时长自然播完（endPos 覆盖比对）')
  {
    const sb = makeSandbox(makeDocRef())
    const r = vm.runInContext(`(() => {
      const out = {}
      // 诚实从头看到结尾：时长读不到，结尾位置 120s，覆盖秒≈119 → 解锁
      const w1 = new Set()
      for (let s = 0; s < 119; s++) w1.add(s)
      out.honest = courseEndedTrusted(w1, 0, 119, 180, 120)
      // 拖到结尾：无覆盖 → 不放行（即使自然播完位置给了 120）
      const w2 = new Set()
      out.drag = courseEndedTrusted(w2, 0, 0, 180, 120)
      // 看到一半（60/120）→ 覆盖不足不放行
      const w3 = new Set()
      for (let s = 0; s < 60; s++) w3.add(s)
      out.half = courseEndedTrusted(w3, 0, 60, 180, 120)
      // ended 后 currentTime 归零（endPos 缺失）→ 退回累计秒兜底（4 参兼容语义）
      out.noPosShort = courseEndedTrusted(new Set(), 0, 100, 180)
      out.noPosLong  = courseEndedTrusted(new Set(), 0, 180, 180)
      // 有时长路径不受影响
      const w4 = new Set(); for (let s = 0; s < 95; s++) w4.add(s)
      out.withDur = courseEndedTrusted(w4, 100, 95, 180, 100)
      return out
    })()`, sb)
    assert('无时长：诚实看到结尾（覆盖 119/120）→ 可信解锁', r.honest === true, `got ${r.honest}`)
    assert('无时长：拖到结尾覆盖 0 → 不可信', r.drag === false, `got ${r.drag}`)
    assert('无时长：只看到一半（60/120）→ 不可信', r.half === false, `got ${r.half}`)
    assert('无时长且位置缺失 + 累计秒不足 → 不可信（旧语义）', r.noPosShort === false, `got ${r.noPosShort}`)
    assert('无时长且位置缺失 + 累计秒达标 → 可信（旧语义）', r.noPosLong === true, `got ${r.noPosLong}`)
    assert('有时长：覆盖 95% → 可信（路径不变）', r.withDur === true, `got ${r.withDur}`)
  }

  // ============ B. 行为级：seeking 卡死 true，真实播放仍能完成并进入小测 ============
  console.log('\n🧪 B. seeking 卡死容错：进度能到 90%+、确认后可进课后小测')
  {
    const refB = makeDocRef()
    const sb = makeSandbox(refB)
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb)
    const fire = ev => vm.runInContext('(el, ev) => el._handlers[ev].forEach(f => f())', sb)(videoEl, ev)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    const progText = () => vm.runInContext('_els.courseVideoProgress.textContent', sb)
    videoEl.duration = 100
    fire('loadedmetadata')
    videoEl.paused = false
    // 模拟 bug 设备：seeking 卡死为 true 且整个播放过程不复位
    videoEl.seeking = true
    // 逐秒真实播放 0→100（时间轴每 1s 触发一次，等价于真实设备 interval/timeupdate 节拍）
    vm.runInContext(`(() => {
      const v = _els.courseVideoEl
      for (let i = 1; i <= 100; i++) { v.currentTime = i; (v._handlers['timeupdate'] || []).forEach(f => f()) }
    })()`, sb)
    // 前 2 个 tick 是拖动保护窗口（防快进），只损失约 2 秒；此后持续累计
    assert('seeking 卡死下真实播放 → 进度 ≥95%（不再恒 0）', /9[5-9]%|100%/.test(progText()), `got "${progText()}"`)
    assert('播放达标 → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
    // 触发 ended（seeking 仍卡 true）→ 覆盖达标 → 记 100%
    fire('ended')
    assert('ended（覆盖足）→ 进度显示 100%', /100%/.test(progText()), `got "${progText()}"`)
    // 打分并提交 → 配了小测 → 直接进入答题
    vm.runInContext("courseVideoShowRating('c1','v1','张三')", sb)
    vm.runInContext("_els.courseVideoConfirmArea.dataset.rate = '4'", sb)
    await vm.runInContext("courseVideoSubmitRating('c1','v1','张三')", sb)
    const phase = vm.runInContext('courseQuiz && courseQuiz.phase', sb)
    assert('提交后进入课后小测（phase=quiz）', phase === 'quiz', `got ${phase}`)
    const qType = vm.runInContext('courseQuiz && courseQuiz.type', sb)
    assert('会话类型 videoquiz', qType === 'videoquiz', `got ${qType}`)
    const qCount = vm.runInContext('courseQuiz && courseQuiz.questions.length', sb)
    assert('小测 2 题进入答题页', qCount === 2, `got ${qCount}`)
    // 云端观看记录已写入（≥90%）；测验字段需答完题交卷后才合一
    const rec0 = refB.doc.classes[0].assignments[0].results['张三']
    assert('观看记录云端写入 ≥90%（小测待答）', rec0 && Number(rec0.watchedPct) >= 90 && rec0.quizTotal == null, JSON.stringify(rec0 || {}))
    // 答完 2 题交卷 → 测验成绩合一进同一条记录
    vm.runInContext('courseQuiz.questions.forEach((q, i) => { courseQuiz.answers[i] = q.answer[0] })', sb)
    vm.runInContext('courseQuiz.index = courseQuiz.questions.length - 1', sb)
    await vm.runInContext('courseVideoQuizFinish()', sb)
    const rec = refB.doc.classes[0].assignments[0].results['张三']
    assert('交卷后合一记录：观看 90% + 测验 2/2 + 100 分', rec && Number(rec.watchedPct) >= 90 && rec.quizTotal === 2 && rec.quizCorrect === 2 && rec.quizScore === 100, JSON.stringify(rec || {}))
  }

  // ============ C. 回归：单次拖动 seek 仍不累计（v39 语义） ============
  console.log('\n🧪 C. 回归：短拖动 seek 不累计，补看可恢复')
  {
    const sb = makeSandbox(makeDocRef())
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'v1')`, sb)
    const v = vm.runInContext('_els.courseVideoEl', sb)
    const fire = ev => vm.runInContext('(el, ev) => el._handlers[ev].forEach(f => f())', sb)(v, ev)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb)
    v.duration = 100
    fire('loadedmetadata')
    v.paused = false
    // 正常看 0→45（逐秒真实播放）
    for (let t = 1; t <= 45; t++) { v.currentTime = t; fire('timeupdate') }
    const m1 = vm.runInContext('_els.courseVideoProgress.textContent', sb)
    assert('诚实播放 0→45 → 45%', /45%/.test(m1), `got "${m1}"`)
    // 单次拖动 seek（1 个大跳 tick）→ 不累计、基线到 99
    v.seeking = true; v.currentTime = 99; fire('timeupdate')
    v.seeking = false
    const m2 = vm.runInContext('_els.courseVideoProgress.textContent', sb)
    assert('单次拖动 seek 后进度仍 45%（不累计）', /45%/.test(m2), `got "${m2}"`)
    assert('拖动后未出确认按钮', !confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
    // 拖回 45 诚实补看到 100（逐秒）→ 覆盖 100 → 出确认（旧场景回归）
    v.currentTime = 45; fire('timeupdate')
    for (let t = 46; t <= 100; t++) { v.currentTime = t; fire('timeupdate') }
    assert('拖回补看至 100% → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
  }

  console.log(failed ? '\n❌ v45 测试存在失败项' : '\n✅ v45 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('运行异常', e); process.exit(1) })
