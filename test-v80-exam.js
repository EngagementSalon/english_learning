// ====== 测试 v80：考试题目出自本人已刷过的练习题 ======
// ① Day1 摸底（尚无已刷题）：回退全库随机——分层 [10,7,3]、两次进入不同、全部 cat12
// ② Day1-6 练习完成（前缀 160 题）：Day7 考试 ⊂ 本人已刷前缀；分层与随机性保持
// ③ Day7 练习也完成（前缀 170 题）：考试 ⊂ 完整个人 170 题序列
// ④ 不同用户考试题出自各自序列（alice 与 bob 考题不同）
// ⑤ 练习切片不受影响；i18n 文案含「考题出自本人已刷题目」（zh/en）
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

function makeSandbox(username) {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    window: { scrollTo() {} },
    document: { addEventListener() {}, getElementById() { return null } },
    confirm() { return true },
    AntiCheat: { start() {}, stop() {}, isActive() { return false }, getViolations() { return 0 }, dismiss() {}, isAdminUser() { return false } },
    CloudSync: { enqueue() {}, _chExamOpen: true, _chOpen: true },
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  vm.runInContext(['shuffleOptions', 'checkAnswer'].map(n => extractFn(appSrc, n)).join('\n'), sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sb)
  vm.runInContext('Store.init()', sb)
  if (username) vm.runInContext(`Store.getSession = () => ({ username: ${JSON.stringify(username)} })`, sb)
  return sb
}

// 注入进度：practDays = 已完成练习的阶段列表（Day1 摸底 test 不算练习）
function setProgress(sb, donePractice) {
  const days = {}
  donePractice.forEach(([day, si]) => {
    days[day] = days[day] || { stages: {} }
    days[day].stages[si] = { done: true, at: 1726272000000 + day * 86400000, correct: 9, total: 10, wrong: [] }
  })
  sb.__chDays = days
  vm.runInContext('challengeState = { uid: challengeUid(), days: __chDays }', sb)
}

;(async () => {
  console.log('\n🧪 v80 考试题目出自本人已刷题目测试')

  // ---------- ① Day1 摸底：回退全库 ----------
  console.log('\n[1] Day1 摸底（无已刷题 → 全库随机）')
  const sb0 = makeSandbox('alice')
  const t1 = vm.runInContext('challengeStageQuestions(1,0)', sb0)
  const t2 = vm.runInContext('challengeStageQuestions(1,0)', sb0)
  assert('Day1 摸底抽 20 题', t1.length === 20, `got ${t1.length}`)
  assert('分层 难度1×10+2×7+3×3', JSON.stringify([1, 2, 3].map(d => t1.filter(q => Number(q.difficulty) === d).length)) === JSON.stringify([10, 7, 3]))
  assert('两次进入不同（随机）', JSON.stringify(t1.map(q => q.id)) !== JSON.stringify(t2.map(q => q.id)))
  assert('全部 cat12', t1.every(q => Number(q.category_id) === 12))

  // ---------- ② Day1-6 练习完成 → 考试 ⊂ 已刷前缀 160 ----------
  console.log('\n[2] Day7 考试 ⊂ 本人已刷题（前缀 160）')
  const sbA = makeSandbox('alice')
  setProgress(sbA, [[1, 1], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]])
  const prefix160 = vm.runInContext('challengePool().slice(0,160).map(q => q.id)', sbA)
  const e1 = vm.runInContext('challengeStageQuestions(7,1)', sbA)
  const e2 = vm.runInContext('challengeStageQuestions(7,1)', sbA)
  assert('期末考试抽 20 题', e1.length === 20, `got ${e1.length}`)
  assert('考题全部出自已刷过的 160 题', e1.every(q => prefix160.includes(q.id)),
    'leak: ' + e1.filter(q => !prefix160.includes(q.id)).map(q => q.id).join(','))
  assert('分层 难度1×10+2×7+3×3 不变', JSON.stringify([1, 2, 3].map(d => e1.filter(q => Number(q.difficulty) === d).length)) === JSON.stringify([10, 7, 3]))
  assert('两次进入不同（随机）', JSON.stringify(e1.map(q => q.id)) !== JSON.stringify(e2.map(q => q.id)))
  assert('选项已重洗（含 options 字段）', e1.every(q => Array.isArray(q.options) && q.options.length >= 2))

  // ---------- ③ Day7 练习也完成 → 前缀 170 ----------
  console.log('\n[3] 全部练习完成（前缀 170）')
  const sbA2 = makeSandbox('alice')
  setProgress(sbA2, [[1, 1], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]])
  const pool170 = vm.runInContext('challengePool().map(q => q.id)', sbA2)
  const e3 = vm.runInContext('challengeStageQuestions(7,1)', sbA2)
  assert('考题全部出自本人 170 题序列', e3.every(q => pool170.includes(q.id)))

  // ---------- ④ 不同用户考题出自各自序列 ----------
  console.log('\n[4] 每人考自己的题')
  const sbB = makeSandbox('bob')
  setProgress(sbB, [[1, 1], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]])
  const bPool = vm.runInContext('challengePool().slice(0,160).map(q => q.id)', sbB)
  const eB = vm.runInContext('challengeStageQuestions(7,1)', sbB)
  assert('bob 考题 ⊂ bob 已刷前缀', eB.every(q => bPool.includes(q.id)))
  assert('alice 与 bob 考题不完全相同', JSON.stringify(e1.map(q => q.id)) !== JSON.stringify(eB.map(q => q.id)))

  // ---------- ⑤ 练习切片不受影响 ----------
  console.log('\n[5] 练习环节不受影响')
  const s2 = vm.runInContext('challengeStageQuestions(2,0).map(q => q.id)', sbA)
  assert('Day2 练习仍 = 序列[10..40)', JSON.stringify(s2) === JSON.stringify(pool170.slice(10, 40)))

  // ---------- ⑥ i18n 文案 ----------
  console.log('\n[6] i18n 提示文案')
  {
    const src = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const zh = (src.match(/考题出自本人已刷题目/g) || []).length
    const en = (src.match(/exam questions come from your practiced set/g) || []).length
    assert('chPoolInfo zh/en 均含考题出处说明', zh === 1 && en === 1, `zh=${zh} en=${en}`)
  }

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v80 测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
