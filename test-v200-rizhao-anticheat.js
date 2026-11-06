// v200 建立 → **v204 撤下**：日照账号防作弊豁免已移除，恢复 v65 单一管理员豁免
// 背景：v200 为日照测试期临时关闭防切屏（2026-10-30 用户要求）；v204（2026-11-06）测试结束，
//       按用户要求「给本轮日照 21 天重新上防切出去的模式」→ 豁免撤下，日照学员恢复全口径监听。
// 本套件现为 v204 反向契约：日照与餐饮同口径（激活 / 挂监听 / 切屏计数 / 达上限强制交卷），
//       管理员豁免不回归，isRizhaoUser 死代码零残留，调用点不动（豁免收口在模块内）。
const fs = require('fs')
const vm = require('vm')

function makeEmitter() {
  const ls = {}
  return {
    listeners: ls,
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn) },
    removeEventListener(t, fn) { if (ls[t]) ls[t] = ls[t].filter(f => f !== fn) },
    emit(t, payload) { (this.listeners[t] || []).forEach(f => { try { f(payload) } catch (e) {} }) }
  }
}
const fakeElem = () => ({
  style: {}, classList: { toggle() {}, add() {}, remove() {} },
  innerHTML: '', _children: [],
  appendChild(c) { this._children.push(c); return c },
  remove() { this._removed = true },
  querySelectorAll() { return [] },
  set textContent(v) { this._t = v }
})

function mkSandbox(opts) {
  const winEmit2 = makeEmitter()
  const docEmit2 = makeEmitter()
  const sb = {
    console, Date, Math, JSON, Set, Map, Promise, Array, Object, String, Number, RegExp, Error,
    setTimeout, clearTimeout,
    window: Object.assign({}, winEmit2, { focus() {} }),
    document: Object.assign({}, docEmit2, {
      hidden: false,
      body: { appendChild() {}, removeChild() {} },
      createElement: () => fakeElem(),
      addEventListener: docEmit2.addEventListener.bind(docEmit2),
      removeEventListener: docEmit2.removeEventListener.bind(docEmit2)
    }),
    t: (k) => {
      const map = { anticheatWarn: 'Warn', anticheatWarnDesc: 'left {n}', anticheatFinal: 'Final', anticheatAck: 'OK' }
      return map[k] !== undefined ? map[k] : k
    },
    Store: {
      isAdmin: () => !!opts.admin,
      getSessionDept: () => (opts.dept === undefined ? '' : opts.dept)
    }
  }
  sb.globalThis = sb
  vm.createContext(sb)
  sb.__clock = 1750000000000
  vm.runInContext('Date.now = function () { return __clock }', sb)
  vm.runInContext(fs.readFileSync('anti-cheat.js', 'utf8'), sb)
  return sb
}

let pass = 0, fail = 0, fails = []
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; fails.push(name); console.log('  ✗ ' + name) } }
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）', a === b) }

console.log('=== 组一 日照学员恢复全口径（v204 核心行为）===')
eq('日照-餐饮 start 后 isActive=true', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮' })
  sb.window.AntiCheat.start({ maxViolations: 3, onSubmit: () => {} })
  return sb.window.AntiCheat.isActive()
})(), true)
eq('日照-房务 start 后 isActive=true', (function () {
  const sb = mkSandbox({ dept: '日照·日照-房务' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  return sb.window.AntiCheat.isActive()
})(), true)
eq('slug 写法 rizhao/canyin 同口径激活', (function () {
  const sb = mkSandbox({ dept: 'rizhao/canyin' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  return sb.window.AntiCheat.isActive()
})(), true)
ok('日照学员挂满 7 个监听（doc 5 + win 2，与餐饮同口径）', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  const nd = Object.keys(sb.document.listeners || {}).length
  const nw = Object.keys(sb.window.listeners || {}).length
  return nd === 5 && nw === 2
})())
ok('日照学员切屏计 1（去抖后 blur 不重复计）', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  sb.document.hidden = true
  sb.document.emit('visibilitychange')
  sb.window.emit('blur')
  return sb.window.AntiCheat.getViolations() === 1
})())
ok('日照学员连续切屏 3 次（间隔>1.5s）→ 计 3 + 强制交卷 + 停监听', (function () {
  const sb = mkSandbox({ dept: '日照·日照-房务' })
  let submitted = ''
  sb.setTimeout = (fn) => { fn(); return 0 }   // 同步穿透 700ms 延迟交卷
  sb.window.AntiCheat.start({ maxViolations: 3, onSubmit: (why) => { submitted = why } })
  for (let i = 0; i < 3; i++) {
    sb.document.hidden = true
    sb.document.emit('visibilitychange')
    sb.document.hidden = false
    vm.runInContext('__clock += 2000', sb)   // 跨过去抖窗口
  }
  return sb.window.AntiCheat.getViolations() === 3 && submitted === 'cheat' && !sb.window.AntiCheat.isActive()
})())

console.log('=== 组二 管理员豁免不回归（v65 原状）===')
eq('管理员 start 后 isActive=false', (function () {
  const sb = mkSandbox({ dept: '饮食部·标帜餐厅', admin: true })
  sb.window.AntiCheat.start({})
  return sb.window.AntiCheat.isActive()
})(), false)
ok('管理员不挂任何监听', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮', admin: true })
  sb.window.AntiCheat.start({})
  return Object.keys(sb.document.listeners || {}).length + Object.keys(sb.window.listeners || {}).length === 0
})())
ok('餐饮学员照常激活（对照）', (function () {
  const sb = mkSandbox({ dept: '饮食部·标帜餐厅' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  return sb.window.AntiCheat.isActive()
})())

console.log('=== 组三 源码契约（v204 反向 + 死代码零残留）===')
const src = fs.readFileSync('anti-cheat.js', 'utf8')
ok('start 豁免收口为仅管理员', src.indexOf('if (isAdminUser()) { stop(); return }') >= 0)
ok('isRizhaoUser 判定已整段移除（无函数定义、无调用、无导出）',
  src.indexOf('function isRizhaoUser') < 0 && src.indexOf('isRizhaoUser()') < 0 && src.indexOf('isRizhaoUser,') < 0)
ok('normDept 兜底引用随之移除', src.indexOf('normDept') < 0)
ok('导出清单已去掉 isRizhaoUser', src.indexOf('return { start, stop, isActive, getViolations, dismiss, isAdminUser }') >= 0)
ok('头部注释标明 v204 撤下', src.indexOf('v204') >= 0 && src.indexOf('豁免撤下') >= 0)
ok('撤下缘由可追溯（v200 时间戳在案）', src.indexOf('2026-10-30') >= 0 && src.indexOf('2026-11-06') >= 0)

console.log('=== 组四 调用点不动（豁免收口在模块内） ===')
const capp = fs.readFileSync('app.js', 'utf8')
const cch = fs.readFileSync('challenge.js', 'utf8')
const cco = fs.readFileSync('course-app.js', 'utf8')
ok('app.js 考试调用点原样（无部门分支）', capp.indexOf("AntiCheat.start({ maxViolations: 3, onSubmit: function () { finishExam(false) } })") >= 0)
ok('challenge.js 测试调用点原样', cch.indexOf('AntiCheat.start({ maxViolations: 3, onSubmit: chCheatSubmit })') >= 0)
ok('course-app.js 调用点原样', cco.indexOf('AntiCheat.start({') >= 0)
ok('app.js 注释已同步（v204 撤下）', capp.indexOf('已于 v204 撤下') >= 0)
ok('challenge.js 注释已同步（v204 撤下）', cch.indexOf('已于 v204 撤下') >= 0)

console.log('')
console.log(pass + ' 通过, ' + fail + ' 失败' + (fail ? ' ❌' : ' ✅'))
if (fail) fails.forEach(f => console.log('  ✗ ' + f))
process.exit(fail ? 1 : 0)
