// test-v118-round-switch-columns.js
// v118：「七天挑战开关」独立卡片区（v107 引入）合并进「营次管理」表两列。
// 背景（用户反馈）：「这个区域用来干嘛的？似乎不太简洁，且没有其他餐厅的。」
//   两个真实问题：
//     ① 信息割裂：同一营次要跨两个面板看（营次表看排期/部门，开关卡看两个开关）；
//     ② 卡片区**跟随看板部门筛选**（v107 的 dashRoundsForGate 按 dashChDept 过滤），
//        管理员切到「标帜餐厅」后只看到标帜那一期，误以为「其他餐厅的开关没了」。
//   修法：把「挑战」「考试」各作一列并进营次表（营次表=全集视图，不随部门筛选）。
// 断言面：
//   ① 数据层未变：两个 set* 仍支持 roundId 精确落刀（回归保护，防误删）
//   ② 单元格函数：dashChOpenCellHtml / dashChExamCellHtml 定义 + 按钮 + badge + roundId + tooltip
//   ③ 营次表接线：表头 7 列顺序、行 7 单元格顺序、开关列位置
//   ④ 独立卡片区彻底下线（正反双向断言：新家有 / 老家没）
//   ⑤ 刷新链路：dashRefreshRoundsPanel 刷 #dashRoundsPanel；兼容别名链完整
//   ⑥ i18n：dashRoundSwitchHint 成对；列头复用键仍成对
//   ⑦ 版本号：唯一 ?v=N ×12 且 ≥118
'use strict'
let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) } }
const fs = require('fs')
const path = require('path')

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const cloudSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf8')
const idxSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

// 取函数体（到下一个顶层 function 声明之前）
const bodyOf = (src, header) => {
  const i = src.indexOf(header)
  if (i < 0) return ''
  const j = src.indexOf('\nfunction ', i + header.length)
  return src.slice(i, j < 0 ? src.length : j)
}

// ---------- ① 数据层回归保护 ----------
console.log('① 数据层未变（roundId 精确落刀仍是唯一写入口）')
assert(cloudSrc.includes('setChallengeOpen'), 'cloud-store 仍有 setChallengeOpen')
assert(cloudSrc.includes('setChallengeExamOpen'), 'cloud-store 仍有 setChallengeExamOpen')
{
  const i = appSrc.indexOf('async function dashToggleChOpen')
  const b = appSrc.slice(i, i + 900)
  assert(b.includes('setChallengeOpen({ open: next, roundId: rid })'), 'dashToggleChOpen 仍传 roundId（精确落刀，未退化为指针期）')
  assert(b.includes('data') || b.includes('btn.dataset.rid'), 'dashToggleChOpen 仍从按钮 dataset 取目标营次')
}
{
  const i = appSrc.indexOf('async function dashToggleChExam')
  const b = appSrc.slice(i, i + 1400)
  assert(b.includes('setChallengeExamOpen({ open: next, roundId: rid })'), 'dashToggleChExam 仍传 roundId')
  assert(/if \(rid === dashRoundCurId\(\)\) CloudSync\._chExamOpen = next/.test(b),
    '仍只在改当前指针期时同步侧信道（防学员端读错期）')
}

// ---------- ② 两个单元格函数 ----------
console.log('② 单元格函数：挑战列 / 考试列')
const cellOpen = bodyOf(appSrc, 'function dashChOpenCellHtml(r)')
const cellExam = bodyOf(appSrc, 'function dashChExamCellHtml(r)')
assert(cellOpen.length > 0, 'dashChOpenCellHtml 已定义')
assert(cellExam.length > 0, 'dashChExamCellHtml 已定义')
assert(cellOpen.includes('<td') && cellExam.includes('<td'), '两者都返回 <td> 单元格（可直接插进表行）')
assert(cellOpen.includes('dashToggleChOpen(this)'), '挑战列：按钮调 dashToggleChOpen(this)')
assert(cellExam.includes('dashToggleChExam(this)'), '考试列：按钮调 dashToggleChExam(this)')
assert(cellOpen.includes('data-rid="${rid}"'), '挑战列：按钮带 data-rid（目标营次）')
assert(cellExam.includes('data-rid="${rid}"'), '考试列：按钮带 data-rid（目标营次）')
assert(cellOpen.includes('const rid = escAttr(r.id)'), '挑战列：rid 经 escAttr 转义（防属性截断）')
assert(cellExam.includes('const rid = escAttr(r.id)'), '考试列：rid 经 escAttr 转义')
// badge 两态（本次用显式三元，非 v107 的 badge() 辅助函数）
assert(/t\('dashChOpenOn'\)/.test(cellOpen) && /t\('dashChOpenOff'\)/.test(cellOpen),
  '挑战列：徽章开/关两态文案齐备')
assert(/t\('dashChExamOn'\)/.test(cellExam) && /t\('dashChExamOff'\)/.test(cellExam),
  '考试列：徽章开/关两态文案齐备')
assert(/t\('dashChOpenCloseBtn'\)/.test(cellOpen) && /t\('dashChOpenOpenBtn'\)/.test(cellOpen),
  '挑战列：按钮开/关两态文案齐备')
assert(/t\('dashChExamCloseBtn'\)/.test(cellExam) && /t\('dashChExamOpenBtn'\)/.test(cellExam),
  '考试列：按钮开/关两态文案齐备')
// 徽章与按钮同判据（都用 r.open===true / r.examOpen===true，避免徽章说开、按钮说关）
assert(/r\.open === true/.test(cellOpen), '挑战列：徽章与按钮共用 r.open===true 判据')
assert(/r\.examOpen === true/.test(cellExam), '考试列：徽章与按钮共用 r.examOpen===true 判据')
// tooltip 说明沿用既有 hint 键（信息没丢）
assert(cellOpen.includes("escAttr(t('dashChOpenHint'))"), '挑战列：按钮保留 tooltip（dashChOpenHint）')
assert(cellExam.includes("escAttr(t('dashChExamHint'))"), '考试列：按钮保留 tooltip（dashChExamHint）')

// ---------- ③ 营次表接线 ----------
console.log('③ 营次表接线（表头 ↔ 行单元格一一对应）')
const panel = bodyOf(appSrc, 'function dashRoundsPanelHtml()')
assert(panel.length > 0, '能取到 dashRoundsPanelHtml 函数体')
{
  const iThead = panel.indexOf('<thead>')
  const iTheadEnd = panel.indexOf('</tr></thead>')
  assert(iThead > 0 && iTheadEnd > iThead, '能定位表头区域')
  const thead = panel.slice(iThead, iTheadEnd)
  const cols = [...thead.matchAll(/t\('([A-Za-z]+)'\)/g)].map(m => m[1])
  assert(cols.length === 7, `表头 7 列（实际 ${cols.length}）`)
  assert(cols[0] === 'dashRoundNameLabel' && cols[6] === 'dashRoundOpsLabel', '首列「名称」、末列「操作」未动')
  assert(cols[4] === 'dashChOpenTitle' && cols[5] === 'dashChExamTitle', '第 5/6 列为「挑战」「考试」（挑战在前）')
  assert(cols.indexOf('dashRoundWindowLabel') === 3, '开关两列位于「开放时间」之后（顺序：…→ 开放时间 → 挑战 → 考试 → 操作）')
}
{
  const iRows = panel.indexOf('const rows = list.map')
  const iJoin = panel.indexOf("}).join('')", iRows)
  assert(iRows > 0 && iJoin > iRows, '能定位行模板区域')
  const rowTpl = panel.slice(iRows, iJoin)
  const tds = [...rowTpl.matchAll(/<td|\$\{dashCh(Open|Exam)CellHtml\(r\)\}/g)].map(m => m[0])
  assert(tds.length === 7, `行内 7 个单元格（实际 ${tds.length}）`)
  const iOpen = tds.indexOf('${dashChOpenCellHtml(r)}')
  const iExam = tds.indexOf('${dashChExamCellHtml(r)}')
  assert(iOpen === 4 && iExam === 5, '两个开关单元格在第 5/6 位，与表头同序')
  assert(iExam > iOpen, '行内顺序为「挑战 → 考试」')
}
// 说明文案：三条 hint 都在表格之前（用户先读说明再看表）
{
  const iTable = panel.indexOf('<table class="admin-table"')
  assert(iTable > 0, '能定位 <table class="admin-table"')
  for (const k of ['dashRoundHint', 'dashRoundCurHint', 'dashRoundSwitchHint']) {
    const i = panel.indexOf(`t('${k}')`)
    assert(i > 0 && i < iTable, `说明 ${k} 位于表格之前`)
  }
  assert(panel.indexOf("t('dashRoundSwitchHint')") > panel.indexOf("t('dashRoundCurHint')"),
    '开关列说明排在「设为当前」说明之后（先讲切期、再讲开关）')
}
// 说明文案本身要说清「先设为当前、再开放挑战」的顺序（避免又一次语义误解）
{
  const lines = i18nSrc.split('\n').filter(l => l.includes('dashRoundSwitchHint'))
  assert(lines.length === 2, 'dashRoundSwitchHint zh/en 成对')
  assert(lines.some(l => l.includes('设为当前') && l.includes('开放挑战')), 'zh 文案点明「先设为当前 → 再开放挑战」的顺序')
  assert(lines.some(l => /Set current/.test(l) && /Open challenge/.test(l)), 'en 文案同样点明顺序')
  assert(lines.every(l => !/全体学员|All students/.test(l)), '文案不含「全体学员」（营次按部门隔离，v117 教训）')
}

// ---------- ④ 独立卡片区彻底下线（正反双向） ----------
console.log('④ 独立开关卡片区下线（正反双向断言）')
// 新家：营次表
assert(appSrc.includes('function dashChOpenCellHtml') && appSrc.includes('function dashChExamCellHtml'),
  '新家：两个单元格函数已定义')
assert(/\$\{dashChOpenCellHtml\(r\)\}/.test(panel) && /\$\{dashChExamCellHtml\(r\)\}/.test(panel),
  '新家：营次表行模板真调用两个单元格函数（接线，不只定义）')
// 老家：全没
assert(!appSrc.includes('function dashChGatePanelHtml'), '老家：dashChGatePanelHtml 已删除（不再独立面板）')
assert(!appSrc.includes('function dashChRoundGateCardHtml'), '老家：dashChRoundGateCardHtml 已删除（不再独立卡）')
assert(!appSrc.includes('function dashRoundsForGate'), '老家：dashRoundsForGate 已删除（不再按部门筛选开关列表）')
assert(!/id="dashChGate"/.test(appSrc), '老家：容器 id="dashChGate" 已移除')
assert(!/\$\{dashChGatePanelHtml\(\)\}/.test(appSrc), '老家：模板中不再调用 dashChGatePanelHtml')
assert(!appSrc.includes("document.getElementById('dashChGate')"), '老家：不再有按 #dashChGate 取容器的代码')
// v76/v100 更早的旧形态也不应复活
assert(!appSrc.includes('function dashChExamGateHtml'), '更早形态 dashChExamGateHtml 仍未复活')
assert(!appSrc.includes('function dashChOpenGateHtml'), '更早形态 dashChOpenGateHtml 仍未复活')
// 营次表=全集视图：不得再引入按 dashChDept 过滤营次表的写法（那正是本次 bug 的成因）
{
  const iRows = panel.indexOf('const rows = list.map')
  const iList = panel.indexOf('const list = dashRoundList()')
  assert(iList > 0 && iRows > iList, '营次表数据源仍是 dashRoundList() 全集')
  assert(!/const list = dashRoundList\(\)\.filter/.test(panel),
    '营次表不再对 list 做部门 filter（避免「其他餐厅看不到」复现）')
  assert(!panel.includes('dashRoundUnderDept'), '营次表模板不再引用部门筛选函数')
}

// ---------- ⑤ 刷新链路 ----------
console.log('⑤ 刷新链路与兼容别名')
assert(appSrc.includes('function dashRefreshRoundsPanel()'), 'dashRefreshRoundsPanel 已定义')
{
  const b = bodyOf(appSrc, 'function dashRefreshRoundsPanel()')
  assert(b.includes("getElementById('dashRoundsPanel')"), 'dashRefreshRoundsPanel 刷 #dashRoundsPanel')
  assert(b.includes('dashRoundsPanelHtml()'), 'dashRefreshRoundsPanel 重绘 dashRoundsPanelHtml()')
  assert(!b.includes('dashChGate'), 'dashRefreshRoundsPanel 不再引用已删除的 #dashChGate')
}
{
  const b = appSrc.slice(appSrc.indexOf('async function dashToggleChOpen'), appSrc.indexOf('async function dashToggleChOpen') + 900)
  assert(b.includes('dashRefreshRoundsPanel()'), 'dashToggleChOpen 成功后重绘营次表')
  assert(!b.includes('dashRefreshChGate()'), 'dashToggleChOpen 不再调旧名（避免多刷一次）')
}
{
  const b = appSrc.slice(appSrc.indexOf('async function dashToggleChExam'), appSrc.indexOf('async function dashToggleChExam') + 1400)
  assert(b.includes('dashRefreshRoundsPanel()'), 'dashToggleChExam 成功后重绘营次表')
  assert(!b.includes('dashRefreshChGate()'), 'dashToggleChExam 不再调旧名')
}
// 兼容别名链：dashRefreshExamGate → dashRefreshChGate → dashRefreshRoundsPanel
assert(appSrc.includes('function dashRefreshChGate() { dashRefreshRoundsPanel() }'),
  '别名 dashRefreshChGate → dashRefreshRoundsPanel')
assert(appSrc.includes('function dashRefreshExamGate() { dashRefreshChGate() }'),
  '别名 dashRefreshExamGate → dashRefreshChGate（旧调用不报错）')
// 看板模板：营次表仍在挑战统计块之前，且不再多一个开关容器
{
  const iRounds = appSrc.indexOf('<div id="dashRoundsPanel">')
  const iBlock = appSrc.indexOf('<div id="dashChallengeBlock"></div>')
  assert(iRounds > 0 && iBlock > iRounds, '看板块顺序仍是「营次表 → 挑战统计」（v76/v77 历史约束）')
  const between = appSrc.slice(iRounds, iBlock)
  assert(!/id="dashChGate"/.test(between), '两者之间不再夹着开关容器')
}

// ---------- ⑥ i18n ----------
console.log('⑥ i18n 键成对')
{
  const keys = ['dashChOpenTitle', 'dashChExamTitle', 'dashChOpenOn', 'dashChOpenOff',
    'dashChExamOn', 'dashChExamOff', 'dashChOpenOpenBtn', 'dashChOpenCloseBtn',
    'dashChExamOpenBtn', 'dashChExamCloseBtn', 'dashChOpenHint', 'dashChExamHint',
    'dashRoundSwitchHint', 'dashRoundCurHint', 'dashRoundNameLabel', 'dashRoundStatusLabel',
    'dashRoundWindowLabel', 'dashRoundOpsLabel']
  let bad = []
  for (const k of keys) {
    const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
    if (n !== 2) bad.push(`${k}(${n})`)
  }
  assert(bad.length === 0, `${keys.length} 个键全部 zh/en 成对` + (bad.length ? ` —— 异常：${bad.join(', ')}` : ''))
}

// ---------- ⑦ 版本号 ----------
console.log('⑦ 版本号')
{
  const vms = (idxSrc.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert(vms.length === 12 && uniq.length === 1, '版本号统一：唯一值 × 12 处')
  assert(uniq.length === 1 && uniq[0] >= 118, '版本号 ≥ 118')
}

console.log(`\nPASS ${pass} FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
