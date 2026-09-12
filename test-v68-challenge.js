// ====== 测试 v68：标帜餐厅七天英文挑战 ======
// ① 题池：challengePool 确定性（固定种子可复现）、684 题、id 去重
// ② 分天：7×50=350 题不重叠；day1 ≠ day7 题集；每天题型混合；与 pool 切片一致
// ③ 解锁：day1 恒解锁；后一天需前一天 done；水平测试 done 后不可重做（chStartDay 拒绝）
// ④ 状态：challengeSave/Load 往返；uid 变更重置
// ⑤ 判分：模拟会话 finishChallengeTest → days 记录 + addProgress 逐题；练习 chFinishPractice
// ⑥ 报告：Day1+Day7 完成后 challengeScore 正确
// ⑦ i18n：挑战键 zh/en 成对存在（含函数键可调用）
// ⑧ 接线：index.html nav/page/script；app.js renderFn；i18n setTitle
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
  console.log('\n🧪 v68 七天挑战（标帜餐厅）测试')

  // ---------- ① 题池确定性 ----------
  console.log('\n[1] 题池确定性')
  let sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  const poolIds = vm.runInContext('challengePool().map(q => q.id)', sb)
  const poolIds2 = vm.runInContext('challengePool().map(q => q.id)', sb)
  assert('题池 684 题', poolIds.length === 684, `got ${poolIds.length}`)
  assert('固定种子两次洗牌 id 序列完全一致', JSON.stringify(poolIds) === JSON.stringify(poolIds2))
  assert('题池 id 唯一', new Set(poolIds).size === 684)

  // ---------- ② 分天切片 ----------
  console.log('\n[2] 分天切片 7×50')
  const dayIds = []
  for (let d = 1; d <= 7; d++) {
    const ids = vm.runInContext(`challengeDayQuestions(${d}).map(q => q.id)`, sb)
    dayIds.push(ids)
  }
  const allChallenge = dayIds.flat()
  assert('7 天 × 50 = 350 题', allChallenge.length === 350, `got ${allChallenge.length}`)
  assert('350 题互不重叠', new Set(allChallenge).size === 350)
  assert('Day1 与 Day7 题集不同（进步对比真实）', JSON.stringify(dayIds[0]) !== JSON.stringify(dayIds[6]))
  {
    // day N 题目 = pool[(N-1)*50 .. N*50)
    const d3 = vm.runInContext('challengeDayQuestions(3).map(q => q.id)', sb)
    assert('Day3 = pool[100..150) 顺序一致', JSON.stringify(d3) === JSON.stringify(poolIds.slice(100, 150)))
  }
  {
    const types = new Set(vm.runInContext('challengeDayQuestions(1).map(q => q.type)', sb))
    assert('每天题型混合（listen/single/voicematch）', types.size === 3, `got ${[...types].join(',')}`)
    const ok = dayIds.every(ids => new Set(vm.runInContext(`challengeDayQuestions(${dayIds.indexOf(ids) + 1}).map(q=>q.type)`, sb)).size === 3)
    assert('7 天全部题型混合', ok)
  }
  {
    // 选项每次进入重洗（id 稳定，选项顺序可变）
    const o1 = vm.runInContext('JSON.stringify(challengeDayQuestions(2)[0].options)', sb)
    let diff = false
    for (let i = 0; i < 8; i++) {
      if (vm.runInContext('JSON.stringify(challengeDayQuestions(2)[0].options)', sb) !== o1) { diff = true; break }
    }
    assert('选项顺序每次进入重洗（防背位置）', diff, '8 次调用选项序未变化（概率极低，若复现重跑）')
  }

  // ---------- ③ 解锁规则 ----------
  console.log('\n[3] 顺序解锁 + 测试仅一次')
  sb = makeSandbox()
  vm.runInContext('Store.init()', sb)
  vm.runInContext('challengeLoad()', sb)
  assert('Day1 恒解锁', vm.runInContext('challengeDayUnlocked(1)', sb) === true)
  assert('Day2 初始锁定', vm.runInContext('challengeDayUnlocked(2)', sb) === false)
  assert('Day7 初始锁定', vm.runInContext('challengeDayUnlocked(7)', sb) === false)
  vm.runInContext(`
    challengeState.days[1] = { done: true, at: 1, correct: 40, total: 50 }
    challengeSave()
  `, sb)
  assert('Day1 done → Day2 解锁', vm.runInContext('challengeDayUnlocked(2)', sb) === true)
  assert('Day1 done → Day3 仍锁定', vm.runInContext('challengeDayUnlocked(3)', sb) === false)
  {
    // 水平测试 done 后 chStartDay 拒绝（chs 保持 null）
    vm.runInContext('chStartDay(1)', sb)
    assert('Day1 已完成 → chStartDay(1) 不开会话', vm.runInContext('chs', sb) === null || vm.runInContext('chs === null', sb))
    vm.runInContext('chStartDay(3)', sb)
    assert('Day3 未解锁 → chStartDay(3) 不开会话', vm.runInContext('chs === null', sb))
    vm.runInContext('chStartDay(2)', sb)
    assert('Day2 解锁 → chStartDay(2) 开会话（50 题 practice）', vm.runInContext('chs && chs.kind === "practice" && chs.questions.length === 50', sb))
  }

  // ---------- ④ 状态持久化 + uid 绑定 ----------
  console.log('\n[4] 状态持久化与用户绑定')
  assert('eq_challenge_v1 已写入 localStorage', !!sb.localStorage.getItem('eq_challenge_v1'))
  {
    const before = JSON.parse(sb.localStorage.getItem('eq_challenge_v1'))
    assert('记录绑定 uid=anon（未登录）', before.uid === 'anon')
    vm.runInContext('challengeLoad()', sb)
    assert('重新 load 后 Day1 状态保留', vm.runInContext('challengeDayDone(1)', sb) === true)
    // 模拟另一账号登录
    vm.runInContext(`
      Store.getSession = function () { return { id: 'u2', username: 'alice', role: 'student' } }
      challengeLoad()
    `, sb)
    assert('换账号（alice）后挑战进度重置', vm.runInContext('challengeDayDone(1)', sb) === false)
    assert('新状态 uid=alice', JSON.parse(sb.localStorage.getItem('eq_challenge_v1')).uid === 'alice')
  }

  // ---------- ⑤ 判分与记录 ----------
  console.log('\n[5] 水平测试判分 / 每日练习完成')
  {
    let progressCalls = 0
    let tracked = null
    vm.runInContext(`
      Store.addProgress = function (p) { window.__progress.push(p) }
      Store.trackPractice = function (c, t2) { window.__track = { c, t2 } }
      window.__progress = []
      window.__track = null
    `, sb)
    // 重新以 alice 开 Day2 练习
    vm.runInContext(`
      chStartDay(2)
      // 答对前 3 题（answer[0] 之外——options 已重洗，直接取正确项）
      chs.questions.slice(0, 3).forEach((q, i) => { chs.index = i; chPick(q.answer[0]); chSubmitAnswer() })
      chs.index = 3
      // 第 4 题答错
      chs.questions[3] && (() => { const q = chs.questions[3]; const wrong = q.answer[0] === 0 ? 1 : 0; chPick(wrong); chSubmitAnswer() })()
    `, sb)
    progressCalls = vm.runInContext('window.__progress.length', sb)
    assert('练习逐题 addProgress（4 题）', progressCalls === 4, `got ${progressCalls}`)
    assert('correctCount = 3（3 对 1 错）', vm.runInContext('chs.correctCount', sb) === 3)
    vm.runInContext('chFinishPractice()', sb)
    assert('完成后 days[2] 记录 done correct=3 total=50', (() => {
      const st = JSON.parse(sb.localStorage.getItem('eq_challenge_v1'))
      return st.days[2] && st.days[2].done && st.days[2].correct === 3 && st.days[2].total === 50
    })())
    assert('trackPractice(3, 50) 已调用', vm.runInContext('window.__track && window.__track.c === 3 && window.__track.t2 === 50', sb))
    assert('practice 结果页 phase=result', vm.runInContext('chs.phase', sb) === 'result')
  }
  {
    // 水平测试：Day1 统一判分
    vm.runInContext(`
      chs = null
      chStartDay(1)
      // 前 10 题答对，其余留空
      chs.questions.slice(0, 10).forEach((q, i) => { chs.index = i; chPick(q.answer[0]) })
      chs.index = 49
    `, sb)
    vm.runInContext('finishChallengeTest()', sb)
    assert('Day1 测试判分 10/50 = 20 分', vm.runInContext('chs.score', sb) === 20, `got ${vm.runInContext('chs.score', sb)}`)
    assert('Day1 逐题 addProgress（50 条）', vm.runInContext('window.__progress.length', sb) === 50 + 4, `got ${vm.runInContext('window.__progress.length', sb)}`)
    assert('review 长度 50 且含对错标记', vm.runInContext('chs.review.length === 50 && chs.review.filter(r => r.isCorrect).length === 10', sb))
    assert('Day1 done 后再 chStartDay(1) 被拒绝', (() => {
      vm.runInContext('chBack(); chStartDay(1)', sb)
      return vm.runInContext('chs === null', sb)
    })())
  }

  // ---------- ⑥ 进步报告数据 ----------
  console.log('\n[6] challengeScore 与报告前置')
  {
    const s1 = vm.runInContext('challengeScore(1)', sb)
    assert('Day1 score = 20%', s1 === 20, `got ${s1}`)
    assert('Day7 未完成 score = null', vm.runInContext('challengeScore(7)', sb) === null)
    assert('报告在 Day7 未完成时不渲染（返回空串）', vm.runInContext('String(chReportHtml())', sb) === '')
    vm.runInContext('challengeState.days[7] = { done: true, at: 2, correct: 45, total: 50 }', sb)
    assert('Day7 45/50 → score 90%', vm.runInContext('challengeScore(7)', sb) === 90)
    const html = vm.runInContext('String(chReportHtml())', sb)
    assert('Day1+Day7 完成后报告含分数与增量', html.includes('20') && html.includes('90') && html.length > 100)
  }

  // ---------- ⑦ i18n ----------
  console.log('\n[7] i18n 双语键')
  {
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const keys = ['navChallenge', 'chTitle', 'chIntro', 'chPoolInfo', 'chTestTag', 'chPracticeTag', 'chDay', 'chLocked', 'chStart', 'chRetake', 'chOnceOnly', 'chQuitConfirm', 'chSubmitTest', 'chConfirmSubmit', 'chTestDone', 'chPracticeDone', 'chBackToChallenge', 'chReportTitle', 'chDelta', 'chReportHint', 'chDayDoneTag']
    const zhIdx = i18nSrc.indexOf('zh: {')
    const enIdx = i18nSrc.indexOf('en: {')
    const zhPart = i18nSrc.slice(zhIdx, enIdx)
    const enPart = i18nSrc.slice(enIdx)
    assert('挑战 21 键 zh 区全部存在', keys.every(k => new RegExp('\\b' + k + '\\s*:').test(zhPart)))
    assert('挑战 21 键 en 区全部存在', keys.every(k => new RegExp('\\b' + k + '\\s*:').test(enPart)))
    const zhCall = vm.runInContext('typeof t("chDay", 3) === "string" && t("chDay", 3).indexOf("3") >= 0', sb)
    assert('函数键 t("chDay",3) 可调用', zhCall)
    assert('navChallenge 中文=七天挑战 英文=7-Day Challenge',
      vm.runInContext('t("navChallenge")', sb).includes('七天挑战') || vm.runInContext('t("navChallenge")', sb).includes('Challenge'),
      vm.runInContext('t("navChallenge")', sb))
  }

  // ---------- ⑧ 接线 ----------
  console.log('\n[8] 静态接线')
  {
    const idx = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')
    assert('nav 有 challenge 项', idx.includes('data-page="challenge"'))
    assert('page-challenge 容器存在', idx.includes('id="page-challenge"'))
    assert('challenge.js 已引入', idx.includes('<script src="challenge.js?v='))
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    assert('navigate renderFn 注册 challenge', /challenge:\s*renderChallenge/.test(appSrc))
    const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    assert("applyI18n setTitle('navChallenge')", i18nSrc.includes("setTitle('navChallenge', 'navChallenge')"))
    const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
    assert('题源固定分类 12', chSrc.includes('Number(q.category_id) === 12'))
    assert('水平测试不可重做 guard', /=== 'test' && challengeDayDone\(day\)/.test(chSrc))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
