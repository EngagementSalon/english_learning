// ====== 测试 v55：作业/测评「上传现成题目文件」来源 ======
// ① impParseText 解析用户模板 CSV（BOM/表头/引号转义/逗号内嵌）→ 标准化导入条目
// ② courseImpQToAssign 条目 → 作业题目：剔除空白选项 + 答案索引重映射、难度 L1-L4、解析保留
// ③ 中空选项重映射（多选题中间缺一项）、判断题、无难度列（规则预估兜底）、非法行报错
// ④ 表头/示例行跳过；多行混合
// ⑤ 新建作业弹窗渲染第三来源：radio value=imp + caImportBox + importPreview；模式切换显隐
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}
function sliceBetween(s, a, b) {
  const i = s.indexOf(a)
  if (i < 0) return ''
  const j = s.indexOf(b, i + a.length)
  return j < 0 ? '' : s.slice(i, j)
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false, checked: false,
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
      store: { eq_bank_version: '999', eq_course_only_v43: '1' },
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
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
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
      enqueuePending: op => { (sandbox._pending = sandbox._pending || []).push(op); return true },
      pendingCount: () => 0,
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
  return sandbox
}

// —— 用户模板的真实样式（UTF-8 BOM + 表头行；题干含英文双引号转义与逗号）——
const HEAD = '\ufeff题型,题干,选项A,选项B,选项C,选项D,选项E,选项F,正确答案,解析,难度(L1-L4 选填)'
const R1 = '单选题,"In the dialog, the waiter says: ""I will take care of you today."" What does ""take care of"" mean?",To look after or handle,To ignore,To cook for,To pay for,,,A,在餐厅服务中，“take care of someone” 意为照顾、服务客人。,L1'
const R2 = '单选题,"If a guest has celiac disease, what can they NOT eat according to the dialog?",Gluten,Lactose,Shellfish,Eggs,,,A,对话明确说：“People with celiac cannot eat gluten.”。,L2'
const MULTI = '多选题,"Which drinks are on the menu?",Coffee,Tea,,Juice,Water,,BD,多选示例：B 与 D。 ,L2'
const JUDGE = '判断题,"Water freezes at 0 degrees.",正确,错误,,,,,A,判断题解析。 ,L1'
const NO_DIFF = '单选题,"What does ""wish"" mean here?",To hope,To ask,To order,To leave,,,A,难度留空 → 自动判定。'
const BAD_ROW = '单选题,Only one option here,Only,,,,A,,,L1'

;(async () => {
  console.log('\n🧪 v55 作业「上传现成题目文件」测试\n')
  const sb = makeSandbox({ doc: { v: 1, classes: [] } })
  const run = expr => vm.runInContext(expr, sb)
  run('Store.init()')

  console.log('① 解析用户模板 CSV（BOM / 表头 / 引号转义 / 内嵌逗号）')
  const rows = run(`impParseText(${JSON.stringify([HEAD, R1, R2].join('\n'))})`)
  assert('解析出 2 行（表头已丢弃）', rows.length === 2 && rows.every(r => r.ok), JSON.stringify(rows))
  assert('题型归一 single / difficulty L1→1', rows[0].q.type === 'single' && rows[0].q.difficulty === 1)
  assert('内嵌引号已还原（"" → "）', rows[0].q.question.includes('says: "I will take care of you today."'), rows[0].q.question)
  assert('答案字母 → 索引 [0]', rows[0].q.answer[0] === 0, JSON.stringify(rows[0].q.answer))
  assert('解析保留、E/F 空位为占位空串', rows[0].q.options.length === 6 && rows[0].q.options[4] === '' && rows[0].q.options[5] === '')
  assert('第二行 L2 → difficulty 2', rows[1].q.difficulty === 2)
  assert('中文解析文本保留', rows[0].q.explanation.indexOf('take care of someone') >= 0)

  console.log('\n② 条目 → 作业题目（courseImpQToAssign：剔空选项 + 答案重映射）')
  const a1 = run(`courseImpQToAssign(${JSON.stringify(rows[0])})`)
  assert('选项裁剪为 4 个非空文本', a1.options.length === 4 && a1.options.every(o => o.trim() !== ''), JSON.stringify(a1.options))
  assert('答案索引仍为 [0]', a1.answer[0] === 0 && a1.answer.length === 1, JSON.stringify(a1.answer))
  assert('难度保留 L1=1', a1.difficulty === 1)
  assert('字段齐备（作业题目 schema）', a1.type === 'single' && a1.question && a1.explanation && typeof a1.explanation === 'string')
  const a2 = run(`courseImpQToAssign(${JSON.stringify(rows[1])})`)
  assert('第二题 difficulty=2 / 题干与答案正确', a2.difficulty === 2 && a2.question.indexOf('celiac') >= 0 && a2.answer[0] === 0)

  console.log('\n③ 中空选项 / 判断题 / 无难度列 / 非法行')
  const mrow = run(`impParseText(${JSON.stringify([HEAD, MULTI].join('\n'))})`)[0]
  assert('多选题解析 ok（A-F 含中空 C 列）', mrow.ok === true && mrow.q.type === 'multiple')
  const mq = run(`courseImpQToAssign(${JSON.stringify(mrow)})`)
  assert('中空选项剔除 → [Coffee,Tea,Juice,Water]', mq.options.length === 4 && mq.options.join('|') === 'Coffee|Tea|Juice|Water', JSON.stringify(mq.options))
  assert('答案 BD（原 idx 1,3）重映射为 [1,2]', JSON.stringify(mq.answer) === '[1,2]', JSON.stringify(mq.answer))
  const jrow = run(`impParseText(${JSON.stringify([HEAD, JUDGE].join('\n'))})`)[0]
  assert('判断题解析 ok / 答案 A→[0]', jrow.ok && jrow.q.type === 'judge' && jrow.q.answer[0] === 0)
  const jq = run(`courseImpQToAssign(${JSON.stringify(jrow)})`)
  assert('判断题选项 [正确,错误] 保留', jq.options.length === 2 && jq.answer[0] === 0)
  const nrow = run(`impParseText(${JSON.stringify([HEAD, NO_DIFF].join('\n'))})`)[0]
  assert('难度留空 → q.difficulty=0 且 est>0', nrow.ok && nrow.q.difficulty === 0 && nrow.est >= 1 && nrow.est <= 4, JSON.stringify({ d: nrow.q.difficulty, est: nrow.est }))
  const nq = run(`courseImpQToAssign(${JSON.stringify(nrow)})`)
  assert('映射难度用规则预估兜底（1-4）', nq.difficulty >= 1 && nq.difficulty <= 4, String(nq.difficulty))
  const brow = run(`impParseText(${JSON.stringify([HEAD, BAD_ROW].join('\n'))})`)[0]
  assert('不足 2 选项 → 非法行（ok=false，预览勾选框将被禁用）', brow.ok === false && brow.err.length > 0, brow.err)

  console.log('\n④ 表头/示例行跳过 + 多行混合')
  const ex = '示例（请删除或覆盖本行后填写）,What does "escort" mean?,引导、陪同,催促,打电话,预订,,,A,escort = 引导/护送。,L2'
  const mixed = run(`impParseText(${JSON.stringify([HEAD, ex, R1, R2].join('\n'))})`)
  assert('示例行 + 表头被跳过，只留 2 条真实数据', mixed.length === 2 && mixed.every(r => r.ok), JSON.stringify(mixed.map(r => r.q && r.q.question)))

  console.log('\n⑤ 新建作业弹窗渲染三来源 + 切换显隐')
  run("courseState.doc = { v: 1, classes: [{ id: 'c1', name: '餐饮班', members: [], assignments: [] }] }")
  run("courseCreateAssignModal('c1')")
  const modalHtml = sb._lastCreated().innerHTML
  assert('来源 radio 含 imp（上传现成题目文件）', modalHtml.indexOf('value="imp"') >= 0 && modalHtml.indexOf('courseSourceImport') < 0 && modalHtml.indexOf('上传现成题目文件') >= 0)
  assert('caImportBox 区域存在（含文件输入/粘贴/加入按钮/预览容器）', modalHtml.indexOf('id="caImportBox"') >= 0 && modalHtml.indexOf('id="caImportFile"') >= 0 && modalHtml.indexOf('id="importPreview"') >= 0 && modalHtml.indexOf('courseImportAdd') >= 0)
  assert('默认来源 bank：caBankBox 显示、caImportBox 隐藏', sb._els['caBankBox'].style.display === '' && sb._els['caImportBox'].style.display === 'none')
  run("courseDraftModeChange('imp')")
  assert('切到 imp：caImportBox 显示、其余隐藏', sb._els['caImportBox'].style.display === '' && sb._els['caBankBox'].style.display === 'none' && sb._els['caFileBox'].style.display === 'none')
  sb._els['caType'].value = 'video'
  run('courseDraftTypeChange()')
  assert('切到 video（视频作业）：caImportBox 隐藏', sb._els['caImportBox'].style.display === 'none')
  sb._els['caType'].value = 'homework'
  run('courseDraftTypeChange()')
  assert('切回 homework：按 mode 恢复（imp 仍显示）', sb._els['caImportBox'].style.display === '')

  // 端到端语义：解析 → courseDraft.preview → 发布取用（courseSubmitAssign 读取勾选项结构）
  const items = run(`impParseText(${JSON.stringify([HEAD, R1, R2].join('\n'))}).map(courseImpQToAssign).map(q => ({ checked: true, q }))`)
  const qs = items.map(it => it.q)
  assert('勾选项 → 发布题目结构齐备（type/difficulty/question/options/answer/explanation）', qs.every(q => q.type && q.difficulty >= 1 && q.difficulty <= 4 && q.question && Array.isArray(q.options) && Array.isArray(q.answer) && q.options.length >= 2 && q.answer.length >= 1))

  console.log(failed ? '\n===== v55 作业文件导入测试：存在失败 =====' : '\n===== v55 作业文件导入测试：全部通过 =====')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
