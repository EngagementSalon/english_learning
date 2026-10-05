// test-v116-dash-ch-export.js
// v116：看板「七天挑战统计」卡新增「下载成绩 (Excel)」导出（双 sheet：成绩明细 + 积分榜）。
// 断言面：
//   ① i18n 13 个新键 zh/en 成对出现（各 2 次）
//   ② 行为沙箱：extractFn 抽真实 dashChExportSheets —— 排名口径（管理员不排名/同分用时短在前/再比答对）、
//      手动补录标记、缺考 '—'、打卡 全/半/— 转换、明细行数=输入数、空输入只出表头
//   ③ 源码接线断言：dashChExportScores 定义 + renderDashChallengeBlock 模板真调用（接线断言：
//      「函数存在」≠「功能存在」）+ 引用 _chDashRows/impXlsxFromSheets/impDownloadBlob/dashChExportSheets
//   ④ 版本号 ?v=116 ×12、?v=115 残留 0
let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) } }
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// ---------- ① i18n ----------
console.log('① i18n 13 键 zh/en 成对')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const KEYS = ['dashChThMaxDay', 'dashChThStages', 'dashChThAns', 'dashChThAcc', 'dashChThUseSec',
  'dashChChkFull', 'dashChChkHalf', 'dashChSheetDetail', 'dashChSheetRank',
  'dashChExportBtn', 'dashChExportEmpty', 'dashChExportNoXlsx', 'dashChExportFile']
KEYS.forEach(k => {
  const n = i18nSrc.split(k + ':').length - 1
  assert(n === 2, `键 ${k} 在 zh/en 各出现 1 次（实际 ${n}）`)
})

// ---------- ② 行为沙箱 ----------
console.log('② dashChExportSheets 行为沙箱')
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
function extractFn(src, name) {
  // ⚠️ 兼容 async 前缀（v115 坑）
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) throw new Error('fn not found: ' + name)
  const start = m.index + m[1].length
  let i = start, depth = 0, began = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') { depth++; began = true }
    else if (ch === '}') { depth--; if (began && depth === 0) { i++; break } }
    i++
  }
  return src.slice(start, i)
}
const ZH = {
  thUsername: '用户名', thName: '姓名', thDept: '部门',
  dashChThMaxDay: '最高天', dashChThStages: '完成阶段', dashChThAns: '答题数', dashChThAcc: '正确率',
  dashChThDay1: '摸底测', dashChThDay7: '期末测', dashChThScore: '积分', dashChThCorrect: '答对',
  dashChThUseSec: '用时(秒)', dashChThRank: '排名',
  dashChChkFull: '全', dashChChkHalf: '半', dashChManualBadge: '手动',
  dashChSheetDetail: '成绩明细', dashChSheetRank: '积分榜',
  // v139：三段分组（明细表改成「分组横幅 + 列标题 + 数据 + Avearge 汇总」）
  dashChGrpFull: '完全有效组(Fully Valid)', dashChGrpPartial: '单边缺失组(Partial Missing)',
  dashChGrpInvalid: '无效/未参与组(Invalid/Non-participant)', dashChAvgLabel: 'Average',
  dashChColDept: '部门', dashChColName: '姓名', dashChColUser: '用户名', dashChColQ: '答题数',
  dashChColAcc: '正确率', dashChColPre: '前测', dashChColFinal: '后测', dashChColChange: '提分'
}
const t = k => (ZH[k] != null ? ZH[k] : k)
const ctx = { t }
vm.createContext(ctx)
// v139：dashChExportSheets 依赖 v139 整块（DASH_CH_MIN_Q / dashChScoreBlocks 等同块顶层 const）
// 以及 course-app 的 xlsxColRef（列号换算）—— 只抽单个函数会 ReferenceError
const iV139 = appSrc.indexOf('// ====== v139：三段分组口径')
const jV139 = appSrc.indexOf('function dashChExportSheets(list) {')
vm.runInContext(appSrc.slice(iV139, jV139), ctx)
const caSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
vm.runInContext(extractFn(caSrc, 'xlsxColRef'), ctx)
vm.runInContext(extractFn(appSrc, 'dashChExportSheets'), ctx)
const dashChExportSheets = ctx.dashChExportSheets
assert(typeof dashChExportSheets === 'function', 'dashChExportSheets 可从 app.js 抽取')

const mk = (u, role, lbScore, lbT, lbC, extra) => Object.assign({
  username: u, name: 'N-' + u, dept: 'D-' + u, role: role || 'student',
  maxDay: 7, stagesDone: 9, q: 100, acc: 85,
  s1: 80, s7: 90, m1: false, m7: false,
  checkin: [2, 2, 2, 2, 2, 2, 2],
  lbC: lbC, lbT: lbT, lbScore: lbScore, chQ: {}
}, extra || {})

// 结构：双 sheet（v139 起明细表为「三段分组」，明细契约见 test-v139-dash-ch-scoreboard.js）
{
  const list = [mk('a', 'student', 300, 100, 30), mk('b', 'student', 280, 120, 28)]
  const sheets = dashChExportSheets(list)
  assert(Array.isArray(sheets) && sheets.length === 2, '输出两个 sheet')
  assert(sheets[0].name === '成绩明细' && sheets[1].name === '积分榜', 'sheet 名 = 成绩明细/积分榜')
  const d = sheets[0].rows, r = sheets[1].rows
  // v139：3 组 ×（横幅 + 列标题）= 6 行骨架 + 2 条数据 + 1 行 Average 汇总 = 9
  assert(d.length === 9, '明细行数 = 三段骨架 6 + 数据 2 + 汇总 1（实际 ' + d.length + '）')
  assert(d[1][0].v === '部门' && d[1][3].v === '答题数' && d[1][5].v === '前测' && d[1][6].v === '后测' && d[1][7].v === '提分' && d[1][8].v === 'D1',
    '明细列标题（部门/…/答题数/正确率/前测/后测/提分/D1）')
  assert(d[2][3].v === 100 && d[2][4].v === 0.85 && d[2][5].v === 80 && d[2][6].v === 90 && d[2][7].v === 10,
    '数据行 = 答题数 / 正确率小数 / 前测 / 后测 / 提分（后测−前测）')
  assert(d[4][0].v === 'Average' && d[4][5].v === 80 && d[4][6].v === 90 && d[4][7].v === 10,
    '完全有效组末尾输出 Average 汇总（前测均值 80 / 后测均值 90 / 提分均值 10）')
  assert(r.length === 3, '积分榜行数 = 表头 + 2 名学员')
  assert(sheets[0].merges.length >= 4 && Array.isArray(sheets[0].cols) && sheets[0].cols.length === 15,
    'v139：明细 sheet 声明 merges 与 15 列列宽（走富版式）')
  assert(d.filter(row => row[0] && typeof row[0].v === 'string' && /组\(/.test(row[0].v)).length === 3,
    '三段分组横幅都输出')
}
// 排名口径：管理员不排名；同分用时短在前；同分同时用答对多在前
{
  const list = [
    mk('stu1', 'student', 300, 120, 30),
    mk('stu2', 'student', 300, 100, 30),   // 同分用时短 → 排前
    mk('stu3', 'student', 300, 100, 35),   // 同分同时用答对多 → 最前
    mk('boss', 'admin', 999, 10, 99)       // 管理员不进积分榜
  ]
  const sheets = dashChExportSheets(list)
  const r = sheets[1].rows
  assert(r.length === 4, '积分榜行数 = 表头 + 3（管理员被剔除）')
  assert(r[1][0] === 1 && r[1][1] === 'stu3' && r[2][1] === 'stu2' && r[3][1] === 'stu1', '排名次序 = stu3 > stu2 > stu1（同分比用时/答对）')
  assert(r.every(row => row[1] !== 'boss'), '管理员不出现在积分榜任何一行')
}
// 缺考 '-' + 手动补录标红 + 打卡 1/-1（v139 两态）+ 短 checkin 防御
{
  const list = [mk('m1', 'student', 0, 0, 0, { s7: 90, m7: true, s1: null, checkin: [2, 1, 0] })]
  const d = dashChExportSheets(list)[0].rows
  const row = d.filter(r => r[1] && r[1].v === 'N-m1')[0]
  assert(!!row, '细分表能找到该学员行')
  assert(row[5].v === '-', '摸底测缺考导出 "-"（半角连字符，不是 0 / 空）')
  assert(row[6].v === 90 && row[6].s.color === 'FF0000', '期末测手动补录 → 数值 90 且标红（保留来源可追溯）')
  assert(row[8].v === 1 && row[9].v === -1 && row[10].v === -1 && row[14].v === -1,
    'v139：打卡 2/1/0 → D1=1、其余 -1（原表只有 1/-1 两态，没有「半」）')
}
// 空输入：仍输出三段骨架，不抛异常
{
  const sheets = dashChExportSheets([])
  assert(sheets[0].rows.length === 6 && sheets[1].rows.length === 1, '空输入 = 明细三段骨架 6 行 + 积分榜仅表头')
  const sheets2 = dashChExportSheets(null)
  assert(Array.isArray(sheets2) && sheets2[0].rows.length === 6, 'null 输入不抛异常（防御）')
}

// ---------- ③ 源码接线断言 ----------
console.log('③ 接线断言（函数存在 ≠ 功能存在）')
assert(/function dashChExportScores\s*\(/.test(appSrc), 'dashChExportScores 已定义')
assert(appSrc.includes('onclick="dashChExportScores()"'), '看板模板含 onclick=dashChExportScores()（按钮真接线）')
// 位置：按钮在 renderDashChallengeBlock 的非空分支内（空分支「暂无」提示之后才出现按钮）
const iRender = appSrc.indexOf('function renderDashChallengeBlock')
const iBtn = appSrc.indexOf('onclick="dashChExportScores()"')
const iNone = appSrc.indexOf("t('dashChNone')")
assert(iRender > 0 && iBtn > iRender, '按钮位于 renderDashChallengeBlock 模板内（真接线）')
assert(/_chDashRows\s*\|\|\s*\[\]/.test(appSrc), 'dashChExportScores 读取 _chDashRows（兜底空数组）')
assert(/typeof impXlsxFromSheets !== 'function'/.test(appSrc), 'dashChExportScores 守卫 impXlsxFromSheets 存在')
assert(/impDownloadBlob\(bytes, fname/.test(appSrc), 'dashChExportScores 调 impDownloadBlob 触发下载')
assert(appSrc.includes('impXlsxFromSheets(dashChExportSheets(list))'), 'dashChExportScores 组装 sheets 后交给 impXlsxFromSheets')
for (const k of ['dashChExportBtn', 'dashChExportEmpty', 'dashChExportNoXlsx', 'dashChExportFile']) {
  assert(appSrc.includes("t('" + k + "')"), `导出链路使用 i18n 键 ${k}`)
}

// ---------- ④ 版本号 ----------
console.log('④ 版本号')
const idxSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
{
  // ⚠️ 别把 ?v=N 写死：v116 本来写死 ?v=116 → v117 一 bump 就红（v115 已踩过同一坑）。
  // 契约本意是「全站统一版本号」，故断言唯一值 × 12 处且 ≥ 116。
  const vms = (idxSrc.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert(vms.length === 12 && uniq.length === 1, '版本号统一：唯一值 × 12 处')
  assert(uniq.length === 1 && uniq[0] >= 116, '版本号 ≥ 116')
}

console.log(`\nPASS ${pass} FAIL ${fail}`)
if (fail > 0) process.exit(1)
process.exit(0)
