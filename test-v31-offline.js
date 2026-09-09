// ====== 测试：v31 线下课模块 ======
// ① 管理员在班级内新建「线下课」（题库 11 大主题选择 / 自定义主题 + 上课时间）
// ② 真正下课后「一键全员完成」/ 撤销 / 成员逐个补标
// ③ 学员端线下课卡片 + 「我的线性学习进度」（任务节点路径 + 进度条 + 下一步引导）
// ④ 数据看板：offline 计入完成、不计入均分、矩阵 ✓ 完成
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
      store: { 'eq_course_only_v43': '1' },   /* v43 清空与本测试无关，预置 flag 跳过 */
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

// 学员 doc：h1 作业（s1 已做 80 分）+ o1 线下课未下课 + o2 线下课已下课全员标（s1/s2）
const docLearner = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1', 's2'],
  assignments: [
    { id: 'h1', type: 'homework', title: '第一课作业', desc: '', deadline: 0, createdAt: 1, questions: [{ type: 'single', difficulty: 1, question: 'Q', options: ['A', 'B'], answer: [0], explanation: '' }], results: { s1: { at: 1, score: 80, correct: 1, total: 1, usedSec: 10, attempts: 1 } } },
    { id: 'o1', type: 'offline', title: '点餐服务', topicId: 3, custom: false, desc: '三楼培训室', date: 0, createdAt: 2, held: false, heldAt: 0, results: {} },
    { id: 'o2', type: 'offline', title: '宾客抵达与接待', topicId: 1, custom: false, desc: '', date: 0, createdAt: 3, held: true, heldAt: 5, results: { s1: { done: true, at: 5, by: 'admin' }, s2: { done: true, at: 5, by: 'admin' } } },
  ] }] } }

;(async () => {
  console.log('\n🧪 v31 线下课模块回归测试\n')

  console.log('① 纯函数：线下课判定 / 任务完成判定 / 图标')
  const sbA = makeSandbox({ doc: {} })
  assert('courseIsOffline 仅认 type=offline', vm.runInContext('courseIsOffline({ type: "offline" })', sbA) === true && vm.runInContext('courseIsOffline({ type: "video" })', sbA) === false)
  assert('offline 完成判定：done=true → 完成', vm.runInContext('courseTaskDone({ type: "offline" }, { done: true })', sbA) === true)
  assert('offline 无记录 / done=false → 未完成', vm.runInContext('courseTaskDone({ type: "offline" }, null)', sbA) === false && vm.runInContext('courseTaskDone({ type: "offline" }, { done: false })', sbA) === false)
  assert('homework 有记录 → 完成；video 3% → 未完成', vm.runInContext('courseTaskDone({ type: "homework" }, { score: 60 })', sbA) === true && vm.runInContext('courseTaskDone({ type: "video" }, { watchedPct: 3 })', sbA) === false)
  assert('视频 ≥90% → 完成', vm.runInContext('courseTaskDone({ type: "video" }, { watchedPct: 100 })', sbA) === true)
  assert('courseTaskIcon：offline=📅 / video=🎬 / exam=🧪 / 其它=📝',
    vm.runInContext('courseTaskIcon({ type: "offline" }) + courseTaskIcon({ type: "video" }) + courseTaskIcon({ type: "exam" }) + courseTaskIcon({})', sbA) === '📅🎬🧪📝')

  console.log('\n② 学员端：线下课卡片 + 我的线性学习进度')
  const sbB = makeSandbox(JSON.parse(JSON.stringify(docLearner)))
  asStudent(sbB, 's1')
  await vm.runInContext('courseTestSeedDoc()', sbB)
  vm.runInContext('renderCourseStudent()', sbB)
  const html = sbB._getEl('page-course').innerHTML
  assert('页面含「我的学习进度」区块', html.includes('我的学习进度'), html.slice(0, 200))
  assert('进度统计 = 2 / 3 完成', html.includes('2 / 3 完成'), '')
  assert('进度条宽度 67%', html.includes('width:67%'), '')
  assert('含任务节点路径（cp-path）', html.includes('cp-path') && html.includes('cp-conn'), '')
  assert('未完成的线下课节点标记为下一步（cp-node next）', html.includes('cp-node next'), '')
  assert('下一步引导含「点餐服务」', html.includes('下一步') && html.includes('点餐服务'), '')
  // 卡片区域
  assert('线下课卡片含徽标与类型名', html.includes('course-type offline') && html.includes('📅 线下课'), '')
  assert('未下课卡片状态 = 待上课（o1）', html.includes('待上课'), '')
  assert('已标注卡片显示 已完成 + 标注人（o2）', html.includes('已完成') && html.includes('由 管理员 标注'), '')
  assert('线下课卡片操作为「查看」', html.includes('courseOfflineView') || html.includes('>查看<'), '')
  // 点击线下课 → 信息弹窗（非作答）
  vm.runInContext('courseStart("c1","o1")', sbB)
  const info1 = sbB._lastCreated() ? sbB._lastCreated().innerHTML : ''
  assert('o1 信息弹窗：含线下课信息 / 上课时间 / 待上课 / 线下培训提示',
    info1.includes('线下课信息') && info1.includes('上课时间') && info1.includes('待上课') && info1.includes('线下培训课'), info1.slice(0, 300))
  vm.runInContext('courseStart("c1","o2")', sbB)
  const info2 = sbB._lastCreated() ? sbB._lastCreated().innerHTML : ''
  assert('o2 信息弹窗：显示已完成与标注人', info2.includes('已完成') && info2.includes('由 管理员 标注'), info2.slice(0, 300))

  console.log('\n③ 管理端：新增线下课（题库主题选择 + 自定义）/ 一键全员完成 / 成员标注 / 编辑')
  const sbC = makeSandbox({ doc: { v: 1, classes: [{ id: 'c1', name: '餐饮英语班', members: ['s1', 's2'], assignments: [
    { id: 'o0', type: 'offline', title: '宾客抵达与接待', topicId: 1, custom: false, desc: '', date: 0, createdAt: 1, held: false, heldAt: 0, results: {} },
  ] }] } })
  asAdmin(sbC)
  await vm.runInContext('courseTestSeedDoc()', sbC)
  // 新建弹窗
  vm.runInContext('courseCreateOfflineModal("c1")', sbC)
  const modalHtml = sbC._lastCreated() ? sbC._lastCreated().innerHTML : ''
  assert('新增弹窗含主题下拉（题库 11 大主题 + 自定义）',
    modalHtml.includes('id="coTopic"') && modalHtml.includes('宾客抵达与接待') && modalHtml.includes('自定义主题'), modalHtml.slice(0, 200))
  assert('新增弹窗含上课时间与备注输入', modalHtml.includes('id="coDate"') && modalHtml.includes('id="coDesc"'), '')
  // 创建：选题库主题 3（点餐服务）
  sbC._getEl('coTopic').value = '3'
  sbC._getEl('coTopic').selectedOptions = [{ text: '点餐服务' }]
  sbC._getEl('coDate').value = '2026-09-05T14:00'
  sbC._getEl('coDesc').value = '三楼培训室'
  await vm.runInContext('courseCreateOffline("c1")', sbC)
  let offs = vm.runInContext('(courseState.doc.classes[0].assignments || []).filter(a => a.type === "offline")', sbC)
  assert('创建后 assignment 数 +1（2 个线下课）', offs.length === 2, 'n=' + offs.length)
  const o1 = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.type === "offline" && a.title === "点餐服务")', sbC)
  assert('主题名/题库分类 id 正确（点餐服务 / topicId 3）', o1 && o1.topicId === 3 && o1.custom === false && o1.title === '点餐服务', JSON.stringify(o1))
  assert('上课时间与备注入库', o1 && o1.date === new Date('2026-09-05T14:00').getTime() && o1.desc === '三楼培训室', JSON.stringify(o1 && { date: o1.date, desc: o1.desc }))
  assert('初始未下课（held=false, results 空）', o1 && o1.held === false && Object.keys(o1.results).length === 0, '')
  // 创建：自定义主题
  sbC._getEl('coTopic').value = '__custom'
  sbC._getEl('coTopicCustom').value = '葡萄酒品鉴'
  sbC._getEl('coDate').value = ''
  sbC._getEl('coDesc').value = ''
  await vm.runInContext('courseCreateOffline("c1")', sbC)
  const oC = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.type === "offline" && a.custom === true)', sbC)
  assert('自定义主题创建成功（custom=true, topicId=0, 标题=葡萄酒品鉴）', oC && oC.custom === true && oC.topicId === 0 && oC.title === '葡萄酒品鉴', JSON.stringify(oC))
  assert('空主题被拦截（alert 提示选择主题）', (() => { sbC._getEl('coTopic').value = ''; vm.runInContext('courseCreateOffline("c1")', sbC); return (sbC._lastAlert || '').includes('请选择或输入培训主题') })())
  // 标注完成（默认无缺席 → 全员完成）
  await vm.runInContext('courseHeldSave("c1","' + o1.id + '")', sbC)
  const o1b = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.id === "' + o1.id + '")', sbC)
  assert('一键后 held=true 且全员 done（by admin）', o1b && o1b.held === true && o1b.results.s1.done === true && o1b.results.s2.done === true && o1b.results.s1.by === 'admin', JSON.stringify(o1b && o1b.results))
  const atBefore = o1b ? o1b.results.s1.at : 0
  await vm.runInContext('courseHeldSave("c1","' + o1.id + '")', sbC)
  const o1c = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.id === "' + o1.id + '")', sbC)
  assert('重复一键被拦截（已标注提示，数据不变）', o1c && o1c.results.s1.at === atBefore && (sbC._lastAlert || '').includes('已完成全员标注'), 'alert=' + sbC._lastAlert)
  // 成员标注弹窗：s1 取消，s2 保留
  vm.runInContext('courseOfflineMembers("c1","' + o1.id + '")', sbC)
  const memHtml = sbC._lastCreated() ? sbC._lastCreated().innerHTML : ''
  assert('成员弹窗含出席标注标题与两个勾选项', memHtml.includes('出席标注') && (memHtml.match(/name="coM"/g) || []).length === 2, memHtml.slice(0, 300))
  sbC.document.querySelectorAll = () => [{ value: 's2' }]   // 只勾 s2
  await vm.runInContext('courseOfflineMembersSave("c1","' + o1.id + '")', sbC)
  const o1d = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.id === "' + o1.id + '")', sbC)
  assert('补标保存：s1 被取消、s2 保留 done', o1d && !o1d.results.s1 && o1d.results.s2.done === true, JSON.stringify(o1d && o1d.results))
  sbC.document.querySelectorAll = () => []   // 全取消
  await vm.runInContext('courseOfflineMembersSave("c1","' + o1.id + '")', sbC)
  const o1e = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.id === "' + o1.id + '")', sbC)
  assert('全取消后 results 清空且 held=false', o1e && Object.keys(o1e.results).length === 0 && o1e.held === false, JSON.stringify(o1e))
  // 撤销标注（对 o0：先一键再撤销）
  await vm.runInContext('courseHeldSave("c1","o0")', sbC)
  await vm.runInContext('courseUnheldAll("c1","o0")', sbC)
  const o0b = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.id === "o0")', sbC)
  assert('撤销标注后 held=false 且全员记录清空', o0b && o0b.held === false && Object.keys(o0b.results).length === 0, JSON.stringify(o0b))
  // 编辑线下课（改主题为分类 5）
  vm.runInContext('courseEditOfflineModal("c1","' + o1.id + '")', sbC)
  const editHtml = sbC._lastCreated() ? sbC._lastCreated().innerHTML : ''
  assert('编辑弹窗含主题/时间/备注且当前自定义高亮', editHtml.includes('id="ceTopic"') && editHtml.includes('value="__custom"'), editHtml.slice(0, 200))
  sbC._getEl('ceTopic').value = '5'
  sbC._getEl('ceTopic').selectedOptions = [{ text: '会员礼遇与庆祝' }]
  await vm.runInContext('courseEditOffline("c1","' + o1.id + '")', sbC)
  const o1f = vm.runInContext('courseState.doc.classes[0].assignments.find(a => a.id === "' + o1.id + '")', sbC)
  assert('编辑后主题更新为「会员礼遇与庆祝」', o1f && o1f.title === '会员礼遇与庆祝' && o1f.topicId === 5, JSON.stringify(o1f && { title: o1f.title, topicId: o1f.topicId }))
  // 班级列表行 HTML（offline 行独立渲染）
  const rowHtml = vm.runInContext('courseOfflineAdminRow(courseFind("c1"), courseState.doc.classes[0].assignments.find(a => a.id === "' + o1f.id + '"))', sbC)
  assert('行含 📅 主题 / 标注完成弹窗 / 成员 / 编辑 / 删除', rowHtml.includes('📅 会员礼遇与庆祝') && rowHtml.includes('courseHeldModal') && rowHtml.includes('标注完成') && rowHtml.includes('courseOfflineMembers') && rowHtml.includes('courseEditOfflineModal') && rowHtml.includes('courseDeleteAssign'), rowHtml.slice(0, 300))
  await vm.runInContext('courseHeldSave("c1","' + o1f.id + '")', sbC)
  const rowHeld = vm.runInContext('courseOfflineAdminRow(courseFind("c1"), courseState.doc.classes[0].assignments.find(a => a.id === "' + o1f.id + '"))', sbC)
  assert('已下课行：2/2 完成 + 已下课标签 + 撤销按钮', rowHeld.includes('2/2') && rowHeld.includes('已下课·全员完成') && rowHeld.includes('courseUnheldAll'), rowHeld.slice(0, 300))

  console.log('\n④ 数据看板兼容（offline 计入完成、不计均分、矩阵 ✓）')
  const sbD = makeSandbox(JSON.parse(JSON.stringify(docLearner)))
  asAdmin(sbD)
  await vm.runInContext('courseTestSeedDoc()', sbD)
  // app.js 主看板纯函数
  const sum = vm.runInContext('_courseSummary(courseState.doc)', sbD)
  assert('_courseSummary：completion 按含 offline 任务口径（3/(2×3)=50%）', sum.completion === 50, JSON.stringify(sum))
  assert('_courseSummary：avgScore 不含 offline 的 0 分（=80）', sum.avgScore === 80, 'avg=' + sum.avgScore)
  const cs = vm.runInContext('_courseStatsForUser(courseState.doc, "s1")', sbD)
  assert('_courseStatsForUser：s1 done 2/3、avg 80（offline 不进均分）', cs.done === 2 && cs.total === 3 && cs.avg === 80, JSON.stringify(cs))
  const matrixHtml = vm.runInContext('_courseMatrices(courseState.doc, { s1: { name: "学员一", dept: "饮食部" }, s2: { name: "学员二", dept: "" } })', sbD)
  assert('看板矩阵列头含 📅 线下课标题', matrixHtml.includes('📅 点餐服务') && matrixHtml.includes('📅 宾客抵达与接待'), matrixHtml.slice(0, 200))
  assert('看板矩阵：o2 完成格 = ✓ 已完成；作业格 = 80分', matrixHtml.includes('✓ 已完成') && matrixHtml.includes('80分'), matrixHtml.slice(0, 600))
  // renderCourseDashboard（course-app 内看板）
  await vm.runInContext('renderCourseDashboard()', sbD)
  const dashHtml = sbD._getEl('page-course').innerHTML
  assert('班级看板含线下课列头与完成格', dashHtml.includes('📅 宾客抵达与接待') && dashHtml.includes('✓ 已完成'), dashHtml.slice(0, 400))
  assert('班级看板均分未被 offline 0 分污染（80分）', dashHtml.includes('80分'), dashHtml.slice(0, 600))

  console.log('\n' + (failed ? '❌ 有失败项' : '✅ 全部通过'))
  process.exit(failed ? 1 : 0)
})()
