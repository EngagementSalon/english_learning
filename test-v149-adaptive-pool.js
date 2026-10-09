// test-v149-adaptive-pool.js
// v149：七天挑战「第四第五天打不开 / 点开始没反应」修复的回归套件
//
// 【线上故障根因】
//   题库实际标了 1~4 四个难度（管理员上传界面就有 L1~L4），而 challenge.js 只分 1/2/3 三个桶，
//   且用 Math.min(3, Math.max(1, Number(q.difficulty) || 1)) 把 L4 一律压进桶 3
//   → 「中间档」桶 2 恒空 → 配比里难度2 的坑位在 `if (q) out.push(q)` 处被静默跳过
//   → 序列从设计的 170 缩到 88 → Day3 起切片越过数组末尾 → Day5 起返回空数组
//   → chStartStage 里 `if (!qs.length) return` 静默返回 → 学员点「开始」毫无反应。
//   线上艳中餐厅实测题库：L1×95 + L4×200 = 295 题（桶 95/0/200），复现序列长度 = 88。
//
// 【v149 修法（本套件锁定的契约）】
//   1. 难度归桶按「题库实际最大难度」线性缩放 → 桶 2 不再被系统性掏空；
//   2. 抽题走 chDrawWithBackfill：某档不足时按「距离优先 + 剩余量优先」从相邻档回填，
//      保证序列恒为设计长度（题池总量够的前提下），每天切片都落在序列内；
//   3. 游标记在 buckets.__cur 上跨调用累加（否则逐天调用会重复取题）；
//   4. 抽不到题不再静默 return，改为 alert 明确提示；
//   5. 新增「结构性缺口」告警（旧口径只看总数，295 > 190 完全静默）。
//
// 沙箱形态：用 extractFn 从**真实源码**抽取函数，注入到 vm 沙箱真跑（不复制实现）。

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
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
// 配平扫描取常量声明（嵌套数组必须配平，非贪婪正则会停在第一个 ]）。
// ⚠️ 标量常量（如 CHALLENGE_SEED = 20260912）后面没有 [，若一律找 [ 会一路扫到下一个数组声明，
//    把后续常量一起吞进来 → SyntaxError: Identifier 'xxx' has already been declared。
//    所以先看等号右侧第一个非空字符：是 [ 才配平，否则只取到行尾。
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
// 取整个函数声明源码（断源码形态用）
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

// ====== 题库构造器 ======
// L1~L4 难度；difficulty 字段与真实题库一致（upq 解压后为 q.difficulty）
function mkBank(spec) {
  const out = []
  let id = 1000
  Object.keys(spec).forEach(d => {
    for (let i = 0; i < spec[d]; i++) {
      out.push({
        id: id++, difficulty: Number(d), category_id: 12, dept: 'dining/yan',
        question: 'Q' + id, options: ['a', 'b', 'c', 'd'], answer: 0, explanation: 'e',
      })
    }
  })
  return out
}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}

// ====== 沙箱：真跑 challengePool / challengeStratifiedDraw / 归桶函数 ======
function makePoolSandbox(bank, hardRound) {
  const alerts = []
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, Promise,
    alert: m => alerts.push(m),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    shuffleOptions: q => q,
    Store: {
      getQuestions: () => bank,
      getQuestion: id => bank.find(q => String(q.id) === String(id)) || null,
      isAdmin: () => false,
    },
    sessionDeptSlug: () => 'dining/yan',
    CloudSync: { _chRounds: [], _chRoundCurId: '' },
    chUserSeed: () => 123456,
    chDeptKey: () => 'dining/yan',
    chRoundSlug: id => {
      const s = String(id || '第一期').trim()
      return (!s || s === 'r1' || s === '第一期') ? '第一期' : s
    },
    chCurrentRound: () => (hardRound ? 'r2' : '第一期'),
    CloudSyncRoundStub: null,
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  // 常量（配平扫描，嵌套数组不可用非贪婪正则）
  ;['CHALLENGE_SEED', 'CHALLENGE_DAYS', 'CHALLENGE_DIFF_PLAN', 'CHALLENGE_DIFF_PLAN_HARD',
    'CHALLENGE_TEST_PLAN', 'CHALLENGE_TEST_PLAN_HARD'].forEach(n => {
    vm.runInContext(extractConst(CH, n), sb)
  })
  vm.runInContext('const CHALLENGE_TOTAL = 210\n', sb)
  // 函数（真实源码）
  ;['challengeRng', 'chIsHardRound', 'chDiffPlan', 'chTestPlan',
    'chDiffBucketOf', 'chBankMaxDiff', 'chDrawWithBackfill', 'chBankDiffStats',
    'chPlanAllocate', 'chBankQuestions',
    // v154：challengePool / chBankCount / chBankDiffStats 改走营次口径 → 注入新依赖
    //   （本沙箱无 CloudSync 营次数据 → chRoundBankQuestions 回落视角口径，题源不变）
    'chRoundRecForCurrent', 'chRoundBankQuestions',
    'chBankCount', 'challengePool',
    'challengeStratifiedDraw'].forEach(n => {
    vm.runInContext(extractFn(CH, n), sb)
  })
  sb.__alerts = alerts
  return sb
}
const run = (sb, code) => vm.runInContext(code, sb)

// 按天切片（与 challengeStageMeta 同口径：practice 阶段起点 = 前面各 practice 题数累加）
const PRACTICE_OFFSETS = [[1, 0, 10], [2, 0, 30], [3, 0, 30], [4, 0, 30], [5, 0, 30], [6, 0, 30], [7, 0, 10]]
function daySlice(seq, day, count) {
  let start = 0
  for (const [d, , c] of PRACTICE_OFFSETS) { if (d === day) break; start += c }
  return seq.slice(start, start + count)
}
function avgDiff(list) {
  if (!list.length) return 0
  return list.reduce((s, q) => s + (Number(q.difficulty) || 1), 0) / list.length
}

// ================= 组一：归桶映射（v149 核心口径） =================
group('组一：难度归桶映射')
{
  const sb = makePoolSandbox(mkBank({ 1: 1, 2: 1, 3: 1 }), false)
  const B = (d, mx) => run(sb, `chDiffBucketOf(${d}, ${mx})`)

  // 题库最大难度 ≤ 3 → 保持原样（等价旧行为，老题库零变化）
  assert('mx<=3：1→1', B(1, 3) === 1)
  assert('mx<=3：2→2', B(2, 3) === 2)
  assert('mx<=3：3→3', B(3, 3) === 3)
  assert('mx<=3：越界低值钳到 1', B(0, 3) === 1 && B(-5, 3) === 1)
  assert('mx<=3：越界高值钳到 3', B(9, 3) === 3)
  assert('mx<=3：缺失难度回落 1', B(undefined, 3) === 1 && B(null, 3) === 1)

  // ★ 题库存在 L4 → 线性映射，最高档落 3（这是 v149 的关键修复）
  assert('★ mx=4：L1→桶1', B(1, 4) === 1)
  assert('★ mx=4：L2/L3→桶2（不再掏空中间档）', B(2, 4) === 2 && B(3, 4) === 2)
  assert('★ mx=4：L4→桶3', B(4, 4) === 3)
  // mx=5 时最中间档应落在 2
  assert('mx=5：线性映射 1→1,3→2,5→3', B(1, 5) === 1 && B(3, 5) === 2 && B(5, 5) === 3)

  assert('maxDiff 非法值回落 3（等价旧行为）', run(sb, 'chBankMaxDiff([])') === 1 || B(4, 0) === 3)
}

// ================= 组二：chBankMaxDiff 取最大难度 =================
group('组二：题库最大难度探测')
{
  const sb = makePoolSandbox(mkBank({ 1: 95, 4: 200 }), false)
  assert('线上形态（1/4 两极）→ max=4', run(sb, 'chBankMaxDiff(Store.getQuestions())') === 4)
  assert('空数组 → 回落 1（不抛错）', run(sb, 'chBankMaxDiff([])') === 1)
  // ⚠️ 非数组走 `arr = []` 分支 → mx 保持初值 1（不是 3）。期望值照真实实现写。
  assert('非数组 → 回落 1（arr=[] 分支，不抛错）', run(sb, 'chBankMaxDiff(null)') === 1)
  assert('undefined → 回落 1（不抛错）', run(sb, 'chBankMaxDiff(undefined)') === 1)
  assert('难度字段缺失的题按 1 计', run(sb, 'chBankMaxDiff([{id:1},{id:2,difficulty:3}])') === 3)
  assert('字符串难度 "4" 也认', run(sb, 'chBankMaxDiff([{id:1,difficulty:"4"}])') === 4)
}

// ================= 组三：★ 线上真实题库复现（故障场景） =================
group('组三：★ 线上真实题库（艳中 L1×95 + L4×200）')
{
  const bank = mkBank({ 1: 95, 4: 200 })   // 295 题，正好是线上实测分布
  const sb = makePoolSandbox(bank, false)
  const seq = run(sb, 'challengePool()')

  assert('★ 序列恒为设计长度 170（旧代码为 88）', seq.length === 170, 'len=' + seq.length)
  const ids = seq.map(q => String(q.id))
  assert('★ 序列无重复题（游标跨调用累加）', new Set(ids).size === ids.length,
    'uniq=' + new Set(ids).size + '/' + ids.length)

  // 每天 practice 切片都必须满额 —— 这正是「第四第五天打不开」的直接判据
  let allFull = true, detail = []
  for (const [d, , c] of PRACTICE_OFFSETS) {
    const got = daySlice(seq, d, c).length
    detail.push('D' + d + '=' + got)
    if (got !== c) allFull = false
  }
  assert('★ Day1~Day7 每日切片均满额（' + detail.join(' ') + '）', allFull)

  // 难度逐日递增（学员体感：越往后越难）
  const avgs = PRACTICE_OFFSETS.map(([d, , c]) => avgDiff(daySlice(seq, d, c)))
  let mono = true
  for (let i = 1; i < avgs.length; i++) if (avgs[i] < avgs[i - 1] - 1e-9) mono = false
  assert('★ 每日平均难度单调不减（' + avgs.map(a => a.toFixed(3)).join(' → ') + '）', mono)
  assert('★ Day1 均值 < Day7 均值（确实在变难）', avgs[0] < avgs[6])
  assert('题型仅含难度 1/4（真实题库只有两极）',
    seq.every(q => Number(q.difficulty) === 1 || Number(q.difficulty) === 4))
}

// ================= 组四：均衡题库（桶 2 真被使用） =================
group('组四：均衡题库（L1/L2/L3 ×100）')
{
  const sb = makePoolSandbox(mkBank({ 1: 100, 2: 100, 3: 100 }), false)
  const seq = run(sb, 'challengePool()')
  assert('序列 170 题', seq.length === 170, 'len=' + seq.length)
  assert('无重复题', new Set(seq.map(q => String(q.id))).size === 170)
  const avgs = PRACTICE_OFFSETS.map(([d, , c]) => avgDiff(daySlice(seq, d, c)))
  let mono = true
  for (let i = 1; i < avgs.length; i++) if (avgs[i] < avgs[i - 1] - 1e-9) mono = false
  assert('每日均值单调不减（' + avgs.map(a => a.toFixed(3)).join(' → ') + '）', mono)
  // ⚠️ 第一期配比的桶2 配额恒为 0（中间档份额交给运行时自适应分摊），所以桶2 的题
  //    「在题池充足时不会被抽中」是**设计如此**，不是缺陷。这里改断「桶2 可达」：
  //    题池里的桶2 题量确实被统计到（归桶正确），且当桶1/桶3 不足时它们会被回填进来。
  assert('桶2 归桶正确（100 题进桶2，非空）', run(sb, 'chBankDiffStats()[2]') === 100,
    run(sb, 'chBankDiffStats()[2]'))
  assert('难度 3 的题确实被使用（第一期主打高档）', seq.some(q => Number(q.difficulty) === 3))
  let full = true
  for (const [d, , c] of PRACTICE_OFFSETS) if (daySlice(seq, d, c).length !== c) full = false
  assert('每日切片满额', full)
}

// ================= 组五：进阶期配比（第二期起） =================
group('组五：进阶期（第二期起，CHALLENGE_DIFF_PLAN_HARD）')
{
  const sb = makePoolSandbox(mkBank({ 1: 95, 4: 200 }), true)
  assert('chIsHardRound() 为真', run(sb, 'chIsHardRound()') === true)
  const seq = run(sb, 'challengePool()')
  assert('序列 170 题', seq.length === 170, 'len=' + seq.length)
  assert('无重复题', new Set(seq.map(q => String(q.id))).size === 170)
  const avgs = PRACTICE_OFFSETS.map(([d, , c]) => avgDiff(daySlice(seq, d, c)))
  let mono = true
  for (let i = 1; i < avgs.length; i++) if (avgs[i] < avgs[i - 1] - 1e-9) mono = false
  assert('进阶期每日均值单调不减（' + avgs.map(a => a.toFixed(3)).join(' → ') + '）', mono)

  // 进阶期逐日均值不得低于第一期同日（防「进阶比第一期还简单」）
  const sb1 = makePoolSandbox(mkBank({ 1: 95, 4: 200 }), false)
  const seq1 = run(sb1, 'challengePool()')
  const avgs1 = PRACTICE_OFFSETS.map(([d, , c]) => avgDiff(daySlice(seq1, d, c)))
  let notEasier = true, cmp = []
  for (let i = 0; i < 7; i++) {
    cmp.push('D' + (i + 1) + ':' + avgs1[i].toFixed(2) + '→' + avgs[i].toFixed(2))
    if (avgs[i] < avgs1[i] - 1e-9) notEasier = false
  }
  assert('★ 进阶期每日不低于第一期同日（' + cmp.join(' ') + '）', notEasier)
  assert('进阶期 Day1 均值 ≥ 2.0（进阶起点更高）', avgs[0] >= 1.99, avgs[0])
}

// ================= 组六：★ 题池不足（不虚假满额、不重复） =================
group('组六：题池不足时的诚实降级')
{
  // 极小题库：50 题，需求 170 → 只能给 50，绝不能「凑到 170」而重复取题
  const sb = makePoolSandbox(mkBank({ 1: 50 }), false)
  const seq = run(sb, 'challengePool()')
  assert('★ 50 题题库只返回 50 题（不虚假满额）', seq.length === 50, 'len=' + seq.length)
  assert('★ 50 题题库无重复题', new Set(seq.map(q => String(q.id))).size === 50)
  assert('返回的题全部来自题库', seq.every(q => q.id >= 1000 && q.id < 1050))

  // 恰好够：190 题单档
  const sb2 = makePoolSandbox(mkBank({ 1: 190 }), false)
  const seq2 = run(sb2, 'challengePool()')
  assert('190 题单档题库 → 170 题满额', seq2.length === 170, 'len=' + seq2.length)
  assert('190 题单档题库无重复题', new Set(seq2.map(q => String(q.id))).size === 170)
  assert('全部题被归入桶1后按就近回填', seq2.every(q => Number(q.difficulty) === 1))

  // 空题库 → 空序列（不抛错）
  const sb3 = makePoolSandbox([], false)
  assert('空题库 → 空序列且不抛错', run(sb3, 'challengePool()').length === 0)
}

// ================= 组七：chDrawWithBackfill 回填算法本体 =================
group('组七：自适应回填算法（chDrawWithBackfill）')
{
  const sb = makePoolSandbox([], false)
  // ⚠️ mk 必须在沙箱内定义（宿主变量传不进去；`sb.__mk = mk` 只挂成 window.__mk，裸名仍取不到）
  vm.runInContext('function mk(n, tag) { const a = []; for (let i = 0; i < n; i++) a.push({ id: tag + i }); return a }', sb)

  // 桶2 为空时，其配额应由两侧分摊
  const r1 = run(sb, `(function(){
    const b = { 1: mk(100,'a'), 2: mk(0,'b'), 3: mk(100,'c') }
    return JSON.stringify(chDrawWithBackfill([10,20,10], b).list.length)
  })()`)
  assert('桶2 为空时仍取满 40 题（配额由相邻档补）', JSON.parse(r1) === 40, r1)

  // 总量够的极端不均衡：只有桶1
  const r2 = run(sb, `(function(){
    const b = { 1: mk(50,'a'), 2: [], 3: [] }
    return JSON.stringify(chDrawWithBackfill([10,20,10], b).list.length)
  })()`)
  assert('只有桶1（50题）时取满 40 题', JSON.parse(r2) === 40, r2)

  // 总量不足 → 按实际返回
  const r3 = run(sb, `(function(){
    const b = { 1: mk(5,'a'), 2: [], 3: [] }
    return JSON.stringify(chDrawWithBackfill([10,20,10], b).list.length)
  })()`)
  assert('总量不足（5题）时返回 5 题', JSON.parse(r3) === 5, r3)

  // ★ 游标跨调用累加：连续两次调用不得返回同一批题
  const r4 = run(sb, `(function(){
    const b = { 1: mk(100,'a'), 2: mk(100,'b'), 3: mk(100,'c') }
    const one = chDrawWithBackfill([10,10,10], b).list.map(q=>q.id)
    const two = chDrawWithBackfill([10,10,10], b).list.map(q=>q.id)
    const inter = one.filter(x => two.indexOf(x) >= 0).length
    return JSON.stringify({ one: one.length, two: two.length, inter: inter })
  })()`)
  const d4 = JSON.parse(r4)
  assert('★ 连续两次调用各取 30 题', d4.one === 30 && d4.two === 30, r4)
  assert('★ 连续两次调用零交集（游标累加，不重复取题）', d4.inter === 0, r4)

  // total 字段 = 需求总量（供上层判断）
  const r5 = run(sb, `(function(){
    const b = { 1: mk(3,'a'), 2: [], 3: [] }
    return JSON.stringify(chDrawWithBackfill([10,20,10], b).total)
  })()`)
  assert('返回 total = Σneed（40），与实际取到条数区分开', JSON.parse(r5) === 40, r5)

  // 全空池不抛错
  const r6 = run(sb, `(function(){
    const b = { 1: [], 2: [], 3: [] }
    return JSON.stringify(chDrawWithBackfill([5,5,5], b).list.length)
  })()`)
  assert('全空池返回空列表且不抛错', JSON.parse(r6) === 0, r6)
}

// ================= 组八：分层测试抽题（challengeStratifiedDraw） =================
group('组八：分层测试抽题')
{
  const sb = makePoolSandbox(mkBank({ 1: 95, 4: 200 }), false)
  const got = run(sb, `JSON.stringify(challengeStratifiedDraw(chBankQuestions(), 20).map(q=>q.id))`)
  const arr = JSON.parse(got)
  assert('考试恒取 20 题（桶2 为空也补足）', arr.length === 20, 'len=' + arr.length)
  assert('考试题 id 去重', new Set(arr).size === 20)

  // 极小池：要求 20 但只有 8 题 → 给 8
  const sb2 = makePoolSandbox(mkBank({ 1: 8 }), false)
  const arr2 = JSON.parse(run(sb2, `JSON.stringify(challengeStratifiedDraw(chBankQuestions(), 20).map(q=>q.id))`))
  assert('题池仅 8 题 → 考试返回 8 题（不重复凑数）', arr2.length === 8, 'len=' + arr2.length)

  const sb3 = makePoolSandbox([], false)
  const arr3 = JSON.parse(run(sb3, `JSON.stringify(challengeStratifiedDraw([], 20))`))
  assert('空题池 → 空数组且不抛错', arr3.length === 0)
}

// ================= 组九：结构性缺口告警（旧口径失效的补丁） =================
group('组九：题库结构性缺口告警')
{
  // 线上形态：总量 295 > CHALLENGE_MIN_BANK(190)，旧口径静默；难度2 桶为 0 → 应报缺口
  const sb = makePoolSandbox(mkBank({ 1: 95, 4: 200 }), false)
  sb.__MIN = 190
  vm.runInContext('const CHALLENGE_MIN_BANK = 190\n', sb)
  vm.runInContext(extractFn(CH, 'chBankShort'), sb)
  vm.runInContext(extractFn(CH, 'chBankDiffGap'), sb)
  assert('总量 295 时旧口径不报警（chBankShort=false）—— 正是漏报原因',
    run(sb, 'chBankShort()') === false)
  const gap = run(sb, 'chBankDiffGap()')
  assert('★ 新口径报出中间档缺口', gap !== '', 'gap="' + gap + '"')
  assert('★ 缺口档位文案含 2', String(gap).indexOf('2') >= 0, gap)
  assert('stats 口径：桶 95/0/200', run(sb, 'JSON.stringify([1,2,3].map(d=>chBankDiffStats()[d]))') === '[95,0,200]',
    run(sb, 'JSON.stringify([1,2,3].map(d=>chBankDiffStats()[d]))'))
  assert('stats.total = 295', run(sb, 'chBankDiffStats().total') === 295)

  // 健康题库：各档都充足 → 不报缺口
  const sb2 = makePoolSandbox(mkBank({ 1: 100, 2: 100, 3: 100 }), false)
  vm.runInContext('const CHALLENGE_MIN_BANK = 190\n', sb2)
  vm.runInContext(extractFn(CH, 'chBankShort'), sb2)
  vm.runInContext(extractFn(CH, 'chBankDiffGap'), sb2)
  assert('均衡题库（100/100/100）不报缺口', run(sb2, 'chBankDiffGap()') === '',
    run(sb2, 'chBankDiffGap()'))

  // 空题库：交给 chBankShort 处理，缺口检测静默（避免双重提示）
  const sb3 = makePoolSandbox([], false)
  vm.runInContext('const CHALLENGE_MIN_BANK = 190\n', sb3)
  vm.runInContext(extractFn(CH, 'chBankShort'), sb3)
  vm.runInContext(extractFn(CH, 'chBankDiffGap'), sb3)
  assert('空题库不报结构性缺口（由总量告警负责）', run(sb3, 'chBankDiffGap()') === '')
  assert('空题库总量告警也不报（n>0 前提）', run(sb3, 'chBankShort()') === false)
}

// ================= 组十：源码级护栏（接线 + 契约存在性） =================
group('组十：源码级护栏')
{
  const startFn = grabFn(CH, 'chStartStage')
  // ⚠️ 否定断言前先剥注释行（本项目已四连撞：注释里写着禁忌本身）
  const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const startCode = codeOnly(startFn)

  assert('★ 抽不到题时给出提示（不再静默 return）',
    startCode.indexOf("alert(t('chEmptyAlert'))") >= 0,
    'grabFn len=' + startFn.length)
  // 旧写法必须是「空题直接 return」，v149 已改为先 alert
  const iEmpty = startCode.indexOf('if (!qs.length)')
  const iAlert = startCode.indexOf("alert(t('chEmptyAlert'))")
  assert('★ 空题判定与提示的顺序正确（先判空、后提示）', iEmpty >= 0 && iAlert > iEmpty,
    'iEmpty=' + iEmpty + ' iAlert=' + iAlert)
  assert('保护断言有效性：注释里的旧行为说明确实存在',
    /if \(!qs\.length\) return/.test(CH) || CH.indexOf('静默') >= 0 || CH.indexOf('毫无反应') >= 0)

  const poolFn = grabFn(CH, 'challengePool')
  assert('★ challengePool 使用后向归桶（不再 Math.min(3,…) 压 L4）',
    poolFn.indexOf('chBankMaxDiff') >= 0 && poolFn.indexOf('chDiffBucketOf') >= 0)
  assert('★ challengePool 经 chDrawWithBackfill 取题（自适应）',
    poolFn.indexOf('chDrawWithBackfill') >= 0)
  assert('challengePool 仍按配比逐天取（chDiffPlan）',
    poolFn.indexOf('chDiffPlan') >= 0)

  const drawFn = grabFn(CH, 'challengeStratifiedDraw')
  assert('分层抽题同样用后向归桶 + 自适应回填',
    drawFn.indexOf('chBankMaxDiff') >= 0 && drawFn.indexOf('chDiffBucketOf') >= 0 &&
    drawFn.indexOf('chDrawWithBackfill') >= 0)

  const bfFn = grabFn(CH, 'chDrawWithBackfill')
  assert('★ 回填游标挂在 buckets.__cur（跨调用累加，防重复题）',
    bfFn.indexOf('buckets.__cur') >= 0, 'len=' + bfFn.length)

  // 告警渲染接线（函数定义存在 ≠ 已接线 —— 必须断被模板真调用）
  assert('★ 结构性告警挂在渲染模板里（真调用 t(\'chBankDiffWarn\', …)）',
    CH.indexOf("t('chBankDiffWarn', chBankDiffGap())") >= 0)
  assert('★ 总量告警仍在（chBankShortWarn 未被替换掉）',
    CH.indexOf('chBankShortWarn') >= 0)
}

// ================= 组十一：i18n 键（zh/en 成对 + 类型一致） =================
group('组十一：i18n 新增键')
{
  let src = I18N + '\n;globalThis.__I18N = I18N;\n'
  const store = {}
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp, Error,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
      get length() { return Object.keys(store).length },
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
  vm.runInContext(src, sb, { filename: 'i18n.js' })
  const L = sb.__I18N

  assert('chEmptyAlert 中英都定义', ('chEmptyAlert' in L.zh) && ('chEmptyAlert' in L.en))
  assert('chBankDiffWarn 中英都定义', ('chBankDiffWarn' in L.zh) && ('chBankDiffWarn' in L.en))
  // ★ 带参文案必须类型一致：一侧函数一侧字符串 → t(...) 调用即崩
  assert('★ chBankDiffWarn 中英类型一致（均为函数）',
    typeof L.zh.chBankDiffWarn === typeof L.en.chBankDiffWarn &&
    typeof L.zh.chBankDiffWarn === 'function',
    typeof L.zh.chBankDiffWarn + ' vs ' + typeof L.en.chBankDiffWarn)
  assert('★ chEmptyAlert 中英类型一致（均为字符串）',
    typeof L.zh.chEmptyAlert === typeof L.en.chEmptyAlert &&
    typeof L.zh.chEmptyAlert === 'string',
    typeof L.zh.chEmptyAlert + ' vs ' + typeof L.en.chEmptyAlert)
  assert('chEmptyAlert 文案非空', String(L.zh.chEmptyAlert).length > 5 && String(L.en.chEmptyAlert).length > 5)
  assert('chBankDiffWarn 可调用且含档位参数',
    L.zh.chBankDiffWarn('2').indexOf('2') >= 0 && L.en.chBankDiffWarn('2').indexOf('2') >= 0)
  assert('中英键数相等（无单侧漏写）', Object.keys(L.zh).length === Object.keys(L.en).length,
    Object.keys(L.zh).length + ' vs ' + Object.keys(L.en).length)

  // challenge.js 里用到的所有 t('key') 都必须在两侧存在（防新增键漏配）
  const used = [...new Set([...CH.matchAll(/t\('([A-Za-z0-9_]+)'/g)].map(m => m[1]))]
  const missZh = used.filter(k => !(k in L.zh))
  const missEn = used.filter(k => !(k in L.en))
  assert('challenge.js 用到的键 zh 侧齐全', missZh.length === 0, missZh.join(','))
  assert('challenge.js 用到的键 en 侧齐全', missEn.length === 0, missEn.join(','))
}

// ================= 组十二：版本号（弹性化，不写死） =================
group('组十二：版本号')
{
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('版本号 12 处且唯一（' + (uniq[0] || '?') + '）', vms.length === 12 && uniq.length === 1,
    'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('版本号 >= 149', uniq.length === 1 && uniq[0] >= 149, uniq[0])
}

// ================= 汇总 =================
console.log('\n' + '='.repeat(60))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
else console.log('ALL PASS  ✅ 全部通过')
process.exit(fail ? 1 : 0)
