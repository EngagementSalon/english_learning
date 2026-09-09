// ====== 测试：v30 三修复 ① 视频完成度卡 3% 不刷新（高位水线+播完记100%+低值自愈升级）
//      ② 草稿/作业保存后编辑弹窗可继续 AI 出题（文件生成并追加）
//      ③ 一次选择 2-3 个文件合并提取题目 ======
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

// 统一的 course 沙箱：加载 i18n → bank-data → store → qgen → course-app → app
// courseDocRef：可变的云端文档（mutate 真实改它，便于断言）
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
  // 测试种子：把 courseState.doc 填成云端文档（模块加载后 init 未完成时 doc 为 null，
  // 不能简单用 || { classes: [] }，否则会把真实班级覆盖成空）
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

// 构造两个可用的“伪文件”内容（QGen 可识别的出题模式）
const FILE_A = 'Greet the guest.\n向客人问候。\nbistro（小餐馆）\nfront desk（前台）\nchambermaid（客房服务员）'
const FILE_B = 'complimentary 免费赠送的\nreservation 预订\nhousekeeping 客房服务'

;(async () => {
  console.log('\n🧪 v30 修复回归测试\n\n① 视频完成度（卡 3% 修复：播完记 100% / 低值自愈升级 / 水位不倒退）')

  // ---- 纯函数：播完一律记 100%（防时长元数据异常记成 3%）----
  let p = vm.runInContext('courseVideoFinalPct({ ended: true, watchedSec: 120, duration: 4000 })', makeSandbox({ doc: {} }))
  assert('ended=true 即使时长 4000s 也只看了 120s → 记 100%', p === 100, String(p))

  // ---- 幂等 + 自愈升级规则 ----
  const sb1 = makeSandbox({ doc: {} })
  let allowed = vm.runInContext('courseVideoEntryAllowed(null, 100)', sb1)
  assert('无历史记录 → 允许写入', allowed === true)
  allowed = vm.runInContext('courseVideoEntryAllowed({ watchedPct: 3 }, 100)', sb1)
  assert('旧记录 3%（脏数据）→ 新 100% 允许覆盖刷新（自愈）', allowed === true)
  allowed = vm.runInContext('courseVideoEntryAllowed({ watchedPct: 100 }, 95)', sb1)
  assert('旧记录 100% → 新 95% 拒绝（不降级）', allowed === false)
  allowed = vm.runInContext('courseVideoEntryAllowed({ watchedPct: 3 }, 3)', sb1)
  assert('相同低值重复提交 → 拒绝（幂等）', allowed === false)
  allowed = vm.runInContext('courseVideoEntryAllowed({}, 100)', sb1)
  assert('无 watchedPct 的旧记录 → 视为 100% 拒绝（防重复写）', allowed === false)

  // ---- 端到端：学员“卡在 3%” → 重新看完并确认 → 云端记录升级为 100% ----
  const docRef = { doc: { v: 1, classes: [{ id: 'c1', name: '班', members: ['s1'], createdAt: 1,
    assignments: [{ id: 'v1', type: 'video', title: '视频一', desc: '', deadline: 0, videoUrl: 'https://x.mp4', createdAt: 1,
      results: { s1: { at: 1, watched: true, watchedPct: 3, watchedSec: 90, duration: 3000, difficulty: 3, attempts: 1 } } }] }] } }
  const sb2 = makeSandbox(docRef)
  const Store = vm.runInContext('Store', sb2)
  Store.getSession = () => ({ id: 1, username: 's1', name: '学员一' })
  Store.getUser = () => ({ name: '学员一', dept: '' })
  vm.runInContext('courseState.doc = courseState.doc || { classes: [] }', sb2)
  // 模拟：播放到结尾触发 ended 快照
  vm.runInContext('courseVideoSnap = { cid: "c1", aid: "v1", username: "s1", ended: true, watchedPct: 100, watchedSec: 3000, duration: 3000 }', sb2)
  const area = sb2._getEl('courseVideoConfirmArea')
  area.dataset.rate = '3'   // 打分 3 星
  await vm.runInContext('courseVideoSubmitRating("c1","v1","s1")', sb2)
  const r1 = docRef.doc.classes[0].assignments[0].results.s1
  assert('重看确认后完成度由 3% 自愈升级为 100%', r1 && r1.watchedPct === 100, JSON.stringify(r1))
  assert('升级时 attempts 累加为 2', r1 && r1.attempts === 2, String(r1 && r1.attempts))
  assert('难度打分保留', r1 && r1.difficulty === 3, String(r1 && r1.difficulty))
  // 再次同值提交 → 幂等拒绝，attempts 不变
  await vm.runInContext('courseVideoSubmitRating("c1","v1","s1")', sb2)
  const r2 = docRef.doc.classes[0].assignments[0].results.s1
  assert('同值重复确认被幂等拦截（attempts 仍为 2）', r2 && r2.attempts === 2, String(r2 && r2.attempts))

  // ---- 学员列表：3% 记录显示“请重看刷新”引导，不显示“已完成” ----
  const docRef3 = { doc: { v: 1, classes: [{ id: 'c1', name: '班', members: ['s1'], createdAt: 1,
    assignments: [
      { id: 'v1', type: 'video', title: '低进度视频', desc: '', deadline: 0, videoUrl: 'https://x.mp4', createdAt: 1, results: { s1: { at: 1, watched: true, watchedPct: 3, watchedSec: 90, duration: 3000, difficulty: 3, attempts: 1 } } },
      { id: 'v2', type: 'video', title: '已完成视频', desc: '', deadline: 0, videoUrl: 'https://y.mp4', createdAt: 2, results: { s1: { at: 2, watched: true, watchedPct: 100, watchedSec: 300, duration: 300, difficulty: 4, attempts: 1 } } },
    ] }] } }
  const sb3 = makeSandbox(docRef3)
  const Store3 = vm.runInContext('Store', sb3)
  Store3.getSession = () => ({ id: 1, username: 's1', name: '学员一' })
  Store3.getUser = () => ({ name: '学员一', dept: '' })
  await vm.runInContext('courseTestSeedDoc()', sb3)
  vm.runInContext('renderCourseStudent()', sb3)
  const listHtml3 = sb3._getEl('page-course').innerHTML
  const doneTagCount3 = (listHtml3.match(/course-status done/g) || []).length
  const donePhraseCount3 = (listHtml3.match(/已完成 ·/g) || []).length
  assert('3% 记录在列表不显示“已完成”', doneTagCount3 === 1 && donePhraseCount3 === 1, 'done=' + doneTagCount3 + ' phrase=' + donePhraseCount3)
  assert('3% 记录显示“已看 3% · 请重看并确认刷新”', listHtml3.includes('已看 3%'), listHtml3.slice(0, 500))
  assert('3% 记录按钮为“去观看”', listHtml3.includes('去观看'), '')
  assert('100% 记录仍显示“已完成”', listHtml3.includes('已完成 · 100%'), listHtml3.slice(0, 600))

  console.log('\n② 作业保存后编辑弹窗可继续 AI 出题')
  const docRef4 = { doc: { v: 1, classes: [{ id: 'c1', name: '餐饮班', members: ['s1'], createdAt: 1,
    assignments: [{ id: 'a1', type: 'homework', title: '已保存草稿', desc: '', deadline: 0, status: 'draft', createdAt: 1, questions: [{ type: 'judge', difficulty: 1, question: '判断1', options: ['正确', '错误'], answer: [0], explanation: '' }], results: {} }] }] } }
  const sb4 = makeSandbox(docRef4)
  const Store4 = vm.runInContext('Store', sb4)
  Store4.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store4.getUser = () => ({ name: '管理员', dept: '' })
  await vm.runInContext('courseTestSeedDoc()', sb4)
  // 打开草稿的编辑弹窗
  vm.runInContext('courseEditAssignModal("c1","a1")', sb4)
  const editHtml = sb4._lastCreated() ? sb4._lastCreated().innerHTML : ''
  assert('编辑弹窗含 AI 出题入口按钮', editHtml.includes('courseEditAiToggle') && editHtml.includes('AI 从文件生成并追加'), editHtml.slice(0, 200))
  assert('编辑弹窗含文件选择（多选 multiple）', editHtml.includes('id="ceAiFile"') && editHtml.includes('multiple'), '')
  assert('编辑弹窗含题型比例输入', editHtml.includes('id="ceAiPctSingle"') && editHtml.includes('ceAiPctJudge') && editHtml.includes('ceAiPctListen'), '')
  assert('编辑弹窗含“生成并追加”按钮', editHtml.includes('courseEditAiGen') && editHtml.includes('生成并追加题目'), '')
  // 选择 2 个文件并执行生成追加（其中带一个坏文件验证容错）
  const files4 = [
    { name: '文档A.md', text: async () => FILE_A },
    { name: '文档B.md', text: async () => FILE_B },
  ]
  sb4._getEl('ceAiFile').files = files4
  sb4._getEl('ceAiTotal').value = '20'
  sb4._getEl('ceAiPctSingle').value = '100'
  sb4._getEl('ceAiPctJudge').value = ''
  sb4._getEl('ceAiPctListen').value = ''
  await vm.runInContext('courseEditAiGen()', sb4)
  const statusTxt = sb4._getEl('ceAiStatus').textContent
  assert('状态提示“已追加 N 题”', /已追加 \d+ 题/.test(statusTxt), statusTxt)
  const qLen = vm.runInContext('courseEditAssign.questions.length', sb4)
  assert('AI 新题已追加到编辑列表（原 1 题 → 更多）', qLen > 1, 'len=' + qLen)
  // 追加的单选比例：全为 single 类型
  const types = vm.runInContext('courseEditAssign.questions.map(q => q.type)', sb4)
  assert('比例 100% 单选 → 追加题均为单选', types.slice(1).every(t => t === 'single'), JSON.stringify(types))
  // 再次执行 → 全部重复，跳过
  await vm.runInContext('courseEditAiGen()', sb4)
  const qLen2 = vm.runInContext('courseEditAssign.questions.length', sb4)
  const statusTxt2 = sb4._getEl('ceAiStatus').textContent
  assert('重复执行自动去重（题数不再增加）', qLen2 === qLen, 'before=' + qLen + ' after=' + qLen2)
  assert('重复执行提示“跳过重复题”', /跳过 \d+ 道重复题/.test(statusTxt2), statusTxt2)
  // 保存编辑（走真实 courseSaveAssignEdit：先给标题赋值，否则保存会因空标题被拦截）
  sb4._getEl('ceTitle').value = '已保存草稿'
  await vm.runInContext('courseSaveAssignEdit()', sb4)
  const savedA = docRef4.doc.classes[0].assignments[0]
  assert('保存后草稿题目数=编辑后题数', savedA.questions.length === qLen2, 'saved=' + savedA.questions.length)
  assert('草稿状态保留', savedA.status === 'draft', String(savedA.status))

  // 坏文件容错：2 个好文件 + 1 个不支持文件 → 仍正常出题且有提示
  // 保存后 courseEditAssign 已被置空 → 重新打开编辑弹窗再测
  const filesBad = [
    { name: '好.md', text: async () => FILE_A },
    { name: '坏.xyz', text: async () => 'whatever' },
  ]
  vm.runInContext('courseEditAssignModal("c1","a1")', sb4)
  const badBox = sb4._getEl('ceAiFile')
  badBox.files = filesBad
  vm.runInContext('courseEditAssign.questions = []', sb4)
  await vm.runInContext('courseEditAiGen()', sb4)
  const statusTxt3 = sb4._getEl('ceAiStatus').textContent
  assert('单个坏文件不阻断：其余文件正常追加', /已追加 \d+ 题/.test(statusTxt3), statusTxt3)
  assert('坏文件给出忽略提示', statusTxt3.includes('坏.xyz'), statusTxt3)

  console.log('\n③ 新建作业：一次选 2-3 个文件合并提取')
  const sb5 = makeSandbox(docRef4)
  const Store5 = vm.runInContext('Store', sb5)
  Store5.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store5.getUser = () => ({ name: '管理员', dept: '' })
  await vm.runInContext('courseTestSeedDoc()', sb5)
  // 打开新建作业弹窗 → 文件模式
  vm.runInContext('courseCreateAssignModal("c1")', sb5)
  const createHtml = sb5._lastCreated() ? sb5._lastCreated().innerHTML : ''
  assert('新建弹窗文件输入支持多选 multiple', createHtml.includes('id="caFile"') && createHtml.includes('multiple'), '')
  assert('新建弹窗含多文件提示', createHtml.includes('可一次选择多个文件'), '')
  // 选择 3 个文件，触发 courseDraftFileChange → courseDraftGenFile
  const three = [
    { name: '课件一.md', text: async () => FILE_A },
    { name: '课件二.md', text: async () => FILE_B },
    { name: '课件三.txt', text: async () => 'VIP guest（VIP 客人）\nWelcome back.\n欢迎再次光临。' },
  ]
  sb5._getEl('caFile').files = three
  vm.runInContext('courseDraftFileChange(document.getElementById("caFile"))', sb5)
  const filesInDraft = vm.runInContext('courseDraft.files.length', sb5)
  assert('courseDraft.files 记录了 3 个文件', filesInDraft === 3, 'n=' + filesInDraft)
  sb5._getEl('caGenTotal').value = '30'
  sb5._getEl('caPctSingle').value = ''
  sb5._getEl('caPctJudge').value = ''
  sb5._getEl('caPctListen').value = ''
  await vm.runInContext('courseDraftGenFile()', sb5)
  const previewN = vm.runInContext('(courseDraft.preview || []).length', sb5)
  assert('3 个文件合并后成功生成题目预览', previewN > 0, 'n=' + previewN)
  const previewHtml = sb5._getEl('caPreview').innerHTML
  assert('预览区渲染（含已选计数）', previewHtml.includes('已选') && previewHtml.includes('题'), previewHtml.slice(0, 200))
  const qStem3 = vm.runInContext('courseDraft.preview.map(x => x.q.question).join("|")', sb5)
  assert('内容来自多个文件（含第三个文件的 VIP 客人）', qStem3.includes('VIP'), qStem3.slice(0, 300))

  // ---- 多文件合并纯函数：部分失败提示 + 内容合并 ----
  const merged = await vm.runInContext('courseMergeFileTexts([{ name: "A.md", text: async () => "hi（你好）" }, { name: "B.md", text: async () => "bye（再见）" }])', makeSandbox({ doc: {} }))
  assert('两文件文本合并且标注文件名', merged.text.includes('【A.md】') && merged.text.includes('【B.md】') && merged.text.includes('你好') && merged.text.includes('再见'), merged.text)
  assert('合并无解析错误', merged.errs.length === 0, JSON.stringify(merged.errs))

  console.log('\n' + (failed ? '❌ 有失败项' : '✅ 全部通过'))
  process.exit(failed ? 1 : 0)
})()
