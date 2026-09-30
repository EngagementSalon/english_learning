// ====== 测试：管理员可查看学员线下课页面（学员视图 ↔ 管理模式切换）======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
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

const courseDoc = { v: 1, classes: [
  { id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, members: ['s1'],
    assignments: [ { id: 'a1', type: 'homework', title: '作业一', deadline: 0, questions: [{ id: 1 }], results: {} } ] },
] }

const sandbox = {
  localStorage: {
    store: {},
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
  CloudSync: {
    status: 'online',
    onStatus() {}, enqueue() {},
    recalcCloudPlacementLevels: async () => ({}),
    getDashboardData: async () => ([]),
  },
  CourseStore: {
    status: 'online',
    newId: () => 'c1',
    findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
    findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
    getDoc: async () => JSON.parse(JSON.stringify(courseDoc)),
    mutate: async () => true,
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

// 加载顺序：i18n → bank-data → store → course-app → app（escHtml/init 依赖）
vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

;(async () => {
  console.log('\n🧪 管理员线下课学员视图测试')

  // 管理员身份
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  if (!Store.isAdmin()) { console.error('isAdmin() 应为 true'); process.exit(1) }

  // 1. 管理员默认进入学员视图
  console.log('\n1️⃣  管理员默认学员视图')
  await vm.runInContext('renderCoursePage()', sandbox)
  let studentHtml = getEl('page-course').innerHTML
  // v133 反转：「我的班级」卡片列表已移除 —— 学员首页改为「学习进度大纲（📈 我的学习进度）+ 可加入的班级」。
  //   旧断言断的是被移除的卡片区标题「我的班级」。
  //   ★ 注意：本套件里 admin 不是 c1 的成员（members:['s1']），myClasses 为空 → 大纲区 courseStudentPathHtml
  //     返回空串（有意的：没加入班级就没进度可看）。故此处断「卡片区已下线 + 可加入班级仍在」，
  //     大纲区本身的渲染由 4️⃣ 节（学员 s1 身份，是成员）覆盖。
  assert('[v133 反转] 学员首页不再出现「我的班级」字样', !studentHtml.includes('我的班级'))
  // ★ 切片范围纪律：course-card-actions 仍是「可加入的班级」卡片的合法类名，
  //   不能整页否定；只否定「我的班级」卡片区会产出的 course-card-title / course-status 组合。
  assert('[v133 反转] 旧「我的班级」卡片专属类名已下线（不再产出 course-card-title）',
    !studentHtml.includes('course-card-title'), '')
  assert('渲染「可加入的班级」', studentHtml.includes('可加入的班级'))
  assert('显示管理员预览横幅', studentHtml.includes('管理员预览'))
  assert('横幅有「管理模式」切换按钮', studentHtml.includes('管理模式') && studentHtml.includes('courseToggleAdminView'))
  assert('学员视图不含「创建班级」按钮', !studentHtml.includes('courseCreateClassModal'))

  // 2. 切换到管理模式
  console.log('\n2️⃣  切换到管理模式')
  vm.runInContext('courseToggleAdminView()', sandbox)
  await new Promise(r => setTimeout(r, 10))
  const adminHtml = getEl('page-course').innerHTML
  assert('渲染管理视图统计卡片', adminHtml.includes('dashboard-summary'))
  assert('管理视图有「创建班级」按钮', adminHtml.includes('courseCreateClassModal'))
  assert('管理视图有「学员视图」切换按钮', adminHtml.includes('学员视图') && adminHtml.includes('courseToggleAdminView'))
  assert('管理视图不含预览横幅', !adminHtml.includes('管理员预览'))

  // 3. 切回学员视图
  console.log('\n3️⃣  切回学员视图')
  vm.runInContext('courseToggleAdminView()', sandbox)
  await new Promise(r => setTimeout(r, 10))
  studentHtml = getEl('page-course').innerHTML
  assert('[v133 反转] 再次渲染学员视图（可加入班级 + 无卡片列表）',
    studentHtml.includes('可加入的班级') && !studentHtml.includes('我的班级'), studentHtml.slice(0, 300))
  assert('再次显示预览横幅', studentHtml.includes('管理员预览'))

  // 4. 学员身份不受影响（无横幅，直接学员视图）
  console.log('\n4️⃣  学员身份无横幅')
  Store.getSession = () => ({ id: 2, username: 's1', name: '张三', role: 'student' })
  vm.runInContext('courseState.adminView = false', sandbox)
  await vm.runInContext('renderCoursePage()', sandbox)
  const stuHtml = getEl('page-course').innerHTML
  assert('[v133 反转] 学员渲染大纲区（s1 是成员 → 我的学习进度 出现）', stuHtml.includes('我的学习进度'), stuHtml.slice(0, 400))
  assert('[v133 反转] 学员视图不再出现「我的班级」卡片区', !stuHtml.includes('我的班级'), '')
  assert('学员视图无预览横幅', !stuHtml.includes('管理员预览'))
  assert('学员视图无管理模式按钮', !stuHtml.includes('管理模式'))

  // 5. 截止后未提交：仍可补交（逾期判定是作业行/详情逻辑，「已截止·可补交」文案随卡片列表下线）
  console.log('\n5️⃣  截止后仍可进入作业（未提交）')
  courseDoc.classes[0].assignments[0].deadline = Date.now() - 1000
  courseDoc.classes[0].assignments[0].results = {}
  await vm.runInContext('renderCoursePage()', sandbox)
  let openHtml = getEl('page-course').innerHTML
  // v133 反转：原「已截止·可补交」标签产自卡片列表的 courseExpiredOpen；卡片列表移除后，
  //   学员首页只剩大纲行，逾期与否不改变「行的可点性」——点行即 courseStart，路由内部处理截止/闸门。
  assert('[v133 反转] 大纲行仍可点击进入作业（courseStart 入口在）', openHtml.includes('courseStart'), '')
  assert('[v133 反转] 截止后作业仍出现在大纲行', openHtml.includes('我的学习进度'), openHtml.slice(0, 400))
  assert('[v133 反转] 卡片列表专属「已截止·可补交」标签已移除（不再由首页产出）',
    !openHtml.includes('已截止·可补交'), '')

  // 6. 逾期提交：管理端成绩详情仍标「逾期」（学员首页本身不产逾期标签 —— 那是卡片列表形态）
  console.log('\n6️⃣  逾期提交标记展示')
  courseDoc.classes[0].assignments[0].results = { 's1': { at: Date.now(), score: 85, correct: 9, total: 10, usedSec: 60, attempts: 1, overdue: true } }
  await vm.runInContext('renderCoursePage()', sandbox)
  openHtml = getEl('page-course').innerHTML
  // v133 反转：学员首页原「逾期」标签产自卡片列表的 overTag；卡片列表移除后该标签只保留在管理端成绩详情表里。
  assert('[v133 反转] 学员首页不再产出卡片态「逾期」标签', !openHtml.includes('courseOverdue'), '')
  assert('[v133 反转] 学员首页仍渲染大纲区（逾期不阻断导航）', openHtml.includes('我的学习进度'), openHtml.slice(0, 300))
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  vm.runInContext('courseState.adminView = true', sandbox)
  await vm.runInContext('courseAssignDetail("c1","a1")', sandbox)
  const detailHtml = getEl('page-course').innerHTML
  assert('管理详情显示「逾期」标签', detailHtml.includes('逾期'))
  assert('管理详情正常渲染成绩', detailHtml.includes('85'))

  console.log('\n' + (failed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(failed ? 1 : 0)
})()
