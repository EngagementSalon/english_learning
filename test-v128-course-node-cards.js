// test-v128-course-node-cards.js — v128 我的学习进度每节课改独立分格卡片（NovoEd 参考版式）
// ① 源码级：courseStudentPathHtml 节点行新增右侧状态角标 cp-flag（已完成/待完成/未开始）；
//    外层 cp-node 类名模板保持 v123 原样（class="cp-node done"/"cp-node next" 契约不破坏）
// ② 行为（沙箱真跑）：三态角标数量与文案键、cp-meta/onclick/title 契约保留、
//    行区间内不出现 'cp-side' 字样（保护 test-v53-review 的 sliceBetween('cp-list','cp-side') 切片）
// ③ CSS：分格卡片（白底描边 + 圆角 + 左状态色条 + 卡片间距）+ 三态角标样式；
//    v123 钉住的字面量全部保留（.cp-grid { margin-top:12px; } / .cp-side display:none /
//    @media (min-width: 900px) / .cp-node .cp-lbl { font-size:13px / .cp-node .cp-meta { / word-break:break-word）
// ④ i18n：courseNodeTodo zh/en 成对；courseDoneTag / coursePending 未改动（兼容）
// ⑤ 版本弹性：唯一 ?v=N ×12 且 ≥128

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
// ★ v148 契约更新：节点行新增「等待放行」态，角标容器改为动态类 ${gFlagCls}、
//   文案改为 gFlagTxt（三层回落 gate → retry → flagTxt），cp-node 类名尾部追加 ${gCls}。
//   本段的**原意**（角标容器存在 / 三态类名拼接 / 三态文案接线 / done/next 契约不破 / escHtml 转义）
//   全部保留，只把「写死的变量名」换成新契约的对应物。
const body = extractFn(APP, 'courseStudentPathHtml')
assert('源码：节点行含 cp-flag 角标容器（v148 动态类 ${gFlagCls}）',
  body.includes('class="cp-flag${gFlagCls}"') || body.includes('class="cp-flag${flagCls}"'))
assert('源码：角标三态类名拼接（\' ok\' / \' doing\' / 空串）仍在（flagCls 回落链末端）',
  body.includes("d ? ' ok' : (isNext ? ' doing' : '')"))
assert('源码：角标文案接线（courseDoneTag / coursePending / courseNodeTodo 三个 t() 调用）',
  body.includes("t('courseDoneTag')") && body.includes("t('coursePending')") && body.includes("t('courseNodeTodo')"))
// ★ v123 的实质契约 = 「外层 cp-node 必带 done / next 两个条件类」。v148 在尾部加 ${gCls}，
//   故改为断「含 done 与 next 两个条件片段」+「模板以 cp-node 开头」，不再钉整串字面量。
assert('源码：外层 cp-node 类名模板保留 done/next 条件类（v123 契约核心，v148 追加 ${gCls}）',
  /class="cp-node\$\{d \? ' done' : ''\}\$\{isNext \? ' next' : ''\}\$\{gCls\}"/.test(body),
  '')
assert('源码：角标文案经 escHtml 转义输出', body.includes('${escHtml(gFlagTxt)}') || body.includes('${escHtml(flagTxt)}'))
assert('源码：cp-dot / cp-info / cp-lbl / cp-meta 结构保留（v123 行内契约）',
  body.includes('class="cp-dot"') && body.includes('class="cp-info"') && body.includes('class="cp-lbl"') && body.includes('class="cp-meta"'))

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
function mkAssign(id, title, done, extra) {
  return Object.assign({ id, type: 'homework', title, questions: [1], results: done ? { stu1: { done: true, score: 90 } } : {} }, extra || {})
}

// 场景 A：4 节点 = 2 done + 1 next + 1 未开始 —— 三态角标矩阵
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '第一课', true), mkAssign('a2', '第二课', true), mkAssign('a3', '第三课', false), mkAssign('a4', '第四课', false)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景A：v123 兼容——cp-node done 恰 2 处、next 恰 1 处',
    out.split('class="cp-node done"').length - 1 === 2 && out.split('class="cp-node next"').length - 1 === 1,
    (out.split('class="cp-node done"').length - 1) + '/' + (out.split('class="cp-node next"').length - 1))
  assert('场景A：已完成角标 cp-flag ok 恰 2 处', out.split('class="cp-flag ok"').length - 1 === 2, out.split('class="cp-flag ok"').length - 1)
  assert('场景A：待完成角标 cp-flag doing 恰 1 处（仅 next 节点）', out.split('class="cp-flag doing"').length - 1 === 1, out.split('class="cp-flag doing"').length - 1)
  assert('场景A：未开始角标裸 cp-flag 恰 1 处（第四课）', out.split('class="cp-flag"').length - 1 === 1, out.split('class="cp-flag"').length - 1)
  assert('场景A：角标文案三键齐备（courseDoneTag/coursePending/courseNodeTodo）',
    out.includes('courseDoneTag') && out.includes('coursePending') && out.includes('courseNodeTodo'))
  assert('场景A：角标不污染行区间——首个 cp-side 出现在所有行之后（保护 v53 sliceBetween 切片；注意 cp-side-count/go/meta 子串也算）', out.indexOf('cp-side') > out.lastIndexOf('cp-meta'))
  assert('场景A：cp-meta 每行一条（4 行）', out.split('class="cp-meta"').length - 1 === 4, out.split('class="cp-meta"').length - 1)
  assert('场景A：onclick / title 保留', out.includes("courseStart('c1','a3')") && out.includes("courseStart('c1','a4')") && out.includes('title="第四课"'))
  assert('场景A：分栏容器三件套保留', out.includes('cp-grid') && out.includes('cp-list') && out.includes('cp-side'))
}

// 场景 B：全部完成 → 全部 ok 角标、无 doing / 裸角标
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '一', true), mkAssign('a2', '二', true), mkAssign('a3', '三', true)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景B：三行全 ok 角标', out.split('class="cp-flag ok"').length - 1 === 3, out.split('class="cp-flag ok"').length - 1)
  assert('场景B：无 doing / 裸角标', out.indexOf('cp-flag doing') < 0 && out.split('class="cp-flag"').length - 1 === 0)
}

// 场景 C：单任务未完成 → 唯一节点 = doing 角标
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '唯一任务', false)] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景C：单节点 doing 角标且环 0%', out.split('class="cp-flag doing"').length - 1 === 1 && out.includes('>0%<'))
}

// 场景 D：线下课节点 → 角标照常输出、副标题仍走 courseTaskMetaText
{
  const sb = mkSandbox()
  const myClasses = [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: [mkAssign('a1', '线下实操', false, { type: 'offline', questions: undefined, date: 1700000000000 })] }]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")', Object.assign(sb, { myClasses }))
  assert('场景D：线下课节点 = doing 角标 + WHEN 时间副标题', out.includes('class="cp-flag doing"') && out.includes('WHEN'))
}

// ---------- ③ CSS ----------
assert('CSS：分格卡片——cp-node 白底 + 1px 描边 + 圆角 10px', /\.cp-node\s*\{[^}]*background:#fff;[^}]*border:1px solid #e5e7eb;/.test(CSS) && /\.cp-node\s*\{[^}]*border-radius:10px;/.test(CSS))
assert('CSS：卡片间距——.cp-node + .cp-node { margin-top:8px; }', CSS.includes('.cp-node + .cp-node { margin-top:8px; }'))
assert('CSS：左侧状态色条——done 绿 / next 品牌深色（::before 4px）',
  /\.cp-node\.done::before\s*\{[^}]*background:#16a34a/.test(CSS) && /\.cp-node\.next::before\s*\{[^}]*background:var\(--primary-dark\)/.test(CSS))
assert('CSS：当前项卡片高亮——next 白品牌底 + 品牌描边', /\.cp-node\.next\s*\{[^}]*background:#fbfcf1;[^}]*border-color:var\(--primary\)/.test(CSS))
assert('CSS：角标三态样式齐备（.cp-flag / .cp-flag.doing / .cp-flag.ok）',
  CSS.includes('.cp-flag {') && CSS.includes('.cp-flag.doing {') && CSS.includes('.cp-flag.ok {'))
assert('CSS：doing 角标走品牌软底变量', /\.cp-flag\.doing\s*\{[^}]*var\(--brand-soft\)/.test(CSS))
assert('CSS：手机端 640px 下卡片收紧（.cp-node padding:9px）', /@media \(max-width:640px\)\s*\{\s*\.cp-node\s*\{\s*padding:9px 10px;/.test(CSS))
// —— v123 钉住的字面量全部保留 ——
assert('CSS（v123 保留）：cp-grid 默认非两列 + margin-top:12px',
  !/^\.cp-grid\s*\{[^}]*grid-template-columns/m.test(CSS) && CSS.includes('.cp-grid { margin-top:12px; }'))
assert('CSS（v123 保留）：cp-side 默认 display:none', /\.cp-side\s*\{\s*display:none;\s*\}/.test(CSS))
assert('CSS（v123 保留）：≥900px 两列 + cp-side 转 flex', /@media \(min-width: 900px\)/.test(CSS) && /\.cp-grid\s*\{\s*display:grid;[^}]*grid-template-columns/.test(CSS) && /\.cp-side\s*\{\s*display:flex;/.test(CSS))
assert('CSS（v123 保留）：标题 13px + word-break:break-word + cp-meta 小字规则',
  CSS.includes('.cp-node .cp-lbl { font-size:13px') && CSS.includes('word-break:break-word') && CSS.includes('.cp-node .cp-meta {'))
assert('CSS：无 v122 竖线残留（seg-on / :not(:last-child)::before）',
  (CSS.match(/^\.cp-node\.seg-on/m) || []).length === 0 && CSS.indexOf('.cp-node:not(:last-child)::before') < 0)

// ---------- ④ i18n ----------
assert('i18n：courseNodeTodo zh/en 成对', /courseNodeTodo:\s*'未开始'/.test(I18N) && /courseNodeTodo:\s*'Not started'/.test(I18N))
assert('i18n：courseDoneTag / coursePending 未改动（兼容）', I18N.includes("coursePending: '待完成'") && I18N.includes("courseDoneTag: '已完成'") && I18N.includes("coursePending: 'To do'") && I18N.includes("courseDoneTag: 'Done'"))
assert('i18n：courseNodeTodo 与 coursePending 同行就近（接线可读性）', /coursePending:[^,]+, courseDoneTag:[^,]+,[^\n]*courseNodeTodo:/.test(I18N))

// ---------- ⑤ 版本弹性 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('版本号 >= 128', uniq.length === 1 && uniq[0] >= 128)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
