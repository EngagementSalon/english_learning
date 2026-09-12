// ====== 测试 v7 培训题并入饮食部迁移 + 管理员权限设置 ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

function makeSandbox(prefill) {
  const sb = {
    localStorage: {
      store: Object.assign({}, prefill),
      getItem(k) { return this.store[k] || null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    console,
    setInterval() { return 0 },
    clearInterval() {},
    setTimeout() { return 0 },
    clearTimeout() {},
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    // 密码哈希所需的浏览器全局（沙箱默认没有）
    TextEncoder,
    Uint8Array,
    crypto,
    // 云端同步 mock：捕获入队事件
    CloudSync: {
      queue: [],
      enqueue(ev) { this.queue.push(ev) },
      pushPending() { return Promise.resolve() },
      setUser() {},
      flushDuration() {},
      setRole() {},
    },
    t: (key) => key,
  }
  vm.createContext(sb)
  return sb
}

// ---------- 场景 1：v7 迁移（storedVer=6 → 7）----------
;(async () => {
  console.log('\n🧪 场景 1：v7 培训题并入饮食部迁移')
  // 模拟已升级到 v6 的设备：localStorage 里有 9001+ 培训合并题（dept='all'）+ 管理员自定义题
  const oldQs = [
    { id: 9001, dept: 'all', category_id: 11, type: 'single', question: '培训理解题1', options: ['a','b','c','d'], answer: [0], difficulty: 1 },
    { id: 9002, dept: 'all', category_id: 11, type: 'pronounce', question: '培训发音题1', options: [], answer: [0], difficulty: 1 },
    { id: 5000, dept: 'dining', category_id: 1, type: 'single', question: '管理员自定义题', options: ['a','b','c','d'], answer: [0], difficulty: 1 },
    { id: 6000, dept: 'all', category_id: 11, type: 'single', question: '通用核心词汇题', options: ['a','b','c','d'], answer: [0], difficulty: 1 },
  ]
  const sb1 = makeSandbox({
    eq_bank_version: '6',
    eq_course_only_v43: '1',   // v43 一次性清空逻辑与本测试无关，预置 flag 跳过
    eq_questions: JSON.stringify(oldQs),
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb1)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb1)
  const Store1 = vm.runInContext('Store', sb1)
  Store1.init()

  const qs1 = Store1.getQuestions()
  const tr9001 = qs1.find(q => q.id === 9001)
  const tr9002 = qs1.find(q => q.id === 9002)
  assert('9001 培训题 dept 迁移为 dining', tr9001 && tr9001.dept === 'dining', `got ${tr9001 && tr9001.dept}`)
  assert('9002 培训题 dept 迁移为 dining', tr9002 && tr9002.dept === 'dining', `got ${tr9002 && tr9002.dept}`)
  assert('自定义题 5000 保留且 dept 不变', qs1.some(q => q.id === 5000 && q.dept === 'dining'))
  assert('通用题 6000 保持 dept=all', qs1.some(q => q.id === 6000 && q.dept === 'all'))
  const bankVer1 = vm.runInContext('BANK.version', sb1)
  assert('版本升级为 9', bankVer1 === 9, `got ${bankVer1}`)
  const verStored = sb1.localStorage.getItem('eq_bank_version')
  assert('localStorage 版本写入 9', verStored === '9', `got ${verStored}`)
})().then(() => {
  // ---------- 场景 2：全新用户（storedVer=0 → 7），培训题直接并入饮食部 ----------
  return new Promise(resolve => {
    console.log('\n🧪 场景 2：全新用户培训题直接并入饮食部')
    const sb2 = makeSandbox({ eq_course_only_v43: '1' })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb2)
    // 培训题库种子（training-questions.js）
    const trSrc = fs.readFileSync(path.join(__dirname, 'training-questions.js'), 'utf-8')
    vm.runInContext(trSrc, sb2)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb2)
    const Store2 = vm.runInContext('Store', sb2)
    Store2.init()

    const qs2 = Store2.getQuestions()
    const trCount = qs2.filter(q => q.id >= 9001).length
    assert('培训题已合并进统一题库（>0 道）', trCount > 0, `got ${trCount}`)
    assert('培训合并题全部 dept=dining', qs2.filter(q => q.id >= 9001).every(q => q.dept === 'dining'))
    const all2 = qs2.filter(q => q.dept === 'all')
    assert('通用题（cat11 原核心词汇）保留', all2.length > 0, `got ${all2.length}`)
    resolve()
  })
}).then(async () => {
  // ---------- 场景 3：setUserRole 管理员权限设置 ----------
  console.log('\n🧪 场景 3：设置/取消管理员权限')
  const sb3 = makeSandbox({ eq_course_only_v43: '1' })
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb3)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb3)
  const Store3 = vm.runInContext('Store', sb3)
  Store3.init()

  // 种子管理员（id=1, admin/admin123），登录
  await Store3.login('admin', 'admin123')
  // 添加学员
  const addR = await Store3.addUser({ username: 'stu1', password: '1234', name: '学员一', dept: '饮食部·标帜餐厅', role: 'student' })
  assert('新增学员成功', addR && addR.ok !== false, JSON.stringify(addR))
  const stu = Store3.getUsers().find(u => u.username === 'stu1')
  assert('学员初始 role=student', stu && stu.role === 'student')

  // 设为管理员
  const up = await Store3.setUserRole(stu.id, 'admin')
  assert('设为管理员成功', up.ok === true && up.role === 'admin', JSON.stringify(up))
  const stu2 = Store3.getUsers().find(u => u.username === 'stu1')
  assert('账号表 role 已更新为 admin', stu2.role === 'admin')
  const roleEvents = sb3.CloudSync.queue.filter(e => e.ty === 'role' && e.u === 'stu1')
  assert('云端 role 事件已入队', roleEvents.length === 1 && roleEvents[0].d.role === 'admin')

  // 重复设为管理员 → 报错
  const dup = await Store3.setUserRole(stu.id, 'admin')
  assert('重复设置返回错误', dup.ok === false)

  // 取消管理员
  const down = await Store3.setUserRole(stu.id, 'student')
  assert('取消管理员成功', down.ok === true && down.role === 'student')
  assert('云端 role 事件已入队（student）', sb3.CloudSync.queue.some(e => e.ty === 'role' && e.u === 'stu1' && e.d.role === 'student'))

  // 取消自己的管理员 → 拒绝（防止锁死）
  const self = await Store3.setUserRole(1, 'student')
  assert('不能取消自己的管理员权限', self.ok === false, JSON.stringify(self))
  const adminAfter = Store3.getUsers().find(u => u.id === 1)
  assert('自己仍是 admin', adminAfter.role === 'admin')

  // 会话同步：给当前用户改角色（若当前用户被设为 admin 时同步会话）
  await Store3.addUser({ username: 'stu2', password: '1234', name: '学员二', role: 'student' })
  const stu2u = Store3.getUsers().find(u => u.username === 'stu2')
  return Promise.resolve(stu2u)
}).then(stu2u => {
  // ---------- 场景 4：cloud-store _apply 支持 role 事件 ----------
  console.log('\n🧪 场景 4：云端聚合 role 事件')
  const sb4 = makeSandbox({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb4)
  const CloudSync4 = vm.runInContext('CloudSync', sb4)
  const map = {}
  CloudSync4._apply(map, { u: 'stu1', n: '学员一', ty: 'register', ts: 1000, d: { name: '学员一', role: 'student' } })
  assert('注册事件 role=student', map.stu1.role === 'student')
  CloudSync4._apply(map, { u: 'stu1', ty: 'role', ts: 2000, d: { role: 'admin' } })
  assert('role 事件把聚合记录改为 admin', map.stu1.role === 'admin')
  CloudSync4._apply(map, { u: 'stu1', ty: 'role', ts: 3000, d: { role: 'student' } })
  assert('role 事件改回 student', map.stu1.role === 'student')

  console.log('\n' + (testFailed ? '❌ 有失败断言' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
}).catch(e => { console.error('测试异常:', e); process.exit(1) })
