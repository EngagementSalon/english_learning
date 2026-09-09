// 测试 recalcPlacementLevels 迁移逻辑
const vm = require('vm'), fs = require('fs')
let pass = 0, fail = 0
function ok(name, cond) { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }

// mock localStorage
const store = {}
const localStorage = {
  getItem: k => store[k] || null,
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: k => { delete store[k] },
}

// mock 全局
const ctx = {
  localStorage,
  console,
  BANK: { version: 5, questions: [], categories: [] },
}
// levelOf 依赖 Store 内部 LEVEL_RULES — 不需要，recalc 不调 levelOf
ctx.globalThis = ctx
vm.createContext(ctx)

// 加载 store.js（定义 Store）
const storeCode = fs.readFileSync('store.js', 'utf8') + '\nglobalThis.__Store = Store;'
vm.runInContext(storeCode, ctx)

const Store = ctx.__Store

// === 准备：模拟旧定级数据 ===
// 用户1：旧逻辑定 L4（L1 17% / L2 17% / L3 50% / L4 50%）→ 新逻辑应为 L1
// 用户2：旧逻辑定 L3（L1 83% / L2 67% / L3 50% / L4 83%）→ 新逻辑应为 L2
// 用户3：旧逻辑定 L2（L1 67% / L2 33% / L3 0% / L4 0%）→ 新逻辑应为 L1
// 用户4：旧逻辑定 L1（L1 17%）→ 新逻辑仍 L1

store['eq_users'] = JSON.stringify([
  { id: 1, username: 'alice', name: 'Alice', level: 4, placedAt: 1000 },
  { id: 2, username: 'bob', name: 'Bob', level: 3, placedAt: 2000 },
  { id: 3, username: 'carol', name: 'Carol', level: 2, placedAt: 3000 },
  { id: 4, username: 'dave', name: 'Dave', level: 1, placedAt: 4000 },
])

store['eq_placement_history'] = JSON.stringify([
  { id: 1, userId: 1, username: 'alice', name: 'Alice', level: 4, score: 8, total: 24,
    perLevel: { 1: {correct:1,total:6}, 2: {correct:1,total:6}, 3: {correct:3,total:6}, 4: {correct:3,total:6} },
    timestamp: 1000 },
  { id: 2, userId: 2, username: 'bob', name: 'Bob', level: 3, score: 14, total: 24,
    perLevel: { 1: {correct:5,total:6}, 2: {correct:4,total:6}, 3: {correct:3,total:6}, 4: {correct:2,total:6} },
    timestamp: 2000 },
  { id: 3, userId: 3, username: 'carol', name: 'Carol', level: 2, score: 6, total: 24,
    perLevel: { 1: {correct:4,total:6}, 2: {correct:2,total:6}, 3: {correct:0,total:6}, 4: {correct:0,total:6} },
    timestamp: 3000 },
  { id: 4, userId: 4, username: 'dave', name: 'Dave', level: 1, score: 2, total: 24,
    perLevel: { 1: {correct:1,total:6}, 2: {correct:1,total:6}, 3: {correct:0,total:6}, 4: {correct:0,total:6} },
    timestamp: 4000 },
])

store['eq_counter'] = '100'
// mock session: 设为用户1（alice）
store['eq_session'] = JSON.stringify({ id: 1, username: 'alice', name: 'Alice' })

// 执行前确认旧等级
console.log('== recalcPlacementLevels 迁移测试 ==')
const beforeUsers = JSON.parse(store['eq_users'])
ok('执行前 alice=L4', beforeUsers.find(u=>u.id===1).level === 4)
ok('执行前 bob=L3', beforeUsers.find(u=>u.id===2).level === 3)
ok('执行前 carol=L2', beforeUsers.find(u=>u.id===3).level === 2)
ok('执行前 dave=L1', beforeUsers.find(u=>u.id===4).level === 1)

// 执行重算
Store.recalcPlacementLevels()

// 验证等级已更新
const afterUsers = JSON.parse(store['eq_users'])
ok('执行后 alice=L1（旧 bug 修正）', afterUsers.find(u=>u.id===1).level === 1)
ok('执行后 bob=L2（L3 50% 不达标）', afterUsers.find(u=>u.id===2).level === 2)
ok('执行后 carol=L1（L2 33% 不达标）', afterUsers.find(u=>u.id===3).level === 1)
ok('执行后 dave=L1（不变）', afterUsers.find(u=>u.id===4).level === 1)

// 验证历史记录也更新了
const afterHist = JSON.parse(store['eq_placement_history'])
ok('历史 alice level→1', afterHist.find(h=>h.userId===1).level === 1)
ok('历史 bob level→2', afterHist.find(h=>h.userId===2).level === 2)
ok('历史 carol level→1', afterHist.find(h=>h.userId===3).level === 1)
ok('历史 dave level=1（不变）', afterHist.find(h=>h.userId===4).level === 1)

// 验证 flag 已设置（不会重复执行）
ok('迁移 flag 已设置', store['eq_placement_recalc_v2'] === '1')

// 再次调用应该不执行（幂等）
Store.recalcPlacementLevels()
const afterUsers2 = JSON.parse(store['eq_users'])
ok('二次调用幂等 alice 仍=L1', afterUsers2.find(u=>u.id===1).level === 1)

// 验证活动日志（trackPlacement 对当前用户 alice）
const acts = JSON.parse(store['eq_activity'] || '[]')
const placementActs = acts.filter(a => a.type === 'placement')
ok('当前用户(alice)上报了新等级到活动日志', placementActs.length > 0 && placementActs[0].data.level === 1)

console.log('\n结果: ' + pass + ' 通过 ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
