// v194：学员档案新增「每日准确率走势」+「平均准确率走势」（累计口径）
// 58 项左右断言，覆盖：聚合口径 / 首答 / 断线 / 加权 / 接线 / i18n。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const IDX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}

// ── 剥注释（避免把注释里的旧引用当成有效代码）
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
// ── 抽函数体（花括号配对，含嵌套）
function extractFn(src, name) {
  let i = src.indexOf('function ' + name + '(')
  if (i < 0) i = src.search(new RegExp('(^|\\n)\\s*' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (i < 0) throw new Error('not found: ' + name)
  let d = 0, started = false
  const j = src.indexOf('{', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') { d++; started = true }
    else if (src[k] === '}') { d--; if (started && d === 0) return src.slice(i, k + 1) }
  }
  throw new Error('unbalanced: ' + name)
}
// ── 抽 _upProfileHtml 内嵌的 IIFE/局部（不跨函数）

console.log('=== [A] dashUserDailyAcc 聚合口径 ===')
const sb = { Math, Number, String, Array, Object, isFinite, console }
vm.createContext(sb)
vm.runInContext(extractFn(APP, 'dashUserDailyAcc'), sb)
const f = sb.dashUserDailyAcc

// A1 加权合并（20题60% + 10题100% → 73%，绝不是简单平均 80%）
const a1 = f({ chy: [
  { day: 1, si: 0, kind: 'test', correct: 12, total: 20, at: 100 },
  { day: 1, si: 1, kind: 'practice', correct: 10, total: 10, at: 200 },
] }, 7)
ok('A1 加权 = 73%（非算术平均 80）', a1.days[0].acc === 73, '实=' + a1.days[0].acc)
ok('A2 D1 题量 = 30', a1.days[0].q === 30)

// A3 首答口径
const a3 = f({ chy: [
  { day: 2, si: 0, correct: 10, total: 10, at: 900 },
  { day: 2, si: 0, correct: 8, total: 10, at: 300 },
] }, 7)
ok('A3 同 day+si 取最早（首答 80%）', a3.days[1].acc === 80, '实=' + a3.days[1].acc)

// A4 cleared 剔除
const a4 = f({ chy: [
  { day: 3, si: 0, correct: 99, total: 100, at: 100, cleared: true },
  { day: 3, si: 0, correct: 15, total: 30, at: 200 },
] }, 7)
ok('A4 cleared 存根剔除 = 50%', a4.days[2].acc === 50)

// A5 缺天 null（绝不 0）
const a5 = f({ chy: [
  { day: 1, si: 0, correct: 10, total: 20, at: 100 },
  { day: 3, si: 0, correct: 24, total: 30, at: 300 },
] }, 7)
ok('A5 缺数据天 = null', a5.days[1].acc === null)
ok('A6 days 恒 7 项', a5.days.length === 7)
ok('A7 covered = 2', a5.covered === 2)

// A8-A11 累计
ok('A8 D1 cum = 50%', a5.days[0].cum === 50)
ok('A9 D3 cum = 68%', a5.days[2].cum === 68)
ok('A10 无数据日 cum 延续 50%', a5.days[1].cum === 50)
ok('A11 全期 avg = 68%', a5.avg === 68)

// A12 脏数据 correct>total
const a12 = f({ chy: [{ day: 1, si: 0, correct: 999, total: 20, at: 100 }] }, 7)
ok('A12 correct>total 夹到 100%', a12.days[0].acc === 100)

// A13 越界 day 丢弃
const a13 = f({ chy: [
  { day: 9, si: 0, correct: 10, total: 10, at: 100 },
  { day: 2, si: 0, correct: 15, total: 30, at: 100 },
] }, 7)
ok('A13 day=9 丢弃 covered=1', a13.covered === 1)

// A14 total=0 丢弃 & 空 avg
const a14 = f({ chy: [{ day: 1, si: 0, correct: 0, total: 0, at: 100 }] }, 7)
ok('A14 total=0 → avg null', a14.avg === null)

// A15 无 chy 输入不炸
const a15 = f({}, 7)
ok('A15 空 r 不炸', a15 && a15.days.length === 7 && a15.avg === null)

console.log('\n=== [B] 断线契约（源码级） ===')
const dailyCode = codeOnly(extractFn(APP, 'dashUserDailyAcc'))
ok('B1 聚合函数注释/代码明确「绝不写 0」', /绝不写 0|绝不补 0/.test(extractFn(APP, 'dashUserDailyAcc')))
// 缺值日 acc 必须是 null 而非 0 —— 用运行时已验证（A5），这里验源码里没有把缺日写成 0 的分支
ok('B2 缺日分支写 null', /acc:\s*null/.test(dailyCode))

console.log('\n=== [C] _upProfileHtml 接线 ===')
const profCode = codeOnly(extractFn(APP, '_upProfileHtml'))
ok('C1 调 dashUserDailyAcc', profCode.includes('dashUserDailyAcc('))
ok('C2 有 dailyChart（当日准确率图）', profCode.includes('dailyChart'))
ok('C3 有 cumChart（累计平均图）', profCode.includes('cumChart'))
ok('C4 有 dailyTable', profCode.includes('dailyTable'))
ok('C5 图色 #0891b2（当日）', profCode.includes("'#0891b2'"))
ok('C6 图色 #7c3aed（累计）', profCode.includes("'#7c3aed'"))
ok('C7 空态走 upDailyNone 提示卡（不是空串）', profCode.includes('upDailyNone'))
ok('C8 小样本标注 upDailyThinTip', profCode.includes('upDailyThinTip'))
ok('C9 小样本注释 upDailyThinNote', profCode.includes('upDailyThinNote'))
// 营次锚定：只画当前营次
ok('C10 按营次过滤（dailyRound）', profCode.includes('dailyRound'))

console.log('\n=== [D] 渲染真跑（沙箱） ===')
const sb2 = {
  Math, Number, String, Array, Object, Date, isFinite, isNaN, JSON, console,
  LANG: 'zh',
  escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  escAttr: s => String(s == null ? '' : s).replace(/"/g, '&quot;'),
  dashRoundSlug: id => String(id || ''),
  dashRoundList: () => [{ id: 'r3', name: '标帜餐厅七天挑战第三期' }],
  dashChStageWeight: () => 1,
  courseAssignTypeLabel: ty => ty,
  _courseCellDone: (a, r) => !!(r && r.done),
  Store: { getQuestions: () => [] },
}
vm.createContext(sb2)
// i18n：从 i18n.js 里挖 zh 字典
try {
  vm.runInContext(I18N + '\n;globalThis.__D = (typeof I18N !== "undefined") ? I18N : null;', sb2)
} catch (e) { /* 兼容其它导出名 */ }
const dict = sb2.__D || {}
const zh = dict.zh || dict['zh-CN'] || {}
sb2.t = function (k) {
  const args = Array.prototype.slice.call(arguments, 1)
  const v = (zh[k] !== undefined) ? zh[k] : k
  return (typeof v === 'function') ? v.apply(null, args) : v
}
;['_upLineChartSvg', 'dashUserRoundSeries', 'dashUserLevelSeries', 'dashUserCourseSeries', 'dashUserDailyAcc',
  '_upProfileHtml', 'dashUserWrongList', '_upWrongCardHtml', '_upWrongSectionHtml'].forEach(n => {
  try { vm.runInContext(extractFn(APP, n), sb2) }
  catch (e) { console.log('  ⚠ 抽取失败 ' + n + ': ' + e.message) }
})
let rendered = ''
try {
  const row = { username: 'tester', name: '测试', dept: 'x', chLevel: 2,
    chy: [
      { day: 1, si: 0, kind: 'test', correct: 18, total: 20, at: 100, rd: 'r3' },
      { day: 1, si: 1, kind: 'practice', correct: 9, total: 10, at: 200, rd: 'r3' },
      { day: 2, si: 0, kind: 'practice', correct: 27, total: 30, at: 300, rd: 'r3' },
      // D3 故意缺 → 断线
      { day: 4, si: 0, kind: 'practice', correct: 30, total: 30, at: 500, rd: 'r3' },
    ] }
  rendered = sb2._upProfileHtml(row, null, [], sb2.dashUserWrongList(row, []))
} catch (e) {
  ok('D0 _upProfileHtml 可渲染', false, e.message)
}
ok('D1 渲染出 svg', (rendered.match(/<svg /g) || []).length >= 2, (rendered.match(/<svg /g) || []).length + ' 张')
ok('D2 无未替换占位符 {xxx}', !/\{[a-zA-Z]+\}/.test(rendered.replace(/\{0,1\}/g, '')))
ok('D3 出现「每日准确率」标题', rendered.includes('每日准确率走势'))
ok('D4 出现「累计平均」图', rendered.includes('平均准确率走势'))
ok('D5 营次名显示', rendered.includes('标帜餐厅七天挑战第三期'))
ok('D6 表格含 7 行（D1-D7）', (rendered.match(/>D\d<\/td>/g) || []).length === 7, '实=' + (rendered.match(/>D\d<\/td>/g) || []).length)
ok('D7 D3 断线（表格该行是 —）', /D3<\/td>[\s\S]{0,200}?—/.test(rendered))

console.log('\n=== [E] i18n 键 ===')
const keys = ['upDailyTitle', 'upDailyHint', 'upDailyNone', 'upSeriesDailyAcc', 'upSeriesCumAcc',
  'upCumTitle', 'upThDay', 'upThDailyQ', 'upThDailyAcc', 'upThCumAcc', 'upDailyThinTip', 'upDailyThinNote']
keys.forEach(k => {
  const n = (I18N.match(new RegExp('\\b' + k + '\\s*:', 'g')) || []).length
  ok('E ' + k + ' zh/en 齐', n >= 2, '实=' + n)
})
// 带参文案必须是箭头函数（t() 只对函数值插值）
ok('E upDailyHint 是箭头函数', /upDailyHint\s*:\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*=>/.test(I18N))

console.log('\n=== [F] 版本标记 ===')
const n194 = (IDX.match(/\?v=194/g) || []).length
const nOther = (IDX.match(/\?v=(?!194)\d+/g) || []).length
ok('F1 index.html ?v=194 = 12 处', n194 === 12, '实=' + n194)
ok('F2 无其它版本号残留', nOther === 0, '实=' + nOther)

console.log('\n=== 结果 = ' + pass + ' 通过 / ' + fail + ' 失败 ===')
process.exit(fail === 0 ? 0 : 1)
