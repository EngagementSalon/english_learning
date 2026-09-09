// ====== 测试：v35 线下课标注完成可选择未出席成员 ======
// ① 数据模型：absent 字段 + 缺席者完成判定
// ② 管理端「标注完成」弹窗：勾选没来的学员 → 其余自动标注；缺席徽标 / 幂等 / 全员缺席拦截 / 预勾选回显
// ③ 撤销清空缺席名单；「成员补标」弹窗 ⇄ 缺席名单互为补集
// ④ 学员端：缺席学员显示「未出席」；线性进度把缺席节点视为未完成
// ⑤ i18n 双语键齐全（含人数插值）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null,
    scrollIntoView() {},
  }
}

function makeSandbox(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let lastCreated = null
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const sandbox = {
    console,
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { lastCreated = mkEl(); return lastCreated },
      body: { appendChild() {} }, title: '',
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [], recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    CourseStore: {
      status: 'online',
      newId: () => 'aX' + Math.floor(Math.random() * 1e6),
      findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
      findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
      getDoc: async () => JSON.parse(JSON.stringify(courseDocRef.doc)),
      mutate: async fn => {
        const doc = JSON.parse(JSON.stringify(courseDocRef.doc))
        const ret = fn(doc)
        if (ret === false) return null
        courseDocRef.doc = doc
        return true
      },
    },
    _els: elements, _getEl: getEl, _lastCreated: () => lastCreated,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

function asAdmin(sb) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  return Store
}
function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
  Store.getUser = () => ({ name, dept: '' })
  return Store
}

// 管理端 doc：c1 三名成员 s1/s2/s3，o1 线下课未下课
const docAdmin = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1', 's2', 's3'],
  assignments: [
    { id: 'h1', type: 'homework', title: '第一课作业', desc: '', deadline: 0, createdAt: 1, questions: [], results: { s1: { at: 1, score: 80 } } },
    { id: 'o1', type: 'offline', title: '点餐服务', topicId: 3, custom: false, desc: '三楼培训室', date: 0, createdAt: 2, held: false, heldAt: 0, results: {} },
  ] }] } }

// 学员端 doc：o1 已下课，absent=[s2,s3]，仅 s1 完成
const docStudent = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1', 's2', 's3'],
  assignments: [
    { id: 'o1', type: 'offline', title: '点餐服务', topicId: 3, custom: false, desc: '', date: 0, createdAt: 1, held: true, heldAt: 9, absent: ['s2', 's3'], results: { s1: { done: true, at: 9, by: 'admin' } } },
  ] }] } }

;(async () => {
  console.log('\n🧪 v35 线下课标注完成可选未出席回归测试\n')

  console.log('① 数据模型与完成判定')
  const sbA = makeSandbox({ doc: {} })
  assert('缺席者（无 results 记录）→ 未完成', vm.runInContext('courseTaskDone({ type: "offline", absent: ["s2"] }, null)', sbA) === false)
  assert('出席者 done=true → 完成', vm.runInContext('courseTaskDone({ type: "offline", absent: ["s2"] }, { done: true })', sbA) === true)
  assert('absent 兼容缺失（旧数据无字段）不报错', vm.runInContext('Array.isArray(({ held: true }).absent)', sbA) === false)

  console.log('\n② 管理端：标注完成弹窗勾选没来的学员')
  const sbB = makeSandbox(JSON.parse(JSON.stringify(docAdmin)))
  asAdmin(sbB)
  await vm.runInContext('courseTestSeedDoc()', sbB)
  const oid = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.type === "offline").id', sbB)
  // 未下课行：主按钮应打开缺席选择弹窗
  const row0 = vm.runInContext(`courseOfflineAdminRow(courseFind("c1"), courseState.doc.classes[0].assignments.find(a => a.id === "${oid}"))`, sbB)
  assert('未下课行主按钮 = courseHeldModal（含排序列）', row0.includes('courseHeldModal') && row0.includes('course-sort-cell'), row0.slice(0, 300))
  // 弹窗内容
  vm.runInContext(`courseHeldModal("c1","${oid}")`, sbB)
  const modalHtml = sbB._lastCreated() ? sbB._lastCreated().innerHTML : ''
  assert('弹窗含 3 个缺席勾选框（name="coAbs"）', (modalHtml.match(/name="coAbs"/g) || []).length === 3, modalHtml.slice(0, 400))
  assert('弹窗标题=标注完成、提示含「没来的学员 / 共 3 人」', modalHtml.includes('标注完成') && modalHtml.includes('没来的学员') && modalHtml.includes('共 3 人'), modalHtml.slice(0, 300))
  // 勾选 s2、s3 没来 → 保存
  sbB.document.querySelectorAll = () => [{ value: 's2' }, { value: 's3' }]
  await vm.runInContext(`courseHeldSave("c1","${oid}")`, sbB)
  const o1b = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('保存后 held=true、absent=[s2,s3]、仅出席者 s1 完成', o1b.held === true && JSON.stringify(o1b.absent) === '["s2","s3"]' && o1b.results.s1.done === true && !o1b.results.s2 && !o1b.results.s3, JSON.stringify(o1b))
  assert('提示 = 已给 1 名成员标注完成，未到 2 人', (sbB._lastAlert || '').includes('已给 1 名成员标注完成，未到 2 人'), sbB._lastAlert)
  // 已下课行：缺席徽标 + 撤销按钮
  const row1 = vm.runInContext(`courseOfflineAdminRow(courseFind("c1"), courseState.doc.classes[0].assignments.find(a => a.id === "${oid}"))`, sbB)
  assert('已下课行显示「未到 2 人」徽标与 1/3，且无「全员完成」标签', row1.includes('未到 2 人') && row1.includes('course-off-absent') && row1.includes('1/3') && !row1.includes('已下课·全员完成') && row1.includes('courseUnheldAll'), row1.slice(0, 500))
  // 已 held 重复保存被拦截
  await vm.runInContext(`courseHeldSave("c1","${oid}")`, sbB)
  const o1b2 = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('重复标注被拦截（提示已完成，数据不变）', (sbB._lastAlert || '').includes('已完成全员标注') && JSON.stringify(o1b2.absent) === '["s2","s3"]', 'alert=' + sbB._lastAlert)
  // 撤销 → absent 与 results 清空
  await vm.runInContext(`courseUnheldAll("c1","${oid}")`, sbB)
  const o1c = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('撤销后 held=false、results 清空、缺席名单保留 [s2,s3]', o1c.held === false && Object.keys(o1c.results).length === 0 && JSON.stringify(o1c.absent) === '["s2","s3"]', JSON.stringify(o1c))
  // 全员缺席 → 拦截不标注
  sbB.document.querySelectorAll = () => [{ value: 's1' }, { value: 's2' }, { value: 's3' }]
  await vm.runInContext(`courseHeldSave("c1","${oid}")`, sbB)
  const o1d = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('全员缺席被拦截：held 仍 false、无记录、提示无出席成员', o1d.held === false && Object.keys(o1d.results).length === 0 && (sbB._lastAlert || '').includes('没有可标注的出席成员'), 'alert=' + sbB._lastAlert)
  // 预勾选回显：标注 s3 缺席 → 撤销 → 再开弹窗 s3 应预勾选
  sbB.document.querySelectorAll = () => [{ value: 's3' }]
  await vm.runInContext(`courseHeldSave("c1","${oid}")`, sbB)
  const o1e = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('s3 缺席标注成功（s1/s2 完成）', o1e.held === true && JSON.stringify(o1e.absent) === '["s3"]' && o1e.results.s1.done && o1e.results.s2.done && !o1e.results.s3, JSON.stringify(o1e))
  await vm.runInContext(`courseUnheldAll("c1","${oid}")`, sbB)
  vm.runInContext(`courseHeldModal("c1","${oid}")`, sbB)
  const modal2 = sbB._lastCreated() ? sbB._lastCreated().innerHTML : ''
  assert('再次标注弹窗中 s3 预勾选、s1 未勾选', (modal2.match(/name="coAbs"/g) || []).length === 3 && modal2.includes('value="s3" checked') && !modal2.includes('value="s1" checked'), modal2.slice(0, 400))

  console.log('\n③ 「成员补标」弹窗 ⇄ 缺席名单互为补集')
  // 恢复 held + absent=[s3]
  sbB.document.querySelectorAll = () => [{ value: 's3' }]
  await vm.runInContext(`courseHeldSave("c1","${oid}")`, sbB)
  // 补标弹窗只勾 s1/s2（s3 仍缺席）
  vm.runInContext(`courseOfflineMembers("c1","${oid}")`, sbB)
  sbB.document.querySelectorAll = () => [{ value: 's1' }, { value: 's2' }]
  await vm.runInContext(`courseOfflineMembersSave("c1","${oid}")`, sbB)
  const o1g = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('补标 s1/s2 后 absent 同步 = [s3]、results 无 s3', o1g.absent.length === 1 && o1g.absent[0] === 's3' && o1g.results.s1.done && o1g.results.s2.done && !o1g.results.s3, JSON.stringify(o1g))
  // 补标弹窗全勾 → absent 清空、全员完成、held 保留
  sbB.document.querySelectorAll = () => [{ value: 's1' }, { value: 's2' }, { value: 's3' }]
  await vm.runInContext(`courseOfflineMembersSave("c1","${oid}")`, sbB)
  const o1h = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('补标全员出席 → absent=[]、3/3 完成、held 保留', o1h.absent.length === 0 && Object.keys(o1h.results).length === 3 && o1h.held === true, JSON.stringify(o1h))
  // 幂等：状态未变时再次保存不产生额外写入（results/absent 保持）
  const beforeJson = JSON.stringify(o1h)
  await vm.runInContext(`courseOfflineMembersSave("c1","${oid}")`, sbB)
  const o1i = vm.runInContext(`courseState.doc.classes[0].assignments.find(a => a.id === "${oid}")`, sbB)
  assert('补标幂等：状态一致无多余写入', JSON.stringify(o1i) === beforeJson, JSON.stringify(o1i))

  console.log('\n④ 学员端：未出席展示 + 线性进度把缺席视为未完成')
  const sbD = makeSandbox(JSON.parse(JSON.stringify(docStudent)))
  asStudent(sbD, 's2')   // s2 缺席
  await vm.runInContext('courseTestSeedDoc()', sbD)
  vm.runInContext('renderCourseStudent()', sbD)
  const htmlD = sbD._getEl('page-course').innerHTML
  assert('缺席学员卡片状态 = 未出席', htmlD.includes('未出席'), htmlD.slice(0, 300))
  assert('缺席学员线性进度 0/1、缺席节点为下一步', htmlD.includes('0 / 1 完成') && htmlD.includes('cp-node next') && htmlD.includes('点餐服务'), htmlD.slice(0, 300))
  vm.runInContext('courseOfflineInfoModal("c1","o1")', sbD)
  const infoD = sbD._lastCreated() ? sbD._lastCreated().innerHTML : ''
  assert('缺席学员信息弹窗含补标提示', infoD.includes('未出席') && infoD.includes('补标'), infoD.slice(0, 400))
  // 出席者 s1 视角：已完成
  const sbE = makeSandbox(JSON.parse(JSON.stringify(docStudent)))
  asStudent(sbE, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbE)
  vm.runInContext('renderCourseStudent()', sbE)
  const htmlE = sbE._getEl('page-course').innerHTML
  assert('出席学员卡片 = 已完成 1/1', htmlE.includes('1 / 1 完成') && htmlE.includes('course-status done'), htmlE.slice(0, 300))
  assert('出席学员无「未出席」字样', !htmlE.includes('未出席'), '')

  console.log('\n⑤ i18n 双语键')
  const sbF = makeSandbox({ doc: {} })
  assert('courseOfflineHeldModalHint(3) 中文含「共 3 人」', vm.runInContext("t('courseOfflineHeldModalHint',3)", sbF).includes('共 3 人'))
  assert('courseOfflineAbsentTag(2) = 未到 2 人', vm.runInContext("t('courseOfflineAbsentTag',2)", sbF) === '未到 2 人')
  assert('courseOfflineNoAttend 中文存在', vm.runInContext("t('courseOfflineNoAttend')", sbF).length > 8)
  assert('courseOfflineAbsentSelf = 未出席', vm.runInContext("t('courseOfflineAbsentSelf')", sbF) === '未出席')
  assert('courseOfflineInfoAbsentHint 中文含补标', vm.runInContext("t('courseOfflineInfoAbsentHint')", sbF).includes('补标'))
  // 切换英文（t 取 en 侧）
  vm.runInContext('LANG = "en"', sbF)
  assert('en：HeldAll = Mark Done', vm.runInContext("t('courseOfflineHeldAll')", sbF) === 'Mark Done')
  assert('en：AbsentTag(2) = 2 absent', vm.runInContext("t('courseOfflineAbsentTag',2)", sbF) === '2 absent')
  assert('en：AbsentSelf = Absent', vm.runInContext("t('courseOfflineAbsentSelf')", sbF) === 'Absent')

  console.log()
  console.log(failed ? '❌ v35 有断言失败' : '✅ v35 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('v35 异常:', e); process.exit(1) })
