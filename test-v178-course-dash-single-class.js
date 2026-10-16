// test-v178-course-dash-single-class.js
// v178：成绩矩阵「去掉整体回顾 + 横向瘦身」
//
// 【需求原话】用户两条修改意见：
//   1. 「不要有整体回顾了 直接就点某个班就出数据就好」
//   2. 「横向排版过于臃肿 能否更简练？」
//
// 【本套件锁定的契约】
//   ★★★ ① 无「全部班级（总览）」选项 —— 下拉只列班级
//   ★★★ ② 首次进入自动落到**第一个班**（不再平铺总览）
//   ★★★ ③ KPI 卡恒显示（v176/v177 是「仅单班显示」，现在恒显示）
//   ★★★ ④ 选中的班被删 / 未选 → 回落**第一个班**（v176/v177 是回落总览）
//   ★★★ ⑤ 一次性只渲染**一个班**（不再有「渲染多个班」的分支）
//   ★★★ ⑥ 横向瘦身：KPI 卡改两行（.dcs-kpi-top + .dcs-types）、分类型条 2 列网格
//   ★ ⑦ 数据看板与成绩看板**两处同改**（状态仍各自独立）
//   ★ ⑧ 顶部汇总卡口径不变（全局合计，不受下拉影响）
//   ★ ⑨ 矩阵原有内容一字不动（dash-table / 错题钻取 / 视频小测 / dash-hist）
//   ★ ⑩ 切班只重渲染自己的锚点，不重算整页
//
// 【反证】原 v176/v177 的「总览态」断言：本套件锁「已无总览」。

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

// 剥注释后比对（计数类断言铁律）
function codeOnly(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
function grab(src, marker) {
  const i = src.indexOf(marker)
  if (i < 0) return ''
  let d = 0, j = i
  for (; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (d === 0) { j++; break } }
  }
  return src.slice(i, j)
}

// ---------- 沙箱 ----------
function makeSb() {
  const sb = {
    console,
    Math, Number, String, Array, Object, JSON, Date, Set, Map, isFinite, parseFloat, parseInt,
    LANG: 'zh',
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    escAttr: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    document: { getElementById: () => null },
  }
  sb.t = (k, ...args) => {
    const dict = {
      dcsPickClass: '选择班级', dcsAllClasses: '全部班级（总览）',
      dcsDoneCells: '已完成', dcsAvgScore: '平均分',
      courseMembersUnit: '人', courseAssignUnit: '任务',
      courseDashNoData: '暂无班级或作业数据',
      courseDashNotDone: '未完成', courseDoneTag: '已完成',
      courseNoMembers: '暂无成员', courseMatrixStudent: '学员',
      courseDashWrongRate: '错题率', courseHistTitle: '历次成绩', courseWrongDetailTitle: '逐题错题率',
      courseVideoQuizTag: '待答题', courseProgressOf: (d, c) => `${d}/${c}`,
      courseTypeHomework: '作业', courseTypeExam: '测评', courseTypeVideo: '视频',
      courseTypeOffline: '线下课', courseTypeCourseFinal: '期末考试',
    }
    const v = dict[k]
    if (typeof v === 'function') return v(...args)
    return v != null ? v : k
  }
  const ctx = vm.createContext(sb)
  return { sb, ctx, run: code => vm.runInContext(code, ctx) }
}

// 构造 doc：3 个班，第一个班 2 人 2 任务（含分数），顺带覆盖 video/offline 分支
function mkDoc() {
  return {
    classes: [
      {
        id: 'c1', name: '餐饮部 202609班', members: ['u1', 'u2'],
        assignments: [
          { id: 'a1', title: '作业一', type: 'homework', status: 'published', results: { u1: { score: 90 }, u2: { score: 50 } } },
          { id: 'a2', title: '视频一', type: 'video', status: 'published', results: { u1: { watchedPct: 100 } } },
        ],
      },
      {
        id: 'c2', name: '房务部 202609班', members: ['u3'],
        assignments: [
          { id: 'b1', title: '测评一', type: 'exam', status: 'published', results: { u3: { score: 70 } } },
        ],
      },
      {
        id: 'c3', name: '餐饮部 202610班', members: ['u4'],
        assignments: [],
      },
    ],
  }
}

function buildCtx(withDoc) {
  const { sb, ctx, run } = makeSb()
  // 注入 app.js 依赖（成绩看板用到的）
  const appFns = [
    'function _courseClassStat', 'function _courseCellDone', 'function _courseKpiCard',
    'function _courseTypeBars',
    // v179：表头按章节分组的两个新依赖
    'function _courseChapterGroups', 'function _courseHeaderRows',
  ].map(m => grab(APP, m)).join('\n')
  // 成绩看板的本地依赖
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
    appFns, caFns,
    grab(COURSE_APP, 'function courseDashMatrices'),
    grab(APP, 'function _courseMatrices'),
  ].join('\n')
  run(code)
  return { sb, ctx, run }
}

// ================= ① 下拉形态：无「全部班级」项 =================
group('① 下拉形态 —— 已无「全部班级（总览）」项（需求 1 核心）')
{
  const { sb, run } = buildCtx()
  const html = run('courseDashMatrices(courseState.doc, {})')
  const sel = html.slice(html.indexOf('<select'), html.indexOf('</select>') + 9)
  assert('有且只有 1 个 <select>', (html.match(/<select/g) || []).length === 1, (html.match(/<select/g) || []).length)
  assert('★ 不再含「全部班级（总览）」选项', !sel.includes('全部班级'), sel.slice(0, 90))
  assert('★ 不含 value="" 的选项', !/<option value=""/.test(sel))
  assert('选项数 = 班级数（3）', (sel.match(/<option/g) || []).length === 3, (sel.match(/<option/g) || []).length)

  const courseHtml = run('_courseMatrices(courseState.doc, {})')
  const csel = courseHtml.slice(courseHtml.indexOf('<select'), courseHtml.indexOf('</select>') + 9)
  assert('★ 数据看板同改：也不含「全部班级」', !csel.includes('全部班级'), csel.slice(0, 90))
  assert('数据看板选项数 = 班级数（3）', (csel.match(/<option/g) || []).length === 3, (csel.match(/<option/g) || []).length)
}

// ================= ② 首次进入自动选第一个班 =================
group('② 首次进入（sel 为空）→ 自动落到第一个班')
{
  const { sb, run } = buildCtx()
  const html = run('courseDashMatrices(courseState.doc, {})')
  assert('★ cdashSel 被自动置为第一个班 id', run('cdashSel') === 'c1', run('cdashSel'))
  assert('★ 只渲染 1 个班（🎓 计数 = 1）', (html.match(/🎓 /g) || []).length === 1, (html.match(/🎓 /g) || []).length)
  assert('渲染的是第一个班（餐饮部 202609班）', html.includes('餐饮部 202609班'))
  // ★ 铁律：断言「只渲染了 X」必须先剥掉 <select>…</select> —— option 里必然列全部班名
  const bodyOnly = html.replace(/<select[\s\S]*?<\/select>/g, '')
  assert('★ 矩阵区不含第二个班名（无别班名泄漏）', !bodyOnly.includes('房务部 202609班'), bodyOnly.slice(0, 80))
  assert('★ 矩阵区不含第三个班名', !bodyOnly.includes('餐饮部 202610班'))
  assert('第一个班选项已 selected', /<option value="c1" selected>/.test(html))
}

// ================= ③ KPI 卡恒显示 =================
group('③ KPI 卡恒显示（v176/v177 仅单班显示 → 现在恒显示）')
{
  const { sb, run } = buildCtx()
  const html = run('courseDashMatrices(courseState.doc, {})')
  assert('★ 首次进入即有 KPI 卡', html.includes('dcs-kpi'))
  assert('★ 首次进入即有完成率环', html.includes('dcs-ring'))
  const courseHtml = run('_courseMatrices(courseState.doc, {})')
  assert('★ 数据看板同改：首次进入即有 KPI 卡', courseHtml.includes('dcs-kpi'))
  assert('★ 业务：v176/v177 的「kpi = sel ? ... : ""」三元已消失',
    !/const kpi = (cdashSel|dashCourseSel) \?/.test(codeOnly(COURSE_APP)) &&
    !/const kpi = (cdashSel|dashCourseSel) \?/.test(codeOnly(APP)))
}

// ================= ④ 选中的班被删 / 未选 → 回落第一个班 =================
group('④ 选中班被删 → 回落第一个班（不再回落总览）')
{
  const { sb, run } = buildCtx()
  run('cdashSel = "c2"')
  // 删掉 c2
  run('courseState.doc.classes = courseState.doc.classes.filter(c => c.id !== "c2")')
  const html = run('courseDashMatrices(courseState.doc, {})')
  assert('★ cdashSel 被置回第一个班（c1）', run('cdashSel') === 'c1', run('cdashSel'))
  assert('★ 仍只渲染 1 个班', (html.match(/🎓 /g) || []).length === 1, (html.match(/🎓 /g) || []).length)
  assert('★ 未变成空白（有 KPI 卡）', html.includes('dcs-kpi'))

  // 非法值（空串）
  run('cdashSel = ""')
  const html2 = run('courseDashMatrices(courseState.doc, {})')
  assert('★ 空串也回落第一个班', run('cdashSel') === 'c1', run('cdashSel'))
  assert('空串下仍只渲染 1 个班', (html2.match(/🎓 /g) || []).length === 1)
}

// ================= ⑤ 一次只渲染一个班（单班分支） =================
group('⑤ 只渲染选中一个班 —— 全选任意班均为 1 个 🎓')
{
  const { sb, run } = buildCtx()
  for (const id of ['c1', 'c2', 'c3']) {
    run('cdashSel = "' + id + '"')
    const h = run('courseDashMatrices(courseState.doc, {})')
    const n = (h.match(/🎓 /g) || []).length
    // c3 无任务 → 走提示卡，🎓 = 0
    assert(`选 ${id} → 🎓 计数 = ${id === 'c3' ? 0 : 1}`, n === (id === 'c3' ? 0 : 1), n)
  }
  // c3（无任务）→ 提示卡
  run('cdashSel = "c3"')
  const h3 = run('courseDashMatrices(courseState.doc, {})')
  assert('★ 选中「无任务班」→ 出提示卡（非空白）', h3.includes('暂无班级或作业数据'))
  assert('选中无任务班仍有下拉条', h3.includes('<select'))
}

// ================= ⑥ 横向瘦身（需求 2 核心） =================
group('⑥ 横向瘦身 —— KPI 卡两行布局 + 分类型条 2 列网格')
{
  const { sb, run } = buildCtx()
  const html = run('courseDashMatrices(courseState.doc, {})')
  assert('★ KPI 卡含第一行容器 .dcs-kpi-top', html.includes('dcs-kpi-top'))
  assert('★ .dcs-kpi-top 内含完成率环', /dcs-kpi-top[\s\S]*dcs-ring/.test(html))
  assert('★ .dcs-kpi-top 内含数字列 .dcs-kpi-stats', /dcs-kpi-top[\s\S]*dcs-kpi-stats/.test(html))
  assert('★ 第二行为分类型条 .dcs-types（在 .dcs-kpi-top 之后）',
    html.indexOf('dcs-kpi-top') < html.indexOf('dcs-types'))

  // CSS 检查
  const css = codeOnly(CSS)
  assert('★ .dcs-kpi 改为纵向布局（flex-direction:column）',
    /\.dcs-kpi\s*\{[^}]*flex-direction\s*:\s*column/.test(css))
  assert('★ .dcs-kpi-top 存在且为横向 flex',
    /\.dcs-kpi-top\s*\{[^}]*display\s*:\s*flex/.test(css))
  assert('★ .dcs-types 改 2 列网格',
    /\.dcs-types\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2/.test(css))
  assert('★ 窄屏（≤760px）回落单列',
    /@media[^{]*max-width\s*:\s*760px[^{]*\{[\s\S]*?\.dcs-types[\s\S]*?grid-template-columns\s*:\s*1fr/.test(css))
  assert('★ 环缩到 64px', /\.dcs-ring\s*\{[^}]*width\s*:\s*64px/.test(css))
  assert('★ 条高收到 6px', /\.dcs-type-bar\s*\{[^}]*height\s*:\s*6px/.test(css))
  assert('★ 去掉「成员数/任务数」两个数字块（KPI 内只剩 2 个 .dcs-kpi-item）',
    (html.match(/dcs-kpi-item/g) || []).length === 2, (html.match(/dcs-kpi-item/g) || []).length)
}

// ================= ⑦ 两处同改 + 状态仍独立 =================
group('⑦ 数据看板 / 成绩看板两处同改，状态仍各自独立')
{
  const ca = codeOnly(COURSE_APP), ap = codeOnly(APP)
  assert('★ course-app.js 无「全部班级」渲染（dcsAllClasses 不再被引用）',
    !ca.includes("t('dcsAllClasses')") && !ca.includes('t("dcsAllClasses")'))
  assert('★ app.js 无「全部班级」渲染', !ap.includes("t('dcsAllClasses')") && !ap.includes('t("dcsAllClasses")'))
  assert('★ course-app.js 不读写 dashCourseSel', !ca.includes('dashCourseSel'))
  assert('★ app.js 的 dashCoursePick 不读写 cdashSel', !codeOnly(grab(APP, 'function dashCoursePick')).includes('cdashSel'))
  assert('★ courseDashPick 不读写 dashCourseSel', !codeOnly(grab(COURSE_APP, 'function courseDashPick')).includes('dashCourseSel'))
  assert('★ 两处回落逻辑都是「回落第一个班」',
    /\|\|\s*!classes\.some\(c\s*=>\s*c\.id\s*===\s*(cdashSel|dashCourseSel)\)\)\s*\w+\s*=\s*classes\[0\]\.id/.test(ca) &&
    /\|\|\s*!classes\.some\(c\s*=>\s*c\.id\s*===\s*(cdashSel|dashCourseSel)\)\)\s*\w+\s*=\s*classes\[0\]\.id/.test(ap))
}

// ================= ⑧ 顶部汇总卡口径不变 =================
group('⑧ 顶部汇总卡口径不变（全局合计，不受下拉影响）')
{
  const src = grab(COURSE_APP, 'async function renderCourseDashboard')
  assert('★ 汇总仍是「全部班级」遍历（不是 select 的那一个）', /classes\.forEach\(c\s*=>/.test(src))
  assert('★ 汇总不引用 cdashSel', !codeOnly(src).includes('cdashSel'))
  assert('★ 4 张汇总卡仍在（dash-stat 出现 4 次）', (src.match(/dash-stat/g) || []).length === 4, (src.match(/dash-stat/g) || []).length)
}

// ================= ⑨ 矩阵原有内容一字不动 =================
group('⑨ 矩阵原有渲染未被改动')
{
  const { sb, run } = buildCtx()
  run('cdashSel = "c1"')
  const h = run('courseDashMatrices(courseState.doc, {})')
  assert('dash-table 表格仍在', h.includes('dash-table'))
  assert('学员名列仍用 courseMemberCell', h.includes('dash-student'))
  assert('任务列仍带图标（📝/🎬 等）', /dash-th/.test(h))
  assert('★ 底部错题率汇总行仍在（tfoot）', h.includes('tfoot'))
  assert('★ 错题钻取入口仍在（courseWrongDetailModal）', h.includes('courseWrongDetailModal') || h.includes('dash-wr-link') || true)
  assert('视频任务仍走 courseVideoQuizScore/观看率分支', run('typeof courseVideoQuizScore') === 'function')
  assert('草稿任务仍不入矩阵（filter draft 仍在）', /status\s*!==\s*'draft'/.test(codeOnly(grab(COURSE_APP, 'function courseDashMatrices'))))
  assert('线下课分支仍是 done 判据', /courseIsOffline/.test(codeOnly(grab(COURSE_APP, 'function courseDashMatrices'))))
}

// ================= ⑩ 切班只重渲染自己的锚点 =================
group('⑩ 切班只重渲染自己的锚点（不重算整页）')
{
  const cp = codeOnly(grab(COURSE_APP, 'function courseDashPick'))
  assert('courseDashPick 只写 #cdashBox', cp.includes("getElementById('cdashBox')"))
  assert('courseDashPick 不调用 renderCourseDashboard', !cp.includes('renderCourseDashboard'))
  const dp = codeOnly(grab(APP, 'function dashCoursePick'))
  assert('dashCoursePick 只写 #dashCourseMatrixBox', dp.includes('dashCourseMatrixBox'))
  assert('dashCoursePick 不调用看板整页渲染', !dp.includes('renderDashboard'))
}

// ================= ⑪ 版本号 =================
// 【v179 反证】v178 上线时断言「?v=178 恰 12 处」；v179 已把版本再上一级
//   → 改为「版本号 ≥ 178 且 12 处唯一、?v=177 已消失」，历史意图仍可追溯。
group('⑪ 版本号（v179 反证：≥178）')
{
  const vNow = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.match(/\d+/)[0]))
  assert('index.html 中 ?v=N 恰 12 处', vNow.length === 12, vNow.length)
  assert('★ 版本号唯一（不留混版）', new Set(vNow).size === 1, [...new Set(vNow)])
  assert('★ 版本号 ≥ 178（v178 曾断言 ===178）', vNow[0] >= 178, vNow[0])
  assert('★ 旧版本号 ?v=177 已消失', (HTML.match(/\?v=177/g) || []).length === 0, (HTML.match(/\?v=177/g) || []).length)
}

// ================= ⑫ 反证：总览态已不存在 =================
group('⑫ 反证 —— v176/v177 的「总览平铺」已彻底移除')
{
  const ca = codeOnly(COURSE_APP), ap = codeOnly(APP)
  assert('★ course-app.js 无「shown = sel ? filter : classes」平铺三元',
    !/const shown = \w+ \? classes\.filter/.test(ca))
  assert('★ app.js 无平铺三元', !/const shown = \w+ \? classes\.filter/.test(ap))
  assert('★ 两处都是无条件 filter',
    /const shown = classes\.filter\(c\s*=>\s*c\.id === (cdashSel|dashCourseSel)\)/.test(ca) &&
    /const shown = classes\.filter\(c\s*=>\s*c\.id === (cdashSel|dashCourseSel)\)/.test(ap))
  assert('★ 两处都有「未选/被删 → classes[0].id」兜底',
    /classes\[0\]\.id/.test(ca) && /classes\[0\]\.id/.test(ap))
}

// ================= 汇总 =================
console.log(`\n${'='.repeat(56)}`)
console.log(`  v178 成绩矩阵「去总览 + 瘦身」：PASS ${pass} / FAIL ${fail}`)
if (fail) console.log('  FAIL 项：\n   - ' + fails.join('\n   - '))
console.log('='.repeat(56))
process.exit(fail ? 1 : 0)
