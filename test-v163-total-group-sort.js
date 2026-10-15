// ====== 测试 v163：累计总览「分部门分组 + 按准确率排名 + 全站统一配色」======
// 用户诉求（原话）：「给这个新的排名表出分部门功能 以及 可以按准确率排名 统一颜色标准
//   绿色为90以上 90及以下用（237.57.151） 80及以下用（221.61.0）」
// 拍板（AskUserQuestion）：① 按分部门分组显示（部门列合并单元格，与当期看板一致）
//   ② 三个表头都能点（累计答题数 / 首答准确率 / 正确率(含重做)），可升可降，并显示名次
//   ③ **90 整算粉档**（「90以上」与「90及以下」在 90 处重叠 → 用户明确选粉）
//   ④ 配色**全站统一**（累计总览 + 当期看板成绩明细 + 每道题正确率表）
//
// ★ 本套件守的三条红线：
//   ① **90 整必须是粉**（不是绿也不是红）——这是用户唯一会一眼看错的边界；
//   ② **配色唯一来源 = accRateClass**，但**调用点必须带 typeof 守卫**：既有套件按源码切片
//      只注入目标函数体，盒外没有 accRateClass 时会 ReferenceError 让整片套件崩
//      （v161 / v162 两次血泪）→ 本套件分组 [3] 专门用「不注入」的沙箱复现该场景；
//   ③ **分组与排序必须同时成立**：组内按当前键排序、组间按组内第一名排序，
//      名次是**组内**名次（否则 rowspan 分组与全局排名会互相打架）。
//
// 覆盖：[1] accRateClass 阈值（含 90 边界反证） [2] 三处调用点统一 + 旧阈值无残留
//   [3] ★ 切片沙箱守卫（不注入新符号不得崩） [4] 分部门分组（含「客房送餐部」归一化合并）
//   [5] 排序切换（状态机 + 真实渲染顺序，含组间按组内第一名） [6] 排名列（组内名次）
//   [7] 表头可点 + 配色图例 [8] i18n 新键中英成对 [9] 版本契约
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
// ★ 精确版：indexOf('function normDept') 会命中更早的 `function normDeptSub(`（v162 实撞）
function extractFnStrict(src, name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('fn not found (strict): ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
// 只保留代码、剥掉注释行 —— 计数断言必须走这个，否则注释里写过的字面量会一起被数进去（v162 实撞）
function codeOnly(src) {
  return src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
}

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const caSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const CSS_SRC = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8')
const HTML_SRC = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

// 沙箱：withNew=false 时不注入 v162/v163 的新符号 ——
//   精确模拟「既有套件按源码切片注入目标函数」的真实环境，用来验证 typeof 守卫真的兜住了
// 沙箱开关（精确模拟各种「切片注入」的真实环境）：
//   v162=false → 连 v162 的函数都不注入（最早期那批切片套件）
//   v163=false → 只有 v162、没有 v163 新符号（v162 的调用点是否被守卫兜住）
//   acc=false  → 只缺 accRateClass（配色被三处调用，最危险的一种）
//   totalView  → dashChView 直接置 'total'（点表头时用户必然在累计总览里，这是真实前提）
function makeSandbox(o) {
  const cfg = { v162: true, v163: true, acc: true, totalView: false }
  if (o === false) { cfg.v162 = false; cfg.v163 = false; cfg.acc = false }
  else if (o && typeof o === 'object') Object.assign(cfg, o)
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console, window: {},
    document: { addEventListener() {}, getElementById() { return null } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm() { return true },
    addEventListener() {}, removeEventListener() {},
  }
  sb.window = sb
  sb.window.__els = {}
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
  vm.runInContext(extractFn(appSrc, 'escHtml'), sb)
  vm.runInContext(extractFn(appSrc, 'escAttr'), sb)
  vm.runInContext(extractFn(appSrc, 'dashChStageWeight'), sb)
  vm.runInContext(appSrc.slice(appSrc.indexOf('// ====== v139：三段分组口径'),
    appSrc.indexOf('function dashChExportSheets(list) {')), sb)
  vm.runInContext(extractFn(appSrc, 'renderDashChallengeBlock'), sb)
  vm.runInContext(extractFn(appSrc, 'dashChExportHeader'), sb)
  vm.runInContext(extractFn(appSrc, 'dashChExportSheets'), sb)
  vm.runInContext(extractFn(caSrc, 'xlsxColRef'), sb)
  vm.runInContext('let dashRoundView = \'\'', sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundList'), sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundCurId'), sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundSlug'), sb)
  vm.runInContext('let dashChDept = "all"', sb)
  vm.runInContext(extractFnStrict(appSrc, 'normDept'), sb)
  vm.runInContext(extractFn(appSrc, 'normDeptSub'), sb)
  vm.runInContext(extractFn(appSrc, '_deptSubIndex'), sb)
  vm.runInContext(extractFn(appSrc, 'deptTree'), sb)
  vm.runInContext('const DEPT_MAJOR_KEYS = ["dining", "rooms", "other"]', sb)
  vm.runInContext('const DEPT_CANON = { dining: ["标帜餐厅", "艳中餐厅", "酒吧团队", "客房送餐"], rooms: ["迎宾前台", "礼宾部", "随时随需", "客房造型", "健身及水疗中心"] }', sb)
  vm.runInContext('const DEPT_SUB_SLUGS = { dining: { "标帜餐厅": "sig", "艳中餐厅": "yan", "酒吧团队": "bar", "客房送餐": "ird" }, rooms: { "迎宾前台": "fo", "礼宾部": "concierge", "随时随需": "ww", "客房造型": "styling", "健身及水疗中心": "spa" } }', sb)
  vm.runInContext('const DEPT_SUB_BY_SLUG = (() => { const o = {}; Object.keys(DEPT_SUB_SLUGS).forEach(mk => Object.keys(DEPT_SUB_SLUGS[mk]).forEach(s => { o[mk + "/" + DEPT_SUB_SLUGS[mk][s]] = s })); return o })()', sb)
  vm.runInContext(extractFn(appSrc, 'deptSlug'), sb)
  vm.runInContext(extractFn(appSrc, 'deptSlugName'), sb)
  vm.runInContext(extractFn(appSrc, 'deptGroupKey'), sb)
  vm.runInContext('const TYPE_LABELS = new Proxy({}, { get: (_, k) => k })', sb)
  vm.runInContext('Store.init()', sb)
  // v162 符号（最早期那批切片套件连这些也没有）
  if (cfg.v162) {
    vm.runInContext(extractFn(appSrc, 'dashChTotalRows'), sb)
    vm.runInContext(extractFn(appSrc, 'renderDashChTotalBlock'), sb)
    vm.runInContext(extractFn(appSrc, 'dashChViewBarHtml'), sb)
    vm.runInContext(extractFn(appSrc, 'dashChSetView'), sb)
  }
  // dashChView 始终给（视图分派必需）；totalView=true 模拟「用户正停在累计总览」点表头
  vm.runInContext('let dashChView = "' + (cfg.totalView ? 'total' : 'round') + '"', sb)
  if (cfg.acc) vm.runInContext(extractFnStrict(appSrc, 'accRateClass'), sb)
  if (cfg.v163) {
    vm.runInContext(extractFnStrict(appSrc, 'dashChTotalGroups'), sb)
    vm.runInContext(extractFnStrict(appSrc, 'dashChTotalSetSort'), sb)
    vm.runInContext('let dashChTotalSort = "q"', sb)
    vm.runInContext('let dashChTotalDir = -1', sb)
    vm.runInContext('let _perQLastRows = []', sb)
  }
  return sb
}
function setupEls(sb) {
  vm.runInContext('document.getElementById = (id) => (window.__els[id] = window.__els[id] || { id, innerHTML: "", style: {} })', sb)
}
function renderTotal(sb, rows) {
  setupEls(sb)
  vm.runInContext(`renderDashChTotalBlock(${JSON.stringify(rows)})`, sb)
  return vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
}
// 从渲染结果里按文档顺序取出命中的姓名（顺序断言专用）
function seqOf(html, names) {
  return names.filter(n => html.indexOf(n) >= 0)
    .sort((a, b) => html.indexOf(a) - html.indexOf(b))
}
// 取出表体里的每一行（用于数单元格 / 定位名次）
function rowsOfHtml(html) {
  const tb = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'))
  return tb.split('<tr>').slice(1)
}

// ---- 数据：两个分部门 + 「客房送餐部」带「部」的写法（归一化合并的反证对象）----
// 标帜餐厅：标大 30 题 / 首答 90%；标小 10 题 / 首答 50%
// 客房送餐：送餐一 10 题 / 首答 100%（写「客房送餐部」）；送餐二 10 题 / 首答 70%（写「客房送餐」）
const rowsG = [
  { username: 'sigS', name: '标小', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 5, total: 10, at: 1, rd: 'r1' }] },
  { username: 'sigB', name: '标大', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 9, total: 10, at: 1, rd: 'r1' }, { day: 2, si: 0, kind: 'practice', correct: 18, total: 20, at: 2, rd: 'r1' }] },
  { username: 'ird1', name: '送餐一', role: 'student', dept: '客房送餐部', chy: [{ day: 1, si: 0, kind: 'practice', correct: 10, total: 10, at: 1, rd: 'r1' }] },
  { username: 'ird2', name: '送餐二', role: 'student', dept: '客房送餐', chy: [{ day: 1, si: 0, kind: 'practice', correct: 4, total: 5, at: 1, rd: 'r1' }, { day: 2, si: 0, kind: 'practice', correct: 3, total: 5, at: 2, rd: 'r1' }] },
]
const NAMES = ['标大', '标小', '送餐一', '送餐二']

;(async () => {
  console.log('\n🧪 v163 累计总览：分部门分组 + 准确率排名 + 全站统一配色')

  console.log('\n[1] accRateClass：唯一配色口径（90 整必须算粉）')
  {
    const sb = makeSandbox()
    const cls = v => vm.runInContext(`accRateClass(${JSON.stringify(v)})`, sb)
    assert('>90 → 绿 perq-good（91 与 100 都是绿）', cls(91) === 'perq-good' && cls(100) === 'perq-good')
    assert('★ 90 整 → 粉 perq-high（不是绿）', cls(90) === 'perq-high', cls(90))
    assert('81 → 粉 perq-high（粉档下界）', cls(81) === 'perq-high')
    assert('★ 80 整 → 红 perq-low（80 及以下用红）', cls(80) === 'perq-low', cls(80))
    assert('70 / 0 → 红 perq-low', cls(70) === 'perq-low' && cls(0) === 'perq-low')
    assert('★ 边界反证：90 与 91 必须不同档（重叠歧义已按用户选择消解）', cls(90) !== cls(91))
    assert('★ 边界反证：80 与 81 必须不同档', cls(80) !== cls(81))
    assert('非法值 / 无数据（null、undefined、字符串）→ 最低档，不抛错',
      cls(null) === 'perq-low' && cls(undefined) === 'perq-low' && cls('abc') === 'perq-low')
    assert('数字字符串能正常分档（"85" → 粉）', cls('85') === 'perq-high', cls('85'))
  }

  console.log('\n[2] 全站三处调用点统一走 accRateClass（旧阈值不得残留）')
  {
    const code = codeOnly(appSrc)
    assert('旧口径「≥80 绿 / ≥60 蓝 / 其余红」已无残留（当期看板）',
      !code.includes("p.acc >= 80 ? 'perq-good' : p.acc >= 60"))
    assert('旧口径「≥80 / ≥60 / ≥40 / 其余」已无残留（每道题正确率表）',
      !code.includes("r.rate >= 80 ? 'perq-good' : r.rate >= 60"))
    const nGuarded = (code.match(/typeof accRateClass === 'function'/g) || []).length
    assert('★ 三处调用点都带 typeof 守卫（当期看板 / 累计总览 / 每道题正确率表）',
      nGuarded === 3, '实际 ' + nGuarded + ' 处')
    assert('累计总览的准确率徽章走统一档位函数',
      code.includes('perq-rate ${accCls(v)}') && code.includes('accCls = v =>'))
    assert('当期看板成绩明细的准确率徽章走统一档位函数',
      code.includes('perq-rate ${(typeof accRateClass === \'function\') ? accRateClass(p.acc)'))
    assert('每道题正确率表走统一档位函数',
      code.includes('trClass = r => (typeof accRateClass === \'function\')'))
    assert('style.css 定义了两档新配色', CSS_SRC.includes('.perq-rate.perq-high') && CSS_SRC.includes('.perq-rate.perq-low'))
    assert('★ 颜色值与用户给的一致：粉 = rgb(237,57,151)，红 = rgb(221,61,0)',
      CSS_SRC.includes('color:rgb(237,57,151)') && CSS_SRC.includes('color:rgb(221,61,0)'),
      '颜色值不符')
    assert('绿色档位沿用既有 perq-good（不新造第四种绿）',
      /\.perq-rate\.perq-good \{ background:#d1fae5; color:#047857; \}/.test(CSS_SRC))
  }

  console.log('\n[3] ★ 切片沙箱守卫：不注入 v163 新符号也不得崩（v161/v162 两次血泪）')
  {
    // ① 只缺 accRateClass（最危险：配色被三处调用）
    const sbNoAcc = makeSandbox({ acc: false })
    assert('确认沙箱里真的没有 accRateClass', vm.runInContext('typeof accRateClass', sbNoAcc) === 'undefined')
    let threw = null
    let html = ''
    try { html = renderTotal(sbNoAcc, rowsG) } catch (e) { threw = e }
    assert('★ 无 accRateClass 时 renderDashChTotalBlock 不抛错', !threw, threw && threw.message)
    assert('★ 且仍有徽章渲染（走内联同口径兜底），不是空白',
      !threw && html.includes('class="perq-rate')) 
    assert('★ 兜底口径与正式口径一致：90% → perq-high、100% → perq-good、50% → perq-low',
      !threw && html.includes('perq-rate perq-high">90%') && html.includes('perq-rate perq-good">100%') && html.includes('perq-rate perq-low">50%'),
      '兜底档位与 accRateClass 不一致')
    // ② 只有 v162、没有任何 v163 新符号（模拟 v162 时代那批切片套件）
    const sbOld = makeSandbox({ v163: false, acc: false })
    assert('确认沙箱里没有 v163 新符号（accRateClass / dashChTotalGroups）',
      vm.runInContext('typeof accRateClass', sbOld) === 'undefined' &&
      vm.runInContext('typeof dashChTotalGroups', sbOld) === 'undefined')
    let threw2 = null
    let html2 = ''
    try { html2 = renderTotal(sbOld, rowsG) } catch (e) { threw2 = e }
    assert('★ 无任何 v163 新符号时仍不抛错（v162 套件兼容）', !threw2, threw2 && threw2.message)
    assert('★ 此时按「单组」兜底渲染，行数不丢（4 人全在）',
      !threw2 && NAMES.every(n => html2.includes(n)), '有人被兜底路径吞掉')
    // ③ 连 v162 符号也没有（最早期那批套件）
    const sbLegacy = makeSandbox(false)
    let threw3 = null
    try { setupEls(sbLegacy); vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(rowsG)})`, sbLegacy) } catch (e) { threw3 = e }
    assert('★ 当期看板渲染在无任何新符号时不抛错', !threw3, threw3 && threw3.message)
  }

  console.log('\n[4] 分部门分组（部门列合并单元格；「客房送餐部」与「客房送餐」必须同组）')
  {
    const sb = makeSandbox()
    const html = renderTotal(sb, rowsG)
    assert('两组各 2 人 → 恰好两个 rowspan="2"', (html.match(/rowspan="2"/g) || []).length === 2,
      '实际 ' + (html.match(/rowspan="2"/g) || []).length + ' 个')
    assert('★ 组标签用归一化短名（显示「客房送餐」，不带「部」）',
      html.includes('>客房送餐</td>') && !html.includes('客房送餐部'))
    assert('标帜餐厅组也成组显示', html.includes('>标帜餐厅</td>'))
    assert('★ 反证：若不做归一化，`客房送餐部` 会另起一组（rowspan=1 + 原始串） —— 现无此现象',
      !html.includes('rowspan="1"'))
    assert('组内成员相邻（同组 2 人之间不夹其他部门的人）',
      seqOf(html, NAMES).join(',') !== '' && Math.abs(html.indexOf('标大') - html.indexOf('标小')) < Math.abs(html.indexOf('标大') - html.indexOf('送餐一')),
      '分组被拆散')
    assert('累计答题数仍在（分组不改数值）', html.includes('>30</td>') && html.includes('>10</td>'))
  }

  console.log('\n[5] 排序：三个表头可点；组内按当前键、组间按组内第一名')
  {
    // ★ totalView: 点表头只可能发生在累计总览里（dashChTotalSetSort 会重渲染），
    //   沙箱必须落在 'total' 视图，否则重渲染成当期看板 —— 断言会对着错的 HTML 通过/失败
    const sb = makeSandbox({ totalView: true })
    // 默认：累计答题数降序
    const h0 = renderTotal(sb, rowsG)
    assert('默认按累计答题数降序（组内：标大 30 题在 标小 10 题之前）',
      h0.indexOf('标大') < h0.indexOf('标小'), '默认顺序不符')
    assert('默认组间：标帜组（组内第一 30 题）在客房送餐组（10 题）之前',
      h0.indexOf('>标帜餐厅</td>') < h0.indexOf('>客房送餐</td>'),
      '注意：部门筛选条里也有部门名，必须用 `>名</td>` 定位分组单元格')
    assert('默认排序态 = q ▼', vm.runInContext('dashChTotalSort', sb) === 'q' && vm.runInContext('dashChTotalDir', sb) === -1)
    // 切到首答准确率
    vm.runInContext('_perQLastRows = ' + JSON.stringify(rowsG), sb)
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)
    const h1 = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert("点「首答准确率」→ 排序键切到 accFirst（默认降序）",
      vm.runInContext('dashChTotalSort', sb) === 'accFirst' && vm.runInContext('dashChTotalDir', sb) === -1)
    assert('★ 重渲染的确实是累计总览（含标题），不是当期看板',
      h1.includes('累计总览'), '切排序后渲染到了别的视图')
    assert('★ 组间按组内第一名重排：客房送餐（首名 100%）现在排在标帜（90%）之前',
      h1.indexOf('>客房送餐</td>') < h1.indexOf('>标帜餐厅</td>'), '组间未按组内第一名排')
    assert('组内按首答降序（送餐一 100% 在送餐二 70% 之前）', h1.indexOf('送餐一') < h1.indexOf('送餐二'))
    assert('组内按首答降序（标大 90% 在标小 50% 之前）', h1.indexOf('标大') < h1.indexOf('标小'))
    // 再点一次 → 升序
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)
    const h2 = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert('再点同一表头 → 方向取反为升序', vm.runInContext('dashChTotalDir', sb) === 1)
    assert('★ 升序：标小 50% 升到 标大 90% 之前', h2.indexOf('标小') < h2.indexOf('标大'), '升序未生效')
    assert('升序时表头箭头变 ▲', h2.includes('首答准确率 ▲'))
    // 换键 → 回到该键默认降序
    vm.runInContext("dashChTotalSetSort('accAll')", sb)
    assert("换到「正确率(含重做)」→ 键=accAll 且方向回到降序",
      vm.runInContext('dashChTotalSort', sb) === 'accAll' && vm.runInContext('dashChTotalDir', sb) === -1)
    vm.runInContext("dashChTotalSetSort('乱码')", sb)
    assert('白名单：非法键一律回落 q（不会被脏值卡死）',
      vm.runInContext('dashChTotalSort', sb) === 'q' && vm.runInContext('dashChTotalDir', sb) === -1)
  }

  console.log('\n[6] 排名列：组内名次，随排序变化')
  {
    const sb = makeSandbox({ totalView: true })
    const rowsOf = h => h.slice(h.indexOf('<tbody>'), h.indexOf('</tbody>')).split('<tr>').slice(1)
    const rankOf = (h, name) => {
      const tr = rowsOf(h).filter(s => s.includes(name))[0] || ''
      return (tr.match(/<td[^>]*>(\d+)<\/td>/) || [])[1]
    }
    const h0 = renderTotal(sb, rowsG)
    assert('组内第一名 = 1（标大 30 题居首 → 1；标小 → 2）', rankOf(h0, '标大') === '1' && rankOf(h0, '标小') === '2',
      rankOf(h0, '标大') + '/' + rankOf(h0, '标小'))
    assert('另一个组也是组内名次（送餐一 1 / 送餐二 2）',
      rankOf(h0, '送餐一') === '1' && rankOf(h0, '送餐二') === '2')
    vm.runInContext('_perQLastRows = ' + JSON.stringify(rowsG), sb)
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)   // → 升序
    const h1 = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert('★ 排序方向变化后名次跟着重算（升序下 标小 50% 变组内第 1）',
      rankOf(h1, '标小') === '1' && rankOf(h1, '标大') === '2',
      rankOf(h1, '标小') + '/' + rankOf(h1, '标大'))
    assert('名次列的表头是 i18n 文案「排名」', h0.includes('>排名</th>'))
    assert('名次列表头带「组内名次」提示',
      appSrc.includes("escAttr(t('dashChTotalRankHint'))"), '排名列 title 未接 i18n')
  }

  console.log('\n[7] 表头可点 + 配色图例')
  {
    const sb = makeSandbox()
    const h = renderTotal(sb, rowsG)
    assert('三个数值表头都带 onclick 切换（累计答题数 / 首答准确率 / 正确率(含重做)）',
      h.includes(`onclick="dashChTotalSetSort('q')"`) &&
      h.includes(`onclick="dashChTotalSetSort('accFirst')"`) &&
      h.includes(`onclick="dashChTotalSetSort('accAll')"`))
    assert('当前排序列显示方向箭头（默认 q ▼；其余列不显示箭头）',
      h.includes('累计答题数 ▼') && !h.includes('首答准确率 ▼'), '箭头渲染不符')
    assert('★ 图例三档与真实档位同源（>90% 绿 / 81–90% 粉 / ≤80% 红）',
      h.includes('perq-good">&gt;90%') && h.includes('perq-high">81–90%') && h.includes('perq-low">≤80%'))
    assert('图例在表格之前（先说明后数据）', h.indexOf('perq-good">&gt;90%') < h.indexOf('<tbody>'))
    assert('非数值列（部门/姓名/账号/营次/阶段）不可点排序',
      !h.includes(`onclick="dashChTotalSetSort('dept')"`) && !h.includes(`onclick="dashChTotalSetSort('name')"`))
    assert('表头 9 列（新增排名列）', (h.match(/<\/th>/g) || []).length === 9, '实际 ' + (h.match(/<\/th>/g) || []).length + ' 列')
    assert('每行 9 个单元格（排名 + 部门 + 姓名 + 账号 + 营次 + 题数 + 两准确率 + 阶段）',
      (rowsOfHtml(h)[0].match(/<\/td>/g) || []).length === 9,
      '实际 ' + (rowsOfHtml(h)[0].match(/<\/td>/g) || []).length + ' 个')
  }

  console.log('\n[8] i18n 新键中英成对')
  {
    const keys = ['dashChTotalThRank', 'dashChTotalRankHint', 'dashChTotalSortHint', 'dashChTotalColorHint']
    let ok = true, bad = []
    keys.forEach(k => {
      const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
      if (n !== 2) { ok = false; bad.push(k + '=' + n) }
    })
    assert('4 个新键在中英各出现一次（成对）', ok, bad.join(','))
    assert('中文说明写清「组内名次 + 组间按组内第一名」',
      i18nSrc.includes('名次是组内名次，组间按各组第一名排'))
    assert('英文同样写清（rank within the group / ordered by their top member）',
      i18nSrc.includes('rank is within the group') && i18nSrc.includes('groups are ordered by their top member'))
    assert('配色说明键只说「全站统一」，不写死具体色值（避免与 CSS 双份真相）',
      !/#|rgb|绿|粉/.test((i18nSrc.match(/dashChTotalColorHint: '([^']*)'/) || [])[1] || ''), '文案里写死了颜色')
  }

  console.log('\n[9] 版本契约')
  {
    const vers = (HTML_SRC.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = [...new Set(vers)]
    assert('index.html 资源版本号恰好 12 处且唯一', vers.length === 12 && uniq.length === 1, `出现 ${vers.length} 处，唯一值 ${uniq.join(',')}`)
    assert('★ 版本号 ≥ 163（弹性判据，绝不写死等值）', uniq.every(v => v >= 163), String(uniq[0]))
    assert('无更早版本号残留', vers.every(v => v >= 163))
  }

  console.log('\n' + (testFailed ? '❌ FAILED' : '✅ ALL PASS'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
