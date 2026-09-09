// ====== 测试：账号管理页 / 数据看板页 拆分（渲染级） ======
// 验证 renderUsers 只含账号管理内容、renderDashboard 只含统计内容
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

const cloudRows = [
  { username: 'admin', name: '管理员', dept: '', role: 'admin', loginCount: 5, loginSec: 3600,
    practiceCount: 10, practiceCorrect: 8, practiceTotal: 10, examCount: 2, examScoreSum: 180,
    examBest: 95, examPassCount: 2, placementLevel: null, lastActive: Date.now(), perQ: {} },
  { username: 's1', name: '张三', dept: '饮食部', role: 'student', loginCount: 3, loginSec: 1800,
    practiceCount: 20, practiceCorrect: 15, practiceTotal: 20, examCount: 1, examScoreSum: 88,
    examBest: 88, examPassCount: 1, placementLevel: 3, lastActive: Date.now() - 1000,
    perQ: { '1': { correct: 2, total: 3 } } },
  { username: 's2', name: '李四', dept: '房务部', role: 'student', loginCount: 1, loginSec: 600,
    practiceCount: 5, practiceCorrect: 3, practiceTotal: 5, examCount: 0, examScoreSum: 0,
    examBest: 0, examPassCount: 0, placementLevel: null, lastActive: 0,
    perQ: { '2': { correct: 1, total: 1 }, '999': { correct: 0, total: 2 } } },
]

const sandbox = {
  localStorage: {
    store: {
      // v57：预置 v43 flag 跳过一次性清空（与老设备一致；种子题库仍会由 BANK.version 正常种子化）
      eq_course_only_v43: '1',
    },
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
  // 云端 + 线下课 stub（renderUsers / renderDashboard 依赖）
  CloudSync: {
    status: 'online',
    onStatus() {},
    enqueue() {},
    recalcCloudPlacementLevels: async () => ({}),
    getDashboardData: async () => JSON.parse(JSON.stringify(cloudRows)),
  },
  CourseStore: {
    status: 'online',
    getDoc: async () => ({ v: 1, classes: [
      { id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, members: ['s1', 's2'],
        assignments: [ { id: 'a1', type: 'homework', title: '作业一', deadline: 0,
          // v57：完整题目（renderDashboard 触发 v43 派生重建，残缺题派生后为空库）
          questions: [{ type: 'single', question: 'Book a room for tonight.', options: ['A', 'B'], answer: [0], difficulty: 1, explanation: '' }],
          results: { s1: { at: 1, score: 85, total: 10, attempts: 1 }, s2: { at: 2, score: 60, total: 10, attempts: 2 } } } ] },
    ] }),
  },
  courseMemberCell: (u) => `<strong>${u}</strong>`,   // 与 course-app.js 同名，供 _courseMatrices 使用
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
  console.log('\n🧪 账号管理 / 数据看板 拆分渲染测试')

  // 管理员身份
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  Store.pullCloudChanges = async () => ({ ok: true, applied: { roleChanged: [], renamed: [], deleted: [], added: [], sessionRoleSync: false } })

  // 1. 账号管理页
  console.log('\n1️⃣  renderUsers（账号管理）')
  await vm.runInContext('renderUsers()', sandbox)
  const usersHtml = getEl('page-users').innerHTML
  assert('页面标题为「账号管理」', usersHtml.includes('账号管理'))
  assert('有「新增账号」按钮', usersHtml.includes('新增账号'))
  assert('有「清空定级」按钮', usersHtml.includes('清空定级'))
  assert('有重置密码操作', usersHtml.includes('重置密码'))
  assert('有删除操作', usersHtml.includes('删除'))
  assert('有学员行（张三/李四）', usersHtml.includes('张三') && usersHtml.includes('李四'))
  assert('不包含数据看板汇总卡片', !usersHtml.includes('dashboard-summary'))
  assert('不包含分类进度区块', !usersHtml.includes('dashCatBlock'))
  assert('不包含每题正确率区块', !usersHtml.includes('perQBlock'))
  assert('不包含课程矩阵', !usersHtml.includes('dashCourseMatrixTitle'))
  assert('不包含数据明细分组表头', !usersHtml.includes('col-group-online'))
  assert('不包含登录时长数据列', !usersHtml.includes('登录时长'))

  // 2. 数据看板页（分「线上数据 / 线下课程」两个标签）
  console.log('\n2️⃣  renderDashboard（数据看板·线上/线下标签）')
  await vm.runInContext('renderDashboard()', sandbox)
  const dashHtml = getEl('page-dashboard').innerHTML
  assert('包含汇总卡片', dashHtml.includes('dashboard-summary'))
  assert('包含「线上数据」标签按钮', dashHtml.includes('线上数据') && dashHtml.includes('dashTabBtnOnline'))
  assert('包含「线下课程」标签按钮', dashHtml.includes('线下课程') && dashHtml.includes('dashTabBtnOffline'))
  assert('包含线上块容器', dashHtml.includes('dashOnlineBlock'))
  assert('包含线下块容器', dashHtml.includes('dashOfflineBlock'))
  assert('默认线上块无隐藏内联样式', !dashHtml.includes('id="dashOnlineBlock" style'))
  assert('默认线下块隐藏', dashHtml.includes('id="dashOfflineBlock" style="display:none"'))

  // 线上块内容（mock 不解析子元素，按字符串区间截取）
  console.log('\n2.1  线上数据块内容')
  function sliceBetween(html, start, end) {
    const i = html.indexOf(start)
    if (i < 0) return ''
    const j = html.indexOf(end, i + start.length)
    return j > i ? html.slice(i + start.length, j) : ''
  }
  const onlineHtml = sliceBetween(dashHtml, '<div id="dashOnlineBlock">', '<div id="dashOfflineBlock"')
  const offlineHtml = sliceBetween(dashHtml, 'style="display:none">', '<p class="form-hint"')
  assert('线上块：总用户数统计', onlineHtml.includes('总用户数'))
  assert('线上块：学员数据明细标题', onlineHtml.includes('学员数据明细'))
  assert('线上块：分类进度区块', onlineHtml.includes('dashCatBlock'))
  assert('线上块：每题正确率区块', onlineHtml.includes('perQBlock'))
  assert('线上块：登录时长列', onlineHtml.includes('登录时长'))
  assert('线上块：考试均分列', onlineHtml.includes('考试均分'))
  assert('线上块：学员行（张三/李四）', onlineHtml.includes('张三') && onlineHtml.includes('李四'))
  assert('线上块：不含线下完成列', !onlineHtml.includes('线下完成'))
  assert('线上块：不含课程矩阵', !onlineHtml.includes('课程成绩矩阵'))

  // 线下块内容
  console.log('\n2.2  线下课程块内容')
  assert('线下块：班级数汇总卡', offlineHtml.includes('班级数'))
  assert('线下块：学员线下明细标题', offlineHtml.includes('学员线下明细'))
  assert('线下块：线下完成列', offlineHtml.includes('线下完成'))
  assert('线下块：课程成绩矩阵', offlineHtml.includes('课程成绩矩阵'))
  assert('线下块：学员行（张三/李四）', offlineHtml.includes('张三') && offlineHtml.includes('李四'))
  assert('线下块：不含登录时长列', !offlineHtml.includes('登录时长'))
  assert('线下块：不含 perQ 区块', !offlineHtml.includes('perQBlock'))

  // 2.3 标签切换
  console.log('\n2.3  标签切换')
  vm.runInContext("dashSwitchTab('offline')", sandbox)
  assert('切到线下：线上块隐藏', getEl('dashOnlineBlock').style.display === 'none')
  assert('切到线下：线下块显示', getEl('dashOfflineBlock').style.display === '')
  vm.runInContext("dashSwitchTab('online')", sandbox)
  assert('切回线上：线上块显示', getEl('dashOnlineBlock').style.display === '')
  assert('切回线上：线下块隐藏', getEl('dashOfflineBlock').style.display === 'none')

  assert('不包含新建账号按钮', !dashHtml.includes('openUserModal'))
  assert('不包含重置密码操作', !dashHtml.includes('resetUserPassword'))

  // 3. perQ 区块实际渲染内容
  console.log('\n3️⃣  数据看板 perQ 区块')
  // v57 语义：perQ 只显示当前题库中仍存在的题目；已删除题目（qMap 无此 id）直接过滤。
  // renderDashboard 已触发 v43 派生重建 → 题库 = 作业派生题。把 perQ 指向派生题真实 id + 一条已删题 id 999。
  const derivedQs = Store.getQuestions()
  assert('v43 派生题库已重建（含作业题）', derivedQs.length >= 1 && derivedQs.some(q => q.question === 'Book a room for tonight.'))
  cloudRows[1].perQ = { [String(derivedQs[0].id)]: { correct: 2, total: 3 }, '999': { correct: 0, total: 2 } }
  sandbox.__testRows = cloudRows
  vm.runInContext('renderPerQBlock(__testRows)', sandbox)
  const perQHtml = getEl('perQBlock').innerHTML
  assert('perQ 区块有统计标题', perQHtml.includes('perQTitle') || perQHtml.includes('每道题正确率'))
  assert('perQ 区块包含答过的题', perQHtml.includes('<tr>'))
  assert('perQ 显示现存题目（派生题干）', perQHtml.includes('Book a room'))
  assert('v57：已删除题目不再显示兜底行', !perQHtml.includes('已删除') && !perQHtml.includes('question deleted') && !perQHtml.includes('>999<'))

  console.log('\n' + (testFailed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(testFailed ? 1 : 0)
})()
