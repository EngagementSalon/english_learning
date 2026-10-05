// test-v139-dash-ch-scoreboard.js
// v139：七天挑战成绩看板（网页）与导出（Excel）改为「三段分组」形态，对齐线下报表《七天挑战成绩》。
// 断言面：
//   ① i18n 新键 zh/en 成对（各 1 次）
//   ② 分组规则 vm 真跑：门槛 30、成绩齐全度、以及「只重置过考试成绩」的归属
//   ③ D1–D7 的 1/-1 判据（复现原表 Star Zhang 那条强证据）
//   ④ 提分 = 后测 − 前测；缺一侧 → '-'（半角连字符，非 0）
//   ⑤ dashChExportSheets 结构：三段横幅/表头/数据/汇总 + merges + cols + 公式
//   ⑥ 端到端 .xlsx：解 stored zip 校验 styles.xml / mergeCells / cols / 公式 / 灰底 / 数字格式
//   ⑦ 网页看板渲染：三段分组 + 部门 rowspan + 1/-1 + 操作列保留 + 导出按钮
//   ⑧ 积分榜口径回归（管理员不排名 / 同分比用时 / 再比答对）
//   ⑨ 版本号唯一且 ≥139 ×12
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let pass = 0, fail = 0
const assert = (name, cond, msg) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (msg ? '  → ' + msg : '')) }
}
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8')
const APP = read('app.js')
const CA = read('course-app.js')

// 抽函数：兼容 `function name(` / `async function name(`，按花括号配平截取
function extractFn(src, name) {
  const m = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(').exec(src)
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
// 抽常量声明整行（const NAME = ...）
function extractConst(src, name) {
  const m = new RegExp('(^|\\n)const ' + name + ' = ([^\\n]+)').exec(src)
  if (!m) throw new Error('const not found: ' + name)
  return 'const ' + name + ' = ' + m[2] + '\n'
}
// 抽「v139 三段分组」整块（从标记注释到 dashChExportSheets 之前）——
// ⚠️ 不能只抽函数：这些函数引用了同块的顶层 const，单抽会 ReferenceError
function extractV139Block(src) {
  const i = src.indexOf('// ====== v139：三段分组口径')
  const j = src.indexOf('function dashChExportSheets(list) {')
  if (i < 0 || j < 0 || j <= i) throw new Error('v139 block not found')
  return src.slice(i, j)
}

// ---------------- 沙箱 A：纯逻辑 + xlsx 写入器（无 DOM） ----------------
function makeLogicSandbox() {
  const sb = {
    console, Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder, Uint8Array, DataView, Int32Array, Buffer,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(read('i18n.js'), sb)
  vm.runInContext(extractV139Block(APP), sb)
  vm.runInContext(extractFn(APP, 'dashChExportSheets'), sb)
  vm.runInContext(extractFn(APP, 'impXlsxFromSheets'), sb)
  ;['xlsxXmlEscape', 'xlsxColRef', 'xlsxSheetXml', 'xlsxStyleBook', 'xlsxCellXml',
    'xlsxPxToWidth', 'xlsxSheetXmlRich', 'xlsxCrc32', 'xlsxBuildZip'].forEach(n => {
    vm.runInContext(extractFn(CA, n), sb)
  })
  return sb
}
// ---------------- 沙箱 B：看板渲染（DOM mock） ----------------
function makeDashSandbox() {
  const sb = {
    console, Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById() { return null } },
  }
  sb.window = sb
  vm.createContext(sb)
  vm.runInContext(read('i18n.js'), sb)
  vm.runInContext(extractV139Block(APP), sb)
  vm.runInContext(extractFn(APP, 'escHtml'), sb)
  vm.runInContext(extractFn(APP, 'escAttr'), sb)
  vm.runInContext(extractFn(APP, 'renderDashChallengeBlock'), sb)
  vm.runInContext(extractFn(APP, 'dashChStageWeight'), sb)
  vm.runInContext(extractFn(APP, 'dashRoundUnderDept'), sb)
  // 营次/部门依赖：沙箱按「单期（第一期）+ 全部部门」口径，等价 v88/v89 的默认行为
  vm.runInContext('function dashRoundList() { return [] }', sb)
  vm.runInContext('function dashRoundCurId() { return "" }', sb)
  vm.runInContext('function dashRoundSlug(id) { return "" }', sb)
  vm.runInContext('let dashRoundView = ""', sb)
  vm.runInContext('let dashChDept = "all"', sb)
  vm.runInContext('const TYPE_LABELS = new Proxy({}, { get: (_, k) => k })', sb)
  vm.runInContext('const Store = { getQuestions: () => [] }', sb)
  vm.runInContext('window.__els = {}', sb)
  vm.runInContext('document.getElementById = (id) => (window.__els[id] = window.__els[id] || { id, innerHTML: "" })', sb)
  return sb
}

// 学员行工厂（看板输入口径：已聚合好的 chy/chQ）
const mkRow = (o) => Object.assign({
  username: 'u', name: 'N', dept: 'D', role: 'student',
  q: 100, acc: 80, s1: 80, s7: 90, m1: false, m7: false,
  checkin: [2, 2, 2, 2, 2, 2, 2], lbC: 0, lbT: 0, lbScore: 0, chQ: {},
  maxDay: 7, stagesDone: 9,
}, o || {})

// ============================================================================
console.log('\n🧪 v139 七天挑战成绩看板（三段分组）')

// ---------- ① i18n ----------
console.log('\n[1] i18n 新键 zh/en 成对')
{
  const src = read('i18n.js')
  for (const k of ['dashChGrpFull', 'dashChGrpPartial', 'dashChGrpInvalid', 'dashChAvgLabel',
    'dashChGrpEmpty', 'dashChJoinCount', 'dashChColDept', 'dashChColName', 'dashChColUser',
    'dashChColQ', 'dashChColAcc', 'dashChColPre', 'dashChColFinal', 'dashChColChange',
    'dashChGrpRuleHint', 'dashChDayMarkHint', 'dashChDayPartialHint']) {
    const n = src.split(k + ':').length - 1
    assert(`键 ${k} 在 zh/en 各出现 1 次（实际 ${n}）`, n === 2)
  }
  const sb = makeLogicSandbox()
  assert('zh 分组名保留原表双语写法', vm.runInContext("t('dashChGrpFull')", sb) === '完全有效组(Fully Valid)')
  assert('汇总标签拼写 Average（原表 Avearge 笔误已按用户拍板改正，en 同）', vm.runInContext(`(() => {
    const z = I18N.zh.dashChAvgLabel
    setLang('en'); const e = I18N.en.dashChAvgLabel; setLang('zh'); return z + '|' + e
  })()`, sb) === 'Average|Average')
}

// ---------- ② 分组规则 ----------
console.log('\n[2] 分组规则（门槛 + 齐全度）')
{
  const sb = makeLogicSandbox()
  assert('★ 门槛常量 = 30（原表事实：答 20 题归无效组、答 30 题留单边缺失组）',
    vm.runInContext('DASH_CH_MIN_Q', sb) === 30, String(vm.runInContext('DASH_CH_MIN_Q', sb)))
  assert('分组键顺序 = full / partial / invalid',
    JSON.stringify(vm.runInContext('DASH_CH_GROUPS', sb)) === '["full","partial","invalid"]')
  const gk = o => vm.runInContext(`dashChGroupKey(${JSON.stringify(mkRow(o))})`, sb)
  assert('前测+后测都有（q=100）→ 完全有效组', gk({ s1: 80, s7: 90 }) === 'full')
  assert('只有前测（后测缺）→ 单边缺失组', gk({ s1: 80, s7: null }) === 'partial')
  assert('只有后测（前测缺）→ 单边缺失组', gk({ s1: null, s7: 90 }) === 'partial')
  assert('两个都缺但答题数够（重置过考试成绩）→ 单边缺失组，绝不能算「未参与」',
    gk({ s1: null, s7: null, q: 200 }) === 'partial')
  assert('★ 答题数 29（低于门槛）→ 无效/未参与组', gk({ q: 29, s1: 80, s7: 90 }) === 'invalid')
  assert('答题数 0 → 无效/未参与组', gk({ q: 0 }) === 'invalid')
  // 原表逐行复现
  assert('原表 Iris Zhang 形态（20 题 / 前测100 / 后测90）→ 无效/未参与组',
    gk({ q: 20, s1: 100, s7: 90 }) === 'invalid')
  assert('★ 原表 Star Zhang 形态（30 题 / 前测95 / 后测缺）→ 单边缺失组',
    gk({ q: 30, s1: 95, s7: null }) === 'partial')
  assert('原表 Vicky Qin 形态（313 题 / 70→90）→ 完全有效组',
    gk({ q: 313, s1: 70, s7: 90 }) === 'full')
  // 三段分组装配
  const blocks = vm.runInContext(`dashChScoreBlocks(${JSON.stringify([
    mkRow({ username: 'a', q: 100, s1: 1, s7: 2 }),
    mkRow({ username: 'b', q: 300, s1: 1, s7: 2 }),
    mkRow({ username: 'c', q: 50, s1: null, s7: 2 }),
    mkRow({ username: 'd', q: 5, s1: 1, s7: 2 }),
  ])})`, sb)
  assert('固定输出三段（顺序 full/partial/invalid）',
    blocks.map(b => b.key).join(',') === 'full,partial,invalid')
  assert('组内按答题数降序（200 组内 300 在 100 前）',
    blocks[0].rows.map(r => r.username).join(',') === 'b,a')
  assert('门槛外的进无效组', blocks[2].rows.map(r => r.username).join(',') === 'd')
  assert('横幅文案取 i18n（中文为原表双语写法）', blocks[1].label === '单边缺失组(Partial Missing)', blocks[1].label)
}

// ---------- ③ D1–D7 判据 ----------
console.log('\n[3] D1–D7：当日全部阶段完成 = 1，否则 -1')
{
  const sb = makeLogicSandbox()
  const marks = (ck) => vm.runInContext(`[1,2,3,4,5,6,7].map(d => dashChDayMark(${JSON.stringify({ checkin: ck })}, d))`, sb)
  assert('全部完成（checkin 全 2）→ 全 1',
    JSON.stringify(marks([2, 2, 2, 2, 2, 2, 2])) === '[1,1,1,1,1,1,1]')
  assert('★ 部分完成（1）也记 -1 —— 原表只有 1/-1 两态，没有「半」',
    JSON.stringify(marks([2, 1, 0, 2, 1, 0, 2])) === '[1,-1,-1,1,-1,-1,1]')
  assert('★ 原表 Star Zhang 复现（Day1 全做完后停手）→ [1,-1,-1,-1,-1,-1,-1]',
    JSON.stringify(marks([2, 0, 0, 0, 0, 0, 0])) === '[1,-1,-1,-1,-1,-1,-1]')
  assert('checkin 缺失/短数组不抛异常且记 -1',
    JSON.stringify(marks(undefined)) === '[-1,-1,-1,-1,-1,-1,-1]')
}

// ---------- ④ 提分 ----------
console.log('\n[4] 提分 = 后测 − 前测')
{
  const sb = makeLogicSandbox()
  const chg = o => vm.runInContext(`dashChScoreChange(${JSON.stringify(o)})`, sb)
  assert('70 → 90 记 +20', chg({ s1: 70, s7: 90 }) === 20)
  assert('100 → 95 记 -5', chg({ s1: 100, s7: 95 }) === -5)
  assert('前后都齐且相等记 0', chg({ s1: 90, s7: 90 }) === 0)
  assert("缺前测 → '-'（半角连字符，不是 0）", chg({ s1: null, s7: 90 }) === '-')
  assert("缺后测 → '-'", chg({ s1: 90, s7: null }) === '-')
}

// ---------- ⑤ 导出结构 ----------
console.log('\n[5] dashChExportSheets：三段纵向堆叠')
{
  const sb = makeLogicSandbox()
  const rows = [
    mkRow({ username: 'vicky', name: 'Vicky Qin', dept: 'The Kitchen Table', q: 313, acc: 81, s1: 70, s7: 90 }),
    mkRow({ username: 'penny', name: 'Penny Hou', dept: 'The Kitchen Table', q: 310, acc: 96, s1: 100, s7: 95 }),
    mkRow({ username: 'sylas', name: 'Sylas Hu', dept: 'The Kitchen Table', q: 193, acc: 93, s1: null, s7: 95 }),
    mkRow({ username: 'star', name: 'Star Zhang', dept: 'The Kitchen Table', q: 30, acc: 87, s1: 95, s7: null, checkin: [2, 0, 0, 0, 0, 0, 0] }),
    mkRow({ username: 'iris', name: 'Iris Zhang', dept: 'The Kitchen Table', q: 20, acc: 0, s1: 100, s7: 90, checkin: [0, 0, 0, 0, 0, 0, 0] }),
  ]
  const sheets = vm.runInContext(`dashChExportSheets(${JSON.stringify(rows)})`, sb)
  assert('输出两个 sheet（成绩明细 + 积分榜）', sheets.length === 2 && sheets[0].name === '成绩明细' && sheets[1].name === '积分榜')
  assert('明细 sheet 声明了 merges 与 cols（走富版式）',
    Array.isArray(sheets[0].merges) && sheets[0].merges.length > 0 && Array.isArray(sheets[0].cols))
  assert('列宽 15 列（含新增的用户名列）', sheets[0].cols.length === 15)
  const R = sheets[0].rows
  const txt = (r, c) => (R[r] && R[r][c] ? R[r][c].v : null)
  assert('行布局 = 3 组 ×（横幅 + 表头）+ 2 数据 + 汇总 + 2 数据 + 1 数据 = 12 行', R.length === 12, 'got ' + R.length)
  assert('第 1 行 = 完全有效组横幅', txt(0, 0) === '完全有效组(Fully Valid)', txt(0, 0))
  assert('第 2 行 = 列标题（部门/姓名/用户名/答题数/正确率/前测/后测/提分/D1）',
    txt(1, 0) === '部门' && txt(1, 1) === '姓名' && txt(1, 2) === '用户名' && txt(1, 3) === '答题数'
    && txt(1, 4) === '正确率' && txt(1, 5) === '前测' && txt(1, 6) === '后测' && txt(1, 7) === '提分' && txt(1, 8) === 'D1',
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map(c => txt(1, c)).join('/'))
  assert('第 3 行 = 完全有效组第 1 名（Vicky Qin / 313 / 70 / 90 / +20）',
    txt(2, 1) === 'Vicky Qin' && txt(2, 3) === 313 && txt(2, 5) === 70 && txt(2, 6) === 90 && txt(2, 7) === 20)
  assert('部门列合并段内第 2 行留空（要靠 merges 补）', txt(3, 0) === null)
  assert('提分写成公式（=后测−前测），并带缓存值', R[2][7].f === 'G3-F3' && R[2][7].v === 20, R[2][7].f)
  assert('第 5 行 = Average 汇总（前测 85 / 后测 92.5 / 提分 7.5）',
    txt(4, 0) === 'Average' && txt(4, 5) === 85 && txt(4, 6) === 92.5 && txt(4, 7) === 7.5,
    [txt(4, 0), txt(4, 5), txt(4, 6), txt(4, 7)].join('/'))
  assert('汇总用 AVERAGE 公式，范围只覆盖本组数据行',
    R[4][5].f === 'AVERAGE(F3:F4)' && R[4][6].f === 'AVERAGE(G3:G4)' && R[4][7].f === 'AVERAGE(H3:H4)')
  assert('第 6/10 行 = 另两组横幅', txt(5, 0) === '单边缺失组(Partial Missing)' && txt(9, 0) === '无效/未参与组(Invalid/Non-participant)')
  assert('单边缺失组按答题数降序（193 在 30 前）', txt(7, 1) === 'Sylas Hu' && txt(8, 1) === 'Star Zhang')
  assert("缺考导出 '-'（不是 0 / 空）", txt(7, 5) === '-' && txt(8, 6) === '-')
  assert('无效组只有 1 名（Iris Zhang）且在最后一块', txt(11, 1) === 'Iris Zhang')
  const starDay = [8, 9, 10, 11, 12, 13, 14].map(c => R[8][c].v)
  assert('★ Star Zhang 的 D1–D7 = [1,-1,-1,-1,-1,-1,-1]',
    JSON.stringify(starDay) === '[1,-1,-1,-1,-1,-1,-1]', JSON.stringify(starDay))
  const mg = sheets[0].merges.join(' ')
  assert('合并单元格：三段横幅整行 + 部门列纵向 + Average 标签三列',
    mg.includes('A1:O1') && mg.includes('A6:O6') && mg.includes('A10:O10')
    && mg.includes('A3:A4') && mg.includes('A8:A9') && mg.includes('A5:C5'), mg)
  assert('无效组只有 1 行 → 不产生部门纵向合并', !mg.includes('A11:A'))
  assert('正确率导出为百分比数值（0..1 + 0% 格式），不是文本', typeof R[2][4].v === 'number' && R[2][4].s.fmt === '0%')
  assert('前测/后测一位小数、提分一位小数', R[2][5].s.fmt === '0.0' && R[2][7].s.fmt === '0.0')
  assert('汇总行提分两位小数（原表 G23 为 0.00）', R[4][7].s.fmt === '0.00')
  assert('表头带灰底（原表 #747373）', R[1][0].s.fill === '747373')
  // 手动补录 → 红字（数值保持数字，列不被污染成文本），保留 v105 的来源可追溯
  const rows2 = [mkRow({ username: 'm', q: 100, s1: 80, s7: 90, m7: true })]
  const R2 = vm.runInContext(`dashChExportSheets(${JSON.stringify(rows2)})`, sb)[0].rows
  const manRow = R2.filter(r => r[1] && r[1].v === 'N')[0]
  assert('手动补录的成绩用红字标注且仍是数字单元格',
    manRow[6].s.color === 'FF0000' && typeof manRow[6].v === 'number', JSON.stringify(manRow[6]))
  // 空输入
  const empty = vm.runInContext('dashChExportSheets([])[0]', sb)
  assert('空输入：仍输出三段骨架（3 横幅 + 3 表头 = 6 行），无数据行无汇总行',
    empty.rows.length === 6, 'got ' + empty.rows.length)
  assert('空输入不抛异常（null 也安全）',
    vm.runInContext('dashChExportSheets(null)[0].rows.length', sb) === 6)
}

// ---------- ⑥ 端到端 .xlsx ----------
console.log('\n[6] 端到端 .xlsx 产物')
{
  const sb = makeLogicSandbox()
  const rows = [
    mkRow({ username: 'vicky', name: 'Vicky Qin', dept: 'The Kitchen Table', q: 313, acc: 81, s1: 70, s7: 90 }),
    mkRow({ username: 'penny', name: 'Penny Hou', dept: 'The Kitchen Table', q: 310, acc: 96, s1: 100, s7: 95, m7: true }),
    mkRow({ username: 'star', name: 'Star Zhang', dept: 'The Kitchen Table', q: 30, acc: 87, s1: 95, s7: null, checkin: [2, 0, 0, 0, 0, 0, 0] }),
  ]
  const buf = vm.runInContext(`Buffer.from(impXlsxFromSheets(dashChExportSheets(${JSON.stringify(rows)})))`, sb)
  // 手工解 stored zip
  const entries = {}
  {
    let p = 0
    while (p + 4 <= buf.length) {
      const sig = buf.readUInt32LE(p)
      if (sig === 0x06054b50 || sig === 0x02014b50) break
      if (sig !== 0x04034b50) throw new Error('bad local header @' + p)
      const method = buf.readUInt16LE(p + 8)
      const csize = buf.readUInt32LE(p + 18), nlen = buf.readUInt16LE(p + 26), elen = buf.readUInt16LE(p + 28)
      const name = buf.slice(p + 30, p + 30 + nlen).toString('utf8')
      if (method !== 0) throw new Error('unexpected compression method ' + method)
      entries[name] = buf.slice(p + 30 + nlen + elen, p + 30 + nlen + elen + csize).toString('utf8')
      p += 30 + nlen + elen + csize
    }
  }
  assert('PK 头 + EOCD 尾', buf.readUInt32LE(0) === 0x04034b50 && buf.readUInt32LE(buf.length - 22) === 0x06054b50)
  assert('7 个条目（老 6 个 + 新增 xl/styles.xml）',
    Object.keys(entries).length === 7 && !!entries['xl/styles.xml'], Object.keys(entries).join(','))
  const sh = entries['xl/worksheets/sheet1.xml']
  const st = entries['xl/styles.xml']
  assert('Content_Types 声明 styles', entries['[Content_Types].xml'].includes('/xl/styles.xml'))
  assert('workbook rels 指向 styles.xml', entries['xl/_rels/workbook.xml.rels'].includes('Target="styles.xml"'))
  assert('cols 出现在 sheetData 之前', sh.indexOf('<cols>') >= 0 && sh.indexOf('<cols>') < sh.indexOf('<sheetData>'))
  assert('mergeCells 出现在 sheetData 之后', sh.indexOf('<mergeCells') > sh.indexOf('</sheetData>'))
  assert('三段横幅的整行合并都在', (sh.match(/<mergeCell ref="A\d+:O\d+"\/>/g) || []).length === 3)
  assert('部门列纵向合并存在（完全有效组 2 人同部门）', /<mergeCell ref="A\d+:A\d+"\/>/.test(sh), sh.match(/<mergeCell[^>]*>/g))
  assert('Average 标签三列合并存在', /<mergeCell ref="A\d+:C\d+"\/>/.test(sh))
  assert('公式写入（提分 = 后测−前测，带缓存值）', /<f>G\d+-F\d+<\/f><v>-?\d+(\.\d+)?<\/v>/.test(sh))
  assert('AVERAGE 汇总公式写入', /<f>AVERAGE\(F\d+:F\d+\)<\/f>/.test(sh))
  assert('styles.xml 含灰底 #747373 solid 填充', st.includes('patternType="solid"') && st.includes('FF747373'))
  assert('styles.xml 含红字（手动补录用）', st.includes('FFFF0000'))
  assert('styles.xml 含自定义数字格式 0.0 / 内置 0% / 0.00',
    st.includes('formatCode="0.0"') && /numFmtId="9"/.test(st) && /numFmtId="2"/.test(st))
  assert('styles.xml 含 medium 边框（外框加粗）', st.includes('style="medium"'))
  assert('默认字体未被重复注册（fonts 数量受控）',
    Number(/<fonts count="(\d+)"/.exec(st)[1]) <= 3, /<fonts count="(\d+)"/.exec(st)[0])
  {
    const declared = Number(/<mergeCells count="(\d+)"/.exec(sh)[1])
    const actual = (sh.match(/<mergeCell ref=/g) || []).length
    assert('mergeCells 的 count 与实际条目数一致', declared === actual && actual >= 4, declared + ' vs ' + actual)
  }
  assert('row 标签配平', (sh.match(/<row /g) || []).length === (sh.match(/<\/row>/g) || []).length)
  assert('积分榜 sheet 仍是双列结构（未被富版式影响）',
    entries['xl/worksheets/sheet2.xml'].includes('排名') && entries['xl/worksheets/sheet2.xml'].includes('用时(秒)'))
  // 旧路径字节级兼容：无样式时不得出现 s 属性
  assert('★ 老路径兼容：xlsxSheetXml 对纯数组仍输出无样式单元格',
    vm.runInContext(`xlsxSheetXml([[1, 'a']]).includes('<c r="A1"><v>1</v></c>')`, sb))
}

// ---------- ⑦ 网页看板渲染 ----------
console.log('\n[7] 网页看板渲染')
{
  const sb = makeDashSandbox()
  const chy = []
  const push = (day, si, kind, correct, total) => chy.push({ day, si, kind, correct, total, at: day * 100 + si, usedSec: 60 })
  // alice：完整 7 天（Day1 测试 8/20=40、Day7 测试 18/20=90）→ 完全有效组
  push(1, 0, 'test', 8, 20); push(1, 1, 'practice', 25, 30)
  for (let d = 2; d <= 6; d++) push(d, 0, 'practice', 25, 30)
  push(7, 0, 'practice', 10, 10); push(7, 1, 'test', 18, 20)
  // bob：只做了 Day2-6 + Day7（Day1 缺席）→ 单边缺失组
  const chyB = []
  for (let d = 2; d <= 6; d++) chyB.push({ day: d, si: 0, kind: 'practice', correct: 20, total: 30, at: d * 100, usedSec: 50 })
  chyB.push({ day: 7, si: 1, kind: 'test', correct: 15, total: 20, at: 700, usedSec: 50 })
  // cathy：只答了 20 题（Day1 摸底）→ 无效/未参与组
  const chyC = [{ day: 1, si: 0, kind: 'test', correct: 18, total: 20, at: 100, usedSec: 30 }]
  const rows = [
    mkRow({ username: 'alice', name: 'Alice', dept: '标帜餐厅', role: 'student', chy, chQ: {} }),
    mkRow({ username: 'bob', name: 'Bob', dept: '迎宾前台', role: 'student', chy: chyB, chQ: {} }),
    mkRow({ username: 'cathy', name: 'Cathy', dept: '标帜餐厅', role: 'student', chy: chyC, chQ: {} }),
  ]
  vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(rows)})`, sb)
  const html = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
  assert('三段分组横幅都渲染（中文为原表双语写法）',
    html.includes('完全有效组(Fully Valid)') && html.includes('单边缺失组(Partial Missing)')
    && html.includes('无效/未参与组(Invalid/Non-participant)'))
  assert('列标题齐全（部门/姓名/用户名/答题数/正确率/前测/后测/提分/D1–D7）',
    ['部门', '姓名', '用户名', '答题数', '正确率', '前测', '后测', '提分'].every(h => html.includes('>' + h + '<'))
    && html.includes('D1') && html.includes('D7'))
  assert('部门列用 rowspan 纵向合并（同部门连续段）', /<td rowspan="\d+"/.test(html))
  assert('Average 汇总行渲染在完全有效组末尾', html.includes('Average'))
  assert('D 标记按 ✓/− 渲染（alice 全 ✓、cathy 全 −）', html.includes('>✓</span>') && html.includes('>−</span>'))
  assert('分组规则与 D 图例提示渲染', html.includes('分组规则') && html.includes('✓ = 当日参与'))
  assert('★ 操作列保留（重置成绩 / 手动补录 两个按钮都在）',
    html.includes('dashResetChUser(this') && html.includes('dashManualScoreFromBtn(this)'))
  assert('★ 导出按钮仍在', html.includes('dashChExportScores()'))
  assert('积分榜表仍在（含名次与奖品提示）', html.includes('七天挑战积分榜') && html.includes('🥇'))
  // ★ 通用守卫：t() 缺键会原样回显键名 —— 先剥掉所有属性值（onclick/id/data-* 里合法地含函数名），
  //   余下的可见文本里不该再出现任何 i18n 键名
  {
    const visible = html.replace(/="[^"]*"/g, '=""')
    assert('★ 可见文本不残留 i18n 键名（缺键会被 t() 原样回显）', !/dashCh[A-Za-z]/.test(visible),
      (visible.match(/dashCh[A-Za-z]+/g) || []).slice(0, 5).join(','))
  }
  assert('成绩明细小标题渲染', html.includes('📋 成绩明细'))
  assert('_chDashRows 已被写入（供批量补录/导出的收口）',
    Array.isArray(vm.runInContext('_chDashRows', sb)) && vm.runInContext('_chDashRows.length', sb) === 3)
  assert('管理员不参加积分榜但仍在明细表', (() => {
    const sb2 = makeDashSandbox()
    const r2 = [
      mkRow({ username: 'stu', name: 'Stu', role: 'student', chy, lbScore: 100, lbC: 10, lbT: 10 }),
      mkRow({ username: 'boss', name: 'Boss', role: 'admin', chy, lbScore: 99999, lbC: 99, lbT: 1 }),
    ]
    vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(r2)})`, sb2)
    const h = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb2)
    const rankSeg = h.slice(h.indexOf('七天挑战积分榜'), h.indexOf('成绩明细') > 0 ? h.indexOf('成绩明细') : h.length)
    return rankSeg.includes('stu') && !rankSeg.includes('boss')
  })())
}

// ---------- ⑧ 积分榜口径回归 ----------
console.log('\n[8] 积分榜口径（回归保护）')
{
  const sb = makeLogicSandbox()
  const rows = [
    mkRow({ username: 'stu1', lbScore: 300, lbT: 120, lbC: 30 }),
    mkRow({ username: 'stu2', lbScore: 300, lbT: 100, lbC: 30 }),
    mkRow({ username: 'stu3', lbScore: 300, lbT: 100, lbC: 35 }),
    mkRow({ username: 'boss', role: 'admin', lbScore: 99999, lbT: 1, lbC: 99 }),
  ]
  const r = vm.runInContext(`dashChExportSheets(${JSON.stringify(rows)})[1].rows`, sb)
  assert('积分榜 = 表头 + 3（管理员被剔除）', r.length === 4 && r.every(row => row[1] !== 'boss'))
  assert('同分用时短者在前，再比答对数（stu3 > stu2 > stu1）',
    r[1][1] === 'stu3' && r[2][1] === 'stu2' && r[3][1] === 'stu1')
  assert('排名列连续 1/2/3', r[1][0] === 1 && r[2][0] === 2 && r[3][0] === 3)
}

// ---------- ⑨ 源码接线 + 版本号 ----------
console.log('\n[9] 源码接线与版本号')
{
  assert('dashChScoreBlocks / dashChGroupKey / dashChDayMark / dashChScoreChange 均已定义',
    ['dashChScoreBlocks', 'dashChGroupKey', 'dashChDayMark', 'dashChScoreChange']
      .every(n => APP.includes('function ' + n + '(')))
  assert('看板明细表改用 detailGroups（不再有旧的 ✅/◐ 打卡单元格渲染）',
    APP.includes('${detailGroups}') && !APP.includes('function checkinCell'))
  assert('旧的三态打卡键保留但不再被渲染引用',
    read('i18n.js').includes('dashChChkFull:') && !APP.includes("t('dashChChkFull')"))
  assert('导出链路仍走 impXlsxFromSheets(dashChExportSheets(list))',
    APP.includes('impXlsxFromSheets(dashChExportSheets(list))'))
  assert('xlsx 写入器已支持合并/样式/列宽/公式',
    CA.includes('function xlsxSheetXmlRich(') && CA.includes('function xlsxStyleBook(')
    && CA.includes('function xlsxCellXml(') && CA.includes('function xlsxPxToWidth('))
  const idx = read('index.html')
  const vs = (idx.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vs))
  assert('版本号统一（唯一值 × 12 处）', vs.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' × ' + vs.length)
  assert('版本号 ≥ 139', uniq.length === 1 && uniq[0] >= 139, String(uniq[0]))
}

console.log(`\nPASS ${pass} FAIL ${fail}`)
process.exit(fail > 0 ? 1 : 0)
