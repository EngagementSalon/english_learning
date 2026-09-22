// ====== 测试 v76：七天挑战期末考试门禁（管理员开启/关闭） ======
// ① cloud-store：_getDoc 侧信道 _chExamOpen（缺省关闭）+ setChallengeExamOpen 读改写/失败重试/跨端同步
// ② challenge.js：Day7 test 入口锁定（渲染无开始按钮 + chStartStage 二次拦截）；Day1 摸底不受影响；已完成仍显示成绩
// ③ challenge.js：考试状态拉取后变化 → 概览页重渲染
// ④ app.js 接线 + i18n 双语成对
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
function makeChSandbox(examOpen) {
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
  sb.CloudSync = { enqueue() {}, _chExamOpen: examOpen, _chOpen: true }   // v77 挑战门禁默认开放（行为见 test-v77）
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  vm.runInContext(['visibleOptionIndexes', 'shuffleOptions', 'checkAnswer', 'safeQType', 'escAttr', 'escHtml'].map(n => extractFn(appSrc, n)).join('\n'), sb)
  // renderChallengeQuiz 渲染依赖（test-v68 靠 el=null 早退躲过；本测试 el 可用 → 注入简版）
  vm.runInContext(
    'const TYPE_LABELS = new Proxy({}, { get: (_, k) => k });' +
    'const LETTERS = ["A", "B", "C", "D"];' +
    'function quizTitleHtml(q) { return "<div>" + (q.question || "") + "</div>" };' +
    'function autoplayListen() {}',
    sb
  )
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sb)
  // 预置进度：Day1（两阶段）/ Day2-6 昨天 done；Day7 巩固刚 done → 期末考试阶段解锁
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
  const DAY = 86400000

  // ---------- ① cloud-store ----------
  console.log('\n[1] cloud-store：侧信道 + setChallengeExamOpen')
  {
    const state = { doc: { v: 1, base: {}, events: [] } }
    const { sb, CloudSync } = loadCloudStoreWithFetch(fetchImpl(state))
    await CloudSync.pushPending()   // 空队列探测 → _getDoc → 侧信道初始化
    assert('云端无 chExamOpen → 侧信道缺省关闭', vm.runInContext('CloudSync._chExamOpen === false', sb))
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    assert('setChallengeExamOpen(true) 返回 ok', !!res && res.ok === true)
    assert('云端写入 chExamOpen=true + chExamAt 时间戳', state.doc.chExamOpen === true && typeof state.doc.chExamAt === 'number')
    assert('本地侧信道即时开启', vm.runInContext('CloudSync._chExamOpen === true', sb))
    const res2 = await vm.runInContext('CloudSync.setChallengeExamOpen(false)', sb)
    assert('setChallengeExamOpen(false) 关闭（云端+侧信道）', !!res2 && res2.ok === true && state.doc.chExamOpen === false && vm.runInContext('CloudSync._chExamOpen === false', sb))
    // 跨端：云端被其他设备改为 true → 本端拉取后同步
    // v88：无营次数组时写/读仍走 doc 顶层 chExamOpen（兼容路径），行为与 v87 一致
    state.doc.chExamOpen = true
    await CloudSync.pushPending()
    assert('其他端开启后本端拉取即同步', vm.runInContext('CloudSync._chExamOpen === true', sb))
  }
  {
    const state = { doc: { v: 1, base: {}, events: [] }, failPut: true }
    const { sb, CloudSync } = loadCloudStoreWithFetch(fetchImpl(state))
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    assert('写入持续失败 → ok:false / reason:network', !!res && res.ok === false && res.reason === 'network')
    assert('失败不污染侧信道（仍关闭）', vm.runInContext('CloudSync._chExamOpen === false', sb))
    assert('按设计重试 4 次 PUT', state.calls.put === 4, 'put=' + state.calls.put)
  }

  // ---------- ② challenge.js 门禁 ----------
  console.log('\n[2] Day7 期末考试门禁（渲染 + 拦截）')
  {
    const sb = makeChSandbox(false)
    assert('前置完成 → Day7 天级与期末阶段解锁', vm.runInContext('chDayUnlocked(7) === true && chStageUnlocked(7,1) === true', sb))
    const html = vm.runInContext('chStageRowHtml(7, 1, { kind: "test", count: 20 })', sb)
    assert('考试未开放 → 入口显示锁定文案（无开始按钮）', html.includes('期末考试待管理员开放') && !html.includes('chStartStage(7,1)'), html.slice(0, 200))
    vm.runInContext('chStartStage(7, 1)', sb)
    assert('考试未开放 → chStartStage 二次拦截（alert + 不开会话）',
      vm.runInContext('(window.__alerts || []).length === 1 && window.__alerts[0].includes("期末考试尚未开放")', sb)
      && vm.runInContext('chs === null', sb))
    // Day1 摸底测试不受门禁影响：已完成 → 显示分数、无锁定文案
    const html1 = vm.runInContext('chStageRowHtml(1, 0, { kind: "test", count: 20 })', sb)
    assert('Day1 摸底测试已完成 → 显示 80 分、无锁定文案', html1.includes('80') && !html1.includes('期末考试待管理员开放'))
    // Day1 摸底测试未完成 → 门禁不拦（照常可考）
    vm.runInContext('challengeState.days[1] = { stages: {} }; challengeSave()', sb)
    const html1b = vm.runInContext('chStageRowHtml(1, 0, { kind: "test", count: 20 })', sb)
    assert('Day1 摸底测试未完成 → 门禁锁定时仍有开始按钮', html1b.includes('chStartStage(1,0)') && !html1b.includes('期末考试待管理员开放'))
    vm.runInContext('chStartStage(1, 0)', sb)
    assert('Day1 摸底测试正常开会话（门禁不拦）', vm.runInContext('chs && chs.day === 1 && chs.kind === "test"', sb))
    // 已完成的期末考试：仍显示成绩，不显示锁定文案
    vm.runInContext('chs = null; challengeState.days[7].stages[1] = { done: true, at: Date.now(), correct: 9, total: 20 }; challengeSave()', sb)
    const htmlDone = vm.runInContext('chStageRowHtml(7, 1, { kind: "test", count: 20 })', sb)
    assert('已考完的期末考试不受关闭影响（显示 45 分）', htmlDone.includes('45') && !htmlDone.includes('期末考试待管理员开放') && !htmlDone.includes('chStartStage(7,1)'))
  }
  {
    const sb = makeChSandbox(true)
    const html = vm.runInContext('chStageRowHtml(7, 1, { kind: "test", count: 20 })', sb)
    assert('考试已开放 → Day7 期末正常显示开始按钮', html.includes('chStartStage(7,1)') && !html.includes('期末考试待管理员开放'))
    vm.runInContext('chStartStage(7, 1)', sb)
    assert('考试已开放 → chStartStage 正常开会话（test + 防作弊启动）',
      vm.runInContext('chs && chs.day === 7 && chs.si === 1 && chs.kind === "test" && chs.questions.length === 20', sb)
      && (vm.runInContext('window.__acStart', sb) || 0) === 1)
  }

  // ---------- ③ 概览页随开关状态重渲染 ----------
  console.log('\n[3] 考试状态拉取后变化 → 概览重渲染')
  {
    const sb = makeChSandbox(false)
    vm.runInContext('const __origRC = renderChallenge; window.__rc = 0; renderChallenge = function () { window.__rc++; __origRC() }', sb)
    vm.runInContext('renderChallenge()', sb)
    await new Promise(r => setTimeout(r, 20))   // 等内部 chLoadLeaderboard 微任务完成
    assert('状态未变 → 不额外重渲染', vm.runInContext('window.__rc', sb) === 1, 'rc=' + vm.runInContext('window.__rc', sb))
    vm.runInContext('CloudSync._chExamOpen = true; _chLbCache = { at: 0, top: null }', sb)
    await vm.runInContext('chLoadLeaderboard()', sb)
    await new Promise(r => setTimeout(r, 20))
    assert('管理员开启后拉取 → 概览自动重渲染（锁变按钮）', vm.runInContext('window.__rc', sb) === 2, 'rc=' + vm.runInContext('window.__rc', sb))
  }

  // ---------- ④ app.js 接线 + i18n 成对 ----------
  console.log('\n[4] app.js 接线 + i18n 双语')
  {
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    // ⚠️ v107：v76 的「单张考试开关卡」已被「按营期逐个渲染」取代（修「一开都开」）。
    //    新结构：dashChGatePanelHtml() 逐期出卡（dashChRoundGateCardHtml），每期各有挑战/考试两个按钮，
    //    点击带该期 roundId → cloud-store setChallengeOpen/setChallengeExamOpen({open, roundId})。
    assert('v107：按营期逐卡渲染函数 dashChChRoundGateCardHtml 定义',
      appSrc.includes('function dashChRoundGateCardHtml'))
    assert('v107：开关面板 dashChGatePanelHtml 定义（逐期聚合）',
      appSrc.includes('function dashChGatePanelHtml'))
    assert('v107：面板按期过滤（跟随看板部门筛选）',
      appSrc.includes('function dashRoundsForGate') && appSrc.includes('dashRoundUnderDept(r, dashChDept)'))
    assert('v107：考试按钮按期传 roundId（不再只改指针那期）',
      appSrc.includes('CloudSync.setChallengeExamOpen({ open: next, roundId: rid })'))
    assert('v107：挑战按钮按期传 roundId',
      appSrc.includes('CloudSync.setChallengeOpen({ open: next, roundId: rid })'))
    assert('v107：每期卡同时渲染「开放挑战」与「开放考试」两个按钮',
      /dashToggleChOpen\(this\)/.test(appSrc) && /dashToggleChExam\(this\)/.test(appSrc))
    assert('renderDashboard 插入营次面板', appSrc.includes('${dashRoundsPanelHtml()}'))
    assert('营次面板插入于 dashChallengeBlock 占位之前', appSrc.indexOf('${dashRoundsPanelHtml()}') >= 0 && appSrc.indexOf('${dashRoundsPanelHtml()}') < appSrc.indexOf('<div id="dashChallengeBlock"></div>'))
    // ⚠️ v100 修复：v88 加营次面板时误删了考试开关卡的插入（v76 只断言「函数定义存在」→ 缺陷逃逸两个版本，
    //    管理员看板上根本没有「开放考试」按钮）。此处改为断言「真的被渲染进看板 HTML」。
    assert('v100→v107：开关面板真的插入看板（dashChGatePanelHtml 被调用，非仅定义）',
      /<div id="dashChGate">\$\{dashChGatePanelHtml\(\)\}<\/div>/.test(appSrc))
    assert('v100→v107：开关面板位于营次面板之后、挑战统计之前',
      appSrc.indexOf('${dashChGatePanelHtml()}') > appSrc.indexOf('${dashRoundsPanelHtml()}') &&
      appSrc.indexOf('${dashChGatePanelHtml()}') < appSrc.indexOf('<div id="dashChallengeBlock"></div>'))
    assert('v100→v107：开关成功后就地刷新开关面板', appSrc.includes('function dashRefreshChGate') && appSrc.includes('dashRefreshChGate()'))
    const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
    assert('challenge.js 门禁判定与拦截接线', chSrc.includes('function chFinalExamLocked') && chSrc.includes('function chIsFinalExam') && chSrc.includes('chExamLockedAlert'))
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const keys = ['chExamLocked', 'chExamLockedAlert', 'dashChExamTitle', 'dashChExamOn', 'dashChExamOff', 'dashChExamOpenBtn', 'dashChExamCloseBtn', 'dashChExamHint', 'dashChExamFail']
    keys.forEach(k => {
      const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
      assert('i18n ' + k + ' zh/en 成对', n === 2, '出现 ' + n + ' 次')
    })
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('异常:', e); process.exit(1) })
