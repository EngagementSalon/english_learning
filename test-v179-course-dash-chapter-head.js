// test-v179-course-dash-chapter-head.js
//   v179：成绩矩阵「任务列按章节分组」—— 章节名作跨列大表头，无章节归「未归入章节」组。
//
//   需求原话（用户）：「横着的部分能否按我分的章节排列呢」
//     「横着的部分」= 成绩矩阵表的列（任务列）；章节 = 管理端录入的 a.chapter。
//     拍板兜底：无章节的任务单独归到「未归入章节」组（线上 202609 两班 17/18 与 18/18 未录章节）。
//
//   ★ 核心契约（四条）：
//     ① 章节是「一段连续区间」语义（与学员端进度页一致）：相邻同章自动归组，
//        章节名变化处开新组 —— 不按「同名合并」！
//     ② 无章节任务**不丢弃、不合并**，归到兜底组，组名 = courseChapterNone（「未归入章节」）。
//     ③ 只在「确有非空章节」时才输出章节行（整班都没录章节 → 不凭空多一行）。
//     ④ 表头列数必须与数据列数严格对齐（章节行 colspan 合计 = assigns.length），
//        含 tfoot 的行也要对齐（成绩看板有汇总行）。
//
//   ★ 纪律：计数类断言走 codeOnly 剥注释；断言「只渲染了 X」先剥 <select>。

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const DIR = __dirname
const APP = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8')
const COURSE_APP = fs.readFileSync(path.join(DIR, 'course-app.js'), 'utf8')
const CSS = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8')
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
const I18N = fs.readFileSync(path.join(DIR, 'i18n.js'), 'utf8')
const T178 = fs.readFileSync(path.join(DIR, 'test-v178-course-dash-single-class.js'), 'utf8')

let pass = 0, fail = 0
const FAILS = []
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; FAILS.push(name); console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))) }
}
function group(t) { console.log('\n' + t) }

// 剥注释后再断言（本项目九次复发的坑）
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// 从源码中按名字抓一个顶层函数（含其后的注释归属）
function grab(src, marker) {
  const i = src.indexOf(marker)
  if (i < 0) throw new Error('未找到 ' + marker)
  // 从函数起始处向后做花括号配平（跳过字符串/注释干扰最小的简单实现）
  let depth = 0, started = false, j = i
  for (; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth--; if (started && depth === 0) { j++; break } }
  }
  return src.slice(i, j)
}

// ============ 沙箱：注入 app.js + course-app.js 相关函数 ============
function makeSb() {
  const sb = { console }
  const ctx = vm.createContext(sb)
  return { sb, ctx, run: code => vm.runInContext(code, ctx) }
}

function mkDoc() {
  return {
    classes: [
      {
        id: 'c1', name: '餐饮部 202610班', members: ['u1', 'u2'],
        assignments: [
          { id: 'a1', chapter: 'Episode 1', title: '课前摸底', type: 'exam', status: 'published', results: { u1: { score: 90 } } },
          { id: 'a2', chapter: 'Episode 1', title: '视频1', type: 'video', status: 'published', results: {} },
          { id: 'a3', chapter: 'Episode 2', title: '作业1', type: 'homework', status: 'published', results: {} },
          { id: 'a4', chapter: 'Episode 2', title: '作业2', type: 'homework', status: 'published', results: {} },
          { id: 'a5', chapter: 'Final Episode', title: '终极大考', type: 'coursefinal', status: 'published', results: {} },
        ],
      },
      {
        // 整班未录章节 → 不应出现章节行（契约③）
        id: 'c2', name: '房务部 202609班', members: ['u3'],
        assignments: [
          { id: 'b1', title: '无章任务1', type: 'exam', status: 'published', results: { u3: { score: 70 } } },
          { id: 'b2', title: '无章任务2', type: 'video', status: 'published', results: {} },
        ],
      },
    ],
  }
}

function buildCtx(withDoc) {
  const { sb, ctx, run } = makeSb()
  const appFns = [
    'function escHtml', 'function escAttr',
    'function _courseClassStat', 'function _courseCellDone',
    'function _courseKpiCard', 'function _courseTypeBars',
    'function _courseChapterGroups', 'function _courseHeaderRows',
  ].map(m => grab(APP, m)).join('\n')
  const caFns = [
    'function courseTaskIcon', 'function courseIsOffline', 'function courseVideoQuizScore',
    'function courseTaskWrongRate', 'function courseTaskWrongDetail', 'function courseWrongDetailable',
    'function courseWrongRateCls', 'function courseMemberCell',
  ].map(m => grab(COURSE_APP, m)).join('\n')
  const code = [
    'let LANG = "zh"',
    'let cdashSel = ""',
    'let cdashInfoCache = null',
    'let dashCourseSel = ""',
    'let dashCourseDocCache = null',
    'let dashCourseInfoCache = {}',
    'function courseWrongDetailModal(){}',
    'function courseDashPick(v) { cdashSel = String(v == null ? "" : v); const el = document.getElementById("cdashBox"); if (el) el.innerHTML = courseDashMatrices(courseState.doc, cdashInfoCache) }',
    'function dashCoursePick(v) { dashCourseSel = String(v == null ? "" : v); const el = document.getElementById("dashCourseMatrixBox"); if (el) el.innerHTML = _courseMatrices(dashCourseDocCache, dashCourseInfoCache) }',
    'const courseState = { doc: ' + JSON.stringify(withDoc || mkDoc()) + ' }',
    'const t = k => ({ courseChapterNone: "未归入章节", courseMatrixStudent: "学员", courseDashNotDone: "未完成", courseDoneTag: "已完成", courseNoMembers: "无成员", courseHistTitle: "历次" }[k] || k)',
    appFns, caFns,
    grab(COURSE_APP, 'function courseDashMatrices'),
    grab(APP, 'function _courseMatrices'),
  ].join('\n')
  run(code)
  return { sb, ctx, run }
}

// 取 <thead>…</thead>
function theadOf(html) {
  const i = html.indexOf('<thead>'), j = html.indexOf('</thead>')
  if (i < 0 || j < 0) return ''
  return html.slice(i, j)
}
// 统计一段 HTML 里 <th> 的总数
function countTh(s) { return (s.match(/<th\b/g) || []).length }
// 取某班渲染块：★ 必须用「🎓 班级名」定位卡片标题，
//   不能只 indexOf(班级名) —— 班级名在 <select> 的 <option> 里也会出现，
//   从那里往前 lastIndexOf('<div class="card"') 会切到错误起点（本项目实撞）。
function blockOf(html, name) {
  const i = html.indexOf('🎓 ' + name)
  if (i < 0) return ''
  const start = html.lastIndexOf('<div class="card"', i)
  const end = html.indexOf('</table>', i)
  if (start < 0 || end < 0) return ''
  return html.slice(start, end + 8)
}

// ================= ① 分组函数语义：连续区间 =================
group('① _courseChapterGroups —— 「连续区间」语义（不按同名合并）')
{
  const { run } = buildCtx()
  // A A B B → 2 组
  const g1 = run('JSON.stringify(_courseChapterGroups([{chapter:"A"},{chapter:"A"},{chapter:"B"},{chapter:"B"}]).map(g=>[g.ch,g.items.length]))')
  assert('A A B B → 2 组', g1 === '[["A",2],["B",2]]', g1)
  // A B A → 3 组（不合并首尾同名！）
  const g2 = run('JSON.stringify(_courseChapterGroups([{chapter:"A"},{chapter:"B"},{chapter:"A"}]).map(g=>[g.ch,g.items.length]))')
  assert('★ A B A → 3 组（不按同名合并，严格连续区间）', g2 === '[["A",1],["B",1],["A",1]]', g2)
  // 空串/undefined/null/空白 全部归一为 ''
  const g3 = run('JSON.stringify(_courseChapterGroups([{chapter:""},{},{chapter:null},{chapter:"   "}]).map(g=>[g.ch,g.items.length]))')
  assert('★ 空串 / 缺字段 / null / 纯空白 → 统一归一组 ""', g3 === '[["",4]]', g3)
  // 空白包裹的章节名被 trim
  const g4 = run('JSON.stringify(_courseChapterGroups([{chapter:"  Episode 1  "},{chapter:"Episode 1"}]).map(g=>[g.ch,g.items.length]))')
  assert('★ "  Episode 1  " 与 "Episode 1" trim 后同章 → 1 组', g4 === '[["Episode 1",2]]', g4)
  // 顺序保持
  const g5 = run('JSON.stringify(_courseChapterGroups([{chapter:"B",title:"x"},{chapter:"A",title:"y"}]).map(g=>g.ch))')
  assert('保持原顺序（B 先于 A 就照实）', g5 === '["B","A"]', g5)
  // 空输入
  assert('空数组 → 0 组', run('_courseChapterGroups([]).length') === 0)
  assert('undefined 输入不抛错 → 0 组', run('_courseChapterGroups(undefined).length') === 0)
}

// ================= ② 表头两行结构 =================
group('② _courseHeaderRows —— 两行结构 + colspan 对齐')
{
  const { run } = buildCtx()
  const assigns = '[{chapter:"Episode 1",title:"t1"},{chapter:"Episode 1",title:"t2"},{chapter:"Episode 2",title:"t3"}]'
  const rows = run('_courseHeaderRows(' + assigns + ', "", { firstTh: \'<th class="dash-student-th">学员</th>\', cellFn: a => a.title })')
  assert('★ 确有章节 → 输出 2 个 <tr>', (rows.match(/<tr>/g) || []).length === 2, (rows.match(/<tr>/g) || []).length)
  assert('第一行含 2 个章节单元格（colspan）', (rows.slice(0, rows.indexOf('</tr>')).match(/colspan="/g) || []).length === 2)
  assert('第一行 colspan 值 = 2 与 1', /colspan="2"/.test(rows) && /colspan="1"/.test(rows))
  assert('★ 学员列表头被加上 rowspan="2"', /<th rowspan="2" class="dash-student-th"/.test(rows))
  assert('★ 章节单元格共 2 个（Episode 1 / Episode 2）', /Episode 1/.test(rows) && /Episode 2/.test(rows))
  assert('第二行为 3 个任务单元格', countTh(rows.slice(rows.lastIndexOf('<tr>'))) === 3, countTh(rows.slice(rows.lastIndexOf('<tr>'))))
  assert('★ th 总数 = 1（学员列）+ 2（章节）+ 3（任务）= 6', countTh(rows) === 6, countTh(rows))
  // colspan 合计 = 任务数
  const cols = (rows.match(/colspan="(\d+)"/g) || []).map(s => Number(s.match(/\d+/)[0]))
  assert('★ colspan 合计 = 任务数 3', cols.reduce((a, b) => a + b, 0) === 3, cols)
}

// ================= ③ 无章节时不出章节行 =================
group('③ 整班无章节 → 不输出章节行（避免噪音）')
{
  const { run } = buildCtx()
  const rows = run('_courseHeaderRows([{title:"x"},{title:"y"}], "", { firstTh: \'<th class="dash-student-th">学员</th>\', cellFn: a => a.title })')
  assert('★ 只有 1 个 <tr>', (rows.match(/<tr>/g) || []).length === 1, (rows.match(/<tr>/g) || []).length)
  assert('★ 无「未归入章节」字样', !/未归入章节/.test(rows))
  assert('无 colspan', !/colspan/.test(rows))
  assert('无 rowspan', !/rowspan/.test(rows))
}

// ================= ④ 混合班（部分有章节）→ 兜底组 =================
group('④ 部分有章节 → 无章节归「未归入章节」组')
{
  const { run } = buildCtx()
  const assigns = '[{chapter:"E1",title:"a"},{chapter:"E1",title:"b"},{title:"c"},{title:"d"}]'
  const rows = run('_courseHeaderRows(' + assigns + ', "", { firstTh: \'<th class="dash-student-th">学员</th>\', cellFn: a => a.title })')
  assert('★ 出现 2 个章节单元格（E1 + 未归入章节）', (rows.slice(0, rows.indexOf('</tr>')).match(/class="dash-ch"/g) || []).length === 2, rows.slice(0, rows.indexOf('</tr>')).match(/class="dash-ch"/g))
  assert('★ 兜底组名为「未归入章节」', /<th class="dash-ch"[^>]*>未归入章节<\/th>/.test(rows), rows.slice(0, rows.indexOf('</tr>')))
  const cols = (rows.match(/colspan="(\d+)"/g) || []).map(s => Number(s.match(/\d+/)[0]))
  assert('★ colspan = [2, 2] 且合计 4', cols.join(',') === '2,2', cols)
  assert('★ 无章节任务未丢失（第二行 4 个）', countTh(rows.slice(rows.lastIndexOf('<tr>'))) === 4)
}

// ================= ⑤ 成绩看板接入（有 tfoot 对齐） =================
group('⑤ 成绩看板 courseDashMatrices —— 章节表头已接入 + tfoot 对齐')
{
  const { run } = buildCtx()
  const html = run('courseDashMatrices(courseState.doc, {})')
  const blk = blockOf(html, '餐饮部 202610班')
  const th = theadOf(blk)
  assert('★ 成绩看板表头含章节行（colspan）', /class="dash-ch"/.test(th))
  assert('★ 含 Episode 1 / Episode 2 / Final Episode', /Episode 1/.test(th) && /Episode 2/.test(th) && /Final Episode/.test(th))
  const cols = (th.match(/colspan="(\d+)"/g) || []).map(s => Number(s.match(/\d+/)[0]))
  assert('★ 章节 colspan 合计 = 任务数 5', cols.reduce((a, b) => a + b, 0) === 5, cols)
  // tfoot 列数 = 1 + 任务数
  const foot = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'))
  const footTd = (foot.match(/<td\b/g) || []).length
  assert('★ tfoot 列数 = 1 + 5 = 6（与表头对齐）', footTd === 6, footTd)
  assert('★ 表头任务单元格数（第二行）= 5', countTh(th.slice(th.lastIndexOf('<tr>'))) === 5)
}

// ================= ⑥ 数据看板接入 =================
group('⑥ 数据看板 _courseMatrices —— 章节表头已接入')
{
  const { run } = buildCtx()
  const html = run('_courseMatrices(courseState.doc, {})')
  const blk = blockOf(html, '餐饮部 202610班')
  const th = theadOf(blk)
  assert('★ 数据看板表头含章节行', /class="dash-ch"/.test(th))
  assert('★ 含 3 个章节单元格', (th.slice(0, th.indexOf('</tr>')).match(/class="dash-ch"/g) || []).length === 3)
}

// ================= ⑦ 整班无章节：表头不退化 =================
group('⑦ 房务部 202609班（整班无章节）→ 无章节行、任务列照常')
{
  const { run } = buildCtx()
  const html = run('courseDashMatrices(courseState.doc, {})')
  // 手动切到 c2
  const html2 = run('cdashSel = "c2"; courseDashMatrices(courseState.doc, {})')
  const blk = blockOf(html2, '房务部 202609班')
  const th = theadOf(blk)
  assert('★ 无章节行（1 个 <tr>）', (th.match(/<tr>/g) || []).length === 1, (th.match(/<tr>/g) || []).length)
  assert('★ 无「未归入章节」字样', !/未归入章节/.test(th))
  assert('表头任务列 = 2（两个任务都渲染）', countTh(th) === 3, countTh(th))  // 学员列 + 2
  assert('任务标题未丢失', /无章任务1/.test(th) && /无章任务2/.test(th))
}

// ================= ⑧ 两处同构（源码级） =================
group('⑧ 两处同改（app.js 数据看板 + course-app.js 成绩看板）')
{
  const appCode = codeOnly(APP)
  const caCode = codeOnly(COURSE_APP)
  assert('★ app.js 定义 _courseChapterGroups', /function _courseChapterGroups\s*\(/.test(appCode))
  assert('★ app.js 定义 _courseHeaderRows', /function _courseHeaderRows\s*\(/.test(appCode))
  assert('★ _courseChapterGroups 只定义一次', (appCode.match(/function _courseChapterGroups\s*\(/g) || []).length === 1)
  assert('★ _courseHeaderRows 只定义一次', (appCode.match(/function _courseHeaderRows\s*\(/g) || []).length === 1)
  assert('★ course-app.js 不重复定义（复用 app.js）', !/function _courseHeaderRows\s*\(/.test(caCode) && !/function _courseChapterGroups\s*\(/.test(caCode))
  assert('★ app.js 的 _courseMatrices 调用 _courseHeaderRows', /_courseHeaderRows\(assigns/.test(appCode))
  assert('★ course-app.js 的 courseDashMatrices 调用 _courseHeaderRows', /_courseHeaderRows\(assigns/.test(caCode))
  assert('★ 两处都不再有旧的内联 headerCells 变量', !/const headerCells = assigns\.map/.test(appCode) && !/const headerCells = assigns\.map/.test(caCode))
  assert('★ 两处 <thead> 都用 ${headRows}', /<thead>\$\{headRows\}<\/thead>/.test(appCode) && /<thead>\$\{headRows\}<\/thead>/.test(caCode))
  // ★ v179 重构表头时曾一度丢掉 v41 锁定的「任务列 min-width:110px」→ 必须有断言守住
  assert('★ v41：成绩看板任务列 min-width:110px 未丢', /thStyle:\s*'min-width:110px'/.test(caCode), 'thStyle 未传')
  assert('★ _courseHeaderRows 支持 thStyle（任务列宽度约束）', /opt\.thStyle/.test(appCode))
}

// ================= ⑨ CSS：章节表头样式 =================
group('⑨ CSS —— .dash-ch 章节表头样式')
{
  assert('★ 定义 .dash-table thead th.dash-ch', /\.dash-table thead th\.dash-ch\s*\{/.test(CSS))
  assert('★ 章节表头居中对齐', /\.dash-table thead th\.dash-ch\s*\{[^}]*text-align:\s*center/.test(CSS))
  assert('★ 章节表头有浅色底（分组带观感）', /\.dash-table thead th\.dash-ch\s*\{[^}]*background:\s*#f6f7f9/.test(CSS))
  assert('★ 章节表头有下边框', /\.dash-table thead th\.dash-ch\s*\{[^}]*border-bottom/.test(CSS))
  assert('★ 章节间有左分隔线（分组边界）', /\.dash-table thead th\.dash-ch \+ th\.dash-ch/.test(CSS))
  assert('★ 原有 .dash-th（任务列）样式未被破坏', /\.dash-th\s*\{[^}]*font-size:\s*12px/.test(CSS))
}

// ================= ⑩ i18n 复用（不新增键） =================
group('⑩ i18n —— 复用 courseChapterNone，未新增键')
{
  const code = codeOnly(APP)
  assert('★ _courseHeaderRows 用 t(\'courseChapterNone\') 作兜底组名', /t\('courseChapterNone'\)/.test(code))
  assert('★ courseChapterNone 中文 = 未归入章节', /courseChapterNone:\s*'未归入章节'/.test(I18N))
  assert('★ courseChapterNone 英文已定义', /courseChapterNone:\s*'Not in any chapter'/.test(I18N))
  // 带参键检查：无新增带参键
  assert('★ 未引入新的 t( 带引号键名残留（占位符陷阱）', !/\bt\(\s*'[^']*\{0\}/.test(code))
}

// ================= ⑪ 口径不变（不含统计变更） =================
group('⑪ 口径红线 —— 只改视图，不改统计')
{
  const appCode = codeOnly(APP)
  const caCode = codeOnly(COURSE_APP)
  assert('★ 未触碰 _courseCellDone（完成判据）', /function _courseCellDone/.test(appCode))
  assert('★ 未触碰 _courseClassStat（KPI 口径）', /function _courseClassStat/.test(appCode))
  assert('★ 未触碰 courseTaskWrongRate（错题率口径）', /function courseTaskWrongRate/.test(caCode))
  // ★ 只在函数体内检查，不用 /s 跨整个文件（否则 [\s\S]*? 会一路吃到文件里别处的 members）
  const gBody = grab(appCode, 'function _courseChapterGroups')
  const hBody = grab(appCode, 'function _courseHeaderRows')
  assert('★ _courseChapterGroups 函数体不引用成员/成绩（纯按 chapter 分组）',
    !/members|results|score/.test(gBody), gBody.match(/members|results|score/))
  assert('★ _courseChapterGroups 函数体只读 chapter（无写入）', /a\.chapter/.test(gBody) && !/\.chapter\s*=[^=]/.test(gBody))
  assert('★ _courseHeaderRows 函数体不引用成员/成绩', !/members|results|score/.test(hBody))
  assert('★ 无任何 .chapter 写入（纯读）', !/_courseChapterGroups[\s\S]{0,600}?\.chapter\s*=[^=]/.test(appCode) && !/_courseHeaderRows[\s\S]{0,600}?\.chapter\s*=[^=]/.test(appCode))
}

// ================= ⑫ 版本号 =================
group('⑫ 版本号 ?v=179')
{
  assert('★ index.html 中 ?v=179 恰 12 处', (HTML.match(/\?v=179/g) || []).length === 12, (HTML.match(/\?v=179/g) || []).length)
  assert('★ 旧版本号 ?v=178 已消失', !/\?v=178/.test(HTML))
}

console.log('\n' + '='.repeat(60))
console.log('  v179 成绩矩阵「任务列按章节分组」：PASS ' + pass + ' / FAIL ' + fail)
console.log('='.repeat(60))
if (fail) { console.log('\n失败项：'); FAILS.forEach(f => console.log('  · ' + f)) }
process.exit(fail ? 1 : 0)
