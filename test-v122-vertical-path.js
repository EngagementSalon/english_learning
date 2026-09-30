// test-v122-vertical-path.js — v122 我的学习进度改竖版时间线
// ① 源码级：独立 cp-conn 全删（JS 生成器 + CSS 规则）、标题不再截断、seg-on 机制就位
// ② 行为（沙箱真跑 courseStudentPathHtml）：
//    - 相邻完成 → seg-on 只挂在「前一节点」行（视觉语义同旧 cp-conn.on，v34 反转）
//    - 完整标题不截断；next 节点高亮；全完成 → ok tip；onclick/title 保留
// ③ CSS：cp-path 纵向 + 伪元素竖线 + seg-on 点亮，无 .cp-conn 残留
// ④ 版本弹性：唯一 ?v=N ×12 且 ≥122

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

let failed = 0
function assert(name, cond, extra) {
  if (cond) { console.log('✓ ' + name) }
  else { failed++; console.log('✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}

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

// ---------- ① 源码级 ----------
// 注：v122 注释里保留 cp-conn 字样用于说明语义来源，故断「生成器/规则」的结构化字面量而非任意出现
assert('course-app.js 不再有 cp-conn 生成器（class="cp-conn）', APP.indexOf('class="cp-conn') < 0)
const body = extractFn(APP, 'courseStudentPathHtml')
assert('节点标题不再 9 字截断（无 slice(0, 9)）', body.indexOf('slice(0, 9)') < 0)
assert('seg-on 机制就位（节点行携带竖线点亮类）', body.indexOf("seg-on") >= 0 && body.indexOf('segOn') >= 0)
assert('cp-node done / next 类名保留（旧断言兼容）', body.indexOf("' done'") >= 0 && body.indexOf("' next'") >= 0)

// ---------- ② 行为 ----------
function mkSandbox() {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Promise, Date,
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escAttr: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    t: (k, ...a) => a.length ? k + ':' + a.join(',') : k,
    courseTaskDone: (a, res) => !!(res && res.done),
    courseTaskIcon: a => ({ video: '🎬', exam: '📝', coursefinal: '📕', offline: '📅' }[a.type] || '📄'),
    courseIsOffline: a => a.type === 'offline',
  }
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, 'courseStudentPathHtml'), sb)
  return sb
}
const LONG = '如何优雅地处理宾客的投诉与特殊需求'
function mkAssign(id, title, done) {
  return { id, type: 'homework', title, questions: [1], results: done ? { stu1: { done: true, score: 90 } } : {} }
}

// 场景 A：2/3 完成（前两个 done，第三个 next）——竖版结构矩阵
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '第一课', true), mkAssign('a2', LONG, true), mkAssign('a3', '第三课', false)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景A：输出含竖版容器 cp-path', out.includes('cp-path'))
  assert('场景A：相邻双完成 → 前一节点行挂 seg-on（恰 1 处）', out.split('cp-node done seg-on').length - 1 === 1, out.split('cp-node done seg-on').length - 1)
  assert('场景A：中间完成节点不带 seg-on（类名恰为 cp-node done）', out.includes('class="cp-node done"'))
  assert('场景A：未完成节点标记 next', out.includes('cp-node next'))
  assert('场景A：无 cp-conn 残留', out.indexOf('cp-conn') < 0)
  assert('场景A：长标题完整展示（不截断、无省略号）', out.includes(LONG) && out.indexOf('…') < 0)
  assert('场景A：节点 onclick 保留（courseStart 带 c/a id）', out.includes("courseStart('c1','a3')"))
  assert('场景A：title 属性保留完整标题', out.includes('title="' + LONG + '"'))
}

// 场景 B：全部完成 → 无 next、连线段点亮、ok tip
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '一', true), mkAssign('a2', '二', true), mkAssign('a3', '三', true)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景B：无未完成节点', out.indexOf('cp-node next') < 0)
  assert('场景B：前两行挂 seg-on（2 处，最后一行不挂）', out.split('cp-node done seg-on').length - 1 === 2, out.split('cp-node done seg-on').length - 1)
  assert('场景B：全完成 ok tip', out.includes('cp-tip ok'))
}

// 场景 C：单项任务未完成 → next 且无 seg-on
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '唯一任务', false)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景C：单节点 = next、无 seg-on', out.includes('cp-node next') && out.indexOf('seg-on') < 0)
}

// 场景 D：草稿不进路径、空班级返回空串
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [{ id: 'a9', type: 'homework', title: '草稿任务', status: 'draft', questions: [], results: {} }] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景D：草稿任务不出现，无任务班级返回空串', !out.includes('草稿任务') && vm.runInContext('courseStudentPathHtml([{id:"c2",name:"B",members:["stu1"],assignments:[]}], "stu1")', Object.assign(sb, { x: 1 })) === '')
}

// ---------- ③ CSS ----------
assert('CSS：cp-path 纵向排列', CSS.includes('.cp-path { display:flex; flex-direction:column'))
assert('CSS：节点行伪元素竖线（:not(:last-child)::before）', CSS.includes('.cp-node:not(:last-child)::before'))
assert('CSS：seg-on 点亮竖线', CSS.includes('.cp-node.seg-on::before'))
assert('CSS：无 .cp-conn 规则残留（行首规则选择器，注释说明不算）', (CSS.match(/^\.cp-conn/m) || []).length === 0)
assert('CSS：节点行完整标题（13px + word-break:break-word，非 11px 居中截断）', CSS.includes('.cp-node .cp-lbl { font-size:13px') && CSS.includes('word-break:break-word'))

// ---------- ④ 版本弹性 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('版本号 >= 122', uniq.length === 1 && uniq[0] >= 122)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
