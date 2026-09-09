// ====== 测试 pullCloudChanges：拉云端 events 应用到本地 users 表 ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

// 简易 cloud doc mock（由 fetchSyncSummary 使用）
function makeCloudMock(docs) {
  return {
    queue: [],
    enqueue(ev) { this.queue.push(ev) },
    pushPending() { return Promise.resolve() },
    setUser() {},
    flushDuration() {},
    fetchSyncSummary() { return Promise.resolve(docs) },
  }
}

// 用 vm 加载 store.js，并注入 CloudSync mock
function makeSandbox({ prefetchedStore = {}, cloudMock }) {
  const sb = {
    localStorage: {
      store: Object.assign({}, prefetchedStore),
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
    CloudSync: cloudMock,
    t: (k) => k,
  }
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
  return sb
}

;(async () => {
  // ===== 场景 1：拉 role 事件 → 本地用户表更新 =====
  console.log('\n🧪 场景 1：拉 role 事件 → 本地更新')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', name: '管理员', dept: '', role: 'admin', createdAt: 100 },
        { id: 2, username: 'alice', password: 'a', name: 'Alice', dept: '餐饮', role: 'student', createdAt: 200 },
      ]),
      eq_counter: '100',
      eq_session: JSON.stringify({ id: 1, username: 'admin', name: '管理员', role: 'admin' }),
      eq_cloud_pull_ts: '0',
    }
    const cloudMap = { admin: { username: 'admin', name: '管理员', role: 'admin', dept: '', createdAt: 100 }, alice: { username: 'alice', name: 'Alice', role: 'admin', dept: '餐饮', createdAt: 200 } }
    const cloudMock = makeCloudMock({ ok: true, map: cloudMap, doc: { v: 1, base: cloudMap, events: [{ id: 'e1', u: 'alice', n: 'Alice', ty: 'role', ts: 1000, d: { role: 'admin' } }] } })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    assert('返回 ok', r.ok === true)
    assert('角色变更 1 条', r.applied.roleChanged.length === 1 && r.applied.roleChanged[0].username === 'alice' && r.applied.roleChanged[0].role === 'admin')
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    const alice = users.find(u => u.username === 'alice')
    assert('alice.role 变 admin', alice.role === 'admin')
    assert('lastTs 更新到 1000', JSON.parse(sb.localStorage.getItem('eq_cloud_pull_ts')) === 1000)
  }

  // ===== 场景 2：拉 rename 事件 → 本地用户名改名 =====
  console.log('\n🧪 场景 2：拉 rename 事件 → 本地改名')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', name: '管理员', role: 'admin', createdAt: 100 },
        { id: 2, username: 'alice', password: 'a', name: 'Alice', role: 'student', createdAt: 200 },
      ]),
      eq_counter: '100',
      eq_session: JSON.stringify({ id: 1, username: 'admin', name: '管理员', role: 'admin' }),
      eq_cloud_pull_ts: '0',
    }
    const cloudMap = { admin: { username: 'admin', name: '管理员', role: 'admin', createdAt: 100 }, 'alice2': { username: 'alice2', name: 'Alice', role: 'student', dept: '', createdAt: 200 } }
    const cloudMock = makeCloudMock({ ok: true, map: cloudMap, doc: { v: 1, base: cloudMap, events: [{ id: 'e1', u: 'alice', ty: 'rename', ts: 1000, d: { nu: 'alice2' } }] } })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    assert('返回 ok', r.ok === true)
    assert('改名 1 条', r.applied.renamed.length === 1 && r.applied.renamed[0].from === 'alice' && r.applied.renamed[0].to === 'alice2')
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    assert('本地仍 2 用户', users.length === 2)
    assert('本地有 alice2 无 alice', users.some(u => u.username === 'alice2') && !users.some(u => u.username === 'alice'))
  }

  // ===== 场景 3：拉 delete 事件 → 本地用户被删除 =====
  console.log('\n🧪 场景 3：拉 delete 事件 → 本地用户被删除')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', name: '管理员', role: 'admin' },
        { id: 2, username: 'bob', password: 'b', name: 'Bob', role: 'student' },
      ]),
      eq_session: JSON.stringify({ id: 1, username: 'admin', role: 'admin' }),
      eq_cloud_pull_ts: '0',
    }
    const cloudMap = { admin: { username: 'admin', name: '管理员', role: 'admin' } }
    const cloudMock = makeCloudMock({ ok: true, map: cloudMap, doc: { v: 1, base: cloudMap, events: [{ id: 'e1', u: 'bob', ty: 'delete', ts: 500, d: {} }] } })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    assert('本地只 1 用户', users.length === 1 && users[0].username === 'admin')
    assert('deleted 数组记录 bob', r.applied.deleted.includes('bob'))
  }

  // ===== 场景 4：云端有但本地无 → 建影子账户 =====
  console.log('\n🧪 场景 4：建影子账户')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', name: '管理员', role: 'admin' },
      ]),
      eq_counter: '100',
      eq_session: JSON.stringify({ id: 1, username: 'admin', role: 'admin' }),
      eq_cloud_pull_ts: '0',
    }
    const cloudMap = { admin: { username: 'admin', name: '管理员', role: 'admin' }, 'newbie': { username: 'newbie', name: '新人小张', role: 'student', dept: '餐饮', createdAt: 3000 } }
    const cloudMock = makeCloudMock({ ok: true, map: cloudMap, doc: { v: 1, base: cloudMap, events: [{ id: 'e1', u: 'newbie', n: '新人小张', ty: 'register', ts: 3000, d: { name: '新人小张', dept: '餐饮', role: 'student' } }] } })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    assert('本地新增 newbie', users.some(u => u.username === 'newbie'))
    const newbie = users.find(u => u.username === 'newbie')
    assert('newbie 标记 cloudOnly', newbie.cloudOnly === true)
    assert('newbie 密码为空（不能跨设备登录）', newbie.password === '')
    assert('added 数组记录 newbie', r.applied.added.includes('newbie'))
    assert('counter 已递增', JSON.parse(sb.localStorage.getItem('eq_counter')) >= 101)
  }

  // ===== 场景 5：当前 session 角色被云端覆盖 =====
  console.log('\n🧪 场景 5：当前 session 角色与本地不同 → 同步')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', name: '管理员', role: 'student', createdAt: 100 }, // 本地旧值
      ]),
      eq_session: JSON.stringify({ id: 1, username: 'admin', name: '管理员', role: 'student' }),
      eq_cloud_pull_ts: '0',
    }
    const cloudMap = { admin: { username: 'admin', name: '管理员', role: 'admin' } }
    const cloudMock = makeCloudMock({ ok: true, map: cloudMap, doc: { v: 1, base: cloudMap, events: [{ id: 'e1', u: 'admin', ty: 'role', ts: 500, d: { role: 'admin' } }] } })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    const sess = JSON.parse(sb.localStorage.getItem('eq_session'))
    assert('session role 已同步到 admin', sess.role === 'admin')
    assert('sessionRoleSync 为 true', r.applied.sessionRoleSync === true)
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    assert('本地 users 表 admin.role 也变 admin', users.find(u => u.username === 'admin').role === 'admin')
  }

  // ===== 场景 6：offline → ok=false，不报错 =====
  console.log('\n🧪 场景 6：offline 时不抛错')
  {
    const prefetched = {
      eq_users: JSON.stringify([{ id: 1, username: 'admin', password: 'a', role: 'admin' }]),
      eq_session: JSON.stringify({ id: 1, username: 'admin', role: 'admin' }),
    }
    const cloudMock = makeCloudMock(null)
    cloudMock.fetchSyncSummary = () => Promise.resolve({ ok: false, reason: 'offline' })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    assert('offline 返回 ok=false', r.ok === false)
    assert('reason=offline', r.reason === 'offline')
    // 本地数据没动
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    assert('本地用户表不变', users.length === 1)
  }

  // ===== 场景 7：lastTs 已在上次拉到的位置，后续重复 ts 不会再应用 =====
  console.log('\n🧪 场景 7：增量拉取（lastTs 后只处理新事件）')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', role: 'admin' },
        { id: 2, username: 'a', password: 'a', role: 'student' },
      ]),
      eq_session: JSON.stringify({ id: 1, username: 'admin', role: 'admin' }),
      eq_cloud_pull_ts: '500', // 上次已经处理过 ts<=500 的事件
    }
    const cloudMap = { admin: { username: 'admin', role: 'admin' }, 'a': { username: 'a', role: 'admin' } }
    const cloudMock = makeCloudMock({ ok: true, map: cloudMap, doc: { v: 1, base: cloudMap, events: [
      { id: 'e1', u: 'a', ty: 'role', ts: 300, d: { role: 'student' } }, // 旧事件，不应回退
      { id: 'e2', u: 'a', ty: 'role', ts: 1000, d: { role: 'admin' } }, // 新事件，要应用
    ] } })
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)
    const r = await Store.pullCloudChanges()
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    const aUser = users.find(u => u.username === 'a')
    assert('a 仍为 admin（300 事件跳过）', aUser.role === 'admin')
    assert('applied 1 条角色变更（admin）', r.applied.roleChanged.length === 1 && r.applied.roleChanged[0].username === 'a' && r.applied.roleChanged[0].role === 'admin', `got ${JSON.stringify(r.applied.roleChanged)}`)
  }

  // ===== 场景 8：setUserRole 走完整往返（A 改 B 权限 → 推云端事件 → 等下次 B 拉取同步） =====
  console.log('\n🧪 场景 8：端到端 A→云端→B')
  {
    const prefetched = {
      eq_users: JSON.stringify([
        { id: 1, username: 'admin', password: 'a', role: 'admin' },
        { id: 2, username: 'bob', password: 'b', role: 'student' },
      ]),
      eq_session: JSON.stringify({ id: 1, username: 'admin', role: 'admin' }),
      eq_counter: '100',
      eq_cloud_pull_ts: '0',
    }
    const events = []
    const cloudMock = {
      enqueue(ev) { events.push(ev) },
      pushPending() { return Promise.resolve() },
      setUser() {},
      flushDuration() {},
      fetchSyncSummary() {
        // 服务端视角：events 都已上云，重新构造 map（简单的 _apply：register/role/delete 直接给值）
        const map = {}
        map['admin'] = { username: 'admin', name: '管理员', role: 'admin', dept: '', createdAt: 100 }
        map['bob'] = { username: 'bob', name: 'Bob', role: 'student', dept: '餐饮', createdAt: 200 }
        // 模拟 role 事件已生效
        const roleEv = events.find(e => e.ty === 'role' && e.u === 'bob')
        if (roleEv) map['bob'].role = roleEv.d.role
        return Promise.resolve({ ok: true, map, doc: { v: 1, base: map, events } })
      },
    }
    const sb = makeSandbox({ prefetchedStore: prefetched, cloudMock })
    const Store = vm.runInContext('Store', sb)

    // A 设备上把 bob 设为管理员
    const r = await Store.setUserRole(2, 'admin')
    assert('setUserRole ok', r.ok === true)
    assert('云端事件已入队', events.some(e => e.ty === 'role' && e.u === 'bob' && e.d.role === 'admin'))

    // B 设备拉云端
    const pull = await Store.pullCloudChanges()
    const users = JSON.parse(sb.localStorage.getItem('eq_users'))
    assert('B 设备上 bob 变 admin', users.find(u => u.username === 'bob').role === 'admin')
  }

  console.log(testFailed ? '\n❌ 部分测试失败' : '\n✅ pullCloudChanges 测试全部通过')
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(2) })
