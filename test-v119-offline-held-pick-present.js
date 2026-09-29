// test-v119-offline-held-pick-present.js
// v119：线下课「标注完成」弹窗改为勾选【来了的】学员 + 名单显示中文名（不再只显示账号名）。
//
// 背景（用户反馈）：「线下课录入能勾选谁来了 并且是人的名字而不是账号的名字吗」
//   → ① 原弹窗是**反向**的（勾选「没来的学员」，未勾选=来了），与「勾选谁来了」的直觉相反；
//        新老师容易按直觉勾「来了的人」，结果把出席的全标成缺席（危险：反向误标）。
//     ② 名单渲染用 escHtml(u) 直接输出**用户名**（如 xiaoming01），不是人的姓名。
//
// 改动：
//   - courseHeldModal：默认**全员勾选**（= 都来了），老师只需取消没到的；`prevAbsent` 回显反转
//     （上次缺席者本次不勾选）。存储结构不变，仍写 a.absent。
//   - courseHeldSave：勾选集合语义由 absent 改为 present，absent = members - present。
//   - 两处名单标签改用 courseMemberCell(u, infoMap) → 中文名加粗 + 用户名小字 + 部门。
//   - 新增一键「全选 / 全不选」（courseHeldPickAll / courseOfflinePickAll）。
//   - i18n：courseOfflineHeldModalHint 反转措辞；新增 courseOfflinePickAll / courseOfflinePickNone。
//
// 断言面：
//   ① i18n 两新键 zh/en 成对 + hint 反转措辞（zh/en 都不得再是「请勾选没来的」）
//   ② courseHeldModal 默认全员勾选 + 提示接线 + 全选/全不选按钮接线
//   ③ courseHeldSave 口径反转（勾选=出席；未勾选=缺席）
//   ④ 姓名显示：courseMemberCell 输出中文名与用户名，且两个弹窗都用它渲染标签
//   ⑤ 行为沙箱：真实跑一遍「3 人只来 1 人」→ absent 正确；再跑姓名映射
//   ⑥ 版本号：唯一 ?v=N ×12 且 ≥119
'use strict'
let pass = 0, fail = 0
const assert = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) } }
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const appSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const idxSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

const bodyOf = (src, header, stopHeader) => {
  const i = src.indexOf(header)
  if (i < 0) return ''
  const j = src.indexOf(stopHeader, i + header.length)
  return src.slice(i, j < 0 ? src.length : j)
}
const countOf = (s, sub) => s.split(sub).length - 1

// ---------- ① i18n ----------
console.log('① i18n：新键成对 + 提示语反转')
for (const k of ['courseOfflinePickAll', 'courseOfflinePickNone']) {
  const n = (i18nSrc.match(new RegExp('\\b' + k + ':', 'g')) || []).length
  assert(n === 2, `键 ${k} zh/en 成对（实际 ${n}）`)
}
assert(/courseOfflineHeldModalHint:\s*\(n\)\s*=>/.test(i18nSrc), 'courseOfflineHeldModalHint 仍是带参箭头函数')
{
  const lines = i18nSrc.split('\n').filter(l => l.includes('courseOfflineHeldModalHint'))
  assert(lines.length === 2, 'courseOfflineHeldModalHint 恰好两行（zh/en）')
  assert(lines.some(l => l.includes('取消勾选')), 'zh 提示改为「取消勾选没来的学员」（反转 v35 的「请勾选没来的」）')
  assert(lines.some(l => /Uncheck/.test(l)), 'en 提示改为 Uncheck')
  assert(lines.every(l => !/请勾选<b>没来的/.test(l) && !/Check members who were/.test(l)),
    '两处都不得残留旧口径（「请勾选没来的」/「Check members who were」）')
}

// ---------- ② courseHeldModal ----------
console.log('② courseHeldModal：默认全勾 + 反向回显 + 快捷按钮接线')
const modal = bodyOf(appSrc, 'async function courseHeldModal(cid, aid)', '\nasync function courseHeldSave')
assert(modal.length > 0, '能取到 courseHeldModal 函数体')
assert(modal.includes('async function courseHeldModal'), 'courseHeldModal 已是 async（要拉取姓名映射）')
assert(modal.includes('await courseUserInfoMap()'), '弹窗内 await courseUserInfoMap() 拉取姓名')
assert(/const present = prevAbsent\.length \? prevAbsent\.indexOf\(u\) < 0 : true/.test(modal),
  'v119：默认全勾；有历史缺席名单时按「不在缺席名单里 = 勾选」反向回显')
assert(modal.includes('${present ? \' checked\' : \'\'}'), 'v119：checkbox 用 present 决定勾选（不再是 prevAbsent 命中才勾）')
assert(!/prevAbsent\.indexOf\(u\) >= 0 \? ' checked'/.test(modal), '旧口径（缺席才勾选）已移除')
assert(modal.includes('courseHeldPickAll(true)') && modal.includes('courseHeldPickAll(false)'),
  '弹窗含「全选 / 全不选」按钮接线')
assert(modal.includes("t('courseOfflineHeldModalHint', members.length)"), '提示语仍接线并传人数')
assert(modal.includes('courseHeldSave(') && modal.includes("t('courseOfflineHeldAll')"), '主按钮仍指向 courseHeldSave')
// 快捷函数
assert(appSrc.includes('function courseHeldPickAll(on)'), 'courseHeldPickAll 已定义（标注完成弹窗）')
{
  const b = bodyOf(appSrc, 'function courseHeldPickAll(on)', '\n}\n')
  assert(b.includes('.course-off-absent-pick') && b.includes('name="coAbs"'), 'courseHeldPickAll 作用于 coAbs 勾选框')
}
assert(appSrc.includes('function courseOfflinePickAll(on)'), 'courseOfflinePickAll 已定义（成员补标弹窗）')
{
  const b = bodyOf(appSrc, 'function courseOfflinePickAll(on)', '\n}\n')
  assert(b.includes('.course-off-members') && b.includes('name="coM"'), 'courseOfflinePickAll 作用于 coM 勾选框')
}

// ---------- ③ courseHeldSave 口径反转 ----------
console.log('③ courseHeldSave：勾选=出席，未勾选=缺席')
const save = bodyOf(appSrc, 'async function courseHeldSave(cid, aid)', '\nfunction courseHeldPickAll')
assert(save.length > 0, '能取到 courseHeldSave 函数体')
assert(save.includes(':checked') && save.includes('const present = '), '从勾选框读出的集合命名为 present（语义已反转）')
assert(/const absent = members\.filter\(u => !presentSet\[u\]\)/.test(save), 'absent = members 中未勾选者（口径正确）')
assert(/const attend = members\.filter\(u => presentSet\[u\]\)/.test(save), 'attend = members 中已勾选者')
assert(!/const absent = Array\.prototype\.slice\.call/.test(save), '旧口径（直接把勾选当 absent）已移除')
assert(!/const absentSet/.test(save), '旧变量名 absentSet 已移除（防残留混用）')
assert(save.includes('if (!attend.length)') && save.includes('courseOfflineNoAttend'), '全员未勾选仍被拦截（不标 held）')
assert(/if \(!presentSet\[u\]\) delete aa\.results\[u\]/.test(save), '未勾选者清除 results（防误标残留）')
assert(save.includes('aa.absent = absent.slice()'), '存储结构不变：仍写 a.absent')

// ---------- ④ 姓名显示 ----------
console.log('④ 名单显示人的姓名（而非账号名）')
assert(appSrc.includes('function courseMemberCell(u, map)'), 'courseMemberCell 辅助函数存在')
{
  const b = bodyOf(appSrc, 'function courseMemberCell(u, map)', '\n\n')
  assert(b.includes('info.name') && b.includes('<strong>'), 'courseMemberCell 输出加粗中文名')
  assert(b.includes('color:#9ca3af') && b.includes('escHtml(u)'), 'courseMemberCell 保留用户名小字（便于核对账号）')
}
assert(modal.includes('courseMemberCell(u, infoMap)'), 'v119：标注完成弹窗标签改用 courseMemberCell（中文名）')
assert(!/value="\$\{escAttr\(u\)\}"\$\{present \? ' checked' : ''\} \/> \$\{escHtml\(u\)\}/.test(modal),
  'v119：标注完成弹窗不再直接 escHtml(u) 当标签')
{
  const mem = bodyOf(appSrc, 'async function courseOfflineMembers(cid, aid)', '\nasync function courseOfflineMembersSave')
  assert(mem.length > 0, '能取到 courseOfflineMembers 函数体')
  assert(mem.includes('async function courseOfflineMembers'), 'courseOfflineMembers 已是 async')
  assert(mem.includes('await courseUserInfoMap()'), '成员补标弹窗也拉取姓名映射')
  assert(mem.includes('courseMemberCell(u, infoMap)'), 'v119：成员补标弹窗标签也改用 courseMemberCell')
  assert(mem.includes('courseOfflinePickAll(true)'), '成员补标弹窗也加全选/全不选')
}

// ---------- ⑤ 行为沙箱：跑真实代码 ----------
console.log('⑤ 行为验证（真实代码 + 真实云端 doc 结构）')
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}
function makeSb(docRef, users) {
  const els = {}
  const getEl = id => els[id] || (els[id] = mkEl())
  let last = null
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const sb = {
    console,
    localStorage: { store: {}, getItem(k) { return this.store[k] !== undefined ? this.store[k] : null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    document: {
      getElementById: getEl, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { last = mkEl(); return last },
      body: { appendChild() {} }, title: '', addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {}, speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] }, SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() } },
    alert(m) { sb._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      // 姓名来源：这里返回「用户名 → 中文名」的映射
      getDashboardData: async () => (users || []),
      recalcCloudPlacementLevels: async () => ({}), flushDuration() {}, pushPending: async () => {},
    },
    CourseStore: {
      status: 'online', newId: () => 'aX' + Math.floor(Math.random() * 1e6),
      findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
      findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
      getDoc: async () => JSON.parse(JSON.stringify(docRef.doc)),
      mutate: async fn => {
        const d = JSON.parse(JSON.stringify(docRef.doc))
        const r = fn(d)
        if (r === false) return null
        docRef.doc = d
        return true
      },
    },
    _els: els, _getEl: getEl, _lastCreated: () => last,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(load('i18n.js'), sb)
  vm.runInContext(load('bank-data.js'), sb)
  vm.runInContext(load('store.js'), sb)
  vm.runInContext(load('qgen.js'), sb)
  vm.runInContext(load('course-app.js'), sb)
  vm.runInContext(load('app.js'), sb)
  vm.runInContext('async function seed(){ courseState.doc = await CourseStore.getDoc() }', sb)
  return sb
}

const USERS = [
  { username: 'u1', name: '张伟', dept: '标帜餐厅' },
  { username: 'u2', name: '李娜', dept: '艳中餐厅' },
  { username: 'u3', name: '', dept: '' },          // 无姓名 → 回退显示用户名
]
const seedDoc = () => ({
  doc: {
    v: 1, classes: [{
      id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin',
      members: ['u1', 'u2', 'u3'],
      assignments: [{ id: 'o1', type: 'offline', title: '点餐服务', topicId: 3, custom: false, desc: '三楼培训室', date: 0, createdAt: 2, held: false, heldAt: 0, results: {} }],
    }],
  },
})

;(async () => {
  const sb = makeSb(seedDoc(), USERS)
  vm.runInContext('Store.getSession = () => ({ id: 1, username: "admin", name: "管理员", role: "admin" })', sb)
  vm.runInContext('Store.getUsers = () => []', sb)
  await vm.runInContext('seed()', sb)

  // 弹窗：默认全员勾选 + 姓名显示
  await vm.runInContext('courseHeldModal("c1","o1")', sb)
  const html = sb._lastCreated() ? sb._lastCreated().innerHTML : ''
  assert((html.match(/name="coAbs"/g) || []).length === 3, '弹窗渲染 3 个勾选框')
  assert((html.match(/checked/g) || []).length === 3, 'v119：默认 3 个全勾选（都来了）')
  assert(html.includes('张伟') && html.includes('李娜'), '弹窗显示中文名（张伟 / 李娜）')
  assert(html.includes('u1') && html.includes('u2'), '同时保留用户名小字（便于核对账号）')
  assert(html.includes('u3'), '无姓名的成员回退显示用户名')
  assert(!html.includes('请勾选<b>没来的'), '弹窗内不再出现旧口径提示')

  // 行为：3 人只来 1 人（勾 u1）→ u2/u3 缺席
  sb.document.querySelectorAll = () => [{ value: 'u1' }]
  await vm.runInContext('courseHeldSave("c1","o1")', sb)
  const a1 = vm.runInContext('courseState.doc.classes[0].assignments[0]', sb)
  assert(a1.held === true, '保存后 held=true')
  assert(JSON.stringify(a1.absent) === '["u2","u3"]', 'v119：未勾选者 u2/u3 进 absent（口径正确）')
  assert(a1.results.u1 && a1.results.u1.done === true, '勾选者 u1 记 done')
  assert(!a1.results.u2 && !a1.results.u3, '未勾选者无 results 记录')
  assert((sb._lastAlert || '').includes('已给 1 名成员标注完成') && (sb._lastAlert || '').includes('未到 2 人'),
    '提示：已给 1 名标注完成，未到 2 人 —— ' + sb._lastAlert)

  // 反向回显：撤销后重开弹窗，s 缺席者应【不勾选】
  await vm.runInContext('courseUnheldAll("c1","o1")', sb)
  await vm.runInContext('courseHeldModal("c1","o1")', sb)
  const html2 = sb._lastCreated() ? sb._lastCreated().innerHTML : ''
  assert(html2.includes('value="u1" checked'), 'v119 回显：上次出席的 u1 仍勾选')
  assert(!html2.includes('value="u2" checked') && !html2.includes('value="u3" checked'),
    'v119 回显：上次缺席的 u2/u3 不勾选')

  // 全员未勾选 → 拦截
  sb.document.querySelectorAll = () => []
  await vm.runInContext('courseHeldSave("c1","o1")', sb)
  const a2 = vm.runInContext('courseState.doc.classes[0].assignments[0]', sb)
  assert(a2.held === false && Object.keys(a2.results).length === 0, '全员未勾选 → 不标 held')
  assert((sb._lastAlert || '').includes('没有可标注的出席成员'), '提示无出席成员')

  // 成员补标弹窗也显示姓名
  await vm.runInContext('courseOfflineMembers("c1","o1")', sb)
  const html3 = sb._lastCreated() ? sb._lastCreated().innerHTML : ''
  assert(html3.includes('张伟') && html3.includes('李娜'), '成员补标弹窗同样显示中文名')
  assert(html3.includes('courseOfflinePickAll(true)'), '成员补标弹窗含全选按钮')

  // ---------- ⑥ 版本号 ----------
  console.log('⑥ 版本号')
  {
    const vms = (idxSrc.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = Array.from(new Set(vms))
    assert(vms.length === 12 && uniq.length === 1, '版本号统一：唯一值 × 12 处')
    assert(uniq.length === 1 && uniq[0] >= 119, '版本号 ≥ 119')
  }

  console.log(`\nPASS ${pass} FAIL ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(e => { console.error('异常:', e); process.exit(1) })
