// ====== 测试：v66 线下课测评（exam）选项可选中 / 填空可输入 ======
// 回归背景：courseRenderTake 里禁用判断误写成 (isExam || qz.submitted)，
// 导致测评卷所有选择题不绑 onclick、多选不绑、voicematch 不绑、填空题 input 被 disabled，
// 整卷无法作答。v66 改为 locked = !!qz.submitted（只有「本题已提交」才锁定）。
// 覆盖：① 测评卷各类题型可交互 ② 作业逐题提交后仍要锁定 ③ 选择/多选/填空行为 ④ 交卷记分 ⑤ 源码级断言
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

function mkEl() {
  const el = {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener(ev, fn) { (el._handlers[ev] = el._handlers[ev] || []).push(fn) },
    removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() { el._removed = true }, lastElementChild: null,
    scrollIntoView() {}, _handlers: {},
    duration: NaN, currentTime: 0, seeking: false, paused: true, ended: false,
  }
  return el
}

function makeSandbox(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = {}
  const docListeners = {}
  const winListeners = {}
  const counters = { append: 0 }
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
      body: { appendChild() { counters.append++ } }, title: '',
      hidden: false,
      addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) {
        if (docListeners[ev]) docListeners[ev] = docListeners[ev].filter(f => f !== fn)
      },
      visibilityState: 'visible',
    },
    window: {
      addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn) },
      removeEventListener(ev, fn) {
        if (winListeners[ev]) winListeners[ev] = winListeners[ev].filter(f => f !== fn)
      },
      dispatchEvent() { return true }, scrollTo() {}, focus() {},
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
    _els: elements, _getEl: getEl, _docListeners: docListeners, _winListeners: winListeners, _counters: counters,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext('try { window.t = t } catch (e) {}', sandbox)
  vm.runInContext(load('anti-cheat.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext('try { window.Store = Store } catch (e) {}', sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

function asRole(sb, username, role) {
  sb.localStorage.setItem('eq_session', JSON.stringify({ id: 1, username, name: username, role }))
  sb.document.hidden = false
}

// 混合题型的测评卷（含单选 / 多选 / 判断 / 填空 / 看字选音）
const EXAM_QUESTIONS = [
  { id: 902, category_id: 1, dept: 'all', type: 'single', difficulty: 1, question: 'menu', options: ['菜单', '账单', '同事', '投诉'], answer: [0], explanation: 'menu = 菜单' },
  { id: 903, category_id: 1, dept: 'all', type: 'multiple', difficulty: 2, question: '选出发音含 /i:/ 的单词', options: ['seat', 'sit', 'meet', 'bit'], answer: [0, 2], explanation: 'seat / meet' },
  { id: 904, category_id: 1, dept: 'all', type: 'judge', difficulty: 1, question: '"bill" 表示账单。', options: ['正确', '错误'], answer: [0], explanation: 'bill = 账单' },
  { id: 905, category_id: 1, dept: 'all', type: 'fill', difficulty: 2, question: '同事的英文是 ______。', options: ['colleague'], answer: [0], explanation: 'colleague' },
  { id: 906, category_id: 1, dept: 'all', type: 'voicematch', difficulty: 2, question: '听发音选单词', options: ['menu', 'bill'], answer: [0], explanation: 'menu' },
]

const docRef = {
  doc: {
    v: 1,
    classes: [{
      id: 'c1', name: '测试班', note: '', createdBy: 'admin', members: ['张三'],
      assignments: [
        { id: 'e1', type: 'exam', title: '线下课小测', status: 'open', duration: 10, questions: JSON.parse(JSON.stringify(EXAM_QUESTIONS)), results: {} },
        { id: 'h1', type: 'homework', title: '第一节作业', status: 'open', questions: JSON.parse(JSON.stringify(EXAM_QUESTIONS)), results: {} },
      ],
    }],
  },
}

const idxOfType = (sb, type) => vm.runInContext(
  `courseQuiz.questions.findIndex(q => q.type === '${type}')`, sb)
const pageHtml = sb => vm.runInContext("document.getElementById('page-course').innerHTML", sb)
// 按「打乱后」的正确索引作答（shuffleOptions 会重映射 q.answer，故直接读 q.answer 才对得上）
const pickCorrect = (sb, i) => vm.runInContext(`(() => {
  const q = courseQuiz.questions[${i}]
  if (q.type === 'multiple') {
    courseQuiz.answers[courseQuiz.index] = []      // 多选为 toggle 语义，先清空保证幂等
    q.answer.forEach(x => courseTogglePick(x))
  }
  else if (q.type === 'fill' || q.type === 'translate') { courseType(q.options[0]) }
  else { coursePick(q.answer[0]) }
})()`, sb)
// 过滤注释行后的「纯代码」，避免注释里提到旧写法造成误判
const codeOnly = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

;(async () => {
  console.log('\n🧪 A. 测评卷（exam）：各题型都要可交互')
  {
    const sb = makeSandbox(docRef)
    asRole(sb, '张三', 'student')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'e1')`, sb)
    assert('测评已进入答题态', vm.runInContext('courseQuiz && courseQuiz.phase === "quiz"', sb) === true)

    // A1 单选
    const iSingle = idxOfType(sb, 'single')
    vm.runInContext(`courseGoto(${iSingle})`, sb)
    assert('单选选项绑定 coursePick', /onclick="coursePick\(\d+\)"/.test(pageHtml(sb)), 'html 内无 coursePick')
    assert('单选选项未被 disabled', !/class="option-item[^"]*"[^>]*disabled/.test(pageHtml(sb)))

    // A2 多选
    const iMulti = idxOfType(sb, 'multiple')
    vm.runInContext(`courseGoto(${iMulti})`, sb)
    assert('多选选项绑定 courseTogglePick', /onclick="courseTogglePick\(\d+\)"/.test(pageHtml(sb)))

    // A3 判断
    const iJudge = idxOfType(sb, 'judge')
    vm.runInContext(`courseGoto(${iJudge})`, sb)
    assert('判断选项绑定 coursePick', /onclick="coursePick\(\d+\)"/.test(pageHtml(sb)))

    // A4 填空：input 不能 disabled
    const iFill = idxOfType(sb, 'fill')
    vm.runInContext(`courseGoto(${iFill})`, sb)
    const fillHtml = pageHtml(sb)
    assert('填空页存在 input', /<input[^>]*class="input-answer"/.test(fillHtml), fillHtml.slice(0, 200))
    assert('填空 input 未 disabled', !/<input[^>]*\sdisabled/.test(fillHtml))
    assert('填空绑定 courseType', /oninput="courseType\(this\.value\)"/.test(fillHtml))

    // A5 看字选音
    const iVm = idxOfType(sb, 'voicematch')
    if (iVm >= 0) {
      vm.runInContext(`courseGoto(${iVm})`, sb)
      assert('voicematch 选项绑定 coursePick', /onclick="coursePick\(\d+\)"/.test(pageHtml(sb)))
    } else {
      assert('voicematch 题存在', false, '题目缺失')
    }
  }

  console.log('\n🧪 B. 测评卷：选择行为与交卷记分')
  {
    const sb = makeSandbox(docRef)
    asRole(sb, '张三', 'student')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'e1')`, sb)

    // B1 单选：点第 1 个选项 → 写入 answers
    const iSingle = idxOfType(sb, 'single')
    vm.runInContext(`courseGoto(${iSingle}); coursePick(0)`, sb)
    assert('测评单选点击后写入 answers', vm.runInContext(`courseQuiz.answers[${iSingle}]`, sb) === 0,
      String(vm.runInContext(`courseQuiz.answers[${iSingle}]`, sb)))
    assert('测评单选点选后题号格标记已答', /course-grid-cell answered/.test(pageHtml(sb)))

    // B2 多选：toggle 两次 → 数组含两项
    const iMulti = idxOfType(sb, 'multiple')
    vm.runInContext(`courseGoto(${iMulti}); courseTogglePick(0); courseTogglePick(2)`, sb)
    const multiAns = vm.runInContext(`JSON.stringify(courseQuiz.answers[${iMulti}] || [])`, sb)
    assert('测评多选 toggle 生效', multiAns === '[0,2]', multiAns)
    vm.runInContext(`courseTogglePick(0)`, sb)
    assert('测评多选再次点击可取消', vm.runInContext(`JSON.stringify(courseQuiz.answers[${iMulti}])`, sb) === '[2]',
      vm.runInContext(`JSON.stringify(courseQuiz.answers[${iMulti}])`, sb))
    vm.runInContext(`courseTogglePick(0)`, sb)

    // B3 填空：courseType 写入
    const iFill = idxOfType(sb, 'fill')
    vm.runInContext(`courseGoto(${iFill}); courseType('colleague')`, sb)
    assert('测评填空可输入并写入 answers', vm.runInContext(`courseQuiz.answers[${iFill}]`, sb) === 'colleague')

    // B4 全部按正确答案作答 → 交卷应得 100 分（证明打乱后选项索引与答案一致，作答链路通）
    const total = vm.runInContext('courseQuiz.questions.length', sb)
    for (let i = 0; i < total; i++) {
      vm.runInContext(`courseGoto(${i})`, sb)
      pickCorrect(sb, i)
      const t = vm.runInContext(`courseQuiz.questions[${i}].type`, sb)
      const ok = vm.runInContext(`courseCheckAnswer(courseQuiz.questions[${i}], courseQuiz.answers[${i}])`, sb)
      assert(`第 ${i + 1} 题（${t}）按正确答案作答 → 判定为对`, ok === true,
        `ans=${JSON.stringify(vm.runInContext(`courseQuiz.answers[${i}]`, sb))} answer=${vm.runInContext(`JSON.stringify(courseQuiz.questions[${i}].answer)`, sb)} opts=${vm.runInContext(`JSON.stringify(courseQuiz.questions[${i}].options)`, sb)}`)
    }
    await vm.runInContext('courseExamSubmit(false)', sb)
    assert('测评交卷后进入结果页', vm.runInContext('courseQuiz.phase', sb) === 'result')
    const res = docRef.doc.classes[0].assignments[0].results['张三']
    assert('测评成绩已落库', !!res && res.score != null, JSON.stringify(res || {}))
    assert('全对得 100 分', res && res.score === 100, String(res && res.score))

    // B5 测评不存在 reviewing 态、不受 locked 影响
    assert('测评交卷后 submitted 未污染后续', vm.runInContext('courseQuiz.submitted', sb) === false)
  }

  console.log('\n🧪 C. 作业（homework）：逐题反馈后必须锁定')
  {
    const sb = makeSandbox(docRef)
    asRole(sb, '张三', 'student')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext(`courseStart('c1', 'h1')`, sb)
    const iSingle = idxOfType(sb, 'single')

    vm.runInContext(`courseGoto(${iSingle}); coursePick(0)`, sb)
    assert('作业作答中选项可点', /onclick="coursePick\(\d+\)"/.test(pageHtml(sb)))

    vm.runInContext('courseSubmitAnswer()', sb)
    assert('作业本题已提交 submitted=true', vm.runInContext('courseQuiz.submitted', sb) === true)
    const afterHtml = pageHtml(sb)
    assert('作业提交后选项不再可点', !/onclick="coursePick\(\d+\)"/.test(afterHtml))
    assert('作业提交后显示对错反馈', /class="feedback /.test(afterHtml))
  }

  console.log('\n🧪 D. 源码级断言')
  {
    const src = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
    const code = codeOnly(src)
    assert('已移除 (isExam || qz.submitted) 误禁用', !/\(isExam \|\| qz\.submitted\)/.test(code))
    assert('引入 locked = !!qz.submitted', /const locked = !!qz\.submitted/.test(code))
    const lockedUses = (src.match(/locked \? ''/g) || []).length
    assert('locked 覆盖全部 4 处题型（voicematch/单选/多选/填空）', lockedUses === 3 && /oninput="courseType\(this\.value\)" \$\{locked \? 'disabled' : ''\}/.test(src), String(lockedUses))
    assert('isExam 仍用于布局（题号格/底部按钮/类型标签）', (src.match(/isExam/g) || []).length >= 5)
  }

  console.log(failed ? '\n❌ 存在失败项' : '\n✅ v66 测评卷可作答 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
