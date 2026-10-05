// ====== test-v145：新建作业 / 测评弹窗支持「所属章节」 ======
// 需求（用户原话）：「为什么线下课一定要生成作业了再分章节 创造的时候就生成不好吗」
//   → 新建作业/测评时即可直接归入章节，不必「先发布 → 再进编辑弹窗 / 批量分章」补填。
// 背景：v131 已给「新增线下课」弹窗（#coChapter）加了章节字段，但 courseCreateAssignModal
//   一直没跟上（历史漏改：v129 的章节体系落在编辑弹窗 + 列表分块上）。
// 语义（与 v131 一致）：留空 = 不归章节 → **不写 chapter 字段**（不是写空串，保持数据干净）。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) console.log('  ✓', name)
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

const COURSE = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')

// ============ A. 源码接线（定义了 ≠ 被模板真调用） ============
console.log('\n🧪 A. 源码接线：弹窗含章节字段 + 提交真的读它')

const createFn = (() => {
  const i = COURSE.indexOf('function courseCreateAssignModal(')
  if (i < 0) return ''
  const j = COURSE.indexOf('\nfunction courseDraftTypeChange(', i)
  return COURSE.slice(i, j > 0 ? j : i + 4000)
})()
assert('A0 切片锚点存在（新建弹窗函数体非空）', createFn.length > 500, 'len=' + createFn.length)
assert('A1 新建弹窗含 #caChapter 输入框', createFn.includes('id="caChapter"'))
assert('A2 含 datalist #caChapterList（复用本班已有章节名，防打错字变成两个章）',
  createFn.includes('id="caChapterList"'))
assert('A3 候选由 courseChapterOptionsHtml(cid) 提供（不是新造一份）',
  createFn.includes('${courseChapterOptionsHtml(cid)}'))
assert('A4 复用已有 i18n 键（未另造新键）',
  createFn.includes("t('courseChapterLabel')") && createFn.includes("t('courseChapterPh')"))

const submitFn = (() => {
  const i = COURSE.indexOf('async function courseSubmitAssign(')
  if (i < 0) return ''
  const j = COURSE.indexOf('// ================================================================', i)
  return COURSE.slice(i, j > 0 ? j : i + 3000)
})()
assert('A5 切片锚点存在（courseSubmitAssign 函数体非空）', submitFn.length > 500, 'len=' + submitFn.length)
assert('A6 提交时从 #caChapter 取值', submitFn.includes("getElementById('caChapter')"))
// 注意：定义是 `const withChapter = obj =>`（等号后没有括号），故 split('withChapter(') 只数调用处
assert('A7 章节包装器已定义', submitFn.includes('const withChapter = '))
assert('A7b video 分支与普通分支两处 commit 都经 withChapter 调用包装',
  (submitFn.split('withChapter(').length - 1) === 2,
  'n=' + (submitFn.split('withChapter(').length - 1))
assert('A8 不存在未包装的 commit 调用（防漏包 → 视频作业丢章节）',
  !/commit\(CourseStore\.newId\('a'\), (?!withChapter)/.test(submitFn))
assert('A9 courseDraft 初始化声明了 chapter 字段',
  COURSE.includes("fileName: '', quiz: [], chapter: ''"))

const offFn = (() => {
  const i = COURSE.indexOf('function courseCreateOfflineModal(')
  if (i < 0) return ''
  const j = COURSE.indexOf('\nasync function courseCreateOffline(', i)
  return COURSE.slice(i, j > 0 ? j : i + 2000)
})()
assert('A10 [对照] 线下课弹窗的 #coChapter 仍在（本次没顺手改坏）', offFn.includes('id="coChapter"'))

// ============ 沙箱 ============
const elements = {}
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '',
    title: '', placeholder: '', value: '', readOnly: false, checked: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
const getEl = id => elements[id] || (elements[id] = mkEl())

getEl('caType').value = 'homework'
getEl('caTitle').value = ''
getEl('caDesc').value = ''
getEl('caDeadline').value = ''
getEl('caDuration').value = '20'
getEl('caPass').value = '60'
getEl('caVideoUrl').value = ''
getEl('caChapter').value = ''

const courseDoc = {
  v: 1, classes: [
    {
      id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1', 'admin'],
      assignments: [
        {
          id: 'a1', type: 'homework', title: '已有作业A', desc: '', deadline: 0, duration: 0, passScore: 60,
          chapter: '第一章 迎宾礼仪', createdAt: 1,
          questions: [{ type: 'single', difficulty: 1, question: 'Q1?', options: ['A', 'B'], answer: [0], explanation: '' }], results: {}
        },
      ]
    },
  ]
}

let alertMsg = null
const sandbox = {
  localStorage: {
    store: {},
    getItem(k) { return this.store[k] || null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  },
  console,
  window: {
    addEventListener() {}, scrollTo() {},
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function () {},
    dispatchEvent() {}, CustomEvent: function () {},
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
  alert(m) { alertMsg = String(m) }, confirm() { return true }, prompt() { return null },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, RegExp, Set, Map, Promise,
  CloudSync: {
    status: 'online', onStatus() {}, enqueue() {},
    recalcCloudPlacementLevels: async () => ({}),
    getDashboardData: async () => ([]),
    flushDuration() {},
  },
  CourseStore: {
    status: 'online',
    newId: (p) => p + '_' + Math.random().toString(36).slice(2, 8) + '_t',
    findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
    findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
    getDoc: async () => JSON.parse(JSON.stringify(courseDoc)),
    mutate: async (fn) => { fn(courseDoc); return true },
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8'), sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)

const Store = vm.runInContext('Store', sandbox)
if (!Store) { console.error('Store missing!'); process.exit(1) }

// 提交一次（真跑 courseSubmitAssign），返回新写入的那条作业
async function submit(opts) {
  const o = opts || {}
  getEl('caType').value = o.type || 'homework'
  getEl('caTitle').value = o.title || 'X'
  getEl('caChapter').value = o.chapter == null ? '' : o.chapter
  getEl('caVideoUrl').value = o.videoUrl || ''
  alertMsg = null
  const before = courseDoc.classes[0].assignments.length
  const given = { cid: 'c1', mode: 'bank', chapter: '', quiz: [] }
  if (o.type === 'video') {
    given.preview = []
  } else {
    given.preview = [{ checked: true, q: { type: 'single', difficulty: 1, question: 'Qn?', options: ['甲', '乙'], answer: [0], explanation: '' } }]
  }
  await vm.runInContext(`
    (async () => {
      courseDraft = ${JSON.stringify(given)}
      await courseSubmitAssign(${JSON.stringify(o.status || 'open')})
    })()
  `, sandbox)
  await new Promise(r => setTimeout(r, 10))
  const list = courseDoc.classes[0].assignments
  return { rec: list.length > before ? list[list.length - 1] : null, added: list.length - before, alert: alertMsg }
}

;(async () => {
  // ============ B. 沙箱真跑：章节真的落到作业数据上 ============
  console.log('\n🧪 B. 沙箱真跑：提交后章节落到作业数据上')

  const r1 = await submit({ title: 'B1作业', chapter: '第一章 迎宾礼仪' })
  assert('B1 填了章节 → 写入作业（值逐字正确）',
    r1.rec && r1.rec.chapter === '第一章 迎宾礼仪', JSON.stringify(r1.rec && r1.rec.chapter))

  const r2 = await submit({ title: 'B2作业', chapter: '' })
  assert('B2 留空 → 作业上【不存在】chapter 字段（不是空串，也不是 undefined 值）',
    r2.rec && !('chapter' in r2.rec), 'keys=' + JSON.stringify(Object.keys(r2.rec || {})))

  const r3 = await submit({ title: 'B3作业', chapter: '   ' })
  assert('B3 纯空格 → trim 后同样不写字段', r3.rec && !('chapter' in r3.rec))

  const r4 = await submit({ title: 'B4作业', chapter: '  第二章 客房服务  ' })
  assert('B4 首尾空格已 trim', r4.rec && r4.rec.chapter === '第二章 客房服务',
    JSON.stringify(r4.rec && r4.rec.chapter))

  const r5 = await submit({ title: 'B5草稿', chapter: '第三章 餐饮', status: 'draft' })
  assert('B5 存草稿也保留章节 + status=draft',
    r5.rec && r5.rec.chapter === '第三章 餐饮' && r5.rec.status === 'draft',
    JSON.stringify(r5.rec && { c: r5.rec.chapter, s: r5.rec.status }))

  const r6 = await submit({ title: 'B6视频', type: 'video', videoUrl: 'https://x/y.mp4', chapter: '第四章 视频课' })
  assert('B6 video 分支同样写入章节（证明两处 commit 都包到了）',
    r6.rec && r6.rec.type === 'video' && r6.rec.chapter === '第四章 视频课',
    JSON.stringify(r6.rec && { t: r6.rec.type, c: r6.rec.chapter }))

  assert('B7 既有字段未受影响（type/title/passScore/questions/deadline）',
    r1.rec && r1.rec.type === 'homework' && r1.rec.title === 'B1作业' && r1.rec.passScore === 60
    && Array.isArray(r1.rec.questions) && r1.rec.questions.length === 1 && r1.rec.deadline === 0,
    JSON.stringify(r1.rec && { t: r1.rec.type, n: (r1.rec.questions || []).length }))
  assert('B8 每次提交恰好新增 1 条（幂等/未重复）', r1.added === 1 && r6.added === 1,
    r1.added + '/' + r6.added)

  // 候选清单来自本班已有章节（打错字就会变成两个章 → 候选是防错的主要手段）
  const opts = vm.runInContext("courseChapterOptionsHtml('c1')", sandbox)
  assert('B9 章节候选含本班既有章节名（第一章 迎宾礼仪）',
    opts.includes('value="第一章 迎宾礼仪"'), opts.slice(0, 120))
  assert('B10 章节候选含刚新建作业写入的章节名（第四章 视频课）',
    opts.includes('value="第四章 视频课"'), opts.slice(0, 200))

  // ---- 端到端：管理列表按章节分块显示 ----
  console.log('\n🧪 C. 端到端：管理班级列表按章节分块渲染')
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  vm.runInContext('courseState.adminView = true; courseState.view = "list"', sandbox)
  await vm.runInContext('courseOpenClass("c1")', sandbox)
  await new Promise(r => setTimeout(r, 20))
  const html = getEl('page-course').innerHTML
  assert('C0 渲染产物非空（锚点有效）', html.length > 500, 'len=' + html.length)
  assert('C1 出现章节分隔行容器 chapter-sep-name', html.includes('chapter-sep-name'))
  assert('C2 新建时填的章节名出现在章节分隔行上（端到端贯通）', html.includes('第四章 视频课'))
  assert('C3 未归章节的作业仍走「不归章节」散项行（未被打上章节）',
    html.includes('chapter-sep-plain'))

  // ============ D. i18n：复用的章节键中英成对且类型一致 ============
  console.log('\n🧪 D. i18n：复用的章节键中英成对')
  const I18N = vm.runInContext('I18N', sandbox)
  const keys = ['courseChapterLabel', 'courseChapterPh', 'courseChapterHint']
  keys.forEach(k => {
    const zh = I18N.zh[k], en = I18N.en[k]
    assert('D ' + k + '：zh/en 都有且类型一致',
      zh != null && en != null && typeof zh === typeof en,
      'zh=' + typeof zh + ' en=' + typeof en)
  })

  // ============ E. 版本号（弹性断言：随发版递增，别写死） ============
  console.log('\n🧪 E. 版本号')
  const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('E1 版本号统一：唯一值 × 12 处',
    vms.length === 12 && uniq.length === 1, 'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('E2 版本号 >= 145（本套件所属版本）', uniq.length === 1 && uniq[0] >= 145, JSON.stringify(uniq))

  console.log('\n' + (failed ? '❌ 部分测试失败' : '✅ 所有测试通过'))
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(2) })
