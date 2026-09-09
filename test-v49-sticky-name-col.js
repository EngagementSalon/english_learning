// v49：成绩看板学员名列固定 —— 横向滚动时姓名列不消失（sticky 首列）
// 覆盖：成绩看板矩阵（course-app.js renderCourseDashboard）与账号页在线矩阵（app.js _courseMatrices）
// 断言 CSS 规则存在 + 两处渲染结构都把学员列放在表格第一列
'use strict'
const fs = require('fs')
const path = require('path')
let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
const dir = __dirname
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8')
const courseJs = fs.readFileSync(path.join(dir, 'course-app.js'), 'utf8')
const appJs = fs.readFileSync(path.join(dir, 'app.js'), 'utf8')

console.log('—— v49 学员名列固定 ——')

// 1) 表格容器必须改为 separate 边框（sticky 单元格在 border-collapse:collapse 下部分浏览器会失效）
assert('dash-table 采用 border-collapse: separate', /\.dash-table\s*{[^}]*border-collapse:\s*separate/.test(css), css.match(/\.dash-table\s*\{[^}]*\}/)?.[0])
assert('dash-table 保留 border-spacing: 0', /\.dash-table\s*{[^}]*border-spacing:\s*0/.test(css))

// 2) 首列 sticky 规则：thead th:first-child 与 tbody td:first-child
const stickyBlock = css.slice(css.indexOf('.dash-table thead th:first-child'))
assert('存在首列 sticky 规则块', stickyBlock.length > 0)
assert('th:first-child sticky', /\.dash-table thead th:first-child\s*,[\s\S]*?position:\s*sticky/.test(stickyBlock))
assert('td:first-child 属于同一规则', /\.dash-table tbody td:first-child/.test(stickyBlock))
assert('left: 0 吸附左缘', /left:\s*0/.test(stickyBlock))
assert('显式不透明背景（防内容透过）', /background:\s*var\(--card-bg\)/.test(stickyBlock))
assert('右缘分隔线', /border-right:\s*1px solid var\(--border\)/.test(stickyBlock))

// 3) hover 时 sticky 列同步底色（否则行悬停时姓名列保持纯白不一致）
assert('hover 同步规则存在', /\.dash-table tbody tr:hover td:first-child\s*{[^}]*background:\s*#f9fafb/.test(css))

// 4) 成绩看板矩阵（course-app.js）：学员名列是表格第一列（表头 dash-student-th 先于任务列 headerCells）
assert('成绩看板 thead 首列为学员名', /<thead><tr><th class="dash-student-th"[\s\S]{0,200}\$\{headerCells\}/.test(courseJs))
assert('成绩看板行首列为学员名', /<tr><td class="dash-student">\$\{courseMemberCell\(u, infoMap\)\}<\/td>\$\{cells\}<\/tr>/.test(courseJs))

// 5) 账号页在线矩阵（app.js）：同样学员列在首列
assert('在线矩阵 thead 首列为学员名', /<thead><tr><th style="min-width:80px">\$\{t\('courseMatrixStudent'\)\}<\/th>\$\{headerCells\}/.test(appJs))
assert('在线矩阵行首列为学员名', /<tr><td class="dash-student">\$\{courseMemberCell\(u, infoMap\)\}<\/td>\$\{cells\}<\/tr>/.test(appJs))

console.log(`\n===== v49 测试：通过 ${pass} 项，失败 ${fail} 项 =====`)
process.exit(fail ? 1 : 0)
