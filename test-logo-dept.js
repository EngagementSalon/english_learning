// ====== 测试：① 平台 Logo（本地缓存 + 云端拉取） ② 管理员调整学员部门（本地/云端/会话同步 + 账号页 UI） ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LOGO_A = 'data:image/png;base64,AAAA'
const LOGO_B = 'data:image/png;base64,BBBB'
// 元素 map（Part B 渲染级断言用，模块级声明以便 getElOf 访问）
const elements = {}
function getElOf(id) {
  return elements[id] || (elements[id] = {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  })
}

// ---- 通用 localStorage / window / document mock ----
function mkStorage(initial) {
  return {
    store: Object.assign({}, initial || {}),
    getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
}
function mkWindow() {
  return {
    _handlers: {},
    addEventListener(ev, fn) { this._handlers[ev] = fn },
    removeEventListener() {},
    dispatchEvent(ev) { return true },
    scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
  }
}
function mkDoc(elements) {
  const getEl = id => elements[id] || (elements[id] = {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  })
  return {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mkDoc({}).getElementById('x'),
    body: { appendChild() {} },
    title: '',
    addEventListener() {},
  }
}

;(async () => {
  // ============================================================
  // Part A：cloud-store.js 的 _apply 支持 dept 事件（看板聚合用）
  // ============================================================
  console.log('\n🧪 Part A：CloudSync._apply 聚合 dept 事件')
  {
    const sb = {
      localStorage: mkStorage({}),
      console, window: mkWindow(), document: mkDoc({}),
      setInterval() { return 0 }, clearInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
      fetch: () => Promise.reject(new Error('no net')),
    }
    vm.createContext(sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
    const CloudSync = vm.runInContext('CloudSync', sb)
    const map = {}
    CloudSync._apply(map, { u: 'bob', n: 'Bob', ty: 'register', ts: 1, d: { name: 'Bob', dept: '饮食部', role: 'student' } })
    assert('register 聚合 dept', map.bob.dept === '饮食部')
    CloudSync._apply(map, { u: 'bob', n: 'Bob', ty: 'dept', ts: 2, d: { dept: '房务部' } })
    assert('dept 事件更新聚合 dept', map.bob.dept === '房务部')
    CloudSync._apply(map, { u: 'bob', n: 'Bob', ty: 'dept', ts: 3, d: { dept: '' } })
    assert('dept 空串 = 清除部门', map.bob.dept === '')
    CloudSync._apply(map, { u: 'bob', n: 'Bob', ty: 'dept', ts: 4, d: { dept: '饮食部·宴会运营' } })
    assert('dept 中文完整值', map.bob.dept === '饮食部·宴会运营')
  }

  // ============================================================
  // Part B：store.js（Logo 缓存 / setUserDept / pullCloudChanges）
  // ============================================================
  const cloudSent = []       // CloudSync.enqueue 捕获
  let fetchResult = { ok: true, map: {}, doc: { v: 1, base: {}, events: [] } }
  let dashRows = []
  const windowObj = mkWindow()
  const sandbox = {
    localStorage: mkStorage({}),
    console,
    window: windowObj,
    document: mkDoc(elements),
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean,
    TextEncoder: require('util').TextEncoder,
    CloudSync: {
      status: 'online',
      onStatus() {},
      enqueue(ev) { cloudSent.push(ev) },
      pushPending: async () => {},
      setUser() {}, flushDuration() {},
      setCloudLogo: async () => ({ ok: true }),
      fetchSyncSummary: async () => fetchResult,
      recalcCloudPlacementLevels: async () => ({}),
      getDashboardData: async () => JSON.parse(JSON.stringify(dashRows)),
    },
    CourseStore: {
      status: 'online',
      getDoc: async () => ({ v: 1, classes: [] }),
    },
    courseMemberCell: (u) => `<strong>${u}</strong>`,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)
  const Store = vm.runInContext('Store', sandbox)
  if (!Store) { console.error('Store missing!'); process.exit(1) }

  const usersWith = (users) => sandbox.localStorage.setItem('eq_users', JSON.stringify(users))

  console.log('\n🧪 Part B1：Logo 本地缓存')
  {
    assert('初始无 Logo', Store.getLogo() === '')
    assert('setLogo 返回变化 true', Store.setLogo(LOGO_A) === true)
    assert('getLogo 读取正确', Store.getLogo() === LOGO_A)
    assert('相同 Logo 返回 false', Store.setLogo(LOGO_A) === false)
    assert('清除 Logo 返回 true', Store.setLogo('') === true)
    assert('清除后为空', Store.getLogo() === '')
    assert('再次清除返回 false', Store.setLogo('') === false)
  }

  console.log('\n🧪 Part B2：Store.setUserDept（本地账号表 / 会话 / 云端事件）')
  {
    usersWith([
      { id: 1, username: 'admin', password: 'x', name: '管理员', dept: '', role: 'admin', createdAt: 100 },
      { id: 2, username: 's1', password: 'x', name: '张三', dept: '饮食部·标帜餐厅', role: 'student', createdAt: 200 },
    ])
    sandbox.localStorage.setItem('eq_counter', '100')
    sandbox.localStorage.setItem('eq_session', JSON.stringify({ id: 2, username: 's1', name: '张三', dept: '饮食部·标帜餐厅', role: 'student', level: 0 }))
    sandbox.localStorage.setItem('eq_user', JSON.stringify({ name: '张三', dept: '饮食部·标帜餐厅' }))
    cloudSent.length = 0
    const r = await Store.setUserDept(2, '房务部·迎宾前台')
    assert('setUserDept ok', r.ok === true && r.old === '饮食部·标帜餐厅' && r.dept === '房务部·迎宾前台')
    let users = JSON.parse(sandbox.localStorage.getItem('eq_users'))
    assert('本地账号表部门已更新', users.find(u => u.id === 2).dept === '房务部·迎宾前台')
    let sess = JSON.parse(sandbox.localStorage.getItem('eq_session'))
    assert('当前会话部门同步', sess.dept === '房务部·迎宾前台')
    const eqUser = JSON.parse(sandbox.localStorage.getItem('eq_user'))
    assert('个人资料缓存部门同步', eqUser.dept === '房务部·迎宾前台')
    assert('云端 dept 事件已入队', cloudSent.some(e => e.ty === 'dept' && e.u === 's1' && e.d.dept === '房务部·迎宾前台'))
    // 部门未变化 → ok:false
    const r2 = await Store.setUserDept(2, '房务部·迎宾前台')
    assert('部门未变化返回 ok:false', r2.ok === false)
    // 不存在的账号
    const r3 = await Store.setUserDept(999, '饮食部')
    assert('账号不存在返回 ok:false', r3.ok === false)
  }

  console.log('\n🧪 Part B3：Store.setUserDeptByUsername（云端影子账号）')
  {
    usersWith([
      { id: 1, username: 'admin', password: 'x', name: '管理员', dept: '', role: 'admin', createdAt: 100 },
    ])
    sandbox.localStorage.setItem('eq_counter', '100')
    sandbox.localStorage.setItem('eq_session', JSON.stringify({ id: 1, username: 'admin', name: '管理员', role: 'admin' }))
    cloudSent.length = 0
    const r = await Store.setUserDeptByUsername('c9', '饮食部·WOOBAR')
    assert('影子账号调整部门 ok', r.ok === true && r.dept === '饮食部·WOOBAR')
    const users = JSON.parse(sandbox.localStorage.getItem('eq_users'))
    const c9 = users.find(u => u.username === 'c9')
    assert('已创建影子账号并写入部门', !!c9 && c9.cloudOnly === true && c9.dept === '饮食部·WOOBAR')
    assert('云端 dept 事件已入队', cloudSent.some(e => e.ty === 'dept' && e.u === 'c9' && e.d.dept === '饮食部·WOOBAR'))
  }

  console.log('\n🧪 Part B4：pullCloudChanges 同步 dept 事件 + 云端 Logo 到本地')
  {
    usersWith([
      { id: 1, username: 'admin', password: 'x', name: '管理员', dept: '', role: 'admin', createdAt: 100 },
      { id: 2, username: 's1', password: 'x', name: '张三', dept: '饮食部·标帜餐厅', role: 'student', createdAt: 200 },
    ])
    sandbox.localStorage.setItem('eq_user', JSON.stringify({ name: '张三', dept: '饮食部·标帜餐厅' }))
    sandbox.localStorage.setItem('eq_session', JSON.stringify({ id: 2, username: 's1', name: '张三', dept: '饮食部·标帜餐厅', role: 'student', level: 0 }))
    sandbox.localStorage.setItem('eq_cloud_pull_ts', '0')
    sandbox.localStorage.removeItem('eq_logo')
    fetchResult = {
      ok: true,
      map: { 's1': { username: 's1', name: '张三', dept: '房务部·迎宾前台', role: 'student' } },
      doc: {
        v: 1, base: {}, logo: LOGO_B,
        events: [
          { id: 'e1', u: 's1', n: '张三', ty: 'dept', ts: Date.now() + 1000, d: { dept: '房务部·迎宾前台' } },
        ],
      },
    }
    const pull = await Store.pullCloudChanges()
    const users = JSON.parse(sandbox.localStorage.getItem('eq_users'))
    assert('deptChanged 记录 s1', pull.applied.deptChanged.includes('s1'))
    assert('本地账号表部门已更新', users.find(u => u.username === 's1').dept === '房务部·迎宾前台')
    const sess = JSON.parse(sandbox.localStorage.getItem('eq_session'))
    assert('sessionDeptSync 标记', pull.applied.sessionDeptSync === true)
    assert('会话部门已同步（学员设备即生效）', sess.dept === '房务部·迎宾前台')
    const eqUser = JSON.parse(sandbox.localStorage.getItem('eq_user'))
    assert('eq_user 部门同步', eqUser.dept === '房务部·迎宾前台')
    assert('云端 Logo 已缓存到本地', Store.getLogo() === LOGO_B)
  }

  console.log('\n🧪 Part B5：账号管理页包含 上传Logo + 改部门 入口')
  {
    usersWith([
      { id: 1, username: 'admin', name: '管理员', dept: '', role: 'admin', createdAt: 100 },
      { id: 2, username: 's1', name: '张三', dept: '饮食部·标帜餐厅', role: 'student', createdAt: 200 },
      { id: 3, username: 's2', name: '李四', dept: '房务部', role: 'student', createdAt: 200 },
    ])
    sandbox.localStorage.setItem('eq_session', JSON.stringify({ id: 1, username: 'admin', name: '管理员', dept: '', role: 'admin' }))
    sandbox.localStorage.setItem('eq_user', JSON.stringify({ name: '管理员', dept: '' }))
    dashRows = [
      { username: 'admin', name: '管理员', dept: '', role: 'admin', loginCount: 5, loginSec: 3600,
        practiceCount: 10, practiceCorrect: 8, practiceTotal: 10, examCount: 2, examScoreSum: 180,
        examBest: 95, examPassCount: 2, placementLevel: null, lastActive: Date.now(), perQ: {} },
      { username: 's1', name: '张三', dept: '饮食部·标帜餐厅', role: 'student', loginCount: 3, loginSec: 1800,
        practiceCount: 20, practiceCorrect: 15, practiceTotal: 20, examCount: 1, examScoreSum: 88,
        examBest: 88, examPassCount: 1, placementLevel: 3, lastActive: Date.now(), perQ: {} },
      { username: 's2', name: '李四', dept: '房务部', role: 'student', loginCount: 1, loginSec: 600,
        practiceCount: 5, practiceCorrect: 3, practiceTotal: 5, examCount: 0, examScoreSum: 0,
        examBest: 0, examPassCount: 0, placementLevel: null, lastActive: 0, perQ: {} },
    ]
    // 拦截真实云端拉取（避免受 Part B4 影响）
    Store.pullCloudChanges = async () => ({ ok: true, applied: { roleChanged: [], renamed: [], deleted: [], added: [], deptChanged: [], sessionRoleSync: false, sessionDeptSync: false } })
    await vm.runInContext('renderUsers()', sandbox)
    const html = getElOf('page-users').innerHTML
    assert('工具栏含「上传 Logo」按钮', html.includes('上传 Logo') && html.includes('openLogoModal'))
    assert('工具栏仍含「新增账号」', html.includes('新增账号'))
    assert('学员行有「改部门」按钮', html.includes('改部门') && html.includes('changeUserDeptUI'))
    assert('改部门按钮携带学员 id', html.includes('changeUserDeptUI(2,'))
    assert('改部门按钮携带当前部门', html.includes('饮食部·标帜餐厅'))
    // 管理员行不加改部门按钮（admin id=1 不带 changeUserDeptUI(1）
    assert('管理员行不出现改部门', !html.includes('changeUserDeptUI(1,'))
  }

  console.log('\n' + (testFailed ? '❌ 部分测试失败' : '✅ Logo / 调整部门 测试全部通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(2) })
