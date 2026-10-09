// ====== 测试：v153 营次列表卡收紧 —— 汇总视角只显示「登录账号自己部门」的营次 ======
// 用户口径（v153）：「那这个本部门 不是应该也只显示自己部门了么」—— 截图里管理员在汇总视角
//   看到「本部门下设 4 期挑战」列着 标帜×2 + 艳中 + 客房送餐（v110 总览口径），与 v152
//   「营次按部门独立编号」的心智模型冲突。用户拍板：汇总视角只显示自己部门（推翻 v110 总览）。
// 口径矩阵（新函数 chRoundCardList，仅供列表卡使用）：
//   · 分部门视角（'dining/sig' 等）→ 视角即单一部门 → 该分部门的历期（视角优先于登录部门）
//   · 汇总视角（'' 全库 / 'dining' 大部门）→ 登录账号自己部门（sessionDeptSlug）的历期
//   · 'all'（仅通用题切片）→ 无营次（v110 语义保持）
//   · 未设部门（管理员典型）→ 空 → 整卡不渲染
//   · legacy 全部门期（depts: []）→ 对所有人都适用 → 出现在每个人卡里
//   ⚠️ chRoundListForView 本体绝不能改口径 —— chCurrentRound 回落 / chRoundViewKey 重载判据 /
//      chRoundMetaText / chHardRoundHtml / chLbAggregate 都还消费它（第 4 组护栏）。
// 覆盖：
//   1. chRoundCardList 矩阵（视角 × 自己部门 × 营次部门）
//   2. chRoundListHtml 渲染判定（<2 期不渲染 / 只含本部门期名 / 云端原序）
//   3. 学员端（非管理员）各 dept 行为（k 恒为自己部门 → 分部门分支）
//   4. 主链路不连坐：chRoundListForView 本体口径不变 / chCurrentRound 大部门回落仍取列表最新
//   5. i18n 双语提示更新成对 + 源码护栏
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

// ---- cloud-store.js 提取 roundDeptMatch / roundOpenState ----
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

// 营次夹具：镜像 2026-10-09 线上真实状态（r1 标帜 / r2 艳中 / r3 标帜第二期 / r4 客房送餐第1期）
const R1 = '标帜餐厅七天挑战第一期'
const R2 = '艳中餐厅七天挑战第一期'
const R3 = '标帜餐厅七天挑战第二期'
const R4 = '客房送餐部七天挑战第1期'
const mkRounds = (extra) => {
  const base = [
    { id: 'r1', name: R1, depts: ['dining/sig'], open: true, examOpen: true },
    { id: 'r2', name: R2, depts: ['dining/yan'], open: true, examOpen: true },
    { id: 'r3', name: R3, depts: ['dining/sig'], open: true, examOpen: true },
    { id: 'r4', name: R4, depts: ['dining/ird'], open: true, examOpen: true },
  ]
  return extra ? base.concat(extra) : base
}
const setRounds = (extra) => {
  sandbox.CloudSync = { _chRounds: mkRounds(extra), _chRoundCurId: 'r1', _chRoundCurName: R1 }
}
setRounds()

// 登录身份：dept 用线上同款「大部门·分部门」显示名（sessionDeptSlug → normDept → slug）
const asStudent = dept => {
  Store.getSession = () => ({ role: 'student', name: 's1', username: 's1', dept })
  Store.getUser = () => ({ name: 's1', dept })
}
const asAdmin = dept => {
  Store.getSession = () => ({ role: 'admin', username: 'admin', dept: dept || '' })
  Store.getUser = () => ({ name: 'admin', dept: dept || '' })
}
// 管理员「题目部门」切片（挑战页视角）。'' = 未切片（跟随登录部门）
const setSlice = k => { asAdmin(''); run(`setPracticeDept(${JSON.stringify(k)})`) }
const cardIds = () => run('chRoundCardList().map(r => r.id)')
const eq = v => JSON.stringify(v)

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')

;(async () => {
  console.log('\n🧪 v153 营次列表卡收紧：汇总视角只显示自己部门')

  // ============ 〇、身份映射自检 ============
  console.log('\n=== 〇、身份映射自检（桩 → slug）===')
  asAdmin('饮食部·客房送餐')
  assert('映射自检：饮食部·客房送餐 → dining/ird', run('sessionDeptSlug()') === 'dining/ird', run('sessionDeptSlug()'))
  asAdmin('饮食部·标帜餐厅')
  assert('映射自检：饮食部·标帜餐厅 → dining/sig', run('sessionDeptSlug()') === 'dining/sig', run('sessionDeptSlug()'))
  asAdmin('饮食部·酒吧团队')
  assert('映射自检：饮食部·酒吧团队 → dining/bar', run('sessionDeptSlug()') === 'dining/bar', run('sessionDeptSlug()'))
  asAdmin('')
  assert('映射自检：未设部门 → 空串', run('sessionDeptSlug()') === '')

  // ============ 一、chRoundCardList 矩阵 ============
  console.log('\n=== 一、chRoundCardList（视角 × 自己部门）===')
  // -- 汇总视角：全库（''）--
  setSlice('')
  asAdmin('饮食部·客房送餐')
  assert('★ 全库视角 + 自己部门=客房送餐 → 仅 r4（不混入标帜/艳中）', eq(cardIds()) === '["r4"]', eq(cardIds()))
  asAdmin('饮食部·标帜餐厅')
  assert('全库视角 + 自己部门=标帜 → r1+r3（同部门两期）', eq(cardIds()) === '["r1","r3"]', eq(cardIds()))
  asAdmin('饮食部·艳中餐厅')
  assert('全库视角 + 自己部门=艳中 → 仅 r2', eq(cardIds()) === '["r2"]', eq(cardIds()))
  asAdmin('饮食部·酒吧团队')
  assert('全库视角 + 自己部门=酒吧（0 期）→ 空', eq(cardIds()) === '[]', eq(cardIds()))
  asAdmin('')
  assert('★ 全库视角 + 未设部门（管理员典型）→ 空（整卡不渲染）', eq(cardIds()) === '[]', eq(cardIds()))
  // -- 汇总视角：大部门（'dining'）--
  setSlice('dining')
  asAdmin('饮食部·客房送餐')
  assert('★ 饮食部大部门视角 + 自己部门=客房送餐 → 仅 r4（不再汇总别队）', eq(cardIds()) === '["r4"]', eq(cardIds()))
  asAdmin('饮食部·标帜餐厅')
  assert('饮食部大部门视角 + 自己部门=标帜 → r1+r3', eq(cardIds()) === '["r1","r3"]', eq(cardIds()))
  asAdmin('')
  assert('饮食部大部门视角 + 未设部门 → 空', eq(cardIds()) === '[]', eq(cardIds()))
  // -- 'all'（仅通用题切片）--
  setSlice('all')
  asAdmin('饮食部·标帜餐厅')
  assert("'all' 切片 → 无营次（v110 语义保持）", eq(cardIds()) === '[]', eq(cardIds()))
  // -- 分部门视角：视角优先于登录部门 --
  setSlice('dining/sig')
  asAdmin('饮食部·客房送餐')
  assert('★ 分部门视角优先：视角=标帜、自己部门=客房送餐 → 列标帜两期（视角赢）', eq(cardIds()) === '["r1","r3"]', eq(cardIds()))
  setSlice('dining/ird')
  asAdmin('饮食部·标帜餐厅')
  assert('分部门视角=客房送餐、自己部门=标帜 → 仅 r4', eq(cardIds()) === '["r4"]', eq(cardIds()))
  setSlice('dining/bar')
  asAdmin('饮食部·标帜餐厅')
  assert('分部门视角=酒吧（0 期）→ 空', eq(cardIds()) === '[]', eq(cardIds()))
  setSlice('')

  // ============ 二、chRoundListHtml 渲染判定 ============
  console.log('\n=== 二、chRoundListHtml（渲染判定）===')
  asAdmin('饮食部·客房送餐'); setSlice('')
  assert('自己部门仅 1 期 → 整卡不渲染（<2 期规则）', run('chRoundListHtml()') === '')
  asAdmin('饮食部·标帜餐厅')
  const hList = run('chRoundListHtml()')
  assert('自己部门两期 → 渲染列表卡', hList.length > 0 && hList.includes(R1) && hList.includes(R3), 'len=' + hList.length)
  assert('列表卡不含别队营次（艳中/客房送餐）', !hList.includes(R2) && !hList.includes(R4))
  assert('列表卡保持云端原序（r1 在 r3 前）', hList.indexOf(R1) >= 0 && hList.indexOf(R1) < hList.indexOf(R3))
  assert('列表卡含标题键（本部门下设 2 期）', hList.includes(run('t("chRoundListTitle", 2)')))
  asAdmin('')
  assert('未设部门 → 整卡不渲染', run('chRoundListHtml()') === '')

  // ============ 三、legacy 全部门期（depts: []）对所有人都适用 ============
  console.log('\n=== 三、legacy 全部门期 ===')
  setRounds([{ id: 'r0', name: '全员摸底期', depts: [], open: true }])
  asAdmin('饮食部·客房送餐')
  assert('legacy 期（depts 空）出现在客房送餐卡里', eq(cardIds()) === '["r4","r0"]', eq(cardIds()))
  asAdmin('饮食部·标帜餐厅')
  assert('legacy 期出现在标帜卡里', eq(cardIds()) === '["r1","r3","r0"]', eq(cardIds()))
  asAdmin('饮食部·酒吧团队')
  assert('legacy 期出现在 0 期部门卡里（酒吧也有份）', eq(cardIds()) === '["r0"]', eq(cardIds()))
  setRounds()

  // ============ 四、学员端（非管理员）============
  console.log('\n=== 四、学员端（k 恒为自己部门 → 分部门分支）===')
  asStudent('饮食部·标帜餐厅')
  assert('学员（标帜）→ 本部门两期', eq(cardIds()) === '["r1","r3"]', eq(cardIds()))
  asStudent('饮食部·客房送餐')
  assert('学员（客房送餐）→ 仅 r4', eq(cardIds()) === '["r4"]', eq(cardIds()))
  asStudent('饮食部·酒吧团队')
  assert('学员（酒吧，0 期）→ 空', eq(cardIds()) === '[]', eq(cardIds()))
  asStudent('房务部·迎宾前台')
  assert('学员（房务部）→ 空（饮食部营次与其无关）', eq(cardIds()) === '[]', eq(cardIds()))
  asStudent('')
  assert('学员（未设部门）→ 空', eq(cardIds()) === '[]', eq(cardIds()))
  asStudent('饮食部·标帜餐厅')
  assert('学员（标帜）列表卡渲染', run('chRoundListHtml()').includes(R1))

  // ============ 五、主链路不连坐（chRoundListForView 本体口径未动）============
  console.log('\n=== 五、主链路不连坐护栏 ===')
  setSlice(''); asAdmin('')
  assert('chRoundListForView 全库仍返回全部 4 期（本体口径未动）',
    eq(run('chRoundListForView().map(r => r.id)')) === '["r1","r2","r3","r4"]',
    eq(run('chRoundListForView().map(r => r.id)')))
  setSlice('dining')
  assert('chRoundListForView 饮食部视角仍汇总 4 期',
    eq(run('chRoundListForView().map(r => r.id)')) === '["r1","r2","r3","r4"]',
    eq(run('chRoundListForView().map(r => r.id)')))
  assert('chNoRoundForDept 饮食部仍为 false（门禁口径未动）', run('chNoRoundForDept()') === false)
  asAdmin('饮食部·客房送餐')
  assert('大部门视角 chCurrentRound 回落仍取列表最新（r4）', run('chCurrentRound()') === 'r4', run('chCurrentRound()'))
  setSlice('')

  // ============ 六、i18n + 源码护栏 ============
  console.log('\n=== 六、i18n / 源码护栏 ===')
  assert('zh 提示已更新（不再引导切题目部门）',
    i18nSrc.includes('本部门各期独立开营、题目不同') && !i18nSrc.includes('本部门各分队各自开营'))
  assert('en 提示已更新（成对）', /Each round of this department runs independently/.test(i18nSrc)
    && !/Switch "Question Dept" above/.test(i18nSrc))
  assert('标题键 zh/en 仍在（语义已收敛为单一部门）',
    i18nSrc.includes('本部门下设') && /chRoundListTitle: \(n\) =>/.test(i18nSrc))
  assert('chRoundListHtml 直用 chRoundCardList',
    /function chRoundListHtml\(\)[\s\S]{0,200}?chRoundCardList\(\)/.test(chSrc))
  assert('入口卡预览优先 chRoundCardList、缺失回落旧口径',
    /function challengeEntryRoundPreviewHtml\(\)[\s\S]{0,400}?typeof chRoundCardList === 'function'/.test(appSrc)
      && /function challengeEntryRoundPreviewHtml\(\)[\s\S]{0,600}?typeof chRoundListForView === 'function'/.test(appSrc))
  assert('chRoundCardList 全程 typeof 守卫',
    /function chRoundCardList\(\)[\s\S]{0,900}?typeof chDeptKey === 'function'/.test(chSrc)
      && /function chRoundCardList\(\)[\s\S]{0,900}?typeof sessionDeptSlug === 'function'/.test(chSrc)
      && /function chRoundCardList\(\)[\s\S]{0,900}?typeof chRoundListForView === 'function'/.test(chSrc)
      && /function chRoundCardList\(\)[\s\S]{0,900}?typeof roundDeptMatch/.test(chSrc))
  assert('v153：版本参数已 bump（index.html 唯一版本号 ≥153）', (() => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')
    const vms = (html.match(/\?v=(\d+)/g) || []).map(s => +s.slice(3))
    return vms.length === 12 && new Set(vms).size === 1 && [...new Set(vms)][0] >= 153
  })())

  console.log('\n' + (testFailed ? '❌ 存在失败断言' : '✅ v153 全部断言通过'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
