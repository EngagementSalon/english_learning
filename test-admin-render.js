// ====== 测试：管理页三个题库 Tab + 看板分类进度区块（渲染级） ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

// ---- 万能 DOM mock（按 id 缓存元素，捕获 innerHTML）----
const elements = {}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {},
    textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
const getEl = id => elements[id] || (elements[id] = mkEl())

const sandbox = {
  localStorage: {
    store: { 'eq_course_only_v43': '1' },   /* v43 清空与本测试无关，预置 flag 跳过 */
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {
    addEventListener() {}, scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
  },
  document: {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  },
  alert() {}, confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

// 加载顺序：i18n → bank-data → store → app
vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

;(async () => {
  console.log('\n🧪 管理页题库 Tab（v89 六 tab: 餐饮四分队+房务部+通用） + 看板分类区块渲染测试')

  const allQs = Store.getQuestions()
  // v89：题库 tab 已细到分部门 slug，计数按 adminDeptSetOf 的集合口径
  const tabs = vm.runInContext('ADMIN_DEPT_TABS', sandbox)
  const setOf = tab => vm.runInContext(`JSON.stringify(adminDeptSetOf(${JSON.stringify(tab)}))`, sandbox)
  const countOf = tab => {
    const set = JSON.parse(setOf(tab))
    return allQs.filter(q => set.indexOf(q.dept || 'all') >= 0).length
  }
  const counts = {}
  tabs.forEach(k => { counts[k] = countOf(k) })
  console.log('  tab 列表:', JSON.stringify(tabs))
  console.log('  各 tab 计数:', JSON.stringify(counts))

  // 管理员身份
  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })

  // 1. renderAdmin → 6 个 tab + 正确计数 + 默认落点
  console.log('\n1️⃣  renderAdmin 渲染')
  vm.runInContext('renderAdmin()', sandbox)
  const shell = getEl('page-admin').innerHTML
  assert('tab 数量为 6', tabs.length === 6, `got ${tabs.length}`)
  assert('默认 tab 落在 dining/sig（标帜餐厅）', vm.runInContext('adminTab', sandbox) === 'dining/sig', vm.runInContext('adminTab', sandbox))
  tabs.forEach(k => {
    const label = vm.runInContext(`adminTabLabel(${JSON.stringify(k)})`, sandbox)
    assert(`含 tab「${label}」(${k})`, shell.includes(`switchAdminTab('${k}')`))
  })
  assert('不包含 培训题库 tab（已并入饮食部）', !shell.includes('trainingBank') && !shell.includes('培训题库'))
  tabs.forEach(k => {
    assert(`tab ${k} 计数正确 (${counts[k]})`, shell.includes(`>${counts[k]}<`), `期望 ${counts[k]}`)
  })
  assert('各 tab 计数之和 > 0（题库非空）', Object.values(counts).some(n => n > 0))

  // 2. 默认 tab 列表（dining/sig）：只有本分部门题
  const body = getEl('adminTabBody').innerHTML
  assert('默认 tab 列表有题目', body.includes('<tr>'))
  assert('列表不含部门下拉', !body.includes('adminFilterDept'))
  assert('列表不含「全部部门」选项', !body.includes('deptAll'))
  const rowCount = (body.match(/<tr>/g) || []).length - 1 // 减去表头
  assert('默认展示 10 条', rowCount <= 10, `got ${rowCount}`)

  // 3. 切换到房务部 tab（v89 题库为空 → 显示暂无题目）
  console.log('\n2️⃣  切换 tab')
  vm.runInContext("switchAdminTab('rooms')", sandbox)
  const roomsBody = getEl('adminTabBody').innerHTML
  assert('房务部空题库显示暂无题目', roomsBody.includes('noQuestions') || roomsBody.includes('暂无题目'))
  const roomsShell = getEl('page-admin').innerHTML
  assert('房务部 tab 高亮', roomsShell.includes("admin-tab active"))

  // 3b. 逐个切换餐饮四分队 tab 均可渲染（不抛错）
  ;['dining/yan', 'dining/bar', 'dining/ird'].forEach(k => {
    vm.runInContext(`switchAdminTab(${JSON.stringify(k)})`, sandbox)
    const h = getEl('adminTabBody').innerHTML
    assert(`切到 ${k} 渲染不抛错且有内容`, h.length > 0, `len=${h.length}`)
  })

  // 4. 切换到通用 tab
  vm.runInContext("switchAdminTab('all')", sandbox)
  const allBody = getEl('adminTabBody').innerHTML
  assert('通用 tab 有题目', allBody.includes('<tr>'))

  // 5. 切回标帜餐厅 + 分类筛选函数可用（v89 后 tab 值是 slug，不再有 'dining' 大部门 tab）
  vm.runInContext("switchAdminTab('dining/sig')", sandbox)
  vm.runInContext("adminFilterCat('1')", sandbox)
  const catBody = getEl('adminTabBody').innerHTML
  assert('标帜餐厅+分类1 筛选渲染', catBody.includes('<tr>'))
  // 无 tab 状态残留（历史 bug：adminStates['dining'] 为 undefined 导致赋值抛错）
  assert('adminStates 无遗留 dining 键', vm.runInContext("!adminStates['dining']", sandbox))
  assert('adminStates 覆盖全部 tab', vm.runInContext('Object.keys(adminStates).length', sandbox) === tabs.length)

  // 6. 看板分类区块
  console.log('\n3️⃣  看板分类进度区块')
  vm.runInContext('renderDashCatBlock()', sandbox)
  const dashHtml = getEl('dashCatBlock').innerHTML
  assert('看板区块渲染分类进度', dashHtml.includes('dashCatTitle') || dashHtml.includes('分类进度'))
  assert('看板区块含全部/饮食/房务切换', dashHtml.includes("setDashDept('dining')") && dashHtml.includes("setDashDept('rooms')"))
  // 默认（全部）口径
  const fullHtml = getEl('dashCatBlock').innerHTML
  const catItems = (fullHtml.match(/cat-progress-item/g) || []).length
  // v67（题库 v9）后分类表 = 线下课题库 + 标帜餐厅常见词汇
  assert('全部口径渲染 2 个分类（线下课题库+标帜餐厅常见词汇）', catItems === 2, `got ${catItems}`)
  // 全库分类1题数
  const cat1Full = Store.getStats().categoryStats.find(c => c.id === 1).totalQuestions
  assert('全部口径分类1题数正确', fullHtml.includes(`>${cat1Full}${' '}`) || fullHtml.includes(`>${cat1Full}<`), `期望 ${cat1Full}`)

  // 切换到饮食部口径
  vm.runInContext("setDashDept('dining')", sandbox)
  const diningHtml = getEl('dashCatBlock').innerHTML
  const cat1Dining = Store.getStats('dining').categoryStats.find(c => c.id === 1).totalQuestions
  const cat12Dining = Store.getStats('dining').categoryStats.find(c => c.id === 12).totalQuestions
  assert('饮食部口径分类1题数正确', diningHtml.includes(`>${cat1Dining}${' '}`) || diningHtml.includes(`>${cat1Dining}<`), `期望 ${cat1Dining}`)
  assert('饮食部口径分类12题数正确（标帜餐厅词汇主体入库）', diningHtml.includes(`>${cat12Dining}${' '}`) || diningHtml.includes(`>${cat12Dining}<`), `期望 ${cat12Dining}`)

  console.log('\n' + (testFailed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(testFailed ? 1 : 0)
})()
