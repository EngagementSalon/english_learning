// ====== 测试 v97：练习部门切片 ⇄ 七天挑战视角联动 ======
// 用户原话：「我的理解是 我在标帜餐厅页面下面看到标志餐厅七天挑战 在艳下面看到艳中餐厅七天挑战啊」
// 改造前：练习页部门切片（practiceDept）只影响练习抽题；挑战卡的标题/营次/门禁走云端侧信道
//         （按登录部门 CloudSync._deptSlug 解析；管理员无部门 → 全局指针 + 写死通用标题
//         「标帜餐厅七天英文挑战」），于是出现「标题标帜、营次艳中」的混搭。
// v97：管理员 chDeptKey() 跟随练习切片；营次在本地按视角部门实时重算（chRoundRecForDept，
//      四级口径与云端 _roundCurrentForDept 一致）；通用标题改为中性「七天英文挑战」。
//
// 覆盖点：
// ① 管理员 chDeptKey 跟随切片（sig/yan/all/''/rooms），非管理员忽略切片走本人 session 部门
// ② chRoundRecForDept 四级解析：① 指针适用 ② 本部门已开放 ③ 本部门最新 ④ 无适用 → null
// ③ chRoundName / chCurrentRound（进度存档键）/ chRoundOpenState / chOpenLocked / chNoRoundForDept 按视角切换
// ④ chRoundMetaText 按视角显示排期
// ⑤ chBankQuestions 视角口径：yan=本队+通用；sig=本队+通用；all=仅通用；''=全库；rooms=仅通用
// ⑥ chTitleText：分部门视角带部门名；全库/通用视角回落中性通用标题
// ⑦ i18n：chTitle 中性化、practiceDeptAdminHint 联动说明，中英成对
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg == null ? '' : msg); testFailed = true }
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
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
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

run(`localStorage.setItem('eq_categories', JSON.stringify(BANK.categories))`)

// 云端营次布局（对齐线上真实数据 2026-09-21）：
//   r1 = 标帜餐厅七天挑战第一期，depts=['dining/sig']，open=true，无排期
//   r2 = 艳中餐厅七天挑战第一期，depts=['dining/yan']，open=false，startAt 未来 / endAt 更远（upcoming）
//   全局指针 chRoundCur = r2（管理员最近切到艳中建的期）
const NOW = Date.now()
const R1 = { id: 'r1', name: '标帜餐厅七天挑战第一期', depts: ['dining/sig'], open: true, startAt: 0, endAt: 0, examOpen: false }
const R2 = { id: 'r2', name: '艳中餐厅七天挑战第一期', depts: ['dining/yan'], open: false, startAt: NOW + 3600e3, endAt: NOW + 8 * 86400e3, examOpen: false }
function feedCloud() {
  run(`CloudSync._chRounds = ${JSON.stringify([R1, R2])}`)
  run(`CloudSync._chRoundCurId = 'r2'`)
  run(`CloudSync._chRoundCurName = '艳中餐厅七天挑战第一期'`)
  run(`CloudSync._chOpen = true; CloudSync._chOpenAt = 0; CloudSync._chExamOpen = false; CloudSync._chNoRound = false`)
  run(`CloudSync._chOpenLocked = undefined`)
}
function setAdminSlice(v) {
  Store.getSession = () => ({ role: 'admin', name: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })
  run(`practiceDept = ${JSON.stringify(v)}`)
}
function setStudent(dept) {
  Store.getSession = () => ({ role: 'student', name: 's1', dept })
  Store.getUser = () => ({ name: 's1', dept })
  run(`practiceDept = 'dining/yan'`)   // 即使切片残留，非管理员也必须忽略
}

;(async () => {
  console.log('\n🧪 v97 练习部门切片 ⇄ 挑战视角联动')

  feedCloud()

  console.log('\n1️⃣  管理员 chDeptKey() 跟随练习切片')
  for (const [slice, want] of [['dining/yan', 'dining/yan'], ['dining/sig', 'dining/sig'], ['all', 'all'], ['', ''], ['rooms', 'rooms']]) {
    setAdminSlice(slice)
    const got = run('chDeptKey()')
    assert(`切片 ${JSON.stringify(slice)} → chDeptKey=${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`)
  }

  console.log('\n2️⃣  非管理员忽略切片，始终走本人 session 部门')
  setStudent('饮食部·标帜餐厅')
  assert('标帜学员 + 切片残留 yan → chDeptKey 仍是 dining/sig', run('chDeptKey()') === 'dining/sig', run('chDeptKey()'))
  setStudent('饮食部·艳中餐厅')
  assert('艳中学员 → dining/yan', run('chDeptKey()') === 'dining/yan', run('chDeptKey()'))

  console.log('\n3️⃣  chRoundRecForDept 四级解析（r1=标帜 open / r2=艳中 upcoming / 指针=r2）')
  setAdminSlice('dining/yan')
  assert('艳中视角：① 指针 r2 适用 → r2', run('chRoundRecForDept() && chRoundRecForDept().id') === 'r2', JSON.stringify(run('chRoundRecForDept()')))
  setAdminSlice('dining/sig')
  assert('标帜视角：① r2 不适用 → ② r1 已开放 → r1', run('chRoundRecForDept() && chRoundRecForDept().id') === 'r1', JSON.stringify(run('chRoundRecForDept()')))
  setAdminSlice('rooms')
  assert('房务部视角：无适用营次 → null', run('chRoundRecForDept()') === null, JSON.stringify(run('chRoundRecForDept()')))
  setAdminSlice('')
  assert('全库视角：指针必命中 → r2', run('chRoundRecForDept() && chRoundRecForDept().id') === 'r2', JSON.stringify(run('chRoundRecForDept()')))

  console.log('\n4️⃣  chRoundName / 存档键 / 排期态按视角切换')
  setAdminSlice('dining/yan')
  assert('艳中视角营次名 = 艳中…第一期', run('chRoundName()') === '艳中餐厅七天挑战第一期', run('chRoundName()'))
  assert('艳中视角存档键营次 = r2', run('chCurrentRound()') === 'r2', run('chCurrentRound()'))
  assert('艳中视角排期态 = upcoming（未到 startAt）', run('chRoundOpenState().state') === 'upcoming', run('JSON.stringify(chRoundOpenState())'))
  assert('艳中视角 chOpenLocked = true', run('chOpenLocked()') === true)
  assert('艳中视角有排期提示', run('chRoundHasSchedule()') === true)
  setAdminSlice('dining/sig')
  assert('标帜视角营次名 = 标帜…第一期', run('chRoundName()') === '标帜餐厅七天挑战第一期', run('chRoundName()'))
  assert('标帜视角存档键营次 = r1', run('chCurrentRound()') === 'r1', run('chCurrentRound()'))
  assert('标帜视角排期态 = open（r1 手动开放无排期）', run('chRoundOpenState().state') === 'open', run('JSON.stringify(chRoundOpenState())'))
  assert('标帜视角 chOpenLocked = false', run('chOpenLocked()') === false)
  assert('标帜视角无排期提示', run('chRoundHasSchedule()') === false)
  assert('标帜视角排期 meta 为空', run('chRoundMetaText()') === '', run('chRoundMetaText()'))
  setAdminSlice('rooms')
  assert('房务部视角：chNoRoundForDept = true（暂无开营）', run('chNoRoundForDept()') === true)
  assert('房务部视角排期态 = closed/locked', run('chRoundOpenState().state') === 'closed' && run('chRoundOpenState().locked') === true, run('JSON.stringify(chRoundOpenState())'))
  setAdminSlice('dining/sig')
  assert('房务部之外：chNoRoundForDept = false', run('chNoRoundForDept()') === false)
  setAdminSlice('')
  assert('全库视角：chNoRoundForDept = false', run('chNoRoundForDept()') === false)

  console.log('\n5️⃣  chBankQuestions 视角口径（cat12：yan×2 / sig×1 / 通用×1）')
  run(`Store._setUploaded((Store._getUploaded() || []).concat([
    { id: 't97y1', category_id: 12, dept: 'dining/yan', type: 'single', difficulty: 1, question: 'V97 Yan A', options: ['a','b'], answer: [0], explanation: '' },
    { id: 't97y2', category_id: 12, dept: 'dining/yan', type: 'single', difficulty: 1, question: 'V97 Yan B', options: ['a','b'], answer: [0], explanation: '' },
    { id: 't97s1', category_id: 12, dept: 'dining/sig', type: 'single', difficulty: 1, question: 'V97 Sig A', options: ['a','b'], answer: [0], explanation: '' },
    { id: 't97g1', category_id: 12, dept: 'all',      type: 'single', difficulty: 1, question: 'V97 Gen A', options: ['a','b'], answer: [0], explanation: '' },
  ]))`)
  const poolIds = () => run(`chBankQuestions().map(q => q.id).filter(id => String(id).indexOf('t97') === 0)`)
  setAdminSlice('dining/yan')
  assert('艳中视角池 = 本队 2 + 通用 1', JSON.stringify(poolIds()) === JSON.stringify(['t97y1', 't97y2', 't97g1']), JSON.stringify(poolIds()))
  setAdminSlice('dining/sig')
  assert('标帜视角池 = 本队 1 + 通用 1', JSON.stringify(poolIds()) === JSON.stringify(['t97s1', 't97g1']), JSON.stringify(poolIds()))
  setAdminSlice('all')
  assert('通用视角池 = 仅通用 1', JSON.stringify(poolIds()) === JSON.stringify(['t97g1']), JSON.stringify(poolIds()))
  setAdminSlice('rooms')
  assert('房务部视角池 = 仅通用 1', JSON.stringify(poolIds()) === JSON.stringify(['t97g1']), JSON.stringify(poolIds()))
  setAdminSlice('')
  assert('全库视角池 = 全部 4', poolIds().length === 4, JSON.stringify(poolIds()))

  console.log('\n6️⃣  chTitleText 视角与中性通用标题')
  setAdminSlice('dining/yan')
  assert('艳中视角标题含「艳中餐厅」', run('chTitleText()').indexOf('艳中餐厅') >= 0, run('chTitleText()'))
  setAdminSlice('dining/sig')
  assert('标帜视角标题含「标帜餐厅」', run('chTitleText()').indexOf('标帜餐厅') >= 0, run('chTitleText()'))
  setAdminSlice('')
  assert('全库视角回落中性通用标题', run('chTitleText()') === run(`t('chTitle')`), run('chTitleText()'))
  assert('通用标题不再写死「标帜餐厅」', run(`t('chTitle')`).indexOf('标帜') < 0, run(`t('chTitle')`))
  setAdminSlice('all')
  assert('通用视角同样回落中性标题（不出现「all」字样）', run('chTitleText()') === run(`t('chTitle')`) && run('chTitleText()').indexOf('all') < 0, run('chTitleText()'))

  console.log('\n7️⃣  i18n：切片提示说明联动，中英成对')
  const hintZh = run(`t('practiceDeptAdminHint')`)
  assert('中文提示提到挑战联动', hintZh.indexOf('挑战') >= 0, hintZh)
  run(`setLang('en')`)
  const hintEn = run(`t('practiceDeptAdminHint')`)
  assert('英文提示提到 challenge', hintEn.toLowerCase().indexOf('challenge') >= 0, hintEn)
  assert('英文 chTitle 已中性化', run(`t('chTitle')`).toLowerCase().indexOf('signature') < 0, run(`t('chTitle')`))
  run(`setLang('zh')`)

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ v97 全部断言通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
