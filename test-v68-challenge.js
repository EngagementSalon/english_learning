// ====== 测试 v72：七天挑战（每日 30 题 + 测试每次随机 + 错题当天刷到对 + 前日错题次日追加 + 听音注解） ======
// ① 练习序列：按难度配比抽取 170 题（Day1 10 + Day2-6 30×5 + Day7 10）、id 唯一、固定种子可复现；题型 = listen+single
// ② 阶段切片：9 阶段；练习起点只按 practice 累加（test 不占序列）；test 每次分层随机（难度1×10+2×7+3×3）；
//    难度逐天递增（1.0→2.2）；选项每次重洗
// ③ 解锁：天级（时间锁）+ 阶段级；test done 不可重做；旧进度（无 wrong 字段）兼容
// ④ 状态：eq_challenge_v2 往返；uid 变更重置
// ⑤ 判分与上报：测试统一判分（wrong 记录）+ chy/perq；练习逐题反馈 + 错题回顾轮（刷到全对才 done、多轮）；
//    次日练习额外追加前一天错题（不占配额）；Day7 链路；防作弊强制交卷
// ⑥ 报告：chTestScoreOfDay / chDayScore / chReportHtml
// ⑦ i18n：挑战键 zh/en 成对（含 v72 新键 chReview* / chExtraDone）
// ⑧ 接线：nav 无挑战项；容器 + script + renderFn + 入口；防作弊/看板/chy/cloud-store 分支；listen 注解条
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

// 从 app.js 源码提取纯函数（花括号配对法；两函数体内无花括号字符串字面量）
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

function makeSandbox(pre) {
  const sb = {
    localStorage: {
      store: Object.assign({}, pre || {}),
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: { scrollTo() {} },
    document: { addEventListener() {}, getElementById() { return null } },
    confirm() { return true },
  }
  // 防作弊 mock（记录 start/stop 调用与配置）
  sb.AntiCheat = {
    start(opts) { sb.window.__acStart = (sb.window.__acStart || 0) + 1; sb.window.__acOpts = opts || null },
    stop() { sb.window.__acStop = (sb.window.__acStop || 0) + 1 },
    isActive() { return false },
    getViolations() { return 0 },
    dismiss() {},
    isAdminUser() { return false },
  }
  // 云事件队列 mock（chy / perq 上报捕获）
  sb.CloudSync = {
    enqueue(ev) { (sb.window.__events = sb.window.__events || []).push(ev) },
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  // challenge.js 依赖 app.js 的纯工具：提取真实实现注入（渲染类函数不被纯逻辑路径触达）
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  vm.runInContext(['shuffleOptions', 'checkAnswer'].map(n => extractFn(appSrc, n)).join('\n'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sb)
  return sb
}

const DAY = 86400000

;(async () => {
  console.log('\n🧪 v72 七天挑战（每日30题+随机测试+错题闭环+次日复习）测试')

  // ---------- ① 练习序列 ----------
  console.log('\n[1] 练习序列（难度配比抽取 170 题）')
  let sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  const poolIds = vm.runInContext('challengePool().map(q => q.id)', sb)
  const poolIds2 = vm.runInContext('challengePool().map(q => q.id)', sb)
  assert('练习序列 170 题（10+30×5+10）', poolIds.length === 170, `got ${poolIds.length}`)
  assert('固定种子两次生成 id 序列完全一致', JSON.stringify(poolIds) === JSON.stringify(poolIds2))
  assert('序列 id 唯一', new Set(poolIds).size === 170)
  assert('CHALLENGE_TOTAL = 210', vm.runInContext('CHALLENGE_TOTAL', sb) === 210)
  {
    const types = new Set(vm.runInContext('challengePool().map(q => q.type)', sb))
    assert('题型只剩 listen/single（听音选中文改造生效）', types.size === 2 && !types.has('voicematch'), `got ${[...types].join(',')}`)
  }

  // ---------- ② 阶段切片 + 测试随机 + 难度递增 ----------
  console.log('\n[2] 阶段切片 / 测试分层随机 / 难度递增 / 选项重洗')
  {
    const meta = vm.runInContext('challengeStageMeta()', sb)
    assert('共 9 个阶段', meta.length === 9, `got ${meta.length}`)
    assert('类型序列 test/practice×7/test',
      JSON.stringify(meta.map(m => m.kind)) === JSON.stringify(['test', 'practice', 'practice', 'practice', 'practice', 'practice', 'practice', 'practice', 'test']))
    assert('题数序列 20/10/30×5/10/20（每日 30 题）',
      JSON.stringify(meta.map(m => m.count)) === JSON.stringify([20, 10, 30, 30, 30, 30, 30, 10, 20]),
      `got ${JSON.stringify(meta.map(m => m.count))}`)
    assert('练习切片起点 0/0/10/40/70/100/130/160/170（test 不占序列）',
      JSON.stringify(meta.map(m => m.start)) === JSON.stringify([0, 0, 10, 40, 70, 100, 130, 160, 170]),
      `got ${JSON.stringify(meta.map(m => m.start))}`)
  }
  {
    // 测试每次随机：分层（难度1×10+2×7+3×3）、两次进入不同、全部 cat12
    const t1 = vm.runInContext('challengeStageQuestions(1,0)', sb)
    const t2 = vm.runInContext('challengeStageQuestions(1,0)', sb)
    assert('Day1 测试抽 20 题', t1.length === 20, `got ${t1.length}`)
    assert('两次进入测试题不同（随机）', JSON.stringify(t1.map(q => q.id)) !== JSON.stringify(t2.map(q => q.id)))
    const dist = [1, 2, 3].map(d => t1.filter(q => Number(q.difficulty) === d).length)
    assert('测试分层 难度1×10+难度2×7+难度3×3', JSON.stringify(dist) === JSON.stringify([10, 7, 3]), `got ${JSON.stringify(dist)}`)
    assert('测试题全部属于分类 12', t1.every(q => Number(q.category_id) === 12))
    const t7 = vm.runInContext('challengeStageQuestions(7,1)', sb)
    assert('Day7 测试也是 20 题随机', t7.length === 20 && JSON.stringify(t7.map(q => q.id)) !== JSON.stringify(t1.map(q => q.id)))
  }
  {
    // 练习切片对照：Day1 巩固 = pool[0..10)；Day2 = [10..40)；Day7 巩固 = [160..170)
    const s11 = vm.runInContext('challengeStageQuestions(1,1).map(q => q.id)', sb)
    const s2 = vm.runInContext('challengeStageQuestions(2,0).map(q => q.id)', sb)
    const s7 = vm.runInContext('challengeStageQuestions(7,0).map(q => q.id)', sb)
    assert('Day1 巩固 = 序列[0..10)', JSON.stringify(s11) === JSON.stringify(poolIds.slice(0, 10)))
    assert('Day2 练习 = 序列[10..40)', JSON.stringify(s2) === JSON.stringify(poolIds.slice(10, 40)))
    assert('Day7 巩固 = 序列[160..170)', JSON.stringify(s7) === JSON.stringify(poolIds.slice(160, 170)))
    const stageIds = []
    const meta = vm.runInContext('challengeStageMeta()', sb)
    for (const m of meta) {
      if (m.kind === 'practice') stageIds.push(vm.runInContext(`challengeStageQuestions(${m.day},${m.si}).map(q => q.id)`, sb))
    }
    const flat = stageIds.flat()
    assert('7 个练习阶段共 170 题且不重叠', flat.length === 170 && new Set(flat).size === 170, `got ${flat.length}/${new Set(flat).size}`)
  }
  {
    // 难度递增：7 个练习阶段平均难度严格递增 1.0 → 2.2
    const avgByStage = []
    const spans = [[0, 10], [10, 40], [40, 70], [70, 100], [100, 130], [130, 160], [160, 170]]
    for (const [a, b] of spans) {
      const qs = vm.runInContext(`challengePool().slice(${a},${b})`, sb)
      avgByStage.push(qs.reduce((s, q) => s + (Number(q.difficulty) || 1), 0) / qs.length)
    }
    const mono = avgByStage.every((v, i) => i === 0 || v > avgByStage[i - 1])
    assert('练习难度逐天严格递增', mono, `avg=${avgByStage.map(v => v.toFixed(2)).join('→')}`)
    assert('Day1 练习均值 ≤ 1.2（简单起步）', avgByStage[0] <= 1.2, `got ${avgByStage[0].toFixed(2)}`)
    assert('Day7 练习均值 ≥ 2.1（难度收尾）', avgByStage[6] >= 2.1, `got ${avgByStage[6].toFixed(2)}`)
    assert('Day1 练习无难度 3 题', vm.runInContext('challengePool().slice(0,10).every(q => Number(q.difficulty) < 3)', sb))
    assert('Day7 练习含难度 3 题', vm.runInContext('challengePool().slice(160,170).some(q => Number(q.difficulty) === 3)', sb))
    const types = new Set(vm.runInContext('challengeStageQuestions(2,0).map(q => q.type)', sb))
    assert('题型混合（listen/single）', types.size === 2, `got ${[...types].join(',')}`)
  }
  {
    // 选项每次进入重洗（id 稳定，选项顺序可变）
    const o1 = vm.runInContext('JSON.stringify(challengeStageQuestions(2,0)[0].options)', sb)
    let diff = false
    for (let i = 0; i < 8; i++) {
      if (vm.runInContext('JSON.stringify(challengeStageQuestions(2,0)[0].options)', sb) !== o1) { diff = true; break }
    }
    assert('选项顺序每次进入重洗（防背位置）', diff, '8 次调用选项序未变化（概率极低，若复现重跑）')
  }

  // ---------- ③ 解锁规则（含时间锁 + 旧进度兼容） ----------
  console.log('\n[3] 天级+阶段级解锁 / 时间锁 / 测试仅一次 / 旧进度兼容')
  sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  vm.runInContext('challengeLoad()', sb)
  assert('Day1 恒解锁', vm.runInContext('chDayUnlocked(1)', sb) === true)
  assert('Day2 初始锁定', vm.runInContext('chDayUnlocked(2)', sb) === false)
  assert('Day7 初始锁定', vm.runInContext('chDayUnlocked(7)', sb) === false)
  assert('Day1 测试阶段解锁', vm.runInContext('chStageUnlocked(1,0)', sb) === true)
  assert('Day1 巩固阶段未解锁', vm.runInContext('chStageUnlocked(1,1)', sb) === false)
  assert('Day7 测试未解锁', vm.runInContext('chStageUnlocked(7,1)', sb) === false)
  vm.runInContext(`
    challengeState.days[1] = { stages: { 0: { done: true, at: ${Date.now()}, correct: 16, total: 20 } } }
    challengeSave()
  `, sb)
  assert('Day1 测试 done → 巩固阶段解锁', vm.runInContext('chStageUnlocked(1,1)', sb) === true)
  assert('Day1 仅测试 done → 天未完成，Day2 仍锁', vm.runInContext('chDayUnlocked(2)', sb) === false)
  vm.runInContext(`
    challengeState.days[1].stages[1] = { done: true, at: ${Date.now()}, correct: 9, total: 10 }
    challengeSave()
  `, sb)
  assert('Day1 当天全 done → Day2 时间锁（明日解锁）', vm.runInContext('chDayUnlocked(2)', sb) === false)
  assert('chDayLastDoneAt(1) = 当天时间', vm.runInContext('chDayLastDoneAt(1)', sb) > 0)
  vm.runInContext(`
    challengeState.days[1].stages[0].at = ${Date.now() - DAY}
    challengeState.days[1].stages[1].at = ${Date.now() - DAY}
    challengeSave()
  `, sb)
  assert('Day1 昨天完成 → Day2 解锁', vm.runInContext('chDayUnlocked(2)', sb) === true)
  assert('Day2 done 前 Day3 仍锁', vm.runInContext('chDayUnlocked(3)', sb) === false)
  vm.runInContext(`
    challengeState.days[2] = { stages: { 0: { done: true, at: ${Date.now() - DAY}, correct: 27, total: 30 } } }
    challengeSave()
  `, sb)
  assert('Day2 昨天 done → Day3 解锁', vm.runInContext('chDayUnlocked(3)', sb) === true)
  assert('Day3 done 前 Day4 仍锁', vm.runInContext('chDayUnlocked(4)', sb) === false)
  {
    vm.runInContext('chStartStage(1,0)', sb)
    assert('Day1 测试已完成 → chStartStage(1,0) 拒绝', vm.runInContext('chs === null', sb))
    vm.runInContext('chStartStage(4,0)', sb)
    assert('Day4 未解锁 → chStartStage(4,0) 拒绝', vm.runInContext('chs === null', sb))
    vm.runInContext('chStartStage(7,1)', sb)
    assert('Day7 测试未解锁 → 拒绝', vm.runInContext('chs === null', sb))
    vm.runInContext('chStartStage(2,0)', sb)
    assert('Day2 解锁 → 开会话 30 题 practice（前日无错题记录 → 无额外）',
      vm.runInContext('chs && chs.kind === "practice" && chs.questions.length === 30 && chs.extraCount === 0', sb))
    vm.runInContext('chStartStage(1,1)', sb)
    assert('Day1 巩固解锁 → 开会话 10 题', vm.runInContext('chs && chs.day === 1 && chs.si === 1 && chs.questions.length === 10', sb))
  }
  {
    // 旧进度兼容：v71 时代的 stage 记录无 wrong 字段 → 次日无额外题、不报错
    const sb2 = makeSandbox()
    vm.runInContext('Store.init()', sb2)
    vm.runInContext(`
      challengeLoad()
      challengeState.days[1] = { stages: {
        0: { done: true, at: ${Date.now() - DAY}, correct: 16, total: 20 },
        1: { done: true, at: ${Date.now() - DAY}, correct: 9, total: 10 },
      } }
      challengeSave()
    `, sb2)
    vm.runInContext('chStartStage(2,0)', sb2)
    assert('旧进度（无 wrong 字段）→ Day2 正常 30 题、不报错',
      vm.runInContext('chs && chs.questions.length === 30 && chs.extraCount === 0', sb2))
  }

  // ---------- ④ 状态持久化 + uid 绑定 ----------
  console.log('\n[4] 状态持久化与用户绑定')
  assert('eq_challenge_v2 已写入 localStorage', !!sb.localStorage.getItem('eq_challenge_v2'))
  {
    const before = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
    assert('记录绑定 uid=anon（未登录）', before.uid === 'anon')
    assert('days[1] 两阶段均 done', vm.runInContext('chDayDone(1)', sb) === true)
    vm.runInContext('challengeLoad()', sb)
    assert('重新 load 后 Day1 状态保留', vm.runInContext('chDayDone(1)', sb) === true)
    vm.runInContext(`
      Store.getSession = function () { return { id: 'u2', username: 'alice', role: 'student' } }
      challengeLoad()
    `, sb)
    assert('换账号（alice）后挑战进度重置', vm.runInContext('chDayDone(1)', sb) === false)
    assert('新状态 uid=alice', JSON.parse(sb.localStorage.getItem('eq_challenge_v2')).uid === 'alice')
  }

  // ---------- ⑤ 判分与上报 + 错题闭环 ----------
  console.log('\n[5] 测试判分 / 回顾轮刷到对 / 次日错题追加 / 防作弊 / Day7 链路')
  sb = makeSandbox()
  vm.runInContext('Store.init(); challengeLoad()', sb)
  vm.runInContext(`
    Store.getSession = function () { return { id: 'u1', username: 'tester', name: 'Tester', role: 'student' } }
    Store.addProgress = function (p) { window.__progress.push(p); if (p.question_id != null) { if (p.challenge) { if (!p.correct) Store.reportPerQuestion(p.question_id, false, true) } else { Store.reportPerQuestion(p.question_id, !!p.correct) } } }
    Store.trackPractice = function (c, t2) { window.__track = { c, t: t2 } }
    window.__progress = []
    window.__track = null
    window.__events = []
  `, sb)
  {
    // ① Day1 水平测试（随机 20 题）：前 10 对，其余空 → 50 分；错题进 wrong
    vm.runInContext(`
      chStartStage(1, 0)
      chs.questions.slice(0, 10).forEach((q, i) => { chs.index = i; chPick(q.answer[0]) })
      chs.index = 19
    `, sb)
    assert('test 开场 AntiCheat.start 已调用', (vm.runInContext('window.__acStart', sb) || 0) === 1)
    assert('AntiCheat 配置 maxViolations=3 + onSubmit=chCheatSubmit', (() => {
      const o = vm.runInContext('window.__acOpts', sb)
      return o && o.maxViolations === 3 && String(o.onSubmit).includes('chCheatSubmit')
    })())
    // v73：快进 90 秒验证 chy usedSec（阶段净用时）
    vm.runInContext('window.__origNow = Date.now; Date.now = () => window.__origNow() + 90000', sb)
    vm.runInContext('finishChallengeTest()', sb)
    assert('交卷后 AntiCheat.stop 已调用', (vm.runInContext('window.__acStop', sb) || 0) >= 1)
    assert('Day1 测试判分 10/20 = 50 分', vm.runInContext('chs.score', sb) === 50, `got ${vm.runInContext('chs.score', sb)}`)
    assert('review 长度 20 且 10 对', vm.runInContext('chs.review.length === 20 && chs.review.filter(r => r.isCorrect).length === 10', sb))
    assert('days[1].stages[0] = {done, correct:10, total:20, wrong:10 题}', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[1] && st.days[1].stages[0]
      return r && r.done && r.correct === 10 && r.total === 20 && Array.isArray(r.wrong) && r.wrong.length === 10
    })())
    assert('chy 事件已上报（day1 si0 test 10/20 + usedSec≈90s）', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "chy")', sb)
      const e = evs[0]
      return evs.length === 1 && e.d.day === 1 && e.d.si === 0 && e.d.kind === 'test' && e.d.correct === 10 && e.d.total === 20 &&
        typeof e.d.usedSec === 'number' && e.d.usedSec >= 90 && e.d.usedSec <= 92
    })())
    vm.runInContext('Date.now = window.__origNow', sb)
    assert('挑战错题 perq(ch=1) 10 条、对题不报', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch)', sb)
      return evs.length === 10 && evs.every(e => e.d.correct === 0)
    })(), `got ${vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch)', sb).length}`)
    vm.runInContext('chBack(); chStartStage(1, 0)', sb)
    assert('测试 done 后再开被拒绝', vm.runInContext('chs === null', sb))
  }
  {
    // ② Day1 巩固练习（10 题）：3 对 1 错 → 强制进入回顾轮，刷到全对才 done（含多轮）
    vm.runInContext('chStartStage(1, 1)', sb)
    assert('测试完成后巩固阶段可开（10 题 practice）',
      vm.runInContext('chs && chs.day === 1 && chs.si === 1 && chs.kind === "practice" && chs.questions.length === 10', sb))
    vm.runInContext(`
      chs.questions.slice(0, 3).forEach((q, i) => { chs.index = i; chPick(q.answer[0]); chSubmitAnswer() })
      chs.index = 3
      chPick(chs.questions[3].answer[0] === 0 ? 1 : 0)
      chSubmitAnswer()
    `, sb)
    assert('练习逐题 addProgress（测试 20 + 练习 4 = 24 条）', vm.runInContext('window.__progress.length', sb) === 24, `got ${vm.runInContext('window.__progress.length', sb)}`)
    assert('correctCount = 3（3 对 1 错）', vm.runInContext('chs.correctCount', sb) === 3)
    vm.runInContext('chFinishPractice()', sb)
    assert('有错题 → 进入错题回顾轮（phase=review，不直接 done）', vm.runInContext('chs && chs.phase === "review"', sb))
    assert('回顾轮只抽答错的 1 题、第 1 轮', vm.runInContext('chs.reviewQs.length === 1 && chs.reviewRound === 1 && chs.reviewQs[0].id === chs.questions[3].id', sb))
    assert('回顾期间阶段未 done、chy 未新增', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      return !(st.days[1].stages[1] && st.days[1].stages[1].done) &&
        vm.runInContext('(window.__events||[]).filter(e => e.ty === "chy")', sb).length === 1
    })())
    // 回顾轮 1：故意再答错 → 进入第 2 轮
    vm.runInContext(`
      chReviewPick(chs.reviewQs[0].answer[0] === 0 ? 1 : 0)
      chReviewSubmit()
    `, sb)
    assert('回顾轮再答错 → perq 再报（累计 12 条 ch 事件）',
      vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch).length', sb) === 12,
      `got ${vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch).length', sb)}`)
    vm.runInContext('chReviewNext()', sb)
    assert('本轮仍有错 → 第 2 轮重刷', vm.runInContext('chs.reviewRound === 2 && chs.reviewQs.length === 1 && chs.reviewIdx === 0', sb))
    // 回顾轮 2：答对 → 全对完成
    vm.runInContext(`
      chReviewPick(chs.reviewQs[0].answer[0])
      chReviewSubmit()
      chReviewNext()
    `, sb)
    assert('全对 → 阶段完成（phase=result）', vm.runInContext('chs && chs.phase === "result"', sb))
    assert('days[1].stages[1] = {done, correct:3, total:10, wrong:[错题]}（首次口径，不含回顾轮）', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[1] && st.days[1].stages[1]
      return r && r.done && r.correct === 3 && r.total === 10 && Array.isArray(r.wrong) && r.wrong.length === 1 && r.wrong[0] === String(vm.runInContext('chs.questions[3].id', sb))
    })())
    assert('trackPractice(3, 10) 已调用', vm.runInContext('window.__track && window.__track.c === 3 && window.__track.t === 10', sb))
    assert('chy 累计 2 条（practice 3/10 首次口径 + usedSec 数值）', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "chy")', sb)
      const e = evs[1]
      return evs.length === 2 && e.d.day === 1 && e.d.si === 1 && e.d.kind === 'practice' && e.d.correct === 3 && e.d.total === 10 &&
        typeof e.d.usedSec === 'number' && e.d.usedSec >= 0
    })())
    assert('addProgress 累计 26 条（测试 20 + 练习 4 + 回顾 2）', vm.runInContext('window.__progress.length', sb) === 26, `got ${vm.runInContext('window.__progress.length', sb)}`)
    assert('练习不新增 AntiCheat.start（仍 1 次）', (vm.runInContext('window.__acStart', sb) || 0) === 1)
  }
  {
    // ③ 次日额外复习：Day2 开场追加 Day1 全部错题（测试 10 + 练习 1 = 11，不占 30 配额）
    vm.runInContext('chBack()', sb)
    assert('Day1 全 done → Day2 昨天完成解锁', vm.runInContext('chDayDone(1)', sb) === true)
    vm.runInContext(`
      challengeState.days[1].stages[0].at = ${Date.now() - DAY}
      challengeState.days[1].stages[1].at = ${Date.now() - DAY}
      challengeSave()
      chs = null
      chStartStage(2, 0)
    `, sb)
    assert('Day2 = 30 题 + 前日错题 11 = 41 题（额外不占配额）',
      vm.runInContext('chs && chs.questions.length === 41 && chs.extraCount === 11', sb),
      `got ${vm.runInContext('chs && chs.questions.length', sb)}`)
    assert('前 30 题 = 固定序列[10..40)', (() => {
      const ids = vm.runInContext('chs.questions.slice(0, 30).map(q => q.id)', sb)
      const pool = vm.runInContext('challengePool().map(q => q.id)', sb)
      return JSON.stringify(ids) === JSON.stringify(pool.slice(10, 40))
    })())
    assert('后 11 题 = Day1 全部错题（测试 10 + 练习 1，去重）', (() => {
      const extraIds = vm.runInContext('chs.questions.slice(30).map(q => q.id)', sb)
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const wrongSet = new Set([].concat(st.days[1].stages[0].wrong, st.days[1].stages[1].wrong).map(Number))
      return extraIds.length === 11 && extraIds.every(id => wrongSet.has(id)) && new Set(extraIds).size === 11
    })())
    // 全对走完 Day2（含额外题）→ 直接 done（无错题时无需回顾轮）
    vm.runInContext(`
      chs.questions.forEach((q, i) => { chs.index = i; chPick(q.answer[0]); chSubmitAnswer() })
      chFinishPractice()
    `, sb)
    assert('Day2 全对（41/41）直接完成', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[2] && st.days[2].stages[0]
      return r && r.done && r.correct === 41 && r.total === 41 && r.wrong.length === 0
    })())
    assert('chy Day2 = practice 41/41', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "chy")', sb)
      const e = evs[2]
      return evs.length === 3 && e.d.day === 2 && e.d.correct === 41 && e.d.total === 41
    })())
  }
  {
    // ④ Day7：前置天 3-6 完成后，巩固 done → 测试解锁 → 测试判分
    vm.runInContext(`
      chs = null
      for (let d = 3; d <= 6; d++) {
        challengeState.days[d] = { stages: { 0: { done: true, at: ${Date.now() - DAY}, correct: 27, total: 30 } } }
      }
      challengeSave()
    `, sb)
    assert('Day6 昨天 done → Day7 天级解锁', vm.runInContext('chDayUnlocked(7)', sb) === true)
    vm.runInContext(`
      chStartStage(7, 0)
      chs.questions.forEach((q, i) => { chs.index = i; chPick(q.answer[0]); chSubmitAnswer() })
      chFinishPractice()
    `, sb)
    assert('Day7 巩固完成后测试阶段解锁', vm.runInContext('chStageUnlocked(7,1)', sb) === true)
    assert('Day7 巩固 days[7].stages[0] = 10/10（前置 Day2 错题已在 Day2 刷完 → 无额外）', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[7] && st.days[7].stages[0]
      return r && r.done && r.correct === 10 && r.total === 10
    })())
    vm.runInContext(`
      chs = null
      chStartStage(7, 1)
      chs.questions.slice(0, 9).forEach((q, i) => { chs.index = i; chPick(q.answer[0]) })
      chs.index = 19
      finishChallengeTest()
    `, sb)
    assert('Day7 测试 9/20 = 45 分', vm.runInContext('chs.score', sb) === 45, `got ${vm.runInContext('chs.score', sb)}`)
    assert('chTestScoreOfDay(7) = 45', vm.runInContext('chTestScoreOfDay(7)', sb) === 45)
  }
  {
    // ⑤ 防作弊强制交卷：切屏超限回调 chCheatSubmit → 按已答判分（手造 test 会话；Day1/7 正式 test 均已完成）
    vm.runInContext(`
      const qs = challengeStageQuestions(7, 1)
      chs = { day: 7, si: 1, kind: 'test', questions: qs, answers: qs.map(() => -1), index: 0, phase: 'quiz', submitted: false, correctCount: 0, firstWrong: [], extraCount: 0 }
      chs.questions.slice(0, 5).forEach((q, i) => { chs.index = i; chPick(q.answer[0]) })
      chs.index = 19
      chCheatSubmit()
    `, sb)
    assert('chCheatSubmit → 强制交卷（phase=result）', vm.runInContext('chs && chs.phase === "result"', sb))
    assert('强制交卷按已答判分 5/20 = 25', vm.runInContext('chs.score', sb) === 25, `got ${vm.runInContext('chs.score', sb)}`)
    vm.runInContext(`
      challengeState.days[7].stages[1] = { done: true, at: ${Date.now()}, correct: 9, total: 20 }
      challengeSave()
    `, sb)
  }

  // ---------- ⑥ 进步报告数据 ----------
  console.log('\n[6] chDayScore / chTestScoreOfDay / 报告')
  {
    assert('chTestScoreOfDay(1) = 50', vm.runInContext('chTestScoreOfDay(1)', sb) === 50)
    assert('chDayScore(1) 合并 (10+3)/(20+10) = 43%', vm.runInContext('chDayScore(1)', sb) === 43, `got ${vm.runInContext('chDayScore(1)', sb)}`)
    assert('chDayScore(2) = 100%（41/41 含额外复习）', vm.runInContext('chDayScore(2)', sb) === 100, `got ${vm.runInContext('chDayScore(2)', sb)}`)
    assert('chTestScoreOfDay(6) = null（当天无测试）', vm.runInContext('chTestScoreOfDay(6)', sb) === null)
    const html = vm.runInContext('String(chReportHtml())', sb)
    assert('Day1+Day7 测试均完成后报告含两测试分', html.includes('50') && html.includes('45') && html.length > 100)
  }

  // ---------- ⑦ i18n ----------
  console.log('\n[7] i18n 双语键')
  {
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const keys = ['chTitle', 'chIntro', 'chPoolInfo', 'chTestTag', 'chPracticeTag', 'chDay', 'chLocked', 'chStageLocked', 'chTomorrow', 'chStart', 'chRetake', 'chOnceOnly', 'chQuitConfirm', 'chSubmitTest', 'chConfirmSubmit', 'chTestDone', 'chPracticeDone', 'chBackToChallenge', 'chReportTitle', 'chDelta', 'chReportHint', 'chDayDoneTag', 'chEntryHint', 'chProgressTitle', 'chProgressStages', 'chProgressQ', 'chReviewTag', 'chReviewHint', 'chReviewRound', 'chReviewNextRound', 'chReviewFinish', 'chExtraDone', 'dashChTitle', 'dashChJoin', 'dashChTotalQ', 'dashChAvg', 'dashChNone', 'dashChThProgress', 'dashChThQ', 'dashChThAcc', 'dashChThDay1', 'dashChThDay7', 'dashChHint', 'dashChWrongTitle', 'dashChWrongHint', 'dashChThWrong', 'chDashProgress']
    const zhIdx = i18nSrc.indexOf('zh: {')
    const enIdx = i18nSrc.indexOf('en: {')
    const zhPart = i18nSrc.slice(zhIdx, enIdx)
    const enPart = i18nSrc.slice(enIdx)
    assert(`挑战+看板 ${keys.length} 键 zh 区全部存在`, keys.every(k => new RegExp('\\b' + k + '\\s*:').test(zhPart)),
      keys.filter(k => !new RegExp('\\b' + k + '\\s*:').test(zhPart)).join(','))
    assert(`挑战+看板 ${keys.length} 键 en 区全部存在`, keys.every(k => new RegExp('\\b' + k + '\\s*:').test(enPart)),
      keys.filter(k => !new RegExp('\\b' + k + '\\s*:').test(enPart)).join(','))
    assert('navChallenge 键已删除（zh/en）', !/\bnavChallenge\s*:/.test(zhPart) && !/\bnavChallenge\s*:/.test(enPart))
    assert("setTitle('navChallenge') 行已删除", !i18nSrc.includes("setTitle('navChallenge'"))
    assert('t("chTomorrow") 含「明日」', vm.runInContext('t("chTomorrow")', sb).includes('明日'))
    assert('t("chProgressQ",60) 含 /210', vm.runInContext('t("chProgressQ", 60)', sb).includes('210'))
    assert('t("chReviewRound",2) 可调用', vm.runInContext('t("chReviewRound", 2)', sb).includes('2'))
    assert('t("chExtraDone",11) 可调用', vm.runInContext('t("chExtraDone", 11)', sb).includes('11'))
    assert('t("chDashProgress",4,5) 可调用', (() => {
      const s = vm.runInContext('t("chDashProgress", 4, 5)', sb)
      return typeof s === 'string' && s.includes('4') && s.includes('5')
    })())
    assert('chPoolInfo 含「难度逐日递增」与「每次随机」', (() => {
      const s = vm.runInContext('t("chPoolInfo", 684)', sb)
      return s.includes('难度逐日递增') && s.includes('每次随机')
    })())
    assert('chIntro 提及 30 题 + 错题次日复习', (() => {
      const s = vm.runInContext('t("chIntro")', sb)
      return s.includes('30 题') && s.includes('第二天')
    })())
  }

  // ---------- ⑧ 接线 ----------
  console.log('\n[8] 静态接线')
  {
    const idx = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')
    assert('nav 已无挑战独立项', !idx.includes('data-page="challenge"'))
    assert('page-challenge 容器存在', idx.includes('id="page-challenge"'))
    assert('challenge.js 已引入', idx.includes('<script src="challenge.js?v='))
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    assert('navigate renderFn 注册 challenge', /challenge:\s*renderChallenge/.test(appSrc))
    assert('练习页挂挑战入口卡片', appSrc.includes('${challengeEntryHtml()}'))
    assert('challengeEntryHtml 点击跳 challenge 页', /function challengeEntryHtml[\s\S]*?navigate\('challenge'\)/.test(appSrc))
    assert('入口卡片用 chEntryHint 键', appSrc.includes("t('chEntryHint'"))
    assert('看板有挑战板块容器', appSrc.includes('id="dashChallengeBlock"'))
    assert('看板调用 renderDashChallengeBlock', appSrc.includes('renderDashChallengeBlock(rows)'))
    assert('看板错题排行聚合 chQ', appSrc.includes('wrongAgg'))
    const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
    assert('题源固定分类 12', chSrc.includes('Number(q.category_id) === 12'))
    assert('水平测试不可重做 guard（阶段版）', /=== 'test' && chStageDone\(day, si\)/.test(chSrc))
    assert('状态键 eq_challenge_v2', chSrc.includes("CHALLENGE_KEY = 'eq_challenge_v2'"))
    assert('难度配比表存在', chSrc.includes('CHALLENGE_DIFF_PLAN'))
    assert('测试分层随机表存在', chSrc.includes('CHALLENGE_TEST_PLAN'))
    assert('测试随机抽题函数', chSrc.includes('function challengeRandomQuestions'))
    assert('前日错题汇总函数', chSrc.includes('function chPrevDayWrongQuestions'))
    assert('总题量 CHALLENGE_TOTAL（进度条分母）', chSrc.includes('CHALLENGE_TOTAL'))
    assert('回顾轮渲染 renderChallengeReview', chSrc.includes('function renderChallengeReview'))
    assert('回顾轮提交 chReviewSubmit', chSrc.includes('function chReviewSubmit'))
    assert('听音题注解条（listenHint）', chSrc.includes("t('listenHint')"))
    assert('时间锁 chDayLastDoneAt', chSrc.includes('function chDayLastDoneAt'))
    assert('防作弊启动（test 阶段 AntiCheat.start）', chSrc.includes('AntiCheat.start({ maxViolations: 3, onSubmit: chCheatSubmit })'))
    assert('防作弊强制交卷 chCheatSubmit', chSrc.includes('function chCheatSubmit'))
    assert('交卷/退出 AntiCheat.stop', (chSrc.match(/AntiCheat\.stop\(\)/g) || []).length >= 3)
    assert('chy 上报 reportChallengeStage（含 usedSec）', chSrc.includes('Store.reportChallengeStage(chs.day, chs.si, chs.kind, correct, total, usedSec)'))
    assert('chy startedAt 记录（chStartStage）', chSrc.includes('startedAt: Date.now()'))
    assert('chy usedSec 净用时计算', chSrc.includes('Math.round((Date.now() - chs.startedAt) / 1000)'))
    assert('addProgress 带 challenge:true（练习+回顾+测试 = 3 处）', (chSrc.match(/challenge: true/g) || []).length === 3, `got ${(chSrc.match(/challenge: true/g) || []).length}`)
    assert('stage 记录含 wrong 字段', chSrc.includes('wrong: (wrongQids || []).map(String)'))
    const storeSrc = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
    assert('store.reportChallengeStage 定义（6 参含 usedSec）', storeSrc.includes('reportChallengeStage(day, si, kind, correct, total, usedSec)'))
    assert('store chy 事件携带 usedSec', storeSrc.includes('usedSec: usedSec || 0'))
    assert('perq 只报挑战错题（省空间）', storeSrc.includes('if (!record.correct) this.reportPerQuestion(record.question_id, false, true)'))
    const cloudSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
    assert("cloud-store chy 事件分支（存 usedSec）", cloudSrc.includes("case 'chy':") && cloudSrc.includes('usedSec: Number(d.usedSec) || 0'))
    assert('cloud-store chQ 聚合', cloudSrc.includes('r.chQ = r.chQ || {}'))
    assert('cloud-store rename 合并 chy/chQ', cloudSrc.includes('tgt.chy = (tgt.chy || []).concat(r.chy)'))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
