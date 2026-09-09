// ====== 测试部门题库筛选逻辑 ======
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

// 加载 bank-data.js → BANK
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
// 加载 store.js → Store
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)

// const 声明的全局变量在 vm 沙箱中不暴露到 context，需要用 eval 提取
const Store = vm.runInContext('Store', sandbox)
const BANK = vm.runInContext('BANK', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

// 初始化题库
Store.init()

;(async () => {
  console.log('\n🧪 部门题库筛选测试')

  // 1. 验证 BANK 版本 = 8
  console.log('\n1️⃣  题库版本')
  const bankVer = BANK.version
  assert('BANK.version = 8', bankVer === 8, `got ${bankVer}`)

  // 2. 验证题目有 dept 字段
  console.log('\n2️⃣  题目 dept 字段')
  const allQs = Store.getQuestions()
  assert('总题数 > 500', allQs.length > 500, `got ${allQs.length}`)
  const withDept = allQs.filter(q => q.dept)
  assert('所有题目有 dept', withDept.length === allQs.length, `${withDept.length}/${allQs.length}`)
  
  const diningQs = allQs.filter(q => q.dept === 'dining')
  const roomsQs = allQs.filter(q => q.dept === 'rooms')
  const allDeptQs = allQs.filter(q => q.dept === 'all')
  assert('饮食部题目 > 0', diningQs.length > 0, `got ${diningQs.length}`)
  assert('房务部题目 = 0（暂时为空）', roomsQs.length === 0, `got ${roomsQs.length}`)
  assert('通用题目 > 0', allDeptQs.length > 0, `got ${allDeptQs.length}`)

  // 3. 部门筛选：dining 应看到 dining + all
  console.log('\n3️⃣  部门筛选')
  const diningView = Store.getQuestionsByDept('dining')
  assert('饮食部看到 dining+all', diningView.length === diningQs.length + allDeptQs.length, `got ${diningView.length}`)
  assert('饮食部看不到 rooms', diningView.every(q => q.dept !== 'rooms'))

  // 4. 房务部筛选
  const roomsView = Store.getQuestionsByDept('rooms')
  assert('房务部看到 rooms+all', roomsView.length === roomsQs.length + allDeptQs.length, `got ${roomsView.length}`)
  assert('房务部看不到 dining', roomsView.every(q => q.dept !== 'dining'))

  // 5. 其他部门看到全部
  const otherView = Store.getQuestionsByDept('other')
  assert('其他部门看到全部', otherView.length === allQs.length, `got ${otherView.length}`)

  // 6. 空字符串 = 管理员 = 看全部
  const adminView = Store.getQuestionsByDept('')
  assert('空 dept = 看全部', adminView.length === allQs.length, `got ${adminView.length}`)

  // 7. queryQuestions 带 dept 参数
  console.log('\n4️⃣  queryQuestions 带 dept')
  const { list: diningList, total: diningTotal } = Store.queryQuestions({ dept: 'dining' })
  assert('queryQuestions dept=dining 总数正确', diningTotal === diningQs.length + allDeptQs.length, `got ${diningTotal}`)
  
  const { list: roomsList, total: roomsTotal } = Store.queryQuestions({ dept: 'rooms' })
  assert('queryQuestions dept=rooms 总数正确', roomsTotal === roomsQs.length + allDeptQs.length, `got ${roomsTotal}`)

  // 8. getQuestionsWithLevel 带 dept
  console.log('\n5️⃣  getQuestionsWithLevel 带 dept')
  const diningWithLevel = Store.getQuestionsWithLevel('dining')
  assert('getQuestionsWithLevel(dining) 数量正确', diningWithLevel.length === diningQs.length + allDeptQs.length)
  assert('所有结果有 level', diningWithLevel.every(q => q.level >= 1 && q.level <= 4))

  // 9. getSessionDeptKey
  console.log('\n6️⃣  getSessionDeptKey')
  // 先设置一个饮食部 session
  Store.getSession = () => ({ dept: '饮食部·标帜餐厅' })
  assert('饮食部·标帜餐厅 → dining', Store.getSessionDeptKey() === 'dining')
  Store.getSession = () => ({ dept: '房务部·前台' })
  assert('房务部·前台 → rooms', Store.getSessionDeptKey() === 'rooms')
  Store.getSession = () => ({ dept: '其他部门·IT' })
  assert('其他部门·IT → other', Store.getSessionDeptKey() === 'other')
  Store.getSession = () => ({ dept: '' })
  assert('空 dept → other', Store.getSessionDeptKey() === 'other')
  Store.getSession = () => null
  assert('null session → other', Store.getSessionDeptKey() === 'other')

  // 10. 新增题目默认有 dept
  console.log('\n7️⃣  新增题目')
  const before = Store.getQuestions().length
  Store.addQuestion({ category_id: 1, dept: 'rooms', type: 'single', difficulty: 1, question: '测试房务题', options: ['A','B'], answer: [0], explanation: '' })
  const after = Store.getQuestions()
  assert('题目数+1', after.length === before + 1)
  const newQ = after[after.length - 1]
  assert('新题目 dept=rooms', newQ.dept === 'rooms')

  // 11. 房务部现在能看到这道新题
  const roomsView2 = Store.getQuestionsByDept('rooms')
  assert('房务部现在能看到新题', roomsView2.some(q => q.question === '测试房务题'))

  console.log('\n' + (testFailed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(testFailed ? 1 : 0)
})()
