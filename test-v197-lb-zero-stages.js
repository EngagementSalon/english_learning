// ====== 测试 v197：积分榜「本期零记录者不入榜」 ======
// 起因（用户 10-30 报）：新营次（日照-餐饮21天挑战第一期 r8）尚无人作答，学员端
//   「当前积分榜前三」却显示三个 0 分用户（答对 0·100% 0分）——应该是空的。
// 真因两层：
//   ① 数据层：那三个名字来自设备本机 pending 队列重放（云端文档里根本不存在）——
//      getDashboardData = doc.events.concat(本机 _queue()) 重放进名单；
//   ② ★ 代码层（本版修复）：chLbAggregate 外层只筛「有任意 chy」，内层 matchRound 把
//      别营次记录全剔除后，first 为空 → tq=0 → acc 走缺省 1、积分 0 → 照样占榜。
// 修复口径（三处同改，绝不分叉）：
//   · challenge.js chLbAggregate：first 非空（stages>0）才入榜；
//   · app.js 看板积分榜 lbList：lbStages>0 才入榜（明细表保留全员——v185「仅上期」设计不动）；
//   · app.js 导出积分榜 lb：同 lbStages>0。
// 覆盖：A 学员端聚合（沙箱真跑） B 看板渲染（沙箱真跑） C 源码契约 D 护栏（不误伤）
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

// —— 学员端聚合沙箱（同 test-v160 makeLbSandbox）——
function makeLbSandbox() {
  const sb = { console, Math, JSON, Object, Array, String, Number }
  vm.createContext(sb)
  vm.runInContext(extractFn(chSrc, 'chLbStageWeight'), sb)
  vm.runInContext(extractFn(chSrc, 'chRoundSlug'), sb)
  vm.runInContext(extractFn(chSrc, 'chCurrentRound'), sb)
  vm.runInContext(extractFn(chSrc, 'chLbAggregate'), sb)
  return sb
}
// —— 看板渲染沙箱（同 test-v160 makeSandbox / renderDash）——
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
function scoresOf(html) {
  const out = []
  const re = /color:#b45309">(-?\d+)</g
  let m
  while ((m = re.exec(html))) out.push(Number(m[1]))
  return out
}

;(async () => {
  console.log('\n🧪 v197 积分榜「本期零记录者不入榜」测试')

  // 幽灵用户画像 = 用户设备本机队列重放出来的人：只有**别的营次**的 chy（云端查无此人）
  const ghost = {
    username: 'luzishuang', name: '路子爽', role: 'student', dept: 'dining',
    chy: [{ day: 1, si: 0, kind: 'test', correct: 30, total: 30, at: 1, usedSec: 100, rd: 'r7' }],
  }
  const normal = {
    username: 'stu1', name: '正常学员', role: 'student', dept: 'dining',
    chy: [{ day: 1, si: 0, kind: 'test', correct: 30, total: 30, at: 2, usedSec: 60 }],   // 无 rd → 缺省匹配本期
  }

  console.log('\n[A] 学员端 chLbAggregate（沙箱真跑）')
  {
    const lb = makeLbSandbox()
    const top = vm.runInContext(`chLbAggregate(${JSON.stringify([ghost, normal])})`, lb)
    assert('★ 幽灵（只有别营次 chy）不入榜，榜上只有正常学员',
      top.length === 1 && top[0].username === 'stu1', JSON.stringify(top))
    assert('正常学员计分不变（30×100×1 − 60 = 2940）',
      top[0] && top[0].score === 2940 && top[0].q === 30 && Math.abs(top[0].acc - 1) < 1e-9,
      JSON.stringify(top[0]))

    const empty = vm.runInContext(`chLbAggregate(${JSON.stringify([ghost])})`, lb)
    assert('★ 全员无本期记录 → 返回空数组（渲染层走空态）', Array.isArray(empty) && empty.length === 0,
      JSON.stringify(empty))

    const withAdmin = vm.runInContext(`chLbAggregate(${JSON.stringify([
      { username: 'boss', name: '管', role: 'admin', chy: [{ day: 1, si: 0, kind: 'test', correct: 30, total: 30, at: 1, usedSec: 1 }] },
      ghost, normal,
    ])})`, lb)
    assert('管理员剔除不回归（仍只正常学员上榜）',
      withAdmin.length === 1 && withAdmin[0].username === 'stu1', JSON.stringify(withAdmin))
  }

  console.log('\n[B] 看板积分榜（renderDashChallengeBlock 沙箱真跑）')
  {
    const html = renderDash(makeSandbox(), [ghost, normal])
    assert('★ 排名表不含幽灵（本期零记录）', !html.slice(0, html.indexOf('📋')).includes('路子爽'))
    assert('★ 排名表含正常学员', html.slice(0, html.indexOf('📋')).includes('正常学员'))
    assert('明细表仍显示幽灵（v185「仅上期」设计不动）', html.includes('路子爽'))

    const htmlEmpty = renderDash(makeSandbox(), [ghost])
    assert('★ 全员无本期记录 → 排名表空态（colspan=8 灰字）',
      htmlEmpty.includes('colspan="8" style="text-align:center;color:#9ca3af;padding:16px"'))

    // 不误伤：全零记录（total:0）但确实参加过本期 → 仍 0 分在榜（v160 既有护栏语义）
    const htmlZero = renderDash(makeSandbox(), [{ username: 'zero', name: '零', role: 'student', dept: 'dining', chy: [{ day: 1, si: 0, kind: 'practice', correct: 0, total: 0, at: 1, usedSec: 0 }] }])
    assert('全零记录但参加过本期 → 仍 0 分在榜（不误伤）', scoresOf(htmlZero).join(',') === '0' && htmlZero.includes('零'))
  }

  console.log('\n[C] 源码契约（三处同口径，绝不分叉）')
  {
    assert('challenge.js chLbAggregate 返回 stages 字段',
      chSrc.includes('stages: Object.keys(first).length'))
    assert('challenge.js 入榜判据 = stages > 0',
      /return list\.filter\(p => p\.stages > 0\)\.sort/.test(chSrc))
    assert('app.js 看板积分榜 filter 含 lbStages > 0',
      /const lbList = list\.filter\(p => p\.role !== 'admin' && \(p\.lbStages \|\| 0\) > 0\)/.test(appSrc))
    assert('app.js 导出积分榜 filter 含 lbStages > 0',
      /const lb = rows0\.filter\(p => p\.role !== 'admin' && \(p\.lbStages \|\| 0\) > 0\)/.test(appSrc))
    assert('app.js 明细表 list 元素带 lbStages 字段（供两处消费）',
      appSrc.includes('lbStages: Object.keys(firstByStage).length'))
    assert('明细表参与名单未被改动（parts 仍含仅上期人员）',
      /const parts = \(rows \|\| \[\]\)\.filter\(r => r && \(chyOf\(r\)\.length \|\| chyPrevOf\(r\)\.length\) && deptFilter\(r\)\)/.test(appSrc))
  }

  console.log('\n[D] 排序稳定性护栏（stages>0 者口径不变）')
  {
    const lb = makeLbSandbox()
    const rowsTie = [
      { username: 'nina', name: 'N', chy: [{ day: 1, si: 0, correct: 100, total: 100, at: 1, usedSec: 2500 }] },
      { username: 'mike', name: 'M', chy: [{ day: 1, si: 0, correct: 90, total: 100, at: 1, usedSec: 600 }] },
    ]
    const tie = vm.runInContext(`chLbAggregate(${JSON.stringify(rowsTie)})`, lb)
    assert('同分按用时升序（v74 既有口径不回归）',
      tie.length === 2 && tie[0].username === 'mike' && tie[1].username === 'nina', JSON.stringify(tie.map(x => x.username)))
  }

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ 全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('套件异常:', e); process.exit(1) })
