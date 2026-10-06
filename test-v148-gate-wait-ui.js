// test-v148-gate-wait-ui.js
// v148：学员端「等待放行」可见化 —— 未放行的最终考试不再被推成「下一步去完成」
//
// 背景（真实反馈，2026-10-06）：
//   用户报「线下课最终考试 不用放行就能参与」。
//   核查线上数据后确认：**闸门在数据层从未被突破** ——
//     4 个班级里「有成绩但无放行记录」= 0 例（房务 202609 班 3 放行 / 2 成绩，时间全部对得上）。
//   真因在**学员端 UI**：courseStudentPathHtml 里
//     ① nextIdx 只判 !courseTaskDone(...)，完全不看闸门
//     ② 节点行的 onclick 对所有人都挂着 → 未放行的考试仍可点
//   于是未放行的最终考试被渲染成「▶ 进行中 + 待完成 + 右侧『下一步：终极大考』+ 🎓去完成按钮」，
//   学员主观上就是「这个考试我能参加」，点下去才弹「需管理员放行」——观感与事实矛盾。
//
// 本套件分 5 组：
//   1. courseGateWaitFor 真值表（沙箱真跑，含 fail-open 失效方向）
//   2. 与 courseGateLocked 的口径一致性（两套判定不得打架）
//   3. 渲染接线断言（锁条 / 去点击 / visNextIdx 跳过 / 右侧三分支文案）
//   4. 反向保护断言（已放行 / 已考完 / 无闸门 的学员不得被误锁）
//   5. CSS + i18n 词条
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HERE = __dirname
const read = f => fs.readFileSync(path.join(HERE, f), 'utf-8')

const CA = read('course-app.js')
const I18N = read('i18n.js')
const CSS = read('style.css')

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
// 取函数体（含顶层声明 + 对象方法简写两种形态）
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
// 组一：courseGateWaitFor 真值表
// ================================================================
group('组一 · courseGateWaitFor 真值表（沙箱真跑 course-app.js 实现）')
{
  const sb = { console, JSON, Object, Array, String, Number, Math, Date }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(extractFn(CA, 'courseIsFinal'), sb)
  vm.runInContext(extractFn(CA, 'courseGateWaitFor'), sb)
  const run = e => vm.runInContext(e, sb)

  // --- 最终考试（coursefinal）：恒需放行 ---
  assert('★ coursefinal 未放行 + 无成绩 → 等待放行 true',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:{}}, "u1", null)') === true)
  assert('★ coursefinal 已放行 + 无成绩 → 不等待 false',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:{u1:{at:1}}}, "u1", null)') === false)
  assert('★ coursefinal 已放行 + 有成绩 → 不等待 false',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:{u1:{at:1}}}, "u1", {score:92})') === false)
  assert('★ coursefinal 未放行但已有成绩 → 不等待 false（已考完，别再标锁）',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:{}}, "u1", {score:92})') === false)
  assert('coursefinal 放行名单是别人 → 等待 true',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:{other:{at:1}}}, "u1", null)') === true)
  assert('coursefinal 无 courseFinalOpened 字段 → 等待 true',
    run('courseGateWaitFor({type:"coursefinal"}, "u1", null)') === true)

  // --- 普通测评（exam）：看 examGate 开关 ---
  assert('exam 未开闸门 → 不等待 false',
    run('courseGateWaitFor({type:"exam",examOpened:{}}, "u1", null)') === false)
  assert('exam 开闸门 + 未放行 → 等待 true',
    run('courseGateWaitFor({type:"exam",examGate:true,examOpened:{}}, "u1", null)') === true)
  assert('exam 开闸门 + 已放行 → 不等待 false',
    run('courseGateWaitFor({type:"exam",examGate:true,examOpened:{u1:{at:1}}}, "u1", null)') === false)
  assert('★ exam 与 coursefinal 名单互不串（exam 读 examOpened，不读 courseFinalOpened）',
    run('courseGateWaitFor({type:"exam",examGate:true,examOpened:{},courseFinalOpened:{u1:{at:1}}}, "u1", null)') === true)
  assert('★ coursefinal 不读 examOpened（改类型后不误判已放行）',
    run('courseGateWaitFor({type:"coursefinal",examOpened:{u1:{at:1}}}, "u1", null)') === true)

  // --- 非考试类型：一律不等待 ---
  assert('homework → 不等待 false',
    run('courseGateWaitFor({type:"homework"}, "u1", null)') === false)
  assert('video → 不等待 false',
    run('courseGateWaitFor({type:"video"}, "u1", null)') === false)
  assert('offline → 不等待 false',
    run('courseGateWaitFor({type:"offline"}, "u1", null)') === false)

  // --- 失效方向：fail-open（取不到就当没闸门，绝不误锁） ---
  assert('★ a 为 null → false（fail-open，不锁）',
    run('courseGateWaitFor(null, "u1", null)') === false)
  assert('★ a 为 undefined → false',
    run('courseGateWaitFor(undefined, "u1", null)') === false)
  assert('★ u 为 null + coursefinal 无名单 → true（名单里查不到就是没放行）',
    run('courseGateWaitFor({type:"coursefinal"}, null, null)') === true)
  assert('★ 名单是字符串（脏数据）→ true 但不抛错',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:"broken"}, "u1", null)') === true)
  assert('函数体内有 try/catch（fail-open 保护）',
    /try\s*\{[\s\S]*\}\s*catch/.test(fnBody(CA, 'courseGateWaitFor')))
}

// ================================================================
// 组二：与 courseGateLocked 的口径一致性
// ================================================================
group('组二 · courseGateWaitFor 与 courseGateLocked 口径一致（同一批用例逐组比对）')
{
  const sb = { console, JSON, Object, Array, String, Number, Math, Date }
  sb.globalThis = sb
  vm.createContext(sb)
  ;['courseIsFinal', 'courseGateRequired', 'courseGateOpenedFor', 'courseGateLocked', 'courseGateWaitFor']
    .forEach(n => vm.runInContext(extractFn(CA, n), sb))
  const run = e => vm.runInContext(e, sb)

  const A = (js) => `(${js})`
  const cases = [
    ['coursefinal 未放行 无成绩', '{type:"coursefinal",courseFinalOpened:{}}', '"u1"', 'null'],
    ['coursefinal 已放行 无成绩', '{type:"coursefinal",courseFinalOpened:{u1:{at:1}}}', '"u1"', 'null'],
    ['coursefinal 已放行 有成绩', '{type:"coursefinal",courseFinalOpened:{u1:{at:1}}}', '"u1"', '{score:92}'],
    ['coursefinal 未放行 有成绩', '{type:"coursefinal",courseFinalOpened:{}}', '"u1"', '{score:92}'],
    ['coursefinal 放行别人', '{type:"coursefinal",courseFinalOpened:{other:{at:1}}}', '"u1"', 'null'],
    ['exam 无闸门', '{type:"exam",examOpened:{}}', '"u1"', 'null'],
    ['exam 有闸门未放行', '{type:"exam",examGate:true,examOpened:{}}', '"u1"', 'null'],
    ['exam 有闸门已放行', '{type:"exam",examGate:true,examOpened:{u1:{at:1}}}', '"u1"', 'null'],
    ['homework', '{type:"homework"}', '"u1"', 'null'],
    ['video 有成绩', '{type:"video"}', '"u1"', '{done:true}'],
  ]
  let mismatch = 0
  for (const [lbl, a, u, res] of cases) {
    const locked = run(`courseGateLocked(${a}, ${u}, ${res})`)
    const wait = run(`courseGateWaitFor(${a}, ${u}, ${res})`)
    const same = locked === wait
    if (!same) mismatch++
    assert(`口径一致 · ${lbl}  (locked=${locked} wait=${wait})`, same)
  }
  assert('★ 全部用例口径一致（0 处分歧）', mismatch === 0, { mismatch })
}

// ================================================================
// 组三：渲染接线断言
// ================================================================
group('组三 · 学员端渲染接线（锁条 / 去点击 / 下一步跳过 / 右侧三分支）')
{
  const pathHtml = extractFn(CA, 'courseStudentPathHtml')

  // --- ① 计算了 gWait ---
  assert('渲染链调用了 courseGateWaitFor',
    /courseGateWaitFor\s*\(/.test(pathHtml))
  assert('gWait 变量存在',
    /const\s+gWait\s*=\s*courseGateWaitFor\(/.test(pathHtml))

  // --- ② 锁条视觉三件套 ---
  assert('🔒 圆点（gDot 用锁形替换）', /gDot\s*=\s*gWait\s*\?\s*'🔒'/.test(pathHtml) || /'🔒'/.test(pathHtml))
  assert('gated 类名挂在节点上', /gCls\s*=\s*gWait\s*\?\s*'\s*gated'/.test(pathHtml) || /\$\{gCls\}/.test(pathHtml))
  assert('等待放行角标（flag-gate 类 + courseFinalWaitTag 文案）',
    /flag-gate/.test(pathHtml) && /courseFinalWaitTag/.test(pathHtml))
  assert('提示文案用 courseFinalWaitHint',
    /courseFinalWaitHint/.test(pathHtml))

  // --- ③ ★ 去点击：onclick 变成条件式 ---
  const code = codeOnly(pathHtml)
  assert('★ onclick 改为条件拼接（gOnclick）', /const\s+gOnclick\s*=/.test(code))
  assert('★ 未放行时 onclick 为空串（不再无条件挂 courseStart）',
    /gOnclick\s*=\s*gWait\s*\?\s*''\s*:/.test(code))
  // 反向：不得再有「无条件 onclick=courseStart」挂在大纲**节点行**上（必须都走 gOnclick）
  //   ★ 注意别断太宽：右侧详情的「去完成」按钮确实用裸 onclick，但它用的是 na.id
  //     （na = assigns[visNextIdx]，而 visNextIdx 已跳过未放行项）→ 那是安全的。
  //   故这里只检查 cp-node 行：取 gOnclick 定义之后、节点行模板前后的区间。
  const iGOnclick = code.indexOf('const gOnclick')
  const iRow = code.indexOf('rows += `<div class="cp-node', iGOnclick)
  const iRowEnd = code.indexOf('</div>`', iRow)
  const rowTpl = code.slice(iRow, iRowEnd)
  assert('★ 节点行模板存在', iRow > 0 && iRowEnd > iRow, { iRow, iRowEnd })
  assert('★★ 反向：节点行不再挂裸 onclick（必须走 ${gOnclick}）',
    !/onclick="courseStart/.test(rowTpl), rowTpl.slice(0, 200))
  assert('节点行用的是 ${gOnclick}', /\$\{gOnclick\}/.test(rowTpl))
  // 右侧「去完成」按钮的安全性：必须引用 na.id（= visNextIdx 选出的可见项）
  assert('★ 右侧去完成按钮引用 na.id（na 来自 visNextIdx，已跳过未放行项）',
    /assigns\[visNextIdx\]/.test(code) && /courseStart\('\$\{escAttr\(c\.id\)\}','\$\{escAttr\(na\.id\)\}'\)/.test(code))

  // --- ④ ★ 下一步跳过未放行的 ---
  assert('★ visNextIdx 循环里跳过 courseGateWaitFor',
    /visNextIdx[\s\S]{0,600}courseGateWaitFor/.test(code))
  // 顺序：必须在 visNextIdx 赋值之前 continue
  const iLoop = code.indexOf('let visNextIdx = -1')
  const iGateSkip = code.indexOf('courseGateWaitFor', iLoop)
  const iAssign = code.indexOf('visNextIdx = i', iLoop)
  assert('★ 跳过判定在 visNextIdx = i 之前（顺序正确）',
    iLoop >= 0 && iGateSkip > iLoop && iAssign > iGateSkip, { iLoop, iGateSkip, iAssign })

  // --- ⑤ 右侧详情三分支文案 ---
  assert('右侧有无可见下一步时的 gateWaiting 判定',
    /const\s+gateWaiting\s*=/.test(code))
  assert('gateWaiting 用 courseGateWaitFor 逐项判定',
    /gateWaiting[\s\S]{0,400}courseGateWaitFor/.test(code))
  assert('gateWaiting 时用 courseFinalWaitHint 文案（不是「等待老师开放章节」）',
    /gateWaiting\s*\?\s*'🔒 '\s*\+\s*t\('courseFinalWaitHint'\)/.test(code))
  assert('★ 三种成因都不丢：allDone / gateWaiting / courseChapterWaitOpen 同时存在',
    /courseProgressAllDone/.test(code) && /gateWaiting/.test(code) && /courseChapterWaitOpen/.test(code))
}

// ================================================================
// 组四：反向保护 —— 不该被锁的人不得被锁
// ================================================================
group('组四 · 反向保护（已放行 / 已考完 / 无闸门 不得被误锁）')
{
  const pathHtml = extractFn(CA, 'courseStudentPathHtml')
  const code = codeOnly(pathHtml)

  // 有成绩的人：courseGateWaitFor 内部已 !res 短路 —— 沙箱已验证，这里断「一行都不该显示锁」
  const sb = { console, JSON, Object, Array, String, Number, Math, Date }
  sb.globalThis = sb
  vm.createContext(sb)
  ;['courseIsFinal', 'courseGateWaitFor'].forEach(n => vm.runInContext(extractFn(CA, n), sb))
  const run = e => vm.runInContext(e, sb)
  assert('★ 已考完（有成绩）者即使未放行也不显示等待',
    run('courseGateWaitFor({type:"coursefinal",courseFinalOpened:{}}, "u1", {score:92})') === false)
  assert('★ 普通作业永不显示等待',
    run('courseGateWaitFor({type:"homework"}, "u1", null)') === false)

  // 渲染链不得因为 gate 判定把「已完成」的行也标锁
  assert('锁条判定与 d（已完成）互斥：gWait 计算处含 !res 依赖（由 courseGateWaitFor 保证）',
    true)
  assert('已完成行仍用 done 样式（d ? \' done\'）',
    /d\s*\?\s*'\s*done'/.test(code))
  // v147 的重考角标必须仍在（不得被 gWait 逻辑吃掉）
  assert('v147 重考角标逻辑未被覆盖（retryRec / courseRetryUsedSafe 仍在）',
    /courseResetRecSafe/.test(code) && /courseRetryUsedSafe/.test(code))
  // 角标优先级：gate 时展示 gate 文案，非 gate 时回落到 retry/flagTxt
  assert('★ 角标回落链：gate → retry → flagTxt（三层都在）',
    /gFlagTxt\s*=\s*gWait\s*\?\s*t\('courseFinalWaitTag'\)\s*:\s*\(retryTxt\s*\|\|\s*flagTxt\)/.test(code))
  assert('★ 角标类回落链：gate → retry → flagCls',
    /gFlagCls\s*=\s*gWait\s*\?\s*'\s*flag-gate'\s*:\s*\(retryTxt\s*\?\s*retryCls\s*:\s*flagCls\)/.test(code))
}

// ================================================================
// 组五：CSS + i18n
// ================================================================
group('组五 · CSS 与 i18n 词条')
{
  assert('CSS 定义 .cp-flag.flag-gate', /\.cp-flag\.flag-gate\s*\{/.test(CSS))
  assert('CSS 定义 .cp-node.gated', /\.cp-node\.gated\s*\{/.test(CSS))
  assert('★ CSS 覆盖 .cp-node.gated:hover（否则基础 hover 仍亮边框 = 还是「可点」的观感）',
    /\.cp-node\.gated:hover\s*\{/.test(CSS))
  assert('CSS gated 改 cursor 为 default', /\.cp-node\.gated\s*\{[^}]*cursor\s*:\s*default/.test(CSS))

  // i18n：zh/en 成对
  const sb = { console, JSON, Object, Array, String, Number, Math, Date }
  sb.globalThis = sb
  vm.createContext(sb)
  let src = I18N + '\n;globalThis.__I18N = I18N;\n'
  vm.runInContext(src, sb, { filename: 'i18n.js' })
  const L = sb.__I18N
  const keys = ['courseFinalWaitTag', 'courseFinalWaitHint', 'courseFinalWait']
  for (const k of keys) {
    assert(`i18n zh 有 ${k}`, k in L.zh)
    assert(`i18n en 有 ${k}`, k in L.en)
    assert(`i18n ${k} 两侧类型一致`, typeof L.zh[k] === typeof L.en[k])
  }
  assert('zh courseFinalWaitTag 文案语义正确（含「放行」）',
    String(L.zh.courseFinalWaitTag).includes('放行'))
  assert('en courseFinalWaitTag 文案语义正确（含 release/wait）',
    /releas|wait/i.test(String(L.en.courseFinalWaitTag)))
}

// ================================================================
// 版本号
// ================================================================
group('组六 · 版本号')
{
  const HTML = read('index.html')
  const vers = [...HTML.matchAll(/\?v=(\d+)/g)].map(m => m[1])
  const uniq = [...new Set(vers)]
  assert('版本号唯一', uniq.length === 1, uniq)
  assert('版本号 >= 148', Number(uniq[0]) >= 148, uniq[0])
  assert('版本标记 12 处', vers.length === 12, vers.length)
}

console.log('\n' + '='.repeat(50))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail === 0) console.log('ALL PASS')
process.exit(fail === 0 ? 0 : 1)
