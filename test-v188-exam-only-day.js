// ====== 测试 v188：七天挑战「考试独占一天」新天结构（按营次生效） ======
// 用户口径（2026-10-19）：
//   「不要做 9 天了，只做 7 天，第一天第七天考试」+「从以后的营次生效」+「入口名称仍叫七天挑战」
// 背景（真实现场）：旧结构 Day1/Day7 各有两个环节（10 题热身 + 20 题考试），而管理员打开「期末考试」后
//   考试行会单独给「开始」按钮（v99 提前开放）→ 学员直考、跳过 10 题热身 → 看板 D1/D7 永远是半圆 ◐。
//   实测 r3（标帜第二期）做到 Day7 的 6 人中 0 人满格。
// 新结构：Day1 只有前测 20 题；Day2-6 每日练习 30 题；Day7 只有期末考 20 题 → 一天一个环节 → 打卡只有 ✓/–。
//
// 覆盖点：
//  A. 新结构常量：7 天、1/7 单环节、总题量 190（旧结构 210 一字未改）
//  B. 难度配比：按 day 索引（Day1/Day7 留空行）、Day2-6 各 30 题、均值单调递增、进阶期逐日不低于基础档
//  C. chPlanIsV2 判定：只有营次记录 chPlan:'v2' 才算；缺省/其它值/无营次一律旧结构
//  D. chDays / chTotal / chLastPracticeDay 随营次切换
//  E. 等级门槛：新结构「跑满全程练习」= Day6（写死 7 会让学员永远进不了 L3）
//  F. 看板打卡口径：V2 每天 1 环节 → 结构上不可能出现「半圆」(1)
//  G. cloud-store：_roundsNorm 只放行 'v2'；新建营次自动打标
//  H. i18n：新开场说明中英成对；题量文案接受 total
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}

const elements = {}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {},
    textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
const getEl = id => elements[id] || (elements[id] = mkEl())

const sandbox = {
  localStorage: {
    store: {},
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {
    addEventListener() {}, scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
  },
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  },
  __alerts: [],
  alert(m) { sandbox.__alerts.push(String(m)) },
  confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean,
  AntiCheat: { start() {}, stop() {} },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

const src = f => fs.readFileSync(path.join(__dirname, f), 'utf-8')
vm.runInContext(src('i18n.js'), sandbox)
vm.runInContext(src('bank-data.js'), sandbox)
vm.runInContext(src('store.js'), sandbox)
vm.runInContext(src('challenge.js'), sandbox)
vm.runInContext(src('cloud-store.js'), sandbox)

const run = code => vm.runInContext(code, sandbox)
const appCode = src('app.js')
const chCode = src('challenge.js')
const csCode = src('cloud-store.js')
const I18N = src('i18n.js')
const Store = run('Store')

run(`localStorage.setItem('eq_categories', JSON.stringify(BANK.categories))`)
run(`challengeStageQuestions = function (day, si) {
  return [{ id: 9001, type: 'single', options: ['a', 'b'], answer: [0], difficulty: 1, question: 'V188' }]
}`)
run(`renderChallengeQuiz = function () { window.__r188 = (window.__r188 || 0) + 1 }`)

function setStudent() {
  Store.getSession = () => ({ role: 'student', name: 's1', dept: '饮食部·标帜餐厅' })
  Store.getUser = () => ({ name: 's1', dept: '饮食部·标帜餐厅' })
}
// 喂云端营次：v2=true → 新结构；false → 旧结构（不带 chPlan 字段，与线上 r1–r7 一致）
function feedRound(v2, id) {
  const rid = id || (v2 ? 'r9' : 'r3')
  const r = { id: rid, name: (v2 ? '标帜第三期' : '标帜第二期'), depts: ['dining/sig'], open: true, examOpen: true, startAt: 0, endAt: 0 }
  if (v2) r.chPlan = 'v2'
  run(`CloudSync._chRounds = ${JSON.stringify([r])}`)
  run(`CloudSync._chRoundCurId = '${rid}'`)
  run(`CloudSync._chRoundCurName = '${r.name}'`)
  run(`CloudSync._chOpen = true; CloudSync._chOpenAt = 0; CloudSync._chExamOpen = true; CloudSync._chNoRound = false`)
  run(`CloudSync._chOpenLocked = undefined`)
  run(`CloudSync._chResets = {}; CloudSync._chResetModes = {}`)
}

;(async () => {
  console.log('\n🧪 v188 七天挑战新天结构（Day1/Day7 只考试，按营次生效）')
  setStudent()
  run(`challengeLoad()`)

  // ── A. 结构常量
  console.log('\n1️⃣  A. 新结构常量')
  const v2 = JSON.parse(run('JSON.stringify(CHALLENGE_DAYS_V2)'))
  assert('新结构共 7 天', v2.length === 7, String(v2.length))
  assert('Day1 只有 1 个环节', v2[0].stages.length === 1, JSON.stringify(v2[0]))
  assert('Day1 环节 = 水平测试 20 题', v2[0].stages[0].kind === 'test' && v2[0].stages[0].count === 20, JSON.stringify(v2[0].stages[0]))
  assert('Day2-6 都是单练习 30 题',
    [1, 2, 3, 4, 5].every(i => v2[i].stages.length === 1 && v2[i].stages[0].kind === 'practice' && v2[i].stages[0].count === 30),
    JSON.stringify(v2.slice(1, 6)))
  assert('Day7 只有 1 个环节', v2[6].stages.length === 1, JSON.stringify(v2[6]))
  assert('Day7 环节 = 水平测试 20 题', v2[6].stages[0].kind === 'test' && v2[6].stages[0].count === 20, JSON.stringify(v2[6].stages[0]))
  assert('新结构总题量 = 190', run('CHALLENGE_TOTAL_V2') === 190, run('CHALLENGE_TOTAL_V2'))
  assert('旧结构总题量仍是 210（未改动）', run('CHALLENGE_TOTAL') === 210, run('CHALLENGE_TOTAL'))
  const old7 = JSON.parse(run('JSON.stringify(CHALLENGE_DAYS.find(d => d.day === 7).stages)'))
  assert('旧结构 Day7 仍是「练习 + 考试」两环节（存量营次口径不变）', old7.length === 2 && old7[0].kind === 'practice' && old7[1].kind === 'test', JSON.stringify(old7))

  // ── B. 难度配比
  console.log('\n2️⃣  B. 难度配比')
  const plan = JSON.parse(run('JSON.stringify(CHALLENGE_DIFF_PLAN_V2)'))
  const hard = JSON.parse(run('JSON.stringify(CHALLENGE_DIFF_PLAN_HARD_V2)'))
  const sum = p => p[0] + p[1] + p[2]
  const avg = p => (p[0] * 1 + p[1] * 2 + p[2] * 3) / sum(p)
  assert('配比数组按 day 索引（7 项）', plan.length === 7, String(plan.length))
  assert('Day1 / Day7 是空行 [0,0,0]（当天无练习）',
    sum(plan[0]) === 0 && sum(plan[6]) === 0 && sum(hard[0]) === 0 && sum(hard[6]) === 0,
    JSON.stringify([plan[0], plan[6], hard[0], hard[6]]))
  assert('Day2-6 每天正好 30 题（基础档）', [1, 2, 3, 4, 5].every(i => sum(plan[i]) === 30), JSON.stringify(plan))
  assert('Day2-6 每天正好 30 题（进阶档）', [1, 2, 3, 4, 5].every(i => sum(hard[i]) === 30), JSON.stringify(hard))
  const planAvgs = [1, 2, 3, 4, 5].map(i => avg(plan[i]))
  const hardAvgs = [1, 2, 3, 4, 5].map(i => avg(hard[i]))
  assert('基础档难度逐日递增', planAvgs.every((v, i) => i === 0 || v > planAvgs[i - 1]), JSON.stringify(planAvgs.map(x => x.toFixed(2))))
  assert('进阶档难度逐日递增', hardAvgs.every((v, i) => i === 0 || v > hardAvgs[i - 1]), JSON.stringify(hardAvgs.map(x => x.toFixed(2))))
  assert('进阶档每天都不低于基础档当天', hardAvgs.every((v, i) => v >= planAvgs[i]), JSON.stringify({ hardAvgs, planAvgs }))
  assert('chPlanDayAvg 按天取得到值（Day2 ≈ 1.27）', Math.abs(run('chPlanDayAvg(CHALLENGE_DIFF_PLAN_V2, 2)') - 38 / 30) < 1e-9, run('chPlanDayAvg(CHALLENGE_DIFF_PLAN_V2, 2)'))
  assert('chPlanDayAvg 对 Day1（无练习）返回 0', run('chPlanDayAvg(CHALLENGE_DIFF_PLAN_V2, 1)') === 0)

  // ── C. 营次判定
  console.log('\n3️⃣  C. chPlanIsV2 判定')
  feedRound(false)
  assert('营次无 chPlan 字段 → 旧结构（false）', run('chPlanIsV2()') === false, run('chPlanIsV2()'))
  feedRound(true)
  assert('营次 chPlan=v2 → 新结构（true）', run('chPlanIsV2()') === true, run('chPlanIsV2()'))
  run(`CloudSync._chRounds = [{ id: 'r8', name: 'x', depts: ['dining/sig'], open: true, chPlan: 'v3' }]`)
  run(`CloudSync._chRoundCurId = 'r8'`)
  assert('未知结构值 v3 → 按旧结构处理（保守）', run('chPlanIsV2()') === false, run('chPlanIsV2()'))
  run(`CloudSync._chRounds = undefined; CloudSync._chRounds = []`)
  assert('无营次数据 → 旧结构（false）', run('chPlanIsV2()') === false, run('chPlanIsV2()'))

  // ── D. 访问器
  console.log('\n4️⃣  D. chDays / chTotal / chLastPracticeDay')
  feedRound(false)
  assert('旧营次 → chTotal=210', run('chTotal()') === 210, run('chTotal()'))
  assert('旧营次 → Day1 两个环节', run('chDays().find(d => d.day === 1).stages.length') === 2)
  assert('旧营次 → 最后一个练习日 = 7', run('chLastPracticeDay()') === 7, run('chLastPracticeDay()'))
  feedRound(true)
  assert('新营次 → chTotal=190', run('chTotal()') === 190, run('chTotal()'))
  assert('新营次 → Day1 单个环节', run('chDays().find(d => d.day === 1).stages.length') === 1)
  assert('新营次 → Day7 单个环节', run('chDays().find(d => d.day === 7).stages.length') === 1)
  assert('新营次 → 最后一个练习日 = 6', run('chLastPracticeDay()') === 6, run('chLastPracticeDay()'))
  assert('新营次 → 阶段元数据里 Day1 只有 test', run(`JSON.stringify(challengeStageMeta().filter(m => m.day === 1).map(m => m.kind))`) === '["test"]', run(`JSON.stringify(challengeStageMeta().filter(m => m.day === 1).map(m => m.kind))`))
  assert('新营次 → 练习阶段恰 5 个（Day2-6）', run(`challengeStageMeta().filter(m => m.kind === 'practice').length`) === 5, run(`challengeStageMeta().filter(m => m.kind === 'practice').length`))
  assert('新营次 → 练习切片起点连续（0/30/60/90/120）', run(`JSON.stringify(challengeStageMeta().filter(m => m.kind === 'practice').map(m => m.start))`) === '[0,30,60,90,120]', run(`JSON.stringify(challengeStageMeta().filter(m => m.kind === 'practice').map(m => m.start))`))

  // ── E. 等级门槛
  console.log('\n5️⃣  E. L3 门槛随天结构（不能写死 Day7）')
  feedRound(true)
  assert('新营次：Day6 + 96% → 进 3（不被无谓压回 2）', run('chLevelCapOfBench(2.6, 4, 6, 96)') === 3, run('chLevelCapOfBench(2.6, 4, 6, 96)'))
  assert('新营次：Day5 + 96% → 仍压回 2（没跑满练习日）', run('chLevelCapOfBench(2.6, 4, 5, 96)') === 2, run('chLevelCapOfBench(2.6, 4, 5, 96)'))
  assert('新营次：Day6 + 90% → 压回 2（质量门槛）', run('chLevelCapOfBench(2.6, 4, 6, 90)') === 2, run('chLevelCapOfBench(2.6, 4, 6, 90)'))
  feedRound(false)
  assert('旧营次：Day7 + 96% → 进 3', run('chLevelCapOfBench(2.8, 4, 7, 96)') === 3, run('chLevelCapOfBench(2.8, 4, 7, 96)'))
  assert('旧营次：Day6 + 96% → 仍压回 2', run('chLevelCapOfBench(2.8, 4, 6, 96)') === 2, run('chLevelCapOfBench(2.8, 4, 6, 96)'))

  // ── F. 打卡口径
  console.log('\n6️⃣  F. 打卡口径：V2 结构上不可能出现半圆')
  // 复刻 app.js 的打卡公式：n===0 → 0；n===stageCnt → 2；其它 → 1
  const mkCheckin = (stageCnt, seen) => {
    const out = []
    for (let d = 1; d <= 7; d++) {
      let n = 0
      for (let si = 0; si < stageCnt[d]; si++) if (seen[d + '-' + si]) n++
      out.push(n === 0 ? 0 : n === stageCnt[d] ? 2 : 1)
    }
    return out
  }
  const v2Cnt = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 }
  // 全做 / 全不做 / 只做部分天 —— 都不可能产出 1
  const allDone = {}; for (let d = 1; d <= 7; d++) allDone[d + '-0'] = 1
  assert('V2：全部做完 → 全是 2', mkCheckin(v2Cnt, allDone).every(x => x === 2), JSON.stringify(mkCheckin(v2Cnt, allDone)))
  assert('V2：什么都没做 → 全是 0', mkCheckin(v2Cnt, {}).every(x => x === 0), JSON.stringify(mkCheckin(v2Cnt, {})))
  const partial = { '1-0': 1, '3-0': 1 }
  assert('V2：只做 Day1/Day3 → 只有 2 和 0，永远没有 1（半圆）', mkCheckin(v2Cnt, partial).every(x => x === 0 || x === 2), JSON.stringify(mkCheckin(v2Cnt, partial)))
  const legacyCnt = { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2 }
  assert('旧结构：Day7 只考不做热身 → 仍然是 1（半圆，存量营次如实保留）', mkCheckin(legacyCnt, { '7-1': 1 })[6] === 1, JSON.stringify(mkCheckin(legacyCnt, { '7-1': 1 })))

  // 源码契约：看板按营次取阶段数
  console.log('\n7️⃣  G-1. 看板源码契约')
  assert('app.js 从所选营次取 rdObj', /const rdObj = rdList\.find\(r => r\.id === want\) \|\| \{\}/.test(appCode))
  assert('app.js 用 chPlan === \'v2\' 判定新结构', /const planV2 = !!\(rdObj && rdObj\.chPlan === 'v2'\)/.test(appCode))
  assert('app.js 新结构阶段数全为 1', /\{ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 \}/.test(appCode))
  assert('app.js 旧结构阶段数保持 {1:2,...,7:2}', /\{ 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2 \}/.test(appCode))
  assert('planV2 定义在 stageCnt 之前（作用域正确）', appCode.indexOf("const planV2 = !!(rdObj") < appCode.indexOf('const stageCnt = planV2'), String(appCode.indexOf("const planV2 = !!(rdObj")) + '/' + String(appCode.indexOf('const stageCnt = planV2')))
  assert('营次管理展示「新天结构」徽章', /const planTag = \(r\.chPlan === 'v2'\)/.test(appCode) && /dashRoundPlanV2Tag/.test(I18N))

  // ── G. cloud-store
  console.log('\n8️⃣  G-2. cloud-store 归一与打标')
  const normed = JSON.parse(run(`JSON.stringify(_roundsNorm({ chRounds: [
    { id: 'r9', name: 'A', depts: [], chPlan: 'v2' },
    { id: 'r8', name: 'B', depts: [] },
    { id: 'r7', name: 'C', depts: [], chPlan: 'v3' }
  ] }))`))
  assert('_roundsNorm 保留 chPlan=v2', normed[0].chPlan === 'v2', JSON.stringify(normed[0]))
  assert('_roundsNorm 不给缺字段的营次补默认（存量仍按旧结构）', !('chPlan' in normed[1]), JSON.stringify(normed[1]))
  assert('_roundsNorm 丢弃未知值 v3（不认得就别乱认）', !('chPlan' in normed[2]), JSON.stringify(normed[2]))
  assert('新建营次写入 chPlan:v2', /chPlan: 'v2'/.test(csCode) && /chPlan: 'v2'[\s\S]{0,80}at: manual/.test(csCode), 'push 对象里缺 chPlan')
  assert('新建营次的 chPlan 在这次 push 里（不是别处）', /startAt, endAt,[\s\S]{0,400}chPlan: 'v2'/.test(csCode))

  // ── H. i18n + 渲染
  console.log('\n9️⃣  H. 文案与渲染')
  assert('i18n 中文有 chIntroV2', /chIntroV2: '[^']*第 1 天[^']*第 7 天[^']*'/.test(I18N))
  assert('i18n 英文有 chIntroV2', /chIntroV2: 'Day 1[^']*Day 7[^']*'/.test(I18N))
  assert('chPoolInfo / chProgressQ 接受 total 参数（不再写死 210）',
    /chPoolInfo: \(n, total\)/.test(I18N) && /chProgressQ: \(d, total\)/.test(I18N))
  assert('开场说明按营次选文案', /chPlanIsV2\(\)\) \? 'chIntroV2' : 'chIntro'/.test(chCode))
  feedRound(true)
  const day1Block = run(`chDayBlockHtml({ day: 1, stages: [{ kind: 'test', count: 20 }] })`)
  assert('新营次 Day1 卡片只有 1 个开始入口（不出现练习行）',
    (day1Block.match(/chStartStage\(1,0\)/g) || []).length === 1 && day1Block.indexOf('chStartStage(1,1)') < 0, day1Block.replace(/\s+/g, ' ').slice(0, 220))
  assert('新营次 Day1 卡片不再出现 Day1 的练习标签', day1Block.indexOf(run(`t('chPracticeTag')`)) < 0, day1Block.replace(/\s+/g, ' ').slice(0, 220))
  const intro = run(`t((typeof chPlanIsV2 === 'function' && chPlanIsV2()) ? 'chIntroV2' : 'chIntro')`)
  assert('新营次实际渲染出的是新开场说明', intro.indexOf('当天只有一个环节') >= 0, intro.slice(0, 60))
  feedRound(false)
  const oldIntro = run(`t((typeof chPlanIsV2 === 'function' && chPlanIsV2()) ? 'chIntroV2' : 'chIntro')`)
  assert('旧营次仍渲染旧开场说明（含「巩固练习 10 题」）', oldIntro.indexOf('巩固练习 10 题') >= 0, oldIntro.slice(0, 60))

  console.log('')
  if (testFailed) { console.log('❌ v188 有断言失败'); process.exit(1) }
  console.log('✅ v188 全部通过')
  process.exit(0)          // ★ 必须显式退出：沙箱里的 Promise 链可能留下未释放的 handle
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
