// ====== 测试 v162：七天挑战「累计总览」（跨全部营次的累计答题数与准确率）======
// 用户诉求（原话）：「鉴于之后每个部门的七天挑战会越来越多，能否在管理员后台增加一个页面，
//   看到他所有挑战的累计答题数和准确率」→ 拍板：按学员一行 / 两个准确率并列 / 放在挑战标签内。
//
// ★ 本套件的核心不是「加了个页面」，而是**跨营次的阶段去重必须带营次键**：
//   首答准确率沿用 v160 的口径（各阶段首次完成），而「阶段」在跨营次语境下是
//   （营次, 天, 阶段序号）三元组 —— 若只按 (天, 阶段序号) 去重，第 2 期的同一天同一阶段
//   会被当成第 1 期那一条，累计值「越练越少」且阶段数偏小。
// 覆盖：① 跨期累计口径（手算） ② ★★ 反证：去重键必须带营次
//   ③ 护栏（cleared 存根 / 缺 total / correct>total 钳制） ④ 部门筛选
//   ⑤ 渲染（汇总卡 + 两列准确率 + 空态） ⑥ 视图切换与营次面板收起
//   ⑦ ★ 切片沙箱回归守卫（既有套件按源码切片注入，不得被新变量打死）
//   ⑧ i18n 中英 ⑨ 版本契约
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
// ★ 精确版：indexOf('function normDept') 会命中**更早**的 `function normDeptSub(` ——
//   于是「注入 normDept」实际注入的是 normDeptSub，`typeof normDept` 仍是 undefined，
//   部门筛选静默失效（本套件第一版就踩了这个坑，两侧各自注入才发现）。凡有同名前缀的函数一律用这个。
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

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const caSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const HTML_SRC = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

// 沙箱（同 test-v160 的看板沙箱；withV162=false 时不注入 v162 的四个新符号，
//   模拟「既有套件按源码切片注入」的真实环境 —— 用来验证守卫真的兜住了）
function makeSandbox(withV162) {
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
  vm.runInContext(extractFn(caSrc, 'xlsxColRef'), sb)   // 列号换算在 course-app.js
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
  if (withV162 !== false) {
    vm.runInContext(extractFn(appSrc, 'dashChTotalRows'), sb)
    vm.runInContext(extractFn(appSrc, 'renderDashChTotalBlock'), sb)
    vm.runInContext(extractFn(appSrc, 'dashChViewBarHtml'), sb)
    vm.runInContext(extractFn(appSrc, 'dashChSetView'), sb)
    vm.runInContext('let dashChView = "round"', sb)
  }
  return sb
}
// 让 getElementById 返回带 style 的桩（dashChSetView 要读营次面板的 display）
function setupEls(sb) {
  vm.runInContext('document.getElementById = (id) => (window.__els[id] = window.__els[id] || { id, innerHTML: "", style: {} })', sb)
}
function totalOf(sb, rows, sel) {
  return vm.runInContext(`dashChTotalRows(${JSON.stringify(rows)}, ${JSON.stringify(sel)})`, sb)
}
function renderTotal(sb, rows) {
  setupEls(sb)
  vm.runInContext(`renderDashChTotalBlock(${JSON.stringify(rows)})`, sb)
  return vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
}

// ---- 数据：跨两个营次 + 中途重做 ----
// q = 40、c = 28（含重做的全部作答）；首答只看每营次每阶段的首次完成：
//   第一期|2|0 → at=100 的 8/10（at=200 的重做 10/10 不计）
//   r2|2|0     → 4/10      r2|3|0 → 6/10      ⇒ fQ=30、fC=18
const rowsCross = [
  {
    username: 'jia', name: '甲', role: 'student', dept: '标帜餐厅', chy: [
      { day: 2, si: 0, kind: 'practice', correct: 8, total: 10, at: 100, rd: 'r1' },
      { day: 2, si: 0, kind: 'practice', correct: 10, total: 10, at: 200, rd: 'r1' },  // 重做 → 不进首答
      { day: 2, si: 0, kind: 'practice', correct: 4, total: 10, at: 900, rd: 'r2' },
      { day: 3, si: 0, kind: 'practice', correct: 6, total: 10, at: 950, rd: 'r2' },
    ]
  },
]

;(async () => {
  console.log('\n🧪 v162 七天挑战「累计总览」测试')

  console.log('\n[1] 跨营次累计口径（手算）')
  {
    const sb = makeSandbox()
    const a = totalOf(sb, rowsCross, 'all')[0]
    assert('累计答题数 = 40（含重做的全部作答）', a.q === 40, String(a.q))
    assert('累计答对 = 28', a.c === 28, String(a.c))
    assert('正确率(含重做) = 28/40 = 70%', a.accAll === 70, String(a.accAll))
    assert('首答准确率 = 18/30 = 60%', a.accFirst === 60, String(a.accFirst))
    assert('首答题量只算首次完成 = 30（重做的 10 题不计）', a.fQ === 30, String(a.fQ))
    assert('参与营次 = 2 期', a.rounds === 2, String(a.rounds))
    assert('参与营次明细 = 第一期 / r2', a.roundSlugs.join(',') === '第一期,r2', a.roundSlugs.join(','))
    assert('计分阶段 = 3（第一期 1 + r2 2）', a.stages === 3, String(a.stages))
    assert('★ 两个准确率口径不同（70% vs 60%），证明必须并列显示', a.accAll !== a.accFirst)
  }

  console.log('\n[2] ★★ 反证：首答去重键必须带「营次」')
  {
    const sb = makeSandbox()
    // 同一（天,阶段）在两个营次各出现一次，且成绩不同 →
    // 正确实现（键 = 营次|天|阶段）取两条 = 12/20 = 60%；
    // 错误实现（键 = 天|阶段）只取 at 最早那条（第一期 8/10）= 80%，且阶段数变 2。
    const rows = [
      {
        username: 'k', name: '键', role: 'student', dept: '标帜餐厅', chy: [
          { day: 2, si: 0, kind: 'practice', correct: 4, total: 10, at: 100, rd: 'r1' },
          { day: 2, si: 0, kind: 'practice', correct: 8, total: 10, at: 900, rd: 'r2' },
        ]
      },
    ]
    const k = totalOf(sb, rows, 'all')[0]
    assert('★ 两期同一阶段各自计入首答：12/20 = 60%（错误实现会得 40% 或 80%）',
      k.accFirst === 60 && k.fQ === 20, `accFirst=${k.accFirst} fQ=${k.fQ}`)
    assert('★ 阶段数 = 2（两期各一个），错误实现会算成 1', k.stages === 2, String(k.stages))
    assert('累计答题数仍是 20（跨期累加，不受去重影响）', k.q === 20, String(k.q))
    // 第一期为更早记录时也不能被后一期挤掉
    const rows2 = [
      {
        username: 'k2', name: '键2', role: 'student', dept: '标帜餐厅', chy: [
          { day: 5, si: 0, kind: 'practice', correct: 9, total: 10, at: 100, rd: 'r1' },
          { day: 5, si: 0, kind: 'practice', correct: 3, total: 10, at: 900, rd: 'r2' },
        ]
      },
    ]
    const k2 = totalOf(sb, rows2, 'all')[0]
    assert('两期同阶段各取当期首次：12/20 = 60%（只按天去重会得 90%）', k2.accFirst === 60, String(k2.accFirst))
  }

  console.log('\n[3] 护栏：重置存根 / 缺 total / 脏数据')
  {
    const sb = makeSandbox()
    // v84 成绩重置存根：correct/total 被清零过但字段仍在（这里刻意给非零值以验证「被跳过」）
    const rows = [
      {
        username: 're', name: '重', role: 'student', dept: '标帜餐厅', chy: [
          { day: 7, si: 1, kind: 'test', correct: 2, total: 20, at: 500, rd: 'r1', cleared: true },
          { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 800, rd: 'r1' },   // 重考
        ]
      },
    ]
    const r = totalOf(sb, rows, 'all')[0]
    assert('★ cleared 存根不进首答：18/20 = 90%（若计入会得 20/40 = 50%）', r.accFirst === 90, String(r.accFirst))
    assert('累计口径（含重做）与明细表一致，存根照旧计入：20/40 = 50%', r.accAll === 50, String(r.accAll))
    assert('阶段数 = 1（存根与被覆写的重考同为第一期|7|1）', r.stages === 1, String(r.stages))
    // 老记录缺 total（v73 之前）→ 分母 0 → 显示「-」而不是 0%（与「答了但全错」区分）
    const old = totalOf(sb, [{ username: 'old', name: '老', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 30, at: 1, rd: 'r1' }] }], 'all')[0]
    assert('缺 total → 两个准确率都是 null（渲染成「-」），不是 0%',
      old.accAll === null && old.accFirst === null && old.q === 0, JSON.stringify({ a: old.accAll, f: old.accFirst, q: old.q }))
    // correct > total 脏数据 → 钳到 100%
    const dirty = totalOf(sb, [{ username: 'dirty', name: '脏', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 30, total: 10, at: 1, rd: 'r1' }] }], 'all')[0]
    assert('correct(30) > total(10) → 钳到 100%（不出 300%）', dirty.accAll === 100 && dirty.accFirst === 100, JSON.stringify({ a: dirty.accAll, f: dirty.accFirst }))
    // 完全没有作答的人不出现
    const empty = totalOf(sb, [{ username: 'nul', name: '无', role: 'student', dept: '标帜餐厅', chy: [] }], 'all')
    assert('无任何作答记录的学员不进表（不是一行 0）', empty.length === 0, String(empty.length))
  }

  console.log('\n[4] 部门筛选（与当期看板同口径）')
  {
    const sb = makeSandbox()
    // 沙箱注入自检：防止 extractFn 前缀误命中（normDept ⊂ normDeptSub）导致部门筛选静默失效
    assert('沙箱自检：normDept 已真的注入（不是 normDeptSub）',
      vm.runInContext('typeof normDept', sb) === 'function' &&
      vm.runInContext('typeof normDept("标帜餐厅")', sb) === 'object',
      'typeof=' + vm.runInContext('typeof normDept', sb))
    const rows = [
      { username: 'sig1', name: '标', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 5, total: 10, at: 1, rd: 'r1' }] },
      { username: 'ird1', name: '送', role: 'student', dept: '客房送餐', chy: [{ day: 1, si: 0, kind: 'practice', correct: 9, total: 10, at: 1, rd: 'r1' }] },
      { username: 'none', name: '无', role: 'student', dept: '标帜餐厅', chy: [] },
    ]
    assert("'all' → 2 人（无记录者不计）", totalOf(sb, rows, 'all').length === 2)
    assert("大部门 'dining' → 2 人", totalOf(sb, rows, 'dining').length === 2)
    const sig = totalOf(sb, rows, 'dining/sig')
    assert("分部门 'dining/sig' → 只标帜 1 人", sig.length === 1 && sig[0].username === 'sig1', JSON.stringify(sig.map(x => x.username)))
    const ird = totalOf(sb, rows, 'dining/ird')
    assert("分部门 'dining/ird' → 只客房送餐 1 人", ird.length === 1 && ird[0].username === 'ird1', JSON.stringify(ird.map(x => x.username)))
    assert("房务部 'rooms' → 0 人（挑战限饮食部）", totalOf(sb, rows, 'rooms').length === 0)
  }

  console.log('\n[5] 渲染：汇总卡 + 两列准确率 + 空态')
  {
    const sb = makeSandbox()
    const html = renderTotal(sb, rowsCross)
    assert('标题含「累计总览」', html.includes('累计总览'), html.slice(0, 80))
    assert('四张汇总卡：参与学员 / 累计答题数 / 整体首答准确率 / 整体正确率(含重做)',
      html.includes('参与学员') && html.includes('累计答题数') && html.includes('整体首答准确率') && html.includes('整体正确率(含重做)'))
    assert('汇总数值 = 1 人 / 40 题 / 60% / 70%',
      html.includes('>1</div>') && html.includes('>40</div>') && html.includes('>60%</div>') && html.includes('>70%</div>'))
    assert('表头含「首答准确率」与「正确率(含重做)」两列',
      html.includes('首答准确率') && html.includes('正确率(含重做)'))
    assert('行内数值 = 累计 40 题', html.includes('<td style="text-align:center;font-weight:700">40</td>'))
    assert('「参与营次」列悬停列出期名（第一期、r2）', html.includes('title="第一期、r2"'), '未找到期名提示')
    assert('口径说明写明「跨全部营次」', html.includes('跨全部营次'))
    // 空态：★ 断言必须连「空态专属文案」一起给，只查 colspan 会假绿（v160 血泪）
    //    v163：新增「排名」列 → colspan 8 → 9（契约随需求变更，非回归）
    const emptyHtml = renderTotal(sb, [])
    assert('空态行 = colspan 9 + 空态专属文案（精确到文案，防假绿）',
      emptyHtml.includes('colspan="9" style="text-align:center;color:#9ca3af;padding:16px">还没有任何营次的挑战作答记录。'),
      '未找到空态行')
    // 排序：累计答题数降序
    const rowsSort = [
      { username: 'small', name: '小', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 5, total: 10, at: 1, rd: 'r1' }] },
      { username: 'big', name: '大', role: 'student', dept: '标帜餐厅', chy: [{ day: 1, si: 0, kind: 'practice', correct: 25, total: 30, at: 1, rd: 'r1' }] },
    ]
    const htmlSort = renderTotal(sb, rowsSort)
    assert('按累计答题数降序（大 30 题 在前，小 10 题 在后）',
      htmlSort.indexOf('大') < htmlSort.indexOf('小'), '顺序不符')
  }

  console.log('\n[6] 视图切换（含营次管理面板收起）')
  {
    const sb = makeSandbox()
    setupEls(sb)
    assert('初始视图 = round（当期看板）', vm.runInContext('dashChView', sb) === 'round')
    vm.runInContext("dashChSetView('total')", sb)
    assert("切到 total：dashChView === 'total'", vm.runInContext('dashChView', sb) === 'total')
    assert('★ 累计总览时营次管理面板收起（display:none）',
      vm.runInContext('window.__els.dashRoundsPanel.style.display', sb) === 'none')
    assert('切换后渲染的是累计总览（含标题）',
      vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb).includes('累计总览'))
    vm.runInContext("dashChSetView('round')", sb)
    assert('切回 round：营次管理面板恢复显示（display 空串）',
      vm.runInContext('window.__els.dashRoundsPanel.style.display', sb) === '')
    assert('★ 切回 round 时不抛错且回到当期看板源码路径', vm.runInContext('dashChView', sb) === 'round')
    vm.runInContext("dashChSetView('乱码')", sb)
    assert('白名单：非法值一律回落 round（不会被脏值卡死）', vm.runInContext('dashChView', sb) === 'round')
    // 切换条本身
    const bar = vm.runInContext('dashChViewBarHtml()', sb)
    assert('切换条含两个按钮与当前态高亮', bar.includes("dashChSetView('round')") && bar.includes("dashChSetView('total')") && bar.includes('btn-primary'))
    assert('切换条按钮带稳定 id（便于巡检/测试定位）',
      bar.includes('id="dashChViewBtnRound"') && bar.includes('id="dashChViewBtnTotal"'))
  }

  console.log('\n[7] ★ 切片沙箱回归守卫（既有套件按源码切片注入，不得被新变量打死）')
  {
    const sbNo = makeSandbox(false)
    assert('切片沙箱里确实没有 dashChView（模拟既有套件）',
      vm.runInContext('typeof dashChView', sbNo) === 'undefined')
    let threw = null
    try {
      setupEls(sbNo)
      vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(rowsCross)})`, sbNo)
    } catch (e) { threw = e }
    assert('★ 无 dashChView / 无 renderDashChTotalBlock 时调用 renderDashChallengeBlock 不抛错',
      !threw, threw && threw.message)
    assert('★ 且渲染的仍是当期看板（积分榜），没有误入累计总览',
      !threw && !vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sbNo).includes('累计总览'))
    // 源码级接线：守卫必须在函数体最前（早于营次筛选与任何新引用）
    assert('app.js：renderDashChallengeBlock 顶部按 typeof 守卫后分派',
      appSrc.includes("const _chView = (typeof dashChView === 'undefined') ? 'round' : dashChView") &&
      appSrc.includes("if (_chView === 'total' && typeof renderDashChTotalBlock === 'function') return renderDashChTotalBlock(rows)"))
    const iGuard = appSrc.indexOf("const _chView = (typeof dashChView")
    const iDept = appSrc.indexOf('const rdAll = dashRoundList()')
    assert('守卫位置早于营次筛选逻辑（否则会先跑一遍旧逻辑再被覆盖）', iGuard > 0 && iDept > iGuard, `guard=${iGuard} dept=${iDept}`)
    // 模板层：老套件若按源码切片渲染模板，也不能因为新函数缺失而崩
    assert('app.js：看板视图条在模板里同样带 typeof 守卫',
      appSrc.includes("${typeof dashChViewBarHtml === 'function' ? dashChViewBarHtml() : ''}"))
    assert('app.js：营次管理面板由累计总览自己收起（不动模板字面量，避免弄红 v76/v118 接线断言）',
      appSrc.includes("const rp = document.getElementById('dashRoundsPanel')\n  if (rp) rp.style.display = 'none'") &&
      appSrc.includes('<div id="dashRoundsPanel">${dashRoundsPanelHtml()}</div>'))
    assert('面板顺序契约未动：营次管理仍在挑战统计之前',
      appSrc.indexOf('${dashRoundsPanelHtml()}') < appSrc.indexOf('<div id="dashChallengeBlock"></div>'))
  }

  console.log('\n[8] i18n 中英成对')
  {
    const keys = ['dashChViewLabel', 'dashChViewRound', 'dashChViewTotal', 'dashChTotalTitle',
      'dashChTotalStatPeople', 'dashChTotalStatQ', 'dashChTotalStatFirst', 'dashChTotalStatAll',
      'dashChTotalThRounds', 'dashChTotalThQ', 'dashChTotalThFirst', 'dashChTotalThAll',
      'dashChTotalThStages', 'dashChTotalStagesHint', 'dashChTotalHint', 'dashChTotalEmpty']
    let allPaired = true, missing = []
    keys.forEach(k => {
      const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
      if (n !== 2) { allPaired = false; missing.push(k + '=' + n) }
    })
    assert('16 个新键在中英各出现一次（成对）', allPaired, missing.join(','))
    assert('中文说明区分两个口径（含「首答准确率」与「含重做」）',
      i18nSrc.includes('「首答准确率」与积分榜同口径') && i18nSrc.includes('含重做的全部作答'), '')
    assert('英文说明区分两个口径（first-try / redos）',
      i18nSrc.includes('"First-try accuracy" uses the same basis as the leaderboard') && i18nSrc.includes('accuracy (incl. redos)'), '')
    assert('中英文都不写死具体营次名（避免复用到别的期时文案失真）',
      !/第一期|艳中|标帜/.test((i18nSrc.match(/dashChTotalHint: '([^']*)'/) || [])[1] || 'x'), '文案里出现了具体营次/部门名')
  }

  console.log('\n[9] 版本契约')
  {
    const vers = (HTML_SRC.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = [...new Set(vers)]
    assert('index.html 资源版本号恰好 12 处且唯一', vers.length === 12 && uniq.length === 1, `出现 ${vers.length} 处，唯一值 ${uniq.join(',')}`)
    assert('index.html 资源版本号 ≥ 162（弹性判据，不写死等值）', uniq.every(v => v >= 162), String(uniq[0]))
    assert('index.html 无更早的版本号残留', vers.every(v => v >= 162))
  }

  console.log('\n' + (testFailed ? '❌ FAILED' : '✅ ALL PASS'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
