// 防作弊计数 + listen 判题/渲染 测试
const fs = require('fs')
const vm = require('vm')

// ---- 事件收发 mock ----
function makeEmitter() {
  const ls = {}
  return {
    listeners: ls,
    addEventListener(t, fn) { (ls[t] = ls[t] || []).push(fn) },
    removeEventListener(t, fn) { if (ls[t]) ls[t] = ls[t].filter(f => f !== fn) },
    emit(t, payload) { (this.listeners[t] || []).forEach(f => { try { f(payload) } catch (e) { console.error(e) } }) }
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
const sandbox = {
  console, Date, Math, JSON, Set, Map, Promise, Array, Object, String, Number, RegExp, Error,
  setTimeout, clearTimeout,
  window: Object.assign({}, winEmit, {
    focus() {}, speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function (t) { this.text = t }
  }),
  document: Object.assign({}, docEmit, {
    hidden: false,
    body: { appendChild() {}, removeChild() {} },
    createElement: () => fakeElem(),
    addEventListener: docEmit.addEventListener.bind(docEmit),
    removeEventListener: docEmit.removeEventListener.bind(docEmit)
  }),
  t: (k) => {
    const map = { listenPlay: 'Play', listenHint: 'Listen', anticheatWarn: 'Warn', anticheatWarnDesc: 'left {n}', anticheatFinal: 'Final', anticheatAck: 'OK', questionTextPh: 'q', listenQuestionPh: 'w' }
    return map[k] !== undefined ? map[k] : k
  },
  escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  escAttr: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
sandbox.window.t = sandbox.t
sandbox.document.t = sandbox.t
sandbox.globalThis = sandbox
sandbox.window.AntiCheat = undefined
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync('anti-cheat.js', 'utf8'), sandbox)

let pass = 0, fail = 0
function eq(name, a, b) { if (a === b) { pass++; console.log('  \u2713 ' + name) } else { fail++; console.log('  \u2717 ' + name + '\n    期望: ' + b + '\n    实际: ' + a) } }
function includes(name, html, sub) { if (String(html).includes(sub)) { pass++; console.log('  \u2713 ' + name) } else { fail++; console.log('  \u2717 ' + name + ' (缺: ' + sub + ')\n    实际: ' + html) } }

// ====== AntiCheat ======
console.log('== AntiCheat 计数与自动交卷 ==')
const AC = sandbox.window.AntiCheat
let submitted = null
AC.start({ maxViolations: 3, onSubmit: () => { submitted = 'cheat' } })
eq('启动后激活', AC.isActive(), true)
eq('初始违规 0', AC.getViolations(), 0)

// 第 1 次切屏（hidden=true + blur 同时触发，应去抖只计 1 次）
sandbox.document.hidden = true
docEmit.emit('visibilitychange')
winEmit.emit('blur')
eq('第1次切屏计 1', AC.getViolations(), 1)
eq('未达上限不交卷', submitted, null)

// 回到页面
sandbox.document.hidden = false
docEmit.emit('visibilitychange')

// 第 2 次（间隔 >1.5s）
setTimeout(() => {
  sandbox.document.hidden = true
  docEmit.emit('visibilitychange')
  eq('第2次切屏计 2', AC.getViolations(), 2)

  // 第 3 次 → 达上限 → stop + onSubmit
  setTimeout(() => {
    sandbox.document.hidden = true
    docEmit.emit('visibilitychange')
    eq('第3次计 3', AC.getViolations(), 3)
    eq('达上限后停止', AC.isActive(), false)
    setTimeout(() => {
      eq('触发自动交卷回调', submitted, 'cheat')

      // 去抖验证：1.5s 内连发不重复计数
      console.log('== 去抖验证 ==')
      submitted = null
      AC.start({ maxViolations: 5, onSubmit: () => { submitted = 'x' } })
      sandbox.document.hidden = true
      docEmit.emit('visibilitychange')
      winEmit.emit('blur')   // 同一动作，应被去抖
      docEmit.emit('visibilitychange') // 仍在窗口内
      eq('连发只计 1 次', AC.getViolations(), 1)
      AC.stop()
      eq('停止后失活', AC.isActive(), false)

      console.log('== 右键/复制被拦截 ==')
      AC.start({ maxViolations: 9 })
      let prevented = false
      const ctxEv = { preventDefault() { prevented = true } }
      docEmit.emit('contextmenu', ctxEv)
      eq('contextmenu 被阻止', prevented, true)
      let copyPrevented = false
      const cpEv = { preventDefault() { copyPrevented = true } }
      docEmit.emit('copy', cpEv)
      eq('copy 被阻止', copyPrevented, true)
      AC.stop()

      console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
      process.exit(fail ? 1 : 0)
    }, 800)
  }, 1700)
}, 1700)
