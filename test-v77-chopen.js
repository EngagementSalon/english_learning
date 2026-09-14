// ====== 测试 v77：七天挑战管理员开放开关 + 结束灰掉 + sticky hover 修复 ======
// ① cloud-store：_getDoc 侧信道 _chOpen/_chOpenAt（缺省关闭）+ setChallengeOpen 读改写/失败重试/跨端同步/关闭保留 chOpenAt
// ② challenge.js：未开放/已结束 → 阶段入口灰掉（已完成测试仍显示分数）+ chStartStage 全局拦截 + 概览横幅
// ③ challenge.js：挑战开关拉取后变化 → 概览页重渲染（与考试开关复合判定）
// ④ app.js 接线（开关卡 + 入口卡提示）+ i18n 双语成对 + style.css hover 修复
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// ---- fetch mock（GET 返回 state.doc；POST 覆盖 state.doc，failPut 时恒 500） ----
function fetchImpl(state) {
  state.calls = { get: 0, put: 0 }
  return async (url, opt) => {
    opt = opt || {}
    if (opt.method === 'POST') {
      state.calls.put++
      if (state.failPut) return { ok: false, status: 500 }
      state.doc = JSON.parse(opt.body)
      return { ok: true }
    }
    state.calls.get++
    return { ok: true, text: async () => JSON.stringify(state.doc) }
  }
}

function loadCloudStoreWithFetch(fetchFn) {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setInterval() { return 0 }, clearInterval() {},
    setTimeout() { return 0 }, clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {}, visibilityState: 'visible' },
    fetch: fetchFn, AbortController: global.AbortController,
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
  return { sb, CloudSync: vm.runInContext('CloudSync', sb) }
}

// ---- challenge.js 沙箱（进度预置：Day1-6 全完成、Day7 巩固完成、期末考试未考） ----
// chOpen=挑战开关；chOpenAt=最近一次开放时间（0=从未开放）
function makeChSandbox(chOpen, chOpenAt) {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm() { return true },
  }
  sb.window = sb
  sb.window.__els = {}
  sb.document = {
    addEventListener() {},
    getElementById(id) { return (sb.window.__els[id] = sb.window.__els[id] || { id, innerHTML: '' }) },
  }
  sb.alert = (m) => { (sb.window.__alerts = sb.window.__alerts || []).push(m) }
  sb.AntiCheat = {
    start(opts) { sb.window.__acStart = (sb.window.__acStart || 0) + 1; sb.window.__acOpts = opts || null },
    stop() { sb.window.__acStop = (sb.window.__acStop || 0) + 1 },
    isActive() { return false },
    getViolations() { return 0 },
    dismiss() {},
    isAdminUser() { return false },
  }
  sb.CloudSync = { enqueue() {}, _chExamOpen: true, _chOpen: !!chOpen, _chOpenAt: chOpenAt || 0 }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  vm.runInContext(['shuffleOptions', 'checkAnswer', 'escHtml'].map(n => extractFn(appSrc, n)).join('\n'), sb)
  // renderChallengeQuiz 渲染依赖（el 可用 → 注入简版，同 test-v76）
  vm.runInContext(
    'const TYPE_LABELS = new Proxy({}, { get: (_, k) => k });' +
    'const LETTERS = ["A", "B", "C", "D"];' +
    'function quizTitleHtml(q) { return "<div>" + (q.question || "") + "</div>" };' +
    'function autoplayListen() {}',
    sb
  )
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sb)
  // challengeEntryHtml（app.js）单独提取注入（依赖 challengeLoad/chOpenLocked/t，沙箱已齐备）
  vm.runInContext(extractFn(appSrc, 'challengeEntryHtml'), sb)
  // 预置进度：Day1（两阶段）/ Day2-6 昨天 done；Day7 巩固刚 done
  vm.runInContext(
    'challengeLoad();' +
    'const __Y = Date.now() - 86400000;' +
    'challengeState.days[1] = { stages: { 0: { done: true, at: __Y, correct: 16, total: 20 }, 1: { done: true, at: __Y, correct: 9, total: 10 } } };' +
    'for (let d = 2; d <= 6; d++) challengeState.days[d] = { stages: { 0: { done: true, at: __Y, correct: 27, total: 30 } } };' +
    'challengeState.days[7] = { stages: { 0: { done: true, at: Date.now(), correct: 10, total: 10 } } };' +
    'challengeSave()',
    sb
  )
  return sb
}

;(async () => {
  // ---------- ① cloud-store ----------
  console.log('\n[1] cloud-store：侧信道 + setChallengeOpen')
  {
    const state = { doc: { v: 1, base: {}, events: [] } }
    const { sb, CloudSync } = loadCloudStoreWithFetch(fetchImpl(state))
    await CloudSync.pushPending()   // 空队列探测 → _getDoc → 侧信道初始化
    assert('云端无 chOpen → 侧信道缺省关闭 + chOpenAt=0',
      vm.runInContext('CloudSync._chOpen === false && CloudSync._chOpenAt === 0', sb))
    const res = await vm.runInContext('CloudSync.setChallengeOpen(true)', sb)
    assert('setChallengeOpen(true) 返回 ok', !!res && res.ok === true)
    assert('云端写入 chOpen=true + chOpenAt 时间戳', state.doc.chOpen === true && typeof state.doc.chOpenAt === 'number')
    assert('本地侧信道即时开启（_chOpen + _chOpenAt）', vm.runInContext('CloudSync._chOpen === true && CloudSync._chOpenAt > 0', sb))
    const atAfterOpen = state.doc.chOpenAt
    const res2 = await vm.runInContext('CloudSync.setChallengeOpen(false)', sb)
    assert('setChallengeOpen(false) 关闭且保留 chOpenAt（→ 学员端显示「已结束」）',
      !!res2 && res2.ok === true && state.doc.chOpen === false && state.doc.chOpenAt === atAfterOpen
      && vm.runInContext('CloudSync._chOpen === false', sb))
    // 跨端：云端被其他设备改为 true → 本端拉取后同步
    state.doc.chOpen = true
    await CloudSync.pushPending()
    assert('其他端开启后本端拉取即同步', vm.runInContext('CloudSync._chOpen === true', sb))
  }
  {
    const state = { doc: { v: 1, base: {}, events: [] }, failPut: true }
    const { sb, CloudSync } = loadCloudStoreWithFetch(fetchImpl(state))
    const res = await vm.runInContext('CloudSync.setChallengeOpen(true)', sb)
    assert('写入持续失败 → ok:false / reason:network', !!res && res.ok === false && res.reason === 'network')
    assert('失败不污染侧信道（仍关闭）', vm.runInContext('CloudSync._chOpen === false', sb))
    assert('按设计重试 4 次 PUT', state.calls.put === 4, 'put=' + state.calls.put)
  }

  // ---------- ② challenge.js 门禁：未开放 ----------
  console.log('\n[2] 挑战未开放（缺省）→ 入口灰掉 + 拦截')
  {
    const sb = makeChSandbox(false, 0)
    assert('前置完成 → Day2 天级解锁（门禁是唯一拦截源）', vm.runInContext('chDayUnlocked(2) === true', sb))
    const html2 = vm.runInContext('chStageRowHtml(2, 0, { kind: "practice", count: 30 })', sb)
    assert('未开放 → 未完成环节灰掉「挑战未开放」（无开始按钮）',
      html2.includes('挑战未开放') && !html2.includes('chStartStage(2,0)'), html2.slice(0, 200))
    // 已完成练习：重练按钮同样灰掉
    const html1p = vm.runInContext('chStageRowHtml(1, 1, { kind: "practice", count: 10 })', sb)
    assert('未开放 → 已完成练习不给重练按钮（灰掉）',
      html1p.includes('挑战未开放') && !html1p.includes('chStartStage(1,1)'), html1p.slice(0, 200))
    // 已完成测试：分数保留
    const html1t = vm.runInContext('chStageRowHtml(1, 0, { kind: "test", count: 20 })', sb)
    assert('未开放 → 已完成摸底测试仍显示 80 分', html1t.includes('80') && !html1t.includes('挑战未开放'), html1t.slice(0, 200))
    // chStartStage 全局拦截（Day2 已解锁仍被拦）
    vm.runInContext('chStartStage(2, 0)', sb)
    assert('未开放 → chStartStage 全局拦截（alert + 不开会话）',
      vm.runInContext('(window.__alerts || []).length === 1 && window.__alerts[0].includes("暂未开放")', sb)
      && vm.runInContext('chs === null', sb))
    // 概览横幅 + 阶段行灰掉
    vm.runInContext('renderChallenge()', sb)
    const page = vm.runInContext('document.getElementById("page-challenge").innerHTML', sb)
    assert('未开放 → 概览顶部横幅「挑战暂未开放」+ 等待提示',
      page.includes('挑战暂未开放') && page.includes('请稍候'), page.slice(0, 300))
    // 练习页入口卡提示
    const entry = vm.runInContext('challengeEntryHtml()', sb)
    assert('未开放 → 练习页入口卡显示锁定提示', entry.includes('挑战暂未开放'), entry.slice(0, 200))
  }

  // ---------- ③ challenge.js 门禁：已结束（曾开放后关闭） ----------
  console.log('\n[3] 挑战已结束（chOpenAt>0 且关闭）→ 显示「已结束」')
  {
    const sb = makeChSandbox(false, Date.now() - 60000)
    const html2 = vm.runInContext('chStageRowHtml(2, 0, { kind: "practice", count: 30 })', sb)
    assert('已结束 → 环节灰掉「挑战已结束」（无开始按钮）',
      html2.includes('挑战已结束') && !html2.includes('chStartStage(2,0)'), html2.slice(0, 200))
    vm.runInContext('renderChallenge()', sb)
    const page = vm.runInContext('document.getElementById("page-challenge").innerHTML', sb)
    assert('已结束 → 概览横幅「🏁 挑战已结束」+ 感谢参与提示',
      page.includes('挑战已结束') && page.includes('感谢参与'), page.slice(0, 300))
    assert('已结束 → 横幅不再显示「未开放」文案', !page.includes('挑战暂未开放'), '')
  }

  // ---------- ④ 开放后恢复正常 ----------
  console.log('\n[4] 挑战开放 → 恢复开始按钮与会话')
  {
    const sb = makeChSandbox(true, Date.now())
    const html2 = vm.runInContext('chStageRowHtml(2, 0, { kind: "practice", count: 30 })', sb)
    assert('开放 → Day2 已完成环节显示重练按钮', html2.includes('chStartStage(2,0)') && !html2.includes('挑战未开放'), html2.slice(0, 200))
    vm.runInContext('challengeState.days[2] = { stages: {} }; challengeSave()', sb)
    const html2b = vm.runInContext('chStageRowHtml(2, 0, { kind: "practice", count: 30 })', sb)
    assert('开放 → Day2 未完成环节显示开始按钮', html2b.includes('chStartStage(2,0)'), html2b.slice(0, 200))
    vm.runInContext('renderChallenge()', sb)
    const page = vm.runInContext('document.getElementById("page-challenge").innerHTML', sb)
    assert('开放 → 概览无锁定横幅', !page.includes('挑战暂未开放') && !page.includes('挑战已结束'), '')
    vm.runInContext('chStartStage(2, 0)', sb)
    assert('开放 → chStartStage 正常开会话（practice 30 题）',
      vm.runInContext('chs && chs.day === 2 && chs.kind === "practice" && chs.questions.length === 30', sb))
  }

  // ---------- ⑤ 概览页随开关状态重渲染 ----------
  console.log('\n[5] 挑战开关拉取后变化 → 概览重渲染（与考试开关复合判定）')
  {
    const sb = makeChSandbox(false, 0)
    vm.runInContext('const __origRC = renderChallenge; window.__rc = 0; renderChallenge = function () { window.__rc++; __origRC() }', sb)
    vm.runInContext('renderChallenge()', sb)
    await new Promise(r => setTimeout(r, 20))   // 等内部 chLoadLeaderboard 微任务完成
    assert('状态未变 → 不额外重渲染', vm.runInContext('window.__rc', sb) === 1, 'rc=' + vm.runInContext('window.__rc', sb))
    vm.runInContext('CloudSync._chOpen = true; CloudSync._chOpenAt = Date.now(); _chLbCache = { at: 0, top: null }', sb)
    await vm.runInContext('chLoadLeaderboard()', sb)
    await new Promise(r => setTimeout(r, 20))
    assert('管理员开放后拉取 → 概览自动重渲染（灰掉变按钮）', vm.runInContext('window.__rc', sb) === 2, 'rc=' + vm.runInContext('window.__rc', sb))
    vm.runInContext('CloudSync._chOpen = false; _chLbCache = { at: 0, top: null }', sb)
    await vm.runInContext('chLoadLeaderboard()', sb)
    await new Promise(r => setTimeout(r, 20))
    assert('关闭后拉取 → 再次重渲染（按钮变灰掉）', vm.runInContext('window.__rc', sb) === 3, 'rc=' + vm.runInContext('window.__rc', sb))
  }

  // ---------- ⑥ app.js 接线 + i18n 成对 + style.css ----------
  console.log('\n[6] app.js 接线 + i18n 双语 + style.css hover 修复')
  {
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    assert('dashChOpenGateHtml 定义', appSrc.includes('function dashChOpenGateHtml'))
    assert('dashToggleChOpen 定义并调 setChallengeOpen', appSrc.includes('async function dashToggleChOpen') && appSrc.includes('CloudSync.setChallengeOpen(next)'))
    assert('renderDashboard 同时插入挑战开关行与考试开关行',
      appSrc.includes('${dashChOpenGateHtml()}') && appSrc.includes('${dashChExamGateHtml()}'))
    assert('挑战开关行位于考试开关行之前（均为 dashChallengeBlock 占位之前）',
      appSrc.indexOf('${dashChOpenGateHtml()}') >= 0
      && appSrc.indexOf('${dashChOpenGateHtml()}') < appSrc.indexOf('${dashChExamGateHtml()}')
      && appSrc.indexOf('${dashChExamGateHtml()}') < appSrc.indexOf('<div id="dashChallengeBlock"></div>'))
    assert('挑战入口卡含锁定提示（challengeEntryHtml → chOpenLocked）',
      /function challengeEntryHtml[\s\S]*?chOpenLocked/.test(appSrc))
    const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
    assert('challenge.js 门禁判定/曾开放判定/拦截接线',
      chSrc.includes('function chOpenLocked') && chSrc.includes('function chOpenEverOpened') && chSrc.includes('chNotOpenAlert'))
    assert('challenge.js 阶段行灰掉 + 概览横幅接线',
      chSrc.includes('chNotOpenShort') && chSrc.includes('chEnded') && chSrc.includes('chClosedBanner'))
    assert('challenge.js 重渲染判定改为复合门禁态（open+exam）',
      chSrc.includes('{ open: chOpenLocked(), exam: chFinalExamLocked() }'))
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const keys = ['chNotOpen', 'chNotOpenHint', 'chNotOpenShort', 'chNotOpenAlert', 'chEnded', 'chEndedHint',
      'dashChOpenTitle', 'dashChOpenOn', 'dashChOpenOff', 'dashChOpenOpenBtn', 'dashChOpenCloseBtn', 'dashChOpenHint']
    keys.forEach(k => {
      const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
      assert('i18n ' + k + ' zh/en 成对', n === 2, '出现 ' + n + ' 次')
    })
    const cssSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8')
    assert('style.css：option-item:hover 包裹于 @media (hover: hover)',
      /@media \(hover: hover\)\s*\{\s*\.option-item:hover/.test(cssSrc.replace(/\r/g, '')))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('异常:', e); process.exit(1) })
