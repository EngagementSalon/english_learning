// ====== 测试 v84：管理员「只重置考试成绩」（练习进度 / 打卡 / 错题 / 积分不受影响） ======
// ① 看板口径：被重置的测试记录（cleared 存根）→ 两列成绩显示「—」、不再计积分与题数，
//    但每日打卡 ✅、进度 9/9、参与汇总不受影响（存根保留 day/si/at 供统计）
// ② 学员端：重置后测试阶段可重考（done 去除）、进度链与天数解锁不受影响、
//    排名行渲染「成绩已重置，可重考」+ 开始按钮、进步报告不再有该场成绩
// ③ 重考闭环：本地重考覆盖存根 + 云端新增 chy → 看板成绩与积分恢复
// ④ 其余口径不受影响：练习记录 / chQ 错题 / __q / perQ、其他学员、管理员不参加排名
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

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

// ---------- 看板渲染沙箱（同 test-v82 模式） ----------
function renderDash(rows) {
  const el = { innerHTML: '' }
  const sb = {
    console,
    document: { getElementById: (id) => (id === 'dashChallengeBlock' ? el : null) },
    setTimeout, clearTimeout,
  }
  vm.createContext(sb)
  vm.runInContext(I18N, sb)
  vm.runInContext(extractFn(APP, 'escHtml'), sb)
  vm.runInContext(extractFn(APP, 'escAttr'), sb)   // v85：重置按钮 data-u/data-n 转义
  vm.runInContext(extractFn(APP, 'dashChStageWeight'), sb)
  vm.runInContext(extractFn(APP, 'renderDashChallengeBlock'), sb)
  // v88：营次筛选依赖（dashRoundView/dashRoundCurId/dashRoundList）——从 app.js 提取真实实现，
  // 沙箱无云端营次 → dashRoundList 返回空数组、dashRoundCurId 兜底 'r1'，等价单期（第一期）口径
  vm.runInContext('let dashRoundView = \'\'', sb)
  vm.runInContext(extractFn(APP, 'dashRoundList'), sb)
  vm.runInContext(extractFn(APP, 'dashRoundCurId'), sb)
  vm.runInContext(extractFn(APP, 'dashRoundSlug'), sb)
  // v89：看板挑战统计的部门筛选（dashChDept / normDept）——沙箱按「全部部门」口径，行为与 v88 一致
  vm.runInContext('let dashChDept = "all"', sb)
  vm.runInContext(extractFn(APP, 'normDept'), sb)
  vm.runInContext(extractFn(APP, 'normDeptSub'), sb)
  vm.runInContext(extractFn(APP, '_deptSubIndex'), sb)
  vm.runInContext(extractFn(APP, 'deptTree'), sb)
  vm.runInContext('const DEPT_MAJOR_KEYS = ["dining", "rooms", "other"]', sb)
  vm.runInContext('const DEPT_CANON = { dining: ["标帜餐厅", "艳中餐厅", "酒吧团队", "客房送餐"], rooms: ["迎宾前台", "礼宾部", "随时随需", "客房造型", "健身及水疗中心"] }', sb)
  vm.runInContext('const DEPT_SUB_SLUGS = { dining: { "标帜餐厅": "sig", "艳中餐厅": "yan", "酒吧团队": "bar", "客房送餐": "ird" }, rooms: { "迎宾前台": "fo", "礼宾部": "concierge", "随时随需": "ww", "客房造型": "styling", "健身及水疗中心": "spa" } }', sb)
  vm.runInContext('const DEPT_SUB_BY_SLUG = (() => { const o = {}; Object.keys(DEPT_SUB_SLUGS).forEach(mk => Object.keys(DEPT_SUB_SLUGS[mk]).forEach(s => { o[mk + "/" + DEPT_SUB_SLUGS[mk][s]] = s })); return o })()', sb)
  vm.runInContext(extractFn(APP, 'deptSlug'), sb)
  vm.runInContext(extractFn(APP, 'deptSlugName'), sb)
  vm.runInContext(extractFn(APP, 'deptGroupKey'), sb)

  vm.runInContext('const TYPE_LABELS = new Proxy({}, { get: (_, k) => k })', sb)
  vm.runInContext('const Store = { getQuestions: () => [] }', sb)
  vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(rows)})`, sb)
  return el.innerHTML
}
// 取某学员在进度明细表中的整行（跳过前面的积分榜行）
function rowOf(html, username) {
  const seg = html.slice(html.indexOf('colspan="7"'))
  const start = seg.indexOf('>' + username + '<')
  if (start < 0) return ''
  return seg.slice(start, seg.indexOf('</tr>', start))
}
const countOf = (s, k) => s.split(k).length - 1

// ---------- 学员端沙箱（challenge.js 进度相关函数） ----------
const DAYS_MINI = [
  { day: 1, stages: [{ kind: 'test', count: 20 }, { kind: 'practice', count: 10 }] },
  { day: 2, stages: [{ kind: 'practice', count: 30 }] },
  { day: 3, stages: [{ kind: 'practice', count: 30 }] },
  { day: 4, stages: [{ kind: 'practice', count: 30 }] },
  { day: 5, stages: [{ kind: 'practice', count: 30 }] },
  { day: 6, stages: [{ kind: 'practice', count: 30 }] },
  { day: 7, stages: [{ kind: 'practice', count: 10 }, { kind: 'test', count: 20 }] },
]
function makeChSandbox(state, examOpen) {
  const sb = { console, Math, JSON, Object, Array, String, Number, Date, Set, document: { getElementById: () => null }, setTimeout, clearTimeout }
  sb.window = sb
  vm.createContext(sb)
  vm.runInContext(I18N, sb)
  vm.runInContext(`const CHALLENGE_DAYS = ${JSON.stringify(DAYS_MINI)}`, sb)
  vm.runInContext(`const CloudSync = { _chOpen: true, _chExamOpen: ${!!examOpen} }`, sb)
  vm.runInContext(`let challengeState = ${JSON.stringify(state)}`, sb)
  vm.runInContext('let chs = null', sb)
  vm.runInContext(`const Store = { trackPractice() {}, reportChallengeStage() {} }`, sb)
  vm.runInContext('function challengeSave() {}', sb)
  // v111：chStageRowHtml 新增 chIsHardRound() 依赖（进阶期标签）→ 沙箱同步注入
  //（chIsHardRound 读 chRoundSlug/chCurrentRound，本沙箱无营次 → 自然回落 false = 第一期行为）
  vm.runInContext('function chIsHardRound() { return false }', sb)
  ;['challengeStageMeta', 'challengeStageInfo', 'challengeKindOf', 'chStageRec', 'chStageDone', 'chStageCleared',
    'chStageCounted', 'chDayDone', 'chDayLastDoneAt', 'chDayUnlocked', 'chStageUnlocked', 'chStageScore',
    'chIsFinalExam', 'chFinalExamLocked', 'chExamEarlyOpen', 'chOpenLocked', 'chOpenEverOpened', 'chStageRowHtml', 'chClearExamStageRecs',
    'chRecordStage'].forEach(f => vm.runInContext(extractFn(CH, f), sb))
  return sb
}

// 完整的七天进度（Day1 摸底 8/20 + Day1 练习 25/30 + Day2-6 各 25/30 + Day7 练习 10/10 + Day7 期末 18/20）
const YDAY = Date.now() - 86400000
function fullDays() {
  const d = { 1: { stages: {} }, 7: { stages: {} } }
  d[1].stages[0] = { done: true, at: YDAY, correct: 8, total: 20, wrong: ['11'] }
  d[1].stages[1] = { done: true, at: YDAY + 60000, correct: 25, total: 30, wrong: [] }
  for (let day = 2; day <= 6; day++) d[day] = { stages: { 0: { done: true, at: YDAY, correct: 25, total: 30, wrong: [] } } }
  d[7].stages[0] = { done: true, at: YDAY, correct: 10, total: 10, wrong: [] }
  d[7].stages[1] = { done: true, at: YDAY, correct: 18, total: 20, wrong: [] }
  return { uid: 'alice', days: d }
}
// 与上面等价的云端 chy（练习部分相同；test 由 cleared 决定是否已重置）
function fullChy(cleared) {
  const a = []
  a.push(cleared
    ? { day: 1, si: 0, kind: 'test', correct: 0, total: 0, usedSec: 0, at: 100, cleared: true }
    : { day: 1, si: 0, kind: 'test', correct: 8, total: 20, usedSec: 300, at: 100 })
  a.push({ day: 1, si: 1, kind: 'practice', correct: 25, total: 30, usedSec: 120, at: 150 })
  for (let day = 2; day <= 6; day++) a.push({ day, si: 0, kind: 'practice', correct: 25, total: 30, usedSec: 100, at: 1000 + day })
  a.push({ day: 7, si: 0, kind: 'practice', correct: 10, total: 10, usedSec: 80, at: 2000 })
  a.push(cleared
    ? { day: 7, si: 1, kind: 'test', correct: 0, total: 0, usedSec: 0, at: 3000, cleared: true }
    : { day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 400, at: 3000 })
  return a
}

;(async () => {
  console.log('\n🧪 v84 只重置考试成绩测试')

  // ---------- ① 看板：只掉成绩，不掉进度/打卡/汇总 ----------
  console.log('\n[1] 看板：成绩归零但进度、打卡与练习部分不受影响')
  const rows = [
    { username: 'alice', name: 'Alice', dept: '标帜餐厅', role: 'student', chy: fullChy(false), chQ: { 11: { correct: 0, total: 1 } } },
    { username: 'bob', name: 'Bob', dept: '迎宾前台', role: 'student', chy: fullChy(true), chQ: {} },
  ]
  const html = renderDash(rows)
  {
    const r = rowOf(html, 'alice')
    assert('未重置学员：Day1/Day7 成绩可见（40 / 90）', r.includes('>40<') && r.includes('>90<'), r.slice(0, 400))
    assert('未重置学员：9/9 环节 + 7 天打卡 ✅', r.includes('9/9') && countOf(r, '✅') === 7 && countOf(r, '◐') === 0, r.slice(0, 400))
  }
  {
    const r = rowOf(html, 'bob')
    assert('已重置学员：两列成绩显示「—」（不再显示旧分数）', countOf(r, '>—</span>') === 2, r.slice(0, 400))
    assert('已重置学员：不会出现考试分数 40 / 90', !r.includes('>40<') && !r.includes('>90<'))
    assert('已重置学员：进度仍为 9/9 环节（存根算完成）', r.includes('9/9'), r.slice(0, 300))
    assert('已重置学员：7 天打卡全部保持 ✅（练习进度不倒退）', countOf(r, '✅') === 7 && countOf(r, '◐') === 0, r.slice(-240))
  }
  {
    // 积分：练习部分（160 对×100 − 700s = 15300）保留；考试部分（Day1 500 + Day7 期末 5000）被扣除
    assert('未重置学员积分含考试部分（16000−700+500+5000 = 20800）', html.includes('>20800<'), '')
    assert('已重置学员积分为练习部分（16000−700 = 15300）', html.includes('>15300<'), '')
  }
  {
    // 打卡人数汇总不含测试分（按天统计不变）
    assert('各天打卡人数汇总仍显示 D1 2 · D2 2（重置不影响打卡）', /D1 2/.test(html) && /D2 2/.test(html), '')
  }

  // ---------- ② 学员端：可重考、进度链不断 ----------
  console.log('\n[2] 学员端：重置后测试可重考，进度与天数解锁不受影响')
  {
    const sb = makeChSandbox(fullDays(), false)
    vm.runInContext('window.__cleared = chClearExamStageRecs()', sb)
    assert('清理掉两场考试成绩（返回 2）', vm.runInContext('window.__cleared', sb) === 2)
    assert('测试阶段不再算「已完成」（可重考）', vm.runInContext('chStageDone(1,0) === false && chStageDone(7,1) === false', sb))
    assert('标记为已重置存根 + 保留完成时间与题量', vm.runInContext(
      'const r = challengeState.days[1].stages[0]; r.cleared === true && r.at > 0 && r.total === 20 && r.wrong === undefined', sb))
    assert('成绩读取为空（不显示旧分数）', vm.runInContext('chStageScore(1,0) === null && chStageScore(7,1) === null', sb))
    assert('练习阶段原样保留（25/30、10/10）', vm.runInContext(
      'challengeState.days[1].stages[1].done === true && challengeState.days[1].stages[1].correct === 25 && chStageRec(7,0).correct === 10', sb))
    assert('当天仍算完成（Day1 / Day7 打卡与进度不倒退）', vm.runInContext('chDayDone(1) === true && chDayDone(7) === true', sb))
    assert('次日解锁判定不受影响（Day2 已解锁）', vm.runInContext('chDayUnlocked(2) === true', sb))
    assert('9 个环节仍全部计入进度', vm.runInContext(
      'challengeStageMeta().filter(m => chStageCounted(m.day, m.si)).length === 9', sb))
    assert('Day7 阶段链（练习→考试）仍视为解锁', vm.runInContext('chStageUnlocked(7,1) === true', sb))
  }
  {
    // 渲染：已重置的考试行显示「成绩已重置，可重考」+ 开始按钮；未重置的练习行显示分数
    const sb = makeChSandbox(fullDays(), false)
    vm.runInContext('chClearExamStageRecs()', sb)
    const row1 = vm.runInContext('chStageRowHtml(1, 0, { kind: "test", count: 20 })', sb)
    assert('Day1 考试行：标注成绩已重置 + 出现开始按钮', row1.includes('成绩已重置，可重考') && row1.includes('chStartStage(1,0)'), row1)
    assert('Day1 考试行：不再显示旧分数（40）与「仅测一次」', !row1.includes('>40<') && !row1.includes('仅测一次'), row1)
    const rowPractice = vm.runInContext('chStageRowHtml(1, 1, { kind: "practice", count: 10 })', sb)
    assert('练习行不受影响：显示 ✓ 25/30 与重练按钮', rowPractice.includes('25/30') && rowPractice.includes('chStartStage(1,1)'), rowPractice)
    const rowExamLocked = vm.runInContext('chStageRowHtml(7, 1, { kind: "test", count: 20 })', sb)
    assert('Day7 考试行：管理员未开考时仍按门禁锁定（不越过 v76 开关）', rowExamLocked.includes('期末考试待管理员开放') && !rowExamLocked.includes('chStartStage(7,1)'), rowExamLocked)
  }
  {
    // 重考完成 → 覆盖存根，成绩恢复
    const sb = makeChSandbox(fullDays(), false)
    vm.runInContext('chClearExamStageRecs()', sb)
    vm.runInContext('chs = { day: 7, si: 1, kind: "test", startedAt: Date.now() - 60000 }', sb)
    vm.runInContext('chRecordStage(16, 20, [101])', sb)
    assert('重考后本地记录恢复为已完成（cleared 标记被覆盖）', vm.runInContext(
      'const r = chStageRec(7,1); r.done === true && r.cleared === undefined && r.correct === 16 && r.total === 20', sb))
    assert('重考后成绩可读（80 分）', vm.runInContext('chStageScore(7,1) === 80', sb))
  }

  // ---------- ③ 重考闭环：云端恢复 ----------
  console.log('\n[3] 重考闭环：新成绩重新进入看板与积分')
  {
    const chy = fullChy(true)
    chy.push({ day: 7, si: 1, kind: 'test', correct: 16, total: 20, usedSec: 250, at: 9000 })
    const html2 = renderDash([{ username: 'bob', name: 'Bob', dept: '迎宾前台', role: 'student', chy, chQ: {} }])
    const r = rowOf(html2, 'bob')
    assert('重考后 Day7 成绩列恢复（80 分）', r.includes('>80<'), r.slice(0, 400))
    assert('Day1 仍为「—」（未重考）', countOf(r, '>—</span>') === 1, r.slice(0, 400))
    assert('重考的期末成绩按 3 倍权重计入积分（15300+4800−250 = 19850）', html2.includes('>19850<'), '')
    assert('Day7 打卡仍 ✅（重考不重复计数）', countOf(r, '✅') === 7, r.slice(-240))
  }

  // ---------- ④ 口径与接线 ----------
  console.log('\n[4] 实现口径与接线')
  // v88：重置改为按营次作用 → 条件中多了 inRound(x)（仅清当前营次的测试记录），
  // 但「按重置时刻过滤、只清重置前的成绩」这一幂等口径不变。
  assert('云端：exam 模式按重置时刻过滤（重放幂等，只清重置前的成绩）', /x\.kind === 'test' && !x\.cleared && inRound\(x\) && \(x\.at \|\| 0\) <= ev\.ts/.test(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')))
  assert('看板：测试列跳过存根（!x.cleared）', APP.includes("x.kind === 'test' && x.day === 1 && !x.cleared") && APP.includes("x.kind === 'test' && x.day === 7 && !x.cleared"))
  assert('看板：积分去重跳过存根', /firstByStage\[k\] \|\| \(x\.at \|\| 0\)/.test(APP) && APP.includes('if (x.cleared) return'))
  assert('学员端积分榜同样跳过存根', CH.includes('if (x && x.cleared) return'))
  assert('学员端：chDayDone / chDayLastDoneAt 兼容存根', CH.includes('cfg.stages.every((_, si) => chStageCounted(day, si))') && CH.includes('if (r && (r.done || r.cleared) && r.at)'))
  assert('学员端：进度条按 counted 统计', CH.includes('meta.filter(m => chStageCounted(m.day, m.si)).length'))
  const i18nKeys = ['chResetExamNotice:', 'chResetExamNoticeHint:', 'chResetExamRetake:', 'dashChResetBtn:', 'dashChResetHint:']
  const bad = i18nKeys.filter(k => I18N.split(k).length - 1 !== 2)
  assert('i18n 新增/更新键 zh/en 成对', bad.length === 0, bad.join(','))
  assert('管理端按钮文案为「重置成绩」（v86 缩短避免按钮竖排）', I18N.includes("dashChResetBtn: '重置成绩'") && I18N.includes("dashChResetBtn: 'Reset scores'"))

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v84 只重置考试成绩测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
