// ====== 测试 v111：第二期「略难 + 纳入本人第一期错题」 ======
// 背景：用户口径「帮我做一个标志餐厅第二期测试吧，难度比第一期略难，然后每个人要有自己第一期的错题在里面」。
// 拆成两件事：
//   ① 难度提升 —— 第二期及以后改用更偏难的配比（练习 CHALLENGE_DIFF_PLAN_HARD / 考试 CHALLENGE_TEST_PLAN_HARD）
//   ② 错题注入 —— 第二期考试先塞入「本人第一期存档里答错的题」，再用分层随机题补齐到 20 题
//
// 覆盖点：
// ① 配比常量自洽：两套配比各自合计正确，且 HARD 版难度均值明显高于 BASE 版
// ② chIsHardRound 判定：第一期 → false，其他营次 → true，缺函数/异常 → 保守回落 false
// ③ chDiffPlan / chTestPlan 按营次取到正确配比；challengePool 实际题量/难度结构随营次变化
// ④ challengeStratifiedDraw 用当期配比抽题（第二期难度1 更少、难度2/3 更多）
// ⑤ chPrevRoundWrongQuestions：读**第一期存档键**（不是当前营次键）；跨阶段汇总 + qid 去重；
//    按本部门题库过滤；option 重洗（对象与存档非同一引用）
// ⑥ challengeTestWithWrongQuestions：错题全部前置、去重、补满 total、错题≥total 时截断、无错题时退化
// ⑦ challengeTestQuestions 接线：第二期走错题注入分支，第一期**不**走（保证老成绩可复现）
// ⑧ chHardRoundHtml 提示卡：仅进阶期渲染且含错题条数；第一期返回 ''
// ⑨ 源码契约 + i18n 双语文案成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
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
const CH = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const call = (sb, expr) => vm.runInContext(expr, sb)

// 从 challenge.js 里把配比常量源码抠出来（保证测的是真源码而不是抄一份）
// 注意：常量是嵌套数组 [[...], [...]] → 必须按括号配平截取，非贪婪正则会停在第一个 ']'
function constSrc(name) {
  const start = CH.indexOf('const ' + name + ' = [')
  if (start < 0) throw new Error('const not found: ' + name)
  let i = CH.indexOf('[', start), depth = 0
  for (; i < CH.length; i++) {
    if (CH[i] === '[') depth++
    else if (CH[i] === ']') { depth--; if (depth === 0) break }
  }
  return CH.slice(start, i + 1).replace(/\n/g, ' ')
}
// 极简 localStorage 替身
function mockLS(init) {
  const store = Object.assign({}, init || {})
  return {
    _store: store,
    getItem(k) { return store[k] == null ? null : store[k] },
    setItem(k, v) { store[k] = String(v) },
    removeItem(k) { delete store[k] },
  }
}

// ====== 通用沙箱：装载 v111 新增/改动的全部函数 ======
// 注意：challengeStratifiedDraw / challengePool / chPrevDayWrongQuestions 等
//   会把「当前营次」通过 chCurrentRound 读进来 → 每个场景都要能独立控制营次与存档。
function makeSb(opts) {
  const o = opts || {}
  const rounds = o.rounds || null          // 传入营次数组则构造 CloudSync 侧信道
  const curId = o.curId || ''              // 当前营次 id（'' = 无侧信道 → 第一期）
  const ls = mockLS(o.lsStore)
  const questions = o.questions || []
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Set, Map, Date,
    localStorage: ls,
    Store: {
      getSession: () => ({ username: o.username || 'alice' }),
      getQuestions: () => questions,
      getQuestion: (id) => questions.find(q => String(q.id) === String(id)) || null,
      isAdmin: () => !!o.isAdmin,
    },
    // 宿主侧工具（原样从 app.js 语义简化：洗牌即可）
    shuffleOptions: (q) => Object.assign({}, q, { options: q.options.slice().reverse() }),
    escHtml: (s) => String(s == null ? '' : s),
    t: (k, a, b) => (typeof k === 'string' ? k + (a != null ? ':' + a : '') + (b != null ? ',' + b : '') : k),
    LANG: 'zh',
    CloudSync: rounds ? { _chRounds: rounds, _chRoundCurId: curId } : undefined,
    DEPT_SUB_SLUGS: undefined,
    roundDeptMatch: (r, slug) => !!r && Array.isArray(r.depts) && r.depts.indexOf(slug) >= 0,
    roundOpenState: () => ({ state: 'open', on: true }),
    deptSlugName: (s) => s,
    sessionDeptSlug: () => o.dept || 'dining/sig',
  }
  sb.window = sb
  vm.createContext(sb)
  // ---- 常量 ----
  vm.runInContext(`
    const CHALLENGE_KEY = 'eq_challenge_v2'
    const CHALLENGE_KEY_PREFIX = 'eq_challenge_v2_'
    const CHALLENGE_ROUND_SEEN_KEY = 'eq_ch_seen_rounds'
    const CHALLENGE_SEED = 20260912
    const CHALLENGE_MIN_BANK = 190
    const CHALLENGE_DAYS = [
      { day: 1, stages: [ { kind: 'test', count: 20 }, { kind: 'practice', count: 10 } ] },
      { day: 2, stages: [ { kind: 'practice', count: 30 } ] },
      { day: 3, stages: [ { kind: 'practice', count: 30 } ] },
      { day: 4, stages: [ { kind: 'practice', count: 30 } ] },
      { day: 5, stages: [ { kind: 'practice', count: 30 } ] },
      { day: 6, stages: [ { kind: 'practice', count: 30 } ] },
      { day: 7, stages: [ { kind: 'practice', count: 10 }, { kind: 'test', count: 20 } ] },
    ]
    const CHALLENGE_TOTAL = 210
    const PRACTICE_DEPT_SLUGS = ['', 'dining', 'dining/sig', 'dining/bar', 'rooms', 'all']
  `, sb)
  vm.runInContext(constSrc('CHALLENGE_DIFF_PLAN'), sb)
  vm.runInContext(constSrc('CHALLENGE_DIFF_PLAN_HARD'), sb)
  vm.runInContext(constSrc('CHALLENGE_TEST_PLAN'), sb)
  vm.runInContext(constSrc('CHALLENGE_TEST_PLAN_HARD'), sb)
  // ---- 依赖链（顺序按源码中真实先后） ----
  ;['challengeUid', 'chDeptKey', 'chBankQuestions', 'chBankCount', 'chBankIdSet',
    'chRoundSlug', 'chRoundRecForDept', 'chRoundViewSlugs', 'chRoundListForView',
    'chRoundViewKey', 'chCurrentRound', 'chIsHardRound', 'chDiffPlan', 'chTestPlan',
    'challengeRng', 'chUserSeed', 'challengePool', 'challengeStageMeta', 'challengeStageInfo',
    'challengeStratifiedDraw', 'challengeRandomQuestions', 'chPrevDayWrongQuestions',
    'chPrevRoundWrongQuestions', 'challengeTestWithWrongQuestions',
    'chStageRec', 'chStageDone', 'challengeTestQuestions', 'chHardRoundHtml',
  ].forEach(fn => vm.runInContext(extractFn(CH, fn), sb))
  // chStageRec 依赖 challengeState（模块级 let）
  vm.runInContext('let challengeState = ' + JSON.stringify(o.state || { uid: o.username || 'alice', days: {} }), sb)
  return sb
}

// 造题工具：n 道指定难度
function mkQs(prefix, n, diff, startId) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: (startId || 0) + i, category_id: 12, dept: 'dining/sig',
      type: 'single', difficulty: diff,
      question: prefix + '-' + i, options: ['A', 'B', 'C', 'D'], answer: [0],
      explanation: 'e',
    })
  }
  return out
}
// 各难度足量的题库：难度1 × 400 / 难度2 × 260 / 难度3 × 40（够跑 HARD 练习 50/114/6 与考试 5/10/5）
const BANK = mkQs('d1', 400, 1, 1000).concat(mkQs('d2', 260, 2, 5000)).concat(mkQs('d3', 40, 3, 9000))
const diffCount = (arr, d) => arr.filter(q => (Number(q.difficulty) || 1) === d).length
const meanDiff = (arr) => arr.length ? arr.reduce((s, q) => s + (Number(q.difficulty) || 1), 0) / arr.length : 0

;(async () => {
  console.log('\n🧪 v111 第二期：略难 + 纳入本人第一期错题')

  // ================= ① 配比常量自洽 =================
  console.log('\n[1] 难度配比常量自洽性')
  {
    const sb = makeSb({ questions: BANK })
    const base = JSON.parse(call(sb, 'JSON.stringify(CHALLENGE_DIFF_PLAN)'))
    const hard = JSON.parse(call(sb, 'JSON.stringify(CHALLENGE_DIFF_PLAN_HARD)'))
    const sum = p => p.reduce((a, r) => [a[0] + r[0], a[1] + r[1], a[2] + r[2]], [0, 0, 0])
    const b = sum(base), h = sum(hard)
    assert('第一期练习配比合计 82/82/6 = 170 题（v110 原值不变）',
      b[0] === 82 && b[1] === 82 && b[2] === 6 && b[0] + b[1] + b[2] === 170, JSON.stringify(b))
    assert('第二期练习配比合计 37/127/6 = 170 题（题量不变，只调难度结构）',
      h[0] === 37 && h[1] === 127 && h[2] === 6 && h[0] + h[1] + h[2] === 170, JSON.stringify(h))
    // 全序列加权平均难度（Σ难度 / 题量）
    const meanOf = p => p.reduce((s, r) => s + (r[0] + r[1] * 2 + r[2] * 3), 0) / 170
    const bm = meanOf(base), hm = meanOf(hard)
    assert('第二期练习平均难度高于第一期（1.55 → 1.80）', hm > bm && (hm - bm) > 0.2, bm.toFixed(2) + ' → ' + hm.toFixed(2))
    assert('第二期难度1 题量大幅减少（82 → 37）', h[0] < b[0], h[0] + ' vs ' + b[0])
    assert('第二期难度2 题量大幅增加（82 → 127）', h[1] > b[1], h[1] + ' vs ' + b[1])
    assert('难度3 题量保持不变（6 题，题库仅 24 道容量受限）', h[2] === b[2], h[2] + ' vs ' + b[2])
    assert('两套配比都是 7 天（与 CHALLENGE_DAYS 的 7 个 practice 阶段一一对应）',
      base.length === 7 && hard.length === 7, base.length + '/' + hard.length)
    assert('两套配比的每日题量一致（10/30/30/30/30/30/10，总时长不变）',
      base.every((r, i) => (r[0] + r[1] + r[2]) === (hard[i][0] + hard[i][1] + hard[i][2])),
      JSON.stringify(base.map(r => r[0] + r[1] + r[2])) + ' vs ' + JSON.stringify(hard.map(r => r[0] + r[1] + r[2])))
    // 逐日难度必须单调不减（Day1 最易 → Day7 最难）—— 用「每日加权平均难度」而非裸加权和
    //（每日题量不同，Day7 只有 10 题，裸加权和必然回落）
    const dailyMean = p => p.map(r => (r[0] + r[1] * 2 + r[2] * 3) / (r[0] + r[1] + r[2]))
    const mono = a => a.every((x, i) => i === 0 || x >= a[i - 1] - 1e-9)
    assert('第一期配比逐日难度单调不减',
      mono(dailyMean(base)), dailyMean(base).map(x => x.toFixed(2)).join(' '))
    assert('第二期配比逐日难度单调不减',
      mono(dailyMean(hard)), dailyMean(hard).map(x => x.toFixed(2)).join(' '))
    assert('第二期每一天都不低于第一期同一天（逐日「略难」而非整体更难）',
      dailyMean(hard).every((x, i) => x >= dailyMean(base)[i] - 1e-9),
      dailyMean(base).map(x => x.toFixed(2)).join(' ') + ' → ' + dailyMean(hard).map(x => x.toFixed(2)).join(' '))
    assert('第二期 Day1 难度高于第一期 Day1（开营即更难：1.00 → 1.30）',
      dailyMean(hard)[0] > dailyMean(base)[0], dailyMean(hard)[0].toFixed(2))
    // 考试配比
    const tb = JSON.parse(call(sb, 'JSON.stringify(CHALLENGE_TEST_PLAN)'))
    const th = JSON.parse(call(sb, 'JSON.stringify(CHALLENGE_TEST_PLAN_HARD)'))
    assert('第一期考试配比 10/7/3 = 20 题（v110 原值不变）',
      tb[0] === 10 && tb[1] === 7 && tb[2] === 3, JSON.stringify(tb))
    assert('第二期考试配比 5/10/5 = 20 题（题量恒定，难度更高）',
      th[0] === 5 && th[1] === 10 && th[2] === 5, JSON.stringify(th))
    const tmean = p => (p[0] + p[1] * 2 + p[2] * 3) / 20
    assert('第二期考试平均难度高于第一期（1.65 → 2.00）', tmean(th) > tmean(tb), tmean(tb).toFixed(2) + ' → ' + tmean(th).toFixed(2))
  }

  // ================= ② chIsHardRound 判定 =================
  console.log('\n[2] chIsHardRound：按营次判定难度档')
  {
    // 无云端侧信道 → 第一期
    const sb1 = makeSb({ questions: BANK })
    assert('无营次信息 → 视作第一期（false）', call(sb1, 'chIsHardRound()') === false, '')
    // 侧信道指向第二期
    const sb2 = makeSb({
      questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'], open: true }],
      curId: 'r2',
    })
    assert('侧信道指向第二期 → true', call(sb2, 'chIsHardRound()') === true, '')
    // r1 归一
    const sb3 = makeSb({
      questions: BANK, rounds: [{ id: 'r1', name: '第一期', depts: ['dining/sig'], open: true }],
      curId: 'r1',
    })
    assert("侧信道指向 r1 → 归一为第一期（false）", call(sb3, 'chIsHardRound()') === false, '')
    // 缺 chRoundSlug → 保守回落 false（沙箱/部分加载健壮性）
    const sb4 = makeSb({ questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2' })
    const r4 = call(sb4, '(() => { const saved = chRoundSlug; let out; try { chRoundSlug = undefined; out = chIsHardRound() } finally { chRoundSlug = saved } return out })()')
    assert('chRoundSlug 缺失 → 保守回落 false（不抛错）', r4 === false, String(r4))
    // 缺 chCurrentRound → 回落 '第一期' → false
    const r5 = call(sb4, '(() => { const saved = chCurrentRound; let out; try { chCurrentRound = undefined; out = chIsHardRound() } finally { chCurrentRound = saved } return out })()')
    assert('chCurrentRound 缺失 → 回落第一期（false）', r5 === false, String(r5))
    // 源码契约：typeof 守卫（v110 教训同款）
    const fn = extractFn(CH, 'chIsHardRound')
    assert('chIsHardRound 源码含 typeof 守卫（不裸调用）',
      /typeof chRoundSlug !== 'function'/.test(fn) && /typeof chCurrentRound === 'function'/.test(fn), fn)
  }

  // ================= ③ chDiffPlan / chTestPlan 与 challengePool =================
  console.log('\n[3] 配比选取与练习序列按营次变化')
  {
    const sb1 = makeSb({ questions: BANK })
    const sb2 = makeSb({ questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'], open: true }], curId: 'r2' })
    assert('chDiffPlan 第一期 → CHALLENGE_DIFF_PLAN',
      JSON.parse(call(sb1, 'JSON.stringify(chDiffPlan())'))[0][0] === 10, call(sb1, 'JSON.stringify(chDiffPlan())'))
    assert('chDiffPlan 第二期 → CHALLENGE_DIFF_PLAN_HARD（Day1 = 7/3/0）',
      JSON.parse(call(sb2, 'JSON.stringify(chDiffPlan())'))[0][0] === 7, call(sb2, 'JSON.stringify(chDiffPlan())'))
    assert('chTestPlan 第一期 → [10,7,3]',
      JSON.stringify(JSON.parse(call(sb1, 'JSON.stringify(chTestPlan())'))) === '[10,7,3]', call(sb1, 'JSON.stringify(chTestPlan())'))
    assert('chTestPlan 第二期 → [5,10,5]',
      JSON.stringify(JSON.parse(call(sb2, 'JSON.stringify(chTestPlan())'))) === '[5,10,5]', call(sb2, 'JSON.stringify(chTestPlan())'))

    const pool1 = JSON.parse(call(sb1, 'JSON.stringify(challengePool().map(q => q.difficulty))'))
    const pool2 = JSON.parse(call(sb2, 'JSON.stringify(challengePool().map(q => q.difficulty))'))
    assert('练习序列题量两期一致（170 题，总时长不变）', pool1.length === 170 && pool2.length === 170, pool1.length + '/' + pool2.length)
    const c1 = { 1: 0, 2: 0, 3: 0 }, c2 = { 1: 0, 2: 0, 3: 0 }
    pool1.forEach(d => c1[d]++); pool2.forEach(d => c2[d]++)
    assert('第一期练习结构 82/82/6（v110 原值）',
      c1[1] === 82 && c1[2] === 82 && c1[3] === 6, JSON.stringify(c1))
    assert('第二期练习结构 37/127/6（难度2/3 明显增多）',
      c2[1] === 37 && c2[2] === 127 && c2[3] === 6, JSON.stringify(c2))
    assert('第二期练习平均难度更高', meanDiff(pool2.map(d => ({ difficulty: d }))) > meanDiff(pool1.map(d => ({ difficulty: d }))),
      meanDiff(pool1.map(d => ({ difficulty: d }))).toFixed(2) + ' → ' + meanDiff(pool2.map(d => ({ difficulty: d }))).toFixed(2))
    // 同一学员两期题目序列不同（v88 种子 + v111 配比双重隔离）
    assert('同一学员两期练习序列不同（不是简单改难度标签）',
      JSON.stringify(pool1) !== JSON.stringify(pool2), '序列相同')
    // 练习序列 id 不重复（跨难度桶去重契约）
    const ids2 = new Set(call(sb2, 'challengePool().map(q => String(q.id))'))
    assert('第二期练习序列 id 无重复（170 个不同题号）', ids2.size === 170, String(ids2.size))
  }

  // ================= ④ challengeStratifiedDraw 用当期配比 =================
  console.log('\n[4] 分层抽题按当期配比')
  {
    const sb1 = makeSb({ questions: BANK })
    const sb2 = makeSb({ questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'], open: true }], curId: 'r2' })
    const draw = sb => JSON.parse(call(sb, 'JSON.stringify(challengeStratifiedDraw(Store.getQuestions(), 20).map(q => q.difficulty))'))
    const a = draw(sb1), b = draw(sb2)
    assert('第一期抽 20 题：10/7/3', a.length === 20 && attr(a, 1) === 10 && attr(a, 2) === 7 && attr(a, 3) === 3, JSON.stringify(count(a)))
    assert('第二期抽 20 题：5/10/5', b.length === 20 && attr(b, 1) === 5 && attr(b, 2) === 10 && attr(b, 3) === 5, JSON.stringify(count(b)))
    assert('第二期抽题平均难度高于第一期', meanDiff(b.map(d => ({ difficulty: d }))) > meanDiff(a.map(d => ({ difficulty: d }))),
      meanDiff(a.map(d => ({ difficulty: d }))).toFixed(2) + ' → ' + meanDiff(b.map(d => ({ difficulty: d }))).toFixed(2))
    // 题源为空的边界：不得抛错
    const empty = call(sb2, 'JSON.stringify(challengeStratifiedDraw([], 20))')
    assert('空题源不抛错（返回空数组）', empty === '[]', empty)
    // 库存不足时自动少抽（难度3 只有 2 道，要求 5 道）
    const thin = mkQs('t1', 50, 1, 100).concat(mkQs('t2', 50, 2, 200)).concat(mkQs('t3', 2, 3, 300))
    const sb3 = makeSb({ questions: thin, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'], open: true }], curId: 'r2' })
    const out3 = JSON.parse(call(sb3, 'JSON.stringify(challengeStratifiedDraw(Store.getQuestions(), 20).map(q => q.difficulty))'))
    assert('难度3 库存不足 → 自动少抽且不报错（5/10/2）',
      out3.length === 17 && attr(out3, 3) === 2, out3.length + '/' + JSON.stringify(count(out3)))
  }

  // ================= ⑤ chPrevRoundWrongQuestions =================
  console.log('\n[5] 读取第一期错题（跨营次存档键）')
  {
    // 第一期存档：Day1 test(si0) 错 2 题、Day1 practice(si1) 错 1 题（与 si0 重复 1 题）、Day7 test 错 1 题
    const firstState = {
      uid: 'alice',
      days: {
        1: { stages: { 0: { done: true, correct: 18, total: 20, wrong: [1001, 1002] },
                       1: { done: true, correct: 9, total: 10, wrong: [1002, 5001] } } },
        7: { stages: { 1: { done: true, correct: 19, total: 20, wrong: [9001] } } },
      },
    }
    // 第二期存档（当前营次）：故意放一条 9999 错题 → 必须**不被**读取
    const secondState = { uid: 'alice', days: { 1: { stages: { 1: { done: true, correct: 8, total: 10, wrong: [9999] } } } } }
    const sb = makeSb({
      questions: BANK,
      rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'], open: true }],
      curId: 'r2',
      lsStore: {
        'eq_challenge_v2': JSON.stringify(firstState),          // 第一期存档键
        'eq_challenge_v2_第二期': JSON.stringify(secondState),   // 第二期存档键
      },
      state: secondState,
    })
    const ids = JSON.parse(call(sb, 'JSON.stringify(chPrevRoundWrongQuestions().map(q => Number(q.id)))'))
    assert('汇总第一期全部阶段的 wrong（跨天跨环节）',
      ids.indexOf(1001) >= 0 && ids.indexOf(9001) >= 0, JSON.stringify(ids))
    assert('qid 去重（1002 在 si0/si1 各出现一次 → 只取一条）',
      ids.filter(x => x === 1002).length === 1, JSON.stringify(ids))
    assert('总数为去重后 4 条（1001/1002/5001/9001）', ids.length === 4, JSON.stringify(ids))
    assert('不读取当前（第二期）营次存档里的错题 9999',
      ids.indexOf(9999) < 0, JSON.stringify(ids))
    assert('错题按 first-wrong 顺序前置：先 si0 再 si1 再 Day7',
      ids[0] === 1001 && ids[1] === 1002 && ids[2] === 5001 && ids[3] === 9001, JSON.stringify(ids))
    // 选项重洗：返回对象与存档/题库不是同一引用
    const sameRef = call(sb, `(() => { const a = chPrevRoundWrongQuestions()[0];
      const b = Store.getQuestion(1001); return a === b })()`)
    assert('返回的题经过 shuffleOptions（非题库原对象引用）', sameRef === false, '仍是同一引用')

    // 存档缺失 / 无 wrong 字段 → 空数组，不抛错
    const sbNone = makeSb({ questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2' })
    assert('无第一期存档 → 空数组（不抛错）', call(sbNone, 'chPrevRoundWrongQuestions().length') === 0, '')
    const sbNoWrong = makeSb({
      questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, correct: 20, total: 20 } } } } }) },
    })
    assert('旧存档无 wrong 字段（v71 及更早）→ 空数组', call(sbNoWrong, 'chPrevRoundWrongQuestions().length') === 0, '')
    const sbBroken = makeSb({
      questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: { 'eq_challenge_v2': '{不是合法 JSON' },
    })
    assert('第一期存档损坏（非法 JSON）→ 空数组且不抛错', call(sbBroken, 'chPrevRoundWrongQuestions().length') === 0, '')

    // 部门过滤：错题里混入「非本部门」题 → 应被剔除
    const withOther = BANK.concat([{ id: 7777, category_id: 12, dept: 'dining/bar', type: 'single', difficulty: 2, question: 'x', options: ['A', 'B'], answer: [0] }])
    const sbF = makeSb({
      questions: withOther, dept: 'dining/sig',
      rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: [1001, 7777] } } } } }) },
    })
    const fIds = JSON.parse(call(sbF, 'JSON.stringify(chPrevRoundWrongQuestions().map(q => Number(q.id)))'))
    assert('按本部门题库过滤：跨部门错题（dining/bar）被剔除',
      fIds.indexOf(7777) < 0 && fIds.indexOf(1001) >= 0, JSON.stringify(fIds))

    // 源码契约：必须读 CHALLENGE_KEY（第一期键）而不是 chStorageKey()（当前营次键）
    const fn = extractFn(CH, 'chPrevRoundWrongQuestions')
    assert('源码读第一期固定键 CHALLENGE_KEY（不是 chStorageKey()）',
      /localStorage\.getItem\(CHALLENGE_KEY\)/.test(fn) && !/chStorageKey\(\)/.test(fn), fn)
  }

  // ================= ⑥ challengeTestWithWrongQuestions =================
  console.log('\n[6] 考试题 = 第一期错题前置 + 分层补齐')
  {
    // 错题 3 道（<20）→ 前置 + 补齐到 20
    const sb = makeSb({
      questions: BANK,
      rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: {
        'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: [1001, 1002, 1003] } } } } }),
      },
    })
    const got = JSON.parse(call(sb, 'JSON.stringify(challengeTestWithWrongQuestions(Store.getQuestions(), 20).map(q => Number(q.id)))'))
    assert('错题前置：前 3 题就是第一期错题（顺序保留）',
      got[0] === 1001 && got[1] === 1002 && got[2] === 1003, JSON.stringify(got.slice(0, 5)))
    assert('补齐到 20 题', got.length === 20, String(got.length))
    assert('整体无重复题号', new Set(got).size === 20, String(new Set(got).size))

    // 错题 >20 道 → 截断到 20（考试不会无限长）
    const manyWrong = []
    for (let i = 0; i < 30; i++) manyWrong.push(1000 + i)
    const sb2 = makeSb({
      questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: manyWrong } } } } }) },
    })
    const got2 = JSON.parse(call(sb2, 'JSON.stringify(challengeTestWithWrongQuestions(Store.getQuestions(), 20).map(q => Number(q.id)))'))
    assert('错题 ≥20 道 → 只取前 20（全部为第一期错题）',
      got2.length === 20 && got2.every(id => id >= 1000 && id < 1030), JSON.stringify(got2.slice(0, 3)) + '...' + got2.length)

    // 无错题 → 退化为纯分层随机（难度结构符合第二期配比）
    const sb3 = makeSb({ questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2' })
    const got3 = JSON.parse(call(sb3, 'JSON.stringify(challengeTestWithWrongQuestions(Store.getQuestions(), 20).map(q => q.difficulty))'))
    assert('无第一期错题 → 退化为 20 题分层随机（5/10/5）',
      got3.length === 20 && attr(got3, 1) === 5 && attr(got3, 2) === 10 && attr(got3, 3) === 5, JSON.stringify(count(got3)))

    // 错题与补齐题撞题 → 不重复（去重口径）
    // 造一份「三难度齐全」的小题库，并让 wrong 里放两道**属于题库**的题号 → 补齐时必然撞题
    const smallBank = mkQs('s1', 30, 1, 300).concat(mkQs('s2', 30, 2, 400)).concat(mkQs('s3', 30, 3, 500))
    const sb4 = makeSb({
      questions: smallBank, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: [300, 401] } } } } }) },
    })
    const got4 = JSON.parse(call(sb4, 'JSON.stringify(challengeTestWithWrongQuestions(Store.getQuestions(), 20).map(q => Number(q.id)))'))
    assert('错题与补齐题撞题时去重（不会出现两次）',
      new Set(got4).size === got4.length, 'unique=' + new Set(got4).size + ' len=' + got4.length)
    assert('撞题去重后仍补满 20 题', got4.length === 20, String(got4.length))
    assert('撞题的错题（300/401）仍在卷首',
      got4[0] === 300 && got4[1] === 401, JSON.stringify(got4.slice(0, 4)))

    // 精确性：错题必须「真的在里面」（用 Set 判定，不是靠位置猜）
    const wrongSet = new Set([1001, 1002, 1003])
    assert('断言口径复核：20 题里三题全部命中第一期错题集',
      got.filter(id => wrongSet.has(id)).length === 3, JSON.stringify(got.filter(id => wrongSet.has(id))))
  }

  // ================= ⑦ challengeTestQuestions 接线 =================
  console.log('\n[7] challengeTestQuestions：仅进阶期走错题注入')
  {
    // ⚠️ 错题 id 必须落在题库 id 空间里，但**不能**与「第一期分层随机会抽到的题」重叠，
    //   否则「第一期不含错题注入」的否定断言会被随机抽题命中而假失败。
    //   做法：单独造一批 id 900000+ 的「历史错题」（属题库、属本部门、难度齐全），
    //   只存在于 wrong 列表里；第一期分层随机抽的是 BANK（id 1000/5000/9000 空间）→ 天然不撞。
    const histWrong = [
      { id: 900001, category_id: 12, dept: 'dining/sig', type: 'single', difficulty: 1, question: 'w1', options: ['A', 'B'], answer: [0] },
      { id: 900002, category_id: 12, dept: 'dining/sig', type: 'single', difficulty: 2, question: 'w2', options: ['A', 'B'], answer: [0] },
      { id: 900003, category_id: 12, dept: 'dining/sig', type: 'single', difficulty: 2, question: 'w3', options: ['A', 'B'], answer: [0] },
      { id: 900004, category_id: 12, dept: 'dining/sig', type: 'single', difficulty: 3, question: 'w4', options: ['A', 'B'], answer: [0] },
      { id: 900005, category_id: 12, dept: 'dining/sig', type: 'single', difficulty: 3, question: 'w5', options: ['A', 'B'], answer: [0] },
    ]
    const FULL = BANK.concat(histWrong)
    const wrongIds = histWrong.map(q => q.id)
    const doneState = {
      uid: 'alice',
      days: {
        1: { stages: { 1: { done: true, at: 1 } } }, 2: { stages: { 0: { done: true, at: 1 } } },
        3: { stages: { 0: { done: true, at: 1 } } }, 4: { stages: { 0: { done: true, at: 1 } } },
        5: { stages: { 0: { done: true, at: 1 } } }, 6: { stages: { 0: { done: true, at: 1 } } },
      },
    }
    const sb2 = makeSb({
      questions: FULL, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      state: doneState,
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: wrongIds } } } } }) },
    })
    const t2 = JSON.parse(call(sb2, 'JSON.stringify(challengeTestQuestions().map(q => Number(q.id)))'))
    assert('第二期考试含本人第一期错题（5 题全部在列）',
      wrongIds.every(id => t2.indexOf(id) >= 0), JSON.stringify(t2))
    assert('第二期考试仍为 20 题', t2.length === 20, String(t2.length))

    // 第一期：同样的错题存档存在，但**不得**被注入（老成绩可复现）
    const sb1 = makeSb({
      questions: FULL, state: doneState,
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: wrongIds } } } } }) },
    })
    const t1 = JSON.parse(call(sb1, 'JSON.stringify(challengeTestQuestions().map(q => Number(q.id)))'))
    assert('第一期考试不含「第一期错题注入」（行为与 v110 一致）',
      wrongIds.every(id => t1.indexOf(id) < 0), JSON.stringify(t1.filter(id => id > 900000)))
    assert('第一期考试为 20 题', t1.length === 20, String(t1.length))
    const d1 = JSON.parse(call(sb1, 'JSON.stringify(challengeTestQuestions().map(q => q.difficulty))'))
    assert('第一期考试难度结构 10/7/3（未被第二期配比污染）',
      attr(d1, 1) === 10 && attr(d1, 2) === 7 && attr(d1, 3) === 3, JSON.stringify(count(d1)))

    // 源码契约：两个分支都在（chIsHardRound 分流）
    const fn = extractFn(CH, 'challengeTestQuestions')
    assert('challengeTestQuestions 用 chIsHardRound 分流（进阶期走错题注入）',
      /chIsHardRound\(\)/.test(fn) && /challengeTestWithWrongQuestions\(/.test(fn), fn)
    assert('challengeTestQuestions 保留第一期原路径（challengeRandomQuestions / challengeStratifiedDraw）',
      /challengeRandomQuestions\(20\)/.test(fn) && /challengeStratifiedDraw\(source, 20\)/.test(fn), fn)
  }

  // ================= ⑧ chHardRoundHtml 提示卡 =================
  console.log('\n[8] 学员端进阶期提示卡')
  {
    const sb1 = makeSb({ questions: BANK })
    assert('第一期 → 不渲染提示卡（老界面零变化）', call(sb1, 'chHardRoundHtml()') === '', call(sb1, 'chHardRoundHtml()'))
    const sb2 = makeSb({
      questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2',
      lsStore: { 'eq_challenge_v2': JSON.stringify({ uid: 'alice', days: { 1: { stages: { 0: { done: true, wrong: [1001, 1002, 1003] } } } } }) },
    })
    const html = call(sb2, 'chHardRoundHtml()')
    assert('第二期 → 渲染提示卡（含进阶标记）', /🔥/.test(html), html.slice(0, 120))
    assert('提示卡显示第一期错题条数（3 题）', /3/.test(html), html.slice(0, 300))
    assert('提示卡含当期营次名（第二期）', /第二期/.test(html), html.slice(0, 200))
    // 无错题时仍渲染（只隐藏条数那一行）
    const sb3 = makeSb({ questions: BANK, rounds: [{ id: 'r2', name: '第二期', depts: ['dining/sig'] }], curId: 'r2' })
    const html3 = call(sb3, 'chHardRoundHtml()')
    assert('第二期无错题 → 仍渲染难度说明（不因缺错题而消失）', /🔥/.test(html3), html3.slice(0, 120))
    assert('renderChallenge 接入 chHardRoundHtml（位置在营次列表卡之后）',
      /\$\{chRoundListHtml\(\)\}\s*\n\s*\$\{chHardRoundHtml\(\)\}/.test(CH), '未接入或位置不对')
  }

  // ================= ⑨ i18n 双语成对 =================
  console.log('\n[9] i18n 双语文案成对')
  {
    const keys = ['chHardRoundTag', 'chHardRoundTitle', 'chHardRoundHint', 'chRound1WrongTitle']
    const zh = I18N.slice(I18N.indexOf('chRoundLabel:'), I18N.indexOf('dashRoundHint'))
    keys.forEach(k => {
      assert('zh 含 ' + k, new RegExp('\\b' + k + ':').test(zh), '')
    })
    // en 段（文件后半）：从 en 的 chRoundLabel 开始截
    const enIdx = I18N.lastIndexOf('chRoundLabel:')
    const en = I18N.slice(enIdx, enIdx + 4000)
    keys.forEach(k => {
      assert('en 含 ' + k, new RegExp('\\b' + k + ':').test(en), '')
    })
    // 函数型词条必须成对（带参数）
    assert('chHardRoundTag 中英均为函数型（带题量参数）',
      /chHardRoundTag:\s*\(n\)\s*=>/.test(zh) && /chHardRoundTag:\s*\(n\)\s*=>/.test(en), '')
    assert('chRound1WrongTitle 中英均为函数型（带条数参数）',
      /chRound1WrongTitle:\s*\(n\)\s*=>/.test(zh) && /chRound1WrongTitle:\s*\(n\)\s*=>/.test(en), '')
  }

  console.log('')
  if (testFailed) { console.log('❌ v111 测试存在失败项'); process.exit(1) }
  console.log('✅ v111 测试全部通过')
})()

function attr(arr, d) { return arr.filter(x => Number(x) === d).length }
function count(arr) { const c = { 1: 0, 2: 0, 3: 0 }; arr.forEach(d => c[d]++); return c }
