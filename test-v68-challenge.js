// ====== 测试 v70：标帜餐厅七天英文挑战（阶段模型 + 练习页入口） ======
// ① 题池：challengePool 确定性（固定种子可复现）、684 题、id 去重
// ② 阶段切片：9 阶段 350 题不重叠；起点=前面各阶段累加；Day1 ≠ Day7 测试题集
// ③ 解锁：天级（前一天全阶段完成）+ 阶段级（前一阶段完成）；test done 后不可重做
// ④ 状态：eq_challenge_v2 save/Load 往返；uid 变更重置
// ⑤ 判分：测试统一判分 + review；练习逐题反馈 + 完成记录；Day7 巩固→测试链路
// ⑥ 报告：chTestScoreOfDay / chDayScore / chReportHtml
// ⑦ i18n：挑战键 zh/en 成对（新增 chEntryHint/chStageLocked，删除 navChallenge）
// ⑧ 接线：nav 无挑战项；page 容器 + script + renderFn + 练习页入口卡片
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

;(async () => {
  console.log('\n🧪 v70 七天挑战（标帜餐厅·阶段模型）测试')

  // ---------- ① 题池确定性 ----------
  console.log('\n[1] 题池确定性')
  let sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  const poolIds = vm.runInContext('challengePool().map(q => q.id)', sb)
  const poolIds2 = vm.runInContext('challengePool().map(q => q.id)', sb)
  assert('题池 684 题', poolIds.length === 684, `got ${poolIds.length}`)
  assert('固定种子两次洗牌 id 序列完全一致', JSON.stringify(poolIds) === JSON.stringify(poolIds2))
  assert('题池 id 唯一', new Set(poolIds).size === 684)

  // ---------- ② 阶段切片 ----------
  console.log('\n[2] 阶段切片 9 阶段 350 题')
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
  assert('Day1 测试 = pool[0..20)', JSON.stringify(stageIds[0]) === JSON.stringify(poolIds.slice(0, 20)))
  assert('Day1 巩固 = pool[20..50)', JSON.stringify(stageIds[1]) === JSON.stringify(poolIds.slice(20, 50)))
  assert('Day3 = pool[100..150)', JSON.stringify(stageIds[3]) === JSON.stringify(poolIds.slice(100, 150)))
  assert('Day7 巩固 = pool[300..330)', JSON.stringify(stageIds[7]) === JSON.stringify(poolIds.slice(300, 330)))
  assert('Day7 测试 = pool[330..350)', JSON.stringify(stageIds[8]) === JSON.stringify(poolIds.slice(330, 350)))
  assert('Day1 与 Day7 测试题集不同（进步对比真实）', JSON.stringify(stageIds[0]) !== JSON.stringify(stageIds[8]))
  assert('Day1 测试+巩固 = pool[0..50) 连续', JSON.stringify(stageIds[0].concat(stageIds[1])) === JSON.stringify(poolIds.slice(0, 50)))
  {
    const types = new Set(vm.runInContext('challengeStageQuestions(2,0).map(q => q.type)', sb))
    assert('题型混合（listen/single/voicematch）', types.size === 3, `got ${[...types].join(',')}`)
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

  // ---------- ③ 解锁规则 ----------
  console.log('\n[3] 天级+阶段级解锁 / 测试仅一次')
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
    challengeState.days[1] = { stages: { 0: { done: true, at: 1, correct: 16, total: 20 } } }
    challengeSave()
  `, sb)
  assert('Day1 测试 done → 巩固阶段解锁', vm.runInContext('chStageUnlocked(1,1)', sb) === true)
  assert('Day1 仅测试 done → 天未完成，Day2 仍锁', vm.runInContext('chDayUnlocked(2)', sb) === false)
  vm.runInContext(`
    challengeState.days[1].stages[1] = { done: true, at: 2, correct: 25, total: 30 }
    challengeSave()
  `, sb)
  assert('Day1 全阶段 done → Day2 解锁', vm.runInContext('chDayUnlocked(2)', sb) === true)
  vm.runInContext(`
    challengeState.days[2] = { stages: { 0: { done: true, at: 3, correct: 40, total: 50 } } }
    challengeSave()
  `, sb)
  assert('Day2 done → Day3 解锁', vm.runInContext('chDayUnlocked(3)', sb) === true)
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

  // ---------- ⑤ 判分与记录 ----------
  console.log('\n[5] 水平测试判分 / 巩固练习 / Day7 链路')
  sb = makeSandbox()
  vm.runInContext('Store.init(); challengeLoad()', sb)
  vm.runInContext(`
    Store.addProgress = function (p) { window.__progress.push(p) }
    Store.trackPractice = function (c, t2) { window.__track = { c, t: t2 } }
    window.__progress = []
    window.__track = null
  `, sb)
  {
    // ① Day1 水平测试（20 题）：前 10 对，其余空 → 50 分
    vm.runInContext(`
      chStartStage(1, 0)
      chs.questions.slice(0, 10).forEach((q, i) => { chs.index = i; chPick(q.answer[0]) })
      chs.index = 19
    `, sb)
    vm.runInContext('finishChallengeTest()', sb)
    assert('Day1 测试判分 10/20 = 50 分', vm.runInContext('chs.score', sb) === 50, `got ${vm.runInContext('chs.score', sb)}`)
    assert('测试逐题 addProgress（20 条）', vm.runInContext('window.__progress.length', sb) === 20, `got ${vm.runInContext('window.__progress.length', sb)}`)
    assert('review 长度 20 且 10 对', vm.runInContext('chs.review.length === 20 && chs.review.filter(r => r.isCorrect).length === 10', sb))
    assert('days[1].stages[0] = {done, correct:10, total:20}', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[1] && st.days[1].stages[0]
      return r && r.done && r.correct === 10 && r.total === 20
    })())
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
    assert('练习逐题 addProgress（20+4=24 条）', vm.runInContext('window.__progress.length', sb) === 24, `got ${vm.runInContext('window.__progress.length', sb)}`)
    assert('correctCount = 3（3 对 1 错）', vm.runInContext('chs.correctCount', sb) === 3)
    vm.runInContext('chFinishPractice()', sb)
    assert('days[1].stages[1] = {done, correct:3, total:30}', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v2'))
      const r = st.days[1] && st.days[1].stages[1]
      return r && r.done && r.correct === 3 && r.total === 30
    })())
    assert('trackPractice(3, 30) 已调用', vm.runInContext('window.__track && window.__track.c === 3 && window.__track.t === 30', sb))
    // ③ 已 done 的练习可重练
    vm.runInContext('chBack(); chStartStage(1, 1)', sb)
    assert('已 done 的练习可重练（再开会话）', vm.runInContext('chs && chs.day === 1 && chs.si === 1 && chs.questions.length === 30', sb))
  }
  {
    // ④ Day7：前置天 2-6 完成后，巩固 done → 测试解锁 → 测试判分
    vm.runInContext(`
      for (let d = 2; d <= 6; d++) {
        challengeState.days[d] = { stages: { 0: { done: true, at: d, correct: 40, total: 50 } } }
      }
      challengeSave()
    `, sb)
    assert('Day6 done → Day7 天级解锁', vm.runInContext('chDayUnlocked(7)', sb) === true)
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

  // ---------- ⑥ 进步报告数据 ----------
  console.log('\n[6] chDayScore / chTestScoreOfDay / 报告')
  {
    assert('chTestScoreOfDay(1) = 50', vm.runInContext('chTestScoreOfDay(1)', sb) === 50)
    assert('chDayScore(1) 合并 (10+3)/(20+30) = 26%', vm.runInContext('chDayScore(1)', sb) === 26, `got ${vm.runInContext('chDayScore(1)', sb)}`)
    assert('chDayScore(7) 合并 (30+9)/(30+20) = 78%', vm.runInContext('chDayScore(7)', sb) === 78, `got ${vm.runInContext('chDayScore(7)', sb)}`)
    assert('chDayScore(6) = 80%（前置天预置 40/50）', vm.runInContext('chDayScore(6)', sb) === 80, `got ${vm.runInContext('chDayScore(6)', sb)}`)
    assert('chTestScoreOfDay(6) = null（当天无测试）', vm.runInContext('chTestScoreOfDay(6)', sb) === null)
    const html = vm.runInContext('String(chReportHtml())', sb)
    assert('Day1+Day7 测试均完成后报告含两测试分', html.includes('50') && html.includes('45') && html.length > 100)
  }

  // ---------- ⑦ i18n ----------
  console.log('\n[7] i18n 双语键')
  {
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const keys = ['chTitle', 'chIntro', 'chPoolInfo', 'chTestTag', 'chPracticeTag', 'chDay', 'chLocked', 'chStageLocked', 'chStart', 'chRetake', 'chOnceOnly', 'chQuitConfirm', 'chSubmitTest', 'chConfirmSubmit', 'chTestDone', 'chPracticeDone', 'chBackToChallenge', 'chReportTitle', 'chDelta', 'chReportHint', 'chDayDoneTag', 'chEntryHint']
    const zhIdx = i18nSrc.indexOf('zh: {')
    const enIdx = i18nSrc.indexOf('en: {')
    const zhPart = i18nSrc.slice(zhIdx, enIdx)
    const enPart = i18nSrc.slice(enIdx)
    assert('挑战 22 键 zh 区全部存在', keys.every(k => new RegExp('\\b' + k + '\\s*:').test(zhPart)))
    assert('挑战 22 键 en 区全部存在', keys.every(k => new RegExp('\\b' + k + '\\s*:').test(enPart)))
    assert('navChallenge 键已删除（zh/en）', !/\bnavChallenge\s*:/.test(zhPart) && !/\bnavChallenge\s*:/.test(enPart))
    assert("setTitle('navChallenge') 行已删除", !i18nSrc.includes("setTitle('navChallenge'"))
    const entryHint = vm.runInContext('t("chEntryHint", 3)', sb)
    assert('t("chEntryHint",3) 可调用且含 3', typeof entryHint === 'string' && entryHint.includes('3'), entryHint)
    assert('t("chStageLocked") 可调用', typeof vm.runInContext('t("chStageLocked")', sb) === 'string')
    assert('t("chDay",3) 可调用', vm.runInContext('typeof t("chDay", 3) === "string" && t("chDay", 3).indexOf("3") >= 0', sb))
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
    const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
    assert('题源固定分类 12', chSrc.includes('Number(q.category_id) === 12'))
    assert('水平测试不可重做 guard（阶段版）', /=== 'test' && chStageDone\(day, si\)/.test(chSrc))
    assert('状态键 eq_challenge_v2', chSrc.includes("CHALLENGE_KEY = 'eq_challenge_v2'"))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
