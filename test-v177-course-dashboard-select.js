// test-v177-course-dashboard-select.js
// v177：成绩看板（班级管理 → 📊 成绩看板）—— 班级下拉 + 班级 KPI 卡
//
// 【需求原话】用户截图「成绩看板」页 → 「这个也要改」
//   背景：v176 已在**数据看板「线下课」标签**（app.js 的 _courseMatrices）做了下拉 + KPI 卡；
//         但「成绩看板」（course-app.js 的 renderCourseDashboard）仍是全部班级平铺。
//   本次把同一套「视图组件」搬过来：下拉选班 + 单班 KPI 卡。
//
// 【本套件锁定的契约】
//   · 有下拉，且只有 1 个 <select>（多一个 = 漏渲染/重复渲染）
//   · 选项数 = 班级数 + 1（「全部班级」+ 每个班）
//   · '' = 总览：平铺全部班、无 KPI 卡（保留原行为）
//   · 选中某班：只渲染该班、显示 KPI 卡；**矩阵原有内容一字不动**
//     （dash-table / dash-wr-link 错题钻取 / courseVideoQuizScore 视频小测 / dash-hist 历次分）
//   · 选中的班已不存在（被删） → 静默回落总览，不崩
//   · 顶部 4 张汇总卡**不受下拉影响**（全局口径，仍是全部班级合计）
//   · 切班只重渲染 #cdashBox，不重算整页、不重拉云端
//   · ★ 与数据看板的 dashCourseSel 是**两套独立状态**（互不干扰）
//   · ★ 草稿任务（status:'draft'）不计入矩阵，但**计入**顶部汇总的旧口径保持不变
//     —— 顶部汇总本来就是 .filter(a => a.status !== 'draft')，两处同源

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
// course-app.js 里 courseDashMatrices 会调用 app.js 的 _courseClassStat/_courseKpiCard/_courseCellDone
//   → 沙箱里必须把这三者**从 app.js 抽取注入**（漏注入会被静默吞成兜底值，本项目铁律）。
const ZH = {
  courseDashNotDone: '未完成', courseDoneTag: '已完成', courseMembersUnit: '人',
  courseAssignUnit: '个任务', courseMatrixStudent: '学员', courseNoMembers: '暂无成员',
  courseHistTitle: '历次作答成绩', dashOfflineEmpty: '暂无线下课程数据',
  courseDashNoData: '暂无班级或作业数据',
  courseDashWrongRate: '全班错题率', courseWrongDetailTitle: '逐题错题率',
  courseVideoQuizTag: '待答题',
  courseProgressOf: (d, n) => `${d} / ${n} 完成`,
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
    // course-app.js 的顶层状态（含 v177 新增的两个）
    'let cdashSel = ""\nlet cdashInfoCache = null\n'
    // 矩阵渲染依赖（真实函数体，从两个文件各自抽取）
    + grab(APP, 'function escHtml') + '\n'
    + grab(APP, 'function escAttr') + '\n'
    + grab(APP, 'function _courseClassStat') + '\n'
    + grab(APP, 'function _courseCellDone') + '\n'
    + grab(APP, 'function _courseTypeBars') + '\n'
    + grab(APP, 'function _courseKpiCard') + '\n'
    + grab(COURSE_APP, 'function courseMemberCell') + '\n'
    + grab(COURSE_APP, 'function courseTaskIcon') + '\n'
    + grab(COURSE_APP, 'function courseIsOffline') + '\n'
    + grab(COURSE_APP, 'function courseVideoQuizScore') + '\n'
    + grab(COURSE_APP, 'function courseTaskWrongRate') + '\n'
    + grab(COURSE_APP, 'function courseWrongDetailable') + '\n'
    + grab(COURSE_APP, 'function courseTaskWrongDetail') + '\n'
    + grab(COURSE_APP, 'function courseWrongRateCls') + '\n'
    + grab(COURSE_APP, 'function courseWrongDetailModal') + '\n'
    + grab(COURSE_APP, 'function courseDashPick') + '\n'
    + grab(COURSE_APP, 'function courseDashMatrices') + '\n',
    sb, { filename: 'v177.js' })
  return sb
}
// ★ 铁律：cdashSel 是 `let`（脚本词法作用域），`sb.cdashSel = x` 只会新建同名属性，
//   真变量纹丝不动。必须 runInContext 赋值。
function setSel(sb, v) { vm.runInContext('cdashSel = ' + JSON.stringify(v), sb) }
function render(sb, doc) {
  return vm.runInContext('courseDashMatrices(__d, {})', Object.assign(sb, { __d: doc }))
}

// ---------- 构造测试数据（形状对齐线上真实文档）----------
function mkDoc() {
  return {
    classes: [
      {
        id: 'c1', name: '餐饮部 202609班', members: ['s1', 's2'], assignments: [
          { id: 'a1', type: 'offline', title: '点餐服务', results: { s1: { done: true }, s2: {} } },
          { id: 'a2', type: 'homework', title: '课前作业', results: { s1: { score: 80 }, s2: { score: 60 } } },
          { id: 'a3', type: 'video', title: '视频课', results: { s1: { watchedPct: 95 }, s2: { watchedPct: 50 } } },
          { id: 'a4', type: 'exam', title: '随堂考试', results: { s1: { score: 90 }, s2: { score: 70, correct: 7, total: 10 } } },
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
  assert('★ 下拉切换回调 = courseDashPick', html.includes('onchange="courseDashPick(this.value)"'))
  assert('外层容器 id = cdashBox（切班局部重渲染锚点）', html.includes('id="cdashBox"'))
  assert('复用 v176 的 .dcs-* 组件样式类', html.includes('dcs-bar') && html.includes('dcs-sel'))

  group('② 总览模式（""）：平铺全部班 + 无 KPI 卡（保留原行为）')
  assert('平铺 2 个班级标题', (html.match(/🎓 /g) || []).length === 2, (html.match(/🎓 /g) || []).length)
  assert('总览不渲染 KPI 卡', !html.includes('dcs-kpi'))
  assert('总览不渲染完成率环', !html.includes('dcs-ring'))
  assert('「全部班级」项已 selected', /<option value="" selected>/.test(html))

  group('③ 单班模式（选中 c1）：只渲一个班 + KPI 卡齐全')
  setSel(sb, 'c1')
  html = render(sb, doc)
  assert('★ 只渲染 1 个班级标题', (html.match(/🎓 /g) || []).length === 1, (html.match(/🎓 /g) || []).length)
  // ★ 下拉 <option> 里必然列出全部班名（那是选择器），必须先剥掉 <select> 再断言矩阵区。
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
  assert('★ KPI 的已完成格数与矩阵着色同源（6/8）', html.includes('6<em>/8</em>'), html.slice(html.indexOf('dcs-kpi-item'), html.indexOf('dcs-kpi-item') + 120))

  group('④ ★ 矩阵原有内容一字不动（历史断言依赖）')
  assert('矩阵表保留 admin-table dash-table + 稳定列宽', html.includes('admin-table dash-table') && html.includes('min-width:100%'))
  assert('表头含各方标题', html.includes('点餐服务') && html.includes('课前作业') && html.includes('视频课'))
  assert('线下课完成格 = ✓ 已完成', html.includes('✓ 已完成'))
  assert('作业格含分数 80分', html.includes('80分'))
  assert('★ 底部全班错题率汇总行保留（tfoot + dash-lbl-cell）',
    html.includes('<tfoot>') && html.includes('dash-lbl-cell') && html.includes('全班错题率'))
  assert('★ 视频任务仍走 courseVideoQuizScore 分支（小测正确率形态）',
    COURSE_APP.includes('courseVideoQuizScore(a, r)'))
  assert('★ 历次分数 dash-hist 分支保留', COURSE_APP.includes('dash-hist') && COURSE_APP.includes('histArr'))
  assert('学员列用 courseMemberCell（中文名+部门）', html.includes('dash-student'))
  assert('草稿任务 a5「草稿作业」不入矩阵', !html.includes('草稿作业'))

  group('④·补 错题钻取链路（有 wq 明细的任务才出链接）')
  // 错题钻取要求（两个条件缺一不可）：
  //   · courseTaskWrongRate  → 结果需带 correct/total（否则汇总格是 —，不出色块）
  //   · courseWrongDetailable→ 任务需有 questions/quiz 数组（否则不出链接）
  const drillDoc = {
    classes: [{
      id: 'd1', name: '钻取班', members: ['s1', 's2'], assignments: [
        { id: 'q1', type: 'homework', title: '有明细作业', questions: [{}, {}, {}], results: {
          s1: { score: 60, wq: [0, 2], qn: 3, total: 3, correct: 1 },
          s2: { score: 90, wq: [1], qn: 3, total: 3, correct: 2 } } },
      ],
    }],
  }
  const sbDrill = makeSandbox()
  setSel(sbDrill, 'd1')
  const drillHtml = render(sbDrill, drillDoc)
  assert('★ 有 wq 明细 → 错题率出可点击链接（dash-wr-link）', drillHtml.includes('dash-wr-link'))
  assert('★ 链接 onclick 指向 courseWrongDetailModal(班级, 任务)', /courseWrongDetailModal\('d1','q1'\)/.test(drillHtml))
  assert('错题率数值在场（✗ xx%）', /✗ \d+%/.test(drillHtml))
  assert('错题率带 wrong/total 小字', /<span style="font-size:10px;color:#9ca3af"> \d+\/\d+<\/span>/.test(drillHtml))

  group('⑤ 已删除的班级 → 静默回落总览（不崩、不空白）')
  setSel(sb, 'c_已删除')
  html = render(sb, doc)
  assert('回落为总览：平铺 2 个班', (html.match(/🎓 /g) || []).length === 2, (html.match(/🎓 /g) || []).length)
  assert('回落为总览：无 KPI 卡', !html.includes('dcs-kpi'))
  assert('回落为总览：cdashSel 被置回 ""', vm.runInContext('cdashSel', sb) === '', JSON.stringify(vm.runInContext('cdashSel', sb)))

  group('⑥ KPI 口径与页面顶部汇总同源（真实数据重算对照）')
  const c1 = doc.classes[0]
  const st = vm.runInContext('_courseClassStat(__c)', Object.assign(sb, { __c: c1 }))
  // c1：成员 2，已发布任务 4（a5 是草稿，不计）→ cells = 8
  assert('★ 分母排除草稿：cells = 2成员 × 4已发布 = 8', st.cells === 8, 'cells=' + st.cells)
  assert('成员数 = 2', st.members === 2, st.members)
  assert('已发布任务数 = 4（草稿 a5 不计）', st.assigns === 4, st.assigns)
  // 完成格：a1 s1✓ / a2 s1,s2 / a3 s1(95%≥90) / a4 s1,s2 = 6
  // 未完成：a1 s2 / a3 s2(50%<90) = 2
  assert('★ done = 6（offline 只看 done、video 需 ≥90%）', st.done === 6, 'done=' + st.done)
  assert('★ completion = round(6/8*100) = 75', st.completion === 75, 'completion=' + st.completion)
  // 均分：作业 a2(80,60) + 测评 a4(90,70) = 300/4 = 75；video/offline 不进
  assert('★ avgScore 排除 video/offline：300/4 = 75', st.avgScore === 75, 'avg=' + st.avgScore)

  group('⑦ 切班只重渲染容器（不重算整页 / 不重拉云端）')
  const pickBody = grab(COURSE_APP, 'function courseDashPick')
  assert('★ 只写 #cdashBox 的 innerHTML', pickBody.includes("getElementById('cdashBox')"))
  assert('★ 不调用 renderCourseDashboard（否则整页重算 + 云端聚合重跑 + 滚动位置丢失）',
    !pickBody.includes('renderCourseDashboard'))
  assert('切班走纯函数 courseDashMatrices（数据源 = courseState.doc + 缓存 map）',
    pickBody.includes('courseDashMatrices') && pickBody.includes('courseState.doc') && pickBody.includes('cdashInfoCache'))

  group('⑧ 无班级 / 全空兜底')
  const sbEmpty = makeSandbox()
  setSel(sbEmpty, '')
  const emptyHtml = render(sbEmpty, { classes: [] })
  // ★ 本页与数据看板「线下课」标签不同：成绩看板历来在无数据时给「暂无班级或作业数据」提示卡
  //   （v41 起就有测试锁定），**不能返回空串**（否则整块区域空白）。
  assert('★ 无班级 → 出提示卡、不出下拉（保留 v41 起的旧形态）',
    emptyHtml.includes('暂无班级或作业数据') && !emptyHtml.includes('<select'),
    JSON.stringify(emptyHtml.slice(0, 80)))

  const sbNoTask = makeSandbox()
  setSel(sbNoTask, '')
  const noTaskHtml = render(sbNoTask, { classes: [{ id: 'z1', name: '空班', members: ['x'], assignments: [] }] })
  assert('有班但全无任务 → 仍给下拉（可切）', (noTaskHtml.match(/<select/g) || []).length === 1)
  assert('有班但全无任务 → 给空态提示（不是空白）',
    noTaskHtml.includes('暂无班级或作业数据'),
    noTaskHtml.slice(-160))

  group('⑨ 与数据看板的状态隔离（两套独立选择）')
  assert('★ cdashSel 声明在 course-app.js', /let cdashSel\s*=/.test(COURSE_APP))
  assert('★ dashCourseSel 声明在 app.js（两套状态不同名、不同文件）', /let dashCourseSel\s*=/.test(APP))
  const cdPickSrc = codeOnly(grab(COURSE_APP, 'function courseDashPick'))
  assert('★ courseDashPick 不读写 dashCourseSel（互不干扰）', !cdPickSrc.includes('dashCourseSel'))
  const ddPickSrc = codeOnly(grab(APP, 'function dashCoursePick'))
  assert('★ dashCoursePick 不读写 cdashSel（互不干扰）', !ddPickSrc.includes('cdashSel'))
  assert('course-app.js 只声明 1 个 cdashSel', (codeOnly(COURSE_APP).match(/let cdashSel\s*=/g) || []).length === 1)

  group('⑩ i18n 键复用 v176 四键（不新增，避免重复文案）')
  assert('★ dcsPickClass 中英各一', (codeOnly(I18N).match(/dcsPickClass:/g) || []).length === 2)
  assert('★ dcsAllClasses 中英各一', (codeOnly(I18N).match(/dcsAllClasses:/g) || []).length === 2)
  assert('★ dcsDoneCells 中英各一', (codeOnly(I18N).match(/dcsDoneCells:/g) || []).length === 2)
  assert('★ dcsAvgScore 中英各一', (codeOnly(I18N).match(/dcsAvgScore:/g) || []).length === 2)
  assert('★ courseProgressOf 是箭头函数（带参文案铁律；字符串会把 {0} 渲染给管理员）',
    /courseProgressOf:\s*\(/.test(codeOnly(I18N)))
  assert('★ 新增带参/无参键名带引号 grep 应 0 命中（防止写成字符串字面量误用）',
    !/['"]dcsPickClass['"]\s*:/.test(codeOnly(COURSE_APP)) && !/['"]cdashSel['"]/.test(codeOnly(COURSE_APP)))

  group('⑪ 版本号与资源同步')
  const vInHtml = (HTML.match(/\?v=(\d+)/g) || []).map(s => s.slice(3))
  assert('★ index.html 所有 ?v= 一致', new Set(vInHtml).size === 1, [...new Set(vInHtml)].join(','))
  assert('★ 版本号 >= 177', Number(vInHtml[0]) >= 177, vInHtml[0])
  assert('★ course-app.js 在 app.js 之前加载（运行时依赖前向可见）',
    HTML.indexOf('course-app.js') < HTML.indexOf('app.js?v=') && HTML.indexOf('course-app.js') > 0)

  group('⑫ 反证：本页原本没有下拉（v177 才加）')
  assert('★ renderCourseDashboard 内不再直接拼 matrices（已抽出 courseDashMatrices）',
    !/async function renderCourseDashboard[\s\S]*?const matrices = classes\.map/.test(codeOnly(COURSE_APP)))
  assert('★ renderCourseDashboard 调用 courseDashMatrices', /courseDashMatrices\(courseState\.doc, infoMap\)/.test(codeOnly(COURSE_APP)))
  assert('★ 旧「每个班级的成绩矩阵」注释块已消失（功能未重复实现）', !COURSE_APP.includes('// 每个班级的成绩矩阵'))
  assert('★ courseDashMatrices 只定义一次', (codeOnly(COURSE_APP).match(/function courseDashMatrices/g) || []).length === 1)
  assert('★ renderCourseDashboard 只定义一次', (codeOnly(COURSE_APP).match(/async function renderCourseDashboard/g) || []).length === 1)
  assert('★ 顶部 4 张汇总卡口径未变（全局合计，不受下拉影响）',
    /const classes = courseState\.doc\.classes \|\| \[\]/.test(codeOnly(COURSE_APP))
    && /totalStudents \* totalAssigns > 0 \? Math\.round\(totalDone \/ \(totalStudents \* totalAssigns\) \* 100\) : 0/.test(codeOnly(COURSE_APP)))

  console.log('\n' + '─'.repeat(56))
  console.log(`v177 成绩看板下拉：${pass} 项通过 / ${fail} 项失败`)
  if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  - ' + f)) }
  process.exit(fail ? 1 : 0)
})()
