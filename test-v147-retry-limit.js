// test-v147-retry-limit.js
// v147：重置成绩台账 + 「重置后只能重考一次」+ 看板可见可追溯 + 改题影响预警
//
// 背景（真实事故，2026-10-06 诊断）：
//   管理员点「重置成绩」后，学员能**无限重考** —— 因为 courseResetResult 只做 delete a.results[u]，
//   而 courseStart 判「能不能作答」只看 !res。重置既删成绩、又保留放行名单 → 学员立刻变回「未作答」态。
//   同时重置静默消失（看板无痕）；改题后旧成绩的题数与当前题目不一致 → 分数不可比且无任何提示。
//
// 本套件分 6 组：
//   1. 纯函数真值表（沙箱真跑 courseResetRecOf / courseResetUnconsumed / courseRetryBlocked / courseResetTryOf）
//   2. 接线断言（courseStart 判定链顺序、courseSaveResult 消耗、渲染接线）
//   3. 反转断言（旧的裸删已消失）
//   4. course-store：离线补传同样消耗台账 + renameUser 迁移台账
//   5. i18n 词条 zh/en 成对 + 类型一致
//   6. 保护性断言（防自我递归、防三元内联类退化）
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HERE = __dirname
const read = f => fs.readFileSync(path.join(HERE, f), 'utf-8')

const CA = read('course-app.js')
const CS = read('course-store.js')
const I18N = read('i18n.js')
const CSS = read('style.css')

let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
function group(t) { console.log('\n▌' + t) }

// ---- extractFn（兼容 async 前缀，配平扫描） ----
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
// 取函数体（含「function 声明」与「对象方法简写」两种形态）
// ★ v147 实撞：course-store.js 里 _applyResultOp / renameUser 是**对象方法简写**
//   （`_applyResultOp(doc, op) {`），没有 `function ` 前缀 → 用 function-only 版取到 0 长度，
//   11 条断言集体假失败（看着像生产代码没写，其实是夹具取不到）。两种形态都要支持。
function fnBody(src, name) {
  const variants = [
    'function ' + name + '(',       // 顶层函数声明
    'async function ' + name + '(', // 顶层 async 函数声明
    '\n  ' + name + '(',            // 对象方法简写（两空格缩进）
    '\n  async ' + name + '(',      // 对象 async 方法简写
  ]
  for (const needle of variants) {
    const fi = src.indexOf(needle)
    if (fi < 0) continue
    const parenAt = fi + needle.indexOf('(')
    // 先跳完形参表（默认值里可能含 '{'），再定位函数体的 '{'
    let pd = 0, bodyAt = -1
    for (let k = parenAt; k < src.length; k++) {
      if (src[k] === '(') pd++
      else if (src[k] === ')') { pd--; if (pd === 0) { bodyAt = src.indexOf('{', k); break } }
    }
    if (bodyAt < 0) continue
    let depth = 0, end = -1
    for (let i = bodyAt; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end > 0) return src.slice(bodyAt, end + 1)
  }
  return ''
}
// 剥注释行（v133 定式：否定断言前必做）
function codeOnly(s) {
  return s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
}

// ================================================================
// 组一：纯函数真值表（沙箱真跑生产代码）
// ================================================================
group('组一 · 重置台账纯函数真值表（沙箱真跑 course-app.js 实现）')
{
  const sb = { console, JSON, Object, Array, String, Number, Math, Date }
  sb.globalThis = sb
  vm.createContext(sb)
  ;['courseResetRecOf', 'courseResetUnconsumed', 'courseRetryBlocked', 'courseResetTryOf']
    .forEach(n => vm.runInContext(extractFn(CA, n), sb))

  const run = expr => vm.runInContext(expr, sb)
  const A = (resets) => ({ id: 'a1', type: 'coursefinal', results: {}, resultResets: resets })

  // --- courseResetRecOf：只取对象形态，脏数据一律 null ---
  assert('无 resultResets → rec = null', run('courseResetRecOf({id:"a"}, "u1")') === null)
  assert('有记录 → 返回该对象',
    run('courseResetRecOf({resultResets:{u1:{n:1}}}, "u1").n') === 1)
  assert('用户名不存在 → null',
    run('courseResetRecOf({resultResets:{u1:{n:1}}}, "u2")') === null)
  assert('u 为 null → null（不炸）',
    run('courseResetRecOf({resultResets:{u1:{n:1}}}, null)') === null)
  assert('a 为 null → null',
    run('courseResetRecOf(null, "u1")') === null)
  assert('记录是字符串（脏数据）→ null',
    run('courseResetRecOf({resultResets:{u1:"x"}}, "u1")') === null)

  // --- courseResetUnconsumed ---
  assert('有重置且未消耗 → true',
    run('courseResetUnconsumed({resultResets:{u1:{n:1,consumed:false}}}, "u1")') === true)
  assert('有重置但已消耗 → false',
    run('courseResetUnconsumed({resultResets:{u1:{n:1,consumed:true}}}, "u1")') === false)
  assert('n=0 → false（次数为 0 不算重置过）',
    run('courseResetUnconsumed({resultResets:{u1:{n:0,consumed:false}}}, "u1")') === false)
  assert('无记录 → false',
    run('courseResetUnconsumed({resultResets:{}}, "u1")') === false)

  // --- courseRetryBlocked：★★ 核心三态 ---
  assert('★ 有成绩 → 永不 blocked（有成绩由「限考一次」分支负责）',
    run('courseRetryBlocked({resultResets:{u1:{n:1,consumed:true}}}, "u1", {score:90})') === false)
  assert('★ 无成绩 + 从未重置 → 不 blocked（正常首次作答）',
    run('courseRetryBlocked({resultResets:{}}, "u1", null)') === false)
  assert('★ 无成绩 + 已重置未消耗 → 不 blocked（正是「重置后能重考一次」）',
    run('courseRetryBlocked({resultResets:{u1:{n:1,consumed:false}}}, "u1", null)') === false)
  assert('★★ 无成绩 + 重置已被消耗 → blocked（重考机会用完）',
    run('courseRetryBlocked({resultResets:{u1:{n:1,consumed:true}}}, "u1", null)') === true)
  assert('★★ 再重置一次 → 重新 open（循环语义：重置一次=考一次）',
    run('courseRetryBlocked({resultResets:{u1:{n:2,consumed:false}}}, "u1", null)') === false)
  assert('a 为 null → 不 blocked（不炸）',
    run('courseRetryBlocked(null, "u1", null)') === false)

  // --- courseResetTryOf：快照结构 ---
  const snap = run('JSON.stringify(courseResetTryOf({at:111,score:88,correct:22,total:25,attempts:3}, 999))')
  assert('快照含原成绩各字段 + resetAt',
    snap === JSON.stringify({ at: 111, score: 88, correct: 22, total: 25, attempts: 3, resetAt: 999 }), snap)
  assert('prev 为空 → null（不造空快照）',
    run('courseResetTryOf(null, 999)') === null)

  const src = (() => { try { return read('course-app.js') } catch (e) { return '' } })()
  assert('★ 四个函数均取自真实源码（防测试重写副本）',
    src.indexOf('function courseRetryBlocked(') >= 0 && src.indexOf('function courseResetTryOf(') >= 0)
}

// ================================================================
// 组二：接线断言 —— 判定链顺序 + 消耗时机
// ================================================================
group('组二 · 接线断言（courseStart 判定链 / courseSaveResult 消耗 / 渲染）')
{
  const body = fnBody(CA, 'courseStart')
  assert('courseStart 函数体已抽出', body.length > 500, body.length)
  assert('★ 接线：courseStart 调用 courseRetryBlocked',
    body.indexOf('courseRetryBlocked(a, me, res)') >= 0)
  assert('★ 拦截文案用 courseRetryUsed 键',
    body.indexOf("t('courseRetryUsed')") >= 0)

  // ★★ 顺序：回顾分支 < 重考拦截 < 闸门拦截
  const iReview = body.indexOf('courseReviewPending(a, res)')
  const iRetry = body.indexOf('courseRetryBlocked(a, me, res)')
  const iGate = body.indexOf('courseGateLocked(a, me, res)')
  assert('三个锚点都在场（否则顺序断言无意义）', iReview >= 0 && iRetry >= 0 && iGate >= 0,
    { iReview, iRetry, iGate })
  assert('★★ 顺序：回顾 > 重考拦截（回顾是本次成绩的后续，不是重考）', iReview >= 0 && iReview < iRetry,
    { iReview, iRetry })
  assert('★★ 顺序：重考拦截 > 闸门拦截（否则会误报「等待放行」而非「重考机会用完」）',
    iRetry >= 0 && iRetry < iGate, { iRetry, iGate })

  // --- courseSaveResult 消耗台账 ---
  const sb = fnBody(CA, 'courseSaveResult')
  assert('courseSaveResult 函数体已抽出', sb.length > 300, sb.length)
  assert('★ 接线：交卷后消耗台账（rec.consumed = true）',
    sb.indexOf('courseResetRecOf(a, me)') >= 0 && /rec\.consumed\s*=\s*true/.test(sb))
  assert('★ 消耗在同一 mutate 内（与成绩写入原子）',
    sb.indexOf('courseBuildResultEntry(a, prev') >= 0 &&
    sb.indexOf('courseBuildResultEntry(a, prev') < sb.indexOf('rec.consumed = true'))

  // --- courseResetResult 写台账 ---
  const rr = fnBody(CA, 'courseResetResult')
  assert('courseResetResult 函数体已抽出', rr.length > 300, rr.length)
  assert('★ 接线：重置写 n 累加', /rec\.n\s*=\s*\(Number\(rec\.n\)\s*\|\|\s*0\)\s*\+\s*1/.test(rr))
  assert('★ 接线：重置压入成绩快照', rr.indexOf('courseResetTryOf(prev, now)') >= 0)
  assert('★ 接线：重置后 consumed=false（授予一次机会）', /rec\.consumed\s*=\s*false/.test(rr))
  assert('★ 无成绩时不新增台账（防连点凭空多记录）', /if\s*\(!prev\)\s*return false/.test(rr))
  assert('★ 快照条数封顶 10（防 1MB 容量膨胀）', rr.indexOf('rec.tries.length > 10') >= 0)
  assert('★ 重置保留放行名单（courseFinalOpened/examOpened 均未删）',
    !/delete\s+a\.(courseFinalOpened|examOpened)/.test(rr))

  // --- courseResetUndo ---
  const ru = fnBody(CA, 'courseResetUndo')
  assert('courseResetUndo 函数体已抽出', ru.length > 200, ru.length)
  assert('★ 撤销有「已消耗则拒绝」守卫（防抹掉真实作答）',
    /rec\.consumed\s*\)\s*return false/.test(ru))
  assert('★ 撤销归还成绩（写回 a.results[u]）', ru.indexOf('a.results[u] = {') >= 0)
  assert('★ 撤销后 n 减 1', /rec\.n\s*=\s*\(Number\(rec\.n\)\s*\|\|\s*0\)\s*-\s*1/.test(ru))
  assert('★ n 归零则删除整条记录', /if\s*\(rec\.n <= 0\)\s*delete a\.resultResets\[u\]/.test(ru))

  // --- 渲染接线（管理端表格） ---
  const ad = fnBody(CA, 'courseAssignDetail')
  assert('courseAssignDetail 函数体已抽出', ad.length > 1000, ad.length)
  assert('★ 渲染：状态列调用 courseResetRecSafe（读取侧 fail-open）',
    ad.indexOf('courseResetRecSafe(a, u)') >= 0)
  assert('★ 渲染：「已重置·待重考」标签（courseResetPendingTag）',
    ad.indexOf("t('courseResetPendingTag')") >= 0)
  assert('★ 渲染：重置次数徽标（courseResetTimesFmt）',
    ad.indexOf("t('courseResetTimesFmt'") >= 0)
  assert('★ 渲染：待重考时按钮改成「撤销重置」',
    ad.indexOf('courseResetUndo(this)') >= 0 && ad.indexOf("t('courseResetUndo')") >= 0)
  assert('★ 渲染：撤销按钮带 data-c/data-a/data-u（不把用户名拼进 onclick）',
    /data-u="\$\{escAttr\(u\)\}"[^>]*onclick="courseResetUndo\(this\)"/.test(ad))

  // --- 学员端大纲行 ---
  const sp = fnBody(CA, 'courseStudentPathHtml')
  assert('★ 学员端：大纲行走安全版读取（courseResetRecSafe / courseRetryUsedSafe）',
    sp.indexOf('courseResetRecSafe(a, me)') >= 0 && sp.indexOf('courseRetryUsedSafe(a, me') >= 0)
  assert('★ 学员端：重考中角标 class flag-reset', sp.indexOf('flag-reset') >= 0)
  assert('★ 学员端：机会用完角标 class flag-stale', sp.indexOf('flag-stale') >= 0)

  // --- 导出 ---
  const ec = fnBody(CA, 'courseExportCell')
  assert('★ 导出：无成绩时读台账（走安全版）', ec.indexOf('courseResetRecSafe(a, u)') >= 0)
  assert('★ 导出：区分「已重置待重考」与「从未作答」',
    ec.indexOf("t('courseResetPendingTag')") >= 0 && ec.indexOf("t('courseDashNotDone')") >= 0)
  assert('★ 导出调用点传了第 3 参 u',
    /courseExportCell\(a, \(a\.results \|\| \{\}\)\[u\], u\)/.test(CA))

  // --- ★★ fail-open 边界：写入侧 / 拦截侧 / 动作侧一律**不得**走安全版 ---
  //   读取侧 fail-open（台账读不到就当没有），动作侧必须 fail-closed（缺依赖要响亮地炸，
  //   否则会静默变成「重置无效」或「重考限制失效」—— 那正是本次要修的病）。
  const safeFn = fnBody(CA, 'courseResetRecSafe')
  assert('★ courseResetRecSafe 已定义', safeFn.length > 100, safeFn.length)
  // ★★ 自包含（不调用本文件其它函数）：这是 7 个历史套件沙箱能跑通的前提。
  //   若改回「调用 courseResetRecOf + typeof 守卫」，沙箱未注入 courseResetRecOf 时会 ReferenceError
  //   （v147 实撞：一次挂 7 个套件、29 条断言）。
  assert('★★ courseResetRecSafe 自包含（不调用 courseResetRecOf）',
    safeFn.indexOf('courseResetRecOf') < 0)
  assert('★ courseResetRecSafe 有 try/catch 兜底', safeFn.indexOf('try {') >= 0 && safeFn.indexOf('catch (e)') >= 0)
  assert('★ courseResetRecSafe 口径与原函数一致（读 a.resultResets[u] 且判定 object）',
    safeFn.indexOf('a.resultResets') >= 0 && safeFn.indexOf('typeof rec === \'object\'') >= 0)
  const usedSafeFn = fnBody(CA, 'courseRetryUsedSafe')
  assert('★ courseRetryUsedSafe 已定义', usedSafeFn.length > 80, usedSafeFn.length)
  assert('★★ courseRetryUsedSafe 自包含（不调用 courseRetryBlocked）',
    usedSafeFn.indexOf('courseRetryBlocked') < 0)
  assert('★ courseRetryUsedSafe 判定口径与 courseRetryBlocked 一致（res 短路 + n>0 + consumed）',
    usedSafeFn.indexOf('if (!a || res) return false') >= 0 &&
    usedSafeFn.indexOf('rec.n > 0') >= 0 && usedSafeFn.indexOf('rec.consumed') >= 0)

  // ★★ 口径一致性：安全版与真版必须同真值表（两份实现，靠断言锁死）
  {
    const sb = { console, JSON, Object, Array, String, Number, Math, Date }
    sb.globalThis = sb
    vm.createContext(sb)
    ;['courseResetRecOf', 'courseResetUnconsumed', 'courseRetryBlocked', 'courseResetRecSafe', 'courseRetryUsedSafe']
      .forEach(n => vm.runInContext(extractFn(CA, n), sb))
    const cases = [
      '({}, "u1", null)',
      '({resultResets:{}}, "u1", null)',
      '({resultResets:{u1:{n:1,consumed:false}}}, "u1", null)',
      '({resultResets:{u1:{n:1,consumed:true}}}, "u1", null)',
      '({resultResets:{u1:{n:2,consumed:false}}}, "u1", null)',
      '({resultResets:{u1:{n:1,consumed:true}}}, "u1", {score:90})',
      '({resultResets:{u1:"dirty"}}, "u1", null)',
      '({resultResets:{u1:{n:0,consumed:false}}}, "u1", null)',
    ]
    const mismatches = []
    cases.forEach(c => {
      const real = vm.runInContext(`courseRetryBlocked(${c})`, sb)
      const safe = vm.runInContext(`courseRetryUsedSafe(${c})`, sb)
      if (real !== safe) mismatches.push([c, real, safe])
    })
    assert('★★ 安全版与真版真值表完全一致（8 组用例）', mismatches.length === 0, mismatches)
    const mism2 = []
    ;['({resultResets:{u1:{n:1}}}, "u1")', '({resultResets:{u1:"x"}}, "u1")', '({}, "u1")', '({resultResets:{u1:{n:1}}}, null)']
      .forEach(c => {
        const r = JSON.stringify(vm.runInContext(`courseResetRecOf(${c})`, sb))
        const s = JSON.stringify(vm.runInContext(`courseResetRecSafe(${c})`, sb))
        if (r !== s) mism2.push([c, r, s])
      })
    assert('★★ courseResetRecSafe 与 courseResetRecOf 真值表一致（4 组用例）', mism2.length === 0, mism2)
  }
  assert('★★ 拦截侧 courseStart 用**真**courseRetryBlocked（不 fail-open）',
    fnBody(CA, 'courseStart').indexOf('courseRetryBlocked(a, me, res)') >= 0 &&
    fnBody(CA, 'courseStart').indexOf('courseRetryUsedSafe') < 0)
  assert('★★ 写入侧 courseSaveResult 用**真**courseResetRecOf（不 fail-open）',
    fnBody(CA, 'courseSaveResult').indexOf('courseResetRecOf(a, me)') >= 0 &&
    fnBody(CA, 'courseSaveResult').indexOf('courseResetRecSafe') < 0)
  assert('★★ 写入侧 courseResetResult 用**真**courseResetRecOf（不 fail-open）',
    fnBody(CA, 'courseResetResult').indexOf('courseResetRecOf(a, u)') >= 0 &&
    fnBody(CA, 'courseResetResult').indexOf('courseResetRecSafe') < 0)
  assert('★ 取台账口径只有一处（写入侧不再内联读 map）',
    fnBody(CA, 'courseResetResult').indexOf('a.resultResets[u] &&') < 0)
  assert('★★ courseResetUndo 用**真**courseResetRecOf（不 fail-open）',
    fnBody(CA, 'courseResetUndo').indexOf('courseResetRecOf(a, u)') >= 0)
}

// ================================================================
// 组三：Bug3 改题影响预警
// ================================================================
group('组三 · 改题影响预警（Bug3）')
{
  const se = fnBody(CA, 'courseSaveAssignEdit')
  assert('courseSaveAssignEdit 函数体已抽出', se.length > 1000, se.length)
  assert('★ 接线：保存前算受影响人数', /const affected = Object\.keys\(/.test(se))
  assert('★ 接线：题数或题面变化才触发', /oldN !== newN \|\| oldSet !== newSet/.test(se))
  assert('★ 接线：affected > 0 才触发', /if \(affected > 0 &&/.test(se))
  assert('★ 接线：预警文案用 courseEditStaleWarn',
    se.indexOf("t('courseEditStaleWarn'") >= 0)
  // 顺序：预警必须在 courseEditConfirm 之前（先告知影响，再确认保存）
  // ★ v147 实撞：函数里有两处 `t('courseEditConfirm')` —— video 分支（约 1310）与通用分支（约 4400）。
  //   必须限定在**通用分支内**比较，否则锚点落进 video 分支 → 顺序断言假失败。
  const iStale = se.indexOf("t('courseEditStaleWarn'")
  const iQnoq = se.indexOf("t('courseEditNoQ')")            // 通用分支的起点锚
  const iConfirm = se.indexOf("t('courseEditConfirm')", iQnoq)   // 从通用分支起找第一个
  assert('通用分支锚点都在场', iStale >= 0 && iQnoq >= 0 && iConfirm > iQnoq,
    { iStale, iQnoq, iConfirm })
  assert('★★ 顺序：影响预警 > 保存确认（同一通用分支内）', iStale > iQnoq && iStale < iConfirm,
    { iQnoq, iStale, iConfirm })
  assert('★ 预警后 return（用户取消则中止保存）',
    /courseEditStaleWarn[^]*?\)\s*return/.test(se.slice(iStale - 60, iConfirm)),
    se.slice(iStale - 60, iStale + 120))

  // 看板行的「题数已变更」标记
  const ad = fnBody(CA, 'courseAssignDetail')
  assert('★ 接线：题数不一致标记 qnMismatch', ad.indexOf('const qnMismatch =') >= 0)
  assert('★ 判定：比对 r.total 与 a.questions.length',
    /Number\(r\.total\) !== a\.questions\.length/.test(ad))
  assert('★ 渲染：staleTag 挂在成绩单元格', ad.indexOf('${statusHtml}${staleTag}') >= 0)
  assert('★ staleTag 用 stale 样式类', /class="course-status stale"/.test(ad))
}

// ================================================================
// 组四：course-store —— 离线补传消耗 + renameUser 迁移
// ================================================================
group('组四 · course-store（离线补传消耗台账 / 改名迁移台账）')
{
  const ap = fnBody(CS, '_applyResultOp')
  assert('_applyResultOp 函数体已抽出', ap.length > 500, ap.length)
  assert('★ 接线：补传同样消耗台账', /a\.resultResets && a\.resultResets\[op\.u\]/.test(ap))
  assert('★ 只对 homework/exam 消耗（videoquiz/review 不算）',
    /op\.atype === 'homework' \|\| op\.atype === 'exam'/.test(ap))
  assert('★ 消耗放在 a.results[op.u] = entry 之后（以「已算作一次作答」为准）',
    ap.indexOf('a.results[op.u] = entry') >= 0 &&
    ap.indexOf('a.results[op.u] = entry') < ap.indexOf('a.resultResets[op.u]'))
  assert('★ 幂等：已消耗不重复写', /!rr\.consumed\)\s*rr\.consumed = true/.test(ap))

  const rn = fnBody(CS, 'renameUser')
  assert('renameUser 函数体已抽出', rn.length > 500, rn.length)
  assert('★ 接线：改名迁移重置台账', /if \(a\.resultResets && a\.resultResets\[oldU\]\)/.test(rn))
  assert('★ 迁移：n 累加', /nr\.n = \(Number\(nr\.n\) \|\| 0\) \+ \(Number\(or\.n\) \|\| 0\)/.test(rn))
  assert('★ 迁移：两边都有时只要有一边未消耗就给机会',
    /nr\.consumed = !!\(nr\.consumed && or\.consumed\)/.test(rn))
  assert('★ 迁移：删除旧键（防孤儿台账凭空恢复机会）',
    /delete a\.resultResets\[oldU\]/.test(rn))
  assert('★ 迁移：tries 也合并并封顶 10', /nr\.tries = tl\.length > 10/.test(rn))

  // 防自我递归（v134 定式）
  assert('★ course-store 无自我递归写入', !/a\.resultResets\[op\.u\] = a\.resultResets\[op\.u\]/.test(CS))
}

// ================================================================
// 组五：i18n 词条 zh/en 成对 + 类型一致（vm 真跑，不猜块）
// ================================================================
group('组五 · i18n 词条（zh/en 成对 + 类型一致）')
{
  const keys = [
    'courseResetPendingTag', 'courseResetTimesFmt', 'courseResetHistTitle',
    'courseResetUndo', 'courseResetUndoHint', 'courseResetUndoConfirm',
    'courseRetryUsed', 'courseRetryUsedShort',
    'courseStaleTag', 'courseStaleTitle', 'courseEditStaleWarn',
  ]
  let src = I18N + '\n;globalThis.__I18N = I18N;\n'
  const store = {}
  const sb = {
    console, JSON, Math, Date,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] },
      get length() { return Object.keys(store).length },
      key: i => Object.keys(store)[i],
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      body: { appendChild() {}, setAttribute() {} }, addEventListener() {} },
    window: { addEventListener() {}, dispatchEvent() {} },
    navigator: { language: 'zh-CN' }, Event: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(src, sb, { filename: 'i18n.js' })
  const L = sb.__I18N
  assert('I18N 取出成功', !!L && !!L.zh && !!L.en)
  keys.forEach(k => {
    assert('zh 有 ' + k, k in L.zh)
    assert('en 有 ' + k, k in L.en)
    assert('zh/en 类型一致 ' + k,
      typeof L.zh[k] === typeof L.en[k], { zh: typeof L.zh[k], en: typeof L.en[k] })
  })
  // 带参文案必须是函数（否则调用即崩）
  ;['courseResetTimesFmt', 'courseResetUndoConfirm', 'courseStaleTitle', 'courseEditStaleWarn']
    .forEach(k => assert('带参文案是函数 ' + k, typeof L.zh[k] === 'function' && typeof L.en[k] === 'function'))

  assert('zh/en 键数相等', Object.keys(L.zh).length === Object.keys(L.en).length,
    { zh: Object.keys(L.zh).length, en: Object.keys(L.en).length })

  // ★ 断言两条文案的「语义要点」还在（防后人改文案时丢掉关键约束）
  assert('★ courseRetryUsed 文案含「重考机会已用完」语义',
    String(L.zh.courseRetryUsed).indexOf('重考机会已用完') >= 0, L.zh.courseRetryUsed)
  assert('★ courseEditStaleWarn 文案含「重置」建议（引导正确处置）',
    String(L.zh.courseEditStaleWarn).indexOf('重置') >= 0)
  assert('★ courseEditStaleWarn 文案含题数变化（oldN → newN）',
    String(L.zh.courseEditStaleWarn).indexOf('${oldN}') >= 0 && String(L.zh.courseEditStaleWarn).indexOf('${newN}') >= 0)
  assert('★ courseResetConfirm 已标注「每次重置只授予一次」',
    String(L.zh.courseResetConfirm).indexOf('重考一次') >= 0)
}

// ================================================================
// 组六：反转断言 + CSS + 保护性断言
// ================================================================
group('组六 · 反转断言（旧的无限重考路径已消失）/ CSS / 保护性')
{
  // ★ 反转：courseResetResult 不得再是「只删成绩、不留台账」的裸删动作。
  //   ⚠️ 注意断法：新实现里 `delete a.results[u]` **仍然存在**（写完台账照样要删成绩），
  //   所以不能断「不含 delete」（那会假失败）。要断的是**「删」与「台账」同时存在**，
  //   即契约从「删」升级为「删 + 记账」。
  const rr = fnBody(CA, 'courseResetResult')
  const rrCode = codeOnly(rr)
  assert('★★ [v147 反转] 重置 = 删成绩 + 写台账（不再是无痕裸删）',
    rrCode.indexOf('delete a.results[u]') >= 0 && rrCode.indexOf('resultResets') >= 0,
    { hasDelete: rrCode.indexOf('delete a.results[u]') >= 0, hasLedger: rrCode.indexOf('resultResets') >= 0 })
  // 反向：证明上一条不是空转 —— 必须真的存在「台账写入」这一动作（不是只读了 map）
  assert('保护：台账是**写入**而非只读',
    /a\.resultResets\[u\] = rec/.test(rrCode))
  // 且 delete 必须发生在台账写入**之后**（否则中途失败会丢成绩却无记录）
  assert('★ 顺序：先写台账、后删成绩（中途失败不会「成绩没了又无记录」）',
    rrCode.indexOf('a.resultResets[u] = rec') < rrCode.indexOf('delete a.results[u]'),
    { ledger: rrCode.indexOf('a.resultResets[u] = rec'), del: rrCode.indexOf('delete a.results[u]') })

  // ★ 反转：courseStart 不再只靠 !res 判可作答
  const body = codeOnly(fnBody(CA, 'courseStart'))
  assert('★★ [v147 反转] courseStart 判定链已含 courseRetryBlocked',
    body.indexOf('courseRetryBlocked') >= 0)

  // ★ 反转：重置按钮在「已重置待重考」时不显示「重置」（改显示撤销）
  const ad = fnBody(CA, 'courseAssignDetail')
  const btnLine = (ad.match(/<td>\$\{[^}]*courseResetResult[^\n]*/) || [''])[0]
  assert('★ 重置按钮以 r 为条件（无成绩不显示重置）', btnLine.indexOf('r\n') >= 0 || btnLine.indexOf('r ?') >= 0,
    btnLine.slice(0, 80))

  // CSS
  assert('CSS：.course-status.reset 已定义', /\.course-status\.reset\s*\{/.test(CSS))
  assert('CSS：.course-status.stale 已定义', /\.course-status\.stale\s*\{/.test(CSS))
  assert('CSS：.cp-flag.flag-reset 已定义', /\.cp-flag\.flag-reset\s*\{/.test(CSS))
  assert('CSS：.cp-flag.flag-stale 已定义', /\.cp-flag\.flag-stale\s*\{/.test(CSS))

  // 保护性：新函数不得自我递归（v134 定式）
  ;['courseResetRecOf', 'courseResetUnconsumed', 'courseRetryBlocked', 'courseResetTryOf', 'courseResetUndo']
    .forEach(n => {
      const b = fnBody(CA, n)
      assert('无自我递归：' + n, !new RegExp('return\\s+!!?\\s*' + n + '\\s*\\(').test(b))
    })

  // 保护性：新判定不得写成三元内联（v134 定式：循环内三元会静默退化）
  assert('★ courseStudentPathHtml 不得用三元内联取 retryRec',
    !/=\s*[^?\n]*\?\s*courseResetRecOf\(/.test(fnBody(CA, 'courseStudentPathHtml')))

  // 数据兼容：台账必须挂在 assignment 上（不是新建顶层键）
  assert('★ 台账挂在 assignment（a.resultResets）而非顶层',
    CA.indexOf('a.resultResets = a.resultResets || {}') >= 0)
}

console.log('\n' + '='.repeat(60))
console.log(`v147 重置/重考/改题预警：通过 ${pass}，失败 ${fail}`)
console.log('='.repeat(60))
process.exit(fail ? 1 : 0)
