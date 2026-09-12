// ====== 测试：v42 水平测试只从线下课题库（11 大主题）出题 + 非课库题目一次性清理 ======
// ① Store.init 一次性清理（flag eq_course_only_v42）：
//    - 非课库题目（自建分类 category_id=99 / 未分类 / 字符串 id）被删除，课库题目保留
//    - eq_categories 还原为 11 大主题（自建分类移除）
//    - flag 置位后二次 init 幂等（不再改动）
// ② buildPlacementQuestions：只从课库分类抽题，每级 ≤6，总量 ≥8
// ③ 源码接线断言
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
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}

function makeSandbox(preKeys) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  if (preKeys) Object.keys(preKeys).forEach(k => { lsStore[k] = preKeys[k] })
  const sandbox = {
    console,
    localStorage: {
      store: lsStore,
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => mkEl(),
      body: { appendChild() {} }, title: '',
      hidden: false,
      addEventListener() {}, removeEventListener() {},
      visibilityState: 'visible',
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
    fetch: async () => { throw new Error('network down') },
    AbortController,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, addDuration() {}, flushDuration() {}, pushPending: async () => {}, getDashboardData: async () => [] },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  return sandbox
}

async function main() {
  // ---------- ① 一次性清理 ----------
  console.log('\n[1] Store.init 一次性清理非课库题目')
  {
    const seedQ = [
      { id: 1, category_id: 1, dept: 'dining', type: 'single', difficulty: 1, question: '课库题1', options: ['a', 'b'], answer: [0], explanation: '' },
      { id: 2, category_id: 11, dept: 'all', type: 'judge', difficulty: 1, question: '课库题2', options: ['a', 'b'], answer: [0], explanation: '' },
      { id: 501, category_id: 99, dept: 'dining', type: 'single', difficulty: 1, question: '其他题库A（自建分类）', options: ['a', 'b'], answer: [0], explanation: '' },
      { id: 502, dept: 'dining', type: 'single', difficulty: 1, question: '其他题库B（未分类）', options: ['a', 'b'], answer: [0], explanation: '' },
      { id: 503, category_id: '99', dept: 'dining', type: 'single', difficulty: 1, question: '其他题库C（字符串分类id）', options: ['a', 'b'], answer: [0], explanation: '' },
      { id: 504, category_id: 3, dept: 'dining', type: 'single', difficulty: 2, question: '课库题3', options: ['a', 'b'], answer: [0], explanation: '' },
    ]
    const cats = [
      { id: 1, name: '宾客抵达与接待', description: '' }, { id: 2, name: '餐厅与酒吧介绍', description: '' },
      { id: 3, name: '点餐服务', description: '' }, { id: 4, name: '结账与离店', description: '' },
      { id: 5, name: '会员礼遇与庆祝', description: '' }, { id: 6, name: '婉拒与替代方案', description: '' },
      { id: 7, name: '菜品推荐', description: '' }, { id: 8, name: '酒水推荐', description: '' },
      { id: 9, name: '满意度检查与投诉处理', description: '' }, { id: 10, name: '美食趣闻与菜品描述', description: '' },
      { id: 11, name: '核心词汇综合', description: '' },
      { id: 99, name: '旧基础英语题库', description: '' },
    ]
    const sb = makeSandbox({
      eq_bank_version: '8',   // 预置为当前版本，防止版本迁移用种子覆盖预置题库
      eq_course_only_v43: '1', // v43 一次性清空逻辑由 test-v43 覆盖，此处预置 flag 隔离
      eq_questions: JSON.stringify(seedQ),
      eq_categories: JSON.stringify(cats),
    })
    vm.runInContext('Store.init()', sb)
    const after = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    const catsAfter = JSON.parse(vm.runInContext('localStorage.getItem("eq_categories")', sb))
    assert('非课库题目被删除（3 条）', after.length === 3, 'got ' + after.length + ': ' + after.map(q => q.id).join(','))
    assert('课库题目保留（id 1/2/504）', [1, 2, 504].every(id => after.some(q => q.id === id)))
    // v67（题库 v9）后分类表 = 线下课题库(id1) + 标帜餐厅常见词汇(id12)：自建分类被移除，不再还原 11 大主题
    assert('自建分类被移除（剩 线下课题库+标帜餐厅常见词汇 2 个）', catsAfter.length === 2 && catsAfter.some(c => c.id === 1) && catsAfter.some(c => c.id === 12), 'got ' + JSON.stringify(catsAfter.map(c => c.id)))
    assert('清理 flag 已置位', vm.runInContext('localStorage.getItem("eq_course_only_v42")', sb) === '1')

    // 二次 init 幂等：再混入非课库题不会被再次清理（flag 只执行一次）——
    // 但清理后题库应保持干净；这里验证 flag 存在时 init 不重置题库
    vm.runInContext(`
      const q = JSON.parse(localStorage.getItem('eq_questions'))
      q.push({ id: 601, category_id: 99, dept: 'dining', type: 'single', difficulty: 1, question: '新混入', options: ['a','b'], answer: [0], explanation: '' })
      localStorage.setItem('eq_questions', JSON.stringify(q))
      Store.init()
    `, sb)
    const after2 = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    assert('flag 已置位 → 二次 init 不重复清理（幂等）', after2.length === 4, 'got ' + after2.length)
  }

  // ---------- ② 水平测试抽题范围（v43 起只抽派生分类 id=1） ----------
  console.log('\n[2] buildPlacementQuestions 只从线下课题库分类（id=1）抽题')
  {
    const sb = makeSandbox({ eq_bank_version: '8', eq_course_only_v43: '1' })
    vm.runInContext(`
      // 混合题库：线下课题库题（cat 1）+ 其他题库题（cat 99）+ 未分类题
      const mixed = []
      for (let i = 1; i <= 40; i++) mixed.push({ id: i, category_id: 1, dept: 'all', type: 'single', difficulty: (i % 3) + 1, question: '课库题' + i, options: ['a','b','c','d'], answer: [0], explanation: '' })
      for (let i = 101; i <= 130; i++) mixed.push({ id: i, category_id: 99, dept: 'all', type: 'single', difficulty: 1, question: '其他题库题' + i, options: ['a','b'], answer: [0], explanation: '' })
      for (let i = 201; i <= 210; i++) mixed.push({ id: i, dept: 'all', type: 'judge', difficulty: 1, question: '未分类题' + i, options: ['a','b'], answer: [0], explanation: '' })
      window.__mixed = mixed
    `, sb)
    const Store = vm.runInContext('Store', sb)
    Store.getQuestions = () => vm.runInContext('window.__mixed', sb)
    const Store2 = vm.runInContext('Store', sb)
    Store2.getSession = () => ({ id: 1, username: 'stu', name: '学员', role: 'student', dept: '饮食部·标帜餐厅', level: 0 })
    const picked = await vm.runInContext('buildPlacementQuestions()', sb)   // v43 起为 async
    assert('抽到题目 ≥ 8', picked.length >= 8, 'got ' + picked.length)
    assert('全部来自线下课题库分类（cat 1）', picked.every(q => Number(q.category_id) === 1),
      'bad: ' + picked.filter(q => Number(q.category_id) !== 1).map(q => q.id).join(','))
    assert('不含其他题库（cat 99）题', !picked.some(q => q.category_id === 99))
    assert('不含未分类题', !picked.some(q => q.category_id == null))
    // v43 借用语义：题目真实等级不受抽题槽位影响，但总量不超过 24 且不重复
    assert('总量 ≤ 24 且无重复', picked.length <= 24 && new Set(picked.map(q => q.id)).size === picked.length, 'got ' + picked.length)
  }

  // ---------- ③ 预置派生题库（cat 1）下抽题仍正常 ----------
  console.log('\n[3] 派生题库（cat 1）抽题')
  {
    const bankQs = []
    for (let i = 1; i <= 30; i++) bankQs.push({ id: 100 + i, category_id: 1, dept: 'all', type: i % 4 === 0 ? 'judge' : 'single', difficulty: (i % 3) + 1, question: '派生题' + i, options: ['a', 'b', 'c', 'd'], answer: [0], explanation: '' })
    const sb = makeSandbox({ eq_bank_version: '8', eq_course_only_v43: '1', eq_questions: JSON.stringify(bankQs) })
    const Store = vm.runInContext('Store', sb)
    Store.getSession = () => ({ id: 1, username: 'stu', name: '学员', role: 'student', dept: '饮食部·标帜餐厅', level: 0 })
    const picked = await vm.runInContext('buildPlacementQuestions()', sb)
    assert('派生题库抽到 ≥ 8 题', picked.length >= 8, 'got ' + picked.length)
    assert('全部为线下课题库分类（cat 1）', picked.every(q => Number(q.category_id) === 1))
    assert('选项已随机打乱结构（每题有 options）', picked.every(q => Array.isArray(q.options)))
  }

  // ---------- ④ 源码接线 ----------
  console.log('\n[4] 源码接线断言')
  {
    const store = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
    assert('store.js：v42 清理 flag', store.includes('eq_course_only_v42'))
    assert('store.js：清理按 BANK 分类过滤', store.includes('catIds.has(Number(q.category_id))'))
    assert('store.js：分类表还原为 INITIAL_CATEGORIES', /eq_course_only_v42[\s\S]*?INITIAL_CATEGORIES/.test(store))
    assert('store.js：v43 派生方法 rebuildBankFromCourse', store.includes('rebuildBankFromCourse(classes)'))
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    assert('app.js：COURSE_BANK_CAT_ID 定义', app.includes('COURSE_BANK_CAT_ID = 1'))
    assert('app.js：抽题过滤派生分类', app.includes('Number(q.category_id) === COURSE_BANK_CAT_ID'))
    assert('app.js：抽题前同步派生题库', app.includes('await ensureCourseBankSynced()'))
  }

  console.log(failed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(failed ? 1 : 0)   // 必须显式退出：沙箱内定时器句柄会阻止进程自然退出
}

main().catch(e => { console.error('测试执行异常：', e); process.exit(1) })
