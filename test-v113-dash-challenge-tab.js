// ====== 测试：v113 数据看板拆出「七天挑战」独立标签 ======
// 背景：用户反馈「完全不对啊」——v112 把「七天挑战」放到了站点顶栏，
//   但用户真正要的是【数据看板顶部的分栏标签】：七天挑战要单独成一个标签页，
//   放在最顶上，与「线上培训 / 线下课」并列，而不是塞在「线上培训」标签里面。
//
// 本套件验证三件事：
//   1. 三标签并列存在且顺序为 线上培训 → 线下课 → 七天挑战
//   2. 挑战三面板（营次管理 / 开关 / 挑战统计）已从线上块【移出】并落在挑战块
//      —— 反向断言是核心，防「只加标签没搬内容」这种半吊子回退
//   3. dashSwitchTab 三块互斥切换（显示/隐藏 + 按钮高亮）
//   4. 训练营三面板相对顺序不变（v76/v77/v107 历史约束）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

// ---- 万能 DOM mock（按 id 缓存）----
const elements = {}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {},
    textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false, disabled: false,
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
]

const sandbox = {
  localStorage: {
    store: { eq_course_only_v43: '1' },
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
    onStatus() {},
    enqueue() {},
    recalcCloudPlacementLevels: async () => ({}),
    getDashboardData: async () => JSON.parse(JSON.stringify(cloudRows)),
  },
  CourseStore: {
    status: 'online',
    getDoc: async () => ({ v: 1, classes: [] }),
  },
  courseMemberCell: (u) => `<strong>${u}</strong>`,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(I18N, sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(APP, sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

;(async () => {
  console.log('\n🧪 v113 数据看板·七天挑战独立标签 测试')

  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  Store.pullCloudChanges = async () => ({ ok: true, applied: { roleChanged: [], renamed: [], deleted: [], added: [], sessionRoleSync: false } })

  // ---- 1. 源码级：三标签定义与顺序 ----
  console.log('\n1️⃣  源码：三标签定义')
  assert('DASH_TABS 定义为三个标签', /const DASH_TABS = \[[\s\S]{0,700}?\]/.test(APP)
    && (APP.match(/const DASH_TABS = \[[\s\S]{0,700}?\]/)[0].match(/\{ v: '/g) || []).length === 3)
  const tabsBlock = (APP.match(/const DASH_TABS = \[[\s\S]{0,700}?\]/) || [''])[0]
  {
    const iOn = tabsBlock.indexOf("v: 'online'")
    const iOff = tabsBlock.indexOf("v: 'offline'")
    const iCh = tabsBlock.indexOf("v: 'challenge'")
    assert('DASH_TABS 顺序：online → offline → challenge', iOn >= 0 && iOff > iOn && iCh > iOff,
      `on=${iOn} off=${iOff} ch=${iCh}`)
  }
  assert('挑战标签按钮 id 为 dashTabBtnChallenge', tabsBlock.includes("btn: 'dashTabBtnChallenge'"))
  assert('挑战块容器 id 为 dashChallengeTabBlock', tabsBlock.includes("block: 'dashChallengeTabBlock'"))
  assert('挑战标签文案键为 dashTabChallenge', tabsBlock.includes("label: 'dashTabChallenge'"))

  // dashSwitchTab 走配置数组遍历（不再是写死的两个 id）
  console.log('\n1.1  dashSwitchTab 泛化为遍历')
  const fnBody = (APP.match(/function dashSwitchTab\(v\) \{[\s\S]{0,600}?\n\}/) || [''])[0]
  assert('dashSwitchTab 遍历 DASH_TABS', fnBody.includes('DASH_TABS.forEach'))
  assert('dashSwitchTab 按 c.block 控显隐', fnBody.includes('c.block'))
  assert('dashSwitchTab 按 c.btn 控高亮', fnBody.includes('c.btn'))
  assert('dashSwitchTab 不再写死 dashOnlineBlock 变量', !/const ob = document\.getElementById\('dashOnlineBlock'\)/.test(APP))

  // ---- 2. 渲染级：三块容器与默认显隐 ----
  console.log('\n2️⃣  renderDashboard 渲染结果')
  await vm.runInContext('renderDashboard()', sandbox)
  const dashHtml = getEl('page-dashboard').innerHTML
  assert('三个块容器齐备',
    dashHtml.includes('id="dashOnlineBlock"') && dashHtml.includes('id="dashOfflineBlock"')
    && dashHtml.includes('id="dashChallengeTabBlock"'))
  assert('三个标签按钮齐备',
    dashHtml.includes('id="dashTabBtnOnline"') && dashHtml.includes('id="dashTabBtnOffline"')
    && dashHtml.includes('id="dashTabBtnChallenge"'))
  assert('默认线上块显示', !dashHtml.includes('id="dashOnlineBlock" style="display:none"'))
  assert('默认线下块隐藏', dashHtml.includes('id="dashOfflineBlock" style="display:none"'))
  assert('默认挑战块隐藏', dashHtml.includes('id="dashChallengeTabBlock" style="display:none"'))
  // ⚠️ 按钮渲染是 DASH_TABS.map 拼出来的，属性顺序为 class → id，所以断言必须写成
  //    `btn-primary" id="dashTabBtnOnline"`（class 在前）。写反了会假失败（本轮踩过）。
  assert('默认线上标签高亮', dashHtml.includes('btn-primary" id="dashTabBtnOnline"'))
  assert('默认线下标签未高亮', dashHtml.includes('btn-ghost" id="dashTabBtnOffline"'))
  assert('默认挑战标签未高亮', dashHtml.includes('btn-ghost" id="dashTabBtnChallenge"'))

  // ---- 3. 内容搬家：挑战三面板从线上块移出（本套件核心）----
  console.log('\n3️⃣  挑战三面板搬迁（核心：不能只加标签不搬内容）')
  function sliceBetween(html, start, end) {
    const i = html.indexOf(start)
    if (i < 0) return ''
    const j = html.indexOf(end, i + start.length)
    return j > i ? html.slice(i + start.length, j) : ''
  }
  const onlineHtml = sliceBetween(dashHtml, '<div id="dashOnlineBlock"', '<div id="dashOfflineBlock"')
  const offlineHtml = sliceBetween(dashHtml, '<div id="dashOfflineBlock"', '<div id="dashChallengeTabBlock"')
  const challengeHtml = sliceBetween(dashHtml, '<div id="dashChallengeTabBlock"', '</div>\n    <p class="form-hint"')

  assert('线上块仍含分类进度', onlineHtml.includes('dashCatBlock'))
  assert('线上块仍含每题正确率', onlineHtml.includes('perQBlock'))
  assert('线上块【不含】营次管理面板', !onlineHtml.includes('dashRoundsPanel'))
  assert('线上块【不含】挑战开关面板', !onlineHtml.includes('dashChGate'))
  assert('线上块【不含】挑战统计占位', !onlineHtml.includes('dashChallengeBlock'))

  assert('挑战块含营次管理面板', challengeHtml.includes('dashRoundsPanel'))
  assert('挑战块含挑战开关面板', challengeHtml.includes('dashChGate'))
  assert('挑战块含挑战统计占位', challengeHtml.includes('dashChallengeBlock'))

  // ⚠️ 本套件 CourseStore stub 为无班级（classes: []），此时线下块渲染的是空态。
  //    注意 t() 已把 i18n 键换成中文文案，所以【不能断言键名 dashOfflineEmpty】，
  //    要断言渲染出来的中文串（本轮踩过：拿键名去匹配渲染结果，必然假失败）。
  assert('线下块含课程矩阵或空态占位',
    offlineHtml.includes('课程成绩矩阵') || offlineHtml.includes('暂无线下班级与作业数据'),
    'len=' + offlineHtml.length)
  assert('线下块不含挑战面板',
    !offlineHtml.includes('dashRoundsPanel') && !offlineHtml.includes('dashChGate'))

  // 训练营三面板相对顺序不变（v76/v77/v107 历史约束）
  console.log('\n3.1  挑战块内三面板相对顺序（v76/v77/v107 约束保持不变）')
  {
    const iR = APP.indexOf('${dashRoundsPanelHtml()}')
    const iG = APP.indexOf('${dashChGatePanelHtml()}')
    const iB = APP.indexOf('<div id="dashChallengeBlock"></div>')
    assert('三面板顺序：营次管理 → 开关 → 挑战统计', iR >= 0 && iG > iR && iB > iG, `r=${iR} g=${iG} b=${iB}`)
  }
  {
    const iR = challengeHtml.indexOf('dashRoundsPanel')
    const iG = challengeHtml.indexOf('dashChGate')
    const iB = challengeHtml.indexOf('dashChallengeBlock')
    assert('渲染后挑战块内顺序一致', iR >= 0 && iG > iR && iB > iG, `r=${iR} g=${iG} b=${iB}`)
  }

  // ---- 4. 切换行为：三块互斥 ----
  console.log('\n4️⃣  dashSwitchTab 三块互斥切换')
  const disp = id => getEl(id).style.display
  vm.runInContext("dashSwitchTab('challenge')", sandbox)
  assert('切到挑战：挑战块显示', disp('dashChallengeTabBlock') === '')
  assert('切到挑战：线上块隐藏', disp('dashOnlineBlock') === 'none')
  assert('切到挑战：线下块隐藏', disp('dashOfflineBlock') === 'none')
  assert('切到挑战：挑战按钮高亮', getEl('dashTabBtnChallenge').className.includes('btn-primary'))
  assert('切到挑战：另两按钮降级',
    getEl('dashTabBtnOnline').className.includes('btn-ghost') && getEl('dashTabBtnOffline').className.includes('btn-ghost'))

  vm.runInContext("dashSwitchTab('offline')", sandbox)
  assert('切到线下：线下块显示、另两块隐藏',
    disp('dashOfflineBlock') === '' && disp('dashOnlineBlock') === 'none' && disp('dashChallengeTabBlock') === 'none')
  assert('切到线下：线下按钮高亮', getEl('dashTabBtnOffline').className.includes('btn-primary'))

  vm.runInContext("dashSwitchTab('online')", sandbox)
  assert('切回线上：线上块显示、另两块隐藏',
    disp('dashOnlineBlock') === '' && disp('dashOfflineBlock') === 'none' && disp('dashChallengeTabBlock') === 'none')
  assert('切回线上：线上按钮高亮', getEl('dashTabBtnOnline').className.includes('btn-primary'))

  // ---- 5. dashTab 默认值（刷新后落在线上培训）----
  console.log('\n5️⃣  默认标签')
  assert("dashTab 初始默认 'online'", /let dashTab = 'online'/.test(APP))

  // ---- 6. i18n 三键双语成对 ----
  console.log('\n6️⃣  i18n 三标签文案')
  const zhPart = I18N.slice(I18N.indexOf('dashTabOnline'), I18N.indexOf('dashTabOnline') + 200)
  assert('zh: dashTabChallenge 键存在', /dashTabChallenge\s*:/.test(I18N))
  assert('zh: 三键同行相邻（线上培训/线下课/七天挑战）',
    /dashTabOnline: '线上培训',\s*dashTabOffline: '线下课',\s*dashTabChallenge: '七天挑战',/.test(I18N))
  const enIdx = I18N.lastIndexOf('dashTabOnline')
  const enPart = I18N.slice(enIdx, enIdx + 220)
  assert('en: 三键同行相邻（Online Training/Offline Courses/7-Day Challenge）',
    /dashTabOnline: 'Online Training',\s*dashTabOffline: 'Offline Courses',\s*dashTabChallenge: '7-Day Challenge',/.test(I18N))
  assert('zh/en 均有 dashTabChallenge（成对）',
    (I18N.match(/dashTabChallenge\s*:/g) || []).length === 2,
    'count=' + (I18N.match(/dashTabChallenge\s*:/g) || []).length)

  // 真跑 t() 取双语值
  const zhVal = vm.runInContext("(function(){setLang('zh');return t('dashTabChallenge')})()", sandbox)
  const enVal = vm.runInContext("(function(){setLang('en');return t('dashTabChallenge')})()", sandbox)
  vm.runInContext("setLang('zh')", sandbox)
  assert('zh 取值为「七天挑战」', zhVal === '七天挑战', 'got=' + zhVal)
  assert('en 取值为「7-Day Challenge」', enVal === '7-Day Challenge', 'got=' + enVal)

  console.log('\n' + (testFailed ? '❌ v113 测试有断言失败' : '✅ v113 七天挑战独立标签 测试全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
