// ====== 测试 v101：修「开放失败请检查网络重试」——营次路径的写后校验失配 ======
// 用户报障：「一直提示开放失败请检查网络重试」（点看板「开放考试」/「开放挑战」）
//
// 根因：v88 起开关存在**营次记录**里（rec.examOpen / rec.open），但 setChallengeExamOpen /
//       setChallengeOpen 的写后校验读的是**顶层** check.chExamOpen / check.chOpen。
//       有营次时顶层字段压根不被写（只有无营次的兼容分支才写）→ 校验恒 false →
//       重试 4 次全废 → 返回 { ok:false, reason:'network' } → 前端弹「开放失败」。
//       ⚠️ 而 _putDoc 在校验前已执行 → 数据其实写进去了（假失败，云端状态实际已改）。
//       v76/v77 测试只覆盖「无营次」兼容路径 → 缺陷逃逸。
//
// 覆盖点：
// ① 有营次：setChallengeExamOpen(true/false) 返回 ok 且写进营次记录的 examOpen
// ② 有营次：setChallengeOpen(true/false) 返回 ok 且写进营次记录的 open
// ③ 校验真的按营次读回：写入被吞（PUT 无效）→ 正确返回失败（不能恒真）
// ④ 无营次兼容路径不回归（仍用顶层字段）
// ⑤ 营次 id 变化时不误判（指针换期后写入新期记录）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
}

const storeSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')

// 模拟 textdb.dev 的 fetch（对齐项目实现：GET 走 text()，PUT 走 POST；可配置「写无效」模拟校验必须失败）
function fetchImpl(state) {
  state.calls = { get: 0, put: 0 }
  return async (url, opt) => {
    opt = opt || {}
    if (opt.method === 'POST') {
      state.calls.put++
      if (state.failPut) throw new Error('network down')
      // dropWrite：模拟写入被静默丢弃（校验必须能识别失败）
      if (!state.dropWrite) state.doc = JSON.parse(opt.body)
      return { ok: true, status: 200 }
    }
    state.calls.get++
    return { ok: true, status: 200, text: async () => JSON.stringify(state.doc) }
  }
}

function makeSb(state) {
  const sb = {
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setInterval() { return 0 }, clearInterval() {},
    setTimeout() { return 0 }, clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {}, visibilityState: 'visible' },
    fetch: fetchImpl(state), AbortController: global.AbortController,
  }
  vm.createContext(sb)
  vm.runInContext(storeSrc, sb)
  return sb
}

// 带营次的云端文档（r1 当前指针；r2 存在但未开启）
function docWithRounds() {
  return {
    v: 1, base: {}, events: [],
    chRounds: [
      { id: 'r1', name: '第一期', open: false, examOpen: false, at: 0, depts: [] },
      { id: 'r2', name: '第二期', open: false, examOpen: false, at: 0, depts: [] },
    ],
    chRoundCur: 'r1',
  }
}

;(async () => {
  console.log('\n🧪 v101 营次路径写后校验（修「开放失败请检查网络重试」）')

  console.log('\n1️⃣  有营次：setChallengeExamOpen 真实成功（原恒失败）')
  {
    const state = { doc: docWithRounds(), calls: {} }
    const sb = makeSb(state)
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    assert('【核心】有营次时 setChallengeExamOpen(true) 返回 ok（修复前恒 ok:false/network）',
      !!res && res.ok === true, JSON.stringify(res))
    const r1 = state.doc.chRounds.find(r => r.id === 'r1')
    assert('写入当前营次 r1 的 examOpen=true', r1 && r1.examOpen === true)
    assert('未误写顶层 chExamOpen', state.doc.chExamOpen === undefined, JSON.stringify(state.doc.chExamOpen))
    assert('本地侧信道即时开启', vm.runInContext('CloudSync._chExamOpen === true', sb))
    assert('营次侧信道同步（_chRounds 里 r1.examOpen=true）',
      vm.runInContext(`(CloudSync._chRounds || []).find(r => r.id === 'r1').examOpen === true`, sb))

    const res2 = await vm.runInContext('CloudSync.setChallengeExamOpen(false)', sb)
    assert('关闭同样返回 ok', !!res2 && res2.ok === true, JSON.stringify(res2))
    assert('营次记录 examOpen=false', state.doc.chRounds.find(r => r.id === 'r1').examOpen === false)
    assert('侧信道关闭', vm.runInContext('CloudSync._chExamOpen === false', sb))
    assert('2 次操作 = 2 次 PUT（不再无谓重试 4 次）', state.calls.put === 2, 'put=' + state.calls.put)
  }

  console.log('\n2️⃣  有营次：setChallengeOpen 真实成功（同病同修）')
  {
    const state = { doc: docWithRounds(), calls: {} }
    const sb = makeSb(state)
    const res = await vm.runInContext('CloudSync.setChallengeOpen(true)', sb)
    assert('【核心】有营次时 setChallengeOpen(true) 返回 ok', !!res && res.ok === true, JSON.stringify(res))
    const r1 = state.doc.chRounds.find(r => r.id === 'r1')
    assert('写入当前营次 r1 的 open=true', r1 && r1.open === true)
    assert('开放时写 at 时间戳', r1 && Number(r1.at) > 0)
    assert('未误写顶层 chOpen', state.doc.chOpen === undefined, JSON.stringify(state.doc.chOpen))
    const res2 = await vm.runInContext('CloudSync.setChallengeOpen(false)', sb)
    assert('关闭返回 ok 且保留 at（学员端显示「已结束」）',
      !!res2 && res2.ok === true && state.doc.chRounds.find(r => r.id === 'r1').open === false && Number(state.doc.chRounds.find(r => r.id === 'r1').at) > 0)
  }

  console.log('\n3️⃣  校验真实有效（写入被吞 → 必须报失败，不能恒真）')
  {
    const state = { doc: docWithRounds(), calls: {}, dropWrite: true }
    const sb = makeSb(state)
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    assert('写入未生效 → ok:false / reason:network（校验不是摆设）',
      !!res && res.ok === false && res.reason === 'network', JSON.stringify(res))
    assert('重试 4 次 PUT', state.calls.put === 4, 'put=' + state.calls.put)
    assert('失败不污染侧信道', vm.runInContext('CloudSync._chExamOpen === false', sb))
  }

  console.log('\n4️⃣  无营次兼容路径不回归（仍走顶层字段）')
  {
    const state = { doc: { v: 1, base: {}, events: [] }, calls: {} }
    const sb = makeSb(state)
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    assert('无营次 → 仍返回 ok', !!res && res.ok === true, JSON.stringify(res))
    assert('写入顶层 chExamOpen=true', state.doc.chExamOpen === true)
    const res2 = await vm.runInContext('CloudSync.setChallengeOpen(true)', sb)
    assert('无营次 setChallengeOpen 仍 ok 且写顶层 chOpen', !!res2 && res2.ok === true && state.doc.chOpen === true)
  }

  console.log('\n5️⃣  当前指针指向哪个营次就写哪个（r2 为指针时写 r2）')
  {
    const state = { doc: docWithRounds(), calls: {} }
    state.doc.chRoundCur = 'r2'
    const sb = makeSb(state)
    const res = await vm.runInContext('CloudSync.setChallengeExamOpen(true)', sb)
    assert('指针 r2 → 返回 ok', !!res && res.ok === true, JSON.stringify(res))
    assert('写进 r2.examOpen 而非 r1',
      state.doc.chRounds.find(r => r.id === 'r2').examOpen === true && state.doc.chRounds.find(r => r.id === 'r1').examOpen === false)
  }

  console.log('\n6️⃣  源码口径固化（防回退成读顶层）')
  {
    const examFn = storeSrc.slice(storeSrc.indexOf('async setChallengeExamOpen'), storeSrc.indexOf('async setChallengeOpen'))
    const openFn = storeSrc.slice(storeSrc.indexOf('async setChallengeOpen'), storeSrc.indexOf('async _roundWrite'))
    assert('setChallengeExamOpen 写后校验按营次读回（含 wantId 分支 + _roundsNorm(check)）',
      /wantId/.test(examFn) && /_roundsNorm\(check\)/.test(examFn) && /chk\.examOpen === val/.test(examFn))
    assert('setChallengeOpen 写后校验按营次读回',
      /wantId/.test(openFn) && /_roundsNorm\(check\)/.test(openFn) && /chk\.open === val/.test(openFn))
    assert('两函数均保留顶层兼容分支（无营次不回归）',
      /check\.chExamOpen === val/.test(examFn) && /check\.chOpen === val/.test(openFn))
  }

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ v101 全部断言通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
