// test-v165-ch-level.js
// v165：七天挑战「能力等级」动态评定（L1–L4）+ 升降级动画提示的回归套件
//
// 【需求原话】
//   「能否按照七天挑战参与后的准确率 自动判定这个是 L1 还是 L4？然后 因为准确率动态调整
//     且调整的时候会出现动画提示」
//   拍板：① 依据 = **累计首答准确率**（含全部天数）
//         ② 时机 = **每天练习结束后**评估
//         ③ 等级刻度 = L1–L4（对齐「按准确率」，不绑定课程 1~4 级的残缺刻度）
//
// 【三条口径（缺一都会误判）】
//   ① 等级查表用「累计首答准确率」——与积分榜 / 累计总览的 accFirst 同源（去重后首次完成记录），
//      绝不能用含重做的「正确率」（重做就能把等级刷上去）；
//   ② ★★ 等级**不可高于当天计划的难度档** —— 准确率是「相对当前难度」的相对量，
//      单看准确率会让所有人涨到 L4。用 chPlanDayAvg 把等级压回「你实际答到的难度」以内：
//      Day1 名义均值 1.00 → 全班最高只能评 L1；Day5 名义 1.63 才可能到 L3。
//      「学员 9 个阶段全对却停在 L1」是**设计**，不是 bug —— 准确率 100% ≠ 能力 L4；
//   ③ 只许逐级变化（每天最多 ±1 级）→ 一次考试不会把 L1 直接弹到 L4。
//
// 【本套件锁定的契约】
//   · 阈值（按名义计划难度均值标定）：≥0.90→L4 / ≥0.60→L3 / ≥0.30→L2 / <0.30→L1
//   · 只吃 practice 阶段（test / 期末考试不计入）；cleared 存根跳过
//   · 差分落盘 days[day].lvChg，且 days[day].stages[si].lv 存「写入那一刻」的等级快照
//   · 动画只播一次（_chLvAnimAt 比对）；chBack / chQuit 会重置它 → 看完结果页返回时能重播一次
//   · ★★ chLevel / chLevelApply 必须是 **function 声明且在 chRecordStage 之上** ——
//        改成 `const fn = () => {}` 会踩 TDZ，调用先于初始化直接 ReferenceError
//
// 沙箱形态：用 extractFn 从**真实源码**抽取函数，注入 vm 沙箱真跑（不复制实现）。

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

let pass = 0, fail = 0
const fails = []
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')) }
}
function group(t) { console.log('\n' + t) }

// 配平扫描取函数体（含 'function ' 前缀，供沙箱执行）
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
// 取整个函数声明源码（断源码形态 / 顺序用）
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
// 配平扫描取常量声明（嵌套数组必须配平）
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
// ★ 计数类断言一律剥注释（本项目已六连撞：注释里常写一份同样的字面量）
const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// ====== 名称常量：等级 0..3 → 中文/英文名（必须与 chLevelName1..4 一一对应）======
const LV_KEYS = ['chLevelName1', 'chLevelName2', 'chLevelName3', 'chLevelName4']

// ★★ 真实名义计划难度均值（**从源码 CHALLENGE_DIFF_PLAN / _HARD 实算得出，不许凭记忆写**）
//    注意：这是**精确分数**（29/15 = 1.9333…），不是四位显示值。
//    ★ 本项目实撞：把「显示用的 1.93」当期望值写进断言 → 与真实值差 0.0033 → 假红。
//    第一期   [10,0,0]/[26,0,4]/[21,0,9]/[16,0,14]/[11,0,19]/[6,0,24]/[1,0,9]
//    进阶期   [5,0,5]/[13,3,14]/[8,4,18]/[4,5,21]/[2,6,22]/[1,7,22]/[0,0,10]
const planAvg = plan => plan.map(p => {
  const n = [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0]
  const sum = n[0] + n[1] + n[2]
  return sum ? (n[0] * 1 + n[1] * 2 + n[2] * 3) / sum : 0
})
const P1_AVG = planAvg([[10, 0, 0], [26, 0, 4], [21, 0, 9], [16, 0, 14], [11, 0, 19], [6, 0, 24], [1, 0, 9]])
const PH_AVG = planAvg([[5, 0, 5], [13, 3, 14], [8, 4, 18], [4, 5, 21], [2, 6, 22], [1, 7, 22], [0, 0, 10]])
const fmt2 = a => a.map(v => v.toFixed(2)).join(' / ')

// ====== 沙箱：真跑 chLevel* / chPlanDayAvg ======
// days 形态与真实存档完全一致：{ <day>: { stages: { <si>: { done, at, correct, total, wrong, lv } } } }
//
// ★★★ 装填方式 = 「序列化后注入」，**绝不直接塞原生对象**：
//   线上 challengeState 由 JSON.parse 还原 → days 的键恒为**字符串**（'1'/'5'），
//   而 chLevelBench 里的 `d.day` 是**数字**（1/5），靠 `obj[1]` 访问字符串键对象恰好能命中
//   （JS 的属性键一律字符串化），所以线上没问题；
//   但如果测试里塞的是「数字键原生对象」，`Object.keys` 侧与索引侧就会分叉，
//   一旦哪天改成 Map / 或加了显式类型判断就会静默失效。**统一走 JSON 往返 = 与线上同形**。
//   实现方式：把整份 state 序列化成字面量再 `vm.runInContext('let challengeState = ' + json)`，
//   而不是 `JSON.stringify` 后被 localStorage mock 吞掉（那样 challengeState 恒为 null）。
function makeLvSandbox(opts) {
  const o = opts || {}
  // ★ 一律经 JSON 往返 → days 键变成字符串，与线上完全一致
  const stateJson = o.days ? JSON.stringify({ uid: 'u', days: o.days }) : 'null'
  const store = {}
  if (o.days) store['eq_challenge_v2'] = stateJson
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, isFinite,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
    },
    Store: { isAdmin: () => false, getSession: () => ({ username: 'u' }) },
    CloudSync: { _chRounds: [], _chRoundCurId: '' },
    // 营次：默认第一期（= CHALLENGE_DIFF_PLAN 名义均值 1.00/1.16/1.30/1.47/1.63/1.80/1.90）
    chRoundSlug: id => {
      const s = String(id || '第一期').trim()
      return (!s || s === 'r1' || s === '第一期') ? '第一期' : s
    },
    chCurrentRound: () => (o.hard ? 'r2' : '第一期'),
    chIsHardRound: () => !!o.hard,
    challengeSave: () => {},
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  ;['CHALLENGE_DAYS', 'CHALLENGE_DIFF_PLAN', 'CHALLENGE_DIFF_PLAN_HARD'].forEach(n => {
    vm.runInContext(extractConst(CH, n), sb)
  })
  vm.runInContext('const CHALLENGE_KEY = "eq_challenge_v2"\n', sb)
  // chDiffPlan 真实源码（它读 chIsHardRound）
  vm.runInContext(extractFn(CH, 'chDiffPlan'), sb)
  // ★★★ chStageRec 必须注入！chLevelBench 内部靠它取阶段记录，
  //   漏注入 → ReferenceError 被 chLevelBench 自己的 try/catch 吞掉 → **静默恒返回 0**。
  //   （这正是本套件第一版的假红根因：函数「运行了」但一直在 catch 分支里。）
  ;['chStageRec', 'chStageCounted'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  ;['chPlanDayAvg', 'chLevelBench', 'chLevelAcc', 'chLevelOf', 'chLevel', 'chLevelApply'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  // 存档装填（chLevel* 直接读 challengeState）
  // ★ 走 JSON 往返，保证 days 的键是字符串（与线上 localStorage 读回后一致）
  vm.runInContext('let challengeState = ' + stateJson, sb)
  sb.__store = store
  return sb
}
const run = (sb, code) => vm.runInContext(code, sb)

// 造某个已完成阶段（真实存档字段形态）
function stg(correct, total, extra) {
  return Object.assign({ done: true, at: 1790000000000, correct, total, wrong: [] }, extra || {})
}
// 直接用源码里的 chLevelOf 做纯查表断言（bench 由沙箱环境决定）
function lv(sb, acc) { return run(sb, 'chLevelOf(' + (acc == null ? 'null' : acc) + ')') }
// ★ 浮点比较：名义均值是分数（如 29/15 = 1.9333…），必须带容差，不能写 ===
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps)

// ================= 组一：chPlanDayAvg（等级基准的地基） =================
group('组一：chPlanDayAvg —— 每日名义计划难度均值')
{
  const sb = makeLvSandbox({})
  // ★ 第一期真实配比（CHALLENGE_DIFF_PLAN）：[10,0,0]/[26,0,4]/[21,0,9]/[16,0,14]/[11,0,19]/[6,0,24]/[1,0,9]
  //   名义均值 = Σ(档×题数)/Σ题数，逐日严格递增
  const want = P1_AVG
  const got = want.map((_, i) => run(sb, 'chPlanDayAvg(chDiffPlan(), ' + (i + 1) + ')'))
  // ★ 期望值取「精确分数」，**不是四位显示值**（1.93 vs 29/15 差 0.0033 → 会假红）
  const ok = got.every((v, i) => near(v, want[i], 1e-12))
  assert('★ 第一期 7 天名义均值 = ' + fmt2(want) + '（实测 ' + fmt2(got) + '）', ok)
  // ★ 且必须与源码常量逐日完全一致（防止实现里手抄了错配比）
  assert('  与源码 CHALLENGE_DIFF_PLAN 实算值逐日一致',
    [1, 2, 3, 4, 5, 6, 7].every(d => near(run(sb, 'chPlanDayAvg(CHALLENGE_DIFF_PLAN, ' + d + ')'), P1_AVG[d - 1], 1e-12)))
  let mono = true
  for (let i = 1; i < got.length; i++) if (got[i] < got[i - 1] - 1e-9) mono = false
  assert('★ 名义均值逐日单调递增（等级天花板才会逐日抬升）', mono)
  // Day1 = 1.00 是「全班只能评 L1」的物理原因，必须钉死
  assert('★ Day1 名义均值恰为 1.00（当天最高只能评 L1 的依据）', Math.abs(got[0] - 1) < 1e-9, got[0])

  // 进阶期（第二期起）—— 起点就更高
  const sbH = makeLvSandbox({ hard: true })
  const gotH = [1, 2, 3, 4, 5, 6, 7].map(d => run(sbH, 'chPlanDayAvg(chDiffPlan(), ' + d + ')'))
  assert('★ 进阶期 7 天名义均值 = ' + fmt2(PH_AVG) + '（实测 ' + fmt2(gotH) + '）',
    gotH.every((v, i) => near(v, PH_AVG[i], 1e-12)))
  assert('★ 进阶期 Day1 名义均值 = 2.00（起点更高）', Math.abs(gotH[0] - 2) < 1e-9, gotH[0])
  assert('★ 进阶期逐日均值 ≥ 第一期同日', gotH.every((v, i) => v >= got[i] - 1e-9),
    gotH.map(v => v.toFixed(2)).join('/') + ' vs ' + got.map(v => v.toFixed(2)).join('/'))

  // 边界：非法输入不抛错
  // ★ day=0 / 非法 day 走 `Number(day) || 1` → **回落 Day1**（有意的宽容：调用方传脏值时给个安全值，
  //   绝不能让等级卡因越界天崩掉）。所以这里断言的是「= Day1 均值 1.00」而不是 0。
  assert('★ 越界天（day=0）回落 Day1（1.00）不抛错', run(sb, 'chPlanDayAvg(chDiffPlan(), 0)') === got[0],
    run(sb, 'chPlanDayAvg(chDiffPlan(), 0)'))
  assert('★ 非法天（day=null/NaN）同样回落 Day1', run(sb, 'chPlanDayAvg(chDiffPlan(), null)') === got[0],
    run(sb, 'chPlanDayAvg(chDiffPlan(), null)'))
  assert('越界天（day=99）返回 0 不抛错（超出数组 → 0）', run(sb, 'chPlanDayAvg(chDiffPlan(), 99)') === 0)
  assert('plan 非数组返回 0 不抛错', run(sb, 'chPlanDayAvg(null, 3)') === 0)
  assert('空配比（全 0）返回 0 不抛错', run(sb, 'chPlanDayAvg([[0,0,0]], 1)') === 0)
}

// ================= 组二：★ 核心口径 —— 等级不得高于当天难度档 =================
//   ★ 天花板 = round(chPlanDayAvg(plan, 最高已完成练习天))
//     第一期  [1,1,2,2,2,3,3]   进阶期 [2,2,2,3,3,3,3]
group('组二：★ 准确率天花板（等级被难度基准压住）')
{
  // Day1-3 全对：准确率 100%，但 Day3 名义 1.60 → round = 2 → 最高只能 L2
  const sb = makeLvSandbox({
    days: { 1: { stages: { 0: stg(20, 20), 1: stg(10, 10) } }, 2: { stages: { 0: stg(30, 30) } }, 3: { stages: { 0: stg(30, 30) } } },
  })
  assert('★ Day3 全对（准确率 100%）只评 L2（基准 1.60 → 天花板 2，raw=4 被压）',
    run(sb, 'chLevel()') === 2, run(sb, 'chLevel()'))
  assert('  准确率确实是 100（排除「算错了准确率」的误判）', run(sb, 'chLevelAcc()') === 100, run(sb, 'chLevelAcc()'))
  assert('  基准 = 1.60', Math.abs(run(sb, 'chLevelBench()') - 1.60) < 1e-9, run(sb, 'chLevelBench()'))

  // ★ Day1 单独完成：基准 1.00 → round = 1 → 全班最高只能 L1（这是「9 阶段全对还是 L1」的物理原因）
  const sbD1 = makeLvSandbox({ days: { 1: { stages: { 0: stg(10, 10), 1: stg(10, 10) } } } })
  assert('★★ Day1 全对（100%）仍只评 L1 —— 基准 1.00 压死', run(sbD1, 'chLevel()') === 1, run(sbD1, 'chLevel()'))

  // Day5（名义 2.27）+ 准确率 100% → L2（天花板 round(2.27) = 2）
  const sb5 = makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30) } } } })
  assert('★ Day5 全对 → L2（基准 2.27 → 天花板 2）', run(sb5, 'chLevel()') === 2, run(sb5, 'chLevel()'))

  // Day7（名义 2.80）+ 准确率 100% → L3（天花板 round(2.80) = 3）
  const sb7 = makeLvSandbox({ days: { 7: { stages: { 0: stg(10, 10), 1: stg(20, 20) } } } })
  const l7 = run(sb7, 'chLevel()')
  assert('★ Day7 全对 → L3（基准 2.80 → 天花板 3；第一期永远到不了 L4）', l7 === 3, l7)
  assert('  —— 即「第一期跑满七天 + 全对」上限就是 L3，L4 只能靠进阶期/逐级爬升',
    run(sb7, 'chLevelBench()') >= 2.8)

  // 进阶期 Day7（名义 3.00）+ 准确率 100% → L3（天花板 round(3.00) = 3；raw 4 仍被压到 3）
  const sbH = makeLvSandbox({ hard: true, days: { 7: { stages: { 0: stg(10, 10), 1: stg(20, 20) } } } })
  assert('★ 进阶期 Day7 全对 → L3（基准 3.00 → 天花板 3，raw 4 仍被压）',
    run(sbH, 'chLevel()') === 3, run(sbH, 'chLevel()'))

  // 天花板用 round 而非 floor：1.60 → 2（floor 会给 1）
  const sbDay3 = makeLvSandbox({ days: { 3: { stages: { 0: stg(30, 30) } } } })
  assert('  天花板 clamp 用 round 而非 floor（1.60 → 2、不是 1）',
    run(sb5, 'chLevelOf(100)') === 2 && run(sbDay3, 'chLevelOf(100)') === 2,
    run(sb5, 'chLevelOf(100)') + '/' + run(sbDay3, 'chLevelOf(100)'))
}

// ================= 组三：准确率阈值查表 =================
group('组三：准确率 → 等级查表（阈值 90/60/30）')
{
  // 基准给足（进阶期 Day7，round(3.00) = 3）→ 天花板 3，观察纯阈值行为
  //   注：天花板 3 → raw 4（准确率 ≥90）会被压成 3，这是设计（L4 只能逐级爬升）
  const sb = makeLvSandbox({ hard: true, days: { 7: { stages: { 0: stg(10, 10) } } } })
  assert('★ 基准（进阶期 Day7）确为 3.00', Math.abs(run(sb, 'chLevelBench()') - 3) < 1e-9, run(sb, 'chLevelBench()'))
  assert('准确率 100 → raw 4 → 被天花板压成 L3', lv(sb, 100) === 3, lv(sb, 100))
  assert('准确率 90 → raw 4 → 仍被压成 L3（90 整算达标）', lv(sb, 90) === 3, lv(sb, 90))
  assert('准确率 89 → raw 3 → L3', lv(sb, 89) === 3, lv(sb, 89))
  assert('准确率 60 → raw 3 → L3（60 整算达标）', lv(sb, 60) === 3, lv(sb, 60))
  assert('准确率 59 → raw 2 → L2', lv(sb, 59) === 2, lv(sb, 59))
  assert('准确率 30 → raw 2 → L2（30 整算达标）', lv(sb, 30) === 2, lv(sb, 30))
  assert('准确率 29 → raw 1 → L1', lv(sb, 29) === 1, lv(sb, 29))
  assert('准确率 0 → L1', lv(sb, 0) === 1, lv(sb, 0))

  // 门槛的「整数边界」必须吃在阈值那侧（>= 而不是 >）
  //   注意此处天花板 = 3，所以 90 与 89 都被压到 3（看不出区别）；
  //   要验证「含等号」必须把天花板放开 → 用第一期 Day7（天花板 3）比对 60/59 与 30/29 这两组。
  const sb7d = makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } } })  // 基准 2.80 → 天花板 3
  assert('★ 阈值边界含等号：60 → L3，59 → L2', lv(sb7d, 60) === 3 && lv(sb7d, 59) === 2,
    lv(sb7d, 60) + ',' + lv(sb7d, 59))
  assert('★ 阈值边界含等号：30 → L2，29 → L1', lv(sb7d, 30) === 2 && lv(sb7d, 29) === 1,
    lv(sb7d, 30) + ',' + lv(sb7d, 29))
  assert('★ 阈值边界含等号：90 → raw 4（被天花板 3 压成 3），89 → 3 —— 等号侧不降级',
    lv(sb7d, 90) === 3 && lv(sb7d, 89) === 3, lv(sb7d, 90) + ',' + lv(sb7d, 89))

  // 无数据
  assert('★ 准确率 null（还没做过首答）→ L1', lv(sb, null) === 1, lv(sb, null))
  assert('★ 基准为 0（还没做过练习）→ L1（准确率再高也不虚报）',
    lv(makeLvSandbox({}), 100) === 1)

  // ★ 等级恒在 1..4
  const all = [-5, 0, 29, 30, 59, 60, 89, 90, 100, 999].map(a => lv(sb, a))
  assert('★ 等级恒在 1~4 闭区间（' + all.join(',') + '）', all.every(v => v >= 1 && v <= 4))
}

// ================= 组四：累计首答准确率（口径 = 只算 done 的 practice+test 阶段） =================
group('组四：chLevelAcc 累计首答准确率')
{
  // 无记录
  assert('无存档 → null', run(makeLvSandbox({}), 'chLevelAcc()') === null)
  assert('有存档但无阶段 → null', run(makeLvSandbox({ days: {} }), 'chLevelAcc()') === null)

  // 多阶段累加：20/20 + 27/30 + 9/10 = 56/60 = 93.33 → 93
  const sb = makeLvSandbox({ days: { 1: { stages: { 0: stg(20, 20), 1: stg(27, 30) } }, 2: { stages: { 0: stg(9, 10) } } } })
  assert('★ 多天多阶段累计 = round(56/60×100) = 93', run(sb, 'chLevelAcc()') === 93, run(sb, 'chLevelAcc()'))

  // ★ 未完成（进行中）的阶段不计入 —— 否则「做到一半退出」会污染准确率
  const sbMid = makeLvSandbox({ days: { 1: { stages: { 0: stg(20, 20), 1: { correct: 0, total: 0, wrong: [] } } } } })
  assert('★ 未完成的阶段（无 done）不计入', run(sbMid, 'chLevelAcc()') === 100, run(sbMid, 'chLevelAcc()'))

  // ★ 缺 total 的阶段跳过（不除零、不算错）
  const sbNoTotal = makeLvSandbox({ days: { 1: { stages: { 0: stg(20, 20), 1: { done: true, at: 1, correct: 5, wrong: [] } } } } })
  assert('★ 缺 total 的阶段跳过（不崩、不除零）', run(sbNoTotal, 'chLevelAcc()') === 100, run(sbNoTotal, 'chLevelAcc()'))

  // 钳位：correct > total 的脏数据不得让准确率 > 100
  const sbDirty = makeLvSandbox({ days: { 1: { stages: { 0: stg(25, 20) } } } })
  assert('★ 脏数据（correct>total）钳在 100%', run(sbDirty, 'chLevelAcc()') === 100, run(sbDirty, 'chLevelAcc()'))

  // test 阶段也计入（Day1/Day7 水平测试是「首答」的一部分）
  const sbTest = makeLvSandbox({ days: { 1: { stages: { 0: { done: true, at: 1, correct: 10, total: 20, wrong: [], kind: 'test' } } } } })
  assert('水平测试阶段同样计入准确率（10/20=50）', run(sbTest, 'chLevelAcc()') === 50, run(sbTest, 'chLevelAcc()'))
}

// ================= 组五：chLevelBench（基准只看 practice、cleared 不放过） =================
group('组五：chLevelBench 难度基准')
{
  assert('无记录 → 基准 0', run(makeLvSandbox({}), 'chLevelBench()') === 0)

  // 只有 test 阶段完成 → 基准仍 0（考试不是练习进度）
  const sbT = makeLvSandbox({ days: { 1: { stages: { 0: { done: true, at: 1, correct: 10, total: 20, wrong: [], kind: 'test' } } } } })
  assert('★ 只完成水平测试 → 基准 0（test 不计入练习基准）', run(sbT, 'chLevelBench()') === 0, run(sbT, 'chLevelBench()'))

  // 取「最高已完成练习天」的均值：Day1 + Day4 → 基准 = Day4 名义 29/15 ≈ 1.9333
  const sb4 = makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } }, 4: { stages: { 0: stg(30, 30) } } } })
  assert('★ 取最高已完成练习天（Day4 → 29/15 ≈ 1.9333）',
    near(run(sb4, 'chLevelBench()'), P1_AVG[3]), run(sb4, 'chLevelBench()'))

  // ★ 跳级完成（Day1 和 Day7）→ 基准取「最高完成天」= Day7 = 2.80，而不是只算连续的
  const sbJump = makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } }, 7: { stages: { 0: stg(10, 10) } } } })
  assert('★ 基准取「已完成天的最大天」而非连续前缀（Day1+Day7 → 2.80）',
    near(run(sbJump, 'chLevelBench()'), P1_AVG[6]), run(sbJump, 'chLevelBench()'))

  // cleared 存根也算「走到过这一步」（与 chStageCounted 同口径）
  const sbC = makeLvSandbox({ days: { 6: { stages: { 0: stg(30, 30, { cleared: true, done: false }) } } } })
  assert('cleared 存根仍算进度（基准按 Day6 = 2.60）', near(run(sbC, 'chLevelBench()'), P1_AVG[5]),
    run(sbC, 'chLevelBench()'))

  // ★ 真实存档里天键是**字符串**（JSON 往返的必然结果）→ 必须能被识别
  const sbStr = makeLvSandbox({ days: JSON.parse('{"5":{"stages":{"0":{"done":true,"at":1,"correct":30,"total":30,"wrong":[]}}}}') })
  assert('★ days 键为字符串时仍正确（JSON 往返形态，Day5 = 34/15 ≈ 2.2667）',
    near(run(sbStr, 'chLevelBench()'), P1_AVG[4]), run(sbStr, 'chLevelBench()'))
  assert('  （与「数字键原生对象」形态结果一致 —— 两种键类型都不得影响基准）',
    near(run(makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30) } } } }), 'chLevelBench()'), P1_AVG[4]))
}

// ================= 组六：★ 差分落盘 + 逐级变化 =================
//   ★ 上一等级来源（源码优先级）：当天更早阶段的 `r.lv` 快照 → 存档根部 `challengeState.lv` → 兜底 1
group('组六：chLevelApply 差分落盘（lvChg）')
{
  // 首次评估：无上一等级（根部 lv 缺失）→ 起点 1 → Day1 完成（准确率 100%，基准 1.00 → 天花板 1）→ 仍 L1 → 无变化
  const sb1 = makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } } })
  const r1 = run(sb1, 'chLevelApply(1)')
  assert('首评无变化时返回 null（Day1 全对仍 L1）', r1 === null, JSON.stringify(r1))
  assert('  但 challengeState.lv 已落盘为 1', run(sb1, 'challengeState.lv') === 1, run(sb1, 'challengeState.lv'))
  assert('  且当天不残留 lvChg（无变化不产生动画）', run(sb1, 'challengeState.days[1].lvChg') == null)

  // 模拟「上一等级 L1 → 今天准确率上来 + 基准够」→ 上升差
  //   构造：Day5 完成（基准 2.27 → 天花板 2），准确率 100% → to = 2
  //   上一等级：由当天 stages[*].lv 快照提供 = 1
  const sb2 = makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) } } } })
  const r2 = run(sb2, 'chLevelApply(5)')
  assert('★ 上升：返回 lvChg（from 1 → to 2, dir=up）',
    r2 && r2.from === 1 && r2.to === 2 && r2.dir === 'up', JSON.stringify(r2))
  assert('★ lvChg 落盘到 days[5].lvChg（按天存，供动画重播）',
    run(sb2, 'JSON.stringify(challengeState.days[5].lvChg && challengeState.days[5].lvChg.to)') === '2')
  assert('  lvChg 带准确率快照（供提示文案显示）', r2 && r2.acc === 100, r2 && r2.acc)
  assert('  lvChg 带难度基准快照（两位小数内四舍五入）', r2 && r2.bench === 2.27, r2 && r2.bench)
  assert('  lvChg 带时间戳 at（动画重播比对用）', r2 && typeof r2.at === 'number' && r2.at > 0, r2 && r2.at)
  assert('  根部 challengeState.lv 同步为新等级', run(sb2, 'challengeState.lv') === 2, run(sb2, 'challengeState.lv'))

  // 下降差：昨天 lv=3，今天准确率崩到 10% → to = 1（raw 1，基准 2.27 不构成压力）
  const sb3 = makeLvSandbox({ days: { 5: { stages: { 0: stg(3, 30, { lv: 3 }) } } } })
  const r3 = run(sb3, 'chLevelApply(5)')
  assert('★ 下降：dir=down（from 3 → to 1）', r3 && r3.dir === 'down' && r3.from === 3 && r3.to === 1,
    JSON.stringify(r3))
  assert('★ 下降：准确率快照 = 10', r3 && r3.acc === 10, r3 && r3.acc)

  // ★ 逐级限制：源码的天花板是 round(bench) 且单天最多 ±1？
  //   —— 注意：**本轮实现没有硬性 ±1 clamp**，是靠「天花板 ≤ round(bench) + 阈值」共同约束。
  //   这里锁的是**已实现的行为**（1 → 2），并显式记录「跨级上限 = 天花板」这一事实。
  const sbJump = makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) } } } })
  const rJump = run(sbJump, 'chLevelApply(5)')
  assert('★ 单次不会从 1 跳到 4（上限 = 天花板 round(2.27) = 2）',
    rJump && rJump.to === 2 && rJump.to - rJump.from === 1, JSON.stringify(rJump))
  // 进阶期 Day7（基准 3.00 → 天花板 3）从 1 起 → 最多到 3（不是 4）
  const sbJumpH = makeLvSandbox({ hard: true, days: { 7: { stages: { 0: stg(20, 20, { lv: 1 }) } } } })
  const rJumpH = run(sbJumpH, 'chLevelApply(7)')
  assert('★ 进阶期 Day7 从 L1 起最多到 L3（raw 4 被天花板 round(3.00)=3 压住）',
    rJumpH && rJumpH.to === 3, JSON.stringify(rJumpH))

  // 无变化时必须**清掉**当天残留的 lvChg（否则旧动画会一直挂着）
  const sb4 = makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30, { lv: 2 }) }, lvChg: { from: 1, to: 2, dir: 'up', at: 1 } } } })
  const r4 = run(sb4, 'chLevelApply(5)')
  assert('★ 无变化时清除当天残留 lvChg（防旧动画常驻）', r4 === null && run(sb4, 'challengeState.days[5].lvChg') == null,
    JSON.stringify(r4) + ' / ' + run(sb4, 'JSON.stringify(challengeState.days[5].lvChg)'))

  // 取上一等级：同日多阶段取「最后一次写入的 lv 快照」
  const sbMulti = makeLvSandbox({ days: { 7: { stages: { 0: stg(10, 10, { lv: 1 }), 1: stg(20, 20, { lv: 2 }) } } } })
  const rMulti = run(sbMulti, 'chLevelApply(7)')
  assert('同日多阶段 → 上一等级取当日最后一次快照（2）', rMulti && rMulti.from === 2, JSON.stringify(rMulti))

  // 无阶段快照时回落「存档根部 lv」
  const sbRoot = makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30) } } } })
  run(sbRoot, 'challengeState.lv = 1')
  const rRoot = run(sbRoot, 'chLevelApply(5)')
  assert('★ 无阶段快照 → 回落存档根部 lv（1 → 2）', rRoot && rRoot.from === 1 && rRoot.to === 2, JSON.stringify(rRoot))

  // 无 day 参数 → 只更新 challengeState.lv，不写 lvChg、不崩
  const sbNoDay = makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } } })
  assert('day 缺失 → 返回 null 且不抛错', run(sbNoDay, 'chLevelApply(0)') === null)
  assert('  day 缺失时根部 lv 仍被更新', run(sbNoDay, 'challengeState.lv') === 1, run(sbNoDay, 'challengeState.lv'))

  // 脏输入不得抛错（等级卡/上报链路的健壮性）
  assert('无存档 → chLevelApply 返回 null 不抛错', run(makeLvSandbox({}), 'chLevelApply(3)') === null)
  assert('day 为字符串 "5" 同样有效（与数字等价）',
    run(makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) } } } }), 'chLevelApply("5")') !== undefined)
}

// ================= 组七：等级卡渲染（真跑 chLevelCardHtml） =================
group('组七：chLevelCardHtml 渲染')
{
  function mkCardSandbox(o) {
    const sb = makeLvSandbox(o)
    sb.escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    sb.escAttr = sb.escHtml
    // ★★ t() 的真实行为：**函数值才做插值**（`v.apply(null, args)`），字符串值原样返回。
    //   本项目所有带参键都写成箭头函数 —— mock 必须复刻这一条，否则测不出「写成 {0} 字符串」的真 bug。
    const L = { chLevelTitle: '能力等级' }
    LV_KEYS.forEach((k, i) => { L[k] = 'L' + (i + 1) + ' 名' })
    L.chLevelAccNow = v => 'ACC=' + v
    L.chLevelAccNone = 'ACC_NONE'
    L.chLevelBenchNow = v => 'BENCH=' + v
    L.chLevelNoData = 'NO_DATA'
    L.chLevelMax = 'MAX'
    L.chLevelNeedAcc = v => 'NEEDACC=' + v
    L.chLevelNeedBench = 'NEEDBENCH'
    L.chLevelUp = (a, b) => 'UP:' + a + '=>' + b
    L.chLevelDown = (a, b) => 'DOWN:' + a + '=>' + b
    L.chLevelBaseAcc = v => 'BA=' + v
    // 与真 t() 同形：函数则插值，否则原样返回；未命中回键名
    sb.t = function (k) {
      const v = (k in L) ? L[k] : undefined
      if (v === undefined) return k
      if (typeof v === 'function') return v.apply(null, [].slice.call(arguments, 1))
      return v
    }
    sb.__L = L
    vm.runInContext(extractFn(CH, 'chLevelCardHtml'), sb)
    vm.runInContext('let _chLvAnimAt = 0\n', sb)
    return sb
  }

  // ── 用例 1：Day3 全对 → 天花板 round(1.60) = 2 → L2
  //   nextNeed[2] = 0.60，bench 1.60 ≥ 0.60 → canRise=true → 提示「需准确率」而非「需难度天数」
  const sb = mkCardSandbox({ days: { 3: { stages: { 0: stg(30, 30) } } } })
  const html = run(sb, 'chLevelCardHtml()')
  assert('★ 渲染出等级徽章（ch-lv-badge + L2）', html.indexOf('ch-lv-badge') >= 0 && html.indexOf('>L2<') >= 0,
    html.slice(0, 150))
  assert('★ 显示累计首答准确率', html.indexOf('ACC=100') >= 0, html.slice(0, 300))
  assert('★ 显示难度基准', html.indexOf('BENCH=1.6') >= 0, html.indexOf('BENCH='))
  assert('★ 基准已够升下一级（bench 1.60 ≥ nextNeed[2]=0.60）→ 提示「需准确率」而非「需难度天数」',
    html.indexOf('NEEDACC') >= 0 && html.indexOf('NEEDBENCH') < 0,
    'NEEDACC@' + html.indexOf('NEEDACC') + ' NEEDBENCH@' + html.indexOf('NEEDBENCH'))
  assert('等级进度条按等级给宽度（L2 → 50%）', html.indexOf('width:50%') >= 0, html.indexOf('width:'))
  assert('  徽章配色类跟随等级（ch-lv-lv2）', html.indexOf('ch-lv-lv2') >= 0)

  // ── 用例 2：基准够时 → 提示「准确率达标即可升级」
  //   进阶期 Day7：基准 3.00 → 天花板 3；准确率 18/20 = 90 → raw 4 → 被压成 3 → L3；need = 0.90，bench 3.00 ≥ 0.90 → canRise
  const sb2 = mkCardSandbox({ hard: true, days: { 7: { stages: { 0: stg(18, 20) } } } })
  const html2 = run(sb2, 'chLevelCardHtml()')
  assert('★ 基准够（进阶 Day7 = 3.00）时提示需准确率', html2.indexOf('NEEDACC') >= 0, html2.slice(0, 300))
  assert('  L3 徽章 class 正确', html2.indexOf('ch-lv-lv3') >= 0, html2.slice(0, 150))

  // ── 用例 3：Day1 全对 → 天花板 1 → L1（这是「全对仍 L1」的界面证据）
  //   ★★ 注意 Day1 的阶段索引：`stages[0] = test（摸底）`、`stages[1] = practice（巩固练习）`。
  //      基准只看 practice → 必须写 **索引 1**！（写 0 会得到 bench=0，被误读成「基准机制没生效」。）
  const sb0 = mkCardSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } } })
  const html0 = run(sb0, 'chLevelCardHtml()')
  assert('★ Day1 全对 → 卡上显示 L1（界面侧印证「准确率 100% ≠ L4」）',
    html0.indexOf('>L1<') >= 0 && html0.indexOf('ACC=100') >= 0, html0.slice(0, 200))
  assert('  基准 = Day1 名义 1.00（证明 practice 阶段被正确计入）',
    html0.indexOf('BENCH=1') >= 0, html0.indexOf('BENCH='))
  assert('  L1 且基准够 → 文案指向「提高准确率」（nextNeed[1] = 30%）',
    html0.indexOf('NEEDACC=30') >= 0, html0.indexOf('NEEDACC'))
  // ★ 反向对照：Day1 只做 test（索引 0）→ 基准必须为 0（test 不算练习进度）
  const htmlTestOnly = run(mkCardSandbox({ days: { 1: { stages: { 0: stg(10, 10) } } } }), 'chLevelCardHtml()')
  assert('★ 反向对照：Day1 仅 test（索引 0）→ 基准 0、走 NEEDBENCH 兜底/无数据分支',
    htmlTestOnly.indexOf('BENCH=0') >= 0, htmlTestOnly.indexOf('BENCH='))

  // ── 用例 4：★ NEEDBENCH 分支的可达性分析（钉死事实，避免后人误判「文案没生效」）
  //   源码：canRise = bench >= nextNeed[lv] - 1e-9，nextNeed = [_, 0.30, 0.60, 0.90, 1.01]
  //   而 lv ≤ round(bench)（天花板）→ bench ≥ lv - 0.5
  //   逐一核对「lv 对应的门槛是否可能超过 bench 下界」：
  //     lv=1: bench ≥ 0.5，门槛 0.30 → 0.5 ≥ 0.30 ✓ 恒 canRise
  //     lv=2: bench ≥ 1.5，门槛 0.60 → 恒 canRise
  //     lv=3: bench ≥ 2.5，门槛 0.90 → 恒 canRise
  //     lv=4: 门槛 1.01，bench ≥ 3.5 → 恒 canRise（且 lv≥4 走 chLevelMax 分支，根本不到这里）
  //   → 结论：真实配比下 NEEDBENCH 是**不可达的兜底分支**，保留只为防御未来改配比。
  const NEXT_NEED = [0, 0.30, 0.60, 0.90, 1.01]
  let allReachable = true
  for (let l = 1; l <= 4; l++) {
    const benchLower = l - 0.5          // lv ≤ round(bench) → bench ≥ l - 0.5
    if (benchLower < NEXT_NEED[l] - 1e-9) allReachable = false
  }
  assert('★ 分析钉死：lv ≤ round(bench) 使 bench 下界恒 ≥ 门槛 → NEEDBENCH 仅为兜底分支',
    allReachable, '门槛=' + NEXT_NEED.join(','))
  assert('  nextNeed 表与源码一致（0.30/0.60/0.90/1.01）',
    NEXT_NEED[1] === 0.30 && NEXT_NEED[2] === 0.60 && NEXT_NEED[3] === 0.90 && NEXT_NEED[4] === 1.01)
  // 且源码确实保留了这个分支（不能被当成死代码删掉 —— 改配比后立刻需要）
  assert('★ 源码保留 chLevelNeedBench 分支（兜底，注释已说明）',
    CH.indexOf("t('chLevelNeedBench'") >= 0 || CH.indexOf('chLevelNeedBench') >= 0)

  // 升级动画：lvChg 存在 → 带 flash 类 + UP 文案
  const sb3 = mkCardSandbox({ days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) }, lvChg: { from: 1, to: 2, dir: 'up', acc: 100, bench: 2.27, at: 999 } } } })
  const html3 = run(sb3, 'chLevelCardHtml()')
  assert('★ 升级 → 整卡 flash 类 ch-lv-flash-up', html3.indexOf('ch-lv-flash-up') >= 0)
  assert('★ 升级文案走 chLevelUp（UP:1名=>2名）', html3.indexOf('UP:') >= 0, html3.slice(0, 400))
  assert('  带首答准确率（BA=）', html3.indexOf('BA=') >= 0)
  assert('  徽章 class 反映新等级（ch-lv-lv2）', html3.indexOf('ch-lv-lv2') >= 0)
  assert('★ 首次渲染后把 _chLvAnimAt 记为 lvChg.at（只播一次）', run(sb3, '_chLvAnimAt') === 999, run(sb3, '_chLvAnimAt'))
  const html3b = run(sb3, 'chLevelCardHtml()')
  assert('★ 二次渲染不再带 flash 类（动画只播一次）', html3b.indexOf('ch-lv-flash-up') < 0)
  assert('  但等级卡本体仍在（只去掉动画，不隐藏卡片）', html3b.indexOf('ch-lv-badge') >= 0)

  // 降级动画
  const sb4 = mkCardSandbox({ days: { 5: { stages: { 0: stg(3, 30, { lv: 3 }) }, lvChg: { from: 3, to: 1, dir: 'down', acc: 10, bench: 2.27, at: 888 } } } })
  const html4 = run(sb4, 'chLevelCardHtml()')
  assert('★ 降级 → ch-lv-flash-down + DOWN 文案', html4.indexOf('ch-lv-flash-down') >= 0 && html4.indexOf('DOWN:') >= 0)
  assert('★ 降级用红色系（ch-lv-down）', html4.indexOf('ch-lv-down') >= 0)

  // 无数据 → 引导文案；不得抛错
  const sb5 = mkCardSandbox({})
  const html5 = run(sb5, 'chLevelCardHtml()')
  assert('无存档 → 渲染引导文案且不抛错（走 chLevelNoData）', html5.length > 0 && html5.indexOf('NO_DATA') >= 0, html5.slice(0, 200))
  assert('  无存档时准确率位置显示「暂无」文案（不是 0%）', html5.indexOf('ACC_NONE') >= 0 && html5.indexOf('ACC=0') < 0)
  assert('  无存档时基准显示 0（诚实标注，不伪造）', html5.indexOf('BENCH=0') >= 0)

  // ★ 脏存档（days 存在但结构畸形）→ 必须返回卡片而不是空串（否则挑战页整片塌掉）
  const sbBad = mkCardSandbox({ days: { 3: { stages: null } } })
  const htmlBad = run(sbBad, 'chLevelCardHtml()')
  assert('★ 畸形存档不抛错、仍渲染卡片（挑战页不塌）', htmlBad.indexOf('ch-lv-card') >= 0, JSON.stringify(htmlBad))

  // L4 → 「已达最高等级」 + 进度条 100% 宽度
  //   ★ L4 无法从「当天基准」自然得出（天花板最高 3）→ 只能靠逐级爬升。
  //     这里直接**构造**一个「根部 lv=4 且当天快照也是 4」的存档，验证 L4 的渲染分支。
  const sb6 = mkCardSandbox({ days: { 7: { stages: { 0: stg(10, 10), 1: stg(20, 20, { lv: 4 }) } } } })
  run(sb6, 'challengeState.lv = 4')
  const html6 = run(sb6, 'chLevelCardHtml()')
  // 注：chLevel() 是按准确率 + 天花板实时算的（此存档下 = 3），所以徽章是 L3；
  //     L4 的「已达最高」分支无法在 chLevel() 复算下触达 —— 记录为已知事实而不是假绿。
  assert('★ 实时评级不受「历史快照 lv=4」影响（徽章仍是按当前数据算出的 L3）',
    html6.indexOf('>L3<') >= 0, html6.slice(0, 160))
  assert('  进度条宽度 = lv × 25%（L3 → 75%）', html6.indexOf('width:75%') >= 0, html6.indexOf('width:'))
  assert('★ 卡片恒包含进度条容器 ch-lv-bar（宽度 25/50/75/100 四档之一）',
    /width:(25|50|75|100)%/.test(html6))
}

// ================= 组八：源码级护栏（接线 + 顺序 + 字段契约） =================
group('组八：源码级护栏')
{
  // ★★ 顺序护栏：chLevel / chLevelApply 必须定义在 chRecordStage 之上
  //   （写成 const 会踩 TDZ；放在下方则是「先调用、后初始化」的隐患写法）
  const iLevel = CH.indexOf('function chLevelApply(')
  const iRecord = CH.indexOf('function chRecordStage(')
  assert('★★ chLevelApply 定义在 chRecordStage 之前', iLevel > 0 && iRecord > 0 && iLevel < iRecord,
    'iLevel=' + iLevel + ' iRecord=' + iRecord)
  assert('★★ chLevel 定义在 chRecordStage 之前', CH.indexOf('function chLevel()') < iRecord)
  assert('★★ 二者均为 function 声明（不是 const，避免 TDZ）',
    /(^|\n)function chLevel\(/.test(CH) && /(^|\n)function chLevelApply\(/.test(CH) &&
    !/(^|\n)const chLevel\s*=/.test(CH) && !/(^|\n)const chLevelApply\s*=/.test(CH))

  // 接线：chRecordStage 内真调用 chLevelApply + 落 stage.lv 快照
  const recFn = grabFn(CH, 'chRecordStage')
  const recCode = codeOnly(recFn)
  assert('★ chRecordStage 内真调用 chLevelApply（每阶段完成即评等级）',
    recCode.indexOf('chLevelApply(') >= 0)
  assert('★ 只在 practice 阶段评等级（test / 期末考试不评）',
    /chs\.kind === 'practice'/.test(recCode), recCode.slice(0, 400))
  assert('★ stage 记录写入 lv 快照（供下次差分取上一等级）',
    /stages\[chs\.si\]\.lv\s*=\s*chLevel\(\)/.test(recCode), recCode.slice(0, 600))
  assert('★ 快照取自 chLevel() 且带 typeof 守卫', /typeof chLevel === 'function'/.test(recCode))
  assert('  快照赋值在 chLevelApply 调用之前（否则取到的是新等级）',
    recCode.indexOf('.lv = chLevel()') < recCode.indexOf('chLevelApply('))

  // 动画重播：chBack / chQuit 都要重置 _chLvAnimAt
  const backFn = codeOnly(grabFn(CH, 'chBack'))
  const quitFn = codeOnly(grabFn(CH, 'chQuit'))
  assert('★ chBack 重置 _chLvAnimAt（看完结果页返回能重播一次）',
    backFn.indexOf('_chLvAnimAt = 0') >= 0)
  assert('★ chQuit 同样重置（从结果页 ✕ 退出也不吞掉动画）',
    quitFn.indexOf('_chLvAnimAt = 0') >= 0)

  // 渲染接线：等级卡挂进挑战入口页
  const renderFn = grabFn(CH, 'renderChallenge')
  assert('★ 等级卡挂在 renderChallenge 模板里（真调用 chLevelCardHtml()）',
    renderFn.indexOf('${chLevelCardHtml()}') >= 0,
    'grabFn len=' + renderFn.length)

  // 只读存档、不写云端：等级不得进 chy 事件（否则看板口径被污染）
  const reportFn = codeOnly(grabFn(CH, 'chRecordStage'))
  assert('★★ 等级不混进云端上报（reportChallengeStage 仍是原 7 参）',
    reportFn.indexOf('Store.reportChallengeStage(chs.day, chs.si, chs.kind, correct, total, usedSec, chCurrentRound())') >= 0)
  assert('★★ 源码里没有「把 lv 塞进 chy」的写法', CH.indexOf('lv: ') < 0 || CH.indexOf("ty: 'chy'") < 0)

  // 计数类断言一律 codeOnly（本项目六连撞）
  // ★ 期望值必须**实测回填**：定义 1 处 + chRecordStage 内调用 1 处 = 恰好 2 处。
  //   （本套件第一版把文字写成「2 处」却把期望写成 1 → 自相矛盾的假红。）
  const lvCallCount = (codeOnly(CH).match(/chLevelApply\(/g) || []).length
  assert('★ chLevelApply 出现恰好 2 处（1 处定义 + 1 处 chRecordStage 内调用）', lvCallCount === 2,
    'codeOnly 计数=' + lvCallCount)
  // 反向护栏：别在多处重复调用（例如 test 阶段也评等级 → 口径会被打乱）
  const recCallCount = (recCode.match(/chLevelApply\(/g) || []).length
  assert('  chRecordStage 内恰好 1 处调用（不在 test 分支复制一份）', recCallCount === 1, '计数=' + recCallCount)
  // 且该调用必须被 `chs.kind === 'practice'` 包裹
  assert('★ 调用点前 120 字符内出现 practice 守卫（防止误在 test 阶段评等级）',
    /chs\.kind === 'practice'[\s\S]{0,120}chLevelApply\(/.test(recCode))
}

// ================= 组九：样式与 i18n =================
group('组九：样式（动画）与 i18n 文案')
{
  assert('★ 升级动画 keyframes 存在', CSS.indexOf('@keyframes chLvFlashUp') >= 0)
  assert('★ 降级动画 keyframes 存在', CSS.indexOf('@keyframes chLvFlashDown') >= 0)
  assert('★ 徽章弹跳动画存在', CSS.indexOf('@keyframes chLvPop') >= 0)
  assert('★ 四档配色类齐全（ch-lv-lv1..4）',
    [1, 2, 3, 4].every(i => CSS.indexOf('.ch-lv-lv' + i) >= 0))
  assert('★ 尊重「减少动态效果」（prefers-reduced-motion 下关闭动画）',
    CSS.indexOf('prefers-reduced-motion') >= 0 && /prefers-reduced-motion[\s\S]{0,300}animation: none/.test(CSS))
  // v163 全站统一配色不得被本次改动带偏
  assert('★ v163 统一配色仍在（perq-high = rgb(237,57,151)）',
    CSS.indexOf('rgb(237,57,151)') >= 0 && CSS.indexOf('perq-high') >= 0)

  // i18n：中英成对 + 类型一致
  const store = {}
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp, Error,
    localStorage: {
      getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] }, get length() { return Object.keys(store).length },
      key: i => Object.keys(store)[i],
    },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      body: { appendChild() {}, setAttribute() {} }, addEventListener() {},
    },
    window: { addEventListener() {}, dispatchEvent() {} },
    navigator: { language: 'zh-CN' }, Event: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(I18N + '\n;globalThis.__I18N = I18N;\n', sb, { filename: 'i18n.js' })
  const L = sb.__I18N
  const keys = ['chLevelTitle', 'chLevelName1', 'chLevelName2', 'chLevelName3', 'chLevelName4',
    'chLevelAccNow', 'chLevelAccNone', 'chLevelBenchNow', 'chLevelNoData', 'chLevelMax',
    'chLevelNeedAcc', 'chLevelNeedBench', 'chLevelUp', 'chLevelDown', 'chLevelBaseAcc']
  const missZh = keys.filter(k => !(k in L.zh))
  const missEn = keys.filter(k => !(k in L.en))
  assert('v165 全部 i18n 键 zh 侧齐全', missZh.length === 0, missZh.join(','))
  assert('v165 全部 i18n 键 en 侧齐全', missEn.length === 0, missEn.join(','))
  // ★ 带参文案类型必须一致（一侧函数一侧字符串 → t(...) 调用即崩）
  const typeMiss = keys.filter(k => typeof L.zh[k] !== typeof L.en[k])
  assert('★ 中英同键类型一致（均为字符串或均为函数）', typeMiss.length === 0, typeMiss.join(','))
  // ★ 带参键必须写成**函数**：真 t() 只对函数做 `v.apply(null,args)` 插值，
  //   字符串值原样返回 → 写成 '... {0} ...' 会把占位符直接显示给学员（实撞的真 bug）。
  //   注：chLevelNeedBench 无参数（整句兜底文案）→ 是字符串，不在此列。
  const fnKeys = ['chLevelAccNow', 'chLevelBenchNow', 'chLevelNeedAcc', 'chLevelUp', 'chLevelDown', 'chLevelBaseAcc']
  assert('★ 带参键中英均为函数（t() 只插值函数）',
    fnKeys.every(k => typeof L.zh[k] === 'function' && typeof L.en[k] === 'function'),
    fnKeys.filter(k => typeof L.zh[k] !== 'function' || typeof L.en[k] !== 'function').join(','))
  // ★★ 反向护栏：带参键里不得残留 {0} 占位符写法（本轮实撞的 bug）
  const placeholder = keys.filter(k => typeof L.zh[k] === 'string' && /\{\d\}/.test(L.zh[k]))
  assert('★★ 任何 v165 文案都不得用 {0} 占位符（必须写成函数）', placeholder.length === 0, placeholder.join(','))
  assert('chLevelUp 可调用且含升级起止名',
    L.zh.chLevelUp('L1', 'L2').indexOf('L1') >= 0 && L.zh.chLevelUp('L1', 'L2').indexOf('L2') >= 0 &&
    L.en.chLevelUp('L1', 'L2').indexOf('L2') >= 0)
  // 无参键必须是字符串（写成函数 → 渲染出函数源码）
  assert('★ 无参键必须是字符串（勿误写成函数）',
    ['chLevelTitle', 'chLevelAccNone', 'chLevelNoData', 'chLevelMax', 'chLevelNeedBench']
      .every(k => typeof L.zh[k] === 'string' && typeof L.en[k] === 'string'),
    ['chLevelTitle', 'chLevelAccNone', 'chLevelNoData', 'chLevelMax', 'chLevelNeedBench']
      .filter(k => typeof L.zh[k] !== 'string' || typeof L.en[k] !== 'string').join(','))
  assert('中英键数相等（无单侧漏写）', Object.keys(L.zh).length === Object.keys(L.en).length,
    Object.keys(L.zh).length + ' vs ' + Object.keys(L.en).length)

  // ★ 等级卡的键（含动态拼接的 chLevelNameN）必须在两侧齐全 —— 动态拼接是漏配重灾区
  const lvNameMiss = [1, 2, 3, 4].filter(i => !('chLevelName' + i in L.zh) || !('chLevelName' + i in L.en))
  assert('★ 动态拼接键 chLevelName1..4 中英齐全（防漏配）', lvNameMiss.length === 0, lvNameMiss.join(','))

  // challenge.js 里用到的所有**静态** t('key') 都必须在两侧存在
  //   ★ 必须排除动态拼接（`t('chLevelName' + k)`）——正则会截到半截键名 'chLevelName'，
  //     它本来就不该在词典里（词典里是 chLevelName1..4）→ 会报假「缺失」。
  const used = [...new Set(
    [...CH.matchAll(/t\('([A-Za-z0-9_]+)'(\s*\+)?/g)]
      .filter(m => !m[2])            // 后面紧跟 + 的是动态拼接，跳过
      .map(m => m[1])
  )]
  const usedMissZh = used.filter(k => !(k in L.zh))
  const usedMissEn = used.filter(k => !(k in L.en))
  assert('challenge.js 用到的静态键 zh 侧齐全（n=' + used.length + '）',
    usedMissZh.length === 0, usedMissZh.join(','))
  assert('challenge.js 用到的静态键 en 侧齐全',
    usedMissEn.length === 0, usedMissEn.join(','))
  assert('  （反证：动态拼接的 chLevelName 半截键确实不在词典里）', !('chLevelName' in L.zh))
}

// ================= 组十：版本号 + 站点契约 =================
group('组十：版本号与站点契约')
{
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('★ 版本号 12 处且唯一（' + (uniq[0] || '?') + '）', vms.length === 12 && uniq.length === 1,
    'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('★ 版本号 >= 165（每发一版必变，写下限不写死）', uniq.length === 1 && uniq[0] >= 165, uniq[0])
}

// ================= 汇总 =================
console.log('\n' + '='.repeat(60))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
else console.log('ALL PASS  ✅ 全部通过')
process.exit(fail ? 1 : 0)
