// ====== 测试 v71：标帜餐厅七天英文挑战（阶段模型 + 难度递增 + 时间锁 + 防作弊 + 看板上报） ======
// ① 挑战序列：按难度配比抽取 350 题、id 唯一、固定种子可复现；listen 改造后题型 = listen+single
// ② 阶段切片：9 阶段不重叠；起点=前面各阶段累加；Day1 ≠ Day7 测试题集；难度逐天递增
// ③ 解锁：天级（前一天全阶段完成 + 已过完成日次日）+ 阶段级（前一阶段完成）；test done 后不可重做
// ④ 状态：eq_challenge_v2 save/Load 往返；uid 变更重置
// ⑤ 判分与上报：测试统一判分 + review；练习逐题反馈；chy 阶段事件 / perq 挑战错题标记 / 防作弊启停
// ⑥ 报告：chTestScoreOfDay / chDayScore / chReportHtml
// ⑦ i18n：挑战键 zh/en 成对（含 chTomorrow/chProgress* / 看板 dashCh* / chDashProgress）
// ⑧ 接线：nav 无挑战项；page 容器 + script + renderFn + 练习页入口；防作弊/AntiCheat/看板/chy/cloud-store 分支
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
    window: {},
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
  console.log('\n🧪 v71 七天挑战（标帜餐厅·难度递增+时间锁+防作弊+看板上报）测试')

  // ---------- ① 挑战序列 ----------
  console.log('\n[1] 挑战序列（难度配比抽取）')
  let sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  const poolIds = vm.runInContext('challengePool().map(q => q.id)', sb)
  const poolIds2 = vm.runInContext('challengePool().map(q => q.id)', sb)
  assert('挑战序列 350 题', poolIds.length === 350, `got ${poolIds.length}`)
  assert('固定种子两次生成 id 序列完全一致', JSON.stringify(poolIds) === JSON.stringify(poolIds2))
  assert('序列 id 唯一', new Set(poolIds).size === 350)
  {
    // 改造后题型：listen + single（无 voicematch）
    const types = new Set(vm.runInContext('challengePool().map(q => q.type)', sb))
    assert('题型只剩 listen/single（听音选中文改造生效）', types.size === 2 && !types.has('voicematch'), `got ${[...types].join(',')}`)
  }

  // ---------- ② 阶段切片 + 难度递增 ----------
  console.log('\n[2] 阶段切片 9 阶段 350 题 + 难度递增')
  {
    const meta = vm.runInContext('challengeStageMeta()', sb)
    assert('共 9 个阶段', meta.length === 9, `got ${meta.length}`)
    assert('切片起点累加 0/20/50/100/150/200/250/300/330',
      JSON.stringify(meta.map(m => m.start)) === JSON.stringify([0, 20, 50, 100, 150, 200, 250, 300, 330]),
      `got ${JSON.stringify(meta.map(m => m.start))}`)
    assert('类型序列 test/practice×7/test',
      JSON.stringify(meta.map(m => m.kind)) === JSON.stringify(['test', 'practice', 'practice', 'practice', 'practice', 'practice', 'practice', 'practice', 'test']))
    assert('题数序列 20/30/50×5/30/20',
      JSON.stringify(meta.map(m => m.count)) === JSON.stringify([20, 30, 50, 50, 50, 50, 50, 30, 20]))
  }
  const stageIds = []
  {
    const meta = vm.runInContext('challengeStageMeta()', sb)
    for (const m of meta) {
      stageIds.push(vm.runInContext(`challengeStageQuestions(${m.day},${m.si}).map(q => q.id)`, sb))
    }
  }
  const allChallenge = stageIds.flat()
  assert('挑战共 350 题', allChallenge.length === 350, `got ${allChallenge.length}`)
  assert('350 题互不重叠', new Set(allChallenge).size === 350)
  assert('Day1 测试 = 序列[0..20)', JSON.stringify(stageIds[0]) === JSON.stringify(poolIds.slice(0, 20)))
  assert('Day1 巩固 = 序列[20..50)', JSON.stringify(stageIds[1]) === JSON.stringify(poolIds.slice(20, 50)))
  assert('Day3 = 序列[100..150)', JSON.stringify(stageIds[3]) === JSON.stringify(poolIds.slice(100, 150)))
  assert('Day7 巩固 = 序列[300..330)', JSON.stringify(stageIds[7]) === JSON.stringify(poolIds.slice(300, 330)))
  assert('Day7 测试 = 序列[330..350)', JSON.stringify(stageIds[8]) === JSON.stringify(poolIds.slice(330, 350)))
  assert('Day1 与 Day7 测试题集不同（进步对比真实）', JSON.stringify(stageIds[0]) !== JSON.stringify(stageIds[8]))
  assert('Day1 测试+巩固 = 序列[0..50) 连续', JSON.stringify(stageIds[0].concat(stageIds[1])) === JSON.stringify(poolIds.slice(0, 50)))
  {
    // 难度递增：每天 50 题的平均难度单调递增；Day1 无难度 3；Day7 含难度 3
    const avgByDay = []
    for (let d = 1; d <= 7; d++) {
      const qs = vm.runInContext(`challengePool().slice(${(d - 1) * 50},${d * 50})`, sb)
      const avg = qs.reduce((s, q) => s + (Number(q.difficulty) || 1), 0) / qs.length
      avgByDay.push(avg)
    }
    const mono = avgByDay.every((v, i) => i === 0 || v > avgByDay[i - 1])
    assert('每天平均难度严格递增', mono, `avg=${avgByDay.map(v => v.toFixed(2)).join('→')}`)
    assert('Day1 平均难度 ≤ 1.2（简单起步）', avgByDay[0] <= 1.2, `got ${avgByDay[0].toFixed(2)}`)
    assert('Day7 平均难度 ≥ 2.1（难度收尾）', avgByDay[6] >= 2.1, `got ${avgByDay[6].toFixed(2)}`)
    const d1Max = Math.max(...vm.runInContext('challengePool().slice(0,50)', sb).map(q => Number(q.difficulty) || 1))
    const d7Has3 = vm.runInContext('challengePool().slice(300,350).some(q => Number(q.difficulty) === 3)', sb)
    assert('Day1 无难度 3 题', d1Max < 3, `max=${d1Max}`)
    assert('Day7 含难度 3 题', d7Has3)
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

  // ---------- ③ 解锁规则（含时间锁） ----------
  console.log('\n[3] 天级+阶段级解锁 / 时间锁 / 测试仅一次')
  sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  vm.runInContext('challengeLoad()', sb)
  assert('Day1 恒解锁', vm.runInContext('chDayUnlocked(1)', sb) === true)
  assert('Day2 初始锁定', vm.runInContext('chDayUnlocked(2)', sb) === false)
  assert('Day7 初始锁定', vm.runInContext('chDayUnlocked(7)', sb) === false)
  assert('Day1 测试阶段解锁', vm.runInContext('chStageUnlocked(1,0)', sb) === true)
  assert('Day1 巩固阶段未解锁', vm.runInContext('chStageUnlocked(1,1)', sb) === false)
  assert('Day7 测试未解锁', vm.runInContext('chStageUnlocked(7,1)', sb) === false)
  // Day1 测试完成 → 巩固解锁（阶段锁无时间锁）；但天未完成，Day2 仍锁
  vm.runInContext(`
    challengeState.days[1] = { stages: { 0: { done: true, at: ${Date.now()}, correct: 16, total: 20 } } }
    challengeSave()
  `, sb)
  assert('Day1 测试 done → 巩固阶段解锁', vm.runInContext('chStageUnlocked(1,1)', sb) === true)
  assert('Day1 仅测试 done → 天未完成，Day2 仍锁', vm.runInContext('chDayUnlocked(2)', sb) === false)
  // Day1 全阶段完成（当天）→ 时间锁生效：Day2 仍锁（防止一天刷完全部）
  vm.runInContext(`
    challengeState.days[1].stages[1] = { done: true, at: ${Date.now()}, correct: 25, total: 30 }
    challengeSave()
  `, sb)
  assert('Day1 当天全 done → Day2 时间锁（明日解锁）', vm.runInContext('chDayUnlocked(2)', sb) === false)
  assert('chDayLastDoneAt(1) = 当天时间', vm.runInContext('chDayLastDoneAt(1)', sb) > 0)
  // 完成时间改为昨天 → Day2 解锁
  vm.runInContext(`
    challengeState.days[1].stages[0].at = ${Date.now() - DAY}
    challengeState.days[1].stages[1].at = ${Date.now() - DAY}
    challengeSave()
  `, sb)
  assert('Day1 昨天完成 → Day2 解锁', vm.runInContext('chDayUnlocked(2)', sb) === true)
  assert('Day2 done 前 Day3 仍锁', vm.runInContext('chDayUnlocked(3)', sb) === false)
  // Day2 昨天 done → Day3 解锁；Day3 done 前 Day4 锁
  vm.runInContext(`
    challengeState.days[2] = { stages: { 0: { done: true, at: ${Date.now() - DAY}, correct: 40, total: 50 } } }
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
    assert('Day2 解锁 → 开会话 50 题 practice', vm.runInContext('chs && chs.kind === "practice" && chs.questions.length === 50', sb))
    vm.runInContext('chStartStage(1,1)', sb)
    assert('Day1 巩固解锁 → 开会话 30 题', vm.runInContext('chs && chs.day === 1 && chs.si === 1 && chs.questions.length === 30', sb))
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
    // 模拟另一账号登录
    vm.runInContext(`
      Store.getSession = function () { return { id: 'u2', username: 'alice', role: 'student' } }
      challengeLoad()
    `, sb)
    assert('换账号（alice）后挑战进度重置', vm.runInContext('chDayDone(1)', sb) === false)
    assert('新状态 uid=alice', JSON.parse(sb.localStorage.getItem('eq_challenge_v2')).uid === 'alice')
  }

  // ---------- ⑤ 判分与上报 ----------
  console.log('\n[5] 水平测试判分 / 巩固练习 / 防作弊 / chy+perq 上报 / Day7 链路')
  sb = makeSandbox()
  vm.runInContext('Store.init(); challengeLoad()', sb)
  vm.runInContext(`
    // 模拟已登录学员（chy/perq 上报依赖 session.username）
    Store.getSession = function () { return { id: 'u1', username: 'tester', name: 'Tester', role: 'student' } }
    Store.addProgress = function (p) { window.__progress.push(p); if (p.question_id != null) { if (p.challenge) { if (!p.correct) Store.reportPerQuestion(p.question_id, false, true) } else { Store.reportPerQuestion(p.question_id, !!p.correct) } } }
    Store.trackPractice = function (c, t2) { window.__track = { c, t: t2 } }
    window.__progress = []
    window.__track = null
    window.__events = []
  `, sb)
  {
    // ① Day1 水平测试（20 题）：前 10 对，其余空 → 50 分
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
    vm.runInContext('finishChallengeTest()', sb)
    assert('交卷后 AntiCheat.stop 已调用', (vm.runInContext('window.__acStop', sb) || 0) >= 1)
    assert('Day1 测试判分 10/20 = 50 分', vm.runInContext('chs.score', sb) === 50, `got ${vm.runInContext('chs.score', sb)}`)
    assert('review 长度 20 且 10 对', vm.runInContext('chs.review.length === 20 && chs.review.filter(r => r.isCorrect).length === 10', sb))
    assert('days[1].stages[0] = {done, correct:10, total:20}', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[1] && st.days[1].stages[0]
      return r && r.done && r.correct === 10 && r.total === 20
    })())
    assert('chy 事件已上报（day1 si0 test 10/20）', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "chy")', sb)
      const e = evs[0]
      return evs.length === 1 && e.d.day === 1 && e.d.si === 0 && e.d.kind === 'test' && e.d.correct === 10 && e.d.total === 20
    })())
    // 挑战 perq：只报错题（10 错 → 10 条 ch 标记事件；对题不报）
    assert('挑战错题 perq(ch=1) 10 条、对题不报', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch)', sb)
      return evs.length === 10 && evs.every(e => e.d.correct === 0)
    })(), `got ${vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch)', sb).length}`)
    vm.runInContext('chBack(); chStartStage(1, 0)', sb)
    assert('测试 done 后再开被拒绝', vm.runInContext('chs === null', sb))
  }
  {
    // ② Day1 巩固练习（测试完成后解锁，30 题）：答对 3 错 1 后完成
    vm.runInContext('chStartStage(1, 1)', sb)
    assert('测试完成后巩固阶段可开（30 题 practice）',
      vm.runInContext('chs && chs.day === 1 && chs.si === 1 && chs.kind === "practice" && chs.questions.length === 30', sb))
    vm.runInContext(`
      chs.questions.slice(0, 3).forEach((q, i) => { chs.index = i; chPick(q.answer[0]); chSubmitAnswer() })
      chs.index = 3
      const q4 = chs.questions[3]
      chPick(q4.answer[0] === 0 ? 1 : 0)
      chSubmitAnswer()
    `, sb)
    assert('练习逐题 addProgress（测试 20 + 练习 4 = 24 条）', vm.runInContext('window.__progress.length', sb) === 24, `got ${vm.runInContext('window.__progress.length', sb)}`)
    assert('挑战 addProgress 带 challenge:true', vm.runInContext('window.__progress.every(p => p.challenge === true && p.mode === "practice")', sb))
    assert('correctCount = 3（3 对 1 错）', vm.runInContext('chs.correctCount', sb) === 3)
    vm.runInContext('chFinishPractice()', sb)
    assert('days[1].stages[1] = {done, correct:3, total:30}', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[1] && st.days[1].stages[1]
      return r && r.done && r.correct === 3 && r.total === 30
    })())
    assert('trackPractice(3, 30) 已调用', vm.runInContext('window.__track && window.__track.c === 3 && window.__track.t === 30', sb))
    assert('chy 事件累计 2 条（practice 3/30 已报）', (() => {
      const evs = vm.runInContext('(window.__events||[]).filter(e => e.ty === "chy")', sb)
      const e = evs[1]
      return evs.length === 2 && e.d.day === 1 && e.d.si === 1 && e.d.kind === 'practice' && e.d.correct === 3 && e.d.total === 30
    })())
    // 练习错题 → perq ch 事件（累计 10+1=11）
    assert('练习错题 perq(ch=1) 已报（累计 11）', vm.runInContext('(window.__events||[]).filter(e => e.ty === "perq" && e.d.ch).length', sb) === 11)
    // ③ 已 done 的练习可重练
    vm.runInContext('chBack(); chStartStage(1, 1)', sb)
    assert('已 done 的练习可重练（再开会话）', vm.runInContext('chs && chs.day === 1 && chs.si === 1 && chs.questions.length === 30', sb))
    // ④ 练习阶段不启用防作弊（start 不新增）
    assert('练习不新增 AntiCheat.start', (vm.runInContext('window.__acStart', sb) || 0) === 1)
  }
  {
    // ⑤ Day7：前置天 2-6 完成后，巩固 done → 测试解锁 → 测试判分
    vm.runInContext(`
      for (let d = 2; d <= 6; d++) {
        challengeState.days[d] = { stages: { 0: { done: true, at: ${Date.now() - DAY}, correct: 40, total: 50 } } }
      }
      challengeSave()
    `, sb)
    assert('Day6 昨天 done → Day7 天级解锁', vm.runInContext('chDayUnlocked(7)', sb) === true)
    vm.runInContext(`
      chs = null
      chStartStage(7, 0)
      chs.questions.forEach((q, i) => { chs.index = i; chPick(q.answer[0]); chSubmitAnswer() })
      chFinishPractice()
    `, sb)
    assert('Day7 巩固完成后测试阶段解锁', vm.runInContext('chStageUnlocked(7,1)', sb) === true)
    assert('Day7 巩固 days[7].stages[0] = 30/30', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[7] && st.days[7].stages[0]
      return r && r.done && r.correct === 30 && r.total === 30
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
    // ⑥ 防作弊强制交卷：切屏超限回调 chCheatSubmit → 按已答判分（手造 test 会话；Day1/7 正式 test 均已完成）
    vm.runInContext(`
      chs = { day: 7, si: 1, kind: 'test', questions: challengeStageQuestions(7, 1), answers: challengeStageQuestions(7, 1).map(() => -1), index: 0, phase: 'quiz', submitted: false, correctCount: 0 }
      chs.questions.slice(0, 5).forEach((q, i) => { chs.index = i; chPick(q.answer[0]) })
      chs.index = 19
      chCheatSubmit()
    `, sb)
    assert('chCheatSubmit → 强制交卷（phase=result）', vm.runInContext('chs && chs.phase === "result"', sb))
    assert('强制交卷按已答判分 5/20 = 25', vm.runInContext('chs.score', sb) === 25, `got ${vm.runInContext('chs.score', sb)}`)
    // 恢复 Day7 正式测试记录（9/20），不影响后续报告断言
    vm.runInContext(`
      challengeState.days[7].stages[1] = { done: true, at: ${Date.now()}, correct: 9, total: 20 }
      challengeSave()
    `, sb)
  }

  // ---------- ⑥ 进步报告数据 ----------
  console.log('\n[6] chDayScore / chTestScoreOfDay / 报告')
  {
    assert('chTestScoreOfDay(1) = 50', vm.runInContext('chTestScoreOfDay(1)', sb) === 50)
    assert('chDayScore(1) 合并 (10+3)/(20+30) = 26%', vm.runInContext('chDayScore(1)', sb) === 26, `got ${vm.runInContext('chDayScore(1)', sb)}`)
    assert('chDayScore(6) = 80%（前置天预置 40/50）', vm.runInContext('chDayScore(6)', sb) === 80, `got ${vm.runInContext('chDayScore(6)', sb)}`)
    assert('chTestScoreOfDay(6) = null（当天无测试）', vm.runInContext('chTestScoreOfDay(6)', sb) === null)
    const html = vm.runInContext('String(chReportHtml())', sb)
    assert('Day1+Day7 测试均完成后报告含两测试分', html.includes('50') && html.includes('45') && html.length > 100)
  }

  // ---------- ⑦ i18n ----------
  console.log('\n[7] i18n 双语键')
  {
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const keys = ['chTitle', 'chIntro', 'chPoolInfo', 'chTestTag', 'chPracticeTag', 'chDay', 'chLocked', 'chStageLocked', 'chTomorrow', 'chStart', 'chRetake', 'chOnceOnly', 'chQuitConfirm', 'chSubmitTest', 'chConfirmSubmit', 'chTestDone', 'chPracticeDone', 'chBackToChallenge', 'chReportTitle', 'chDelta', 'chReportHint', 'chDayDoneTag', 'chEntryHint', 'chProgressTitle', 'chProgressStages', 'chProgressQ', 'dashChTitle', 'dashChJoin', 'dashChTotalQ', 'dashChAvg', 'dashChNone', 'dashChThProgress', 'dashChThQ', 'dashChThAcc', 'dashChThDay1', 'dashChThDay7', 'dashChHint', 'dashChWrongTitle', 'dashChWrongHint', 'dashChThWrong', 'chDashProgress']
    const zhIdx = i18nSrc.indexOf('zh: {')
    const enIdx = i18nSrc.indexOf('en: {')
    const zhPart = i18nSrc.slice(zhIdx, enIdx)
    const enPart = i18nSrc.slice(enIdx)
    assert('挑战+看板 41 键 zh 区全部存在', keys.every(k => new RegExp('\\b' + k + '\\s*:').test(zhPart)),
      keys.filter(k => !new RegExp('\\b' + k + '\\s*:').test(zhPart)).join(','))
    assert('挑战+看板 41 键 en 区全部存在', keys.every(k => new RegExp('\\b' + k + '\\s*:').test(enPart)),
      keys.filter(k => !new RegExp('\\b' + k + '\\s*:').test(enPart)).join(','))
    assert('navChallenge 键已删除（zh/en）', !/\bnavChallenge\s*:/.test(zhPart) && !/\bnavChallenge\s*:/.test(enPart))
    assert("setTitle('navChallenge') 行已删除", !i18nSrc.includes("setTitle('navChallenge'"))
    assert('t("chTomorrow") 含「明日」', vm.runInContext('t("chTomorrow")', sb).includes('明日'))
    assert('t("chProgressStages",3) 可调用', vm.runInContext('t("chProgressStages", 3)', sb).includes('3'))
    assert('t("chProgressQ",60) 可调用', vm.runInContext('t("chProgressQ", 60)', sb).includes('60'))
    assert('t("chDashProgress",4,5) 可调用', (() => {
      const s = vm.runInContext('t("chDashProgress", 4, 5)', sb)
      return typeof s === 'string' && s.includes('4') && s.includes('5')
    })())
    assert('chPoolInfo 含「难度逐日递增」', vm.runInContext('t("chPoolInfo", 684)', sb).includes('难度逐日递增'))
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
    assert('时间锁 chDayLastDoneAt', chSrc.includes('function chDayLastDoneAt'))
    assert('防作弊启动（test 阶段 AntiCheat.start）', chSrc.includes('AntiCheat.start({ maxViolations: 3, onSubmit: chCheatSubmit })'))
    assert('防作弊强制交卷 chCheatSubmit', chSrc.includes('function chCheatSubmit'))
    assert('交卷/退出 AntiCheat.stop', (chSrc.match(/AntiCheat\.stop\(\)/g) || []).length >= 3)
    assert('chy 上报 reportChallengeStage', chSrc.includes('Store.reportChallengeStage(chs.day, chs.si, chs.kind'))
    assert('addProgress 带 challenge:true', (chSrc.match(/challenge: true/g) || []).length === 2)
    const storeSrc = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
    assert('store.reportChallengeStage 定义', storeSrc.includes('reportChallengeStage(day, si, kind, correct, total)'))
    assert('perq 只报挑战错题（省空间）', storeSrc.includes('if (!record.correct) this.reportPerQuestion(record.question_id, false, true)'))
    const cloudSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
    assert("cloud-store chy 事件分支", cloudSrc.includes("case 'chy':"))
    assert('cloud-store chQ 聚合', cloudSrc.includes('r.chQ = r.chQ || {}'))
    assert('cloud-store rename 合并 chy/chQ', cloudSrc.includes('tgt.chy = (tgt.chy || []).concat(r.chy)'))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
