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

  // ===== 场景 2：云端 _apply 聚合 perq（v75 瘦身语义） =====
  console.log('\n🧪 场景 2：云端 _apply 聚合（全局 __q + 个人只记错题）')
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
    assert('全局聚合 __q[5] = [correct 2, total 4]（跨学员含对/错全量）', map.__q && Array.isArray(map.__q['5']) && map.__q['5'][0] === 2 && map.__q['5'][1] === 4, JSON.stringify(map.__q))
    assert('全局聚合 __q[7] = [1, 1]', map.__q['7'][0] === 1 && map.__q['7'][1] === 1)
    assert('alice 个人只记错题：perQ[5] = {correct:0, total:1}', map.alice.perQ['5'].correct === 0 && map.alice.perQ['5'].total === 1, JSON.stringify(map.alice.perQ))
    assert('bob 个人只记错题：perQ[5] = {correct:0, total:1}', map.bob.perQ['5'].correct === 0 && map.bob.perQ['5'].total === 1)
    assert('答对不再逐题记录：bob 无 perQ[7]', !map.bob.perQ['7'])
    assert('__q 不混入用户名单（无 username 字段）', map.__q.username === undefined)
  }

  // ===== 场景 2b：perqfix 剔除无效错答（v75 同步修 __q 分母） =====
  console.log('\n🧪 场景 2b：perqfix 修正')
  {
    const CloudSync = loadCloudStore()
    const map = {}
    ;[
      { u: 'bob', ty: 'register', d: {} },
      { u: 'bob', ty: 'perq', d: { qid: 9, correct: 0 } },
      { u: 'bob', ty: 'perq', d: { qid: 9, correct: 0 } },
      { u: 'bob', ty: 'perqfix', d: { qid: 9, wrongFix: 1 } },
    ].forEach(ev => CloudSync._apply(map, ev))
    assert('__q[9] 分母剔除后 [0, 1]', map.__q['9'][0] === 0 && map.__q['9'][1] === 1, JSON.stringify(map.__q['9']))
    assert('个人错次回退 total=1', map.bob.perQ['9'].total === 1)
    assert('perqfix 不低于已答对数（全对后剔除不多扣）', (() => {
      const m2 = {}
      CloudSync._apply(m2, { u: 'x', ty: 'perq', d: { qid: 3, correct: 1 } })
      CloudSync._apply(m2, { u: 'x', ty: 'perqfix', d: { qid: 3, wrongFix: 5 } })
      return m2.__q['3'][1] === 1
    })())
  }

  // ===== 场景 2c：base 老用户缺 perQ 字段（线上早期折叠产物）+ perq 事件不崩 =====
  console.log('\n🧪 场景 2c：base 老用户无 perQ 字段时重放 perq 不崩')
  {
    const CloudSync = loadCloudStore()
    // 模拟云端 base：oldcarl 是早期版本折叠的用户，没有 perQ 字段
    const map = {
      oldcarl: { username: 'oldcarl', name: 'Carl', loginCount: 3, loginSec: 600, examCount: 1 },
    }
    // 该用户在 events 里仍有 perq 事件（线上 2026-09-13 真实数据形态，qid='71' 曾触发 TypeError）
    CloudSync._apply(map, { u: 'oldcarl', ty: 'perq', d: { qid: 71, correct: 0 } })
    assert('缺 perQ 的 base 用户答错：自动补建 perQ 表', !!map.oldcarl.perQ && typeof map.oldcarl.perQ === 'object')
    assert('perQ[71] = {correct:0, total:1} 正常累计', map.oldcarl.perQ['71'] && map.oldcarl.perQ['71'].correct === 0 && map.oldcarl.perQ['71'].total === 1, JSON.stringify(map.oldcarl.perQ))
    assert('loginCount 等旧字段保持', map.oldcarl.loginCount === 3 && map.oldcarl.examCount === 1)
    assert('全局 __q[71] = [0, 1] 同步累计', map.__q && map.__q['71'][0] === 0 && map.__q['71'][1] === 1)
    // 答对路径同样不崩（不建 perQ 条目）
    CloudSync._apply(map, { u: 'oldcarl', ty: 'perq', d: { qid: 72, correct: 1 } })
    assert('缺 perQ 的 base 用户答对：不建条目、不崩', !map.oldcarl.perQ['72'])
    assert('全局 __q[72] = [1, 1]', map.__q['72'][0] === 1 && map.__q['72'][1] === 1)
    // 挑战错答路径（chQ 一直有兜底，复核）
    CloudSync._apply(map, { u: 'oldcarl', ty: 'perq', d: { qid: 73, correct: 0, ch: 1 } })
    assert('挑战错答 chQ[73] 正常累计', map.oldcarl.chQ && map.oldcarl.chQ['73'] && map.oldcarl.chQ['73'].total === 1)
  }

  // ===== 场景 3：跨学员汇总（模拟 renderPerQBlock 的 v75 合并逻辑） =====
  console.log('\n🧪 场景 3：看板合并（__q 优先 + 旧 perQ 补充）')
  {
    // v75 新语义：__q 全量 + 个人 perQ 只剩错题
    const qstats = { '5': [3, 6], '7': [1, 1] }   // CloudSync._lastQStats 形态
    const rows = [
      { username: 'alice', perQ: { '5': { correct: 0, total: 1 } } },
      { username: 'bob', perQ: { '5': { correct: 0, total: 1 } } },
    ]
    const agg = {}
    Object.keys(qstats).forEach(qid => {
      const a = qstats[qid]
      if (a && a.length === 2) agg[qid] = { correct: a[0], total: a[1] }
    })
    rows.forEach(r => {
      if (!r.perQ) return
      Object.keys(r.perQ).forEach(qid => {
        if (agg[qid]) return   // __q 已含该题，跳过防双算
        const rec = r.perQ[qid]
        const a = agg[qid] || (agg[qid] = { correct: 0, total: 0 })
        a.correct += rec.correct; a.total += rec.total
      })
    })
    assert('qid5 用 __q：correct=3 total=6（perQ 错题不双算）', agg['5'].correct === 3 && agg['5'].total === 6, JSON.stringify(agg['5']))
    assert('qid7 用 __q：correct=1 total=1', agg['7'].correct === 1 && agg['7'].total === 1)
    assert('qid5 正确率 50%', Math.round(agg['5'].correct / agg['5'].total * 100) === 50)
    // 兼容旧数据：__q 没有的题由 perQ（完整旧记录）补充
    const rowsOld = [{ username: 'old', perQ: { '8': { correct: 1, total: 2 } } }]
    rowsOld.forEach(r => {
      Object.keys(r.perQ).forEach(qid => {
        if (agg[qid]) return
        const rec = r.perQ[qid]
        agg[qid] = { correct: rec.correct, total: rec.total }
      })
    })
    assert('旧 perQ（__q 缺失时）正确补充：qid8 = 1/2', agg['8'].correct === 1 && agg['8'].total === 2)
  }

  done('perq 全部')
})().catch(e => { console.error('异常:', e); process.exit(1) })
