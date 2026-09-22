// ====== 测试 v85：内联 onclick 接线回归（管理员重置按钮修好没） ======
// 背景（v83/v84 线上事故）：重置按钮写作
//   onclick="dashResetChUser(${JSON.stringify(p.username)}, ${JSON.stringify(p.name || '')}, ${pi})"
// 属性值用双引号包裹，JSON.stringify 运行时产出的字符串自带双引号 → 渲染成
//   onclick="dashResetChUser("alice", "", 3)"
// 浏览器解析属性时在第一个 " 处截断，onclick 实际只剩 `dashResetChUser(` → 点击即 SyntaxError，
// 静默失败（线上云端文档里连 chResets 字段都没写入）。管理员反馈「点了完全没反应」。
//
// ⚠️ 这类 bug 静态扫源码抓不到（源码模板串里没有裸引号字符），必须**真正渲染出 HTML** 才能发现。
// 本测试：① 渲染真实看板挑战块 → ② 按浏览器规则解析 onclick 属性 → ③ 断言属性值完整未截断
// → ④ 把 onclick 里的代码在沙箱里真跑一遍，断言重置函数收到正确的用户名/姓名。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
function extractFn(src, name) {
  let start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  // 保留 async 前缀：dashResetChUser 是 async 函数，丢了前缀会 await 语法错误
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}
// 按浏览器规则解析属性：onclick="..." 的值到**下一个双引号**为止（这正是不转义会截断的原因）
function parseAttr(html, attr) {
  const re = new RegExp(attr + '="([^"]*)"', 'g')
  const out = []
  let m
  while ((m = re.exec(html))) out.push(m[1])
  return out
}
function bracketBalanced(s) {
  let d = 0
  for (const c of s) {
    if (c === '(') d++
    else if (c === ')') { d--; if (d < 0) return false }
  }
  return d === 0
}

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
// 两个学员：alice（纯英文）+ 张三（中文，含姓名）——用户名/姓名都可能触发引号问题
const ROWS = [
  {
    username: 'alice', name: 'Alice Wang', dept: '饮食部 · 标帜餐厅', role: 'student',
    chy: [
      { day: 1, si: 0, kind: 'test', correct: 16, total: 20, usedSec: 300, at: 1000 },
      { day: 1, si: 1, kind: 'practice', correct: 9, total: 10, usedSec: 120, at: 2000 },
      { day: 7, si: 1, kind: 'test', correct: 18, total: 20, usedSec: 400, at: 9000 },
    ],
    chQ: {},
  },
  {
    username: '张三', name: '张三丰', dept: '房务部 · 迎宾前台', role: 'student',
    chy: [{ day: 2, si: 0, kind: 'practice', correct: 20, total: 30, usedSec: 600, at: 3000 }],
    chQ: {},
  },
  {
    // 极端用例：用户名/姓名里带引号（英文姓氏 O'Brien / 昵称带双引号）
    username: 'o\'brien"x', name: 'Pat "PJ" O\'Brien', dept: '其他部门', role: 'student',
    chy: [{ day: 3, si: 0, kind: 'practice', correct: 10, total: 30, usedSec: 60, at: 4000 }],
    chQ: {},
  },
]

// ---------- 渲染真实看板挑战块（提取 app.js 里的真函数 + 注入最小依赖） ----------
function renderBoard() {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Date, Set,
    __rows: ROWS,
    __el: { innerHTML: '' },
    Store: { getQuestions: () => [] },
    TYPE_LABELS: {},
    LANG: 'zh',
    t: (k) => k,
    document: { getElementById: () => null },
  }
  sb.window = sb
  sb.document.getElementById = (id) => (id === 'dashChallengeBlock' ? sb.__el : null)
  vm.createContext(sb)
  vm.runInContext(extractFn(appSrc, 'escHtml'), sb)
  vm.runInContext(extractFn(appSrc, 'escAttr'), sb)
  vm.runInContext(extractFn(appSrc, 'dashChStageWeight'), sb)
  vm.runInContext(extractFn(appSrc, 'renderDashChallengeBlock'), sb)
  // v88：营次筛选依赖（dashRoundView/dashRoundCurId/dashRoundList）——从 app.js 提取真实实现，
  // 沙箱无云端营次 → dashRoundList 返回空数组、dashRoundCurId 兜底 'r1'，等价单期（第一期）口径
  vm.runInContext('let dashRoundView = \'\'', sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundList'), sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundCurId'), sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundSlug'), sb)
  // v89：看板挑战统计的部门筛选（dashChDept / normDept）——沙箱按「全部部门」口径，行为与 v88 一致
  vm.runInContext('let dashChDept = "all"', sb)
  vm.runInContext(extractFn(appSrc, 'normDept'), sb)
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

  vm.runInContext('renderDashChallengeBlock(__rows)', sb)
  return sb.__el.innerHTML
}

// ---------- 端到端：把 onclick 属性里的代码在浏览器语义下真跑一遍 ----------
// bind(mockEl) 复刻浏览器内联处理器「this === 该元素」的语义
function runOnclick(code, mockEl) {
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Date, Promise, Set,
    __captured: [], __alerts: [], __rendered: 0, __confirmed: 0,
    t: (k, a) => (a == null ? k : k + '|' + a),
    confirm: () => { sb.__confirmed++; return true },
    alert: (m) => sb.__alerts.push(m),
    renderDashboard: () => { sb.__rendered++ },
    document: { getElementById: () => null },
    CloudSync: {
      setChallengeReset: async (u, n) => { sb.__captured.push([u, n]); return { ok: true, at: 123 } },
    },
  }
  sb.window = sb
  sb.__el = mockEl          // bind 目标须在求值切片之前就位
  vm.createContext(sb)
  vm.runInContext(extractFn(appSrc, 'dashResetChUser'), sb)
  const fn = vm.runInContext(`(function(){ return (${code}) }).bind(__el)`, sb)
  return fn().then(() => sb)
}

;(async () => {
  console.log('\n🧪 v85 内联 onclick 接线测试（管理员重置按钮）')

  const html = renderBoard()

  // ---------- ① 属性完整性：所有 onclick 都没被截断 ----------
  console.log('\n[1] onclick 属性完整性（渲染后按浏览器规则解析）')
  const onclicks = parseAttr(html, 'onclick')
  assert('看板渲染出 onclick 按钮', onclicks.length >= 1, 'count=' + onclicks.length)
  const truncated = onclicks.filter(v => !bracketBalanced(v) || /\(\s*$/.test(v))
  assert('无被引号截断的 onclick（括号平衡且不以 ( 结尾）', truncated.length === 0, JSON.stringify(truncated))
  // 反模式守护：onclick 属性值里不应该出现裸的双引号（浏览器会在此截断）
  assert('onclick 属性值内无裸双引号', onclicks.every(v => !v.includes('"')), JSON.stringify(onclicks.filter(v => v.includes('"'))))

  // ---------- ② 重置按钮接线形态 ----------
  console.log('\n[2] 重置按钮接线（data-* 承载用户名，onclick 只传 this 与行索引）')
  const resetOnclicks = onclicks.filter(v => v.includes('dashResetChUser'))
  assert('每个学员行一个重置按钮', resetOnclicks.length === ROWS.length, JSON.stringify(resetOnclicks))
  assert('onclick 形如 dashResetChUser(this, N)',
    resetOnclicks.every((v, i) => v === `dashResetChUser(this, ${i})`), JSON.stringify(resetOnclicks))
  // 旧反模式的字样不应再出现在按钮上
  assert('按钮不再内嵌 JSON.stringify 的参数字符串',
    !resetOnclicks.some(v => v.includes('JSON') || v.includes('\\"')), '')
  // v105：每行现在有两个按钮（重置 + 补录），都带同一对 data-u/data-n
  // → 断言必须按「按钮种类」取样，不能对全表 data-u 计数（否则新按钮一加就误报）
  const btnAttrs = code => {
    const out = []
    const re = new RegExp('<button[^>]*onclick="' + code + '"[^>]*>', 'g')
    let m
    while ((m = re.exec(html))) {
      const u = /data-u="([^"]*)"/.exec(m[0])
      const n = /data-n="([^"]*)"/.exec(m[0])
      out.push({ u: u ? u[1] : null, n: n ? n[1] : null })
    }
    return out
  }
  const resetAttrs = btnAttrs('dashResetChUser\\(this, \\d+\\)')
  const manualAttrs = btnAttrs('dashManualScoreFromBtn\\(this\\)')
  const dataU = resetAttrs.map(x => x.u)
  const dataN = resetAttrs.map(x => x.n)
  assert('重置按钮每行一个（data-u 数量与学员数一致）', dataU.length === ROWS.length, JSON.stringify(dataU))
  assert('data-u 逐行对应用户名（含引号用户名被转义）',
    dataU[0] === 'alice' && dataU[1] === '张三' && dataU[2] === 'o&#39;brien&quot;x', JSON.stringify(dataU))
  assert('data-n 逐行对应姓名（双引号→&quot; 单引号→&#39;）',
    dataN[0] === 'Alice Wang' && dataN[2] === 'Pat &quot;PJ&quot; O&#39;Brien', JSON.stringify(dataN))
  // v105：补录按钮同样必须走 data-*（不得把用户名拼进 onclick）
  assert('补录按钮每行一个，且同样携带 data-u/data-n',
    manualAttrs.length === ROWS.length
    && manualAttrs[0].u === 'alice' && manualAttrs[1].u === '张三' && manualAttrs[2].u === 'o&#39;brien&quot;x',
    JSON.stringify(manualAttrs))
  assert('补录按钮的 onclick 不含用户名（无内联引号拼接）',
    onclicks.filter(v => v.includes('dashManualScoreFromBtn')).every(v => v === 'dashManualScoreFromBtn(this)'),
    JSON.stringify(onclicks.filter(v => v.includes('dashManualScoreFromBtn'))))

  // ---------- ③ 端到端：点击真跑一遍 ----------
  console.log('\n[3] 端到端模拟点击（onclick 代码 + data-* 一起走完）')
  {
    const el = { dataset: { u: 'alice', n: 'Alice Wang' }, disabled: false, textContent: '' }
    const sb = await runOnclick(resetOnclicks[0], el)
    assert('二次确认弹出一次', sb.__confirmed === 1, 'confirmed=' + sb.__confirmed)
    assert('重置函数收到正确的用户名/姓名', JSON.stringify(sb.__captured[0]) === '["alice","Alice Wang"]', JSON.stringify(sb.__captured))
    assert('成功后重渲染看板（成绩消失）', sb.__rendered === 1, 'rendered=' + sb.__rendered)
    assert('成功后按钮置为 loading 态', el.disabled === true && el.textContent === 'dashChResetWorking', el.textContent)
  }
  {
    // 中文用户名 + 带引号用户名（转义后浏览器会解码回原值，这里直接给解码后的值）
    const el = { dataset: { u: 'o\'brien"x', n: 'Pat "PJ" O\'Brien' }, disabled: false, textContent: '' }
    const sb = await runOnclick(resetOnclicks[2], el)
    assert('带引号用户名原样送达（不被截断/转义污染）',
      JSON.stringify(sb.__captured[0]) === JSON.stringify(['o\'brien"x', 'Pat "PJ" O\'Brien']), JSON.stringify(sb.__captured))
    assert('成功提示带姓名（中文括号标注）', /dashChResetOk\|Pat "PJ" O'Brien（o'brien"x）/.test(sb.__alerts[0] || ''), sb.__alerts[0])
  }
  {
    // 用户取消确认 → 不写入、不重渲染
    const sb0 = {
      console, JSON, Object, Array, String, Number, Math, Date, Promise, Set,
      __captured: [], __rendered: 0, t: (k) => k, confirm: () => false, alert: () => {},
      renderDashboard: () => { sb0.__rendered++ },
      document: { getElementById: () => null },
      CloudSync: { setChallengeReset: async () => { sb0.__captured.push(1); return { ok: true } } },
    }
    sb0.window = sb0
    vm.createContext(sb0)
    vm.runInContext(extractFn(appSrc, 'dashResetChUser'), sb0)
    sb0.__el = { dataset: { u: 'alice', n: '' }, disabled: false, textContent: '' }
    const fn = vm.runInContext(`(function(){ return (${resetOnclicks[0]}) }).bind(__el)`, sb0)
    await fn()
    assert('取消确认 → 不发起重置、不重渲染', sb0.__captured.length === 0 && sb0.__rendered === 0)
  }

  // ---------- ④ 云端失败/旧签名兼容 ----------
  console.log('\n[4] 失败分支与旧签名兼容')
  {
    const sb = {
      console, JSON, Object, Array, String, Number, Math, Date, Promise, Set,
      __alerts: [], __rendered: 0, t: (k) => k, confirm: () => true, alert: (m) => sb.__alerts.push(m),
      renderDashboard: () => { sb.__rendered++ },
      document: { getElementById: (id) => (id === 'dashChResetBtn_0' ? sb.__btn : null) },
      __btn: { dataset: null, disabled: false, textContent: 'x' },
      CloudSync: { setChallengeReset: async () => ({ ok: false, reason: 'network' }) },
    }
    sb.window = sb
    vm.createContext(sb)
    vm.runInContext(extractFn(appSrc, 'dashResetChUser'), sb)
    // 旧三参签名直调：dashResetChUser('alice', 'Alice', 0)
    await vm.runInContext(`dashResetChUser('alice', 'Alice', 0)`, sb)
    assert('云端写入失败 → 提示失败且不重渲染', sb.__alerts[0] === 'dashChResetFail' && sb.__rendered === 0, JSON.stringify(sb.__alerts))
    assert('失败后按钮恢复可点', sb.__btn.disabled === false, '')
  }
  {
    // 空用户名（防御）：不弹确认也不写入
    const sb = {
      console, JSON, Object, Array, String, Number, Math, Date, Promise, Set,
      __confirmed: 0, t: (k) => k, confirm: () => { sb.__confirmed++; return true }, alert: () => {},
      document: { getElementById: () => null }, renderDashboard: () => {},
      CloudSync: { setChallengeReset: async () => ({ ok: true }) },
    }
    sb.window = sb
    vm.createContext(sb)
    vm.runInContext(extractFn(appSrc, 'dashResetChUser'), sb)
    await vm.runInContext(`dashResetChUser({ dataset: { u: '', n: '' } }, 0)`, sb)
    assert('空用户名 → 直接返回（不弹确认）', sb.__confirmed === 0)
  }

  // ---------- ⑤ 全项目反模式扫描（防止别的按钮再踩） ----------
  console.log('\n[5] 全项目内联 onclick 反模式扫描')
  const files = ['app.js', 'challenge.js', 'course-app.js']
  const bad = []
  files.forEach(f => {
    const p = path.join(__dirname, f)
    if (!fs.existsSync(p)) return
    const src = fs.readFileSync(p, 'utf-8')
    // onclick="..." 的属性值内出现 ${JSON.stringify( → 运行时必产出裸双引号 → 属性被截断
    const re = /onclick="[^"\n]*\$\{JSON\.stringify/g
    let m
    while ((m = re.exec(src))) bad.push(f + ': ' + m[0])
  })
  assert('无 onclick 属性内嵌 JSON.stringify 的写法', bad.length === 0, bad.join(' | '))
  assert('重置按钮改用 escAttr 转义 data 属性', appSrc.includes('data-u="${escAttr(p.username)}"') && appSrc.includes('data-n="${escAttr(p.name || \'\')}"'))

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v85 接线测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
