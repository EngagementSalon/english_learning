// ====== 测试：v39 线下课视频防快进 + 作业防作弊 ======
// ① 覆盖式观看统计纯函数：courseWatchMark / courseWatchedPct / courseEndedTrusted
//    —— 拖动跳过的片段不标记，无法靠快进凑完成度；断点续看后已看片段不重复计数
// ② courseStartVideo 行为级：诚实观看 → 达 90% 出现确认按钮；
//    直接拖到结尾触发 ended → 因覆盖不足不算播完、不出确认；补看后可恢复
// ③ 作业防作弊：courseStart(homework) 启动 AntiCheat，courseFinishHomework 提交并停止；
//    测评仍走 courseExamSubmit；防作弊文案改为通用（不再绑定「考试」）
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
    // video mock
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

const docRef = {
  doc: {
    v: 1,
    classes: [{
      id: 'c1', name: '测试班', note: '', createdBy: 'admin', members: ['张三'],
      assignments: [
        { id: 'v1', type: 'video', title: '服务礼仪视频', videoUrl: 'https://example.com/v.mp4', results: {} },
        { id: 'h1', type: 'homework', title: '第一节作业', status: 'open', questions: [
          { id: 901, category_id: 1, dept: 'all', type: 'single', difficulty: 1, question: 'colleague', options: ['同事', '账单', '菜单', '投诉'], answer: [0], explanation: 'colleague = 同事' },
        ], results: {} },
      ],
    }],
  },
}

;(async () => {
  // ================= A. 覆盖式观看统计纯函数 =================
  console.log('\n🧪 A. 覆盖式观看统计（防快进核心）')
  {
    const sb = makeSandbox(docRef)
    const r = vm.runInContext(`(() => {
      const out = {}
      // 正常播放 0→100（时长 200）→ 50%
      const w1 = new Set()
      courseWatchMark(w1, 0, 100)
      out.normalPct = courseWatchedPct(w1, 200)
      // 拖动：看完 0→50，跳到 180 再看 180→190 → 覆盖 60 秒 = 30%
      const w2 = new Set()
      courseWatchMark(w2, 0, 50)
      courseWatchMark(w2, 180, 190)
      out.seekPct = courseWatchedPct(w2, 200)
      out.seekSize = w2.size
      // 边界：from>to / 负值 / 非数值 不炸不加
      const w3 = new Set()
      courseWatchMark(w3, 80, 20)
      courseWatchMark(w3, -10, 5)
      courseWatchMark(w3, NaN, 10)
      courseWatchMark(w3, 0, NaN)
      out.edgeSize = w3.size   // NaN 起点→0：(NaN,10)标0..9、(-10,5)标0..4 → 并集 0..9 共 10 个
      // 重复标记不叠加
      const w4 = new Set()
      courseWatchMark(w4, 0, 100)
      courseWatchMark(w4, 50, 150)
      out.overlapSize = w4.size   // 0..149 共 150
      // 断点续看：上次看到 50（标记 0..50），本次从 50 续看 50→100 → 覆盖 100
      const w5 = new Set()
      courseWatchMark(w5, 0, 50)
      courseWatchMark(w5, 50, 100)
      out.resumePct = courseWatchedPct(w5, 200)
      // ended 可信判定
      const w6 = new Set()
      courseWatchMark(w6, 0, 85)   // 85% < 90%
      out.endedLow = courseEndedTrusted(w6, 200, 85, 180)
      courseWatchMark(w6, 85, 190) // 覆盖 95%
      out.endedHigh = courseEndedTrusted(w6, 200, 95, 180)
      out.endedFallbackNo = courseEndedTrusted(new Set(), 0, 100, 180)
      out.endedFallbackYes = courseEndedTrusted(new Set(), 0, 180, 180)
      out.pctNoDur = courseWatchedPct(w1, NaN)
      return out
    })()`, sb)
    assert('正常播放 100/200 秒 → 50%', r.normalPct === 50, `got ${r.normalPct}`)
    assert('拖动跳过 50-180 不计入 → 30%', r.seekPct === 30 && r.seekSize === 60, `got ${r.seekPct}% / ${r.seekSize}s`)
    assert('from>to / 负值 / NaN 安全（并集 10 秒）', r.edgeSize === 10, `got ${r.edgeSize}`)
    assert('重叠区间不重复计数（150 秒）', r.overlapSize === 150, `got ${r.overlapSize}`)
    assert('断点续看两段拼接 → 50%', r.resumePct === 50, `got ${r.resumePct}`)
    assert('ended：覆盖 85% 不可信', r.endedLow === false, `got ${r.endedLow}`)
    assert('ended：覆盖 95% 可信', r.endedHigh === true, `got ${r.endedHigh}`)
    assert('ended：无时长且累计秒不足 → 不可信', r.endedFallbackNo === false, `got ${r.endedFallbackNo}`)
    assert('ended：无时长但累计秒达标 → 可信', r.endedFallbackYes === true, `got ${r.endedFallbackYes}`)
    assert('无时长 → pct=0（走兜底判定）', r.pctNoDur === 0, `got ${r.pctNoDur}`)
  }

  // ================= B. courseStartVideo 行为级（防快进） =================
  console.log('\n🧪 B. 视频播放行为：诚实观看可完成，拖动快进不可')
  {
    // 场景 1：诚实播放到 90% → 出确认按钮
    const sb1 = makeSandbox(docRef)
    asStudent(sb1, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb1)
    vm.runInContext(`courseStart('c1', 'v1')`, sb1)
    const fire = (ev, fn) => vm.runInContext('(el, ev) => el._handlers[ev].forEach(f => f())', sb1)(vm.runInContext('_els.courseVideoEl', sb1), ev)
    const videoEl = vm.runInContext('_els.courseVideoEl', sb1)
    const confirmHtml = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb1)
    videoEl.duration = 100
    fire('loadedmetadata')
    videoEl.paused = false
    // 播放 0→45（逐秒 timeupdate 触发，模拟真实设备采样节拍；真实浏览器 ~4Hz、兜底 1s）
    for (let t = 1; t <= 45; t++) { videoEl.currentTime = t; fire('timeupdate') }
    let m = vm.runInContext('_els.courseVideoProgress.textContent', sb1)
    assert('播放 45% → 进度显示 45%', /45%/.test(m), `got "${m}"`)
    assert('45% 未出确认按钮', !confirmHtml().includes('courseVideoShowRating'), '不应出现确认')
    // 快进到 96（seeking 期间不标记），再看 96→97 → 有效观看 45+1=46 秒
    videoEl.seeking = true; videoEl.currentTime = 96; fire('timeupdate')
    videoEl.seeking = false; videoEl.currentTime = 97; fire('timeupdate')
    m = vm.runInContext('_els.courseVideoProgress.textContent', sb1)
    assert('快进后仅计真实观看（46%）', /46%/.test(m), `got "${m}"`)
    // 拖回 45 续看至 91 → 覆盖 45+1+46=92 秒 → 达标出确认
    videoEl.currentTime = 45; fire('timeupdate')   // 回退 seek 不标记
    for (let t = 46; t <= 91; t++) { videoEl.currentTime = t; fire('timeupdate') }   // 顺放 46→91
    assert('补看后覆盖 92% → 出现确认按钮', confirmHtml().includes('courseVideoShowRating'), confirmHtml().slice(0, 80))
    // 快照：有效观看秒在达标瞬间（90%）定格，不含拖动跳过的 45-96 区间（非拖动到的 97）
    const snap1 = vm.runInContext('courseVideoSnap && courseVideoSnap.watchedSec', sb1)
    assert('快照 watchedSec 为有效观看秒（≈90，非 97）', snap1 >= 88 && snap1 <= 92, `got ${snap1}`)

    // 场景 2：直接拖到结尾触发 ended → 覆盖不足不算播完、不出确认
    const sb2 = makeSandbox(docRef)
    asStudent(sb2, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb2)
    vm.runInContext(`courseStart('c1', 'v1')`, sb2)
    const v2 = vm.runInContext('_els.courseVideoEl', sb2)
    const fire2 = ev => vm.runInContext('(el, ev) => el._handlers[ev].forEach(f => f())', sb2)(v2, ev)
    const confirm2 = () => vm.runInContext('_els.courseVideoConfirmArea ? _els.courseVideoConfirmArea.innerHTML : ""', sb2)
    v2.duration = 100
    fire2('loadedmetadata')
    v2.paused = false
    v2.seeking = true; v2.currentTime = 99.5; fire2('timeupdate')   // 拖到结尾
    v2.seeking = false
    fire2('ended')   // 播放器停在结尾触发 ended
    assert('拖到结尾：不出确认按钮（覆盖不足）', !confirm2().includes('courseVideoShowRating'), confirm2().slice(0, 80))
    const prog2 = vm.runInContext('_els.courseVideoProgress.textContent', sb2)
    assert('拖到结尾：进度仍显示真实覆盖（0%）', /0%/.test(prog2), `got "${prog2}"`)
    // 拖回开头诚实补看 → 恢复可确认
    v2.currentTime = 0; fire2('timeupdate')    // 回退 seek 不标记，lastT 归零
    for (let t = 1; t <= 91; t++) { v2.currentTime = t; fire2('timeupdate') }   // 顺放 0→91
    assert('拖回补看至 91% → 出现确认按钮（可恢复）', confirm2().includes('courseVideoShowRating'), confirm2().slice(0, 80))
  }

  // ================= C. 作业防作弊 =================
  console.log('\n🧪 C. 作业防作弊接线')
  {
    const sb = makeSandbox(docRef)
    asStudent(sb, '张三')
    await vm.runInContext('courseTestSeedDoc()', sb)
    // 作业：courseStart 后 AntiCheat 应处于激活状态
    vm.runInContext(`courseStart('c1', 'h1')`, sb)
    assert('courseStart(作业) → AntiCheat 激活', vm.runInContext('AntiCheat.isActive()', sb) === true)
    // 提交作业 → AntiCheat 关闭 + 结果落库
    await vm.runInContext('courseFinishHomework()', sb)
    assert('courseFinishHomework → AntiCheat 关闭', vm.runInContext('AntiCheat.isActive()', sb) === false)
    const saved = docRef.doc.classes[0].assignments[1].results['张三']
    assert('作业结果已保存（score 字段存在）', !!saved && saved.score != null, JSON.stringify(saved || {}))
    assert('作业进入结果页（phase=result）', vm.runInContext('courseQuiz && courseQuiz.phase', sb) === 'result')

    // 源码级：v59 起违规达上限 → courseForceTerminate（不计成绩），不再直接交卷
    const src = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    assert('违规达上限 → courseForceTerminate', /onSubmit: function \(\) \{ courseForceTerminate\(\) \}/.test(src))
    assert('防作弊上限为 2 次', /maxViolations: 2/.test(src))
    assert('courseFinishHomework 内含 AntiCheat.stop()', /async function courseFinishHomework[\s\S]{0,200}AntiCheat\.stop\(\)/.test(src))

    // 防作弊文案通用化（作业场景不再写死「考试」）
    const zhWarn = vm.runInContext('t("anticheatWarn")', sb)
    const zhFinal = vm.runInContext('t("anticheatFinal")', sb)
    assert('zh anticheatWarn 不含「考试」', !zhWarn.includes('考试'), zhWarn)
    assert('zh anticheatFinal 不含「考试」', !zhFinal.includes('考试'), zhFinal)
    const enWarn = vm.runInContext('t("anticheatWarn") && I18N.en.anticheatWarn || ""', sb)
    assert('en anticheatWarn 不含 "exam"', !/exam/i.test(enWarn), enWarn)
  }

  console.log(failed ? '\n❌ 存在失败项' : '\n✅ v39 视频防快进 + 作业防作弊 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
