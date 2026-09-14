// ====== 测试 v82：七天挑战看板「每日打卡」 ======
// renderDashChallengeBlock：进度明细表新增 Day1-Day7 打卡列（✅ 当天全部阶段完成 / ◐ 部分 / — 未完成）
// + 底部图例与各天打卡人数汇总（含管理员，与 v78「明细仍含管理员」口径一致）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

function renderDash(rows) {
  const el = { innerHTML: '' }
  const sb = {
    console,
    document: { getElementById: (id) => (id === 'dashChallengeBlock' ? el : null) },
    setTimeout, clearTimeout,
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  vm.runInContext(extractFn(appSrc, 'escHtml'), sb)
  vm.runInContext(extractFn(appSrc, 'dashChStageWeight'), sb)
  vm.runInContext(extractFn(appSrc, 'renderDashChallengeBlock'), sb)
  vm.runInContext('const TYPE_LABELS = new Proxy({}, { get: (_, k) => k })', sb)
  vm.runInContext('const Store = { getQuestions: () => [] }', sb)
  vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(rows)})`, sb)
  return el.innerHTML
}

// 取某学员在进度明细表中的整行（明细表 = 含「每日打卡」colspan 表头的第二张表，须跳过前面的积分榜行）
function rowOf(html, username) {
  const seg = html.slice(html.indexOf('colspan="7"'))
  const start = seg.indexOf('>' + username + '<')
  if (start < 0) return ''
  const end = seg.indexOf('</tr>', start)
  return seg.slice(start, end)
}
const countOf = (s, k) => s.split(k).length - 1

;(async () => {
  console.log('\n🧪 v82 看板每日打卡测试')

  // ---------- ① 打卡推导 ----------
  console.log('\n[1] 每日打卡列渲染（✅ 全部完成 / ◐ 部分 / — 未完成）')
  const rows = [
    // alice：Day1 两个阶段都完成（✅）+ Day2（✅）
    { username: 'alice', name: 'Alice', dept: '标帜餐厅', role: 'student',
      chy: [
        { day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 100, usedSec: 200 },
        { day: 1, si: 1, kind: 'practice', correct: 25, total: 30, at: 150, usedSec: 120 },
        { day: 2, si: 0, kind: 'practice', correct: 24, total: 30, at: 86400000 + 100, usedSec: 300 },
      ], chQ: {} },
    // bob：Day1 只完成 test（2 阶段完成 1 → ◐）
    { username: 'bob', name: 'Bob', dept: '迎宾前台', role: 'student',
      chy: [{ day: 1, si: 0, kind: 'test', correct: 6, total: 20, at: 110, usedSec: 240 }], chQ: {} },
    // carol：Day3 单阶段（✅）
    { username: 'carol', name: 'Carol', dept: 'WOOBAR', role: 'student',
      chy: [{ day: 3, si: 0, kind: 'practice', correct: 20, total: 30, at: 200, usedSec: 280 }], chQ: {} },
    // boss：管理员，Day1 双阶段 ✅（明细与打卡汇总仍含管理员）
    { username: 'boss', name: '管理员', dept: '—', role: 'admin',
      chy: [
        { day: 1, si: 0, kind: 'test', correct: 15, total: 20, at: 90, usedSec: 150 },
        { day: 1, si: 1, kind: 'practice', correct: 30, total: 30, at: 95, usedSec: 60 },
      ], chQ: {} },
    // eve：Day7 practice+test 双阶段 ✅
    { username: 'eve', name: 'Eve', dept: '宴会运营', role: 'student',
      chy: [
        { day: 7, si: 0, kind: 'practice', correct: 10, total: 10, at: 300, usedSec: 80 },
        { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 400, usedSec: 300 },
      ], chQ: {} },
  ]
  const html = renderDash(rows)

  assert('表头含「每日打卡」列组（colspan 7）', html.includes('每日打卡') && html.includes('colspan="7"'), '')
  assert('表头含 D1–D7 小列', [1, 2, 3, 4, 5, 6, 7].every(d => html.includes('>D' + d + '<')))
  {
    const r = rowOf(html, 'alice')
    assert('alice：D1 ✅ D2 ✅ 其余 5 天 —（✅×2）', countOf(r, '✅') === 2, r.slice(-200))
    assert('alice 行无 ◐', countOf(r, '◐') === 0)
  }
  {
    const r = rowOf(html, 'bob')
    assert('bob：Day1 双阶段只完成 1 → ◐ ×1', countOf(r, '◐') === 1 && countOf(r, '✅') === 0, r.slice(-200))
  }
  {
    const r = rowOf(html, 'carol')
    assert('carol：Day3 单阶段 ✅ ×1', countOf(r, '✅') === 1 && countOf(r, '◐') === 0)
  }
  {
    const r = rowOf(html, 'eve')
    assert('eve：Day7 双阶段 ✅ ×1（其余 6 天 —）', countOf(r, '✅') === 1 && countOf(r, '◐') === 0)
  }
  {
    const r = rowOf(html, 'boss')
    assert('boss（管理员）：明细表打卡列仍渲染 ✅ ×1', countOf(r, '✅') === 1)
  }

  // ---------- ② 打卡汇总 ----------
  console.log('\n[2] 图例与各天打卡人数')
  assert('图例含 ✅/◐/— 说明', html.includes('✅ 当天全部完成') && html.includes('◐ 部分完成') && html.includes('— 未完成'))
  // 各天全勤人数：D1 alice+boss=2；D2 alice=1；D3 carol=1；D7 eve=1；D4-6=0
  const statsOk = ['D1 2', 'D2 1', 'D3 1', 'D4 0', 'D5 0', 'D6 0', 'D7 1'].every(s => html.includes(s))
  assert('各天打卡人数 D1 2 · D2 1 · D3 1 · D4 0 · D5 0 · D6 0 · D7 1（含管理员）', statsOk, ['D1 2','D2 1','D3 1','D4 0','D5 0','D6 0','D7 1'].filter(s => !html.includes(s)).join(','))

  // ---------- ③ 无打卡数据 ----------
  console.log('\n[3] 边界')
  {
    const h2 = renderDash([{ username: 'zoe', name: 'Zoe', dept: '礼宾部', role: 'student', chy: [{ day: 1, si: 0, kind: 'test', correct: 5, total: 20, at: 1, usedSec: 100 }], chQ: {} }])
    const r = rowOf(h2, 'zoe')
    assert('zoe：仅 Day1 半完成 → ✅×0 ◐×1', countOf(r, '✅') === 0 && countOf(r, '◐') === 1)
  }
  {
    const h3 = renderDash([])
    assert('无参与学员仍走空态提示（不渲染打卡表）', h3.includes('dashChNone') === false && (h3 === '' || !h3.includes('每日打卡')))
  }

  // ---------- ④ i18n 键成对 ----------
  console.log('\n[4] i18n')
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  for (const k of ['dashChThCheckin:', 'dashChCheckinLegend:', 'dashChCheckinStatsLabel:']) {
    assert(`i18n ${k} zh/en 成对`, countOf(i18nSrc, k) === 2)
  }

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v82 每日打卡测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
