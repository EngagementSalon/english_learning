// 测试云端定级重算 recalcCloudPlacementLevels
const fs = require('fs'), vm = require('vm')

async function main() {

// ---- mock 环境 ----
const store = {}
const storeObj = {
  getItem: (k) => store[k] || null,
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] },
}
const mockFetch = (url, opts) => {
  // 模拟云端文档
  const doc = JSON.parse(store.__cloud_doc__ || '{"v":1,"base":{},"events":[]}')
  if (!opts || !opts.method) {
    // GET
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(doc))
    })
  }
  if (opts.method === 'POST') {
    // 写入
    store.__cloud_doc__ = opts.body
    return Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') })
  }
  return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') })
}

const ctx = {
  localStorage: storeObj,
  fetch: mockFetch,
  console,
  AbortController: class { abort(){} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  window: { addEventListener(){} },
  document: { addEventListener(){} },
}
vm.createContext(ctx)

// 加载 cloud-store.js（末尾追加暴露到 globalThis）
const code = fs.readFileSync('cloud-store.js', 'utf8') + '\nglobalThis.__CloudSync = CloudSync;'
vm.runInContext(code, ctx)

const CS = ctx.__CloudSync

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok  ' + name) }
  else { fail++; console.log('  FAIL ' + name) }
}

// ====== 测试 1：有 perLevel → 精确重算 ======
console.log('== 测试 1：perLevel 精确重算 ==')
store.__cloud_doc__ = JSON.stringify({
  v: 1, base: {},
  events: [
    { id: 'e1', u: 'alice', n: 'Alice', ty: 'placement', ts: 1000,
      d: { level: 4, score: 8, total: 24,
        perLevel: { 1:{correct:1,total:6}, 2:{correct:1,total:6}, 3:{correct:3,total:6}, 4:{correct:3,total:6} } } }
  ]
})
delete store['eq_cloud_recalc_v2']
delete store['eq_pending']

let res1 = await CS.recalcCloudPlacementLevels()
ok('重算执行 done=true', res1.done === true)
ok('修正了 1 人 changed=1', res1.changed === 1)
ok('flag 已设置', store['eq_cloud_recalc_v2'] === '1')

// 检查推送的修正事件（pushPending 已写入云端文档）
const doc1 = JSON.parse(store.__cloud_doc__)
const corr1 = (doc1.events || []).find(e => e.id === 'recalc_v2_alice')
ok('修正事件已写入云端', !!corr1)
ok('修正等级=1（L1 17% 不达标）', corr1 && corr1.d.level === 1)

// 再次调用应跳过
let res1b = await CS.recalcCloudPlacementLevels()
ok('二次调用幂等 reason=already', res1b.done === false && res1b.reason === 'already')

// ====== 测试 2：无 perLevel → 启发式重算 ======
console.log('== 测试 2：score 启发式重算 ==')
store.__cloud_doc__ = JSON.stringify({
  v: 1, base: {},
  events: [
    // bob: 旧逻辑定 L4，score=8/24 → 启发式 maxLevel=floor(8/4)=2 → 修正为 L2
    { id: 'e2', u: 'bob', n: 'Bob', ty: 'placement', ts: 2000,
      d: { level: 4, score: 8, total: 24 } },
    // carol: 旧逻辑定 L3，score=6/24 → maxLevel=floor(6/4)=1 → 修正为 L1
    { id: 'e3', u: 'carol', n: 'Carol', ty: 'placement', ts: 3000,
      d: { level: 3, score: 6, total: 24 } },
    // dave: L4 score=18/24 → maxLevel=floor(18/4)=4 → 不变
    { id: 'e4', u: 'dave', n: 'Dave', ty: 'placement', ts: 4000,
      d: { level: 4, score: 18, total: 24 } },
    // eve: L1 → 不处理
    { id: 'e5', u: 'eve', n: 'Eve', ty: 'placement', ts: 5000,
      d: { level: 1, score: 2, total: 24 } },
  ]
})
delete store['eq_cloud_recalc_v2']
delete store['eq_pending']

let res2 = await CS.recalcCloudPlacementLevels()
ok('修正了 2 人 (bob+carol)', res2.changed === 2)
const doc2 = JSON.parse(store.__cloud_doc__)
const corrBob = (doc2.events || []).find(e => e.u === 'bob' && e.d && e.d.corrected)
const corrCarol = (doc2.events || []).find(e => e.u === 'carol' && e.d && e.d.corrected)
ok('bob 修正为 L2 (score=8→floor(8/4)=2)', corrBob && corrBob.d.level === 2)
ok('carol 修正为 L1 (score=6→floor(6/4)=1)', corrCarol && corrCarol.d.level === 1)
// dave 和 eve 不应有修正事件
const corrDave = (doc2.events || []).find(e => e.u === 'dave' && e.d && e.d.corrected)
const corrEve = (doc2.events || []).find(e => e.u === 'eve' && e.d && e.d.corrected)
ok('dave 不修正 (score=18→maxLevel=4≥L4)', !corrDave)
ok('eve 不修正 (已 L1)', !corrEve)

// ====== 测试 3：base 中已折叠的旧数据 ======
console.log('== 测试 3：base 聚合数据（事件已折叠）==')
store.__cloud_doc__ = JSON.stringify({
  v: 1,
  base: {
    'frank': { username: 'frank', name: 'Frank', placementLevel: 4, placementScore: 10, placementTotal: 24, lastActive: 1000 },
    'grace': { username: 'grace', name: 'Grace', placementLevel: 2, lastActive: 2000 }, // 无 score，无法重算
  },
  events: []
})
delete store['eq_cloud_recalc_v2']
delete store['eq_pending']

let res3 = await CS.recalcCloudPlacementLevels()
ok('frank 修正 (score=10→floor(10/4)=2<L4)', res3.changed === 1)
const doc3 = JSON.parse(store.__cloud_doc__)
const corrFrank = (doc3.events || []).find(e => e.u === 'frank' && e.d && e.d.corrected)
ok('frank 修正为 L2', corrFrank && corrFrank.d.level === 2)
const corrGrace = (doc3.events || []).find(e => e.u === 'grace' && e.d && e.d.corrected)
ok('grace 无 score 无法重算→跳过', !corrGrace)

// ====== 测试 4：所有等级已正确 → 无修正 ======
console.log('== 测试 4：无需修正 ==')
store.__cloud_doc__ = JSON.stringify({
  v: 1, base: {},
  events: [
    { id: 'e10', u: 'henry', n: 'Henry', ty: 'placement', ts: 1000,
      d: { level: 1, score: 2, total: 24 } },
  ]
})
delete store['eq_cloud_recalc_v2']
delete store['eq_pending']

let res4 = await CS.recalcCloudPlacementLevels()
ok('无修正 changed=0', res4.changed === 0)
ok('flag 仍设置', store['eq_cloud_recalc_v2'] === '1')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
}

main()
