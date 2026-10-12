// ====== 测试 v160：积分榜加入「首答准确率」乘数 ======
// 起因（用户原话）：「第一第二名没别人读得多 准确率没第三高 凭啥排第一第二」→ 拍板选 A：
//   积分 = 答对题数 × 100 × 准确率 − 总用时（秒）
// ★ 本套件的核心不是「乘了个数」，而是**乘数必须与答对同源**：
//   答对按 v73 去重只算首次完成 → 准确率也必须只算首次作答；若改用明细表那个「正确率」
//   （含全部重做），学生把环节重做几遍就能把准确率刷到接近 100% → 等于开了刷分后门。
// 覆盖：① 看板公式与新增列 ② 兼容护栏（老记录缺 total / correct>total / 除零）
//   ③ 学员端与看板同口径 ④ ★ 反证：重做不刷分 + 同答对同用时按准确率分档
//   ⑤ 导出积分榜含该列 ⑥ i18n ⑦ 版本契约
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

// 看板渲染沙箱（同 test-v78）
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
  vm.runInContext(extractFn(caSrc, 'xlsxColRef'), sb)   // 列号换算在 course-app.js
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
// 从看板 HTML 里按顺序取出积分榜的「积分」单元格（唯一色号 #b45309）
function scoresOf(html) {
  const out = []
  const re = /color:#b45309">(\d+)</g
  let m
  while ((m = re.exec(html))) out.push(Number(m[1]))
  return out
}
// 积分榜「首答准确率」单元格（灰色 + 百分号；只扫到明细表之前，避免扫进明细）
function accCellsOf(html) {
  const cut = html.indexOf('📋')
  const seg = cut >= 0 ? html.slice(0, cut) : html
  const out = []
  const re = /color:#6b7280">(\d+)%</g
  let m
  while ((m = re.exec(seg))) out.push(Number(m[1]))
  return out
}

// 三档学员：答对/用时相同但准确率不同（sharp 全对）、答对更多但准确率低（grinder）
const rowsAcc = [
  { username: 'sharp', name: '准', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 80, total: 80, at: 100, usedSec: 600 }] },
  { username: 'sloppy', name: '糊', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 80, total: 100, at: 100, usedSec: 600 }] },
  { username: 'grinder', name: '刷', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 90, total: 150, at: 100, usedSec: 1000 }] },
]

;(async () => {
  console.log('\n🧪 v160 积分榜「首答准确率」乘数测试')

  console.log('\n[1] 看板积分 = 得分 × 首答准确率 − 用时（并新增该列）')
  {
    const sb = makeSandbox()
    const html = renderDash(sb, rowsAcc)
    // sharp   : 80×100×1 = 8000 × 1.00 = 8000 − 600  = 7400
    // sloppy  : 80×100×1 = 8000 × 0.80 = 6400 − 600  = 5800   ← 同答对同用时，旧口径下与 sharp 同为 7400
    // grinder : 90×100×1 = 9000 × 0.60 = 5400 − 1000 = 4400   ← 答对最多（90）却最低
    const scores = scoresOf(html)
    assert('前三名积分 = 7400 / 5800 / 4400', scores.join(',') === '7400,5800,4400', JSON.stringify(scores))
    assert('★ 同答对同用时按首答准确率分档（sharp 7400 > sloppy 5800；旧口径两者并列 7400）',
      scores[0] - scores[1] === 1600, '差 ' + (scores[0] - scores[1]))
    assert('答对多但首答不准者反而最低（grinder 90 对 < sharp 80 对的分）', scores[2] === 4400 && scores[2] < scores[1])
    assert('排序：sharp → sloppy → grinder（HTML 中出现次序）',
      html.indexOf('sharp') < html.indexOf('sloppy') && html.indexOf('sloppy') < html.indexOf('grinder'))
    const accs = accCellsOf(html)
    assert('首答准确率列 = 100% / 80% / 60%', accs.join(',') === '100,80,60', JSON.stringify(accs))
    assert('表头含「首答准确率」列', html.includes('首答准确率'))
    // 只有管理员参赛 → 排名表出空态（管理员不进排名），此时才能看到排名表的 colspan。
    // ★ 必须连「空态专属样式」一起断言：明细表的分组横幅也有一个 colspan="8"，只查数字会假绿
    const htmlAdmin = renderDash(makeSandbox(), [{ username: 'boss', name: '管', role: 'admin', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 5, total: 10, at: 1, usedSec: 10 }] }])
    assert('排名空态 colspan 已随新列扩到 8（按空态样式精确定位）',
      htmlAdmin.includes('colspan="8" style="text-align:center;color:#9ca3af;padding:16px"'))
  }

  console.log('\n[2] 兼容护栏（老数据不得被乘数打成 0）')
  {
    const sb = makeSandbox()
    // 老记录没有 total 字段 → 首答准确率按 1 处理，等价加乘数之前
    const html = renderDash(sb, [{ username: 'old', name: '老', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 30, at: 1, usedSec: 100 }] }])
    assert('缺 total 的老记录 → 30×100 − 100 = 2900（不归零）', scoresOf(html).join(',') === '2900', JSON.stringify(scoresOf(html)))
    const sb2 = makeSandbox()
    // correct > total 的脏数据 → 准确率钳到 1.0
    const html2 = renderDash(sb2, [{ username: 'dirty', name: '脏', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 30, total: 10, at: 1, usedSec: 200 }] }])
    assert('correct(30) > total(10) → 钳到 100%：3000 − 200 = 2800', scoresOf(html2).join(',') === '2800', JSON.stringify(scoresOf(html2)))
    const sb3 = makeSandbox()
    const html3 = renderDash(sb3, [{ username: 'zero', name: '零', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 0, total: 0, at: 1, usedSec: 0 }] }])
    assert('全零记录 → 0 分且不抛错', scoresOf(html3).join(',') === '0', JSON.stringify(scoresOf(html3)))
  }

  console.log('\n[3] 学员端「当前积分榜前三」与看板同口径')
  {
    const lb = makeLbSandbox()
    const top = vm.runInContext(`chLbAggregate(${JSON.stringify(rowsAcc)})`, lb)
    assert('学员端积分与看板逐项一致', top.map(x => x.score).join(',') === '7400,5800,4400', JSON.stringify(top.map(x => [x.username, x.score])))
    assert('学员端同时返回首答分母 q 与准确率 acc（渲染层要用）',
      top[0].q === 80 && Math.abs(top[0].acc - 1) < 1e-9 &&
      top[1].q === 100 && Math.abs(top[1].acc - 0.8) < 1e-9 &&
      top[2].q === 150 && Math.abs(top[2].acc - 0.6) < 1e-9, JSON.stringify(top[0]))
  }

  console.log('\n[4] ★ 反证：重做刷不出分（乘数必须只认首次作答）')
  {
    const rowsFarm = [{
      username: 'farm', name: '刷子', role: 'student', dept: 'dining',
      chy: [{ day: 1, si: 0, kind: 'practice', correct: 10, total: 20, at: 1, usedSec: 100 }]
        .concat([2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => ({ day: 1, si: 0, kind: 'practice', correct: 20, total: 20, at: 100 + i, usedSec: 5 }))),
    }]
    const html = renderDash(makeSandbox(), rowsFarm)
    // 首次 10/20 → 得分 1000 × 0.5 = 500 − 100 = 400；后 9 次重做全对一律不计
    assert('看板：重做 9 次全对后积分仍为 400', scoresOf(html).join(',') === '400', JSON.stringify(scoresOf(html)))
    assert('看板：首答准确率仍显示 50%（不被重做抬高）', accCellsOf(html).join(',') === '50', JSON.stringify(accCellsOf(html)))
    const lb = makeLbSandbox()
    const farm = vm.runInContext(`chLbAggregate(${JSON.stringify(rowsFarm)})[0]`, lb)
    assert('学员端：答对 10 / 分母 20 / 得分 400（同口径）',
      farm.correct === 10 && farm.q === 20 && Math.abs(farm.acc - 0.5) < 1e-9 && farm.score === 400, JSON.stringify(farm))
  }

  console.log('\n[5] 导出 Excel 的积分榜 sheet 含首答准确率列')
  {
    const sb = makeSandbox()
    const sheets = vm.runInContext(`dashChExportSheets(${JSON.stringify(rowsAcc)})`, sb)
    const rank = sheets[1]
    assert('积分榜 sheet 表头含「首答准确率」', rank.rows[0].includes('首答准确率'), JSON.stringify(rank.rows[0]))
    const cell = rank.rows[1][6]
    assert('准确率单元格 = {v:1, s:{fmt:\'0%\'}}（Excel 按百分比显示）',
      cell && typeof cell === 'object' && cell.v === 1 && cell.s && cell.s.fmt === '0%', JSON.stringify(cell))
    assert('准确率列排在「答对」与「计分用时(秒)」之间',
      rank.rows[0].join('|') === '排名|用户名|姓名|部门|积分|答对|首答准确率|计分用时(秒)', rank.rows[0].join('|'))
  }

  console.log('\n[6] 文案（规则必须能自证：看板上什么、公式就用什么）')
  {
    const zhRule = (i18nSrc.match(/dashChScoreRule: '([^']*)'/) || [])[1] || ''
    const enRule = (i18nSrc.match(/dashChScoreRule: '([^']*)',\n/g) || [])[1] || ''
    assert('中文规则含「× 准确率」', zhRule.includes('× 准确率'), zhRule.slice(0, 60))
    assert('中文规则解释「首次作答」并点明与明细「正确率」的区别',
      zhRule.includes('首次作答') && zhRule.includes('正确率'), zhRule.slice(0, 120))
    assert('英文规则含 accuracy 与 first attempt',
      i18nSrc.includes('× accuracy −') && i18nSrc.includes('first attempt'))
    assert('积分榜列名 dashChThFirstAcc zh/en 成对（恰好 2 处）',
      (i18nSrc.match(/dashChThFirstAcc:/g) || []).length === 2)
    assert('学员端规则文案含「首答」（中）/ first-try（英）',
      i18nSrc.includes('首答越准，积分越高') && i18nSrc.includes('first-try accuracy'))
  }

  console.log('\n[7] 源码护栏与版本契约')
  {
    assert('app.js：准确率与答对同源（独立累计 lbQ，来自去重后的首次完成记录）',
      appSrc.includes('lbQ += x.total || 0') && appSrc.includes('const lbAcc = lbQ > 0 ? Math.min(1, lbC / lbQ) : 1'))
    assert('app.js：积分用 lbPts × lbAcc（不是明细的 acc 字段）',
      appSrc.includes('lbScore: Math.round(lbPts * lbAcc) - lbT') && !appSrc.includes('lbPts * (q > 0'))
    assert('challenge.js：学员端同口径实现',
      chSrc.includes('tq += x.total || 0') && chSrc.includes('const acc = tq > 0 ? Math.min(1, c / tq) : 1') && chSrc.includes('Math.round(pts * acc) - tsec'))
    const vers = (HTML_SRC.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = [...new Set(vers)]
    assert('index.html 资源版本号恰好 12 处且唯一', vers.length === 12 && uniq.length === 1, `出现 ${vers.length} 处，唯一值 ${uniq.join(',')}`)
    assert('index.html 资源版本号 ≥ 160（弹性判据，不写死等值）', uniq.every(v => v >= 160), String(uniq[0]))
    assert('index.html 无更早的版本号残留', vers.every(v => v >= 160))
  }

  console.log('\n' + (testFailed ? '❌ FAILED' : '✅ ALL PASS'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
