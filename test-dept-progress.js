// ====== 测试：分类进度按部门统计 + 管理页 deptExact 精确过滤 ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

// 构造沙箱
const sandbox = {
  localStorage: {
    store: { 'eq_course_only_v43': '1' },   /* v43 清空与本测试无关，预置 flag 跳过 */
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {},
  document: { addEventListener() {} },
  t: (key) => {
    const tree = {
      deptTree: {
        dining: { name: '饮食部', subs: ['标帜餐厅'] },
        rooms: { name: '房务部', subs: ['前台'] },
        other: { name: '其他部门', subs: [] },
      }
    }
    return tree[key] || key
  },
}
vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
const BANK = vm.runInContext('BANK', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

Store.init()

;(async () => {
  console.log('\n🧪 分类进度按部门 + 管理页精确过滤测试')

  const allQs = Store.getQuestions()
  const diningQs = allQs.filter(q => q.dept === 'dining')
  const roomsQs = allQs.filter(q => q.dept === 'rooms')
  const allDeptQs = allQs.filter(q => q.dept === 'all')

  // 1. getStats() 无参 = 全量
  console.log('\n1️⃣  getStats 部门过滤')
  const sAll = Store.getStats()
  assert('getStats() totalQuestions = 全库', sAll.totalQuestions === allQs.length, `got ${sAll.totalQuestions}`)
  assert('getStats() 分类 1 totalQuestions = 全库分类1', sAll.categoryStats.find(c => c.id === 1).totalQuestions === allQs.filter(q => q.category_id === 1).length)

  const sDining = Store.getStats('dining')
  assert('getStats(dining) totalQuestions = dining+all', sDining.totalQuestions === diningQs.length + allDeptQs.length, `got ${sDining.totalQuestions}`)
  const cat1Dining = sDining.categoryStats.find(c => c.id === 1)
  assert('getStats(dining) 分类1 = dining 分类1 题数', cat1Dining.totalQuestions === diningQs.filter(q => q.category_id === 1).length, `got ${cat1Dining.totalQuestions}`)
  const cat12Dining = sDining.categoryStats.find(c => c.id === 12)
  assert('getStats(dining) 分类12 = dining 分类12 题数（标帜餐厅词汇全 dining）', cat12Dining && cat12Dining.totalQuestions === diningQs.filter(q => q.category_id === 12).length,
    `got ${cat12Dining && cat12Dining.totalQuestions} 期望 ${diningQs.filter(q => q.category_id === 12).length}`)

  const sRooms = Store.getStats('rooms')
  assert('getStats(rooms) totalQuestions = rooms+all', sRooms.totalQuestions === roomsQs.length + allDeptQs.length, `got ${sRooms.totalQuestions}`)
  const cat1Rooms = sRooms.categoryStats.find(c => c.id === 1)
  assert('getStats(rooms) 分类1 = 0（暂无房务题）', cat1Rooms.totalQuestions === 0, `got ${cat1Rooms.totalQuestions}`)

  const sOther = Store.getStats('other')
  assert('getStats(other) = 全库', sOther.totalQuestions === allQs.length)
  const sEmpty = Store.getStats('')
  assert('getStats(空) = 全库', sEmpty.totalQuestions === allQs.length)

  // 2. 塞入 progress 验证 answered 与分类正确率
  console.log('\n2️⃣  分类进度 answered/accuracy')
  // 模拟：答了 2 道分类1 dining 题（1 对 1 错）
  const p1 = diningQs.find(q => q.category_id === 1)
  const p2 = diningQs.filter(q => q.category_id === 1)[1]
  Store.addProgress({ question_id: p1.id, category_id: 1, dept: 'dining', type: p1.type, correct: true, mode: 'practice' })
  Store.addProgress({ question_id: p2.id, category_id: 1, dept: 'dining', type: p2.type, correct: false, mode: 'practice' })
  // 模拟：答了 1 道分类12（标帜餐厅词汇，dining）题 —— v67 后分类表为 线下课题库+标帜餐厅常见词汇
  const p3 = diningQs.find(q => q.category_id === 12)
  Store.addProgress({ question_id: p3.id, category_id: 12, dept: 'dining', type: p3.type, correct: true, mode: 'practice' })

  const sDining2 = Store.getStats('dining')
  const cat1b = sDining2.categoryStats.find(c => c.id === 1)
  assert('分类1 answered = 2', cat1b.answered === 2, `got ${cat1b.answered}`)
  assert('分类1 accuracy = 50%', cat1b.accuracy === 50, `got ${cat1b.accuracy}`)
  const cat12b = sDining2.categoryStats.find(c => c.id === 12)
  assert('分类12 answered = 1', cat12b.answered === 1, `got ${cat12b.answered}`)
  assert('分类12 accuracy = 100%', cat12b.accuracy === 100, `got ${cat12b.accuracy}`)

  // progress 记录带 dept
  const prog = Store.getProgress()
  assert('progress 记录带 dept 字段', prog.every(p => 'dept' in p), '有记录缺 dept')

  // 3. queryQuestions deptExact（管理页 tab 用）
  console.log('\n3️⃣  queryQuestions deptExact')
  const { total: tDining } = Store.queryQuestions({ deptExact: 'dining' })
  assert('deptExact=dining 只含 dining 题', tDining === diningQs.length, `got ${tDining}`)
  const { total: tRooms } = Store.queryQuestions({ deptExact: 'rooms' })
  assert('deptExact=rooms 只含 rooms 题', tRooms === roomsQs.length, `got ${tRooms}`)
  const { total: tAll } = Store.queryQuestions({ deptExact: 'all' })
  assert('deptExact=all 只含 all 题', tAll === allDeptQs.length, `got ${tAll}`)
  const { list: lDining } = Store.queryQuestions({ deptExact: 'dining', category_id: 1 })
  assert('deptExact=dining + 分类1 组合过滤', lDining.every(q => q.dept === 'dining' && q.category_id === 1))
  const { total: tDiningPaged } = Store.queryQuestions({ deptExact: 'dining', page: 1, pageSize: 10 })
  assert('deptExact=dining 分页生效', tDiningPaged === diningQs.length)

  // 4. 旧逻辑回归：dept 学员语义不受影响
  console.log('\n4️⃣  回归：学员语义 dept 筛选')
  const { total: tDiningView } = Store.queryQuestions({ dept: 'dining' })
  assert('dept=dining（学员）仍为 dining+all', tDiningView === diningQs.length + allDeptQs.length, `got ${tDiningView}`)

  console.log('\n' + (testFailed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(testFailed ? 1 : 0)
})()
