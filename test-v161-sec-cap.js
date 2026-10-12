// ====== 测试 v161：积分用时扣分加「每题 30 秒」封顶（计分用时）======
// 起因：用户质疑「第一第二名没别人读得多、准确率也没第三高，凭啥排第一第二」→ 选 A（v160 加首答准确率乘数）
//   之后仍存在的不公平来源 = **用时的口径**：chy 的 usedSec 是「进入环节 → 完成」的净耗时，
//   学员中途被工作打断、页面挂着不管，时长照样全额累积。
// ★ 线上实测铁证（_cloud-sync.json 快照）：某学员单个 30 题练习阶段 usedSec = 3675 秒
//   = 122.5 秒/题，而全体每题用时的 P90 仅约 25 秒 → 单个环节白扣 3675 分（≈37 道题的分）。
// 本版：积分里的计时改为**计分用时** = Σ 阶段 min(usedSec, total × 30)；看板显示实际用时 + * 角标。
// 覆盖：① 源码契约（含「辅助函数必须留在函数体内」的注入护栏）② 封顶/不封顶两端
//   ③ 兼容护栏（total=0 不封顶、负数、边界相等）④ 学员端与看板两处独立实现同口径
//   ⑤ ★ 反证：同一条真实数据在旧口径下是负分 ⑥ 文案 ⑦ 版本契约
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

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const caSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const HTML_SRC = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

// 看板渲染沙箱（同 test-v78 / test-v160）
function makeSandbox() {
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
  vm.runInContext('const TYPE_LABELS = new Proxy({}, { get: (_, k) => k })', sb)
  vm.runInContext('Store.init()', sb)
  return sb
}
function renderDash(sb, rows) {
  vm.runInContext('window.__els.dashChallengeBlock = { id: "dashChallengeBlock", innerHTML: "" }', sb)
  vm.runInContext('document.getElementById = (id) => (window.__els[id] = window.__els[id] || { id, innerHTML: "" })', sb)
  vm.runInContext(`renderDashChallengeBlock(${JSON.stringify(rows)})`, sb)
  return vm.runInContext('window.__els.dashChallengeBlock.innerHTML', sb)
}
function makeLbSandbox() {
  const sb = { console, Math, JSON, Object, Array, String, Number }
  vm.createContext(sb)
  vm.runInContext(extractFn(chSrc, 'chLbStageWeight'), sb)
  vm.runInContext(extractFn(chSrc, 'chRoundSlug'), sb)
  vm.runInContext(extractFn(chSrc, 'chCurrentRound'), sb)
  vm.runInContext(extractFn(chSrc, 'chLbAggregate'), sb)
  return sb
}
// 积分榜「积分」单元格（唯一色号 #b45309 且紧跟 > ；带 * 角标的 span 后面跟的是 " 不是 > ，不会误抓）
function scoresOf(html) {
  const out = []
  const cut = html.indexOf('📋')
  const seg = cut >= 0 ? html.slice(0, cut) : html
  const re = /color:#b45309">(-?\d+)</g
  let m
  while ((m = re.exec(seg))) out.push(Number(m[1]))
  return out
}
// 积分榜「用时」列（实际用时 mm:ss，可能带 * 角标）
function timeCellsOf(html) {
  const cut = html.indexOf('📋')
  const seg = cut >= 0 ? html.slice(0, cut) : html
  const out = []
  const re = /color:#6b7280"[^>]*>(\d+:\d\d)/g
  let m
  while ((m = re.exec(seg))) out.push(m[1])
  return out
}
// 从导出 Excel 的积分榜 sheet 取「计分用时」列（第 8 列，index 7）
// ★ 注意：dashChExportSheets 吃的是 renderDashChallengeBlock 算好的 _chDashRows（见 app.js:4596 注释），
//   直接喂原始 chy 行会得到全 0 —— 必须先进看板渲染再取 _chDashRows。
function scoreSecOf(sheets) {
  return sheets[1].rows.slice(1).map(r => r[7])
}

// 线上实测那条：单个 30 题练习阶段 3675 秒（122.5 秒/题）→ 封顶 30×30 = 900 秒
const REAL_INTERRUPTED_SEC = 3675
const rowsCap = [
  { username: 'interrupted', name: '被打断', role: 'student', dept: 'dining',
    chy: [{ day: 2, si: 0, kind: 'practice', correct: 30, total: 30, at: 100, usedSec: REAL_INTERRUPTED_SEC }] },
  { username: 'normal', name: '正常', role: 'student', dept: 'dining',
    chy: [{ day: 2, si: 0, kind: 'practice', correct: 30, total: 30, at: 100, usedSec: 600 }] },
]

;(async () => {
  console.log('\n🧪 v161 积分用时「每题 30 秒」封顶测试')

  console.log('\n[1] 源码契约：计分用时怎么算、落在哪里')
  {
    assert('app.js 常量 LB_SEC_PER_Q_CAP = 30 存在',
      appSrc.includes('const LB_SEC_PER_Q_CAP = 30'), '缺常量')
    assert('app.js 聚合处用 lbDeductSec(x) 而不是裸 usedSec',
      appSrc.includes('lbT += lbDeductSec(x)') && !appSrc.includes('lbT += x.usedSec || 0'))
    assert('app.js 同时记录实际用时 lbTa（供看板对照显示）',
      appSrc.includes('lbTa += Math.max(0, x.usedSec || 0)') && appSrc.includes('lbC, lbQ, lbAcc, lbT, lbTa'))
    assert('app.js 积分公式本体未变（仍是 lbPts × lbAcc − lbT）',
      appSrc.includes('lbScore: Math.round(lbPts * lbAcc) - lbT'))
    assert('challenge.js 学员端同口径（chLbDeductSec）',
      chSrc.includes('tsec += chLbDeductSec(x)') && !chSrc.includes('tsec += x.usedSec || 0'))
    // ★ 注入护栏：辅助函数必须留在各自函数体内 —— 各套件按源码切片注入，
    //   抽到模块级会让所有既有套件的沙箱缺注入而整片报错（v161 实现时踩到并回退）
    assert('★ app.js 的封顶逻辑整段位于 renderDashChallengeBlock 内部（可被 extractFn 完整带出）',
      extractFn(appSrc, 'renderDashChallengeBlock').includes('const LB_SEC_PER_Q_CAP = 30') &&
      extractFn(appSrc, 'renderDashChallengeBlock').includes('const lbDeductSec ='))
    assert('★ challenge.js 的封顶逻辑位于 chLbAggregate 内部',
      extractFn(chSrc, 'chLbAggregate').includes('const chLbDeductSec ='))
  }

  console.log('\n[2] 封顶：被工作打断的超长计时不再全额扣分')
  {
    const sb = makeSandbox()
    const html = renderDash(sb, rowsCap)
    const calced = vm.runInContext('_chDashRows', sb)
    const byUser = {}
    calced.forEach(p => { byUser[p.username] = p })
    // interrupted: 30×100×1 = 3000 × 1.00 = 3000 − min(3675, 900) = 2100
    // normal     : 30×100×1 = 3000 × 1.00 = 3000 − 600           = 2400
    const scores = scoresOf(html)
    assert('积分 = 2400（正常）/ 2100（被打断）', scores.join(',') === '2400,2100', JSON.stringify(scores))
    assert('★ 正常作答（20 秒/题）完全不受封顶影响：计分用时 600',
      byUser.normal && byUser.normal.lbT === 600, JSON.stringify(byUser.normal && byUser.normal.lbT))
    assert('★ 被中断者计分用时封顶到 30×30 = 900 秒（原 3675）',
      byUser.interrupted && byUser.interrupted.lbT === 900, JSON.stringify(byUser.interrupted && byUser.interrupted.lbT))
    assert('实际用时原样保留（600 / 3675），供看板对照',
      byUser.normal.lbTa === 600 && byUser.interrupted.lbTa === 3675,
      `${byUser.normal.lbTa} / ${byUser.interrupted.lbTa}`)
    // 看板「用时」列显示的是**实际用时**：normal 10:00、interrupted 61:15
    const times = timeCellsOf(html)
    assert('看板用时列显示实际用时（10:00 / 61:15）', times.join(',') === '10:00,61:15', JSON.stringify(times))
    assert('★ 被封顶的行带 * 角标 + 悬停提示（计分用时 15:00）',
      html.includes('计分用时 15:00') && html.includes('>*</span>'),
      '未找到封顶提示')
    assert('★ 只有被封顶的那一行带提示（title=计分用时 恰好 2 处：单元格 + 角标）',
      (html.match(/title="计分用时/g) || []).length === 2,
      '出现 ' + (html.match(/title="计分用时/g) || []).length + ' 次')
    // 导出 Excel 的「计分用时(秒)」列必须与看板同源（吃同一份 _chDashRows）
    const sheets = vm.runInContext('dashChExportSheets(_chDashRows)', sb)
    assert('★ 导出 Excel 积分榜「计分用时(秒)」列 = 600 / 900（与看板同源）',
      scoreSecOf(sheets).join(',') === '600,900', JSON.stringify(scoreSecOf(sheets)))
  }

  console.log('\n[3] 兼容护栏：不给老数据凭空加分、脏数据不炸')
  {
    const mk = usedSec => [{ username: 'b', name: '界', role: 'student', dept: 'dining',
      chy: [{ day: 2, si: 0, kind: 'practice', correct: 30, total: 30, at: 1, usedSec }] }]
    const mkRow = x => [{ username: 'b', name: '界', role: 'student', dept: 'dining', chy: [x] }]
    // 走看板拿 lbT（唯一权威），避免用导出路径绕远
    const secOf = rows => {
      const sb = makeSandbox()
      renderDash(sb, rows)
      return vm.runInContext('_chDashRows', sb).map(p => p.lbT)
    }
    // total 缺失（老记录 / 手动补录异常）→ 不封顶（保持原值），绝不因为「算不出上限」就少扣
    assert('total 缺失 → 不封顶（计分用时仍是 5000）',
      secOf(mkRow({ day: 2, si: 0, kind: 'practice', correct: 10, at: 1, usedSec: 5000 })).join(',') === '5000',
      JSON.stringify(secOf(mkRow({ day: 2, si: 0, kind: 'practice', correct: 10, at: 1, usedSec: 5000 }))))
    assert('该情形积分 = 1000 − 5000 = −4000（照旧如实扣，不送分）',
      scoresOf(renderDash(makeSandbox(), mkRow({ day: 2, si: 0, kind: 'practice', correct: 10, at: 1, usedSec: 5000 }))).join(',') === '-4000')
    // 边界：恰好等于上限 → 不误伤；多 1 秒 → 封顶
    assert('边界：usedSec 恰好 = total×30 (900) → 计分 900（min 取等）', secOf(mk(900)).join(',') === '900')
    assert('边界：usedSec = 901 → 计分 900（只削超出的 1 秒）', secOf(mk(901)).join(',') === '900')
    assert('usedSec 负值 → 计分 0（不产生加分）', secOf(mk(-100)).join(',') === '0')
    assert('usedSec 缺失 → 计分 0（老字段缺失不影响）',
      secOf(mkRow({ day: 2, si: 0, kind: 'practice', correct: 30, total: 30, at: 1 })).join(',') === '0')
    // ★ 最危险的错误实现是把 cap 写成 total × 30 而在 total=0 时得 0 → 白送分
    assert('★ total=0 → 不封顶（计分 3000，绝不因 cap=0 白送 3000 分）',
      secOf(mkRow({ day: 2, si: 0, kind: 'practice', correct: 30, total: 0, at: 1, usedSec: 3000 })).join(',') === '3000')
  }

  console.log('\n[4] 学员端「当前积分榜前三」与看板同口径（两处独立实现必须一致）')
  {
    const lb = makeLbSandbox()
    const top = vm.runInContext(`chLbAggregate(${JSON.stringify(rowsCap)})`, lb)
    assert('学员端前三积分与看板逐项一致（2400 / 2100）',
      top.map(x => x.score).join(',') === '2400,2100', JSON.stringify(top.map(x => [x.username, x.score])))
    assert('学员端 sec（计分用时）= 600 / 900，与看板同口径',
      top.map(x => x.sec).join(',') === '600,900', JSON.stringify(top.map(x => x.sec)))
    assert('答对与分母不受封顶影响（口径没串）',
      top.every(x => x.correct === 30 && x.q === 30), JSON.stringify(top.map(x => [x.correct, x.q])))
  }

  console.log('\n[5] ★ 反证：这条真实数据在旧口径下是负分（证明封顶不是空操作）')
  {
    const oldScore = 30 * 100 - REAL_INTERRUPTED_SEC      // 旧：3000 − 3675 = −675
    const newScore = 30 * 100 - 30 * 30                   // 新：3000 − 900   = 2100
    assert('旧口径下「被打断」者积分为负（−675），名次必然垫底', oldScore === -675, String(oldScore))
    assert('新口径下为 2100 —— 少受了 ' + (newScore - oldScore) + ' 分的冤枉扣分',
      newScore - oldScore === REAL_INTERRUPTED_SEC - 900 && newScore - oldScore === 2775, String(newScore - oldScore))
    // 与看板实际输出对齐（不是只在纸上算）
    const html = renderDash(makeSandbox(), [rowsCap[0]])
    assert('看板实测输出 = 2100（纸上算式与代码一致）', scoresOf(html).join(',') === '2100', JSON.stringify(scoresOf(html)))
    // 反过来：一个「又快又准」的学员不该被这版削掉一分
    const fast = [{ username: 'fast', name: '快', role: 'student', dept: 'dining',
      chy: [{ day: 2, si: 0, kind: 'practice', correct: 30, total: 30, at: 1, usedSec: 300 }] }]
    assert('★ 快且准者不受影响：3000 − 300 = 2700（封顶对正常区间零副作用）',
      scoresOf(renderDash(makeSandbox(), fast)).join(',') === '2700', JSON.stringify(scoresOf(renderDash(makeSandbox(), fast))))
  }

  console.log('\n[6] 文案与列名（规则必须能自证）')
  {
    const zhUse = (i18nSrc.match(/dashChThUseSec: '([^']*)'/) || [])[1] || ''
    assert('导出列名改称「计分用时(秒)」（原来叫「用时(秒)」，会与实际用时混淆）',
      zhUse === '计分用时(秒)', zhUse)
    assert('dashChThUseSec zh/en 成对（恰好 2 处）',
      (i18nSrc.match(/dashChThUseSec:/g) || []).length === 2)
    assert('英文列名含 Scored time',
      i18nSrc.includes(`dashChThUseSec: 'Scored time (s)'`))
    assert('看板规则文案写明「每题最多计 30 秒」（中）',
      /dashChScoreRule: '[^']*每题最多计 30 秒[^']*'/.test(i18nSrc), '中文规则缺上限说明')
    assert('看板规则文案写明 cap（英）',
      i18nSrc.includes('cap of 30 seconds per question'))
    assert('新增 dashChTimeCapped 提示键 zh/en 成对且为函数（恰 2 处）',
      (i18nSrc.match(/dashChTimeCapped:/g) || []).length === 2 &&
      (i18nSrc.match(/dashChTimeCapped: \(s\) =>/g) || []).length === 2)
    assert('学员端规则文案同步（中：用时按每题最多 30 秒计）',
      i18nSrc.includes('用时按每题最多 30 秒计'))
    assert('学员端规则文案同步（英：max 30 seconds per question）',
      i18nSrc.includes('max 30 seconds per question'))
    assert('规则文案不再出现「总用时」（已改称计分用时）',
      !/dashChScoreRule: '[^']*总用时[^']*'/.test(i18nSrc))
  }

  console.log('\n[7] 版本契约')
  {
    const vers = (HTML_SRC.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = [...new Set(vers)]
    assert('index.html 资源版本号恰好 12 处且唯一', vers.length === 12 && uniq.length === 1, `出现 ${vers.length} 处，唯一值 ${uniq.join(',')}`)
    assert('index.html 资源版本号 ≥ 161（弹性判据，不写死等值）', uniq.every(v => v >= 161), String(uniq[0]))
    assert('index.html 无更早的版本号残留', vers.every(v => v >= 161))
  }

  console.log('\n' + (testFailed ? '❌ FAILED' : '✅ ALL PASS'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
