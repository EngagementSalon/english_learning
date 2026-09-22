// ====== 测试：v109 部门标签层级化 + 挑战入口动态营次门禁 ======
// 背景（用户重申）：
//   ① 练习设置部门行只应有一级栏目（全部部门/饮食部/房务部/通用），点饮食部/房务部展开分部门二级行；
//   ② 目前只有标帜餐厅和艳中餐厅开了七天挑战 —— 酒吧团队/客房送餐（及其余部门）不得出现
//      「本部门标题 + 别队营次名」的错位卡（v107 病根：客房送餐七天英文挑战 · 标帜餐厅七天挑战第一期）。
// 覆盖：
//   1. PRACTICE_DEPT_TABS 收缩为一级 4 项；PRACTICE_DEPT_SLUGS 全集 13 项（含二级分部门）
//   2. 层级渲染：默认/通用不展开二级行；选饮食部→4 分队、选房务部→5 分部门
//   3. setPracticeDept 用 PRACTICE_DEPT_SLUGS 校验（二级值不回落、非法值回落）
//   4. chDeptKey 切片联动不断（v97）：管理员切二级仍生效；学员按本人部门
//   5. challengeEntryHtml 三态：正常卡 / noRound 卡（v109）/ blocked 卡（v107）
//   6. renderChallenge 深链接：noRound 部门 → 说明页，不渲染别队营次内容
//   7. i18n zh/en 成对 + 源码护栏
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

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }
const run = code => vm.runInContext(code, sandbox)

// ---- cloud-store.js 提取 roundDeptMatch / roundOpenState（chRoundRecForDept 的 typeof 依赖）----
const csSrc = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const grabFn = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (!m) return null
  let i = m.index + m[0].length, depth = 1
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(m.index, i)
}
;['roundDeptMatch', 'roundOpenState'].forEach(n => {
  const fn = grabFn(csSrc, n)
  assert(`cloud-store 提取 ${n}`, !!fn)
  if (fn) vm.runInContext(fn, sandbox)
})

// ---- 云端营次现状：只有 标帜(r1) / 艳中(r2) 两期（bar/ird 无专属营次）----
const R1_NAME = '标帜餐厅七天挑战第一期'
const R2_NAME = '艳中餐厅七天挑战第二期'
sandbox.CloudSync = {
  _chRounds: [
    { id: 'r1', name: R1_NAME, depts: ['dining/sig'] },
    { id: 'r2', name: R2_NAME, depts: ['dining/yan'] },
  ],
  _chRoundCurId: 'r1',
  _chRoundCurName: R1_NAME,
}
const vmCloud = () => vm.runInContext('CloudSync', sandbox)

const setStudent = dept => {
  Store.getSession = () => ({ role: 'student', name: 's1', username: 's1', dept })
  Store.getUser = () => ({ name: 's1', dept })
}
const setAdmin = () => {
  Store.getSession = () => ({ role: 'admin', username: 'admin', dept: '' })
  Store.getUser = () => ({ name: 'admin', dept: '' })
}

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

;(async () => {
  console.log('\n🧪 v109 部门标签层级化 + 挑战入口动态营次门禁')

  // ============ 一、定义 ============
  console.log('\n=== 一、切片定义（一级 4 项 + 全集 13 项）===')
  const tabs = run('PRACTICE_DEPT_TABS')
  const slugs = run('PRACTICE_DEPT_SLUGS')
  assert('一级行 = [\'\', \'dining\', \'rooms\', \'all\']',
    JSON.stringify(tabs) === JSON.stringify(['', 'dining', 'rooms', 'all']), JSON.stringify(tabs))
  assert('一级行不含分部门 slug', tabs.every(k => String(k).indexOf('/') < 0))
  assert('全集 13 项', slugs.length === 13, `got ${slugs.length}`)
  ;['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird',
    'rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa'].forEach(k => {
    assert(`全集含 ${k}`, slugs.indexOf(k) >= 0)
  })
  assert('chDeptKey 校验改用 PRACTICE_DEPT_SLUGS',
    /PRACTICE_DEPT_SLUGS\.indexOf\(practiceDept\)/.test(chSrc)
      && !/PRACTICE_DEPT_TABS\.indexOf\(practiceDept\)/.test(chSrc))

  // ============ 二、层级渲染 ============
  console.log('\n=== 二、层级渲染（管理员）===')
  setAdmin()
  run('practiceDept = ""')
  run('renderPractice()')
  const h0 = getEl('page-practice').innerHTML
  ;['', 'dining', 'rooms', 'all'].forEach(k => {
    assert(`一级行渲染 setPracticeDept('${k}')`, h0.includes(`setPracticeDept('${k}')`))
  })
  assert('默认视角无二级行（无 dining/sig 按钮）', !h0.includes("setPracticeDept('dining/sig')"))
  assert('默认视角无房务部二级行', !h0.includes("setPracticeDept('rooms/fo')"))

  run(`setPracticeDept('dining')`)
  run('renderPractice()')
  const hD = getEl('page-practice').innerHTML
  ;['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird'].forEach(k => {
    assert(`饮食部二级行渲染 ${k}`, hD.includes(`setPracticeDept('${k}')`))
  })
  assert('饮食部视角不渲染房务部分部门', !hD.includes("setPracticeDept('rooms/fo')"))

  run(`setPracticeDept('rooms')`)
  run('renderPractice()')
  const hR = getEl('page-practice').innerHTML
  ;['rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa'].forEach(k => {
    assert(`房务部二级行渲染 ${k}`, hR.includes(`setPracticeDept('${k}')`))
  })
  assert('房务部视角不渲染饮食部分部门', !hR.includes("setPracticeDept('dining/sig')"))

  run(`setPracticeDept('all')`)
  run('renderPractice()')
  const hA = getEl('page-practice').innerHTML
  assert('通用视角无二级行', !hA.includes("setPracticeDept('dining/sig')")
    && !hA.includes("setPracticeDept('rooms/fo')"))

  // ============ 三、setPracticeDept 校验 ============
  console.log('\n=== 三、setPracticeDept 校验（二级值不回落）===')
  run(`setPracticeDept('dining/sig')`)
  assert("setPracticeDept('dining/sig') 生效", run('practiceDept') === 'dining/sig', run('practiceDept'))
  run(`setPracticeDept('rooms/spa')`)
  assert("setPracticeDept('rooms/spa') 生效", run('practiceDept') === 'rooms/spa', run('practiceDept'))
  run(`setPracticeDept('bogus/xx')`)
  assert("非法值回落 ''", run('practiceDept') === '', run('practiceDept'))
  run(`setPracticeDept('dining')`)
  assert("一级 'dining' 生效", run('practiceDept') === 'dining')

  // ============ 四、chDeptKey 切片联动（v97 保持）============
  console.log('\n=== 四、chDeptKey 切片联动 ===')
  run(`setPracticeDept('dining/yan')`)
  assert("管理员切艳中 → chDeptKey()='dining/yan'", run('chDeptKey()') === 'dining/yan', run('chDeptKey()'))
  run(`setPracticeDept('rooms/styling')`)
  assert("管理员切客房造型 → chDeptKey()='rooms/styling'", run('chDeptKey()') === 'rooms/styling', run('chDeptKey()'))
  run('practiceDept = ""')
  assert("管理员「全部部门」→ chDeptKey()=''", run('chDeptKey()') === '', run('chDeptKey()'))
  setStudent('饮食部·标帜餐厅')
  run(`practiceDept = "dining/bar"`)   // 学员不受切片影响
  assert('学员按本人部门（切片无效）', run('chDeptKey()') === 'dining/sig', run('chDeptKey()'))

  // ============ 五、入口卡三态 ============
  console.log('\n=== 五、challengeEntryHtml 三态 ===')
  // 学员 标帜 → 正常卡（本部门专属营次存在）
  setStudent('饮食部·标帜餐厅')
  const sigCard = run('challengeEntryHtml()')
  assert('标帜学员 → 正常卡含本部门标题', sigCard.includes('标帜餐厅七天英文挑战'), sigCard.slice(0, 120))
  assert('正常卡含本部门营次名', sigCard.includes(R1_NAME))
  assert('正常卡可点击进挑战页', sigCard.includes("navigate('challenge')"))

  // 学员 客房送餐 → noRound 卡（v109 核心：不再显示错位卡）
  setStudent('饮食部·客房送餐')
  const irdCard = run('challengeEntryHtml()')
  assert('客房送餐学员 → 显示 noRound 卡', irdCard.includes(run("t('chDeptNoRound')")), irdCard.slice(0, 160))
  assert('noRound 卡不含错位标题「客房送餐七天英文挑战」', !irdCard.includes('客房送餐七天英文挑战'))
  assert('noRound 卡不含别队营次名', !irdCard.includes(R1_NAME) && !irdCard.includes(R2_NAME))
  assert('noRound 卡列出当前有营次的部门（标帜/艳中）',
    irdCard.includes('标帜餐厅') && irdCard.includes('艳中餐厅'))
  assert('noRound 卡不可点击进挑战页', !irdCard.includes("navigate('challenge')"))

  // 学员 酒吧团队 → 同为 noRound 卡
  setStudent('饮食部·酒吧团队')
  const barCard = run('challengeEntryHtml()')
  assert('酒吧团队学员 → noRound 卡', barCard.includes(run("t('chDeptNoRound')")))

  // 学员 房务部 → blocked 卡（v107 行为不变，与 noRound 卡区分）
  setStudent('房务部·迎宾前台')
  const roomsCard = run('challengeEntryHtml()')
  assert('房务部学员 → blocked 卡（chDeptNotEligible）', roomsCard.includes(run("t('chDeptNotEligible')")))
  assert('房务部学员不是 noRound 卡', !roomsCard.includes(run("t('chDeptNoRound')")))

  // 学员 未设部门 → blocked 卡（去设置部门）
  setStudent('')
  const unsetCard = run('challengeEntryHtml()')
  assert('未设部门学员 → blocked 卡（chDeptNeedSet）', unsetCard.includes(run("t('chDeptNeedSet')")))

  // 管理员切片矩阵
  setAdmin()
  run(`setPracticeDept('dining/ird')`)
  const admIrd = run('challengeEntryHtml()')
  assert('管理员切客房送餐 → noRound 卡（v107 病根修复）',
    admIrd.includes(run("t('chDeptNoRound')")), admIrd.slice(0, 160))
  assert('管理员切客房送餐 → 不含错位标题', !admIrd.includes('客房送餐七天英文挑战'))
  assert('管理员切客房送餐 → 不含别队营次名', !admIrd.includes(R1_NAME))

  run(`setPracticeDept('dining/bar')`)
  assert('管理员切酒吧团队 → noRound 卡',
    run('challengeEntryHtml()').includes(run("t('chDeptNoRound')")))

  run(`setPracticeDept('rooms')`)
  assert('管理员切房务部 → noRound 卡',
    run('challengeEntryHtml()').includes(run("t('chDeptNoRound')")))

  run(`setPracticeDept('all')`)
  assert('管理员切通用 → noRound 卡',
    run('challengeEntryHtml()').includes(run("t('chDeptNoRound')")))

  run(`setPracticeDept('dining')`)
  assert("管理员切「饮食部」一级（整包无专属营次）→ noRound 卡",
    run('challengeEntryHtml()').includes(run("t('chDeptNoRound')")))

  run('practiceDept = ""')
  const admAll = run('challengeEntryHtml()')
  assert("管理员「全部部门」→ 正常卡（通用标题 + 指针营次）",
    admAll.includes(run("t('chTitle')")) && admAll.includes(R1_NAME), admAll.slice(0, 160))

  run(`setPracticeDept('dining/sig')`)
  const admSig = run('challengeEntryHtml()')
  assert('管理员切标帜 → 正常卡（预览标帜营次）', admSig.includes('标帜餐厅七天英文挑战') && admSig.includes(R1_NAME))

  run(`setPracticeDept('dining/yan')`)
  const admYan = run('challengeEntryHtml()')
  assert('管理员切艳中 → 正常卡（艳中专属营次 r2）', admYan.includes('艳中餐厅七天英文挑战') && admYan.includes(R2_NAME),
    `title=${run('chTitleText()')} round=${run('chRoundName()')}`)

  // ============ 六、挑战页深链接 ============
  console.log('\n=== 六、renderChallenge 深链接兜底 ===')
  setStudent('饮食部·客房送餐')
  getEl('page-challenge').innerHTML = ''
  run('renderChallenge()')
  const chIrd = getEl('page-challenge').innerHTML
  assert('客房送餐学员进挑战页 → noRound 说明页', chIrd.includes(run("t('chDeptNoRound')")), chIrd.slice(0, 160))
  assert('说明页不渲染别队营次内容', !chIrd.includes(R1_NAME))
  assert('说明页给返回练习按钮', chIrd.includes("navigate('practice')"))

  setStudent('房务部·迎宾前台')
  getEl('page-challenge').innerHTML = ''
  run('renderChallenge()')
  assert('房务部学员进挑战页 → blocked 说明页（v107）',
    getEl('page-challenge').innerHTML.includes(run("t('chDeptNotEligible')")))

  setStudent('饮食部·标帜餐厅')
  assert('标帜学员不被 noRound 拦（allowed=true 且 noRound=false）',
    run('chDeptAllowed()') === true && run('chNoRoundForDept()') === false)

  // ============ 七、i18n 成对 + 源码护栏 ============
  console.log('\n=== 七、i18n 成对 + 源码护栏 ===')
  assert('zh 有 chDeptNoRound / chDeptNoRoundList',
    i18nSrc.includes("chDeptNoRound: '本部门暂无挑战营次，敬请期待下一期。'")
      && i18nSrc.includes("chDeptNoRoundList: '当前开设营次的部门：'"))
  assert('en 有 chDeptNoRound / chDeptNoRoundList',
    /chDeptNoRound: 'No challenge round for this department yet[^']*'/.test(i18nSrc)
      && /chDeptNoRoundList: 'Departments with an active round:'/.test(i18nSrc))
  assert('challengeEntryHtml 调 chNoRoundForDept',
    /function challengeEntryHtml\(\)[\s\S]{0,800}?chNoRoundForDept\(\)/.test(appSrc))
  assert('challengeEntryNoRoundHtml 已实现', /function challengeEntryNoRoundHtml\(\)/.test(appSrc))
  const rcBody = chSrc.slice(chSrc.indexOf('function renderChallenge'))
  assert('renderChallenge 在 blocked 之后追加 noRound 分支',
    rcBody.indexOf('chDeptAllowed()') >= 0
      && rcBody.indexOf('chDeptAllowed()') < rcBody.indexOf('chNoRoundForDept()')
      && rcBody.indexOf('chNoRoundForDept()') >= 0
      && rcBody.indexOf('chNoRoundForDept()') < rcBody.indexOf('chDeptNoRoundPageHtml()'))
  assert('chDeptNoRoundPageHtml 已实现', /function chDeptNoRoundPageHtml\(\)/.test(chSrc))
  assert('noRound 卡/页不引用 chRoundName（杜绝别队营次名）',
    !/function challengeEntryNoRoundHtml\(\)[\s\S]{0,1400}chRoundName/.test(appSrc)
      && !/function chDeptNoRoundPageHtml\(\)[\s\S]{0,1400}chRoundName/.test(chSrc))

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ v109 全部断言通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
