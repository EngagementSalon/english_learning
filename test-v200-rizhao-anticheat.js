// v200：日照账号防作弊豁免 —— AntiCheat.start 对日照-餐饮/日照-房务学员一律不激活
// 覆盖：管理员豁免不回归 / 日照中文值·slug 值·归一化命中三路豁免 / 非日照（餐饮、房务本部、其他部门、无部门）照常挂监听
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
const winEmit = makeEmitter()
const docEmit = makeEmitter()
const fakeElem = () => ({
  style: {}, classList: { toggle() {}, add() {}, remove() {} },
  innerHTML: '', _children: [],
  appendChild(c) { this._children.push(c); return c },
  remove() { this._removed = true },
  querySelectorAll() { return [] },
  set textContent(v) { this._t = v }
})

// normDept 的极简替身（签名/返回形状与 app.js 一致：{ majorKey, key }）
const normDeptFake = (value) => {
  const s = String(value == null ? '' : value).trim()
  const TABLE = {
    '饮食部·标帜餐厅': { majorKey: 'dining', key: 'dining/sig' },
    '房务部·迎宾前台': { majorKey: 'rooms', key: 'rooms/fo' },
    '日照·日照-餐饮': { majorKey: 'rizhao', key: 'rizhao/canyin' },
    '日照·日照-房务': { majorKey: 'rizhao', key: 'rizhao/fangwu' },
    '其他部门·工程部': { majorKey: 'other', key: '' },
    'rizhao/fangwu': { majorKey: 'rizhao', key: 'rizhao/fangwu' }
  }
  return TABLE[s] || null
}

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
    normDept: normDeptFake,
    Store: {
      isAdmin: () => !!opts.admin,
      getSessionDept: () => (opts.dept === undefined ? '' : opts.dept)
    }
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync('anti-cheat.js', 'utf8'), sb)
  return sb
}

let pass = 0, fail = 0, fails = []
function ok(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name) } else { fail++; fails.push(name); console.log('  \u2717 ' + name) } }
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）', a === b) }

console.log('=== 组一 豁免判定 ===')
const s1 = mkSandbox({ dept: '日照·日照-餐饮' })
eq('isRizhaoUser 中文值命中', s1.window.AntiCheat.isRizhaoUser(), true)
const s2 = mkSandbox({ dept: '日照·日照-房务' })
eq('isRizhaoUser 中文值命中（房务）', s2.window.AntiCheat.isRizhaoUser(), true)
const s3 = mkSandbox({ dept: 'rizhao/fangwu' })
eq('isRizhaoUser slug 值命中', s3.window.AntiCheat.isRizhaoUser(), true)
const s4 = mkSandbox({ dept: '饮食部·标帜餐厅' })
eq('isRizhaoUser 餐饮不命中', s4.window.AntiCheat.isRizhaoUser(), false)
const s5 = mkSandbox({ dept: '其他部门·工程部' })
eq('isRizhaoUser 其他部门不命中', s5.window.AntiCheat.isRizhaoUser(), false)
const s6 = mkSandbox({ dept: '' })
eq('isRizhaoUser 空部门不命中', s6.window.AntiCheat.isRizhaoUser(), false)

console.log('=== 组二 start 豁免行为 ===')
// 日照账号：start 后不激活、无监听
eq('日照账号 start 后 isActive=false', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮' })
  sb.window.AntiCheat.start({ maxViolations: 3, onSubmit: () => {} })
  return sb.window.AntiCheat.isActive()
})(), false)
ok('日照账号不挂任何监听', (function () {
  const sb = mkSandbox({ dept: '日照·日照-房务' })
  sb.window.AntiCheat.start({})
  const n = Object.keys(sb.document.listeners || {}).length + Object.keys(sb.window.listeners || {}).length
  return n === 0
})())
// 管理员豁免不回归
eq('管理员豁免不回归', (function () {
  const sb = mkSandbox({ dept: '饮食部·标帜餐厅', admin: true })
  sb.window.AntiCheat.start({})
  return sb.window.AntiCheat.isActive()
})(), false)
// Store 缺 getSessionDept（旧环境）→ 不豁免
ok('Store 无 getSessionDept → 不豁免（保持原行为）', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮' })
  delete sb.Store.getSessionDept
  sb.window.AntiCheat.start({})
  return sb.window.AntiCheat.isActive()
})())

console.log('=== 组三 非日照照常挂监听 + 计数 ===')
ok('餐饮学员 start 后激活', (function () {
  const sb = mkSandbox({ dept: '饮食部·标帜餐厅' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  return sb.window.AntiCheat.isActive()
})())
ok('餐饮学员切屏计 1（去抖后 blur 不重复计）', (function () {
  const sb = mkSandbox({ dept: '饮食部·标帜餐厅' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  sb.document.hidden = true
  sb.document.emit('visibilitychange')
  sb.window.emit('blur')
  return sb.window.AntiCheat.getViolations() === 1
})())
ok('房务本部学员照常激活', (function () {
  const sb = mkSandbox({ dept: '房务部·迎宾前台' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  return sb.window.AntiCheat.isActive()
})())
ok('日照学员即使切屏也不计违规', (function () {
  const sb = mkSandbox({ dept: '日照·日照-餐饮' })
  sb.window.AntiCheat.start({ maxViolations: 3 })
  sb.document.hidden = true
  sb.document.emit('visibilitychange')
  sb.window.emit('blur')
  return sb.window.AntiCheat.getViolations() === 0 && !sb.window.AntiCheat.isActive()
})())

console.log('=== 组四 源码契约 ===')
const src = fs.readFileSync('anti-cheat.js', 'utf8')
ok('start 内与管理员同位豁免', src.indexOf('if (isAdminUser() || isRizhaoUser()) { stop(); return }') >= 0)
ok('isRizhaoUser 已导出', src.indexOf('isAdminUser, isRizhaoUser') >= 0)
ok('判据覆盖「日照」中文', src.indexOf("d.indexOf('日照')") >= 0)
ok('判据覆盖 rizhao slug', src.indexOf("d.toLowerCase().indexOf('rizhao')") >= 0)
ok('normDept 归一化兜底存在', src.indexOf("hit.majorKey === 'rizhao'") >= 0)
ok('异常时保持原行为（catch 返回 false）', src.split('function isRizhaoUser()')[1] && src.split('function isRizhaoUser()')[1].indexOf('return false') >= 0)

console.log('=== 组五 调用点不动（豁免收口在模块内） ===')
const capp = fs.readFileSync('app.js', 'utf8')
const cch = fs.readFileSync('challenge.js', 'utf8')
const cco = fs.readFileSync('course-app.js', 'utf8')
ok('app.js 考试调用点原样（无部门分支）', capp.indexOf("AntiCheat.start({ maxViolations: 3, onSubmit: function () { finishExam(false) } })") >= 0)
ok('challenge.js 测试调用点原样', cch.indexOf('AntiCheat.start({ maxViolations: 3, onSubmit: chCheatSubmit })') >= 0)
ok('course-app.js 调用点原样', cco.indexOf('AntiCheat.start({') >= 0)
ok('challenge 注释已同步', cch.indexOf('管理员/日照账号自动豁免，v200') >= 0)

console.log('')
console.log(pass + ' 通过, ' + fail + ' 失败' + (fail ? ' ❌' : ' ✅'))
if (fail) fails.forEach(f => console.log('  ✗ ' + f))
process.exit(fail ? 1 : 0)
