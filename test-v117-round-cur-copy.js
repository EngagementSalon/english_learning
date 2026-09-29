// test-v117-round-cur-copy.js
// v117：「设为当前营次」文案订正 —— 原文案误称「全体学员」，实际营次按部门隔离。
// 断言面：
//   ① i18n 两个新键 zh/en 成对；带参键是箭头函数（t() 对函数值 apply）
//   ② dashSetRoundCur 使用 t('dashRoundMakeCurConfirm', label)，且不再出现「全体学员」硬编码文案
//   ③ 面板说明接线：renderDashRoundsPanel 真调用 t('dashRoundCurHint')
//   ④ 版本号：唯一 ?v=N ×12 且 ≥117
let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) } }
const fs = require('fs')
const path = require('path')

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const idxSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

// ---------- ① i18n ----------
console.log('① i18n 新键 zh/en 成对')
for (const k of ['dashRoundMakeCurConfirm', 'dashRoundCurHint']) {
  const n = i18nSrc.split(k + ':').length - 1
  assert(n === 2, `键 ${k} zh/en 各 1 次（实际 ${n}）`)
}
assert(/dashRoundMakeCurConfirm:\s*\(n\)\s*=>/.test(i18nSrc), 'dashRoundMakeCurConfirm 是带参箭头函数（t() apply 调用）')
{
  // 两处键值都必须声明该营次作用范围，不得再出现「全体学员」的说法
  const lines = i18nSrc.split('\n').filter(l => l.includes('dashRoundMakeCurConfirm'))
  assert(lines.length === 2, 'dashRoundMakeCurConfirm 恰好两行（zh/en）')
  assert(lines.every(l => !/全体学员|All students/.test(l)), '两处文案都不含「全体学员 / All students」')
  assert(lines.some(l => l.includes('其他部门')) && lines.some(l => l.includes('other departments')), 'zh/en 均声明「其他部门不受影响」')
  const hint = i18nSrc.split('\n').filter(l => l.includes('dashRoundCurHint'))
  assert(hint.length === 2 && hint.some(l => l.includes('开放挑战')), '面板说明 zh 提及与「开放挑战」的分工')
}

// ---------- ② dashSetRoundCur 源码 ----------
console.log('② dashSetRoundCur 不再硬编码误导文案')
assert(appSrc.includes("t('dashRoundMakeCurConfirm', label)"), '使用带参 i18n 键 dashRoundMakeCurConfirm(label)')
assert(!/全体学员约\s*1\s*分钟内切换/.test(appSrc), 'app.js 已无「全体学员约 1 分钟内切换」旧文案')
assert(!/All students switch to it within/.test(appSrc), 'app.js 已无英文旧文案 "All students switch..."')
// LANG === 'en' 三元硬编码文案应已移除（改走 i18n）
{
  const i = appSrc.indexOf('async function dashSetRoundCur')
  const body = appSrc.slice(i, i + 900)
  assert(body.indexOf("LANG === 'en'") < 0, 'dashSetRoundCur 内不再有 LANG 三元硬编码文案')
  assert(body.indexOf('setChallengeRoundCurrent(rid)') > 0, '仍调用 CloudSync.setChallengeRoundCurrent（保留功能）')
  assert(body.indexOf('dashRoundMakeCurConfirm') > 0, '确认框走新键')
}

// ---------- ③ 面板说明接线 ----------
console.log('③ 面板说明真接线')
assert(appSrc.includes("t('dashRoundCurHint')"), 'renderDashRoundsPanel 模板含 t(dashRoundCurHint)（接线）')
{
  const iP = appSrc.indexOf('function dashRoundsPanelHtml')
  const iH = appSrc.indexOf("t('dashRoundCurHint')")
  const iParent = appSrc.indexOf("t('dashRoundHint')", iP)
  // ⚠️ 面板的 rows 数组在函数开头就算好了（表格行模板），说明文字在后面的 return 模板里，
  //   故「说明必须先于列表渲染」不是有效契约；有效契约是「说明在原提示行旁边 + 在面板函数内
  //   且在表格标记之前（即出现在营次表格上方，用户先看到说明再看到表）」。
  const iTable = appSrc.indexOf('<table class="admin-table"', iP)
  assert(iP > 0 && iH > iP, '说明文字位于 dashRoundsPanelHtml 函数内')
  assert(iParent > 0 && iH > iParent && iH - iParent < 200, '说明紧跟原有「每一期挑战相互独立」提示行')
  assert(iTable > 0 && iH < iTable, '说明位于营次表格之前（在表格上方，先读说明再读表）')
  assert(iH > iP && iH < appSrc.indexOf('function ', iH), '说明未被写到别的函数里（同一函数体内）')
}
assert(appSrc.includes("t('dashRoundMakeCur')"), '「设为当前」按钮本身保留（未移除入口）')

// ---------- ④ 版本号 ----------
console.log('④ 版本号')
{
  const vms = (idxSrc.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert(vms.length === 12 && uniq.length === 1, '版本号统一：唯一值 × 12 处')
  assert(uniq.length === 1 && uniq[0] >= 117, '版本号 ≥ 117')
}

console.log(`\nPASS ${pass} FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
