// test-v150-release-bypass-chapter.js
// v150：放行键 = 最高权限 —— 已被逐人放行的线下课最终考试无视章节锁
//
// 背景（真实故障，2026-10-08）：
//   用户报「线下课 我给杨宇航考试放行了 但他无法考试 一直提示未放行」。
//   ★ 核查线上数据（真实源码 + 真实云端课库，vm 沙箱重演）后确认：**放行闸门完全正常**
//       courseFinalOpened = {"yang":{"at":...,"by":"admin"}}、courseGateOpenedFor = true、
//       courseGateLocked = false、courseGateWaitFor = false、courseRetryBlocked = false。
//   ★ 真凶是**另一道闸门**：这场考试挂了 chapter:'Final Episode'，而该章节名是后来新建作业时
//       才第一次出现的 → 不在建班时 initChOpenForNewClass 写下的 chOpen 快照里 →
//       按 v134「默认关闭」语义被判锁定 → courseStart 第 536 行的**章节闸门**在放行闸门
//       之前就 return 了，管理员无论怎么点放行都无效。
//   用户拍板的修法（verbatim）：「我的解锁键作为最高权限 无视是否完成所有章节」。
//
// ★★ 本版契约（最重要的一条）：
//   coursefinal + 已逐人放行  ⇒  章节锁**失效**（放行键压过章节锁）。
//   理由：放行是管理员对「某一个具体的人」的直接授权；章节开放是面向全体的批量状态。
//   前者更具体、更晚生效，且是考试现场唯一的救场手段。
//   ★ 普通 exam 不豁免 —— 章节锁属于老师排课节奏，不该被放行键绕过。
//
// 分组：
//   ① 判定函数真值表（courseFinalReleasedBypass，沙箱真跑，含 fail-open 失效方向）
//   ② courseStart 闸门接线（豁免支在闸门之前算 + 只认 coursefinal + 拦截文案不变）
//   ③ 渲染链：visNextIdx 豁免 / 章节条按已开放形态 / 章节粒度不逐行抖动
//   ④ 反向保护：普通 exam 不豁免、未放行不豁免、已考完不误判、无 courseFinalOpened 字段安全
//   ⑤ 沙箱端到端：真实 courseStudentPathHtml 跑「关闭章节里放行了最终考试」场景
//   ⑥ 版本号
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HERE = __dirname
const read = f => fs.readFileSync(path.join(HERE, f), 'utf-8')

const CA = read('course-app.js')
const CS = require('./course-store.js')
const HTML = read('index.html')

let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}
function group(t) { console.log('\n▌' + t) }

// ---- extractFn（配平扫描完整函数声明） ----
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
// 取函数体（对象方法简写 / 顶层声明两种形态）
function fnBody(src, name) {
  const variants = [
    'function ' + name + '(',
    'async function ' + name + '(',
    '\n  ' + name + '(',
    '\n  async ' + name + '(',
  ]
  for (const needle of variants) {
    const fi = src.indexOf(needle)
    if (fi < 0) continue
    const parenAt = fi + needle.indexOf('(')
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
function codeOnly(s) {
  return s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
}

// ================================================================
// 沙箱骨架：真实函数 + 按名注入（本项目历史套件定式）
// ================================================================
function mkSandbox(extra) {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Set, Map, Date,
    alert: () => {},
    ...(extra || {}),
  }
  sb.window = sb
  vm.createContext(sb)
  return sb
}
const BYPASS_DEPS = ['courseFinalReleasedBypass']
function injectBypass(sb) {
  BYPASS_DEPS.forEach(n => vm.runInContext(extractFn(CA, n), sb))
}

// ================================================================
// 组一：courseFinalReleasedBypass 真值表
// ================================================================
group('组一 · courseFinalReleasedBypass 真值表（沙箱真跑 course-app.js 实现）')
{
  const sb = mkSandbox()
  injectBypass(sb)
  const run = expr => vm.runInContext(expr, sb)

  assert('最终考试 + 已放行 → true',
    run('courseFinalReleasedBypass({type:"coursefinal",courseFinalOpened:{u1:{at:1}}},"u1")') === true)
  assert('最终考试 + 未放行（名单空）→ false',
    run('courseFinalReleasedBypass({type:"coursefinal",courseFinalOpened:{}},"u1")') === false)
  assert('最终考试 + 放行的是别人 → false',
    run('courseFinalReleasedBypass({type:"coursefinal",courseFinalOpened:{other:{at:1}}},"u1")') === false)
  assert('最终考试 + 无 courseFinalOpened 字段 → false',
    run('courseFinalReleasedBypass({type:"coursefinal"},"u1")') === false)
  assert('★ 普通 exam + 有 examOpened 记录 → false（不豁免，章节锁属排课节奏）',
    run('courseFinalReleasedBypass({type:"exam",examGate:true,examOpened:{u1:{at:1}}},"u1")') === false)
  assert('普通 homework → false',
    run('courseFinalReleasedBypass({type:"homework"},"u1")') === false)
  assert('video → false',
    run('courseFinalReleasedBypass({type:"video"},"u1")') === false)
  assert('offline → false',
    run('courseFinalReleasedBypass({type:"offline"},"u1")') === false)
  assert('null → false（不抛错）',
    run('courseFinalReleasedBypass(null,"u1")') === false)
  assert('undefined → false（不抛错）',
    run('courseFinalReleasedBypass(undefined,"u1")') === false)
  assert('★ u 为 null → false（不因空用户名误放行）',
    run('courseFinalReleasedBypass({type:"coursefinal",courseFinalOpened:{"":{at:1}}},null)') === false)
  assert('★ 脏数据 courseFinalOpened 为字符串 → false（不抛错）',
    run('courseFinalReleasedBypass({type:"coursefinal",courseFinalOpened:"broken"},"u1")') === false)
  assert('★ 整体包了 try/catch（fail-open 失效方向的结构保证）',
    /try\s*\{[\s\S]*\}\s*catch/.test(fnBody(CA, 'courseFinalReleasedBypass')))
  assert('★ 只读 a.courseFinalOpened，不读 examOpened（两名单不可互串）',
    !codeOnly(fnBody(CA, 'courseFinalReleasedBypass')).includes('examOpened'))
}

// ================================================================
// 组二：courseStart 闸门接线
// ================================================================
group('组二 · courseStart 章节闸门接线（豁免支位置 + 条件）')
{
  const body = codeOnly(fnBody(CA, 'courseStart'))
  assert('豁免判定 alreadyReleased 存在', body.includes('const alreadyReleased ='))
  assert('★ 豁免条件 = 最终考试 && 已放行',
    /const alreadyReleased = courseIsFinal\(a\) && courseGateOpenedFor\(a, me0\)/.test(body))
  assert('★ 章节闸门带豁免支',
    body.includes('if (!courseChapterOpened(c, a.chapter) && !alreadyReleased)'))
  const iBypass = body.indexOf('const alreadyReleased =')
  const iGate = body.indexOf('if (!courseChapterOpened(c, a.chapter) && !alreadyReleased)')
  assert('★ 豁免判定在章节闸门之前计算（否则拿不到值）', iBypass > 0 && iBypass < iGate)
  // 顺序保护：豁免判定必须在 draft 之后（草稿不允许因放行而可见）
  const iDraft = body.indexOf("a.status === 'draft'")
  assert('★ 豁免判定在草稿拦截之后（草稿仍不可作答，放行键也救不了）', iBypass > iDraft)
  // 拦截文案保持不变（未放行的作业被章节锁拦住时，提示仍要说「章节未开放」）
  assert('拦截文案仍走 courseChapterNotOpen（未被改动）',
    body.includes("alert(t('courseChapterNotOpen'"))
  assert('未分章作业被拦时显示「未归入章节」而非空串',
    /String\(a\.chapter == null \? '' : a\.chapter\)\.trim\(\) \|\| t\('courseChapterNone'\)/.test(body))
  // 放行闸门仍在（豁免只影响章节闸门，不放宽放行闸门本身）
  assert('★ 放行闸门 courseGateLocked 仍在闸门链上（豁免没有绕过它）',
    body.includes('if (courseGateLocked(a, me, res))'))
  const iChapGate = body.indexOf('if (!courseChapterOpened(c, a.chapter) && !alreadyReleased)')
  const iGateLocked = body.indexOf('if (courseGateLocked(a, me, res))')
  assert('章节闸门仍排在放行闸门之前（顺序未变）', iChapGate < iGateLocked)
}

// ================================================================
// 组三：渲染链
// ================================================================
group('组三 · 渲染链（visNextIdx 豁免 / 章节条形态 / 章节粒度）')
{
  const pathFn = fnBody(CA, 'courseStudentPathHtml')
  assert('★ visNextIdx 跳过关闭章节时带放行豁免',
    /if \(!courseChapterOpened\(c, assigns\[i\]\.chapter\) && !courseFinalReleasedBypass\(assigns\[i\], me\)\) continue/.test(pathFn))
  assert('★ 章节开放态 = 整章开放 || 本章含已放行最终考试',
    /chOpenCur = courseChapterOpened\(c, chName\) \|\| courseChapterHasReleasedFinal\(assigns, me, chName\)/.test(pathFn))
  // 章节粒度保护：chOpenCur 必须在 isNewChapter 分支里算一次，不得逐行抖动
  const iNew = pathFn.indexOf('const isNewChapter =')
  const iAssign = pathFn.indexOf('chOpenCur = courseChapterOpened')
  assert('★ chOpenCur 仍在 isNewChapter 分支内赋值（章节粒度，不逐行抖动）',
    iNew > 0 && iAssign > iNew && iAssign < iNew + 400)
  assert('★ 未放行的最终考试仍走 v148 锁条（豁免没有误开未放行的人）',
    /const gWait = courseGateWaitFor\(/.test(pathFn))
  assert('右侧「无可见下一步」三分支仍在（全完成 / 等待放行 / 等待章节）',
    pathFn.includes("const allDone = nextIdx === -1") && pathFn.includes('const gateWaiting ='))
}

// ================================================================
// 组四：courseChapterHasReleasedFinal 真值表
// ================================================================
group('组四 · courseChapterHasReleasedFinal 真值表（章节条形态判定）')
{
  const sb = mkSandbox()
  injectBypass(sb)
  vm.runInContext(extractFn(CA, 'courseChapterHasReleasedFinal'), sb)
  const run = expr => vm.runInContext(expr, sb)

  const assigns = JSON.stringify([
    { id: 'a1', title: 'A1', chapter: '第二章', results: {} },
    { id: 'a2', title: 'F1', type: 'coursefinal', chapter: '第二章', courseFinalOpened: { u1: { at: 1 } }, results: {} },
  ])
  assert('本章含「已放行未完成」最终考试 → true',
    run(`courseChapterHasReleasedFinal(${assigns},"u1","第二章")`) === true)
  assert('★ 已考完的最终考试不算（考完不再需要这一章可见）',
    run(`courseChapterHasReleasedFinal(${JSON.stringify([
      { id: 'a2', type: 'coursefinal', chapter: '第二章', courseFinalOpened: { u1: { at: 1 } }, results: { u1: { score: 90 } } },
    ])},"u1","第二章")`) === false)
  assert('★ 放行的是别人 → false',
    run(`courseChapterHasReleasedFinal(${assigns},"u2","第二章")`) === false)
  assert('章节名不同 → false',
    run(`courseChapterHasReleasedFinal(${assigns},"u1","第三章")`) === false)
  assert('★ 章节名带空格仍能匹配（与 chKey trim 口径一致）',
    run(`courseChapterHasReleasedFinal(${JSON.stringify([
      { id: 'a2', type: 'coursefinal', chapter: '  第二章  ', courseFinalOpened: { u1: { at: 1 } }, results: {} },
    ])},"u1","第二章")`) === true)
  assert('★ 未分章（chapter 缺失）与空串同键',
    run(`courseChapterHasReleasedFinal(${JSON.stringify([
      { id: 'a2', type: 'coursefinal', courseFinalOpened: { u1: { at: 1 } }, results: {} },
    ])},"u1","")`) === true)
  assert('assigns 非数组 → false（不抛错）',
    run('courseChapterHasReleasedFinal(null,"u1","第二章")') === false)
  assert('普通 exam 挂章不算 → false（不豁免）',
    run(`courseChapterHasReleasedFinal(${JSON.stringify([
      { id: 'a3', type: 'exam', examGate: true, chapter: '第二章', examOpened: { u1: { at: 1 } }, results: {} },
    ])},"u1","第二章")`) === false)
}

// ================================================================
// 组五：沙箱端到端（真实 courseStudentPathHtml 跑真实场景）
// ================================================================
group('组五 · 端到端：关闭章节里放行了最终考试（真实渲染函数）')
{
  function render(chOpen, assigns) {
    const sb = {
      console, JSON, Object, Array, String, Number, Math, Set, Map, Date, alert: () => {},
      escHtml: s => String(s == null ? '' : s),
      escAttr: s => String(s == null ? '' : s),
      t: (k, a, b) => (a === undefined ? k : `${k}:${a}/${b}`),
      courseTaskDone: (a, r) => !!(r && r.done !== false && r.score !== undefined ? r : (r ? r : null)) || !!r,
      courseTaskIcon: () => '[i]',
      courseTaskMetaText: () => 'meta',
      courseIsOffline: () => false,
      courseChapterStat: (list, me, chName) => {
        let done = 0, total = 0
        ;(list || []).forEach(a => {
          if (String(a.chapter == null ? '' : a.chapter).trim() !== chName) return
          total++; if (me && (a.results || {})[me]) done++
        })
        return { done, total }
      },
      CourseStore: { chKey: CS.chKey, chOpen: CS.chOpen },
      courseChapterOpened: (cls, chName) => CS.chOpen(cls, chName) === true,
    }
    sb.window = sb
    vm.createContext(sb)
    const src = extractFn(CA, 'courseResetRecSafe') + '\n' + extractFn(CA, 'courseRetryUsedSafe') + '\n' +
      extractFn(CA, 'courseGateWaitFor') + '\n' +
      extractFn(CA, 'courseFinalReleasedBypass') + '\n' + extractFn(CA, 'courseChapterHasReleasedFinal') + '\n' +
      extractFn(CA, 'courseStudentPathHtml')
    vm.runInContext(src + '\nglobalThis.__cp = courseStudentPathHtml;', sb)
    // courseTaskDone 用真实口径：有成绩即完成
    vm.runInContext('function courseTaskDone(a, r){ return !!r }', sb)
    const cls = {
      id: 'c1', name: 'CE Class', members: ['u1'], chInit: true,
      chOpen, assignments: assigns,
    }
    return sb.__cp([cls], 'u1') || ''
  }

  // 场景 A：关闭章节里有「已放行未完成」的最终考试 → 该考试行必须可见且可点
  const A = render({ '第二章': false, '': true }, [
    { id: 'a1', title: 'A1', chapter: '第二章', results: {} },
    { id: 'a2', title: '终极大考', type: 'coursefinal', chapter: '第二章', courseFinalOpened: { u1: { at: 1 } }, results: {} },
  ])
  assert('A.1 章节条按「已开放」形态渲染（无 cp-chapter-closed）', !/cp-chapter-closed/.test(A))
  assert('A.2 该章节头不带「🔒 未开放」', !A.includes('🔒courseChapterLocked'))
  assert('A.3 已放行的最终考试行可见', A.includes('终极大考'))
  assert('A.4 ★ 该行可点（有 onclick="courseStart）',
    /onclick="courseStart\('c1','a2'\)"/.test(A))
  assert('A.5 ★ 不被渲染成 v148 锁条（无 flag-gate）', !/flag-gate/.test(A))

  // 场景 B：关闭章节里只有「未放行」的最终考试 → 整章收起，行不可见
  const B = render({ '第二章': false, '': true }, [
    { id: 'a1', title: 'A1', chapter: '第二章', results: {} },
    { id: 'a2', title: '终极大考', type: 'coursefinal', chapter: '第二章', courseFinalOpened: {}, results: {} },
  ])
  assert('B.1 未放行 → 整章仍收起（cp-chapter-closed 出现）', /cp-chapter-closed/.test(B))
  assert('B.2 ★ 未放行的考试行不渲染（放行键未生效，章节锁照旧）', !B.includes('终极大考'))

  // 场景 C：关闭章节里的普通作业 → 仍被锁（不豁免）
  const C = render({ '第二章': false, '': true }, [
    { id: 'a1', title: '普通作业', chapter: '第二章', results: {} },
  ])
  assert('C.1 ★ 普通作业仍被章节锁收起（未豁免）', !C.includes('普通作业'))
  assert('C.2 锁定条形态正常（有 locked class）', /cp-chapter-closed/.test(C))

  // 场景 D：普通 exam 即使放行也仍被章节锁（不豁免）
  const D = render({ '第二章': false, '': true }, [
    { id: 'a1', title: '随堂测评', type: 'exam', examGate: true, chapter: '第二章', examOpened: { u1: { at: 1 } }, results: {} },
  ])
  assert('D.1 ★ 普通 exam 放行后仍被章节锁收起（只豁免 coursefinal）', !D.includes('随堂测评'))

  // 场景 E：章节本就开放 + 放行 → 一切照旧（豁免不引入副作用）
  const E = render({ '第二章': true, '': true }, [
    { id: 'a2', title: '终极大考', type: 'coursefinal', chapter: '第二章', courseFinalOpened: { u1: { at: 1 } }, results: {} },
  ])
  assert('E.1 章节开放 + 已放行 → 行可见可点', E.includes('终极大考') && /onclick="courseStart\('c1','a2'\)"/.test(E))
  assert('E.2 无锁条', !/flag-gate/.test(E))

  // 场景 F：div/span 配平（章节条形态切换不得破坏结构）
  ;[['A', A], ['B', B], ['C', C], ['D', D], ['E', E]].forEach(([k, h]) => {
    const od = (h.match(/<div\b/g) || []).length, cd = (h.match(/<\/div>/g) || []).length
    const os = (h.match(/<span\b/g) || []).length, cs2 = (h.match(/<\/span>/g) || []).length
    assert(`F.${k} div 配平（${od}/${cd}）`, od > 0 && od === cd)
    assert(`F.${k} span 配平（${os}/${cs2}）`, os > 0 && os === cs2)
  })
}

// ================================================================
// 组六：版本号
// ================================================================
group('组六 · 版本号')
{
  const v150 = (HTML.match(/\?v=150/g) || []).length
  const v149 = (HTML.match(/\?v=149/g) || []).length
  assert(`index.html 全部 ?v=150（实得 ${v150}）`, v150 === 12)
  assert(`index.html 无残留 ?v=149（实得 ${v149}）`, v149 === 0)
}

// ================================================================
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAILURES') + `  —  PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
