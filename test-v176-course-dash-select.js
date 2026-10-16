// test-v176-course-dash-select.js
// v176：数据看板「线下课」标签 —— 班级下拉 + 班级 KPI 卡
//
// 【需求原话】「我要你做成下拉看 因为现在的东西感觉太拖沓 然后 因为课程太多
//   能否更直观的表示我看到的课程及作业完成情况」
//   现场：4 个班 / 84 个作业全平铺 → 横向 84 列，滚动很长，看不出各班进行到哪。
//   拍板：① 下拉选班级，一次看一个班（保留「全部班级」总览）
//         ② 班级 KPI 卡 + 完成进度条（完成率环 / 均分 / 已完成格数 / 分类型完成度）
//         ③ 只改主看板「线下课」标签（app.js 的 _courseMatrices）
//
// 【本套件锁定的契约】
//   · 有下拉，且只有 1 个 <select>（多一个就是漏渲染/重复渲染）
//   · 选项数 = 班级数 + 1（「全部班级（总览）」+ 每个班）
//   · '' = 总览：平铺全部班、无 KPI 卡（保留原行为，横向对比用）
//   · 选中某班：只渲染该班、显示 KPI 卡（环 + 均分 + 已完成 + 分类型条）
//   · 选中的班已不存在（被删） → 静默回落总览，不崩
//   · KPI 口径与 _courseSummary 同源：分母=成员×已发布任务；video/offline 不进均分
//   · 切班只重渲染 #dashCourseMatrixBox，不重算整页
//   · 矩阵原有内容一字不动（📅/🎬/🧪 图标、✓ 已完成、80分、dash-table）—— 历史断言依赖

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const COURSE_APP = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
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

// 剥注释后比对（计数类断言铁律：注释里的字面量会污染 grep）
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
function grab(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) throw new Error('not found: ' + sig)
  return src.slice(i, src.indexOf('\n}', i) + 2)
}

// ---------- 沙箱 ----------
const ZH = {
  courseDashNotDone: '未完成', courseDoneTag: '已完成', courseMembersUnit: '人',
  courseAssignUnit: '个任务', courseMatrixStudent: '学员', courseNoMembers: '暂无成员',
  courseHistTitle: '历次作答成绩', dashOfflineEmpty: '暂无线下课程数据',
  courseProgressOf: (d, t) => `${d}/${t}`,
  courseTypeOffline: '线下课', courseTypeVideo: '视频', courseTypeCourseFinal: '终极大考',
  courseTypeExam: '测评', courseTypeHomework: '作业',
  dcsPickClass: '选择班级', dcsAllClasses: '全部班级（总览）',
  dcsDoneCells: '已完成', dcsAvgScore: '平均分',
}
function makeSandbox() {
  const sb = {
    console: { log: () => {} }, LANG: 'zh',
    t: (k, ...a) => { const v = ZH[k]; return typeof v === 'function' ? v(...a) : (v != null ? v : k) },
    document: { getElementById: () => null },
  }
  sb.window = sb
  vm.createContext(sb)
  vm.runInContext(
    'let dashCourseSel = ""\nlet dashCourseDocCache = null\nlet dashCourseInfoCache = {}\n'
    + grab(APP, 'function escHtml') + '\n'
    + grab(APP, 'function escAttr') + '\n'
    + grab(APP, 'function _courseClassStat') + '\n'
    + grab(APP, 'function _courseCellDone') + '\n'
    + grab(APP, 'function _courseTypeBars') + '\n'
    + grab(APP, 'function _courseKpiCard') + '\n'
    + grab(APP, 'function dashCoursePick') + '\n'
    + grab(APP, 'function _courseMatrices') + '\n'
    + grab(COURSE_APP, 'function courseMemberCell') + '\n',
    sb, { filename: 'v176.js' })
  return sb
}
// ★ 关键：dashCourseSel 是 `let`，跑在脚本词法作用域里。
//   直接 `sb.dashCourseSel = x` 只会新建一个**同名属性**，沙箱里的变量不变（实测踩过）。
//   必须用 runInContext 赋值才能改到真变量。
function setSel(sb, v) { vm.runInContext('dashCourseSel = ' + JSON.stringify(v), sb) }
function render(sb, doc) { return vm.runInContext('_courseMatrices(__d, {})', Object.assign(sb, { __d: doc })) }

// ---------- 构造测试数据（形状对齐线上真实文档）----------
function mkDoc() {
  return {
    classes: [
      {
        id: 'c1', name: '餐饮部 202609班', members: ['s1', 's2'], assignments: [
          { id: 'a1', type: 'offline', title: '点餐服务', results: { s1: { done: true }, s2: {} } },
          { id: 'a2', type: 'homework', title: '课前作业', results: { s1: { score: 80 }, s2: { score: 60 } } },
          { id: 'a3', type: 'video', title: '视频课', results: { s1: { watchedPct: 95 }, s2: { watchedPct: 50 } } },
          { id: 'a4', type: 'exam', title: '随堂考试', results: { s1: { score: 90 } } },
          { id: 'a5', type: 'homework', title: '草稿作业', status: 'draft', results: {} },
        ],
      },
      {
        id: 'c2', name: '房务部 202609班', members: ['s3'], assignments: [
          { id: 'b1', type: 'homework', title: '房务作业', results: { s3: { score: 70 } } },
        ],
      },
    ],
  }
}

;(function main() {
  group('① 下拉形态：有且只有 1 个 select，选项 = 班级数 + 1')
  const sb = makeSandbox()
  const doc = mkDoc()
  setSel(sb, '')
  let html = render(sb, doc)
  assert('只渲染 1 个 <select>', (html.match(/<select/g) || []).length === 1, (html.match(/<select/g) || []).length)
  assert('选项数 = 2 班 + 1 = 3', (html.match(/<option/g) || []).length === 3, (html.match(/<option/g) || []).length)
  assert('含「全部班级（总览）」选项', html.includes('全部班级（总览）'))
  assert('选项里带各班名', html.includes('餐饮部 202609班') && html.includes('房务部 202609班'))
  assert('★ 下拉切换回调 = dashCoursePick', html.includes('onchange="dashCoursePick(this.value)"'))
  assert('外层容器 id = dashCourseMatrixBox（切班局部重渲染的锚点）', html.includes('id="dashCourseMatrixBox"'))

  group('② 总览模式（""）：平铺全部班 + 无 KPI 卡（保留原行为）')
  assert('平铺 2 个班级标题', (html.match(/🎓 /g) || []).length === 2, (html.match(/🎓 /g) || []).length)
  assert('总览不渲染 KPI 卡', !html.includes('dcs-kpi'))
  assert('总览不渲染完成率环', !html.includes('dcs-ring'))
  assert('「全部班级」项已 selected', /<option value="" selected>/.test(html))

  group('③ 单班模式（选中 c1）：只渲一个班 + KPI 卡齐全')
  setSel(sb, 'c1')
  html = render(sb, doc)
  assert('★ 只渲染 1 个班级标题', (html.match(/🎓 /g) || []).length === 1, (html.match(/🎓 /g) || []).length)
  // ★ 注意：下拉 <option> 里**必然**列出全部班名（那是选择器，不是矩阵）。
  //   所以「只渲该班」必须把下拉那段剥掉再看，否则会被 option 文本误判为「渲染了别的班」。
  const bodyOnly = html.replace(/<select[\s\S]*?<\/select>/g, '')
  assert('矩阵区只含 c1 的名字', bodyOnly.includes('餐饮部 202609班'))
  assert('★ 矩阵区不含 c2 的名字（c2 仅作为下拉选项出现）', !bodyOnly.includes('房务部 202609班'))
  assert('矩阵区不含 c2 的作业列（房务作业）', !bodyOnly.includes('房务作业'))
  assert('仍保留下拉（可切回）', (html.match(/<select/g) || []).length === 1)
  assert('下拉 <option> 数仍为 3', (html.match(/<option/g) || []).length === 3, (html.match(/<option/g) || []).length)
  assert('c1 项已 selected', html.includes('value="c1" selected'))
  assert('★ 渲染 KPI 卡', html.includes('dcs-kpi'))
  assert('★ KPI 含完成率环（SVG）', html.includes('dcs-ring') && html.includes('<svg'))
  assert('KPI 含环内百分比文字', html.includes('dcs-ring-txt') && html.includes('%'))
  assert('KPI 含「已完成」格数', html.includes('已完成') && html.includes('dcs-kpi-item'))
  assert('KPI 含「平均分」', html.includes('平均分'))
  assert('KPI 含成员数 / 任务数', html.includes('人') && html.includes('个任务'))
  assert('★ KPI 含按任务类型的完成度小条', html.includes('dcs-type-row') && html.includes('dcs-type-bar-in'))
  assert('类型条覆盖 线下课/视频/作业/测评', ['线下课', '视频', '作业', '测评'].every(x => html.includes(x)))
  assert('★ 矩阵表保留（历史断言依赖）', html.includes('admin-table dash-table'))
  assert('矩阵表头含各方标题', html.includes('点餐服务') && html.includes('课前作业') && html.includes('视频课'))
  assert('线下课完成格 = ✓ 已完成', html.includes('✓ 已完成'))
  assert('作业格含分数 80分', html.includes('80分'))
  assert('子类名 dcs-bar / dcs-sel 就位', html.includes('dcs-bar') && html.includes('dcs-sel'))

  group('④ 已删除的班级 → 静默回落总览（不崩、不空白）')
  setSel(sb, 'c_已删除')
  html = render(sb, doc)
  assert('回落为总览：平铺 2 个班', (html.match(/🎓 /g) || []).length === 2, (html.match(/🎓 /g) || []).length)
  assert('回落为总览：无 KPI 卡', !html.includes('dcs-kpi'))
  assert('回落为总览：dashCourseSel 被置回 ""', vm.runInContext('dashCourseSel', sb) === '', JSON.stringify(vm.runInContext('dashCourseSel', sb)))

  group('⑤ KPI 口径与 _courseSummary 同源（真实数据重算对照）')
  const c1 = doc.classes[0]
  const st = vm.runInContext('_courseClassStat(__c)', Object.assign(sb, { __c: c1 }))
  // c1：成员 2，已发布任务 4（a5 是草稿，不计）→ cells = 8
  assert('★ 分母排除草稿：cells = 2成员 × 4已发布 = 8', st.cells === 8, 'cells=' + st.cells)
  assert('成员数 = 2', st.members === 2, st.members)
  assert('已发布任务数 = 4（草稿 a5 不计）', st.assigns === 4, st.assigns)
  // 完成格：a1 s1✓(offline done) / a2 s1,s2 / a3 s1(95%≥90) / a4 s1  = 5
  // 未完成：a1 s2 / a3 s2(50%<90) / a4 s2  = 3
  assert('★ done = 5（offline 只看 done、video 需 ≥90%）', st.done === 5, 'done=' + st.done)
  assert('★ completion = round(5/8*100) = 63', st.completion === 63, 'completion=' + st.completion)
  // 均分：作业 a2(80,60) + 测评 a4(90) = 230/3 = 76.67 → 77；video/offline 不进
  assert('★ avgScore 排除 video/offline：230/3 → 77', st.avgScore === 77, 'avg=' + st.avgScore)

  group('⑥ _courseCellDone 判据（与矩阵着色同源，防两处口径漂移）')
  const ck = (a, r) => vm.runInContext('_courseCellDone(__a, __r)', Object.assign(sb, { __a: a, __r: r }))
  assert('offline + done:true → 完成', ck({ type: 'offline' }, { done: true }) === true)
  assert('★ offline + 无 done（有 results 但未标注）→ 未完成', ck({ type: 'offline' }, {}) === false)
  assert('video 95% → 完成', ck({ type: 'video' }, { watchedPct: 95 }) === true)
  assert('★ video 50% → 未完成', ck({ type: 'video' }, { watchedPct: 50 }) === false)
  assert('video 无 watchedPct（旧数据）→ 视为 100% 完成', ck({ type: 'video' }, {}) === true)
  assert('★ 配了小测但未答（quizTotal 缺失）→ 未完成（v44「看完 ≠ 完成」）',
    ck({ type: 'video', quiz: [{}, {}] }, { watchedPct: 100 }) === false)
  assert('配小测且已答 → 完成', ck({ type: 'video', quiz: [{}] }, { watchedPct: 100, quizTotal: 1 }) === true)
  assert('作业有记录 → 完成', ck({ type: 'homework' }, { score: 0 }) === true)
  assert('无记录 → 未完成', ck({ type: 'homework' }, null) === false)

  group('⑦ 切班只重渲染容器（不重算整页）')
  const pickBody = grab(APP, 'function dashCoursePick')
  assert('★ 只写 #dashCourseMatrixBox 的 innerHTML', pickBody.includes("getElementById('dashCourseMatrixBox')"))
  assert('★ 不调用 renderDashboard / renderCourseDashboard（否则全页重算）',
    !pickBody.includes('renderDashboard') && !pickBody.includes('renderCourseDashboard'))
  assert('切班数据源 = 缓存的 doc/map（不重新拉云端）',
    pickBody.includes('dashCourseDocCache') && pickBody.includes('dashCourseInfoCache'))

  group('⑧ 无班级 / 全空兜底')
  const sbEmpty = makeSandbox()
  setSel(sbEmpty, '')
  const emptyHtml = render(sbEmpty, { classes: [] })
  assert('无班级 → 返回空串（不渲染孤立下拉条）', emptyHtml === '', JSON.stringify(emptyHtml.slice(0, 80)))
  const docNoTask = { classes: [{ id: 'cz', name: '空班', members: ['s1'], assignments: [] }] }
  const noTaskHtml = render(sbEmpty, docNoTask)
  assert('有班但全无任务 → 仍返回下拉 + 兜底提示', noTaskHtml.includes('dcs-sel') && noTaskHtml.includes('暂无线下课程数据'), noTaskHtml.slice(0, 120))

  group('⑨ i18n：新增 4 键、中英齐备、无参键必须是字符串')
  for (const k of ['dcsPickClass', 'dcsAllClasses', 'dcsDoneCells', 'dcsAvgScore']) {
    const n = (I18N.match(new RegExp('\\b' + k + ':', 'g')) || []).length
    assert(k + ' 恰好定义 2 次（中 + 英）', n === 2, 'n=' + n)
  }
  assert('★ 带参键 courseProgressOf 是箭头函数（用于下拉选项的 n/m）',
    /courseProgressOf:\s*\(/.test(I18N))
  assert('★ 4 个新键均为字符串字面量（不是箭头函数 —— 无参文案写函数会渲染成源码）',
    ['dcsPickClass', 'dcsAllClasses', 'dcsDoneCells', 'dcsAvgScore']
      .every(k => new RegExp(k + ":\\s*'").test(I18N)))
  assert('新增键在 app.js 里都用 t() 包着（无硬编码中文）',
    !/dcs-(bar-lbl|kpi-item|type-row)[^>]*>\s*[\u4e00-\u9fa5]/.test(codeOnly(APP)))

  group('⑩ CSS：v176 类名齐备')
  for (const cls of ['.dcs-bar', '.dcs-sel', '.dcs-kpi', '.dcs-ring', '.dcs-kpi-item',
                     '.dcs-types', '.dcs-type-row', '.dcs-type-bar', '.dcs-type-bar-in']) {
    assert('style.css 含 ' + cls, CSS.includes(cls))
  }
  assert('★ 完成度条三档配色 good/ok/bad 齐备',
    CSS.includes('.dcs-type-bar-in.good') && CSS.includes('.dcs-type-bar-in.ok') && CSS.includes('.dcs-type-bar-in.bad'))
  assert('含移动端适配（≤640px）', /@media\s*\(max-width:\s*640px\)[\s\S]{0,400}dcs-/.test(CSS))

  group('⑪ 版本号契约')
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('版本号 12 处且唯一（' + (uniq[0] || '?') + '）', vms.length === 12 && uniq.length === 1,
    'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('★ 版本号 >= 176', uniq.length === 1 && uniq[0] >= 176, uniq[0])

  group('⑫ 反证：旧结构已消失 / 新结构未越界')
  assert('★ _courseMatrices 不再直接 return classes.map(...)（已包进 dashCourseMatrixBox）',
    !/function _courseMatrices[\s\S]{0,3000}?return classes\.map/.test(codeOnly(APP)))
  assert('★ 未引入第二个班级下拉类名（courseClassSel/dashClassSel 均不存在）',
    !codeOnly(APP).includes('courseClassSel') && !codeOnly(APP).includes('dashClassSel'))
  // ★ v177 已推翻本条的原始形态：v176 当时「只改 app.js 主看板」，但 v177 按用户要求把同一套
  //   下拉 + KPI 卡也搬到了 course-app.js 的成绩看板。按项目铁律（改口径后旧断言必须翻成**反证**
  //   而非删掉），这里改为锁定「v176 在这边**没有**留下的东西」——即两套状态必须仍然隔离。
  assert('★ course-app.js 未引入 v176 的 dashCourseSel（两页状态隔离；v177 用的是 cdashSel）',
    !codeOnly(COURSE_APP).includes('dashCourseSel'))
  assert('★ course-app.js 未调用 v176 的 dashCoursePick（各自独立回调）',
    !codeOnly(COURSE_APP).includes('dashCoursePick'))

  console.log('\n' + '='.repeat(60))
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
  else console.log('ALL PASS  ✅ 全部通过')
  process.exit(fail ? 1 : 0)
})()
