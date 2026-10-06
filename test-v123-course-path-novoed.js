// test-v123-course-path-novoed.js — v123 我的学习进度改分栏大纲（NovoEd 式）
// ① 源码级：无 cp-conn 生成器、无 seg-on 残留机制、cp-grid/cp-list/cp-side 三件套就位、
//    副标题走 courseTaskMetaText、进度环 SVG 就位
// ② 行为（沙箱真跑 courseStudentPathHtml）：
//    - 左侧大纲行：done/next 类名保留、圆点字形（✓/▶/序号）、标题完整不截断、cp-meta 副标题
//    - 右侧详情：进度环 dashoffset 与 pct 一致、完成数、下一步任务名 + 去完成、全完成 ok tip
//    - onclick/title 保留；草稿不进大纲；空班级返回空串
// ③ CSS：cp-grid 默认单列（手机端）+ ≥900px 两列 + cp-side 默认 display:none（手机端隐藏）
//    + 无 v122 竖线残留（seg-on / :not(:last-child)::before）
// ④ i18n：courseProgressQN zh/en 成对
// ⑤ 版本弹性：唯一 ?v=N ×12 且 ≥123

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')

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
// 注：v122/v123 注释里保留 cp-conn / seg-on 字样用于说明沿革，故断「生成器/规则」的结构化字面量而非任意出现
assert('course-app.js 不再有 cp-conn 生成器（class="cp-conn）', APP.indexOf('class="cp-conn') < 0)
assert('course-app.js 不再有 seg-on 生成机制（类名拼接 segOn/seg-on）', APP.indexOf("' seg-on'") < 0 && APP.indexOf('segOn') < 0)
const body = extractFn(APP, 'courseStudentPathHtml')
assert('节点标题不再 9 字截断（无 slice(0, 9)）', body.indexOf('slice(0, 9)') < 0)
assert('分栏三件套就位（cp-grid + cp-list + cp-side）', body.includes('cp-grid') && body.includes('cp-list') && body.includes('cp-side'))
assert('右侧详情含进度环 SVG（stroke-dasharray/dashoffset 动态写入）', body.includes('stroke-dasharray') && body.includes('stroke-dashoffset'))
assert('大纲行副标题走 courseTaskMetaText（含 cp-meta 容器）', body.includes('cp-meta') && body.includes('courseTaskMetaText(a)'))
assert('cp-node done / next 类名保留（稳定类名，旧断言兼容）', body.indexOf("' done'") >= 0 && body.indexOf("' next'") >= 0)
assert('辅助函数 courseTaskMetaText / courseTaskKindLabel / courseTaskIcon 存在', /function courseTaskMetaText\s*\(/.test(APP) && /function courseTaskKindLabel\s*\(/.test(APP) && /function courseTaskIcon\s*\(/.test(APP))

// ---------- ② 行为 ----------
function mkSandbox() {
  const sb = {
    // v134：本函数新增「章节开关」依赖 —— 这些用例验的是其它行为，故注入「全部已开放」桩，
    //   保持所有章节展开渲染（章节关闭态由 test-v134-chapter-switch.js 专门覆盖）。
    courseChapterOpened: () => true,
    console, JSON, Object, Array, String, Number, Math, Promise, Date, LANG: 'zh',
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escAttr: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    t: (k, ...a) => a.length ? k + ':' + a.join(',').replace(/\d+ 题$/, '') : k,
    courseTaskDone: (a, res) => !!(res && res.done),
    courseTaskIcon: a => ({ video: '🎬', exam: '🧪', coursefinal: '📕', offline: '📅' }[a && a.type] || '📝'),
    courseIsOffline: a => !!(a && a.type === 'offline'),
    courseIsFinal: a => !!(a && a.type === 'coursefinal'),
    courseOfflineWhen: a => (a && a.date ? 'WHEN' : 'courseUnlimited'),
  }
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, 'courseTaskKindLabel'), sb)
  vm.runInContext(extractFn(APP, 'courseTaskMetaText'), sb)
  vm.runInContext(extractFn(APP, 'courseResetRecSafe'), sb)      // v147：渲染侧台账读取（自包含）
  vm.runInContext(extractFn(APP, 'courseRetryUsedSafe'), sb)     // v147：同上
  vm.runInContext(extractFn(APP, 'courseGateWaitFor'), sb)       // v148：等待放行判定（渲染链新增调用）
  vm.runInContext(extractFn(APP, 'courseStudentPathHtml'), sb)
  return sb
}
const LONG = '如何优雅地处理宾客的投诉与特殊需求'
function mkAssign(id, title, done, extra) {
  return Object.assign({ id, type: 'homework', title, questions: [1], results: done ? { stu1: { done: true, score: 90 } } : {} }, extra || {})
}

// 场景 A：2/3 完成（前两个 done，第三个 next）—— 分栏结构矩阵
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '第一课', true), mkAssign('a2', LONG, true), mkAssign('a3', '第三课', false)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景A：输出含分栏容器 cp-grid + cp-list + cp-side', out.includes('cp-grid') && out.includes('cp-list') && out.includes('cp-side'), '')
  assert('场景A：已完成行 2 处 done（类名恰为 cp-node done）+ 未完成行标记 next', out.split('class="cp-node done"').length - 1 === 2 && out.split('class="cp-node next"').length - 1 === 1, out.split('class="cp-node done"').length - 1 + '/' + (out.split('class="cp-node next"').length - 1))
  assert('场景A：无 seg-on / cp-conn 残留', out.indexOf('seg-on') < 0 && out.indexOf('cp-conn') < 0)
  assert('场景A：圆点字形 ✓ / ▶ 齐备', out.includes('✓') && out.includes('▶'), (out.match(/cp-dot">[^<]*/g) || []).join(' | '))
  assert('场景A：长标题完整展示（不截断、无省略号）', out.includes(LONG) && out.indexOf('…') < 0)
  assert('场景A：大纲行副标题渲染 cp-meta（每行一条，类型标签 + 题数键）', out.split('class="cp-meta"').length - 1 === 3 && out.includes('courseProgressQN'), out.split('class="cp-meta"').length - 1)
  assert('场景A：节点 onclick 保留（courseStart 带 c/a id）', out.includes("courseStart('c1','a3')"))
  assert('场景A：title 属性保留完整标题', out.includes('title="' + LONG + '"'))
  assert('场景A：进度环 dashoffset = 周长 × (1 - pct)（2/3 → 67%，offset ≈ 70.5）', /stroke-dashoffset="70\.5"/.test(out), (out.match(/stroke-dashoffset="[^"]*"/) || [''])[0])
  assert('场景A：进度环旁百分比文案 67%', out.includes('>67%<'))
  assert('场景A：右侧详情含完成数 + 下一步任务 + 去完成按钮', out.includes('courseProgressOf:2,3') && out.includes('courseProgressNext') && out.includes('第三课'))
  assert('场景A：下一步按钮为新节点 courseStart', out.includes("courseStart('c1','a3')"))
}

// 场景 B：全部完成 → 无 next、ok tip、环满
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '一', true), mkAssign('a2', '二', true), mkAssign('a3', '三', true)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景B：无未完成节点（无 cp-node next）', out.indexOf('cp-node next') < 0)
  assert('场景B：三行全 done', out.split('class="cp-node done"').length - 1 === 3, out.split('class="cp-node done"').length - 1)
  assert('场景B：全完成 ok tip（cp-tip ok）', out.includes('cp-tip ok'))
  assert('场景B：进度环满（dashoffset 0 + 100%）', out.includes('stroke-dashoffset="0.0"') && out.includes('>100%<'))
}

// 场景 C：单项任务未完成 → next 且环 0%
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '唯一任务', false)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景C：单节点 = next、无 done、环 0%', out.includes('cp-node next') && out.split('class="cp-node done"').length - 1 === 0 && out.includes('>0%<'))
}

// 场景 D：线下课行（type:'offline'）→ 副标题用上课时间而非题数
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '线下实操', false, { type: 'offline', questions: undefined, date: 1700000000000 })] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景D：线下课行副标题含上课时间键（courseOfflineWhen → WHEN）', out.includes('WHEN') && out.includes('courseTypeOffline') && out.includes('cp-node next'), (out.match(/class="cp-meta">[^<]*/g) || []).join(' | '))
}

// 场景 E：视频任务副标题 = 视频 + 小测数量
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '观摩课', false, { type: 'video', quiz: [1, 2, 3], questions: undefined })] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景E：视频 task icon 🎬 + meta 含小测数量键 courseQuizCount', out.includes('🎬') && out.includes('courseQuizCount:3'))
}

// 场景 F：草稿不进大纲、空班级返回空串
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [{ id: 'a9', type: 'homework', title: '草稿任务', status: 'draft', questions: [], results: {} }] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景F：草稿任务不出现，无任务班级返回空串', !out.includes('草稿任务') && vm.runInContext('courseStudentPathHtml([{id:"c2",name:"B",members:["stu1"],assignments:[]}], "stu1")', Object.assign(sb, { x: 1 })) === '')
}

// ---------- ③ CSS ----------
assert('CSS：cp-grid 默认非两列（手机端单列，移动优先）',
  !/^\.cp-grid\s*\{[^}]*grid-template-columns/m.test(CSS) && CSS.includes('.cp-grid { margin-top:12px; }'))
assert('CSS：cp-side 默认 display:none（手机端隐藏右侧详情）', /\.cp-side\s*\{\s*display:none;\s*\}/.test(CSS))
assert('CSS：≥900px media query 内 cp-grid 两列', /@media \(min-width: 900px\)/.test(CSS) && /\.cp-grid\s*\{\s*display:grid;[^}]*grid-template-columns/.test(CSS))
assert('CSS：≥900px 内 cp-side 转 flex 显示', /\.cp-side\s*\{\s*display:flex;/.test(CSS))
assert('CSS：无 v122 竖线残留（seg-on 规则）', (CSS.match(/^\.cp-node\.seg-on/m) || []).length === 0)
assert('CSS：无 v122 伪元素竖线残留（:not(:last-child)::before）', CSS.indexOf('.cp-node:not(:last-child)::before') < 0)
assert('CSS：大纲行完整标题（13px + word-break:break-word）', CSS.includes('.cp-node .cp-lbl { font-size:13px') && CSS.includes('word-break:break-word'))
assert('CSS：副标题小字样式 cp-meta 就位', CSS.includes('.cp-node .cp-meta {'))
assert('CSS：进度环文字居中样式 cp-ring-txt 就位', CSS.includes('.cp-side .cp-ring-txt {'))

// ---------- ④ i18n ----------
assert('i18n：courseProgressQN zh/en 成对（函数式）', /courseProgressQN:\s*\(n\)\s*=>\s*`\$\{n\} 题`/.test(I18N) && /courseProgressQN:\s*\(n\)\s*=>\s*`\$\{n\} question\(s\)`/.test(I18N))
assert('i18n：courseProgressQN 被 courseTaskMetaText 调用（接线断言）', /courseTaskMetaText[\s\S]{0,900}courseProgressQN/.test(APP) || APP.includes("t('courseProgressQN'"))
assert('i18n：既有进度四键未被改动（兼容）', I18N.includes("courseProgressOf: (d, n) => `${d} / ${n} 完成`") && I18N.includes("courseProgressNext: '下一步', courseProgressGo: '去完成'"))

// ---------- ⑤ 版本弹性 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('版本号 >= 123', uniq.length === 1 && uniq[0] >= 123)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
