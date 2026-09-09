// ====== 测试：v33 一次性本地题库清理 ======
// v32 仅删了 bank-data.js 种子里的 20 条，管理员之前 AI 出题保存到本地 localStorage 的同类劣质题仍存在。
// v33 在 Store.init() 顶部按 eq_silly_cleaned_v33 一次性 flag 过滤并删除它们。
// 关键：不得误删合法句子翻译题（"May I know…" 的中文意思是？选项为真实译文，见 bank-data id 17/176）
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// 读取 bank-data.js 的版本号，沙箱里预置 eq_bank_version，避免 init 触发版本迁移覆盖题库
const bankVersion = parseInt((fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8').match(/version:\s*(\d+)/) || [null, '0'])[1], 10) || 1

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkSandbox() {
  const ls = {
    store: {
      // 预置 eq_bank_version = 当前版本，跳过 init 的题库迁移（迁移会以种子覆盖本地，干扰清理断言）
      'eq_bank_version': JSON.stringify(bankVersion),
      // v43 一次性清空逻辑与本测试无关，预置 flag 跳过
      'eq_course_only_v43': '1',
      // 预置本地题：5 条劣质（应清理）+ 3 条合法（应保留，含 17/176 同类句译反例）
      'eq_questions': JSON.stringify([
        { id: 7001, category_id: 1, type: 'single', question: '「护送客人时，请说：」对应的英文是？', options: ['When escorting the guest, say:', 'Addressing Women', 'The proper way...', 'Giving Simple Directions'], answer: [0] },
        { id: 7002, category_id: 1, type: 'single', question: '一课一练 E1 连线题中，"Located on" 对应的中文是？', options: ['位于', '介绍', '专营', '营业时间'], answer: [0] },
        { id: 7003, category_id: 1, type: 'single', question: '词库连线："Announcement" 对应的中文是？', options: ['公告', '周年', '订婚', '传统'], answer: [0] },
        { id: 7008, category_id: 1, type: 'single', question: '「concierge」的中文意思是？', options: ['礼宾人员', '厨师', '行李员', '前台'], answer: [0] },
        { id: 7010, category_id: 1, type: 'single', question: '「Suite」的最佳中文翻译是？', options: ['套房', '标准间', '单人间', '总统套房'], answer: [0] },
        { id: 7004, category_id: 1, type: 'single', question: '服务员自我介绍的句子翻译为？', options: ['Good evening...', 'Hello Smith...', 'Good evening Smith family...'], answer: [0] },
        { id: 7005, category_id: 1, type: 'single', question: '"Illegal" 的意思是？', options: ['违法的', '不合法的商业行为', '不礼貌的', '不健康的'], answer: [0] },
        // 反例：合法句子翻译题（与 bank-data id 17/176 同形状：英文整句 + 真实译文选项），绝不能删
        { id: 7009, category_id: 1, type: 'single', question: '"May I know if you have a reservation?" 的中文意思是？', options: ['请问您有预订吗？', '请问您是会员吗？', '请问您几位？', '请问您住店吗？'], answer: [0] },
      ]),
    },
    getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = { innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '', value: '', placeholder: '', addEventListener() {}, removeEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] }, classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {} })
  const sandbox = {
    console,
    localStorage: ls,
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '', placeholder: '', value: '', addEventListener() {}, removeEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] }, classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {} }),
      body: { appendChild() {} }, title: '',
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {}, speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] }, SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() } },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, addDuration() {}, fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }), getDashboardData: async () => [], recalcCloudPlacementLevels: async () => ({}), flushDuration() {}, pushPending: async () => {} },
    CourseStore: { status: 'online', newId: () => 'aX' + Math.floor(Math.random() * 1e6), findClass: () => null, findAssign: () => null, getDoc: async () => ({ classes: [] }), mutate: async fn => { const d = { classes: [] }; fn(d); return true } },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  // 加载 store.js（文件底部会同步执行 Store.init() → v33 清理即在此完成）
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
  return sandbox
}

;(async () => {
  console.log('\n🧪 v33 本地题库一次性清理（bank-data version=' + bankVersion + '）\n')

  // ============ A. 首次初始化：删劣质、留合法、写 flag ============
  console.log('① 首次 init（无 flag）→ 清理 + 写 flag')
  const sb1 = mkSandbox()
  // mkSandbox 返回前 store.js 的 Store.init() 已同步执行完毕
  const qsAfter1 = JSON.parse(sb1.localStorage.getItem('eq_questions'))
  const flagSet1 = sb1.localStorage.getItem('eq_silly_cleaned_v33') === '1'
  assert('eq_silly_cleaned_v33 flag 已写入', flagSet1)
  assert('预置 8 题 → 首启清理后剩 3 条合法题', qsAfter1.length === 3, 'n=' + qsAfter1.length + ' 保留 ids: ' + qsAfter1.map(q => q.id).join(','))
  const idsKept1 = qsAfter1.map(q => q.id).sort((a, b) => a - b)
  assert('清除劣质题 7001/7002/7003/7008/7010（对应英文/连线题中/词库连线/「」中文意思是/最佳中文翻译）',
    !idsKept1.includes(7001) && !idsKept1.includes(7002) && !idsKept1.includes(7003) && !idsKept1.includes(7008) && !idsKept1.includes(7010),
    '保留 ids: ' + idsKept1.join(','))
  assert('保留合法题 7004（句子翻译）、7005（"X 的意思是"）、7009（整句中文意思·真实译文，与 id 17/176 同型不误删）',
    idsKept1.includes(7004) && idsKept1.includes(7005) && idsKept1.includes(7009),
    '保留 ids: ' + idsKept1.join(','))

  // ============ B. 二次 init：flag 已置位 → 不再清理（避免误伤新题）============
  console.log('\n② 二次 init（flag 已置）→ 不再清理')
  const sb2 = mkSandbox()
  sb2.localStorage.setItem('eq_silly_cleaned_v33', '1')
  sb2.localStorage.setItem('eq_questions', JSON.stringify([
    { id: 7001, category_id: 1, type: 'single', question: '「X」对应的英文是？', options: ['a', 'b', 'c', 'd'], answer: [0] },  // 劣质但 flag 已置：保留（一次性清理，不做反复扫描）
    { id: 7006, category_id: 1, type: 'single', question: 'Illegal 的意思是？', options: ['违法的', '不合法的', '不礼貌的', '不健康的'], answer: [0] }, // 合法
  ]))
  // 直接调用 Store.init() 模拟二次启动（不能重复 runInContext 整个文件：const 重复声明会 SyntaxError）
  vm.runInContext('Store.init()', sb2)
  const qsAfter2 = JSON.parse(sb2.localStorage.getItem('eq_questions'))
  assert('flag 已置位时不再清理（仅首次执行，避免误判）', qsAfter2.length === 2,
    'n=' + qsAfter2.length)

  // ============ C. 题目增删不入云队列：本地清理无需广播 ============
  console.log('\n③ 题库增删不入云队列（Store.addQuestion/updateQuestion/deleteQuestion 仅写 localStorage）')
  const storeSrc = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
  const addQFn = storeSrc.match(/addQuestion\(data\)\s*\{[\s\S]*?\n  \},/)
  assert('addQuestion 不调用 CloudSync.enqueue（仅本地写）',
    addQFn && !/CloudSync\.enqueue/.test(addQFn[0]), addQFn ? addQFn[0].slice(0, 120) : 'NOT FOUND')
  const updateQFn = storeSrc.match(/updateQuestion\(id, data\)\s*\{[\s\S]*?\n  \},/)
  assert('updateQuestion 不调用 CloudSync.enqueue（仅本地写）',
    updateQFn && !/CloudSync\.enqueue/.test(updateQFn[0]))
  const delQFn = storeSrc.match(/deleteQuestion\(id\)\s*\{[\s\S]*?\n  \},/)
  assert('deleteQuestion 不调用 CloudSync.enqueue（仅本地写）',
    delQFn && !/CloudSync\.enqueue/.test(delQFn[0]))

  console.log('\n' + (failed ? '❌ 有失败项' : '✅ 全部通过'))
  process.exit(failed ? 1 : 0)
})()
