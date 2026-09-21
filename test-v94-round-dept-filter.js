// ====== 测试：看板营次筛选必须按所选部门过滤（v94）======
// 用户报的问题：「我选标帜餐厅 不是应该下面只有标帜餐厅第一期嘛 怎么还会有艳中餐厅第一期」
// 根因：renderDashChallengeBlock 里 rdList = dashRoundList() 取的是**全部**营次，
//       未按 dashChDept 过滤 → 选某分队仍列出其它部门的营次。
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
vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const run = code => vm.runInContext(code, sandbox)
const Store = run('Store')

// 两个不同部门的营次 + 一个全部门营次
const ROUNDS = [
  { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, examOpen: false, startAt: 0, endAt: 0 },
  { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: true, examOpen: false, startAt: 0, endAt: 0 },
  { id: 'r3', name: '全员七天挑战', depts: [], open: true, examOpen: false, startAt: 0, endAt: 0 },
]

// 学员行：两个部门各一人，都在各自营次里有记录
const ROWS = [
  { username: 'sig1', name: '标帜甲', dept: '饮食部·标帜餐厅',
    chy: [{ day: 1, si: 0, kind: 'practice', correct: 8, total: 10, usedSec: 60, rd: 'r1' }] },
  { username: 'yan1', name: '艳中乙', dept: '饮食部·艳中餐厅',
    chy: [{ day: 1, si: 0, kind: 'practice', correct: 7, total: 10, usedSec: 70, rd: 'r2' }] },
]

const ROUND_LABEL = run(`t('dashRoundFilterLabel')`)
const deptBtnNames = run(`(function(){
  var m = t('chDeptNames') || {}
  return JSON.stringify({ sig: m['标帜餐厅'], yan: m['艳中餐厅'] })
})()`)
const NAMES = JSON.parse(deptBtnNames)

function render(dept, view) {
  run(`
    CloudSync._chRounds = ${JSON.stringify(ROUNDS)}
    CloudSync._chRoundCurId = 'r1'
    dashChDept = ${JSON.stringify(dept)}
    dashRoundView = ${JSON.stringify(view || '')}
  `)
  run(`renderDashChallengeBlock(${JSON.stringify(ROWS)})`)
  return getEl('dashChallengeBlock').innerHTML
}

;(async () => {
  console.log('\n🧪 看板营次筛选按部门过滤（v94）')
  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })
  assert('dashRoundUnderDept 已定义（筛选方向，非学员方向）', typeof run('dashRoundUnderDept') === 'function')
  // 反向验证：学员方向的 roundDeptMatch 语义相反，不能拿来当筛选器
  assert('roundDeptMatch 对 (r1,sig) 为 true', run(`roundDeptMatch({id:'r1',depts:['dining/sig']}, 'dining/sig')`) === true)
  assert('roundDeptMatch 对 (r1,dining) 为 false —— 故不能复用它做部门筛选',
    run(`roundDeptMatch({id:'r1',depts:['dining/sig']}, 'dining')`) === false)
  assert('dashRoundUnderDept 对 (r1,dining) 为 true —— 大部门应涵盖子部门营次',
    run(`dashRoundUnderDept({id:'r1',depts:['dining/sig']}, 'dining')`) === true)
  assert('dashRoundUnderDept 对 (yan期,sig) 为 false —— 不分串同门兄弟',
    run(`dashRoundUnderDept({id:'r2',depts:['dining/yan']}, 'dining/sig')`) === false)

  // ---- 1. 选「标帜餐厅」：营次条里只能有标帜餐厅期 + 全部门期 ----
  console.log('\n1️⃣  选标帜餐厅 → 只列本部门营次')
  let html = render('dining/sig')
  assert('含「标帜餐厅七天挑战第一期」', html.includes('标帜餐厅七天挑战第一期'))
  assert('不含「艳中餐厅七天挑战第一期」', !html.includes('艳中餐厅七天挑战第一期'),
    '仍渲染了艳中营次按钮')
  assert('含全部门营次（depts 空 = 全部适用）', html.includes('全员七天挑战'))
  // 营次按钮数量 = 2（标帜 + 全员）
  const sigRoundBtns = (html.match(/dashViewRound\(/g) || []).length
  assert('营次按钮数为 2', sigRoundBtns === 2, '实为 ' + sigRoundBtns)

  // ---- 2. 选「艳中餐厅」：反向验证 ----
  console.log('\n2️⃣  选艳中餐厅 → 只列本部门营次')
  html = render('dining/yan')
  assert('不含「标帜餐厅七天挑战第一期」', !html.includes('标帜餐厅七天挑战第一期'))
  assert('含「艳中餐厅七天挑战第一期」', html.includes('艳中餐厅七天挑战第一期'))
  const yanRoundBtns = (html.match(/dashViewRound\(/g) || []).length
  assert('营次按钮数为 2（艳中 + 全员）', yanRoundBtns === 2, '实为 ' + yanRoundBtns)

  // ---- 3. 选「全部」：所有营次都出现 ----
  console.log('\n3️⃣  选全部 → 所有营次都列出')
  html = render('all')
  assert('含标帜营次', html.includes('标帜餐厅七天挑战第一期'))
  assert('含艳中营次', html.includes('艳中餐厅七天挑战第一期'))
  assert('含全员营次', html.includes('全员七天挑战'))
  const allRoundBtns = (html.match(/dashViewRound\(/g) || []).length
  assert('营次按钮数为 3', allRoundBtns === 3, '实为 ' + allRoundBtns)

  // ---- 4. 选大部门「饮食部」：两个分队营次都适用 ----
  console.log('\n4️⃣  选饮食部（大部门）→ 各分队营次都适用')
  html = render('dining')
  assert('含标帜营次', html.includes('标帜餐厅七天挑战第一期'))
  assert('含艳中营次', html.includes('艳中餐厅七天挑战第一期'))
  const diningRoundBtns = (html.match(/dashViewRound\(/g) || []).length
  assert('营次按钮数为 3', diningRoundBtns === 3, '实为 ' + diningRoundBtns)

  // ---- 5. 跨部门 fallback：停在艳中期却切到标帜 → 不停留在不适用营次 ----
  console.log('\n5️⃣  切换部门后不残留其它部门的营次视图')
  html = render('dining/sig', 'r2')   // dashRoundView 指向艳中期
  assert('选中态未落在艳中营次', !/dashViewRound[\s\S]{0,200}btn-primary[\s\S]{0,80}艳中餐厅/.test(html) ||
    !html.includes('艳中餐厅七天挑战第一期'), '仍高亮艳中营次')
  // 统计口径应回到标帜餐厅期（rdName 文案）
  assert('统计标题用标帜期名', html.includes('标帜餐厅七天挑战第一期'))

  // ---- 6. 房务部：无专属营次 → 只剩全部门营次 ----
  console.log('\n6️⃣  选房务部（无专属营次）→ 只剩全部门营次')
  html = render('rooms')
  assert('不含标帜营次', !html.includes('标帜餐厅七天挑战第一期'))
  assert('不含艳中营次', !html.includes('艳中餐厅七天挑战第一期'))
  assert('含全员营次', html.includes('全员七天挑战'))

  // ---- 7. 部门筛选条本身不受影响（仍列出所有部门按钮）----
  console.log('\n7️⃣  部门筛选条完整（功能未受本次改动影响）')
  html = render('dining/sig')
  ;['all', 'dining/sig', 'dining/yan', 'dining/bar', 'dining/ird', 'rooms'].forEach(k => {
    assert(`部门按钮 dashChSetDept('${k}') 存在`, html.includes(`dashChSetDept('${k}')`))
  })
  assert('部门条在营次条之上（v93）', (() => {
    const i = html.indexOf(run(`t('dashChDeptFilterLabel')`) + '：')
    const j = html.indexOf(ROUND_LABEL + '：')
    return i >= 0 && j >= 0 && i < j
  })())

  console.log(testFailed ? '\n❌ 营次按部门过滤测试失败\n' : '\n✅ 营次按部门过滤测试全部通过\n')
  process.exit(testFailed ? 1 : 0)
})()
