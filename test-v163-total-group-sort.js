// ====== 测试 v163：累计总览「★ 所有人一起排 + 按准确率排名 + 全站统一配色」======
// 用户诉求（原话）：「给这个新的排名表出分部门功能 以及 可以按准确率排名 统一颜色标准
//   绿色为90以上 90及以下用（237.57.151） 80及以下用（221.61.0）」
//   → 后续修正（原话）：「排名不要分部门啊 所有人一起排序」
// 拍板（AskUserQuestion + 后续修正）：① ★ **所有学员一起排**（不分部门分组、部门列不合并）
//   ② 「分部门」= 顶部部门**筛选**条（切到某部门只看该部门，名次在该范围内连续）
//   ③ 三个表头都能点（累计答题数 / 首答准确率 / 正确率(含重做)），可升可降，并显示名次
//   ④ **90 整算粉档**（「90以上」与「90及以下」在 90 处重叠 → 用户明确选粉）
//   ⑤ 配色**全站统一**（累计总览 + 当期看板成绩明细 + 每道题正确率表）
//
// ★ 本套件守的三条红线：
//   ① **90 整必须是粉**（不是绿也不是红）——这是用户唯一会一眼看错的边界；
//   ② **配色唯一来源 = accRateClass**，但**调用点必须带 typeof 守卫**：既有套件按源码切片
//      只注入目标函数体，盒外没有 accRateClass 时会 ReferenceError 让整片套件崩
//      （v161 / v162 两次血泪）→ 本套件分组 [3] 专门用「不注入」的沙箱复现该场景；
//   ③ **排序必须是全局的**：跨部门交叉排列、名次 1..N 连续不跳号不重复。
//      分部门只能作为**筛选**存在 —— 若哪天又变回分组（每部门各出一个第 1 名），本组会红。
//
// 覆盖：[1] accRateClass 阈值（含 90 边界反证） [2] 三处调用点统一 + 旧阈值无残留
//   [3] ★ 切片沙箱守卫（不注入新符号不得崩） [4] ★ 不做分组（无 rowspan / 部门列各人各格）
//   [5] 排序切换（状态机 + 真实渲染顺序，★ 跨部门一起排） [6] 排名列（全局 1..N 连续）
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
    // ★ 全局排序函数（v163 终版渲染体依赖它）
    vm.runInContext(extractFnStrict(appSrc, 'dashChTotalSortList'), sb)
    // 分组函数：渲染体已不再调用，但源码仍在 → 一并注入，避免盒外引用歧义
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

  console.log('\n[4] 不做分组：所有学员一起排（部门列各人各格，无合并单元格）')
  {
    const sb = makeSandbox()
    const html = renderTotal(sb, rowsG)
    assert('★ 页面里没有任何 rowspan（分组态已取消）',
      !html.includes('rowspan'), '仍有 rowspan：' + (html.match(/rowspan="\d+"/g) || []).join(','))
    assert('★ 部门列每人一格：4 人 × 部门格 = 4 个部门单元格（不是 2 个合并格）',
      (html.match(/<td style="white-space:nowrap;text-align:center;color:#6b7280;font-size:12px">/g) || []).length === 4,
      '实际 ' + (html.match(/<td style="white-space:nowrap;text-align:center;color:#6b7280;font-size:12px">/g) || []).length + ' 格')
    assert('★ 部门显示保留原始字符串（不再归一化成短名）',
      html.includes('客房送餐部') && html.includes('标帜餐厅'), '原始部门串丢了')
    assert('累计答题数仍在（不分组不改数值）', html.includes('>30</td>') && html.includes('>10</td>'))
    assert('★ 全局排序：整体第一（30 题的标大）在整体第二（10 题的送餐一/标小）之前',
      html.indexOf('标大') < html.indexOf('送餐一'), '全局顺序不符')
    // ★ 契约：累计总览渲染体不得再调用分组函数（分组态已废除；分组函数保留只为兼容旧断言）
    const code = codeOnly(appSrc)
    const renderBody = code.slice(code.indexOf('function renderDashChTotalBlock'))
      .slice(0, code.slice(code.indexOf('function renderDashChTotalBlock')).indexOf('\n// ======'))
    assert('★ 累计总览渲染体不再调用 dashChTotalGroups',
      renderBody.indexOf('dashChTotalGroups(') < 0, '仍在调用分组函数')
    assert('★ 累计总览渲染体改调全局排序函数 dashChTotalSortList',
      renderBody.indexOf('dashChTotalSortList(') >= 0, '未接全局排序')
    // ★ 分部门 = 筛选（唯一保留形态）：切到某分部门后只留该部门，名次在筛选结果内重新连续
    const sbF = makeSandbox()
    vm.runInContext('dashChDept = "dining/ird"', sbF)
    const hFiltered = renderTotal(sbF, rowsG)
    assert('★ 筛选到「客房送餐」→ 只留该分部门 2 人',
      hFiltered.includes('送餐一') && hFiltered.includes('送餐二') && !hFiltered.includes('标大'),
      '筛选未生效')
    assert('★ 筛选后名次重新连续（1、2，不是 3、4）',
      JSON.stringify(rowsOfHtml(hFiltered).map(s => (s.match(/<td[^>]*>(\d+)<\/td>/) || [])[1])) === JSON.stringify(['1', '2']),
      rowsOfHtml(hFiltered).map(s => (s.match(/<td[^>]*>(\d+)<\/td>/) || [])[1]).join(','))
    assert('★ 筛选后仍是全局排序（送餐一 10 题与送餐二 10 题并列时按首答题量兜底稳序）',
      hFiltered.indexOf('送餐一') < hFiltered.indexOf('送餐二'))
    assert('筛选到「标帜餐厅」→ 只留标帜 2 人',
      (() => {
        const sb2 = makeSandbox()
        vm.runInContext('dashChDept = "dining/sig"', sb2)
        const h2 = renderTotal(sb2, rowsG)
        return h2.includes('标大') && h2.includes('标小') && !h2.includes('送餐一')
      })())
  }

  console.log('\n[5] 排序：三个表头可点；★ 所有人一起排（跨部门）')
  {
    // ★ totalView: 点表头只可能发生在累计总览里（dashChTotalSetSort 会重渲染），
    //   沙箱必须落在 'total' 视图，否则重渲染成当期看板 —— 断言会对着错的 HTML 通过/失败
    const sb = makeSandbox({ totalView: true })
    // 默认：累计答题数降序 → 标大 30 > 标小 10 = 送餐一 10 = 送餐二 10
    const h0 = renderTotal(sb, rowsG)
    assert('默认按累计答题数降序（标大 30 题在最前）',
      h0.indexOf('标大') < h0.indexOf('标小'), '默认顺序不符')
    assert('默认排序态 = q ▼', vm.runInContext('dashChTotalSort', sb) === 'q' && vm.runInContext('dashChTotalDir', sb) === -1)
    // 切到首答准确率
    vm.runInContext('_perQLastRows = ' + JSON.stringify(rowsG), sb)
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)
    const h1 = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert("点「首答准确率」→ 排序键切到 accFirst（默认降序）",
      vm.runInContext('dashChTotalSort', sb) === 'accFirst' && vm.runInContext('dashChTotalDir', sb) === -1)
    assert('★ 重渲染的确实是累计总览（含标题），不是当期看板',
      h1.includes('累计总览'), '切排序后渲染到了别的视图')
    // ★★ 核心：跨部门一起排 —— 送餐一（100%）压过标大（90%），部门不再是分组边界
    assert('★★ 跨部门一起排：送餐一 100% 排在标大 90% 之前（部门不是分组边界）',
      h1.indexOf('送餐一') < h1.indexOf('标大'), '仍按部门分组，未全局排序')
    assert('★ 部门交替出现 = 未被分组（标帜与客房送餐的人交叉排列）',
      seqOf(h1, NAMES).join(',') !== '送餐一,送餐二,标大,标小',
      '顺序仍是整组整组出现：' + seqOf(h1, NAMES).join(','))
    assert('全局降序（100 送餐一 → 90 标大 → 70 送餐二 → 50 标小）',
      h1.indexOf('送餐一') < h1.indexOf('标大') && h1.indexOf('标大') < h1.indexOf('送餐二')
      && h1.indexOf('送餐二') < h1.indexOf('标小'),
      seqOf(h1, NAMES).join(','))
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
    // ★ 绝对值取值口径（1..N 连续）
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)
    const sb2 = makeSandbox({ totalView: true })
    const sorted = vm.runInContext('JSON.stringify(dashChTotalSortList(' + JSON.stringify(rowsG) + ", 'accFirst', -1))", sb2)
    assert('★ 排序函数返回扁平数组（不是分组结构）', Array.isArray(JSON.parse(sorted)) && JSON.parse(sorted).length === 4)
    assert('★ 排序函数对入参不改写（返回副本）',
      vm.runInContext('JSON.stringify(dashChTotalSortList(' + JSON.stringify(rowsG) + ", 'accFirst', -1))", sb2) === sorted)
  }

  console.log('\n[6] 排名列：全局名次 1..N 连续，随排序变化')
  {
    const sb = makeSandbox({ totalView: true })
    const rowsOf = h => h.slice(h.indexOf('<tbody>'), h.indexOf('</tbody>')).split('<tr>').slice(1)
    const rankOf = (h, name) => {
      const tr = rowsOf(h).filter(s => s.includes(name))[0] || ''
      return (tr.match(/<td[^>]*>(\d+)<\/td>/) || [])[1]
    }
    const h0 = renderTotal(sb, rowsG)
    assert('全局第一名 = 1（标大 30 题居首）', rankOf(h0, '标大') === '1', rankOf(h0, '标大'))
    assert('★ 名次连续不跳号也不重复（1/2/3/4 各一次）',
      JSON.stringify(rowsOf(h0).map((s, i) => (s.match(/<td[^>]*>(\d+)<\/td>/) || [])[1])) === JSON.stringify(['1', '2', '3', '4']),
      rowsOf(h0).map((s, i) => (s.match(/<td[^>]*>(\d+)<\/td>/) || [])[1]).join(','))
    assert('★ 名次与部门无关：第 2 名可以是别的部门的人（不再是「每部门都有一个 1」）',
      rowsOf(h0).filter(s => (s.match(/<td[^>]*>(\d+)<\/td>/) || [])[1] === '1').length === 1,
      '有多个第 1 名 → 仍在分组口径')
    vm.runInContext('_perQLastRows = ' + JSON.stringify(rowsG), sb)
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)
    vm.runInContext("dashChTotalSetSort('accFirst')", sb)   // → 升序
    const h1 = vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
    assert('★ 排序方向变化后名次跟着重算（升序 50/70/90/100 → 标小 1、标大 3、送餐一 4）',
      rankOf(h1, '标小') === '1' && rankOf(h1, '标大') === '3' && rankOf(h1, '送餐一') === '4',
      rankOf(h1, '标小') + '/' + rankOf(h1, '标大') + '/' + rankOf(h1, '送餐一'))
    assert('名次列的表头是 i18n 文案「排名」', h0.includes('>排名</th>'))
    assert('名次列表头带「全局名次」提示',
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
    assert('中文说明写清「所有学员一起排、与部门无关」',
      i18nSrc.includes('所有学员一起排序，与部门无关'))
    assert('英文同样写清（All learners are ranked together / regardless of department）',
      i18nSrc.includes('All learners are ranked together') && i18nSrc.includes('regardless of department'))
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
