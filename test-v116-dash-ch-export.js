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
  dashChSheetDetail: '成绩明细', dashChSheetRank: '积分榜'
}
const t = k => (ZH[k] != null ? ZH[k] : k)
const ctx = { t }
vm.createContext(ctx)
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

// 结构：双 sheet、明细行数、表头文案
{
  const list = [mk('a', 'student', 300, 100, 30), mk('b', 'student', 280, 120, 28)]
  const sheets = dashChExportSheets(list)
  assert(Array.isArray(sheets) && sheets.length === 2, '输出两个 sheet')
  assert(sheets[0].name === '成绩明细' && sheets[1].name === '积分榜', 'sheet 名 = 成绩明细/积分榜')
  const d = sheets[0].rows, r = sheets[1].rows
  assert(d.length === 3 && r.length === 3, '明细/积分榜行数 = 表头 + 2 名学员')
  assert(d[0][0] === '用户名' && d[0][7] === '摸底测' && d[0][8] === '期末测' && d[0][18] === 'D7', '明细表头列位（用户名…摸底测/期末测…D7）')
  assert(d[1][6] === '85%', '正确率导出为百分比文本 85%')
  assert(d[1][12] === '全' && d[1][18] === '全', '打卡全完成导出「全」')
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
// 手动补录标记 + 缺考 '—' + 打卡混合态 + 短 checkin 防御
{
  const list = [mk('m1', 'student', 0, 0, 0, { s7: 90, m7: true, s1: null, checkin: [2, 1, 0] })]
  const d = dashChExportSheets(list)[0].rows
  assert(d[1][7] === '—', '摸底测缺考导出「—」')
  assert(d[1][8] === '90(手动)', '期末测手动补录导出 90(手动)')
  assert(d[1][12] === '全' && d[1][13] === '半' && d[1][14] === '—', '打卡 2/1/0 → 全/半/—')
  assert(d[1][15] === '—' && d[1][18] === '—', 'checkin 不足 7 位时缺位导出「—」（防御）')
}
// 空输入：只出表头，不抛异常
{
  const sheets = dashChExportSheets([])
  assert(sheets[0].rows.length === 1 && sheets[1].rows.length === 1, '空输入只出表头行')
  const sheets2 = dashChExportSheets(null)
  assert(Array.isArray(sheets2) && sheets2[0].rows.length === 1, 'null 输入不抛异常（防御）')
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
assert((idxSrc.match(/\?v=116/g) || []).length === 12, 'index.html ?v=116 共 12 处')
assert(!idxSrc.includes('?v=115'), 'index.html 无 ?v=115 残留')

console.log(`\nPASS ${pass} FAIL ${fail}`)
if (fail > 0) process.exit(1)
process.exit(0)
