// ====== 测试 v79：练习题序人手一套（种子 = CHALLENGE_SEED + 用户名哈希） ======
// ① 同一用户：两次生成完全一致（可复现）；170 题唯一
// ② 不同用户：题序不同（Day1 巩固练习切片即可区分）；序列长度/唯一性不变
// ③ 不变量保持：难度逐日严格递增、Day1 无难度3 / Day7 含难度3、每日难度配比 = CHALLENGE_DIFF_PLAN、
//    练习阶段切片与个人序列对应、测试环节仍每次随机
// ④ i18n：chPoolInfo 文案含「每人题目随机不同」（zh/en）
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

// 沙箱：真实 store/bank/i18n + challenge.js；username 指定登录用户（null = 未登录 anon）
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

const CH_PLAN = JSON.parse(JSON.stringify([[10, 0, 0], [24, 6, 0], [19, 11, 0], [14, 16, 0], [9, 20, 1], [5, 23, 2], [1, 6, 3]]))
const SPANS = [[0, 10], [10, 40], [40, 70], [70, 100], [100, 130], [130, 160], [160, 170]]

;(async () => {
  console.log('\n🧪 v79 练习题序人手一套（用户名派生种子）测试')

  // ---------- ① 同一用户可复现 ----------
  console.log('\n[1] 同一用户序列可复现')
  const sbA = makeSandbox('alice')
  const p1 = vm.runInContext('challengePool().map(q => q.id)', sbA)
  const p2 = vm.runInContext('challengePool().map(q => q.id)', sbA)
  assert('170 题且 id 唯一', p1.length === 170 && new Set(p1).size === 170, `got ${p1.length}/${new Set(p1).size}`)
  assert('同一用户两次生成完全一致', JSON.stringify(p1) === JSON.stringify(p2))

  // ---------- ② 不同用户序列不同 ----------
  console.log('\n[2] 不同用户序列不同')
  const sbB = makeSandbox('bob')
  const pb = vm.runInContext('challengePool().map(q => q.id)', sbB)
  const sbC = makeSandbox('carol')
  const pc = vm.runInContext('challengePool().map(q => q.id)', sbC)
  const sbAnon = makeSandbox(null)
  const pa = vm.runInContext('challengePool().map(q => q.id)', sbAnon)
  assert('alice ≠ bob（题序不同）', JSON.stringify(p1) !== JSON.stringify(pb))
  assert('bob ≠ carol', JSON.stringify(pb) !== JSON.stringify(pc))
  assert('alice ≠ 未登录 anon', JSON.stringify(p1) !== JSON.stringify(pa))
  assert('bob 序列同样 170 题唯一', pb.length === 170 && new Set(pb).size === 170)
  {
    const aD1 = vm.runInContext('challengeStageQuestions(1,1).map(q => q.id)', sbA)
    const bD1 = vm.runInContext('challengeStageQuestions(1,1).map(q => q.id)', sbB)
    assert('Day1 巩固练习：alice 与 bob 题目不同', JSON.stringify(aD1) !== JSON.stringify(bD1))
    const aD7 = vm.runInContext('challengeStageQuestions(7,0).map(q => q.id)', sbA)
    const bD7 = vm.runInContext('challengeStageQuestions(7,0).map(q => q.id)', sbB)
    assert('Day7 巩固练习：alice 与 bob 题目不同', JSON.stringify(aD7) !== JSON.stringify(bD7))
  }

  // ---------- ③ 不变量保持（alice 全查） ----------
  console.log('\n[3] 难度递增与配比不变量（alice）')
  {
    const avgs = SPANS.map(([a, b]) => {
      const qs = vm.runInContext(`challengePool().slice(${a},${b})`, sbA)
      return qs.reduce((s, q) => s + (Number(q.difficulty) || 1), 0) / qs.length
    })
    assert('练习难度逐天严格递增', avgs.every((v, i) => i === 0 || v > avgs[i - 1]), `avg=${avgs.map(v => v.toFixed(2)).join('→')}`)
    assert('Day1 均值 ≤ 1.2', avgs[0] <= 1.2, `got ${avgs[0].toFixed(2)}`)
    assert('Day7 均值 ≥ 2.1', avgs[6] >= 2.1, `got ${avgs[6].toFixed(2)}`)
  }
  {
    let ok = true, detail = ''
    SPANS.forEach(([a, b], i) => {
      const qs = vm.runInContext(`challengePool().slice(${a},${b})`, sbA)
      const dist = [1, 2, 3].map(d => qs.filter(q => (Number(q.difficulty) || 1) === d).length)
      if (JSON.stringify(dist) !== JSON.stringify(CH_PLAN[i])) { ok = false; detail += ` day${i + 1}:${dist}` }
    })
    assert('每日难度配比 = CHALLENGE_DIFF_PLAN（7 天全对）', ok, detail)
  }
  assert('Day1 练习无难度 3 题', vm.runInContext('challengePool().slice(0,10).every(q => Number(q.difficulty) < 3)', sbA))
  assert('Day7 练习含难度 3 题', vm.runInContext('challengePool().slice(160,170).some(q => Number(q.difficulty) === 3)', sbA))
  {
    const s2 = vm.runInContext('challengeStageQuestions(2,0).map(q => q.id)', sbA)
    assert('Day2 练习 = alice 序列[10..40)', JSON.stringify(s2) === JSON.stringify(p1.slice(10, 40)))
  }
  {
    const t1 = vm.runInContext('challengeStageQuestions(1,0)', sbA)
    const t2 = vm.runInContext('challengeStageQuestions(1,0)', sbA)
    assert('测试环节仍每次随机（两次进入不同）', t1.length === 20 && JSON.stringify(t1.map(q => q.id)) !== JSON.stringify(t2.map(q => q.id)))
    const dist = [1, 2, 3].map(d => t1.filter(q => Number(q.difficulty) === d).length)
    assert('测试分层 难度1×10+2×7+3×3 不变', JSON.stringify(dist) === JSON.stringify([10, 7, 3]), JSON.stringify(dist))
  }

  // ---------- ④ i18n 文案 ----------
  console.log('\n[4] i18n 提示文案')
  {
    const src = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
    const zh = (src.match(/每人题目随机不同/g) || []).length
    const en = (src.match(/questions vary per person/g) || []).length
    assert('chPoolInfo zh/en 均含「每人题目随机不同」', zh === 1 && en === 1, `zh=${zh} en=${en}`)
  }

  console.log(testFailed ? '\n❌ 有断言失败' : '\n✅ v79 测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
