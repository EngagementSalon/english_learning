// ====== 测试：练习页部门切片（v92；v109 层级化更新）======
// 覆盖：
//   1. 一级行只放 全部部门/饮食部/房务部/通用 四个一级栏目（v109：分部门收进二级展开行）
//   2. 合法切片全集 PRACTICE_DEPT_SLUGS 含一级 + 全部分队（13 项）
//   3. 非管理员看不到切片
//   4. 切换切片后 startPractice 取题范围随之变化（全库 / 大部门 / 分队 / 通用）
//   5. 分队切片只拿到「本分队 + 大部门自身 + 通用」，不串其他分队
//   6. 非管理员受切片状态影响为零（practiceDept 被忽略）
//   7. 选中大部门时下方展开分部门二级行；点二级按钮不回落（v109）
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
// 本套整载 app.js + challenge.js：两者共同构成练习页（renderPractice 末尾含挑战入口卡片）
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

const run = code => vm.runInContext(code, sandbox)

;(async () => {
  console.log('\n🧪 练习页部门切片（v92）')

  const allQs = Store.getQuestions()
  const tabs = run('PRACTICE_DEPT_TABS')
  const slugs = run('PRACTICE_DEPT_SLUGS')

  console.log('\n1️⃣  切片项定义（v109 层级化）')
  assert('一级行共 4 项（全部/饮食部/房务部/通用）', tabs.length === 4, `got ${JSON.stringify(tabs)}`)
  assert('首项为「全部」(\'\')', tabs[0] === '')
  assert('一级行含饮食部大部门项', tabs.indexOf('dining') >= 0)
  assert('一级行含房务部大部门项', tabs.indexOf('rooms') >= 0)
  assert('一级行含通用项', tabs.indexOf('all') >= 0)
  assert('一级行不含任何分部门 slug（分部门收进二级行）',
    tabs.every(k => k.indexOf('/') < 0), JSON.stringify(tabs))
  assert('合法切片全集共 13 项', slugs.length === 13, `got ${slugs.length}`)
  ;['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird'].forEach(k => {
    assert(`全集含饮食部四分队 ${k}`, slugs.indexOf(k) >= 0)
  })
  ;['rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa'].forEach(k => {
    assert(`全集含房务部五分部门 ${k}`, slugs.indexOf(k) >= 0)
  })

  // ---------- 管理员视角 ----------
  Store.getSession = () => ({ role: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })
  run('practiceDept = ""')

  console.log('\n2️⃣  管理员：切片渲染在练习页（v109 层级化）')
  run('renderPractice()')
  const html = getEl('page-practice').innerHTML
  assert('练习页含切片容器', html.includes('setPracticeDept('), '未找到 setPracticeDept 调用')
  tabs.forEach(k => {
    assert(`一级行渲染出按钮 setPracticeDept('${k}')`, html.includes(`setPracticeDept('${k}')`))
  })
  assert('默认视角（全部）不展开二级行', !html.includes("setPracticeDept('dining/sig')")
    && !html.includes("setPracticeDept('rooms/fo')"), '默认态渲染了分部门按钮')
  assert('含管理员提示文案', html.includes(run('t("practiceDeptAdminHint")')))
  assert('含部门标签', html.includes(run('t("practiceDeptLabel")')))
  // 一级按钮显示可练习题数（全部视角）
  const allN = allQs.length
  assert('全部视角显示题数', html.includes(`${allN}</span>`) || html.includes(`>${allN}</span>`), `期望含 ${allN}`)

  console.log('\n2️⃣b 管理员：选中大部门 → 下方展开分部门二级行（v109）')
  run(`setPracticeDept('dining')`)
  run('renderPractice()')
  const htmlDining = getEl('page-practice').innerHTML
  ;['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird'].forEach(k => {
    assert(`饮食部二级行渲染出 ${k}`, htmlDining.includes(`setPracticeDept('${k}')`))
  })
  assert('饮食部视角不展开房务部分部门', !htmlDining.includes("setPracticeDept('rooms/fo')"))
  assert('二级行选中分部门后题数可见', htmlDining.includes(run('t("practiceDeptLabel")')))
  run(`setPracticeDept('rooms')`)
  run('renderPractice()')
  const htmlRooms = getEl('page-practice').innerHTML
  ;['rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa'].forEach(k => {
    assert(`房务部二级行渲染出 ${k}`, htmlRooms.includes(`setPracticeDept('${k}')`))
  })
  assert('房务部视角不展开饮食部分部门', !htmlRooms.includes("setPracticeDept('dining/sig')"))
  run(`setPracticeDept('all')`)
  run('renderPractice()')
  const htmlAll = getEl('page-practice').innerHTML
  assert('通用视角不展开二级行', !htmlAll.includes("setPracticeDept('dining/sig')")
    && !htmlAll.includes("setPracticeDept('rooms/fo')"))
  run('practiceDept = ""')

  console.log('\n3️⃣  管理员：切片切换 → 取题范围变化')
  const scopes = {}
  ;['', 'dining', 'dining/sig', 'dining/yan', 'dining/bar', 'dining/ird', 'rooms', 'all'].forEach(k => {
    scopes[k] = k ? Store.getQuestionsByDept(k).length : allQs.length
  })
  console.log('  各切片题数:', JSON.stringify(scopes))
  // 注意：题库 100% 属于饮食部（1156 题）+ 通用（44 题），无房务部专属题，
  // 故「全部」与「饮食部」题数必然相同（均为 1200）。这是数据现状，非缺陷。
  const diningOnly = allQs.filter(q => {
    const d = q.dept || ''
    return d === 'rooms' || d.indexOf('rooms/') === 0
  }).length
  assert('房务部专属题数为 0（数据现状，故「全部」=「饮食部」）', diningOnly === 0, `got ${diningOnly}`)
  assert('「全部」= 全库', scopes[''] === allQs.length)
  assert('「饮食部」= 全库（因无房务部专属题）', scopes['dining'] === allQs.length,
    `${scopes['dining']} vs ${allQs.length}`)
  assert('标帜餐厅 > 0', scopes['dining/sig'] > 0)
  assert('通用 > 0', scopes['all'] > 0)

  // 切片 → startPractice 真实取题（DOM value 需先给定）
  const practiceListFor = k => {
    run(`practiceDept = ${JSON.stringify(k)}`)
    getEl('pCategory').value = '0'
    getEl('pDifficulty').value = '0'
    getEl('pLevel').value = '0'
    getEl('pCount').value = '0'
    run('startPractice()')
    return run('practiceState.questions')
  }

  console.log('\n4️⃣  管理员：切到分队 → 题目只含「本分队 + 大部门自身 + 通用」')
  const barList = practiceListFor('dining/bar')
  const badBar = barList.filter(q => {
    const d = q.dept || 'all'
    return !(d === 'all' || d === '' || d === 'dining/bar' || d === 'dining')
  })
  assert('酒吧切片无越界题', badBar.length === 0,
    `越界 ${badBar.length} 题，例: ${badBar.slice(0, 3).map(q => q.dept + ':' + q.id).join(', ')}`)
  assert('酒吧切片题数 > 0', barList.length > 0, `got ${barList.length}`)

  const sigList = practiceListFor('dining/sig')
  const badSig = sigList.filter(q => {
    const d = q.dept || 'all'
    return !(d === 'all' || d === '' || d === 'dining/sig' || d === 'dining')
  })
  assert('标帜餐厅切片无越界题', badSig.length === 0, `越界 ${badSig.length} 题`)
  assert('标帜餐厅切片 ≠ 酒吧切片', sigList.length !== barList.length,
    `both ${sigList.length}`)

  console.log('\n5️⃣  管理员：切到「全部」拿到全库')
  const allList = practiceListFor('')
  assert('全部切片 = 全库题数', allList.length === allQs.length, `${allList.length} vs ${allQs.length}`)

  console.log('\n6️⃣  管理员：切到「通用」只拿通用题')
  const genList = practiceListFor('all')
  const genBad = genList.filter(q => q.dept && q.dept !== 'all')
  assert('通用切片只含通用题', genBad.length === 0, `越界 ${genBad.length} 题`)
  assert('通用切片题数 = 通用池', genList.length === Store.getQuestionsByDept('all').length)

  console.log('\n7️⃣  setPracticeDept 非法值回落到「全部」')
  run('setPracticeDept("bogus/xx")')
  assert('非法值 → ""', run('practiceDept') === '', run('practiceDept'))
  run('setPracticeDept("dining/yan")')
  assert('合法值生效', run('practiceDept') === 'dining/yan')
  run('practiceDept = ""')

  // ---------- 学员视角 ----------
  console.log('\n8️⃣  非管理员：看不到切片，且不受 practiceDept 影响')
  Store.getSession = () => ({ role: 'student', name: 's1', dept: '饮食部·标帜餐厅' })
  Store.getUser = () => ({ name: 's1', dept: '饮食部·标帜餐厅' })
  run('practiceDept = ""')
  run('renderPractice()')
  const stuHtml = getEl('page-practice').innerHTML
  assert('学员页无切片按钮', !stuHtml.includes('setPracticeDept('), '仍渲染了切片')
  assert('学员页无管理员提示', !stuHtml.includes(run('t("practiceDeptAdminHint")')))

  const stuKey = Store.getSessionDeptKey()
  assert('学员大部门 key = dining', stuKey === 'dining', stuKey)
  // 即便强行设置 practiceDept，学员取题也只看本人部门
  run('practiceDept = "dining/bar"')
  getEl('pCategory').value = '0'; getEl('pDifficulty').value = '0'
  getEl('pLevel').value = '0'; getEl('pCount').value = '0'
  run('startPractice()')
  const stuList = run('practiceState.questions')
  const expN = Store.getQuestionsByDept('dining').length
  assert('学员取题按本人部门（忽略 practiceDept）', stuList.length === expN, `${stuList.length} vs ${expN}`)
  const stuBad = stuList.filter(q => q.dept && q.dept !== 'all' && q.dept !== 'dining' && q.dept.indexOf('dining/') !== 0)
  assert('学员取题不出饮食部范围', stuBad.length === 0, `越界 ${stuBad.length} 题`)
  // 学员拿到的是整个饮食部池，含各分队题（这是 v89 既有语义：大部门 = 全部子分队）
  const stuBar = stuList.filter(q => q.dept === 'dining/bar').length
  const expBar = Store.getQuestionsByDept('dining').filter(q => q.dept === 'dining/bar').length
  assert('学员见到的酒吧题数 = 饮食部池内酒吧题数', stuBar === expBar, `${stuBar} vs ${expBar}`)

  console.log('\n9️⃣  其他部门学员：切片与题库均不受影响')
  Store.getSession = () => ({ role: 'student', name: 's2', dept: '其他部门·行政' })
  Store.getUser = () => ({ name: 's2', dept: '其他部门·行政' })
  run('practiceDept = ""')
  run('renderPractice()')
  assert('其他部门学员无切片', !getEl('page-practice').innerHTML.includes('setPracticeDept('))
  getEl('pCategory').value = '0'; getEl('pDifficulty').value = '0'
  getEl('pLevel').value = '0'; getEl('pCount').value = '0'
  run('startPractice()')
  assert('其他部门学员拿到全库（v89 既有行为）',
    run('practiceState.questions').length === allQs.length)

  console.log('\n🔟 i18n 中英成对')
  const zhVals = run(`JSON.stringify([t('practiceDeptLabel'), t('practiceDeptAdminHint')])`)
  const enVals = run(`(function(){ setLang('en');` +
    ` var r = [t('practiceDeptLabel'), t('practiceDeptAdminHint'), t('practiceDeptCount', 7)];` +
    ` setLang('zh'); return JSON.stringify(r) })()`)
  const zh = JSON.parse(zhVals), en = JSON.parse(enVals)
  assert('zh 键非空', zh[0] && zh[1], zhVals)
  assert('en 键与 zh 不同', en[0] && en[0] !== zh[0], enVals)
  assert('en 键 2 与 zh 不同', en[1] && en[1] !== zh[1], enVals)
  assert('practiceDeptCount 形参函数可用', typeof en[2] === 'string' && en[2].length > 0, en[2])

  console.log(testFailed ? '\n❌ 练习页部门切片测试失败\n' : '\n✅ 练习页部门切片测试全部通过\n')
  process.exit(testFailed ? 1 : 0)
})()
