// ====== 测试 v78：积分口径两项调整 ======
// ① 权重函数 chLbStageWeight（challenge.js）/ dashChStageWeight（app.js，可回退）：第七天期末考试 3 倍，其余 1 倍
// ② 两侧口径一致性：同一 rows 输入 → 看板积分与学员端前三积分完全相同
// ③ 管理员账号不参加排名：看板积分榜 + 学员端前三均剔除；进度明细表与汇总仍包含管理员
// ④ 边界：无 role 历史数据照常参赛；仅管理员参赛 → 排名空态；i18n 规则文案
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
const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

// 看板渲染沙箱（同 test-v71：bank-data/store/i18n/cloud-store + escHtml + renderDashChallengeBlock）
function makeSandbox() {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: {},
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
  vm.runInContext(extractFn(appSrc, 'escAttr'), sb)   // v85：重置按钮 data-u/data-n 转义
  vm.runInContext(extractFn(appSrc, 'dashChStageWeight'), sb)
  vm.runInContext(extractFn(appSrc, 'renderDashChallengeBlock'), sb)
  // v88：营次筛选依赖（dashRoundView/dashRoundCurId/dashRoundList）——从 app.js 提取真实实现，
  // 沙箱无云端营次 → dashRoundList 返回空数组、dashRoundCurId 兜底 'r1'，等价单期（第一期）口径
  vm.runInContext('let dashRoundView = \'\'', sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundList'), sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundCurId'), sb)
  vm.runInContext(extractFn(appSrc, 'dashRoundSlug'), sb)

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

// 学员端聚合沙箱
function makeLbSandbox() {
  const sb = { console, Math, JSON, Object, Array, String, Number }
  vm.createContext(sb)
  vm.runInContext(extractFn(chSrc, 'chLbStageWeight'), sb)
  vm.runInContext(extractFn(chSrc, 'chLbAggregate'), sb)
// v88：chLbAggregate 按营次过滤（chCurrentRound/chRoundSlug）——沙箱无云端营次 → 回落第一期
vm.runInContext(extractFn(chSrc, 'chRoundSlug'), sb)
vm.runInContext(extractFn(chSrc, 'chCurrentRound'), sb)
  return sb
}

const rowsMix = [
  {
    username: 'stuA', name: '学员A', dept: 'dining', role: 'student',
    chy: [
      { day: 1, si: 0, kind: 'test', correct: 10, total: 20, at: 100, usedSec: 100 },
      { day: 7, si: 1, kind: 'test', correct: 12, total: 20, at: 500, usedSec: 60 },
    ],
  },
  {
    username: 'boss', name: '管理员', dept: 'dining', role: 'admin',
    chy: [
      { day: 1, si: 0, kind: 'test', correct: 20, total: 20, at: 90, usedSec: 10 },
      { day: 7, si: 1, kind: 'test', correct: 20, total: 20, at: 490, usedSec: 10 },
    ],
  },
  {
    username: 'stuB', name: '学员B', dept: 'rooms',
    chy: [{ day: 7, si: 1, kind: 'test', correct: 5, total: 20, at: 501, usedSec: 0 }],
  },
]

;(async () => {
  console.log('\n🧪 v78 积分口径测试（考试权重 / 管理员不参加排名）')

  // ---------- ① 权重函数 ----------
  console.log('\n[1] 环节权重函数')
  {
    const sb = { console, Math, JSON, Number }
    vm.createContext(sb)
    vm.runInContext(extractFn(chSrc, 'chLbStageWeight'), sb)
    assert('Day7 水平测试 → 3 倍', vm.runInContext('chLbStageWeight(7, "test") === 3', sb))
    assert('Day7 巩固练习 → 1 倍', vm.runInContext('chLbStageWeight(7, "practice") === 1', sb))
    assert('Day1 摸底测试 → 1 倍', vm.runInContext('chLbStageWeight(1, "test") === 1', sb))
    assert('Day2-6 练习 → 1 倍', vm.runInContext('chLbStageWeight(2, "practice") === 1 && chLbStageWeight(6, "practice") === 1', sb))
    assert('字符串 day（事件反序列化）同样识别', vm.runInContext('chLbStageWeight("7", "test") === 3', sb))

    // app.js 侧：有 challenge.js 实现时复用，缺失时回退同样的规则
    const sb2 = { console, Math, JSON, Number }
    vm.createContext(sb2)
    vm.runInContext(extractFn(chSrc, 'chLbStageWeight'), sb2)
    vm.runInContext(extractFn(appSrc, 'dashChStageWeight'), sb2)
    assert('看板权重复用 challenge.js 实现（委托后结果一致）',
      vm.runInContext('dashChStageWeight(7, "test") === 3 && dashChStageWeight(7, "practice") === 1 && dashChStageWeight(1, "test") === 1', sb2))
    const sb3 = { console, Math, JSON, Number }
    vm.createContext(sb3)
    vm.runInContext(extractFn(appSrc, 'dashChStageWeight'), sb3)
    assert('看板单独加载（无 challenge.js）→ 回退规则一致', vm.runInContext('dashChStageWeight(7, "test") === 3 && dashChStageWeight(3, "test") === 1', sb3))
  }

  // ---------- ② 两侧口径一致 ----------
  console.log('\n[2] 看板积分与学员端前三同口径')
  {
    const sb = makeSandbox()
    const html = renderDash(sb, rowsMix)
    const lb = makeLbSandbox()
    const top = vm.runInContext(`chLbAggregate(${JSON.stringify(rowsMix)})`, lb)
    // stuA = 10×100 + 12×300 − 160 = 1000+3600-160 = 4440；stuB = 5×300 − 0 = 1500
    assert('看板 stuA 积分 4440（含 Day7 考试 12×300）', html.includes('4440'), '')
    assert('学员端 stuA 积分同为 4440', top[0].username === 'stuA' && top[0].score === 4440, JSON.stringify(top[0]))
    assert('学员端 stuB 积分 1500（5×300）', top[1].username === 'stuB' && top[1].score === 1500, JSON.stringify(top[1]))
    assert('未加权时的旧值 2200 不再出现（口径已切换）', !html.includes('>2200<'))
  }

  // ---------- ③ 管理员不参加排名 ----------
  console.log('\n[3] 管理员账号不参加排名（仅排名，进度/汇总仍含）')
  {
    const sb = makeSandbox()
    const html = renderDash(sb, rowsMix)
    // 排名表 = 从「排名」表头到「挑战进度」表头之间（后者为进度明细表起始）
    const rankTable = html.slice(html.indexOf('>排名<'), html.indexOf('挑战进度'))
    assert('排名表切片有效（含 stuA）', rankTable.includes('stuA'), rankTable.slice(0, 200).replace(/\s+/g, ' '))
    assert('看板积分榜不含管理员 boss', !rankTable.includes('boss'), '')
    assert('看板积分榜仍含学员 stuA / stuB', rankTable.includes('stuA') && rankTable.includes('stuB'))
    assert('🥇 为最高学员 stuA（管理员不占位）', rankTable.indexOf('🥇') >= 0 && rankTable.indexOf('stuA') < rankTable.indexOf('stuB'))
    const otherTable = html.slice(html.indexOf('挑战进度'))
    assert('进度明细表仍含管理员 boss（便于自查）', otherTable.includes('boss'), otherTable.slice(0, 200).replace(/\s+/g, ' '))
    assert('参与人数汇总仍为 3（含管理员）', html.includes('>3<'))

    const lb = makeLbSandbox()
    assert('学员端前三不含管理员', vm.runInContext(`chLbAggregate(${JSON.stringify(rowsMix)}).every(x => x.username !== 'boss')`, lb))
    assert('学员端仅剩 2 名学员（boss 剔除后）', vm.runInContext(`chLbAggregate(${JSON.stringify(rowsMix)}).length === 2`, lb))
  }

  // ---------- ④ 边界 ----------
  console.log('\n[4] 边界：无 role 历史数据 / 仅管理员参赛')
  {
    const lb = makeLbSandbox()
    assert('无 role 字段的历史数据照常参赛', vm.runInContext(`chLbAggregate([{ username: 'old', chy: [{ day: 1, si: 0, correct: 10, total: 10, at: 1, usedSec: 0 }] }]).length === 1`, lb))
    const sb = makeSandbox()
    const onlyAdmin = [{ username: 'boss', name: '管理员', role: 'admin', chy: [{ day: 1, si: 0, kind: 'test', correct: 20, total: 20, at: 1, usedSec: 0 }] }]
    const html = renderDash(sb, onlyAdmin)
    assert('仅管理员参赛 → 挑战板块正常渲染（不崩）', html.includes('七天挑战积分榜'))
    assert('仅管理员参赛 → 排名表显示空态文案', html.includes('暂无排名数据'), '')
  }

  // ---------- ⑤ 文案与接线 ----------
  console.log('\n[5] 积分规则文案 + i18n 成对 + 接线')
  {
    const sb = makeSandbox()
    const html = renderDash(sb, rowsMix)
    assert('规则文案说明第七天考试 3 倍', html.includes('第七天期末考试每题按 3 倍计分'))
    assert('规则文案说明管理员不参加排名', html.includes('管理员账号不参加排名'))
    ;['dashChNoAdminRank', 'dashChRankEmpty'].forEach(k => {
      const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
      assert('i18n ' + k + ' zh/en 成对', n === 2, '出现 ' + n + ' 次')
    })
    assert('i18n dashChScoreRule 中英文均含 3 倍说明',
      i18nSrc.includes('第七天期末考试每题按 3 倍计分') && i18nSrc.includes('Day-7 final exam answers score 3×'))
    assert('app.js 排名剔除管理员 + 权重接线',
      appSrc.includes("const lbList = list.filter(p => p.role !== 'admin')") && appSrc.includes('dashChStageWeight(x.day, x.kind)'))
    assert('challenge.js 学员端剔除管理员 + 权重接线',
      chSrc.includes("r.role !== 'admin'") && chSrc.includes('chLbStageWeight(x.day, x.kind)'))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('异常:', e); process.exit(1) })
