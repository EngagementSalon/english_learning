// test-v180-level-all-history.js
// v180：等级评定改按「过往所有正确率」（全量历史）的回归套件
//
// 【需求原话】「依然是定级的问题 我觉得你还是要参考过往的所有正确率定级的 所以请更新吧」
// 【用户拍板的三项口径】
//   ① 定级时机 = 双管齐下：学员端打开页面自动按云端全量重算 + 管理后台一键「重算历史等级」
//   ② 数据口径 = 云端 chy 全量（跨营次、按 day-si 去重取 at 最早、cleared 跳过）
//   ③ 难度地板 = 保留但放宽（按「实际练到的最高难度档」取基准，而非只压单日均值）
//
// 【本套件锁定的契约】
//   · chLevelAcc 必须**同时**吃本机存档与云端 chy 全量，且两路按 day-si 去重（幂等）
//   · chLevelBench 必须**跨营次**取最高 practice day；test 阶段不抬基准
//   · chLevelCapOfBench 按「档位区间」判上限（<1.5→1 / <2.5→2 / <3.5→3 / else 4），
//     不再用 Math.round（那会把 Day2 的 1.27 抹回 1、Day5 的 2.27 抹回 2，压制过紧）
//   · 上限永不高于 raw（准确率阈值仍决定能力上限）—— 两者取 min
//   · Day1 全对仍只 L1（**原有的地板压制完整保留**，防「题目容易 → 人人 L4」）
//   · chLevelBackfill 只在「确有首答记录」时动作（绝不把没练过的人写成假 L1）
//   · chLevelBackfill 与云端同值时不重复上报（幂等短路）
//   · _chCloudChy / _chCloudLevelKnown 必须用 runInContext 赋值（`let` 不能用 sandbox.x = v）
//   · 管理后台有「重算历史等级」按钮 + 4 个 i18n 键（中英成对）

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

let pass = 0, fail = 0
const fails = []
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')) }
}
function group(t) { console.log('\n' + t) }

function extractFn(src, name) {
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) throw new Error('fn not found: ' + name)
  const start = m.index + m[1].length
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
function grabFn(src, name) {
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) return ''
  const start = m.index + m[1].length
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
function extractConst(src, name) {
  const i = src.indexOf('const ' + name + ' = ')
  if (i < 0) throw new Error('const not found: ' + name)
  let k = i + ('const ' + name + ' = ').length
  while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++
  if (src[k] !== '[') {
    const e = src.indexOf('\n', k)
    return src.slice(i, e < 0 ? src.length : e).replace(/\s*\/\/.*$/, '')
  }
  let d = 0, j = k
  for (; j < src.length; j++) {
    if (src[j] === '[') d++
    else if (src[j] === ']') { d--; if (d === 0) break }
  }
  return src.slice(i, j + 1)
}
// ★ 计数类断言一律剥注释（本项目已七连撞）
const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// 真实名义计划难度均值（从源码实算，不许凭记忆写）
const planAvg = plan => plan.map(p => {
  const n = [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0]
  const sum = n[0] + n[1] + n[2]
  return sum ? (n[0] * 1 + n[1] * 2 + n[2] * 3) / sum : 0
})
const P1_AVG = planAvg([[10, 0, 0], [26, 0, 4], [21, 0, 9], [16, 0, 14], [11, 0, 19], [6, 0, 24], [1, 0, 9]])
const PH_AVG = planAvg([[5, 0, 5], [13, 3, 14], [8, 4, 18], [4, 5, 21], [2, 6, 22], [1, 7, 22], [0, 0, 10]])

// ====== 沙箱 ======
// ★★★ v180 关键：_chCloudChy / _chCloudLevelKnown 是模块级 `let`，
//   必须用 runInContext 赋值（`sandbox.x = v` 只会新建属性，真变量不动 —— v176 假红 5 项同款坑）。
function makeLvSandbox(opts) {
  const o = opts || {}
  const uid = o.uid || 'u'
  const st = { uid: uid, days: o.days || undefined }
  if (o.floor != null) st.chLevel = o.floor
  const stateJson = (o.days || o.floor != null) ? JSON.stringify(st) : 'null'
  const store = {}
  if (stateJson !== 'null') store['eq_challenge_v2'] = stateJson

  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, isFinite,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
    },
    Store: {
      isAdmin: () => false,
      getSession: () => ({ username: uid }),
      reportChallengeLevel: (lv, rd) => { sb.__report.push({ lv: lv, rd: rd }) },
    },
    CloudSync: { _chRounds: [], _chRoundCurId: '' },
    chRoundSlug: id => {
      const s = String(id || '第一期').trim()
      return (!s || s === 'r1' || s === '第一期') ? '第一期' : s
    },
    chCurrentRound: () => (o.hard ? 'r2' : '第一期'),
    chIsHardRound: () => !!o.hard,
    challengeSave: () => {},
    courseState: { doc: null },
    __report: [],
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  ;['CHALLENGE_DAYS', 'CHALLENGE_DIFF_PLAN', 'CHALLENGE_DIFF_PLAN_HARD'].forEach(n => {
    vm.runInContext(extractConst(CH, n), sb)
  })
  vm.runInContext('const CHALLENGE_KEY = "eq_challenge_v2"\n', sb)
  vm.runInContext(extractFn(CH, 'chDiffPlan'), sb)
  ;['chStageRec', 'chStageCounted'].forEach(n => { vm.runInContext(extractFn(CH, n), sb) })
  vm.runInContext(extractFn(CH, 'challengeUid'), sb)
  ;['chPlanDayAvg', 'chLevelMaxDay', 'chLevelTierOfBench', 'chLevelBench', 'chLevelAcc', 'chLevelOf', 'chLevelCapOfBench',
    'chLevelFloor', 'chLevel', 'chLevelApply', 'chLevelBackfill'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  // ★ 模块级 let：必须 runInContext 赋值
  vm.runInContext('let _chCloudChy = []\n', sb)
  vm.runInContext('let _chCloudLevelKnown = 0\n', sb)
  vm.runInContext('let _chLvAnimAt = 0\n', sb)
  vm.runInContext('let challengeState = ' + stateJson, sb)
  // 云端 chy 装填（走 runInContext —— 见函数头说明）
  vm.runInContext('_chCloudChy = ' + JSON.stringify(o.cloud || []) + '\n', sb)
  if (o.cloudKnown != null) vm.runInContext('_chCloudLevelKnown = ' + Number(o.cloudKnown) + '\n', sb)
  sb.__store = store
  return sb
}
const run = (sb, code) => vm.runInContext(code, sb)

function stg(correct, total, extra) {
  return Object.assign({ done: true, at: 1790000000000, correct, total, wrong: [] }, extra || {})
}
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps)
// 云端 chy 记录工厂
function cy(day, si, correct, total, extra) {
  return Object.assign({ day, si, kind: 'practice', correct, total, at: 1790000000000, rd: '' }, extra || {})
}

// ============================================================
group('组一：chLevelAcc —— 云端 chy 全量参与（存量学员的核心场景）')
{
  // 本机存档全空（换过设备 / 清过缓存 / v165 前练完后再没练）→ 旧口径恒 null → 恒 L1
  const sb = makeLvSandbox({ days: undefined, cloud: [
    cy(1, 0, 30, 30), cy(3, 0, 28, 30), cy(7, 0, 29, 30),
  ] })
  assert('★ 本机空 + 云端 3 阶段 87/90 → 准确率 97（旧口径 = null）',
    run(sb, 'chLevelAcc()') === 97, run(sb, 'chLevelAcc()'))
  assert('★★ 且能算出等级（L3）—— 「本机空 = 恒 L1」的旧行为已被修正',
    run(sb, 'chLevel()') === 3, run(sb, 'chLevel()'))
}

group('组二：chLevelAcc —— 本机与云端合并（去重幂等）')
{
  const local = { 3: { stages: { 0: stg(30, 30, { at: 100 }) } } }
  const sb = makeLvSandbox({ days: local, cloud: [cy(3, 0, 30, 30, { at: 100 })] })
  assert('★ 同一条记录本机 + 云端都在 → 去重后仍 100%（不翻倍）',
    run(sb, 'chLevelAcc()') === 100, run(sb, 'chLevelAcc()'))
  const sb2 = makeLvSandbox({ days: local, cloud: [cy(3, 0, 0, 30, { at: 999 })] })
  assert('★ 同键取 at 最早 —— 本机 at=100 胜出（云端 at=999 的 0 分不生效）',
    run(sb2, 'chLevelAcc()') === 100, run(sb2, 'chLevelAcc()'))
}

group('组三：chLevelBench —— 跨营次取最高 practice day（放宽的地板）')
{
  const sb = makeLvSandbox({ days: undefined, cloud: [
    cy(2, 0, 20, 20, { rd: '' }), cy(4, 0, 20, 20, { rd: 'r3' }), cy(6, 0, 20, 20, { rd: 'r4' }),
  ] })
  assert('★ 跨 3 个营次（rd 各不同）→ 取最高 day=6，基准 = 2.60',
    near(run(sb, 'chLevelBench()'), 2.6), run(sb, 'chLevelBench()'))
  assert('★ 最高已完成天数同样取云端全量 → 6', run(sb, 'chLevelMaxDay()') === 6, run(sb, 'chLevelMaxDay()'))
  // ★★★ v180 修正：bench 2.60 落在 [2.5,3.5) → cap 3，但 maxDay = 6 < 7 → **质量门槛的 day 侧不过关**
  //   → cap 被打回 2 → 准确率 100% 也只能 L2（旧断言的 3 是「无门槛」时代的口径，已作废）。
  //   这正是 v180 的意图：能到 3 档不代表给 L3，还得「跑满七天 + 准确率 ≥95%」。
  assert('★★ v180：基准 2.60 到 3 档但只练到 Day6 → 准确率 100 仍只给 L2（day 侧门槛拦下）',
    run(sb, 'chLevel()') === 2, run(sb, 'chLevel()'))
  // 反证：把最高 day 抬到 7 → cap 3 保住 → L3 达成。**证明拦的是 day 而不是 bench。**
  const sb7 = makeLvSandbox({ days: undefined, cloud: [
    cy(2, 0, 20, 20, { rd: '' }), cy(4, 0, 20, 20, { rd: 'r3' }), cy(7, 0, 20, 20, { rd: 'r4' }),
  ] })
  assert('★★ 反证：同为云端全量、把最高 day 抬到 7 → bench 2.80、maxDay 7 → 准确率 100 给 L3',
    near(run(sb7, 'chLevelBench()'), 2.8) && run(sb7, 'chLevelMaxDay()') === 7 && run(sb7, 'chLevel()') === 3,
    run(sb7, 'chLevelBench()') + '/' + run(sb7, 'chLevelMaxDay()') + '/' + run(sb7, 'chLevel()'))
}

group('组四：chLevelBench —— test 不抬基准、cleared 跳过')
{
  const sb = makeLvSandbox({ days: undefined, cloud: [
    cy(1, 0, 20, 20), cy(7, 1, 20, 20, { kind: 'test' }),
  ] })
  assert('★ test 阶段不抬基准 → 仍 Day1 的 1.00', near(run(sb, 'chLevelBench()'), 1.0), run(sb, 'chLevelBench()'))
  const sb2 = makeLvSandbox({ days: undefined, cloud: [
    cy(3, 0, 30, 30), cy(7, 0, 0, 30, { cleared: true }),
  ] })
  assert('★ cleared 存根不计入准确率 → 仍 100%', run(sb2, 'chLevelAcc()') === 100, run(sb2, 'chLevelAcc()'))
  assert('★ cleared 不抬基准 → 仍 Day3 = 1.60', near(run(sb2, 'chLevelBench()'), 1.6), run(sb2, 'chLevelBench()'))
}

group('组五：chLevelCapOfBench —— 档位区间（v180 替换 Math.round）')
{
  const sb = makeLvSandbox({})
  // 直接枚举档位边界（期望值实测回填）
  const cases = [
    [1.00, 1], [1.2667, 1], [1.49, 1],
    [1.50, 2], [1.60, 2], [2.2667, 2], [2.49, 2],
    [2.50, 3], [2.60, 3], [2.80, 3], [3.00, 3], [3.49, 3],
    [3.50, 4], [4.00, 4],
  ]
  let ok = true, bad = ''
  cases.forEach(([b, want]) => {
    const got = run(sb, 'chLevelCapOfBench(' + b + ', 4)')
    if (got !== want) { ok = false; bad += ` bench=${b} 期望${want} 实得${got};` }
  })
  assert('★★ 档位区间边界全对（<1.5→1 · <2.5→2 · <3.5→3 · else 4）', ok, bad)
  assert('★★ 上限永不高于 raw（bench 3.0 + raw 2 → 封顶 2）',
    run(sb, 'chLevelCapOfBench(3.0, 2)') === 2, run(sb, 'chLevelCapOfBench(3.0, 2)'))
  assert('★ 返回值恒为 1~4 整数（下游 cappedScore 分支依赖）',
    [1.0, 1.5, 2.5, 3.5, 9].every(b => {
      const v = run(sb, 'chLevelCapOfBench(' + b + ', 4)')
      return Number.isInteger(v) && v >= 1 && v <= 4
    }))
}

group('组六：地板压制完整保留（防「题目容易 → 人人 L4」）')
{
  const sb = makeLvSandbox({ days: { 1: { stages: { 0: stg(10, 10), 1: stg(10, 10) } } } })
  assert('★★ Day1 全对（100%）仍只评 L1 —— 基准 1.00 压死', run(sb, 'chLevel()') === 1, run(sb, 'chLevel()'))
  const sb7 = makeLvSandbox({ days: { 7: { stages: { 0: stg(10, 10), 1: stg(20, 20) } } } })
  assert('★ 第一期 Day7 全对 → L3（基准 2.80 → cap 3；第一期到不了 L4，设计如此）',
    run(sb7, 'chLevel()') === 3, run(sb7, 'chLevel()'))
  const sbH = makeLvSandbox({ hard: true, days: undefined, cloud: [cy(7, 0, 9, 10)] })
  // ★★★ v180 修正：cy(7,0,9,10) = 90% **未过 L3 的 95 线** → cap 3 被打回 2 → L2。
  //   旧断言的 3 属「无质量门槛」时代。要拿 L3 必须真的 ≥95%（见下反证）。
  assert('★★ v180：进阶期 Day7 全对（90%）→ 未过 95 门槛 → L2（门槛生效，旧口径曾为 3）',
    run(sbH, 'chLevel()') === 2, run(sbH, 'chLevel()'))
  assert('★ 进阶期 Day7 且 ≥95% → L3（基准 3.00 → cap 3；此处 19/20 = 95 恰好过线）',
    run(makeLvSandbox({ hard: true, days: undefined, cloud: [cy(7, 0, 19, 20)] }), 'chLevel()') === 3,
    run(makeLvSandbox({ hard: true, days: undefined, cloud: [cy(7, 0, 19, 20)] }), 'chLevel()'))
}

group('组七：chLevelBackfill —— 只在确有依据时动作（不写假 L1）')
{
  const sb = makeLvSandbox({ days: undefined, cloud: [] })
  assert('★ 无任何记录 → 准确率 null', run(sb, 'chLevelAcc()') === null, run(sb, 'chLevelAcc()'))
  assert('★★ chLevelBackfill → false（不动作）', run(sb, 'chLevelBackfill()') === false)
  assert('★★ 且零上报（绝不把没练过的人写成假 L1）', sb.__report.length === 0, sb.__report.length)
}

group('组八：chLevelBackfill —— 与云端同值不重复上报（幂等）')
{
  const sb = makeLvSandbox({ days: undefined, cloud: [cy(7, 0, 30, 30)], cloudKnown: 0 })
  const r1 = run(sb, 'chLevelBackfill()')
  const n1 = sb.__report.length
  const r2 = run(sb, 'chLevelBackfill()')
  const n2 = sb.__report.length
  assert('★ 首次回填 → true 且上报一次', r1 === true && n1 === 1, `${r1}/${n1}`)
  assert('★★ 再次回填（云端同值）→ false 且不重复上报', r2 === false && n2 === 1, `${r2}/${n2}`)
  assert('  上报的是 L3（97%+ 基准 2.80 → cap 3）', sb.__report[0] && sb.__report[0].lv === 3, JSON.stringify(sb.__report[0]))
}

group('组九：chLevelBackfill —— 云端等级更低时按历史重算并上报')
{
  // 云端已知 L2，但按全量历史（Day7 全对）实算 L3 → 应上报修正
  const sb = makeLvSandbox({ days: undefined, cloud: [cy(7, 0, 30, 30)], cloudKnown: 2 })
  const r = run(sb, 'chLevelBackfill()')
  assert('★ 云端 L2 vs 实算 L3 → 上报 L3 修正', r === true && sb.__report[0] && sb.__report[0].lv === 3,
    JSON.stringify(sb.__report))
}

group('组十：chLevelBackfill —— 本机存档同步（等级卡刷新即可见）')
{
  const sb = makeLvSandbox({ days: undefined, cloud: [cy(7, 0, 30, 30)], cloudKnown: 0 })
  run(sb, 'chLevelBackfill()')
  assert('★ 回填后 challengeState.lv 已同步为 L3', run(sb, 'challengeState.lv') === 3, run(sb, 'challengeState.lv'))
  assert('★ 且 challengeState.chLevel 地板值同步（只升不降）',
    run(sb, 'challengeState.chLevel') === 3, run(sb, 'challengeState.chLevel'))
}

group('组十一：接线 —— chLoadLeaderboard 内真调用 chLevelBackfill')
{
  const board = grabFn(CH, 'chLoadLeaderboard')
  assert('★★ chLoadLeaderboard 内真调用 chLevelBackfill', board.indexOf('chLevelBackfill(') >= 0)
  assert('★★ 调用在 chAbsorbCloudProgress 之后（先喂数据再算）',
    board.indexOf('chAbsorbCloudProgress(') >= 0 &&
    board.indexOf('chAbsorbCloudProgress(') < board.indexOf('chLevelBackfill('))
  assert('★ 调用在 chAbsorbCloudLevel 之后（地板值先就位）',
    board.indexOf('chAbsorbCloudLevel(') < board.indexOf('chLevelBackfill('))
  const abs = grabFn(CH, 'chAbsorbCloudProgress')
  assert('★★ chAbsorbCloudProgress 写入 _chCloudChy（云端全量缓存）',
    abs.indexOf('_chCloudChy =') >= 0)
}

group('组十二：顺序护栏 —— 全部定级函数在 chRecordStage 之上 + function 声明')
{
  const iRecord = CH.indexOf('function chRecordStage(')
  ;['chLevelBench', 'chLevelAcc', 'chLevelOf', 'chLevelCapOfBench', 'chLevel', 'chLevelApply', 'chLevelBackfill'].forEach(n => {
    assert('★ ' + n + ' 定义在 chRecordStage 之前', CH.indexOf('function ' + n + '(') < iRecord)
    // ★ 直接查「存在 function 声明」+「不存在同名 const/let 箭头赋值」——
    //   上一版写了个自造的 slice 表达式，恒为假 → 7 项假红（本项目「期望值要实测回填」同款坑）。
    const hasDecl = new RegExp('(^|\\n)function ' + n + '\\s*\\(').test(CH)
    const noConst = !new RegExp('(^|\\n)(const|let|var)\\s+' + n + '\\s*=').test(codeOnly(CH))
    assert('  ' + n + ' 为 function 声明（非 const/let，防 TDZ）', hasDecl && noConst,
      `hasDecl=${hasDecl} noConst=${noConst}`)
  })
  assert('★★ _chCloudChy 声明为模块级 let（不是 const/var）', /(^|\n)let _chCloudChy = \[\]/.test(CH))
  assert('★★ _chCloudLevelKnown 声明为模块级 let', /(^|\n)let _chCloudLevelKnown = 0/.test(CH))
}

group('组十三：管理后台「重算历史等级」入口')
{
  assert('★ app.js 有 dashRebuildLevels 函数', /function dashRebuildLevels\s*\(/.test(APP))
  const fn = grabFn(APP, 'dashRebuildLevels')
  assert('★★ 只对「确有首答记录」的人写等级（无 total 直接跳过）', fn.indexOf('if (!tq) { skipped++') >= 0)
  assert('★★ 只升不降（云端等级更高则跳过）', fn.indexOf('if (cloudLv >= lv)') >= 0)
  assert('★ 走 chLevelCapOfBench（同一套阈值，绝不重写）',
    fn.indexOf('chLevelCapOfBench') >= 0)
  assert('★ 上报走 Store.reportChallengeLevel', fn.indexOf('reportChallengeLevel') >= 0)
  assert('★ 按钮出现在挑战统计区块（dashLvRebuildBtn）', APP.indexOf('dashLvRebuildBtn') >= 0)
  assert('★ 按钮绑定 dashRebuildLevels()', APP.indexOf('onclick="dashRebuildLevels()"') >= 0)
}

group('组十四：i18n（5 个新键，中英成对且类型一致）')
{
  const keys = ['dashLvRebuildBtn', 'dashLvRebuildHint', 'dashLvRebuildRunning', 'dashLvRebuildDone', 'dashLvRebuildFail']
  const zhPart = I18N.slice(0, I18N.indexOf('  en:'))
  const enPart = I18N.slice(I18N.indexOf('  en:'))
  keys.forEach(k => {
    assert('★ ' + k + ' zh 侧存在', zhPart.indexOf(k + ':') >= 0)
    assert('  ' + k + ' en 侧存在', enPart.indexOf(k + ':') >= 0)
  })
  // ★★ 带参文案必须是箭头函数（t() 只插值函数值）—— dashLvRebuildDone 带 n/s 两个参数
  assert('★★ dashLvRebuildDone 中英均为函数（t() 只插值函数值）',
    /dashLvRebuildDone: \(n, s\) =>/.test(zhPart) && /dashLvRebuildDone: \(n, s\) =>/.test(enPart))
  assert('★★ 无参键必须是字符串（不误写成函数）',
    /dashLvRebuildBtn: '.*'/.test(zhPart) && /dashLvRebuildRunning: '.*'/.test(zhPart))
  assert('★★ 任何新文案都不得用 {0} 占位符写法',
    !/dashLvRebuild[A-Za-z]*: '.*\{[0-9]+\}/.test(zhPart) &&
    !/dashLvRebuild[A-Za-z]*: '.*\{[0-9]+\}/.test(enPart))
}

group('组十五：版本号与站点契约')
{
  const vs = HTML.match(/\?v=(\d+)/g) || []
  assert('★ 版本号 12 处', vs.length === 12, vs.length)
  assert('★ 版本号唯一（全部 180）', vs.every(v => v === '?v=180'), [...new Set(vs)].join(','))
  assert('★ 版本号 >= 180（每发一版必变，写下限不写死）',
    vs.every(v => Number(v.slice(3)) >= 180))
}

console.log('\n============================================================')
console.log(`PASS ${pass} / FAIL ${fail}`)
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  · ' + f)); process.exit(1) }
console.log('ALL PASS  ✅ 全部通过')
