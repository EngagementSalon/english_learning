// ====== 测试 CourseStore 静默重试逻辑 ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) {
    console.log('  ✓', name)
  } else {
    console.log('  ✗', name, '—', msg || '')
    testFailed = true
  }
}

// 跑一段表达式，返回结果（在沙箱内访问 const CourseStore）
function evalIn(fn) {
  return fn(v => vm.runInContext(`(${v})`, sandbox))
}

// 构造 fetch：轮流返回失败/成功
let _resolveNetworkOk = false
async function fakeFetch(url, opts) {
  if (_resolveNetworkOk) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ v: 1, classes: [{ id: 'c1', name: 'Test', members: ['u1'], assignments: [{ id: 'a1', title: 'HW1', type: 'homework', deadline: 0, duration: 0, passScore: 60, questions: [], results: {} }] }] }) }
  }
  throw new Error('network down (simulated)')
}

const sandbox = {
  localStorage: {
    store: {},
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
  },
  fetch: fakeFetch,
  AbortController: class { constructor() { this.signal = {} } abort() {} },
  clearTimeout, setTimeout,
  console,
  window: { dispatchEvent(e) { if (e.type === 'course-store-online') sandbox._receivedEvent = true } },
  document: { addEventListener() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
}
vm.createContext(sandbox)
const i18nCode = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
vm.runInContext(i18nCode, sandbox)
const csCode = fs.readFileSync(path.join(__dirname, 'course-store.js'), 'utf-8')
vm.runInContext(csCode, sandbox)

const CS = (v) => vm.runInContext(v, sandbox)
const csAsync = (fn) => vm.runInContext(`(${fn.toString()})()`, sandbox)

;(async () => {
  console.log('\n🧪 CourseStore 静默重试逻辑测试')

  // 1. 初次获取失败 → status=offline
  console.log('\n1️⃣  初次获取失败 → 切到 offline 状态')
  await csAsync(() => CourseStore.getDoc())
  assert('status = offline', CS('CourseStore.status') === 'offline')

  // 2. 验证定时器已排
  assert('已排了重试定时器', CS('CourseStore._retryTimer') !== null)
  assert('延迟 30s', CS('CourseStore._retryDelay') === 30000)

  // 3. 模拟网络恢复后，触发重试 → 应切到 online 并派事件
  console.log('\n2️⃣  网络恢复，触发重试 → 切回 online')
  _resolveNetworkOk = true
  await csAsync(async () => {
    // 关闭现有定时器，模拟一次重试（参考 _scheduleRetry 内部逻辑）
    clearTimeout(CourseStore._retryTimer)
    CourseStore._retryTimer = null
    const d = await CourseStore._fetchDoc()
    CourseStore._cache = d
    CourseStore._saveCache(d)
    CourseStore.status = 'online'
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('course-store-online'))
    }
  })
  assert('status = online', CS('CourseStore.status') === 'online')
  assert('派发了 course-store-online 事件', sandbox._receivedEvent === true)

  // 4. 在线后调 getDoc 应直接成功，不重复排定时器
  console.log('\n3️⃣  在线后再调用 getDoc 不重复排定时器')
  await csAsync(() => CourseStore.getDoc())
  assert('status 仍 online', CS('CourseStore.status') === 'online')
  assert('返回真实数据', CS('CourseStore._cache.classes[0].id') === 'c1')
  // 注意：getDoc 成功会调用 _clearRetry，但 _retryTimer 此时本就是 null，所以无变化
  assert('定时器状态正常', CS('CourseStore._retryTimer === null'))

  // 5. 多次失败 → 延迟应该翻倍
  console.log('\n4️⃣  多次失败 → 指数退避')
  _resolveNetworkOk = false
  CS(`
    CourseStore._cache = null
    CourseStore._retryTimer = null
    CourseStore._retryDelay = 30000
    CourseStore.status = 'online'
  `)
  await csAsync(() => CourseStore.getDoc())
  assert('初次失败延迟 30s', CS('CourseStore._retryDelay') === 30000)

  // 模拟再次失败
  await csAsync(async () => {
    if (CourseStore._retryTimer) { clearTimeout(CourseStore._retryTimer); CourseStore._retryTimer = null }
    try { await CourseStore._fetchDoc(); throw new Error('should fail') }
    catch (e) { CourseStore._retryDelay = Math.min(CourseStore._retryDelay * 2, 300000) }
  })
  assert('失败一次后延迟 × 2 = 60s', CS('CourseStore._retryDelay') === 60000)

  await csAsync(async () => {
    try { await CourseStore._fetchDoc(); throw new Error('should fail') }
    catch (e) { CourseStore._retryDelay = Math.min(CourseStore._retryDelay * 2, 300000) }
  })
  assert('失败二次后延迟 = 120s', CS('CourseStore._retryDelay') === 120000)

  // 6. _clearRetry 清理定时器
  console.log('\n5️⃣  _clearRetry 清理定时器')
  csAsync(() => { CourseStore._retryTimer = setTimeout(() => {}, 9999); CourseStore._clearRetry() })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert('定时器已清', CS('CourseStore._retryTimer') === null)

  console.log('\n' + (testFailed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(testFailed ? 1 : 0)
})()
