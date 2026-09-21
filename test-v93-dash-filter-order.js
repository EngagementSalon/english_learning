// ====== 测试：看板挑战区块筛选条顺序（v93）======
// 断言「部门筛选」渲染在「营次筛选」之前（上方）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}

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

const sandbox = {
  localStorage: {
    store: { 'eq_course_only_v43': '1' },
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
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const run = code => vm.runInContext(code, sandbox)
const Store = run('Store')

;(async () => {
  console.log('\n🧪 看板挑战区块：部门筛选应在营次筛选之上（v93）')

  // 管理员身份
  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })

  const deptLabel = run(`t('dashChDeptFilterLabel')`)
  const roundLabel = run(`t('dashRoundFilterLabel')`)
  console.log('  部门标签:', JSON.stringify(deptLabel), '| 营次标签:', JSON.stringify(roundLabel))

  // ---- 场景 A：多营次（两个筛选条都出现）----
  console.log('\n1️⃣  多营次场景（两条筛选都在）')
  run(`
    dashRoundList = function () { return [
      { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], startAt: 0, endAt: 0 },
      { id: 'r2', name: '酒吧团队七天挑战第一期', depts: ['dining/bar'], startAt: 0, endAt: 0 },
    ] }
    dashRoundCurId = function () { return 'r1' }
    dashRoundView = ''
    dashChDept = 'all'
  `)
  // 无参与学员 → 走空态分支
  run('renderDashChallengeBlock([])')
  let html = getEl('dashChallengeBlock').innerHTML
  assert('空态含部门标签', html.includes(deptLabel + '：'), html.slice(0, 200))
  assert('空态含营次标签', html.includes(roundLabel + '：'))
  let iDept = html.indexOf(deptLabel + '：')
  let iRound = html.indexOf(roundLabel + '：')
  assert('空态：部门在营次之前', iDept >= 0 && iRound >= 0 && iDept < iRound,
    `dept@${iDept} round@${iRound}`)

  // ---- 场景 B：有参与学员（走正常渲染分支）----
  console.log('\n2️⃣  有参与学员场景（正常分支）')
  run(`
    dashChDept = 'all'
    renderDashChallengeBlock([
      { username: 's1', name: '张三', dept: '饮食部·标帜餐厅',
        chy: [{ day: 1, si: 0, kind: 'practice', correct: 8, total: 10, usedSec: 60, rd: 'r1' }] },
      { username: 's2', name: '李四', dept: '饮食部·标帜餐厅',
        chy: [{ day: 1, si: 0, kind: 'practice', correct: 9, total: 10, usedSec: 50, rd: 'r1' }] },
    ])
  `)
  html = getEl('dashChallengeBlock').innerHTML
  iDept = html.indexOf(deptLabel + '：')
  iRound = html.indexOf(roundLabel + '：')
  assert('正常态含部门标签', iDept >= 0, '未找到')
  assert('正常态含营次标签', iRound >= 0, '未找到')
  assert('正常态：部门在营次之前', iDept >= 0 && iRound >= 0 && iDept < iRound,
    `dept@${iDept} round@${iRound}`)
  assert('正常态渲染了学员行', html.includes('张三') && html.includes('李四'))

  // ---- 场景 C：单营次（营次条隐藏，部门条仍在）----
  console.log('\n3️⃣  单营次场景（营次条隐藏）')
  run(`
    dashRoundList = function () { return [
      { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], startAt: 0, endAt: 0 },
    ] }
    renderDashChallengeBlock([
      { username: 's1', name: '张三', dept: '饮食部·标帜餐厅',
        chy: [{ day: 1, si: 0, kind: 'practice', correct: 8, total: 10, usedSec: 60, rd: 'r1' }] },
    ])
  `)
  html = getEl('dashChallengeBlock').innerHTML
  assert('单营次仍有部门条', html.includes(deptLabel + '：'))
  assert('单营次无营次条', !html.includes(roundLabel + '：'), '营次条不该出现')

  // ---- 场景 D：部门筛选按钮组仍在（功能未丢）----
  console.log('\n4️⃣  部门筛选按钮组完整（功能未丢失）')
  run(`
    dashRoundList = function () { return [
      { id: 'r1', name: '第一期', depts: [], startAt: 0, endAt: 0 },
      { id: 'r2', name: '第二期', depts: [], startAt: 0, endAt: 0 },
    ] }
    dashRoundCurId = function () { return 'r1' }
    renderDashChallengeBlock([
      { username: 's1', name: '张三', dept: '饮食部·标帜餐厅',
        chy: [{ day: 1, si: 0, kind: 'practice', correct: 8, total: 10, usedSec: 60, rd: 'r1' }] },
    ])
  `)
  html = getEl('dashChallengeBlock').innerHTML
  ;['all', 'dining/sig', 'dining/yan', 'dining/bar', 'dining/ird', 'rooms'].forEach(k => {
    assert(`部门按钮 dashChSetDept('${k}') 存在`, html.includes(`dashChSetDept('${k}')`))
  })
  assert('营次按钮 dashViewRound 存在', html.includes('dashViewRound('))

  console.log(testFailed ? '\n❌ 筛选条顺序测试失败\n' : '\n✅ 筛选条顺序测试全部通过\n')
  process.exit(testFailed ? 1 : 0)
})()
