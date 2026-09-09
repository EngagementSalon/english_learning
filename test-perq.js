// ====== 测试 perq：每道题正确率（上报 + 云端聚合） ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
function done(extra) {
  console.log(extra ? (testFailed ? `❌ 失败: ${extra}` : `✅ ${extra} 通过`) : (testFailed ? '❌ 有失败' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
}

// CloudSync mock：捕获入队事件 + 可注入 fetchSyncSummary
function makeCloudMock() {
  return {
    queue: [],
    enqueue(ev) { this.queue.push(ev) },
    pushPending() { return Promise.resolve() },
    setUser() {},
    flushDuration() {},
  }
}

function makeSandbox({ prefetchedStore = {}, cloudMock }) {
  const sb = {
    localStorage: {
      store: Object.assign({}, prefetchedStore),
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setInterval() { return 0 },
    clearInterval() {},
    setTimeout() { return 0 },
    clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    TextEncoder, Uint8Array, crypto,
    CloudSync: cloudMock,
    t: (k) => k,
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  return sb
}

// 加载 cloud-store.js，注入 window/document
function loadCloudStore() {
  const lsStore = {}
  const ls = {
    store: lsStore,
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
  const sb = {
    localStorage: ls,
    console,
    setInterval() { return 0 }, clearInterval() {},
    setTimeout() { return 0 }, clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    TextEncoder, Uint8Array, crypto,
    CloudSync: makeCloudMock(),
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
  return vm.runInContext('CloudSync', sb)
}

;(async () => {
  // ===== 场景 1：addProgress 触发 perq 上报 =====
  console.log('\n🧪 场景 1：addProgress 触发每道题明细上报')
  {
    const cloudMock = makeCloudMock()
    const sb = makeSandbox({
      prefetchedStore: {
        eq_users: JSON.stringify([{ id: 1, username: 'alice', ph: 'x', salt: 'y', name: 'Alice', dept: '', role: 'student', createdAt: 100 }]),
        eq_counter: '100',
        eq_session: JSON.stringify({ id: 1, username: 'alice', name: 'Alice', role: 'student' }),
        eq_questions: JSON.stringify([{ id: 1, category_id: 1, dept: 'dining', type: 'single', question: 'Q1', options: [], answer: [0], difficulty: 1 }]),
      },
      cloudMock,
    })
    const Store1 = vm.runInContext('Store', sb)
    Store1.addProgress({ question_id: 1, category_id: 1, dept: 'dining', type: 'single', correct: true, mode: 'practice' })
    Store1.addProgress({ question_id: 1, category_id: 1, dept: 'dining', type: 'single', correct: false, mode: 'practice' })
    const perq = cloudMock.queue.filter(e => e.ty === 'perq')
    assert('上报了 2 条 perq 事件', perq.length === 2)
    assert('perq 事件带用户名', perq.every(e => e.u === 'alice'))
    assert('perq 带 qid', perq.every(e => e.d && e.d.qid === 1))
    assert('perq 对错正确', perq[0].d.correct === 1 && perq[1].d.correct === 0)
  }

  // ===== 场景 2：云端 _apply 聚合 perq =====
  console.log('\n🧪 场景 2：云端 _apply 聚合每道题正确率')
  {
    const CloudSync = loadCloudStore()
    const map = {}
    ;[
      { u: 'alice', ty: 'register', d: {} },
      { u: 'alice', ty: 'perq', d: { qid: 5, correct: 1 } },
      { u: 'alice', ty: 'perq', d: { qid: 5, correct: 0 } },
      { u: 'alice', ty: 'perq', d: { qid: 5, correct: 1 } },
      { u: 'bob',   ty: 'perq', d: { qid: 5, correct: 0 } },
      { u: 'bob',   ty: 'perq', d: { qid: 7, correct: 1 } },
    ].forEach(ev => CloudSync._apply(map, ev))
    assert('alice 记录含 perQ', map.alice && map.alice.perQ)
    assert('qid5 累计 correct=2/total=3', map.alice.perQ['5'].correct === 2 && map.alice.perQ['5'].total === 3)
    assert('bob 的 qid5 correct=0/total=1', map.bob.perQ['5'].correct === 0 && map.bob.perQ['5'].total === 1)
    assert('bob 的 qid7 correct=1/total=1', map.bob.perQ['7'].correct === 1 && map.bob.perQ['7'].total === 1)
  }

  // ===== 场景 3：跨学员汇总（模拟 renderPerQBlock 的聚合逻辑） =====
  console.log('\n🧪 场景 3：跨学员合并每道题正确率')
  {
    // 两个学员的云端记录
    const rows = [
      { username: 'alice', role: 'student', perQ: { '5': { correct: 2, total: 3 }, '7': { correct: 1, total: 1 } } },
      { username: 'bob', role: 'student', perQ: { '5': { correct: 0, total: 1 }, '8': { correct: 1, total: 2 } } },
    ]
    const agg = {}
    rows.forEach(r => {
      if (!r.perQ) return
      Object.keys(r.perQ).forEach(qid => {
        const rec = r.perQ[qid]
        const a = agg[qid] || (agg[qid] = { correct: 0, total: 0 })
        a.correct += rec.correct; a.total += rec.total
      })
    })
    assert('qid5 跨学员 correct=2 total=4', agg['5'].correct === 2 && agg['5'].total === 4)
    assert('qid7 correct=1 total=1', agg['7'].correct === 1 && agg['7'].total === 1)
    assert('qid8 correct=1 total=2', agg['8'].correct === 1 && agg['8'].total === 2)
    const rate5 = Math.round(agg['5'].correct / agg['5'].total * 100)
    assert('qid5 正确率 50%', rate5 === 50)
  }

  done('perq 全部')
})().catch(e => { console.error('异常:', e); process.exit(1) })
