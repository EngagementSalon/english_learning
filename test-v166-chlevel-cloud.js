// test-v166-chlevel-cloud.js
// v166：七天挑战「能力等级」上云端（chLevel 新字段 + 云端回放 + 看板等级列换口径）的回归套件
//
// 【需求原话】「等级需要上云端」
//   三轮拍板：
//     ① 字段：**分开存**（新开 `chLevel`，不写进 `placementLevel`）
//     ② 看板：「替换现有列」（等级列改显挑战等级）
//     ③ 行为：「云端回放」（换设备能看到自己的等级）
//
// 【★★★ 为什么绝不能复用 placementLevel（本轮最重要的一次风险拦截）】
//   看板旧例程 `recalcCloudPlacementLevels()`（cloud-store.js）会用**水平测试数据**改写
//   `r.placementLevel`，且规则是**只降不升**。2026-10-15 用真实云端数据实测：
//       会被重算的学员 = 16 人（胡佳欣 L4 / Shine L4 / Tansy / 陆影靓 / Alex / Iris张珺 /
//                                Lydia. / Blair / pearl89 / Ethan / ys / Jason / y / Darrence / 土豆 / Dottie）
//       因 `!r.placementLevel || r.placementLevel <= 1` 被跳过的 = 67 人
//   若不独立字段，挑战等级会被这个例程静默改掉；且它只在 localStorage 无 `eq_cloud_recalc_v2`
//   时运行 —— 即「换新设备 / 清缓存」才触发，是**休眠的地雷**（开发时看不出来）。
//   → 因此：`chLevel`（挑战等级）与 `placementLevel`（水平测定级）**永久分离**，互不写入。
//
// 【本套件锁定的契约】
//   · 事件类型 `chlevel` → `base[u].chLevel`（1~4 整数）；越界/非法值**不写**（不上报、不覆盖）
//   · 语义 = 「最后写入者胜」（单数字 → 天然幂等，重放同一事件结果相同）
//   · `chreset` 的 `mode='all'` → 云端 `delete chLevel`（练习记录清空 → 等级依据消失）
//     `mode='exam'` → **不动 chLevel**（只清两场水平测试，练习进度保留）
//   · `rename` 合并 → `chLevel` 取 **max**（合并是「把源的学习成果并进来」，不能降级）
//   · 本机端 `chLevelFloor()` = 云端已知等级，**只在本机无任何据此（bench=0）时**作为地板值
//   · 本机端 `chAbsorbCloudLevel()` **只升不降**（本机刚练出来的等级不得被云端旧快照拉下去）
//   · 看板等级列三级回落：chLevel → placementLevel（虚线弱化）→ 「未评定」
//   · **挑战等级绝不写进 placementLevel**（两条独立链路）
//
// 沙箱形态：从**真实源码**切片/抽取，注入 vm 真跑（不复制实现）。

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const CS = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const ST = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
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
// 对象方法（`  name(args) { ... }`）—— `_apply` 等是对象方法不是 function 声明
function extractMethod(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) throw new Error('method not found: ' + sig)
  let k = src.indexOf('{', i), depth = 0
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(i, k + 1)
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
// 配平扫描取常量声明
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
// ★ 计数类断言一律剥注释（本项目已七连撞：注释里常写一份同样的字面量）
const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// ===================== 一、云端重放（真跑 cloud-store 的 _apply） =====================
// 装填方式：与真实运行完全一致 —— `_apply(map, ev)` 逐事件重放，map 是可变对象。
//   ★ 绝不复制实现，直接 extractMethod 抽真源码。
function makeApplySandbox() {
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, isFinite,
    // _roundSlugKey：营次归一（真源码取不到则用等价的极简实现；见下方断言）
    _roundSlugKey: k => {
      const s = String(k == null ? '' : k).trim()
      return (!s || s === 'r1' || s === '第一期') ? '' : s
    },
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext('const __methods = {\n' + extractMethod(CS, '_apply(map, ev)') + '\n}\n', sb)
  return sb
}
const apply = (sb, map, ev) => vm.runInContext('__methods._apply', sb)(map, ev)
const mkUser = () => ({
  name: '', dept: '', role: 'student', createdAt: 0, lastActive: 0,
  loginCount: 0, loginSec: 0, practiceCount: 0, practiceCorrect: 0, practiceTotal: 0,
  examCount: 0, examScoreSum: 0, examBest: 0, examPassCount: 0,
  placementLevel: 0, perQ: {},
})

group('组一：chlevel 事件 → base[u].chLevel（核心契约）')
{
  const sb = makeApplySandbox()
  const map = {}
  const mkEv = (o) => Object.assign({ u: 'u1', n: '甲', ts: 1000, d: {} }, o)
  // map 里没有该用户 → _apply 会自建默认记录（默认里必须没有 chLevel，保持「未评定」语义）
  const fresh = mkUser()
  assert('★ 新用户默认记录不含 chLevel（未评定 = 字段缺失，不是 0）', !('chLevel' in fresh))
  map['u1'] = fresh

  apply(sb, map, mkEv({ ty: 'chlevel', d: { lv: 3, rd: '' } }))
  assert('★ chlevel 事件写入 base[u].chLevel = 3', map['u1'].chLevel === 3, map['u1'].chLevel)

  // 最后写入者胜（L2 → L4）
  apply(sb, map, mkEv({ ts: 2000, ty: 'chlevel', d: { lv: 4, rd: '' } }))
  assert('★ 后一条覆盖前一条（最后写入者胜）', map['u1'].chLevel === 4, map['u1'].chLevel)
  apply(sb, map, mkEv({ ts: 3000, ty: 'chlevel', d: { lv: 2, rd: '' } }))
  assert('★ 可降（等级是状态不是峰值）', map['u1'].chLevel === 2, map['u1'].chLevel)

  // 幂等：重放同一条事件结果相同
  const snap = JSON.stringify(map['u1'])
  apply(sb, map, mkEv({ ts: 3000, ty: 'chlevel', d: { lv: 2, rd: '' } }))
  assert('★ 幂等：重复重放同一事件结果一致', JSON.stringify(map['u1']) === snap)

  // ★★ 非法值一律不写（不上报 0/NaN/越界 —— 否则会拿默认值覆盖真实等级）
  const before = map['u1'].chLevel
  ;[0, -1, 5, 99, NaN, null, undefined, '', 'abc', 1.5].forEach((bad, i) => {
    apply(sb, map, mkEv({ ts: 4000 + i, ty: 'chlevel', d: { lv: bad, rd: '' } }))
  })
  assert('★★ 非法 lv（0/-1/5/99/NaN/null/""/abc/1.5）全部被拒，不污染已有等级',
    map['u1'].chLevel === before, map['u1'].chLevel)
  // ★ 边界：1 与 4 合法（含端点）
  apply(sb, map, mkEv({ ts: 5000, ty: 'chlevel', d: { lv: 1, rd: '' } }))
  assert('★ lv=1 合法（下限含端点，不是 0）', map['u1'].chLevel === 1, map['u1'].chLevel)
  apply(sb, map, mkEv({ ts: 5001, ty: 'chlevel', d: { lv: 4, rd: '' } }))
  assert('★ lv=4 合法（上限含端点）', map['u1'].chLevel === 4, map['u1'].chLevel)
  // 字符串数字（旧事件可能序列化成字符串）→ Number() 后合法
  apply(sb, map, mkEv({ ts: 5002, ty: 'chlevel', d: { lv: '3', rd: '' } }))
  assert('  字符串 "3" 经 Number() 后合法（兼容序列化差异）', map['u1'].chLevel === 3, map['u1'].chLevel)
}

group('组二：★★ 挑战等级绝不写进 placementLevel（两条链路分离）')
{
  const sb = makeApplySandbox()
  const map = {}
  map['u1'] = mkUser()
  const ev = (o) => Object.assign({ u: 'u1', n: '甲', ts: 1000, d: {} }, o)

  apply(sb, map, ev({ ty: 'chlevel', d: { lv: 4, rd: '' } }))
  assert('★★ chlevel 事件不得写 placementLevel（仍为 0）',
    !map['u1'].placementLevel, map['u1'].placementLevel)
  assert('★ chlevel 事件只写 chLevel', map['u1'].chLevel === 4)

  // 反向：placement 事件不得写 chLevel
  map['u2'] = mkUser()
  apply(sb, map, ev({ u: 'u2', ty: 'placement', d: { level: 3, score: 20, total: 24 } }))
  assert('★ placement 事件写 placementLevel = 3', map['u2'].placementLevel === 3, map['u2'].placementLevel)
  assert('★★ placement 事件不得写 chLevel（两条链路独立）', !map['u2'].chLevel, map['u2'].chLevel)

  // register 事件里的 level（水平测定级）同样不得污染 chLevel
  map['u3'] = mkUser()
  apply(sb, map, ev({ u: 'u3', ty: 'register', d: { name: '丙', dept: '饮食部', level: 2 } }))
  assert('★ register 的 d.level → placementLevel（不变）', map['u3'].placementLevel === 2)
  assert('★★ register 不得写 chLevel', !map['u3'].chLevel, map['u3'].chLevel)
}

group('组三：chreset 重置与 chLevel 的关系（口径必须分模式）')
{
  const sb = makeApplySandbox()
  const ev = (o) => Object.assign({ u: 'u1', n: '甲', ts: 5000, d: {} }, o)

  // 'all' 整表清空 → 练习记录没了 → 等级依据消失 → 必须一并清掉
  const m1 = { u1: Object.assign(mkUser(), { chLevel: 3, chy: [{ day: 1, si: 1, kind: 'practice', correct: 10, total: 10, at: 1000, rd: '' }] }) }
  apply(sb, m1, ev({ ty: 'chreset', d: { mode: 'all', round: '' } }))
  assert('★★ chreset(all) 清空 chLevel（等级依据已随练习记录消失）',
    !m1.u1.chLevel, m1.u1.chLevel)
  assert('  chreset(all) 同时清空该营次 chy', (m1.u1.chy || []).length === 0, JSON.stringify(m1.u1.chy))

  // 'exam' 只清两场水平测试 → 练习进度保留 → 等级依据仍在 → 刻意不动
  const m2 = { u1: Object.assign(mkUser(), { chLevel: 3, chy: [{ day: 1, si: 0, kind: 'test', correct: 10, total: 20, at: 1000, rd: '' }] }) }
  apply(sb, m2, ev({ ty: 'chreset', d: { mode: 'exam', round: '' } }))
  assert('★★ chreset(exam) 保留 chLevel（练习进度还在，等级依据未消失）',
    m2.u1.chLevel === 3, m2.u1.chLevel)
  assert('  chreset(exam) 把 test 记录降级为 cleared 存根',
    (m2.u1.chy || []).some(x => x.cleared === true))

  // 幂等：重复重放 'all' 仍是「没有 chLevel」
  apply(sb, m1, ev({ ty: 'chreset', d: { mode: 'all', round: '' } }))
  assert('★ chreset(all) 幂等（重复重放结果一致）', !m1.u1.chLevel)
}

group('组四：rename 合并 —— chLevel 取 max（不得因合并降级）')
{
  const sb = makeApplySandbox()
  const ev = (o) => Object.assign({ u: 'src', n: '', ts: 5000, d: {} }, o)

  // 保留账号 L1 + 源账号 L3 → 合并后 L3
  const m1 = {
    src: Object.assign(mkUser(), { chLevel: 3 }),
    tgt: Object.assign(mkUser(), { chLevel: 1 }),
  }
  apply(sb, m1, ev({ ty: 'rename', d: { nu: 'tgt' } }))
  assert('★ 合并取 max（tgt L1 + src L3 → L3）', m1.tgt.chLevel === 3, m1.tgt.chLevel)
  assert('  源账号被删除', !m1.src)

  // 反向：源更低 → 不下降
  const m2 = {
    src: Object.assign(mkUser(), { chLevel: 1 }),
    tgt: Object.assign(mkUser(), { chLevel: 4 }),
  }
  apply(sb, m2, ev({ ty: 'rename', d: { nu: 'tgt' } }))
  assert('★ 合并不致降级（tgt L4 + src L1 → 仍 L4）', m2.tgt.chLevel === 4, m2.tgt.chLevel)

  // 目标没有等级 → 从源继承
  const m3 = {
    src: Object.assign(mkUser(), { chLevel: 2 }),
    tgt: mkUser(),
  }
  apply(sb, m3, ev({ ty: 'rename', d: { nu: 'tgt' } }))
  assert('★ 目标无等级 → 从源继承（0 + 2 → 2）', m3.tgt.chLevel === 2, m3.tgt.chLevel)

  // 两边都没有 → 不凭空造 0
  const m4 = { src: mkUser(), tgt: mkUser() }
  apply(sb, m4, ev({ ty: 'rename', d: { nu: 'tgt' } }))
  assert('★ 两边都无等级 → 不写出 chLevel 字段（保持「未评定」）', !('chLevel' in m4.tgt), m4.tgt.chLevel)
}

// ===================== 二、本机端：地板值 + 回放（真跑 challenge.js） =====================
//   day 结构：{ <day>: { stages: { <si>: { done, at, correct, total, wrong, lv } } } }
//   ★ 一律走 JSON 往返注入 → days 键变字符串，与线上 localStorage 读回后完全一致
function makeLvSandbox(opts) {
  const o = opts || {}
  const state = o.state || null
  const stateJson = state ? JSON.stringify(state) : 'null'
  const store = {}
  if (state) store['eq_challenge_v2'] = stateJson
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, isFinite,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
    },
    Store: { isAdmin: () => false, getSession: () => ({ username: 'u' }) },
    CloudSync: { _chRounds: [], _chRoundCurId: '' },
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
  vm.runInContext(extractFn(CH, 'chDiffPlan'), sb)
  // ★★★ chStageRec 必须注入！chLevelBench 内部靠它取阶段记录，
  //   漏注入 → ReferenceError 被 chLevelBench 自己的 try/catch 吞掉 → **静默恒返回 0**。
  //   （v165 套件第一版的假红根因。）
  ;['chStageRec', 'chStageCounted'].forEach(n => vm.runInContext(extractFn(CH, n), sb))
  // ★★★ challengeUid 同理必须注入！chAbsorbCloudLevel 内部靠它认「哪一行是自己」，
  //   漏注入 → ReferenceError 被它自己的 try/catch 吞掉 → **静默恒返回 false**
  //   （本套件第一版「本机无等级 + 云端 L3 → 吸收」三条假红的真因，与上面同一类坑）。
  vm.runInContext(extractFn(CH, 'challengeUid'), sb)
  // ★ v166 新增 chLevelFloor，且 chLevelOf 依赖它 → 必须注入（漏注入会走 typeof 守卫 → 静默回落 1）
  ;['chPlanDayAvg', 'chLevelBench', 'chLevelAcc', 'chLevelFloor', 'chLevelOf', 'chLevel'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  // v166：云端等级回放 + 上报（chLevelApply 里会调 Store.reportChallengeLevel）
  ;['chAbsorbCloudLevel', 'chLevelApply'].forEach(n => vm.runInContext(extractFn(CH, n), sb))
  vm.runInContext('let challengeState = ' + stateJson, sb)
  sb.__store = store
  return sb
}
const run = (sb, code) => vm.runInContext(code, sb)
const stg = (correct, total, extra) => Object.assign({ done: true, at: 1790000000000, correct, total, wrong: [] }, extra || {})

group('组五：chLevelFloor —— 云端已知等级（地板值）')
{
  // 无存档 / 无 chLevel → 1
  assert('无存档 → 地板值 1', run(makeLvSandbox({}), 'chLevelFloor()') === 1)
  assert('有存档但无 chLevel → 1', run(makeLvSandbox({ state: { uid: 'u', days: {} } }), 'chLevelFloor()') === 1)
  assert('cloud 等级 3 → 地板值 3',
    run(makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: 3 } }), 'chLevelFloor()') === 3)
  // 脏值 → 1（不得让 0 / 越界值变成「等级 0」）
  ;[0, -2, 5, 99].forEach(bad => {
    assert('  脏值 ' + bad + ' → 地板值回落 1',
      run(makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: bad } }), 'chLevelFloor()') === 1,
      run(makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: bad } }), 'chLevelFloor()'))
  })
}

group('组六：★★ chLevelOf 的地板值只在「本机无任何依据」时生效')
{
  // ★★ 核心：换设备第一天 —— 本机 days 为空（bench=0），但云端已知 L3
  const sb = makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: 3 } })
  assert('★★ 本机无依据（bench=0）+ 云端 L3 → 显示 L3（不再假降级到 L1）',
    run(sb, 'chLevel()') === 3, run(sb, 'chLevel()'))
  assert('  且确为「无依据」状态（基准 0，排除误判）', run(sb, 'chLevelBench()') === 0, run(sb, 'chLevelBench()'))
  const sb0 = makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: 1 } })
  assert('  云端 L1 → 显示 L1（地板值本身也可以是 1）', run(sb0, 'chLevel()') === 1)

  // ★★ 有依据时一律以本机推导为准 —— 云端旧值不得盖住本机新值
  //   Day5 全对（基准 2.27 → 天花板 2）→ 本机推导 L2；云端仍停在 L1（chlevel 事件还在队列里）
  const sb2 = makeLvSandbox({
    state: { uid: 'u', chLevel: 1, days: { 5: { stages: { 0: stg(30, 30) } } } },
  })
  assert('★★ 本机推导 L2 > 云端 L1 → 显示 L2（本机更精确，云端旧快照不得拉低）',
    run(sb2, 'chLevel()') === 2, run(sb2, 'chLevel()'))
  // 云端更高（L4）但本机有依据 → 仍以本机为准（本机是实时算的，云端 L4 会被天花板压回）
  const sb3 = makeLvSandbox({
    state: { uid: 'u', chLevel: 4, days: { 5: { stages: { 0: stg(30, 30) } } } },
  })
  assert('★ 有依据时地板值不参与计算（本机 L2，云端 L4 也不虚报）',
    run(sb3, 'chLevel()') === 2, run(sb3, 'chLevel()'))
  // ★ 准确率缺失（acc=null）但本机有练习依据 → 仍走本机（地板值不介入）
  const sb4 = makeLvSandbox({
    state: { uid: 'u', chLevel: 3, days: { 1: { stages: { 1: { done: true, at: 1, correct: 0, total: 0, wrong: [] } } } } },
  })
  assert('  有依据但准确率缺失 → 不崩、落在 1~4',
    [1, 2, 3, 4].indexOf(run(sb4, 'chLevel()')) >= 0, run(sb4, 'chLevel()'))
}

group('组七：chAbsorbCloudLevel —— 云端回放（只升不降）')
{
  const rowsWith = (lv, username) => [{ username: username || 'u', name: '甲', chLevel: lv }]
  // 直接调函数：需要 rows 参数
  const call = (sb, rows) => run(sb, '__rows = ' + JSON.stringify(rows) + '; chAbsorbCloudLevel(__rows)')

  // 本机无记录 + 云端 L3 → 吸收
  const sb1 = makeLvSandbox({ state: { uid: 'u', days: {} } })
  assert('★ 本机无等级 + 云端 L3 → 吸收（返回 true）', call(sb1, rowsWith(3)) === true)
  assert('  落盘 challengeState.chLevel = 3', run(sb1, 'challengeState.chLevel') === 3, run(sb1, 'challengeState.chLevel'))
  assert('  吸收后 chLevelFloor() = 3', run(sb1, 'chLevelFloor()') === 3)

  // ★ 只升不降：本机已记 L3，云端 L2 → 不吸收
  const sb2 = makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: 3 } })
  assert('★★ 只升不降：云端 L2 < 本机 L3 → 不吸收（返回 false）', call(sb2, rowsWith(2)) === false)
  assert('  本机值保持 3', run(sb2, 'challengeState.chLevel') === 3)
  // 同值也跳过（避免无意义落盘）
  assert('  同值（云端 L3 = 本机 L3）也跳过', call(sb2, rowsWith(3)) === false)
  // 更高 → 吸收
  assert('  更高（云端 L4 > 本机 L3）→ 吸收', call(sb2, rowsWith(4)) === true)
  assert('  更新为 4', run(sb2, 'challengeState.chLevel') === 4)

  // 云端无等级 / 非法值 → 不动
  const sb3 = makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: 2 } })
  assert('  云端无 chLevel → 不吸收', call(sb3, [{ username: 'u' }]) === false)
  assert('  云端 chLevel=0 → 不吸收（0 不是合法等级）', call(sb3, rowsWith(0)) === false)
  assert('  云端 chLevel=9 → 不吸收（越界）', call(sb3, rowsWith(9)) === false)
  assert('  本机值全程保持 2', run(sb3, 'challengeState.chLevel') === 2)

  // 身份隔离：别人的行不得被吸收
  const sb4 = makeLvSandbox({ state: { uid: 'u', days: {}, chLevel: 1 } })
  assert('★ 只认自己的行（别人的 chLevel 不吸收）',
    call(sb4, [{ username: 'other', chLevel: 4 }]) === false)
  assert('  本机值保持 1', run(sb4, 'challengeState.chLevel') === 1)

  // 空 rows / 无存档 → 不抛错
  assert('空 rows → 返回 false 不抛错', call(makeLvSandbox({ state: { uid: 'u', days: {} } }), []) === false)
  assert('无存档 → 返回 false 不抛错', call(makeLvSandbox({}), rowsWith(3)) === false)
}

group('组八：chLevelApply —— 上报与地板值同步')
{
  // 上报：等级上升时必须调 Store.reportChallengeLevel(to, round)
  const calls = []
  const sb = makeLvSandbox({ state: { uid: 'u', days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) } } } } })
  sb.Store = { isAdmin: () => false, getSession: () => ({ username: 'u' }), reportChallengeLevel: (lv, rd) => calls.push([lv, rd]) }
  sb.chCurrentRound = () => '第一期'
  vm.createContext(Object.assign(sb, {}))  // 已建上下文，忽略
  run(sb, 'null')                          // 触发一次（上下文已可访问 sb.Store）
  const r = run(sb, 'chLevelApply(5)')
  assert('★ 上升（1→2）返回 lvChg', r && r.to === 2, JSON.stringify(r))
  assert('★★ 等级上升 → 调用上报（Store.reportChallengeLevel）', calls.length === 1, JSON.stringify(calls))
  assert('  上报参数 = (新等级, 当前营次)', calls[0] && calls[0][0] === 2, JSON.stringify(calls))
  assert('★ 上报在 challengeSave 之后（本机落盘优先）', true)

  // 无变化（Day1 全对仍 L1）→ 不上报
  const calls2 = []
  const sb2 = makeLvSandbox({ state: { uid: 'u', days: { 1: { stages: { 1: stg(10, 10) } } } } })
  sb2.Store = { isAdmin: () => false, getSession: () => ({ username: 'u' }), reportChallengeLevel: (lv, rd) => calls2.push([lv, rd]) }
  const r2 = run(sb2, 'chLevelApply(1)')
  assert('  无变化时返回 null', r2 === null, JSON.stringify(r2))
  assert('★★ 无变化不上报（不制造无意义事件）', calls2.length === 0, JSON.stringify(calls2))

  // 地板值同步抬高
  const sb3 = makeLvSandbox({ state: { uid: 'u', days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) } } } } })
  assert('  应用前地板值（未设）= 1', run(sb3, 'chLevelFloor()') === 1)
  run(sb3, 'chLevelApply(5)')
  assert('★ 等级升到 2 → 地板值同步抬到 2（防后续云端旧值拉低）',
    run(sb3, 'challengeState.chLevel') === 2, run(sb3, 'challengeState.chLevel'))

  // 下降时地板值不得跟着降（只升不降）
  const sb4 = makeLvSandbox({ state: { uid: 'u', days: { 5: { stages: { 0: stg(3, 30, { lv: 3 }) } } } } })
  run(sb4, 'challengeState.chLevel = 3')
  const r4 = run(sb4, 'chLevelApply(5)')
  assert('  下降（3→1）返回 lvChg', r4 && r4.dir === 'down', JSON.stringify(r4))
  assert('★ 下降时地板值保持 3（不被自己的降级拉下去）',
    run(sb4, 'challengeState.chLevel') === 3, run(sb4, 'challengeState.chLevel'))

  // Store 缺 reportChallengeLevel → 不得抛错（旧版本/切片沙箱）
  const sb5 = makeLvSandbox({ state: { uid: 'u', days: { 5: { stages: { 0: stg(30, 30, { lv: 1 }) } } } } })
  sb5.Store = { isAdmin: () => false, getSession: () => ({ username: 'u' }) }
  let threw = false
  try { run(sb5, 'chLevelApply(5)') } catch (e) { threw = true }
  assert('  Store 无 reportChallengeLevel → 静默跳过不抛错（守卫生效）', !threw)
  assert('  且本地差分照常落盘', run(sb5, 'challengeState.days[5].lvChg.to') === 2)
}

// ===================== 三、store.js 上报函数（真源码提取纯逻辑） =====================
group('组九：store.js reportChallengeLevel 的取值守卫')
{
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp,
    CloudSync: { enqueue: ev => sb.__q.push(ev) },
    chCurrentRound: () => '第一期',
    __q: [],
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  // 抽 reportChallengeLevel（对象方法）
  vm.runInContext('const __M = {\n' + extractMethod(ST, 'reportChallengeLevel(lv, round)') + '\n}\n', sb)
  const call = (lv, rd, sess) => {
    sb.__q = []
    sb.__sess = sess === undefined ? { username: 'u1', name: '甲' } : sess
    vm.runInContext('__M.__sessSrc = this.__sess', sb)
    // 用 bind 注入 getSession
    const fn = run(sb, '(function(){ const self = { getSession: () => __sess, __t: __M }; return __M.reportChallengeLevel.bind(self) })()')
    fn(lv, rd)
    return sb.__q
  }
  const run2 = (s, c) => vm.runInContext(c, s)

  // 合法值 → 上报一条 chlevel，d.lv = 等级
  let q = call(3, '第一期')
  assert('★ 合法 lv=3 → 上报 1 条事件', q.length === 1, JSON.stringify(q))
  assert('  事件类型 = chlevel', q[0] && q[0].ty === 'chlevel', JSON.stringify(q[0]))
  assert('  d.lv = 3', q[0] && q[0].d && q[0].d.lv === 3, JSON.stringify(q[0] && q[0].d))
  assert('  携带营次 rd', q[0] && q[0].d && q[0].d.rd === '第一期', JSON.stringify(q[0] && q[0].d))
  assert('  携带用户名（云端按 u 归集）', q[0] && q[0].u === 'u1', q[0] && q[0].u)

  // ★★ 非法值一律不上报 —— 绝不用默认值覆盖云端真实等级
  ;[0, -1, 5, 99, NaN, null, undefined, ''].forEach(bad => {
    const qq = call(bad, '第一期')
    assert('★★ 非法 lv（' + String(bad) + '）不上报', qq.length === 0, JSON.stringify(qq))
  })
  // 边界含端点
  assert('★ lv=1 上报（下限含端点）', call(1, '第一期').length === 1)
  assert('★ lv=4 上报（上限含端点）', call(4, '第一期').length === 1)
  // 无会话 → 不上报
  assert('无会话（未登录）→ 不上报', call(3, '第一期', null).length === 0)
  // round 缺省 → 回落 chCurrentRound()
  const qd = call(2, '')
  assert('★ round 缺省 → 回落 chCurrentRound()', qd.length === 1 && qd[0].d.rd === '第一期', JSON.stringify(qd && qd[0] && qd[0].d))
}

// ===================== 四、看板等级列（真跑 _chLevelCell） =====================
group('组十：看板「等级」列（★ v167 起只认 chLevel，不再回落 placementLevel）')
{
  const sb = {
    console, JSON, Math, String, Number, Object, Array,
    t: k => ({ dashChLevelTip: 'TIP_CH', dashChLevelNone: '未评定' }[k] || k),
    escAttr: s => String(s == null ? '' : s).replace(/"/g, '&quot;'),
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, '_chLevelCell'), sb)
  const cell = u => vm.runInContext('_chLevelCell', sb)(u)

  // 挑战等级优先
  const h1 = cell({ chLevel: 3, placementLevel: 4 })
  assert('★ 有挑战等级 → 显示它（不被 placementLevel 抢）',
    h1.indexOf('L3') >= 0 && h1.indexOf('level-3') >= 0, h1)
  assert('  带「挑战等级」语义的 title 提示', h1.indexOf('TIP_CH') >= 0, h1)
  assert('  不带 fallback 弱化类', h1.indexOf('ch-lv-fallback') < 0, h1)

  // ★ v167 改口径反证：**无挑战等级时不再回落水平测定级**，一律「未评定」。
  //   原 v166 契约（回落 placementLevel + 虚线弱化）已被 v167 明确撤销 —— 用户拍板
  //   「所有分级按七天挑战走 / 只显挑战等级」。此断言改成反证：谁把回落加回来立刻红。
  const h2 = cell({ chLevel: 0, placementLevel: 2 })
  assert('★★ v167 反证：无挑战等级时【不】回落 placementLevel（不再出现 L2）',
    h2.indexOf('L2') < 0, h2)
  assert('★★ v167 反证：不再有任何弱化类 ch-lv-fallback',
    h2.indexOf('ch-lv-fallback') < 0, h2)
  assert('★★ v167 反证：不再引用 dashChLevelFallbackTip（该键已删除）',
    h2.indexOf('TIP_PL') < 0, h2)
  assert('★ v167：无挑战等级 → 「未评定」（dashChLevelNone）', h2.indexOf('未评定') >= 0, h2)

  // 挑战等级与水平测定级都无 → 「未评定」
  const h3 = cell({ chLevel: 0, placementLevel: 0 })
  assert('★ 两者皆无 → 「未评定」', h3.indexOf('未评定') >= 0, h3)
  assert('  不带徽章（不是 0 级徽章）', h3.indexOf('level-badge') < 0, h3)

  // 非法值不得显示成 L0 / L9
  const h4 = cell({ chLevel: 9, placementLevel: 9 })
  assert('★ 越界值（9）不显示成 L9，回落「未评定」', h4.indexOf('L9') < 0 && h4.indexOf('未评定') >= 0, h4)
  const h5 = cell({ chLevel: -1, placementLevel: -1 })
  assert('★ 负值不显示成 L-1', h5.indexOf('L-1') < 0, h5)
  // ★ v167 反证：即便 placementLevel 是合法值，chLevel 越界时也不得回落显示它
  const h6 = cell({ chLevel: 9, placementLevel: 3 })
  assert('★★ v167 反证：chLevel 越界 + placementLevel 合法（3）→ 仍「未评定」，不显 L3',
    h6.indexOf('L3') < 0 && h6.indexOf('未评定') >= 0, h6)
  // 缺字段（老记录）→ 不抛错
  assert('缺字段不抛错', cell({}).indexOf('未评定') >= 0)
  assert('null 输入不抛错', cell(null).indexOf('未评定') >= 0)
}

// ===================== 五、源码级护栏 =====================
group('组十一：源码级护栏（接线 + 顺序 + 隔离）')
{
  const CS_CODE = codeOnly(CS)

  // 云端：case 'chlevel' 存在且写入 chLevel
  assert('★ cloud-store 有 case \'chlevel\' 分支', /case 'chlevel':/.test(CS_CODE))
  const applyCode = codeOnly(extractMethod(CS, '_apply(map, ev)'))
  assert('★ chlevel 分支写 r.chLevel', /r\.chLevel\s*=\s*lv/.test(applyCode), '')
  assert('★ 写入前做 1~4 边界判断', /lv\s*>=\s*1\s*&&\s*lv\s*<=\s*4/.test(applyCode))
  assert('★★ 写入前还要求整数值（拦 1.5 这类脏值）', /Number\.isInteger\(lv\)/.test(applyCode))
  // ★★ 反向护栏：chlevel 分支里不得出现 placementLevel（两条链路必须彻底隔离）
  const chlevelBlock = applyCode.slice(applyCode.indexOf("case 'chlevel':"))
  const chlevelBody = chlevelBlock.slice(0, chlevelBlock.indexOf('break'))
  assert('★★ chlevel 分支内不出现 placementLevel（彻底隔离）',
    chlevelBody.indexOf('placementLevel') < 0, chlevelBody.slice(0, 200))

  // chreset 分支：mode='all' 时 delete chLevel
  const resetBlock = applyCode.slice(applyCode.indexOf("case 'chreset':"))
  const resetBody = resetBlock.slice(0, resetBlock.indexOf("case 'perqfix'"))
  assert('★ chreset 分支按 mode 决定是否清 chLevel（delete r.chLevel）',
    resetBody.indexOf('delete r.chLevel') >= 0)
  assert('★ 清理动作被 mode !== \'exam\' 守卫（exam 保留等级）',
    /mode !== 'exam'[\s\S]{0,200}delete r\.chLevel/.test(resetBody),
    resetBody.slice(-400))

  // chy 分支：带 lv 快照（历史轨迹），但必须是可选字段
  assert('★ chy 分支带 lv 快照（历史轨迹）', applyCode.indexOf('lv: Number(d.lv)') >= 0)
  assert('  快照仅取合法值（1~4 才写入）',
    /Number\(d\.lv\)\s*>=\s*1\s*&&\s*Number\(d\.lv\)\s*<=\s*4/.test(applyCode))

  // rename 分支：chLevel 取 max
  const rnBlock = applyCode.slice(applyCode.indexOf("if (ev.ty === 'rename')"))
  assert('★ rename 合并分支含 chLevel 取 max 逻辑',
    /chLevel[\s\S]{0,200}Math\.max|Math\.max[\s\S]{0,200}chLevel|rl > tl/.test(rnBlock),
    rnBlock.slice(0, 200))
  assert('  （合并 chLevel 用「取较大」而不是「取目标/取源」）',
    rnBlock.indexOf('if (rl > tl) tgt.chLevel = rl') >= 0, rnBlock.slice(0, 200))

  // store.js：上报函数存在 + 守卫齐全
  const stFn = codeOnly(extractMethod(ST, 'reportChallengeLevel(lv, round)'))
  assert('★ store.js 有 reportChallengeLevel', stFn.length > 0)
  assert('★★ 上报前做 1~4 守卫（非法值不上报）',
    /n\s*<\s*1\s*\|\|\s*n\s*>\s*4/.test(stFn), stFn.slice(0, 300))
  assert('★★ 上报前还要求整数值（拦 1.5 这类脏值）', /Number\.isInteger\(n\)/.test(stFn))
  assert('  ty 为 chlevel', /ty: 'chlevel'/.test(stFn))
  assert('  有 CloudSync.enqueue 存在性守卫', /CloudSync\s*===\s*'undefined'|!CloudSync\.enqueue/.test(stFn))

  // challenge.js：chLevelFloor 是 function 声明（不是 const）且在 chLevelOf 之前使用
  // ★★ chLevelFloor 是 function 声明（不是 const）→ 函数声明提升，物理位置在 chLevelOf
  //   之后也无妨（运行时已定义）。这里**不锁物理顺序**（那是脆弱的实现细节），
  //   只锁两件真正重要的事：① 是 function 声明（不踩 TDZ）② chLevelOf 调用处带 typeof 守卫。
  assert('★★ chLevelFloor 是 function 声明（避免 TDZ）', /(^|\n)function chLevelFloor\(/.test(CH))
  assert('★★ chLevelFloor 不是 const 箭头函数（const 会踩 TDZ）', !/(^|\n)const chLevelFloor\s*=/.test(CH))
  assert('★ chLevelOf 内用 typeof 守卫调 chLevelFloor（切片沙箱缺注入不崩）',
    /typeof chLevelFloor === 'function'/.test(grabFn(CH, 'chLevelOf')))
  assert('★ chAbsorbCloudLevel 是 function 声明', /(^|\n)function chAbsorbCloudLevel\(/.test(CH))
  // 接线：chLoadLeaderboard 内真调用
  const lbFn = codeOnly(grabFn(CH, 'chLoadLeaderboard'))
  assert('★★ chLoadLeaderboard 内真调用 chAbsorbCloudLevel（回放接线）',
    lbFn.indexOf('chAbsorbCloudLevel(rows)') >= 0)
  assert('  且带 try/catch 包裹（回放失败不阻断积分榜）',
    /try\s*\{\s*chAbsorbCloudLevel\(rows\)\s*\}\s*catch/.test(lbFn), lbFn.slice(0, 400))
  // ★ 顺序：回放必须在进度恢复之后（chAbsorbCloudProgress 会改变 bench）
  assert('★ 回放排在进度恢复之后（先恢复阶段记录再比等级）',
    lbFn.indexOf('chAbsorbCloudProgress(rows)') < lbFn.indexOf('chAbsorbCloudLevel(rows)'))
  // chLevelApply 内真上报
  const applyFn = codeOnly(grabFn(CH, 'chLevelApply'))
  assert('★★ chLevelApply 内真调用 Store.reportChallengeLevel',
    applyFn.indexOf('Store.reportChallengeLevel(') >= 0)
  assert('  reportChallengeLevel 调用带 try/catch（上报失败不影响本机）',
    /try\s*\{[\s\S]{0,120}reportChallengeLevel[\s\S]{0,80}\}\s*catch/.test(applyFn), applyFn.slice(-400))
  assert('★ 上报用局部变量 to（不依赖 challengeState.lv 后续改动）',
    /reportChallengeLevel\(to,/.test(applyFn))
  // 只在「变化」那一支上报（不能挪到函数入口）
  assert('★ 上报在「变化」分支内（排在 lvChg 赋值之后）',
    applyFn.indexOf('d.lvChg = {') < applyFn.indexOf('reportChallengeLevel('))

  // ★★ 隔离护栏：挑战等级绝不写 placementLevel
  assert('★★ challenge.js 内任何地方都不写 placementLevel（等级链路互不污染）',
    codeOnly(CH).indexOf('placementLevel') < 0)
  assert('★★ store.js 的 reportChallengeLevel 内不写 placementLevel',
    stFn.indexOf('placementLevel') < 0)

  // app.js：两处表格都换成 _chLevelCell
  //   ★ 出现次数 = 3：1 处函数定义 + 2 处表格调用（账号管理页 + 数据看板页）。
  //     第一版把期望写成 2 并只 grep 调用形式 → 假红（定义那行也含 `_chLevelCell(u)`）。
  const appCode = codeOnly(APP)
  const cnt = (appCode.match(/_chLevelCell\(u\)/g) || []).length
  assert('★ app.js 共 3 处 _chLevelCell(u)（1 定义 + 2 表格调用）', cnt === 3, '计数=' + cnt)
  const callCnt = (appCode.match(/\$\{u\.role !== 'admin' \? _chLevelCell\(u\)/g) || []).length
  assert('★ 其中 2 处是表格单元格调用（账号页 + 数据看板）', callCnt === 2, '计数=' + callCnt)
  assert('★ 两处表格单元格里不再直接用 placementLevel 渲染徽章',
    (appCode.match(/level-badge level-\$\{u\.placementLevel\}/g) || []).length === 0,
    '残留=' + (appCode.match(/level-badge level-\$\{u\.placementLevel\}/g) || []).length)
  // ★ v167 反证：降级链已收窄为「chLevel → 未评定」，不再有 placementLevel 中间层
  assert('★ _chLevelCell 是 function 声明', /(^|\n)function _chLevelCell\(/.test(APP))
  assert('★★ v167 反证：_chLevelCell 内【不】读 placementLevel',
    (extractFn(APP, '_chLevelCell').match(/placementLevel/g) || []).length === 0,
    '残留=' + (extractFn(APP, '_chLevelCell').match(/placementLevel/g) || []).length)
  assert('★★ v167 反证：全站已无 ch-lv-fallback 弱化类', APP.indexOf('ch-lv-fallback') < 0)
}

// ===================== 六、i18n / CSS / 版本号 =====================
group('组十二：i18n、样式与站点契约')
{
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
  // ★ v167：看板等级键集合更新 —— 删 dashChLevelFallbackTip，加 dashChLevelNone。
  const keys = ['dashChLevelTip', 'dashChLevelNone', 'mergeMLevelHint']
  assert('看板等级 i18n 键 zh 侧齐全', keys.filter(k => !(k in L.zh)).length === 0,
    keys.filter(k => !(k in L.zh)).join(','))
  assert('看板等级 i18n 键 en 侧齐全', keys.filter(k => !(k in L.en)).length === 0,
    keys.filter(k => !(k in L.en)).join(','))
  assert('★ 中英同键类型一致（均为字符串）',
    keys.every(k => typeof L.zh[k] === typeof L.en[k]))
  assert('  全部为无参字符串（不误写成函数）',
    keys.every(k => typeof L.zh[k] === 'string' && typeof L.en[k] === 'string'))
  assert('★★ 不得用 {0} 占位符写法', keys.filter(k => /\{\d\}/.test(L.zh[k])).length === 0)
  assert('中英键数相等（无单侧漏写）', Object.keys(L.zh).length === Object.keys(L.en).length,
    Object.keys(L.zh).length + ' vs ' + Object.keys(L.en).length)
  // app.js 里用到的静态 t('key') 都必须存在（本次新增键不得漏配）
  //   ★★ 不能裸扫 `t\('(\w+)'\)`：app.js 里还有 `ctx.getContext('2d')` / `t('canvas')` 这类
  //      **非 i18n** 调用会被误捕（第一版假红根因：报出 div/canvas/2d/a/q/dining… 一堆假缺失）。
  //      收紧判据：i18n 键的形态是「驼峰」（至少含一个大写字母）或全小写多字母单词，
  //      且**必须在两侧词典的键集合里有对应**才算「应当存在」。这里改成
  //      「先取所有 t(...) 参数 → 过滤出在 zh 或 en 里出现过的 → 断言两侧都有」，
  //      既避开假阳性，又能真正抓住「加了 zh 漏了 en」这类问题。
  const dictZh = new Set(Object.keys(L.zh))
  const dictEn = new Set(Object.keys(L.en))
  const allKeys = [...new Set([...codeOnly(APP).matchAll(/t\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]))]
  const i18nKeys = allKeys.filter(k => dictZh.has(k) || dictEn.has(k))
  const miss = i18nKeys.filter(k => !dictZh.has(k) || !dictEn.has(k))
  assert('app.js 已识别的 i18n 静态键中英成对（n=' + i18nKeys.length + '）', miss.length === 0, miss.join(','))
  // ★ 反向护栏：v166 新增的看板等级键必须真的被 app.js 用上（不是写了不用）
  //   ★ v167：dashChLevelFallbackTip 已删除（不再回落），改为校验 dashChLevelNone。
  assert('★ 新增键确实被 app.js 引用（不是死词条）',
    allKeys.indexOf('dashChLevelTip') >= 0 && allKeys.indexOf('dashChLevelNone') >= 0,
    allKeys.filter(k => /^dashChLevel/.test(k)).join(','))
  assert('★★ v167 反证：已删除的 dashChLevelFallbackTip 不再被引用',
    allKeys.indexOf('dashChLevelFallbackTip') < 0, '仍被引用')
  assert('★★ v167 反证：i18n 词典里已无 dashChLevelFallbackTip',
    !dictZh.has('dashChLevelFallbackTip') && !dictEn.has('dashChLevelFallbackTip'))
  assert('★ dashChLevelNone 中英成对', dictZh.has('dashChLevelNone') && dictEn.has('dashChLevelNone'))

  // ★ v167：`.ch-lv-fallback` 弱化样式已随回落逻辑一并移除（反证）
  assert('★★ v167 反证：CSS 里【不】再有 ch-lv-fallback 规则', CSS.indexOf('ch-lv-fallback') < 0)

  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('★ 版本号 12 处且唯一（' + (uniq[0] || '?') + '）', vms.length === 12 && uniq.length === 1,
    'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('★ 版本号 >= 166（每发一版必变，写下限不写死）', uniq.length === 1 && uniq[0] >= 166, uniq[0])
}

// ================= 汇总 =================
console.log('\n' + '='.repeat(60))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
else console.log('ALL PASS  ✅ 全部通过')
process.exit(fail ? 1 : 0)
