// ====== 测试：v43 线下课题库动态派生 ======
// ① Store.init 一次性清空旧内置题库（flag eq_course_only_v43），幂等
// ② Store.rebuildBankFromCourse：
//    - 从班级非草稿 homework/exam 作业提取题目；草稿 / 视频 / 线下课任务不参与
//    - 按 题型|题干 去重；题目 id 稳定（重复派生 id 不变）；dept='all'、category_id=1、difficulty 收敛 1-3
//    - 指纹比对：作业题目无变化 → 跳过写库返回 -1；变化 → 重写且 id 保持稳定
// ③ buildPlacementQuestions：先经 CourseStore 派生同步再抽题；某等级不足时从相邻等级就近借用
// ④ 源码接线断言
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

function makeSandbox(preKeys, courseDocRef) {
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
  // CourseStore mock：getDoc 返回 courseDocRef.doc（可变引用，测试中可改内容）
  if (courseDocRef) {
    sandbox.CourseStore = { getDoc: async () => courseDocRef.doc, mutate: async () => null }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  return sandbox
}

// 构造班级作业题目
function mkQ(text, difficulty, type) {
  return { type: type || 'single', difficulty: difficulty || 1, question: text, options: ['a', 'b', 'c', 'd'], answer: [0], explanation: 'e' }
}
function mkDoc() {
  return {
    v: 1,
    classes: [
      {
        id: 'c1', name: '餐饮部班级', members: ['stu'],
        assignments: [
          { id: 'hw1', type: 'homework', title: '作业1', questions: [mkQ('Q-A', 1), mkQ('Q-B', 2)] },
          { id: 'vd1', type: 'video', title: '视频课', videoUrl: 'x' },
          { id: 'of1', type: 'offline', title: '线下课' },
          { id: 'dr1', type: 'homework', status: 'draft', title: '草稿作业', questions: [mkQ('草稿题', 1)] },
        ],
      },
      {
        id: 'c2', name: '房务部班级', members: ['stu2'],
        assignments: [
          { id: 'ex1', type: 'exam', title: '测评1', questions: [mkQ('Q-C', 3), mkQ('Q-B', 2), mkQ('Q-D', 1, 'judge')] },   // Q-B 与 c1 重复
          { id: 'lg1', title: '旧版作业（无 type 字段）', questions: [mkQ('Q-LEGACY', 1)] },   // 旧版作业无 type，仍应纳入
        ],
      },
    ],
  }
}

async function main() {
  // ---------- ① 一次性清空旧题库 ----------
  console.log('\n[1] Store.init 一次性清空旧内置题库（v43）')
  {
    const seedQ = [{ id: 1, category_id: 1, dept: 'dining', type: 'single', difficulty: 1, question: '旧种子题', options: ['a', 'b'], answer: [0], explanation: '' }]
    const sb = makeSandbox({
      eq_bank_version: '8',
      eq_questions: JSON.stringify(seedQ),
      eq_categories: JSON.stringify([{ id: 1, name: '旧分类', description: '' }]),
    })
    vm.runInContext('Store.init()', sb)
    const qsAfter = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    const catsAfter = JSON.parse(vm.runInContext('localStorage.getItem("eq_categories")', sb))
    assert('旧题库被清空', qsAfter.length === 0, 'got ' + qsAfter.length)
    assert('旧分类被清空', catsAfter.length === 0, 'got ' + catsAfter.length)
    assert('v43 flag 已置位', vm.runInContext('localStorage.getItem("eq_course_only_v43")', sb) === '1')
    // 幂等：混入题目后二次 init 不再清空
    vm.runInContext(`
      localStorage.setItem('eq_questions', JSON.stringify([{ id: 9, category_id: 1, dept: 'all', type: 'single', difficulty: 1, question: '派生题', options: ['a','b'], answer: [0], explanation: '' }]))
      Store.init()
    `, sb)
    const qsAfter2 = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    assert('flag 置位后二次 init 幂等（不清空）', qsAfter2.length === 1, 'got ' + qsAfter2.length)
  }

  // ---------- ② rebuildBankFromCourse ----------
  console.log('\n[2] rebuildBankFromCourse 派生逻辑')
  {
    const sb = makeSandbox({ eq_bank_version: '8', eq_course_only_v43: '1' })
    const Store = vm.runInContext('Store', sb)
    const doc = mkDoc()
    const n = Store.rebuildBankFromCourse(doc.classes)
    const qs = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    const cats = JSON.parse(vm.runInContext('localStorage.getItem("eq_categories")', sb))
    assert('提取 5 道去重后题目（Q-A/Q-B/Q-C/Q-D/Q-LEGACY）', n === 5 && qs.length === 5, `n=${n}, len=${qs.length}`)
    assert('视频/线下课/草稿任务不参与', !qs.some(q => q.question === '草稿题'), JSON.stringify(qs.map(q => q.question)))
    assert('旧版无 type 字段作业的题目纳入', qs.some(q => q.question === 'Q-LEGACY'), JSON.stringify(qs.map(q => q.question)))
    // v67（题库 v9）后 rebuild 写入的分类表 = 线下课题库 + BANK 种子新分类（id>=12）
    assert('统一分类 id=1「线下课题库」+ 种子分类 id=12', cats[0].id === 1 && cats[0].name === '线下课题库' && cats.length === 2 && Number(cats[1].id) === 12, JSON.stringify(cats))
    assert('题目 category_id=1 且 dept=all', qs.every(q => q.category_id === 1 && q.dept === 'all'))
    assert('difficulty 保留（1/2/3）', qs.every(q => q.difficulty >= 1 && q.difficulty <= 3), JSON.stringify(qs.map(q => q.difficulty)))
    const idMap = {}
    qs.forEach(q => { idMap[q.question] = q.id })
    assert('id 为正整数', Object.values(idMap).every(v => Number.isInteger(v) && v > 0))
    // 指纹：同内容再派生 → 跳过
    const n2 = Store.rebuildBankFromCourse(doc.classes)
    assert('内容无变化 → 返回 -1 跳过写库', n2 === -1, 'got ' + n2)
    // id 稳定：作业内容变化（新增题目）后重派生，老题 id 不变
    doc.classes[0].assignments[0].questions.push(mkQ('Q-E', 2))
    const n3 = Store.rebuildBankFromCourse(doc.classes)
    const qs3 = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    assert('新增题目后重派生（6 题）', n3 === 6 && qs3.length === 6, `n=${n3}, len=${qs3.length}`)
    assert('老题 id 保持稳定', qs3.every(q => idMap[q.question] === undefined || idMap[q.question] === q.id),
      JSON.stringify(qs3.map(q => [q.question, q.id])))
    assert('新题获得新 id', (() => { const e = qs3.find(q => q.question === 'Q-E'); return e && Object.values(idMap).indexOf(e.id) < 0 })())
    // 空班级 → 清空题库
    const n4 = Store.rebuildBankFromCourse([{ id: 'c3', name: '空班', assignments: [] }])
    const qs4 = JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb))
    assert('无作业班级 → 派生为空题库', n4 === 0 && qs4.length === 0, `n=${n4}, len=${qs4.length}`)
  }

  // ---------- ③ 水平测试：先派生再抽题 + 等级借用 ----------
  console.log('\n[3] buildPlacementQuestions 派生同步 + 等级借用')
  {
    // 3a：全部难度 1 的 30 题 → L2-L4 从 L1 借用，共 24 题
    const doc = {
      v: 1,
      classes: [{ id: 'c1', name: '班', members: ['s'], assignments: [
        { id: 'hw1', type: 'homework', title: '作业', questions: Array.from({ length: 30 }, (_, i) => mkQ('难度一题' + i, 1)) },
      ] }],
    }
    const sb = makeSandbox({ eq_bank_version: '8', eq_course_only_v43: '1' }, { doc })
    const Store = vm.runInContext('Store', sb)
    Store.getSession = () => ({ id: 1, username: 'stu', name: '学员', role: 'student', dept: '饮食部·标帜餐厅', level: 0 })
    const picked = await vm.runInContext('buildPlacementQuestions()', sb)
    assert('抽到 24 题（等级不足时借用补足）', picked.length === 24, 'got ' + picked.length)
    assert('全部来自派生分类（cat 1）', picked.every(q => Number(q.category_id) === 1))
    // 借用题保留原始等级（定级按题目真实难度统计），全部难度 1 → 均为 L1
    const lvCount = {}
    picked.forEach(q => { lvCount[q.level] = (lvCount[q.level] || 0) + 1 })
    assert('借用题保留原始等级（全部 L1）', Object.keys(lvCount).length === 1 && lvCount[1] === 24, JSON.stringify(lvCount))
    const dupIds = new Set(picked.map(q => q.id))
    assert('无重复抽题', dupIds.size === picked.length)
    assert('派生已写入本地题库', JSON.parse(vm.runInContext('localStorage.getItem("eq_questions")', sb)).length === 30)
    // 3b：题目不足 24 → 有多少抽多少（≥8 才开考）
    const doc2 = {
      v: 1,
      classes: [{ id: 'c1', name: '班', members: ['s'], assignments: [
        { id: 'hw1', type: 'homework', title: '作业', questions: Array.from({ length: 10 }, (_, i) => mkQ('少量题' + i, (i % 3) + 1)) },
      ] }],
    }
    const sb2 = makeSandbox({ eq_bank_version: '8', eq_course_only_v43: '1' }, { doc: doc2 })
    const Store2 = vm.runInContext('Store', sb2)
    Store2.getSession = () => ({ id: 1, username: 'stu', name: '学员', role: 'student', dept: '饮食部·标帜餐厅', level: 0 })
    const picked2 = await vm.runInContext('buildPlacementQuestions()', sb2)
    assert('仅 10 题时抽到 10 题（不重复）', picked2.length === 10, 'got ' + picked2.length)
    const ids = new Set(picked2.map(q => q.id))
    assert('无重复抽题', ids.size === picked2.length)
  }

  // ---------- ④ 源码接线 ----------
  console.log('\n[4] 源码接线断言')
  {
    const store = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8')
    assert('store.js：v43 清理 flag', store.includes('eq_course_only_v43'))
    assert('store.js：COURSE_BANK_CATEGORY 定义', store.includes("name: '线下课题库'"))
    assert('store.js：指纹跳过', store.includes('_courseBankFp'))
    assert('store.js：id 映射持久化', store.includes('eq_course_qmap'))
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
    assert('app.js：init 后台派生', /function init\(\) \{[\s\S]*?ensureCourseBankSynced\(\)/.test(app))
    const course = fs.readFileSync(path.join(__dirname, 'course-app.js'), utf())
    assert('course-app.js：进入线下课页派生', course.includes('Store.rebuildBankFromCourse(courseState.doc.classes)'))
    assert('course-app.js：发送作业后派生', course.includes("alert(t('courseSendOk'))"))
  }

  console.log(failed ? '\n存在失败用例 ✗' : '\n全部通过 ✓')
  process.exit(failed ? 1 : 0)   // 必须显式退出：沙箱内定时器句柄会阻止进程自然退出
}

function utf() { return 'utf-8' }

main().catch(e => { console.error('测试执行异常：', e); process.exit(1) })
