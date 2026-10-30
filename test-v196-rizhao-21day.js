// v196：日照大部门（rizhao/canyin + rizhao/fangwu）+ 21 天挑战结构（chPlan:'v3'）
//   · V3 结构：Day1 test 30 / Day2-20 practice 30×19 / Day21 test 30 = 630 题，难度逐日递增
//   · 日照-餐饮题池展开：canyin → sig/yan/bar/ird 四餐厅题库合集（抽题池与视角题库同口径）
//   · 期末判定/积分权重/报告/打卡格改走 chLastTestDay()（绝不写死 day===7）
//   · 后台：营次管理「挑战结构」选择器 + 看板/导出/补录按 dashChDayCount 动态 21/7
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const IDX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
const CS = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf8')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
function extractFn(src, name) {
  let i = src.indexOf('function ' + name + '(')
  if (i < 0) i = src.search(new RegExp('(^|\\n)\\s*(async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (i < 0) throw new Error('not found: ' + name)
  let d = 0, started = false
  const j = src.indexOf('{', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') { d++; started = true }
    else if (src[k] === '}') { d--; if (started && d === 0) return src.slice(i, k + 1) }
  }
  throw new Error('unbalanced: ' + name)
}

// V3 常量块（const 无法 extractFn，按文本区间截取注入沙箱）
const CONST_HEAD = 'const CHALLENGE_DAYS_V3'
const CONST_TAIL = 'const CHALLENGE_TEST_PLAN_HARD_V3 = [4, 13, 13]'
const v3ConstBlock = CH.slice(CH.indexOf(CONST_HEAD), CH.indexOf(CONST_TAIL) + CONST_TAIL.length)
ok('Z0 V3 常量块完整截取（630 行内）', v3ConstBlock.includes('CHALLENGE_TOTAL_V3') && v3ConstBlock.includes('CHALLENGE_DIFF_PLAN_V3'))
// legacy + v2 常量块（chDays/chTotal 的回落分支需要；区间到下一个 const/函数声明为止，含注释无害）
const legacyConstBlock =
  CH.slice(CH.indexOf('const CHALLENGE_DAYS ='), CH.indexOf(CONST_HEAD)) +
  CH.slice(CH.indexOf('const CHALLENGE_DAYS_V2 ='), CH.indexOf('function chDeptKey'))
const aliasConstBlock = CH.slice(CH.indexOf('const CH_DEPT_POOL_ALIAS'), CH.indexOf('function chPoolExpandDepts'))

function mkChSandbox(chRounds, curId, recForDept) {
  const sb = {
    Math, Number, String, Array, Object, Set, Date, isFinite, isNaN, console, JSON,
    CloudSync: { _chRounds: chRounds || [] },
    chCurrentRound: () => (curId || ''),
    chRoundRecForDept: recForDept || (() => (chRounds || []).find(r => String(r.id) === String(curId || '')) || null),
    chRoundSlug: id => String(id || ''),
    PRACTICE_DEPT_SLUGS: ['', 'dining', 'rooms', 'rizhao', 'all', 'dining/sig', 'dining/yan', 'dining/bar', 'dining/ird', 'rizhao/canyin', 'rizhao/fangwu'],
    practiceDept: '',
    sessionDeptSlug: () => '',
  }
  vm.createContext(sb)
  vm.runInContext(v3ConstBlock, sb)
  try { vm.runInContext(legacyConstBlock, sb) } catch (e) { console.log('  ⚠ legacy 常量注入失败: ' + e.message) }
  try { vm.runInContext(aliasConstBlock, sb) } catch (e) { console.log('  ⚠ alias 常量注入失败: ' + e.message) }
  ;['chPlanIsV2', 'chPlanIsV3', 'chIsHardRound', 'chDays', 'chTotal', 'chDiffPlan', 'chTestPlan',
    'chLastTestDay', 'chLastPracticeDay', 'challengeStageMeta', 'challengeStageInfo', 'challengeKindOf', 'chPoolExpandDepts',
    'chRoundRecForCurrent', 'chRoundBankQuestions'].forEach(n => {
    try { vm.runInContext(extractFn(CH, n), sb) } catch (e) { console.log('  ⚠ 抽取失败 ' + n + ': ' + e.message) }
  })
  return sb
}

console.log('=== [A] V3 结构（21 天 / 630 题 / 难度逐级递增） ===')
const sbA = mkChSandbox([{ id: 'r8', chPlan: 'v3', depts: ['rizhao/canyin'] }], 'r8')
const daysA = sbA.chDays()
ok('A1 chDays = 21 天且 day 连续 1..21',
  daysA.length === 21 && daysA.every((d, i) => d.day === i + 1))
ok('A2 Day1/Day21 各 1 个 test 环节 30 题，其余 19 天各 1 个 practice 30 题',
  daysA[0].stages.length === 1 && daysA[0].stages[0].kind === 'test' && daysA[0].stages[0].count === 30 &&
  daysA[20].stages.length === 1 && daysA[20].stages[0].kind === 'test' && daysA[20].stages[0].count === 30 &&
  daysA.slice(1, 20).every(d => d.stages.length === 1 && d.stages[0].kind === 'practice' && d.stages[0].count === 30))
ok('A3 chTotal = 630', sbA.chTotal() === 630, '实=' + sbA.chTotal())
const dpA = sbA.chDiffPlan()
ok('A4 DIFF_PLAN_V3 共 21 行，练习日每行合计 30，考试日 [0,0,0]',
  dpA.length === 21 && dpA[0].reduce((a, b) => a + b, 0) === 0 && dpA[20].reduce((a, b) => a + b, 0) === 0 &&
  dpA.slice(1, 20).every(r => r.reduce((a, b) => a + b, 0) === 30))
const avgOf = r => (r[0] * 1 + r[1] * 2 + r[2] * 3) / 30
let mono = true
for (let i = 1; i < 19; i++) { if (!(avgOf(dpA[i]) < avgOf(dpA[i + 1]))) { mono = false; break } }
ok('A5 练习日均值严格单调递增（Day2 1.13 → Day20 2.57）',
  mono && Math.abs(avgOf(dpA[1]) - 1.1333) < 0.01 && Math.abs(avgOf(dpA[19]) - 2.5667) < 0.01)
const dphA = sbA.chDiffPlan && null // placeholder
ok('A6 基础档考试配比 [15,10,5] 合计 30',
  JSON.stringify(sbA.chTestPlan()) === JSON.stringify([15, 10, 5]))
// 进阶档：r9 是各该部门组第 2 期 → chIsHardRound true
const sbA2 = mkChSandbox([
  { id: 'r8', chPlan: 'v3', depts: ['rizhao/canyin'], seq: 1 },
  { id: 'r9', chPlan: 'v3', depts: ['rizhao/canyin'], seq: 2 },
], 'r9')
ok('A7 进阶档（第 2 期）练习均值逐日高于基础档，考试配比 [4,13,13] 合计 30',
  (() => {
    const hard = sbA2.chDiffPlan()
    for (let i = 1; i <= 19; i++) { if (avgOf(hard[i]) <= avgOf(dpA[i])) return false }
    return JSON.stringify(sbA2.chTestPlan()) === JSON.stringify([4, 13, 13])
  })())
ok('A8 chLastTestDay：v3 = 21 / legacy（无营次记录）= 7',
  sbA.chLastTestDay() === 21 && mkChSandbox([], '').chLastTestDay() === 7)
ok('A9 chLastPracticeDay：v3 = 20 / legacy = 7（沿用旧档）',
  sbA.chLastPracticeDay() === 20 && mkChSandbox([], '').chLastPracticeDay() === 7)
ok('A10 互斥：chPlan:v2 营次 chPlanIsV3=false；无记录两者皆 false',
  (() => {
    const sb = mkChSandbox([{ id: 'r3', chPlan: 'v2' }], 'r3')
    if (sb.chPlanIsV3()) return false
    const sb2 = mkChSandbox([], '')
    return !sb2.chPlanIsV3() && !sb2.chPlanIsV2()
  })())
ok('A11 legacy 结构不动：无记录时 chDays=7 天旧结构 / chTotal=210',
  (() => { const sb = mkChSandbox([], ''); const d = sb.chDays(); return d.length === 7 && d[0].stages.length === 2 && sb.chTotal() === 210 })())

console.log('\n=== [B] 日照题池展开 ===')
const sbB = mkChSandbox([{ id: 'r8', chPlan: 'v3', depts: ['rizhao/canyin'] }], 'r8')
// v198：fangwu 不再「原样返回」—— 展开为房务五子部门 + 自身（礼宾/客房用品词汇库）
ok('B1 chPoolExpandDepts：canyin → 四餐厅池；fangwu → 房务五子部门+自身；混合去重',
  (() => {
    const a = sbB.chPoolExpandDepts(['rizhao/canyin'])
    const b = sbB.chPoolExpandDepts(['rizhao/fangwu'])
    const c = sbB.chPoolExpandDepts(['rizhao/canyin', 'dining/sig'])
    return JSON.stringify(a) === JSON.stringify(['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird']) &&
      JSON.stringify(b) === JSON.stringify(['rizhao/fangwu', 'rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa']) &&
      JSON.stringify(c) === JSON.stringify(['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird'])
  })())
const QPOOL = [
  { id: 1, category_id: 12, dept: 'dining/sig' }, { id: 2, category_id: 12, dept: 'dining/yan' },
  { id: 3, category_id: 12, dept: 'dining/bar' }, { id: 4, category_id: 12, dept: 'dining/ird' },
  { id: 5, category_id: 12, dept: 'rizhao/fangwu' }, { id: 6, category_id: 12, dept: 'rooms/fo' },
  { id: 7, category_id: 12, dept: '' }, { id: 8, category_id: 12, dept: 'all' },
  { id: 9, category_id: 3, dept: 'dining/sig' },  // 非 cat12 不进池
]
const sbB2 = mkChSandbox([{ id: 'r8', chPlan: 'v3', depts: ['rizhao/canyin'] }], 'r8')
sbB2.Store = { getQuestions: () => QPOOL }
const poolB = sbB2.chRoundBankQuestions()
ok('B2 抽题池：canyin 营次 = 四餐厅 + 通用，不含 fangwu/rooms，非 cat12 剔除',
  (() => {
    const ids = poolB.map(q => q.id).sort((a, b) => a - b)
    return JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4, 7, 8])
  })(), '实=' + JSON.stringify(poolB.map(q => q.id)))
const sbB3 = mkChSandbox([{ id: 'r9', chPlan: 'v3', depts: ['rizhao/fangwu'] }], 'r9')
sbB3.Store = { getQuestions: () => QPOOL }
ok('B3 抽题池：fangwu 营次 = 自身 + 房务子部门(rooms/fo) + 通用（v198 展开）',
  (() => {
    const ids = sbB3.chRoundBankQuestions().map(q => q.id).sort((a, b) => a - b)
    return JSON.stringify(ids) === JSON.stringify([5, 6, 7, 8])
  })())
ok('B4 视角题库（chBankQuestions）同口径：管理员切 rizhao/canyin 切片也能看到四餐厅题',
  (() => {
    const src = CH
    const sb = mkChSandbox([], '')
    sb.Store = { getQuestions: () => QPOOL, isAdmin: () => true }
    sb.practiceDept = 'rizhao/canyin'
    vm.runInContext(extractFn(src, 'chDeptKey'), sb)
    vm.runInContext(extractFn(src, 'chBankQuestions'), sb)
    const ids = sb.chBankQuestions().map(q => q.id).sort((a, b) => a - b)
    return JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4, 7, 8])
  })())
ok('B5 展开只改抽题池不改归属：QPOOL 数据未被污染',
  QPOOL[0].dept === 'dining/sig' && QPOOL[4].dept === 'rizhao/fangwu')

console.log('\n=== [C] 源码契约（期末日收口 + 后台动态列） ===')
ok('C1 chIsFinalExam / chLbStageWeight 体内引用 chLastTestDay，不再写死 ===7',
  codeOnly(extractFn(CH, 'chIsFinalExam')).includes('chLastTestDay()') &&
  codeOnly(extractFn(CH, 'chLbStageWeight')).includes('chLastTestDay()') &&
  !/===\s*7/.test(codeOnly(extractFn(CH, 'chIsFinalExam'))) &&
  !/===\s*7/.test(codeOnly(extractFn(CH, 'chLbStageWeight'))))
ok('C2 chLevelOf：v3 早退不并线下课（return capped）',
  (() => { const c = codeOnly(extractFn(CH, 'chLevelOf')); return c.includes("chPlanIsV3()") && c.includes('return capped') })())
ok('C3 chTitleText：v3 走 chTitleDept21 / chTitle21',
  codeOnly(extractFn(CH, 'chTitleText')).includes("t('chTitleDept21'") && codeOnly(extractFn(CH, 'chTitleText')).includes("t('chTitle21')"))
ok('C4 v201：renderChallenge 末尾调用 refreshChallengeNavLabel，该函数内按营次动态命名（navChallengeCh21）',
  codeOnly(extractFn(CH, 'renderChallenge')).includes('refreshChallengeNavLabel()') && codeOnly(extractFn(CH, 'refreshChallengeNavLabel')).includes('navChallengeCh21'))
ok('C5 app.js：dashChDayCount 被 列宽/导出表头/补录 total/补录 si 共用',
  codeOnly(extractFn(APP, 'dashChColPx')).includes('dashChDayCount()') &&
  codeOnly(extractFn(APP, 'dashChExportHeader')).includes('dashChDayCount()') &&
  codeOnly(extractFn(APP, 'dashManualScoreSubmit')).includes('dashChDayCount() === 21 ? 30 : 20'))
ok('C6 app.js：dashUserDailyAllAcc 按营次取天数（chPlan===\'v3\' → 21），绝不写死 7',
  codeOnly(extractFn(APP, 'dashUserDailyAllAcc')).includes("chPlan === 'v3'") &&
  codeOnly(extractFn(APP, 'dashUserDailyAllAcc')).includes('daysOfSlug(slug)'))
ok('C7 cloud-store：_roundsNorm 白名单收 v3（不无条件补默认）',
  CS.match(/if \(r\.chPlan === 'v3'\) rec\.chPlan = 'v3'/) !== null &&
  !/rec\.chPlan = r\.chPlan \|\| 'v2'/.test(CS))
ok('C8 cloud-store：setChallengeRound 的 chPlan patch 只接受 v2/v3 显式值',
  codeOnly(extractFn(CS, 'setChallengeRound')).includes("(p.chPlan === 'v2' || p.chPlan === 'v3')"))

console.log('\n=== [D] 沙箱真跑（21 天不丢 Day8+ / 权重 / 补录口径） ===')
// D1 dashUserDailyAllAcc：v3 营次 Day8-10 数据必须完整展开为 21 cells
const sbD = { Math, Number, String, Array, Object, isFinite, console, dashRoundSlug: id => String(id || '') }
vm.createContext(sbD)
vm.runInContext(extractFn(APP, 'dashUserDailyAcc'), sbD)
vm.runInContext(extractFn(APP, 'dashUserDailyAllAcc'), sbD)
const tD1 = sbD.dashUserDailyAllAcc({
  chy: [
    { day: 1, si: 0, correct: 25, total: 30, at: 100, rd: 'r8' },
    { day: 8, si: 0, correct: 20, total: 30, at: 800, rd: 'r8' },
    { day: 21, si: 0, kind: 'test', correct: 28, total: 30, at: 2100, rd: 'r8' },
  ],
}, null)
// 默认 7 天口径下 Day8/21 会被 day>N 过滤 → 注入 rdList 后必须 21 cells 全保留
const sbD2 = {
  Math, Number, String, Array, Object, isFinite, console,
  dashRoundSlug: id => String(id || ''),
  dashRoundList: () => [{ id: 'r8', name: '日照-餐饮21天挑战第一期', chPlan: 'v3' }],
}
vm.createContext(sbD2)
vm.runInContext(extractFn(APP, 'dashUserDailyAcc'), sbD2)
vm.runInContext(extractFn(APP, 'dashUserDailyAllAcc'), sbD2)
const tD2 = sbD2.dashUserDailyAllAcc({
  chy: [
    { day: 1, si: 0, correct: 25, total: 30, at: 100, rd: 'r8' },
    { day: 8, si: 0, correct: 20, total: 30, at: 800, rd: 'r8' },
    { day: 21, si: 0, kind: 'test', correct: 28, total: 30, at: 2100, rd: 'r8' },
  ],
})
ok('D1 v3 营次 21 cells（Day8/Day21 不被 day>7 过滤）',
  tD2.cells.length === 21 && tD2.cells[7].acc === 67 && tD2.cells[20].acc === 93,
  '实=' + tD2.cells.length + ' cells')
ok('D2 加权均值跨全期 = (25+20+28)/90 = 81%',
  tD2.avg === 81 && tD2.covered === 3, '实=' + tD2.avg)
ok('D3 缺天 null 断线（Day2 无数据 acc=null）', tD2.cells[1].acc === null && tD2.cells[1].cum === 83)

// D4 chLbStageWeight / chIsFinalExam 在 v3 沙箱真跑
const sbD4 = mkChSandbox([{ id: 'r8', chPlan: 'v3', depts: ['rizhao/canyin'] }], 'r8')
vm.runInContext(extractFn(CH, 'chIsFinalExam'), sbD4)
vm.runInContext(extractFn(CH, 'chLbStageWeight'), sbD4)
ok('D4 v3：chLbStageWeight(21,test)=3 / (7,test)=1；chIsFinalExam(21,0)=true',
  sbD4.chLbStageWeight(21, 'test') === 3 && sbD4.chLbStageWeight(7, 'test') === 1 &&
  sbD4.chIsFinalExam(21, 0) === true && sbD4.chIsFinalExam(7, 0) === false)
ok('D5 legacy：chLbStageWeight(7,test)=3 不回归；chIsFinalExam(7,si=1)=true（旧结构 Day7 第 2 环节才是考试）',
  mkChSandbox([], '') && (() => {
    const sb = mkChSandbox([], '')
    vm.runInContext(extractFn(CH, 'chLbStageWeight'), sb)
    vm.runInContext(extractFn(CH, 'chIsFinalExam'), sb)
    return sb.chLbStageWeight(7, 'test') === 3 && sb.chIsFinalExam(7, 1) === true && sb.chIsFinalExam(7, 0) === false
  })())

// D6 dashChDayCount：dashRoundView 指向 v3 → 21；legacy → 7
const sbD6 = { Math, Number, String, Array, console }
vm.createContext(sbD6)
vm.runInContext('var dashRoundView = "r8"', sbD6)
vm.runInContext(extractFn(APP, 'dashRoundCurId').replace(/^function dashRoundCurId\(\)/, 'function dashRoundCurId()'), sbD6)
  ; // dashRoundCurId 依赖 Store/CloudSync —— 直接 stub 掉再注入 dashChDayCount
vm.runInContext('dashRoundCurId = function () { return "r8" }', sbD6)
vm.runInContext(extractFn(APP, 'dashRoundList').replace(/^function dashRoundList[\s\S]*$/, 'function dashRoundList() { return [{ id: "r8", chPlan: "v3" }, { id: "r1", chPlan: "v2" }] }'), sbD6)
vm.runInContext(extractFn(APP, 'dashChDayCount'), sbD6)
const d6 = (() => {
  const a = sbD6.dashChDayCount()
  vm.runInContext('dashRoundView = "r1"', sbD6)
  const b = sbD6.dashChDayCount()
  vm.runInContext('dashRoundView = "r8"', sbD6)
  return a + '/' + b
})()
ok('D6 dashChDayCount：v3 营次 = 21，legacy = 7', d6 === '21/7', '实=' + d6)

console.log('\n=== [E] i18n（双语成对 + 无「七天」残留） ===')
ok('E1 chTitle21 字符串（无参）zh+en 各 1',
  (I18N.match(/chTitle21:\s*'/g) || []).length === 2)
ok('E2 chTitleDept21 带参箭头函数 zh+en 各 1',
  (I18N.match(/chTitleDept21:\s*\(\s*\w+\s*\)\s*=>/g) || []).length === 2)
;['chIntro21', 'chReportTitle21', 'chLevelSrc21', 'navChallengeCh21',
  'dashRoundPlanV3Tag', 'dashRoundPlanV3Title', 'dashRoundPlanLabel', 'dashRoundPlanV3',
  'dashRoundPlanHint', 'dashChManualDay21'].forEach(k => {
  // \b 词边界防前缀误匹配（dashRoundPlanV3 不得吃到 dashRoundPlanV3Tag）
  const n = (I18N.match(new RegExp('(^|[\\n,\\s])' + k + '\\s*:', 'g')) || []).length
  ok('E3 ' + k + ' zh/en 成对', n === 2, '实=' + n)
})
ok('E4 deptTree.rizhao 双语（日照 / 日照-餐饮 / 日照-房务）',
  I18N.includes("rizhao: { name: '日照', subs: ['日照-餐饮', '日照-房务'] }") &&
  I18N.includes("rizhao: { name: 'Rizhao', subs: ['Rizhao F&B', 'Rizhao Rooms'] }"))
ok('E5 chDeptNames 含两个日照分部（zh+en）',
  (I18N.match(/'日照-餐饮': '日照-餐饮'/g) || []).length === 1 &&
  (I18N.match(/'日照-房务': '日照-房务'/g) || []).length === 1)
ok('E6 21 天新文案不含「七天/7-Day」字样',
  (() => {
    const keys = ['chTitle21', 'chTitleDept21', 'chIntro21', 'chReportTitle21', 'chLevelSrc21', 'navChallengeCh21']
    // 取每个键所在行的值片段判「七天 / 7-Day」
    for (const k of keys) {
      const re = new RegExp(k + '\\s*:\\s*[\'"`]([^\'"`]*)[\'"`]')
      const m = I18N.match(re)
      if (m && /七天|7-Day|7 Day/.test(m[1])) return false
    }
    return true
  })())
ok('E7 渲染沙箱：t(chTitleDept21) 插值正常（箭头函数契约）',
  (() => {
    const sb = { console }
    vm.createContext(sb)
    try { vm.runInContext(I18N + '\n;globalThis.__D = (typeof I18N !== "undefined") ? I18N : null;', sb) } catch (e) { return false }
    const zh = (sb.__D || {}).zh || {}
    const v = zh.chTitleDept21
    return typeof v === 'function' && v('日照-餐饮') === '日照-餐饮21天英文挑战'
  })())

console.log('\n=== [F] 版本标记（动态，不写死版本号） ===')
const vNums = IDX.match(/\?v=(\d+)/g) || []
const uniq = Array.from(new Set(vNums))
ok('F1 index.html 版本标记 12 处同号', vNums.length === 12 && uniq.length === 1, '实=' + vNums.length + ' 处 / ' + uniq.join(','))
ok('F2 版本号 ≥195（不回退）', uniq.length === 1 && parseInt(uniq[0].replace(/\?v=/, ''), 10) >= 195, uniq[0])

console.log('\n=== 结果 = ' + pass + ' 通过 / ' + fail + ' 失败 ===')
process.exit(fail === 0 ? 0 : 1)
