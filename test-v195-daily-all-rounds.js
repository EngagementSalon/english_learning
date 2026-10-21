// v195：每日准确率走势扩展到「全部营次」（跨营次拼接 + 累计跨期延续）
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
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
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

console.log('=== [A] dashUserDailyAllAcc 跨营次拼接 ===')
function mkSandbox(roundList) {
  const sb = {
    Math, Number, String, Array, Object, isFinite, console,
    dashRoundSlug: id => String(id || ''),
    dashRoundList: () => (roundList || []),
  }
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, 'dashUserDailyAcc'), sb)
  vm.runInContext(extractFn(APP, 'dashUserDailyAllAcc'), sb)
  return sb
}
const all = mkSandbox().dashUserDailyAllAcc

// A1 两组拼接：14 cells（2 组 × 7 天全展开）
const t1 = all({ chy: [
  { day: 1, si: 0, correct: 10, total: 20, at: 100, rd: 'r1' },
  { day: 2, si: 0, correct: 15, total: 30, at: 200, rd: 'r1' },
  { day: 1, si: 0, correct: 24, total: 30, at: 900000, rd: 'r2' },
  { day: 2, si: 0, correct: 27, total: 30, at: 901000, rd: 'r2' },
] })
ok('A1 组数=2 cells=14', t1.roundCount === 2 && t1.cells.length === 14)
ok('A2 组序按最早 at（r1 前）', t1.cells[0].roundNo === 1 && t1.cells[7].roundNo === 2)
ok('A3 标签 1·D1 / 2·D1', t1.cells[0].label === '1·D1' && t1.cells[7].label === '2·D1')
// A4 跨期累计：r2 D1 = (10+15+24)/(20+30+30) = 49/80 = 61%
ok('A4 cum 跨营次延续（2·D1 = 61%，不重置）', t1.cells[7].cum === 61, '实=' + t1.cells[7].cum)
ok('A5 全期 avg = 69%', t1.avg === 69, '实=' + t1.avg)
ok('A6 无数据日 acc=null cum 延续', t1.cells[2].acc === null && t1.cells[2].cum === 50)
ok('A7 covered=4', t1.covered === 4)

// A8 组名走 dashRoundList
const t8 = mkSandbox([{ id: 'r1', name: '一期' }, { id: 'r2', name: '二期' }]).dashUserDailyAllAcc(
  { chy: [{ day: 1, si: 0, correct: 10, total: 20, at: 100, rd: 'r2' }] })
ok('A8 组名解析', t8.cells[0].round === '二期')

// A9 无 rd → 第 1 组（legacy 兜底），仍按时间序在前
const t9 = all({ chy: [
  { day: 1, si: 0, correct: 10, total: 20, at: 100 },
  { day: 1, si: 0, correct: 20, total: 20, at: 900, rd: 'r2' },
] })
ok('A9 无 rd 归第 1 组且在前', t9.roundCount === 2 && t9.cells[0].roundNo === 1 && t9.cells[0].q === 20)

// A10 单营次 = v194 行为不变
const t10 = all({ chy: [{ day: 1, si: 0, correct: 18, total: 20, at: 100, rd: 'r3' }] })
ok('A10 单营次 7 cells', t10.roundCount === 1 && t10.cells.length === 7)

// A11 空 chy
const t11 = all({})
ok('A11 空输入 covered=0', t11.covered === 0 && t11.cells.length === 0 && t11.avg === null)

// A12 cleared 跨营次剔除
const t12 = all({ chy: [
  { day: 1, si: 0, correct: 10, total: 20, at: 100, rd: 'r1', cleared: true },
  { day: 1, si: 0, correct: 18, total: 20, at: 200, rd: 'r1' },
] })
ok('A12 cleared 剔除 covered=1', t12.covered === 1 && t12.cells[0].acc === 90)

console.log('\n=== [B] 源码契约 ===')
const allCode = codeOnly(extractFn(APP, 'dashUserDailyAllAcc'))
ok('B1 组序按最早 at 升序', allCode.includes('Math.min.apply'))
ok('B2 累计跨组延续（注释明确）', extractFn(APP, 'dashUserDailyAllAcc').includes('跨营次延续'))
ok('B3 首答口径复用 dashUserDailyAcc', allCode.includes('dashUserDailyAcc('))
ok('B4 标签格式 n·Dm', allCode.includes("'·D'") || /label:\s*\(gi \+ 1\)/.test(allCode))

console.log('\n=== [C] _upProfileHtml 接线 ===')
const profCode = codeOnly(extractFn(APP, '_upProfileHtml'))
ok('C1 接线 dashUserDailyAllAcc', profCode.includes('dashUserDailyAllAcc(r)'))
ok('C2 不再引用 dailyRound（v194 遗留清除）', !profCode.includes('dailyRound'))
ok('C3 表格含营次列（round）', profCode.includes('x.round'))
ok('C4 图色仍为当日青/累计紫', profCode.includes("'#0891b2'") && profCode.includes("'#7c3aed'"))

console.log('\n=== [D] 渲染真跑（双营次） ===')
const sb2 = {
  Math, Number, String, Array, Object, Date, isFinite, isNaN, JSON, console,
  LANG: 'zh',
  escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  escAttr: s => String(s == null ? '' : s).replace(/"/g, '&quot;'),
  dashRoundSlug: id => String(id || ''),
  dashRoundList: () => [{ id: 'r1', name: '标帜餐厅第一期' }, { id: 'r2', name: '标帜餐厅第二期' }],
  dashChStageWeight: () => 1,
  courseAssignTypeLabel: ty => ty,
  _courseCellDone: (a, r) => !!(r && r.done),
  Store: { getQuestions: () => [] },
}
vm.createContext(sb2)   // ★ 抽函数前必须 contextify（三撞：v194 D 组 / v195 D 组 / v194 首版）
try { vm.runInContext(I18N + '\n;globalThis.__D = (typeof I18N !== "undefined") ? I18N : null;', sb2) } catch (e) { /* ok */ }
const zh = (sb2.__D || {}).zh || {}
sb2.t = function (k) {
  const args = Array.prototype.slice.call(arguments, 1)
  const v = (zh[k] !== undefined) ? zh[k] : k
  return (typeof v === 'function') ? v.apply(null, args) : v
}
;['_upLineChartSvg', 'dashUserRoundSeries', 'dashUserLevelSeries', 'dashUserCourseSeries', 'dashUserDailyAcc', 'dashUserDailyAllAcc',
  '_upProfileHtml', 'dashUserWrongList', '_upWrongCardHtml', '_upWrongSectionHtml'].forEach(n => {
  try { vm.runInContext(extractFn(APP, n), sb2) } catch (e) { console.log('  ⚠ 抽取失败 ' + n + ': ' + e.message) }
})
let rendered = ''
try {
  const row = { username: 'tester', name: '测试', dept: 'x', chLevel: 2,
    chy: [
      { day: 1, si: 0, kind: 'test', correct: 18, total: 20, at: 100, rd: 'r1' },
      { day: 2, si: 0, kind: 'practice', correct: 27, total: 30, at: 200, rd: 'r1' },
      { day: 1, si: 0, kind: 'test', correct: 25, total: 20, at: 900000, rd: 'r2' },  // 脏数据 correct>total
    ] }
  rendered = sb2._upProfileHtml(row, null, [], sb2.dashUserWrongList(row, []))
} catch (e) { ok('D0 渲染', false, e.message) }
ok('D1 渲染出 2 期标签 1·D1 与 2·D1', rendered.includes('1·D1') && rendered.includes('2·D1'))
ok('D2 营次全名在表格', rendered.includes('标帜餐厅第一期') && rendered.includes('标帜餐厅第二期'))
ok('D3 无未替换占位符', !/\{[a-zA-Z]+\}/.test(rendered.replace(/\{0,1\}/g, '')))
ok('D4 hint 提示覆盖营次数', /覆盖全部 2 个营次/.test(rendered))

console.log('\n=== [E] i18n ===')
ok('E1 upDailyHint 三参箭头函数（zh+en）',
  (I18N.match(/upDailyHint\s*:\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*=>/g) || []).length === 2)

console.log('\n=== [F] 版本标记（动态，不写死版本号） ===')
const vNums = IDX.match(/\?v=(\d+)/g) || []
const uniq = Array.from(new Set(vNums))
ok('F1 index.html 版本标记 12 处同号', vNums.length === 12 && uniq.length === 1, '实=' + vNums.length + ' 处 / ' + uniq.join(','))
ok('F2 版本号 ≥195（不回退）', uniq.length === 1 && parseInt(uniq[0].replace(/\?v=/, ''), 10) >= 195, uniq[0])

console.log('\n=== 结果 = ' + pass + ' 通过 / ' + fail + ' 失败 ===')
process.exit(fail === 0 ? 0 : 1)
