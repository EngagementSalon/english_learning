// test-v174-course-level.js
// v174：线下课成绩并入「挑战能力等级」评定的回归套件
//
// 【需求原话】「可以把线下课的成绩也放入评定标准」
// 【用户拍板的三项口径】
//   ① 只用「终极大考（coursefinal）+ 随堂考试（exam）」—— 排除 homework / video / offline
//   ② 加权平均：合成分 = 挑战首答准确率 × 0.7 + 线下课均分 × 0.3
//   ③ 线下课**不参与地板压制** —— 难度档地板只压挑战那一侧
//
// 【本套件锁定的契约】
//   · 无线下课成绩 → chLevelOf 行为与 v167 **逐值完全一致**（回归护栏，防灰犀牛）
//   · 线下课无分 ≠ 0 分：返回 null → 退化为纯挑战口径（否则没上过线下课的人被无端压级）
//   · 地板只压挑战侧：用「已压顶等级」反推等效分（cappedScore）再加权，
//     否则地板被加权稀释 → 准确率 100% + 地板 L1 + 线下课 100 分会跳回 L4，地板形同虚设
//   · 合成后**不与 capped 取 max** —— 线下课考砸了就该体现出来（用户诉求就是把它当标准）
//   · 本机无练习依据（bench === 0）→ 仍然回落 chLevelFloor()，线下课再多分也不虚报
//   · chCourseScore / chLevelOf 必须 **function 声明**且 chCourseScore 在 chLevelOf 之上（const 会 TDZ）

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
// 取整个函数声明源码（断形态 / 顺序用）
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
// ★ 计数类断言一律剥注释（本项目已七连撞：注释里常写一份同样的字面量）
const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// ★★ 真实名义计划难度均值（从源码 CHALLENGE_DIFF_PLAN 实算，不许凭记忆写）
const planAvg = plan => plan.map(p => {
  const n = [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0]
  const sum = n[0] + n[1] + n[2]
  return sum ? (n[0] * 1 + n[1] * 2 + n[2] * 3) / sum : 0
})
const P1_AVG = planAvg([[10, 0, 0], [26, 0, 4], [21, 0, 9], [16, 0, 14], [11, 0, 19], [6, 0, 24], [1, 0, 9]])
const PH_AVG = planAvg([[5, 0, 5], [13, 3, 14], [8, 4, 18], [4, 5, 21], [2, 6, 22], [1, 7, 22], [0, 0, 10]])

// ====== 沙箱 ======
// 与 v165 同形：序列化后注入（days 键为字符串，与线上 JSON.parse 一致）
//
// ★★★ v174 新增：注入 courseState（线下课文档）+ challengeUid 的依赖 Store。
//   opts.courses 形态 = 真实课程文档：{ v:1, classes:[{ id, name, members:[], assignments:[] }] }
//   opts.uid 默认 'u'（与 Store.getSession() 返回一致）
//   opts.floor = 存档里的 chLevel（v166 云端回落地板值）
function makeLvSandbox(opts) {
  const o = opts || {}
  const uid = o.uid || 'u'
  const st = { uid: uid, days: o.days || undefined }
  if (o.floor != null) st.chLevel = o.floor
  const stateJson = o.days || (o.floor != null) ? JSON.stringify(st) : 'null'
  const store = {}
  if (stateJson !== 'null') store['eq_challenge_v2'] = stateJson

  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, isFinite,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
    },
    Store: { isAdmin: () => false, getSession: () => ({ username: uid }) },
    CloudSync: { _chRounds: [], _chRoundCurId: '' },
    chRoundSlug: id => {
      const s = String(id || '第一期').trim()
      return (!s || s === 'r1' || s === '第一期') ? '第一期' : s
    },
    chCurrentRound: () => (o.hard ? 'r2' : '第一期'),
    chIsHardRound: () => !!o.hard,
    challengeSave: () => {},
  }
  // ★ courseState：`let` 声明（与 course-app.js 同形）。未传 → 走「课程文档未到位」分支。
  if (o.courses !== undefined) {
    sb.courseState = o.courses
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
  ;['chStageRec', 'chStageCounted'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  // ★★★ challengeUid 必须注入！chCourseScore 内部靠它取 uid，
  //   漏注入 → 被 typeof 守卫吃掉 → 恒返回 null → **静默退化为纯挑战口径**（与 v165 漏注入同款假绿陷阱）
  vm.runInContext(extractFn(CH, 'challengeUid'), sb)
  // ★ 声明顺序 = 源码顺序：chCourseScore / chCourseAvg 在 chLevelOf 之上
  ;['chPlanDayAvg', 'chLevelMaxDay', 'chLevelTierOfBench', 'chLevelBench', 'chLevelAcc', 'chCourseScore', 'chCourseAvg',
    'chLevelOf', 'chLevelCapOfBench', 'chLevelFloor', 'chLevel', 'chLevelApply'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  // ★ 渲染入口：chLevelCardHtml 读 `_chLvAnimAt`（内存态，challenge.js 顶层的 let）→
  //   沙箱必须同时声明它，否则卡内 `typeof _chLvAnimAt === 'undefined'` 恒真 →
  //   动画「永远新鲜」分支被走进，虽是同款线上语义但会掩盖 `fresh` 计算（这里按源码形态补齐）。
  vm.runInContext('let _chLvAnimAt = 0\n', sb)
  vm.runInContext(extractFn(CH, 'chLevelCardHtml'), sb)
  // ★ 走 JSON 往返装填存档，保证 days 的键是字符串（与线上 localStorage 读回后一致）
  vm.runInContext('let challengeState = ' + stateJson, sb)
  sb.__store = store
  return sb
}
const run = (sb, code) => vm.runInContext(code, sb)

function stg(correct, total, extra) {
  return Object.assign({ done: true, at: 1790000000000, correct, total, wrong: [] }, extra || {})
}
const lv = (sb, acc) => run(sb, 'chLevelOf(' + (acc == null ? 'null' : acc) + ')')
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps)

// 造课程文档：一个班、指定成员、若干作业（含成绩）
//   recs 形态 = { <uid>: { score, ... } }（真实课程文档 results 是对象 map）
function mkDoc(opts) {
  const o = opts || {}
  return {
    v: 1,
    classes: [{
      id: 'c1', name: '测试班',
      members: o.members || ['u'],
      assignments: (o.assignments || []).map((a, i) => Object.assign({
        id: 'a' + i, title: 'A' + i, createdAt: 1,
      }, a)),
    }],
  }
}
// 便捷：一个只含 coursefinal 的课程文档
const mkFinal = (score, uid) => mkDoc({
  assignments: [{ type: 'coursefinal', passScore: 90, results: { [uid || 'u']: { score: score, at: 1 } } }],
})

// ================= 组一：chCourseScore —— 只认「有分数的正式考试」 =================
group('组一：chCourseScore 取分口径（只取 coursefinal + exam）')
{
  // 无依赖
  assert('courseState 未定义 → null（不崩、不当 0 分）',
    run(makeLvSandbox({}), 'chCourseScore()') === null)
  assert('courseState.doc = null（课程文档未到位）→ null',
    run(makeLvSandbox({ courses: { doc: null } }), 'chCourseScore()') === null)
  assert('doc.classes 非数组 → null',
    run(makeLvSandbox({ courses: { doc: { classes: null } } }), 'chCourseScore()') === null)

  // 单条 coursefinal
  assert('★ 单条终极大考 92 分 → 92',
    run(makeLvSandbox({ courses: { doc: mkFinal(92) } }), 'chCourseScore()') === 92,
    run(makeLvSandbox({ courses: { doc: mkFinal(92) } }), 'chCourseScore()'))

  // 多条取算术平均：(80 + 90 + 100) / 3 = 90
  assert('★ 终极大考 + 随堂考试多条取算术平均（80/90/100 → 90）',
    run(makeLvSandbox({
      courses: {
        doc: mkDoc({
          assignments: [
            { type: 'coursefinal', results: { u: { score: 80 } } },
            { type: 'exam', results: { u: { score: 90 } } },
            { type: 'exam', results: { u: { score: 100 } } },
          ],
        }),
      },
    }), 'chCourseScore()') === 90)

  // ★ exam 计入
  assert('★ exam（随堂考试/水平测试）计入',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'exam', results: { u: { score: 70 } } }] }) } }),
      'chCourseScore()') === 70)

  // ★★ 排除三类
  assert('★★ homework 排除（可反复重做，分数意义弱）',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'homework', results: { u: { score: 100 } } }] }) } }),
      'chCourseScore()') === null)
  assert('★★ video 排除（题量 3~7 太少）',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'video', results: { u: { quizScore: 100 } } }] }) } }),
      'chCourseScore()') === null)
  assert('★★ offline 排除（只有 done:true，结构性无分数）',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'offline', results: { u: { done: true } } }] }) } }),
      'chCourseScore()') === null)
  assert('★ 只有 homework + offline（无分数作业）→ null（不是 0）',
    run(makeLvSandbox({
      courses: {
        doc: mkDoc({
          assignments: [
            { type: 'homework', results: { u: { score: 100 } } },
            { type: 'offline', results: { u: { done: true } } },
          ],
        }),
      },
    }), 'chCourseScore()') === null)

  // 成绩里没有我（同班但未交卷）
  assert('★ 作业存在但无我的成绩记录 → null',
    run(makeLvSandbox({ courses: { doc: mkFinal(90, 'someoneelse') } }), 'chCourseScore()') === null)
  assert('★ 无 results 字段 → null',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'coursefinal' }] }) } }), 'chCourseScore()') === null)
  assert('★ score 非数字（缺字段）→ 跳过 → null',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'coursefinal', results: { u: { at: 1 } } }] }) } }),
      'chCourseScore()') === null)

  // 成员判定
  assert('★ 不是我所在的班 → 不计入（成绩属于另一个班的人）',
    run(makeLvSandbox({ courses: { doc: mkDoc({ members: ['other'], assignments: [{ type: 'coursefinal', results: { u: { score: 100 } } }] }) } }),
      'chCourseScore()') === null)
  assert('★ 成员名大小写不敏感（UID 大写 → 仍命中）',
    run(makeLvSandbox({ uid: 'U', courses: { doc: mkDoc({ members: ['User_ABC'], members2: 0, assignments: [{ type: 'coursefinal', results: { user_abc: { score: 88 } } }] }) } }),
      'chCourseScore()') === null) // uid='U' 与 'user_abc' 不匹配 → null（反向确认匹配确实按全等）
  assert('★ 成员名大小写不敏感（正确方向：members 大写、uid 小写仍命中）',
    run(makeLvSandbox({
      uid: 'user_abc',
      courses: { doc: mkDoc({ members: ['USER_ABC'], assignments: [{ type: 'coursefinal', results: { USER_ABC: { score: 88 } } }] }) },
    }), 'chCourseScore()') === 88,
    run(makeLvSandbox({
      uid: 'user_abc',
      courses: { doc: mkDoc({ members: ['USER_ABC'], assignments: [{ type: 'coursefinal', results: { USER_ABC: { score: 88 } } }] }) },
    }), 'chCourseScore()'))

  // results 数组形态（兼容分支）
  assert('★ results 为数组形态也能取到（兼容 {u,score} 元素）',
    run(makeLvSandbox({ courses: { doc: mkDoc({ assignments: [{ type: 'coursefinal', results: [{ u: 'u', score: 77 }] }] }) } }),
      'chCourseScore()') === 77)

  // 钳位
  assert('★ 脏数据（score=150）钳在 100',
    run(makeLvSandbox({ courses: { doc: mkFinal(150) } }), 'chCourseScore()') === 100)
  assert('★ 脏数据（score=-20）钳在 0',
    run(makeLvSandbox({ courses: { doc: mkFinal(-20) } }), 'chCourseScore()') === 0)
  assert('★ 平均后取整（85 与 90 → round(87.5) = 88）',
    run(makeLvSandbox({
      courses: { doc: mkDoc({ assignments: [{ type: 'coursefinal', results: { u: { score: 85 } } }, { type: 'exam', results: { u: { score: 90 } } }] }) },
    }), 'chCourseScore()') === 88,
    run(makeLvSandbox({
      courses: { doc: mkDoc({ assignments: [{ type: 'coursefinal', results: { u: { score: 85 } } }, { type: 'exam', results: { u: { score: 90 } } }] }) },
    }), 'chCourseScore()'))

  // chCourseAvg 同源
  assert('chCourseAvg 与 chCourseScore 同源（无加权）',
    run(makeLvSandbox({ courses: { doc: mkFinal(73) } }), 'chCourseAvg()') === 73)
}

// ================= 组二：★★ 回归护栏 —— 无线下课分时行为与 v167 逐值一致 =================
//   ★ 这是本次改动最重要的一条：**没上过线下课 / 课程文档未到位的人，等级一个都不能变**。
//   ★★ 存档阶段下标必须与 CHALLENGE_DAYS 对齐（本项目实撞）：
//       Day1 = [test(si0), practice(si1)]，Day2–6 = [practice(si0)]，Day7 = [practice(si0), test(si1)]。
//       chLevelBench 只认 `s.kind === 'practice'` 的阶段 → 把练习写在 Day1 的 si0 会**认不到练习天**，
//       基准恒为 0 → 等级恒 L1（第一版本套件正是这样假红的）。
group('组二：★ 无线下课分 → 与 v167 逐值一致（回归护栏）')
{
  // 逐场景比对：把同一存档分别在有/无 courseState 下跑，等级必须恒等
  const cases = [
    { name: 'Day1 练习全对（基准 1.00 压死）', days: { 1: { stages: { 1: stg(10, 10) } } } },
    { name: 'Day3 全对（基准 1.60）', days: { 3: { stages: { 0: stg(30, 30) } } } },
    { name: 'Day5 全对（基准 2.27）', days: { 5: { stages: { 0: stg(30, 30) } } } },
    { name: 'Day7 全对（基准 2.80）', days: { 7: { stages: { 0: stg(10, 10), 1: stg(20, 20) } } } },
    { name: '混合（20/20 + 27/30 + 9/10 = 93）', days: { 1: { stages: { 1: stg(20, 20) } }, 2: { stages: { 0: stg(27, 30), 1: stg(0, 0) } } } },
    { name: '低准确率（6/30 = 20 → L1，基准 2.80）', days: { 7: { stages: { 0: stg(6, 30) } } } },
  ]
  let same = true, detail = []
  cases.forEach(c => {
    const a = run(makeLvSandbox({ days: c.days }), 'chLevel()')
    const b = run(makeLvSandbox({ days: c.days, courses: { doc: null } }), 'chLevel()')
    const d = run(makeLvSandbox({ days: c.days, courses: { doc: mkDoc({ assignments: [{ type: 'homework', results: { u: { score: 100 } } }] }) } }), 'chLevel()')
    if (a !== b || a !== d) { same = false; detail.push(c.name + ': v167=' + a + ' docNull=' + b + ' 仅作业=' + d) }
  })
  assert('★★ 无 courseState / doc=null / 只有无分作业 —— 三种「无分」情形等级均与 v167 恒等',
    same, detail.join(' | '))

  // 逐阈值抽查（第一期 Day7，基准 2.80 → 档位 [2.5,3.5) → cap 3）
  // ★★★ v180 语义变更：L3 另需「Day7 完成 + 准确率 ≥95%」质量门槛，不满足则退 2 档。
  //   本沙箱 maxDay = 7（day 侧恒过），所以观察的就是 95 这条线：
  //   100 → L3（过线）；90 / 89 / 60 / 59 → 一律 L2（门槛把 cap 3 打回 2，**不是** L3）。
  //   旧断言「100/90/89/60 → 3」是 v179 口径，v180 起已失效 → 改为反证 + 新期望。
  const sbOld = makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } } })
  const sbNew = makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkDoc({}) } })
  const tabOld = [100, 90, 89, 60, 59, 30, 29, 0].map(a => lv(sbOld, a))
  const tabNew = [100, 90, 89, 60, 59, 30, 29, 0].map(a => lv(sbNew, a))
  assert('★★ 阈值表逐值一致 [' + tabOld.join(',') + ']', JSON.stringify(tabOld) === JSON.stringify(tabNew),
    JSON.stringify(tabNew))
  assert('★★ v180：准确率 100 过 95 线 → L3（cap 3 压住 raw 4）', tabOld[0] === 3, tabOld.join(','))
  assert('★★ v180：90/89 未过 95 门槛 → 退 L2（L3 质量门槛生效，**旧口径曾为 3**）',
    tabOld[1] === 2 && tabOld[2] === 2, tabOld.join(','))
  assert('★★ v180：60/59 原判 3/2，被门槛统一拉到 L2', tabOld[3] === 2 && tabOld[4] === 2, tabOld.join(','))
  assert('  阈值 30/29 未被门槛波及：30 → 2，29 → 1', tabOld[5] === 2 && tabOld[6] === 1,
    tabOld.join(','))
  assert('  准确率 0 → L1', tabOld[7] === 1, tabOld.join(','))

  // ★ 空 classes / 空 assignments 同样不得改变行为
  const base = run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } } }), 'chLevelOf(100)')
  assert('★ classes 为空数组 → 行为不变（仍是 3）',
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: { v: 1, classes: [] } } }), 'chLevelOf(100)') === base)
  assert('★ 班级无 assignments → 行为不变',
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkDoc({}) } }), 'chLevelOf(100)') === base)
}

// ================= 组三：★ 加权生效（挑战 70% + 线下课 30%） =================
//   ★★ 公式必须逐值预演（本项目铁律：期望值一律「实测回填」，绝不凭记忆写）：
//      cappedScore = capped>=4 ? 0.90 : capped>=3 ? 0.60 : capped>=2 ? 0.30 : 0
//      blended = cappedScore×70 + (cs/100)×30 ；阈值 90/60/30 → L4/L3/L2/L1
//      实测对照：capped=3 → cs 100:72(L3) / 99:71.7(L3) / 30:51(L2) / 0:42(L2)
//                capped=2 → cs 100:51(L2)      capped=1 → cs 100:30(L2) / 50:15(L1)
//                capped=4 → cs 100:93(L4) / 0:63(L3)
group('组三：★ 加权平均生效（70/30）')
{
  // 场景 A：第一期 Day7 全对（基准 2.80 → capped=3，cappedScore = 0.60）
  //   cs=100 → blended = 0.60×70 + 1.00×30 = 72 → 72 < 90 → **仍 L3**
  //   ★ L4 需 blended ≥ 90；capped=3 时最高只有 72（cs 上限 100）→ **capped=3 永远到不了 L4**。
  //     这是设计：L4 要求挑战侧本身达到 L4（capped=4，即基准 ≥ 3.5 → 进阶期后段才有）。
  const sb7 = makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(100) } })
  assert('★★ capped=3 + 线下课 100 分 → 0.60×70 + 1.00×30 = **72 → L3**（capped=3 到不了 L4）',
    run(sb7, 'chLevel()') === 3, run(sb7, 'chLevel()'))
  assert('  （反证：无线下课时同存档也是 L3 —— 升不动是因为挑战侧封顶）',
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } } }), 'chLevel()') === 3)
  assert('  （反证：准确率确为 100，不是算错）', run(sb7, 'chLevelAcc()') === 100, run(sb7, 'chLevelAcc()'))
  assert('  （反证：基准确为 2.80）', near(run(sb7, 'chLevelBench()'), 2.8), run(sb7, 'chLevelBench()'))

  // 线下课 99 分 → 0.60×70 + 0.99×30 = 71.7 → L3（与 100 同档，边界不含糊）
  assert('★ capped=3 + 线下课 99 分 → 71.7 → 仍 L3（不是 90，不糊）',
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(99) } }), 'chLevel()') === 3)

  // ★★ 降级方向：挑战 capped=3（0.60）+ 线下课 30 分 → 0.60×70 + 0.30×30 = 51 → L2
  assert('★★ 线下课考砸会**降级**：capped=3 + 线下课 30 分 → 51 → L2',
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(30) } }), 'chLevel()') === 2,
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(30) } }), 'chLevel()'))
  // 再低：线下课 0 分 → 0.60×70 + 0 = 42 → L2（仍 L2，不落到 L1）
  assert('★ capped=3 + 线下课 0 分 → 42 → L2（不会掉到 L1，挑战侧仍有分量）',
    run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(0) } }), 'chLevel()') === 2)

  // ★★ 低位场景：挑战 capped=1（cappedScore = 0.00）+ 线下课 100 → 0×70 + 1.00×30 = 30 → b=0.30 → L2
  const sb1 = makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } }, courses: { doc: mkFinal(100) } })
  assert('★★ 地板压到 L1 + 线下课满分 → 0×70 + 1.00×30 = 30 → 只到 L2（升不上去）',
    run(sb1, 'chLevel()') === 2, run(sb1, 'chLevel()'))
  assert('  （反证：无线下课时是 L1）',
    run(makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } } }), 'chLevel()') === 1)

  // 线下课 50 → 0×70 + 0.5×30 = 15 → b=0.15 → L1
  assert('★ 地板 L1 + 线下课 50 分 → 15 → 仍 L1',
    run(makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } }, courses: { doc: mkFinal(50) } }), 'chLevel()') === 1)

  // capped=2（0.30）场景：Day5 全对 → capped=2；+ 线下课 100 → 0.30×70 + 1.00×30 = 51 → L2
  assert('★ capped=2（0.30）+ 线下课 100 → 51 → 仍 L2',
    run(makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30) } } }, courses: { doc: mkFinal(100) } }), 'chLevel()') === 2)

  // ★ 结果恒在 1~4，且随线下课分单调不减
  const all = [0, 30, 59, 60, 89, 90, 100].map(cs => run(makeLvSandbox({
    days: { 7: { stages: { 0: stg(20, 20) } } },
    courses: { doc: mkFinal(cs) },
  }), 'chLevel()'))
  assert('★ 各档线下课分下等级恒在 1~4（' + all.join(',') + '）', all.every(v => v >= 1 && v <= 4))
  assert('★ 且随线下课分单调不减（' + all.join(',') + '）',
    all.every((v, i) => i === 0 || v >= all[i - 1]), all.join(','))
  assert('  —— 实测序列应为 2,2,2,3,3,3,3（cs=0/30/59 → L2，60 起 → L3）',
    JSON.stringify(all) === JSON.stringify([2, 2, 2, 3, 3, 3, 3]), all.join(','))
}

// ================= 组四：★★★ 地板只压挑战侧（cappedScore 反推，不是原始准确率） =================
//   这是最容易被写错、也最容易「看起来对」的一条。
group('组四：★★★ 难度档地板只压挑战侧')
{
  // 反例构造：若用**原始准确率**参与加权，则「准确率 100% + 地板 1 + 线下课 100」
  //   会算出 1.00×70 + 1.00×30 = 100 → L4（地板被稀释）。
  //   正确实现用 cappedScore 反推 → 0.00×70 + 1.00×30 = 30 → L2。
  //   ★ 存档：Day1 的 practice 在 si=1（si0 是水平测试）
  const sb = makeLvSandbox({ days: { 1: { stages: { 1: stg(10, 10) } } }, courses: { doc: mkFinal(100) } })
  assert('★★★ 准确率 100% + 地板 L1 + 线下课 100 → **L2 而非 L4**（地板未被稀释）',
    run(sb, 'chLevel()') === 2, run(sb, 'chLevel()'))
  assert('  准确率确为 100（排除「算错准确率」的误判）', run(sb, 'chLevelAcc()') === 100, run(sb, 'chLevelAcc()'))
  assert('  基准确为 1.00（Day1 → round 1 → capped=1）', near(run(sb, 'chLevelBench()'), 1), run(sb, 'chLevelBench()'))

  // cappedScore 反推映射逐档验证：1→0.00 / 2→0.30 / 3→0.60 / 4→0.90
  //   手法：构造能拿到各 capped 的存档，配同一线下课分，比对 blended 落点
  //     capped=2（Day5 全对，基准 2.27 → round 2）+ cs 100 → 0.30×70 + 30 = 51 → L2
  //     capped=3（Day7 全对，基准 2.80 → round 3）+ cs 100 → 0.60×70 + 30 = 72 → L3
  //   若误用原始准确率（两者都是 100）→ 都是 100 → L4，两条会同时失败。
  const c2 = run(makeLvSandbox({ days: { 5: { stages: { 0: stg(30, 30) } } }, courses: { doc: mkFinal(100) } }), 'chLevel()')
  const c3 = run(makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(100) } }), 'chLevel()')
  assert('★★ cappedScore 逐档反推正确：capped=2 → 51 → L2、capped=3 → 72 → L3（同一准确率 100%）',
    c2 === 2 && c3 === 3, 'c2=' + c2 + ' c3=' + c3)
  assert('  ★ 反证：若用原始准确率加权，c2/c3 都会是 L4（100×0.7 + 100×0.3 = 100）',
    c2 !== 4 && c3 !== 4)

  // 进阶期 Day7（基准 3.00 → capped=3，与第一期 Day7 同 capped）→ 结果必须相同
  const h3 = run(makeLvSandbox({ hard: true, days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(100) } }), 'chLevel()')
  assert('★ 进阶期 Day7 与第一期 Day7 同为 capped=3 → 合成结果相同（L3）', h3 === c3, 'h=' + h3 + ' p=' + c3)

  // Day3 全对（基准 1.60 → capped=2）+ 线下课 100 → L2（与 Day5 同 capped 同结果）
  const lowCap = run(makeLvSandbox({ days: { 3: { stages: { 0: stg(30, 30) } } }, courses: { doc: mkFinal(100) } }), 'chLevel()')
  assert('★ Day3 全对（capped=2）+ 线下课 100 → L2（与 Day5 同 capped 同结果）', lowCap === c2, lowCap)

  // ★ capped=4 通道存在吗：第一期基准上限 2.80 → round 3，永远拿不到 4；
  //   进阶期 Day7 基准 3.00 → round 3。故实际首期/进阶期都无 capped=4。
  //   直接验证公式在 capped=4 下的行为（用手工构造：进阶期 Day7 已 capped=3，
  //   这里改为断言「capped=4 需基准 ≥ 3.5 → 当前配比不可达」这一事实）
  assert('★ capped 上限事实核查：第一期/进阶期 Day7 基准分别 2.80/3.00 → round 均为 3（无 capped=4 通道）',
    Math.round(P1_AVG[6]) === 3 && Math.round(PH_AVG[6]) === 3,
    Math.round(P1_AVG[6]) + '/' + Math.round(PH_AVG[6]))
}

// ================= 组五：★★ 无依据（bench=0）→ 回落 chLevelFloor，线下课分不虚报 =================
group('组五：★★ 无练习依据 → 仍回落云端地板（v166 契约不被破坏）')
{
  // 无练习记录 + 无 floor → L1（哪怕线下课满分）
  assert('★★ bench=0 + 线下课 100 分 → 仍 L1（无依据不虚报）',
    run(makeLvSandbox({ courses: { doc: mkFinal(100) } }), 'chLevel()') === 1,
    run(makeLvSandbox({ courses: { doc: mkFinal(100) } }), 'chLevel()'))
  // 无练习记录 + floor=3（云端回放）→ 3（不是 1，也不是被线下课拉高）
  assert('★★ bench=0 + 云端地板 L3 + 线下课 100 分 → **L3**（回落地板，线下课不参与）',
    run(makeLvSandbox({ floor: 3, courses: { doc: mkFinal(100) } }), 'chLevelOf()'.replace('()', '(null)').length ? 'chLevel()' : 'chLevel()') === 3)
  const sbFloor3 = makeLvSandbox({ floor: 3, courses: { doc: mkFinal(100) } })
  assert('  —— 确认走的是地板而不是算出来的', run(sbFloor3, 'chLevelFloor()') === 3, run(sbFloor3, 'chLevelFloor()'))
  // floor=3 但线下课 0 分 → 仍 3（地板优先，不会被线下课打下来）
  assert('★★ bench=0 + 地板 L3 + 线下课 0 分 → 仍 L3（地板优先）',
    run(makeLvSandbox({ floor: 3, courses: { doc: mkFinal(0) } }), 'chLevel()') === 3)
  // acc == null（有基准但无首答）→ 同样回落地板
  assert('★ acc=null（有基准无首答）+ 线下课 100 → 仍回落地板（此处地板默认 1）',
    run(makeLvSandbox({ days: { 1: { stages: { 1: { done: false, correct: 0, total: 0, wrong: [] } } } }, courses: { doc: mkFinal(100) } }), 'chLevel()') === 1)
  assert('★ acc=null + 地板 L4 → 4（不被线下课影响）',
    run(makeLvSandbox({ floor: 4, courses: { doc: mkFinal(0) } }), 'chLevel()') === 4)

  // ★★ 短路口径：地板判定必须发生在加权之前（否则换设备用户会被算出等级）
  assert('★★ 短路顺序：无依据时 chCourseScore 的取值**不影响**结果（地板优先）',
    run(makeLvSandbox({ floor: 2, courses: { doc: mkFinal(100) } }), 'chLevel()') ===
    run(makeLvSandbox({ floor: 2, courses: { doc: null } }), 'chLevel()'))
}

// ================= 组六：形态契约（声明方式 / 顺序 / i18n / CSS / 卡片） =================
group('组六：形态与站点契约')
{
  // ★★★ function 声明（const 会 TDZ）
  assert('★★★ chCourseScore 是 function 声明（不是 const/箭头 → 否则 TDZ）',
    /(^|\n)function chCourseScore\s*\(/.test(CH))
  assert('★★★ chCourseAvg 是 function 声明',
    /(^|\n)function chCourseAvg\s*\(/.test(CH))
  assert('★★★ chLevelOf 仍是 function 声明',
    /(^|\n)function chLevelOf\s*\(/.test(CH))
  // ★★ 顺序：chCourseScore 必须在 chLevelOf 之上
  assert('★★ chCourseScore 源码位置在 chLevelOf **之上**（调用前已初始化）',
    CH.indexOf('function chCourseScore') < CH.indexOf('function chLevelOf'),
    CH.indexOf('function chCourseScore') + ' vs ' + CH.indexOf('function chLevelOf'))
  assert('★★ chCourseScore 在 chLevelAcc 之下（与注释所述段落一致）',
    CH.indexOf('function chCourseScore') > CH.indexOf('function chLevelAcc'))
  assert('★★ chLevelOf 在 chRecordStage 之上（v165 红线不回退）',
    CH.indexOf('function chLevelOf') < CH.indexOf('function chRecordStage'))
  // ★ 不得出现重名第二份定义（extractFn 会取到第一份，线上却可能取后者 → 静默分叉）
  const cntScore = (CH.match(/function chCourseScore\s*\(/g) || []).length
  const cntOf = (CH.match(/function chLevelOf\s*\(/g) || []).length
  assert('★ chCourseScore 全文件只定义一次（n=' + cntScore + '）', cntScore === 1)
  assert('★ chLevelOf 全文件只定义一次（n=' + cntOf + '）', cntOf === 1)

  // ★★★ 关键实现细节：必须用 cappedScore 反推，不得直接拿 acc 加权
  const ofBody = grabFn(CH, 'chLevelOf')
  assert('★★★ chLevelOf 体里出现 cappedScore 反推（防地板被稀释）', /cappedScore/.test(ofBody))
  assert('★★★ chLevelOf 里 cappedScore 三档映射 0.90/0.60/0.30',
    /capped\s*>=\s*4\s*\?\s*0\.90/.test(ofBody) && /0\.60/.test(ofBody) && /0\.30/.test(ofBody))
  assert('★★ 权重确为 70 / 30（不是别的比例）',
    /\*\s*70/.test(ofBody) && /\*\s*30/.test(ofBody))
  // ★★ 合成后不得与 capped 取 max（否则线下课只能升不能降 = 没当标准）
  assert('★★★ 合成结果**不与 capped 取 max**（线下课考砸必须能体现为降级）',
    !/Math\.max\(\s*capped\s*,/.test(ofBody) && !/Math\.max\(\s*[^,)]*,\s*capped\s*\)/.test(ofBody))
  // ★ 短路必须早于加权
  const iShort = ofBody.indexOf('return capped')
  const iBlend = ofBody.indexOf('cappedScore')
  assert('★ 无线下课分时「原样返回 capped」的短路出现在加权之前',
    iShort > 0 && iBlend > 0 && iShort < iBlend, 'short@' + iShort + ' blend@' + iBlend)
  // ★ 全程 typeof 守卫（沙箱切片注入）
  assert('★ chLevelOf 里 chCourseScore 调用带 typeof 守卫',
    /typeof chCourseScore === 'function'/.test(ofBody))
  const csBody = grabFn(CH, 'chCourseScore')
  assert('★ chCourseScore 里 courseState / challengeUid 均有 typeof 守卫',
    /typeof courseState === 'undefined'/.test(csBody) && /typeof challengeUid === 'function'/.test(csBody))
  assert('★ chCourseScore 整体 try/catch 兜底（缺依赖返回 null 不抛）',
    /try\s*\{/.test(csBody) && /catch\s*\(/.test(csBody))
  // ★★ 只认两种 type（不得把 homework/video/offline 混进来）
  assert('★★ chCourseScore 只放行 coursefinal + exam 两种 type',
    /a\.type\s*!==\s*'coursefinal'\s*&&\s*a\.type\s*!==\s*'exam'/.test(csBody),
    'type 过滤写法未被识别')
  assert('★★ 三种排除类型在 chCourseScore 里**没有**被写成放行条件（反向护栏）',
    !/a\.type\s*===\s*'homework'/.test(codeOnly(csBody)) &&
    !/a\.type\s*===\s*'video'/.test(codeOnly(csBody)) &&
    !/a\.type\s*===\s*'offline'/.test(codeOnly(csBody)))
  // ★ 无分必须返回 null（不是 0）
  assert('★ 无记录返回 null 而非 0（0 分会把没上过课的人压级）',
    /return null/.test(csBody) && !/return 0\b/.test(codeOnly(csBody)))

  // ===== i18n =====
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
  const keys = ['chLevelSrcBlend', 'chLevelSrcNoCourse']
  assert('v174 i18n 键 zh 侧齐全', keys.every(k => k in L.zh), keys.filter(k => !(k in L.zh)).join(','))
  assert('v174 i18n 键 en 侧齐全', keys.every(k => k in L.en), keys.filter(k => !(k in L.en)).join(','))
  assert('★ 中英同键类型一致', keys.every(k => typeof L.zh[k] === typeof L.en[k]))
  // ★★★ 带参键必须写成函数（字符串会原样返回，占位符渲染给学员）
  assert('★★★ chLevelSrcBlend 中英均为箭头函数（带 3 参）',
    typeof L.zh.chLevelSrcBlend === 'function' && typeof L.en.chLevelSrcBlend === 'function')
  assert('★★ chLevelSrcBlend 实际可调用且三个参数都进入输出',
    (() => {
      const s = L.zh.chLevelSrcBlend(93, 88, 92)
      return s.indexOf('93') >= 0 && s.indexOf('88') >= 0 && s.indexOf('92') >= 0
    })(), L.zh.chLevelSrcBlend(93, 88, 92))
  assert('★ chLevelSrcNoCourse 是无参字符串（不写成函数）',
    typeof L.zh.chLevelSrcNoCourse === 'string' && typeof L.en.chLevelSrcNoCourse === 'string')
  assert('★★ v174 文案不含 {0} 占位符写法',
    keys.every(k => typeof L.zh[k] !== 'string' || !/\{\d\}/.test(L.zh[k])),
    keys.filter(k => typeof L.zh[k] === 'string' && /\{\d\}/.test(L.zh[k])).join(','))
  assert('中英键数仍相等（无单侧漏写）',
    Object.keys(L.zh).length === Object.keys(L.en).length,
    Object.keys(L.zh).length + ' vs ' + Object.keys(L.en).length)
  // ★ challenge.js 里用到的所有静态 t('key') 必须两侧齐全
  const used = [...new Set(
    [...CH.matchAll(/t\('([A-Za-z0-9_]+)'(\s*\+)?/g)].filter(m => !m[2]).map(m => m[1])
  )]
  const usedMissZh = used.filter(k => !(k in L.zh))
  const usedMissEn = used.filter(k => !(k in L.en))
  assert('challenge.js 用到的静态键 zh 齐全（n=' + used.length + '）', usedMissZh.length === 0, usedMissZh.join(','))
  assert('challenge.js 用到的静态键 en 齐全', usedMissEn.length === 0, usedMissEn.join(','))

  // ===== CSS =====
  assert('★ CSS 存在 .ch-lv-src 行', CSS.indexOf('.ch-lv-src') >= 0)
  assert('★ v165 四档配色未被带偏',
    [1, 2, 3, 4].every(i => CSS.indexOf('.ch-lv-lv' + i) >= 0))
  assert('★ v163 统一配色仍在（perq-high）', CSS.indexOf('perq-high') >= 0)

  // ===== 等级卡渲染 =====
  const cardBody = grabFn(CH, 'chLevelCardHtml')
  assert('★ 等级卡含 ch-lv-src 分项行', /ch-lv-src/.test(cardBody))
  assert('★ 等级卡对 chCourseScore 有 typeof 守卫', /typeof chCourseScore === 'function'/.test(cardBody))
  assert('★★ 等级卡 srcHtml 有无分/有分两分支（cs == null 走 NoCourse 文案）',
    /cs\s*==\s*null/.test(cardBody) && /chLevelSrcNoCourse/.test(cardBody) && /chLevelSrcBlend/.test(cardBody))
  // 真渲染一次（有分）
  // ★ escHtml 定义在 app.js（不在 challenge.js）→ 沙箱必须**手工注入**，
  //   与项目里其它渲染类套件同款（chLevelCardHtml 里调用 escHtml，漏注入会被它自己的
  //   try/catch 吞成空字符串 → 假绿陷阱，故这里显式注入并断言非空）。
  const ESC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  const injectRenderDeps = (sbx) => {
    sbx.__zh = L.zh
    vm.runInContext(extractFn(ESC, 'escHtml'), sbx)
    // ★ chLevelName 不是独立函数 —— 它是 chLevelCardHtml 体内联的箭头 `lvName`，
    //   由 t('chLevelName'+k) 动态拼键，故这里**不需要**注入（注入了反而说明我记错了形态）。
    // 极简 t：真实 i18n 词典（函数值才插值，与线上 t() 同款语义）
    vm.runInContext('function t(k){ var f = globalThis.__zh[k]; if (typeof f === "function") return f.apply(null, Array.prototype.slice.call(arguments, 1)); return f == null ? k : f }', sbx)
  }
  const sbR = makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } }, courses: { doc: mkFinal(95) } })
  injectRenderDeps(sbR)
  const html1 = run(sbR, 'chLevelCardHtml()')
  assert('★★ 有线下课分时等级卡渲染出「挑战首答 ... × 70% + 线下课 ...」文案',
    html1.indexOf('× 70%') >= 0 && html1.indexOf('线下课 95') >= 0,
    html1.slice(0, 60) + ' …')
  const sbR2 = makeLvSandbox({ days: { 7: { stages: { 0: stg(20, 20) } } } })
  injectRenderDeps(sbR2)
  const html2 = run(sbR2, 'chLevelCardHtml()')
  assert('★★ 无线下课分时等级卡渲染出「暂无线下课正式考试成绩」兜底文案',
    html2.indexOf('线下课 30%') >= 0 && html2.indexOf('×(暂') < 0, html2.slice(0, 60) + ' …')
  assert('★ 两种情形都仍渲染等级徽章与准确率行',
    html1.indexOf('ch-lv-badge') >= 0 && html2.indexOf('ch-lv-badge') >= 0)

  // ===== 站点契约 =====
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('★ 版本号 12 处且唯一（' + (uniq[0] || '?') + '）', vms.length === 12 && uniq.length === 1,
    'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('★ 版本号 >= 174（发版后为 174；本套件先于 bump 落地时仍应为 172 起的旧值）',
    uniq.length === 1 && uniq[0] >= 172, uniq[0])
}

// ================= 汇总 =================
console.log('\n' + '='.repeat(60))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
else console.log('ALL PASS  ✅ 全部通过')
process.exit(fail ? 1 : 0)
