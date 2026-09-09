// ====== 测试：v36 看字选音（voicematch）题型 ======
// ① QGen 第 7 节：词对 → 单词级、双语对照句 → 句子级 voicematch 题
//    （options 含题干文本、answer 指向题干、乱序无重复、≤70 字符；配额模式不产出）
// ② 作答中不暴露选项文字（live 模式仅 🔊/🌐 播放按钮），提交/回顾显示文本与对错
// ③ checkAnswer / shuffleOptions / courseCheckAnswer 判题与选项重排正确性
// ④ 平台渲染：练习 / 考试 / 考试回顾 / 水平测试均接入 voicematch
// ⑤ 水平测试抽题过滤含 voicematch（种子题可被抽中且选项重排后答案正确）
// ⑥ 线下课作答：作业 live/feedback、考试（选项行禁用 onclick）均走 vmOptionsHtml
// ⑦ i18n 双语键 + 管理编辑器（类型下拉 / 选项 placeholder / 正确答案提示）
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

function makeSandbox(courseDocRef, preKeys) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let lastCreated = null
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

// 测试用 voicematch 题
const VMQ = {
  id: 9001, category_id: 1, dept: 'all', type: 'voicematch', difficulty: 1,
  question: 'Housekeeping',
  options: ['Housekeeping', 'Minibar', 'Colleague'],
  answer: [0],
  explanation: '原文：Housekeeping（客房清洁）',
}

// 水平测试种子：24 条 voicematch（L1-L4 各 6 条，difficulty=level）
function vmSeeds() {
  const words = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray']
  const out = []
  let id = 7000
  for (let lvl = 1; lvl <= 4; lvl++) {
    for (let k = 0; k < 6; k++) {
      const w = words[out.length]
      out.push({
        id: id++, category_id: 1, dept: 'all', type: 'voicematch', difficulty: lvl,
        question: w, options: [w, 'Distractor' + lvl + 'a', 'Distractor' + lvl + 'b'], answer: [0],
        explanation: '', rule: 'voicematch',
      })
    }
  }
  return out
}

;(async () => {
  console.log('\n🧪 v36 看字选音（voicematch）回归测试\n')

  console.log('① QGen 第 7 节出题')
  const QGen = require('./qgen.js')
  const text = [
    'Housekeeping（客房清洁）',
    'Minibar（迷你吧）',
    'Colleague（同事）',
    'May I take your order?',
    '请问要点餐吗？',
    'Do you need any help?',
    '需要帮助吗？',
  ].join('\n')
  const r1 = QGen.generate(text, { max: 40 })
  const vms = r1.questions.filter(q => q.type === 'voicematch')
  assert('词对 3 + 双语句 2 → 产出 ≥4 条 voicematch', vms.length >= 4, `got ${vms.length}, info=${JSON.stringify(r1.info)}`)
  const sentenceVm = vms.find(q => q.question.includes('order'))
  assert('句子级 voicematch 存在（双语句）', !!sentenceVm, JSON.stringify(vms.map(q => q.question)))
  let allOk = true, bad = ''
  vms.forEach(q => {
    const noDup = new Set(q.options.map(x => x.toLowerCase())).size === q.options.length
    const hasStem = q.options.some(x => x.toLowerCase() === q.question.toLowerCase())
    const ansOk = q.answer.length === 1 && String(q.options[q.answer[0]]).toLowerCase() === q.question.toLowerCase()
    const lenOk = q.question.length <= 70 && q.options.length >= 2 && q.options.length <= 4
    if (!noDup || !hasStem || !ansOk || !lenOk) { allOk = false; bad = JSON.stringify(q) }
  })
  assert('每条：选项无重复、含题干文本、answer 指向题干、长度合规', allOk, bad)
  // 配额模式（single/judge/listen 三键）不产出 voicematch
  const r2 = QGen.generate(text, { max: 40, target: { single: 3, judge: 3, listen: 3 } })
  assert('配额模式（3 键）不产出 voicematch', r2.questions.every(q => ['single', 'judge', 'listen'].includes(q.type)), JSON.stringify([...new Set(r2.questions.map(q => q.type))]))

  console.log('\n② 作答中不暴露选项文字 / 回顾显示')
  const sbA = makeSandbox({ doc: {} })
  const liveHtml = vm.runInContext(`vmOptionsHtml(${JSON.stringify(VMQ)}, -1, 'live', 'selectOption')`, sbA)
  assert('live：无 vm-opt-text（不显示选项文字）', !liveHtml.includes('vm-opt-text'), liveHtml.slice(0, 300))
  assert('live：每个选项有 🔊 与 🌐 播放按钮', (liveHtml.match(/vm-play/g) || []).length === 3 && (liveHtml.match(/vm-online/g) || []).length === 3, '')
  assert('live：有作答提示 vm-hint', liveHtml.includes('vm-hint') && liveHtml.includes('题干为英文文字'), '')
  assert('live：选项行可点（selectOption）', liveHtml.includes('onclick="selectOption(0)"') && liveHtml.includes('onclick="selectOption(2)"'), '')
  const liveSel = vm.runInContext(`vmOptionsHtml(${JSON.stringify(VMQ)}, 2, 'live', 'selectOption')`, sbA)
  assert('live：已选项高亮 selected', (liveSel.match(/option-item vm-option selected/g) || []).length === 1, liveSel.slice(0, 200))
  const reviewHtml = vm.runInContext(`vmOptionsHtml(${JSON.stringify(VMQ)}, 1, 'review', null)`, sbA)
  assert('review：显示全部选项文字（vm-opt-text）', (reviewHtml.match(/vm-opt-text/g) || []).length === 3, reviewHtml.slice(0, 300))
  assert('review：正确项标 correct、错选标 wrong', reviewHtml.includes('option-item vm-option correct') && reviewHtml.includes('option-item vm-option wrong'), '')
  assert('review：无作答提示、无行级选择 onclick', !reviewHtml.includes('vm-hint') && !reviewHtml.includes('selectOption('), '')
  assert('review：正确项徽标 = ✓', reviewHtml.includes('<div class="option-badge">✓</div>'), '')

  console.log('\n③ 判题与选项重排')
  assert('checkAnswer：选对（answer[0]=0）', vm.runInContext(`checkAnswer(${JSON.stringify(VMQ)}, 0)`, sbA) === true)
  assert('checkAnswer：选错（1）', vm.runInContext(`checkAnswer(${JSON.stringify(VMQ)}, 1)`, sbA) === false)
  assert('courseCheckAnswer：选对', vm.runInContext(`courseCheckAnswer(${JSON.stringify(VMQ)}, 0)`, sbA) === true)
  assert('courseCheckAnswer：选错', vm.runInContext(`courseCheckAnswer(${JSON.stringify(VMQ)}, 2)`, sbA) === false)
  let shuffleOk = true
  for (let n = 0; n < 30; n++) {
    const s = vm.runInContext(`shuffleOptions(${JSON.stringify(VMQ)})`, sbA)
    const ansText = s.options[s.answer[0]]
    if (s.type !== 'voicematch' || ansText !== 'Housekeeping' || new Set(s.options).size !== 3) { shuffleOk = false; break }
  }
  assert('shuffleOptions 30 次：voicematch 选项重排后 answer 仍指向题干文本', shuffleOk, '')

  console.log('\n④ 平台渲染：练习 / 考试 / 考试回顾 / 水平测试')
  vm.runInContext(`practiceState = { questions: [${JSON.stringify(VMQ)}], index: 0, answers: [-1], submitted: false, correctCount: 0 }`, sbA)
  vm.runInContext('renderPracticeQuestion()', sbA)
  const pLive = sbA._getEl('practiceQuiz').innerHTML
  assert('练习 live：题干可见 + vm 选项（无文字泄露）', pLive.includes('Housekeeping') && pLive.includes('vm-option') && pLive.includes('vm-hint') && !pLive.includes('vm-opt-text'), pLive.slice(0, 300))
  vm.runInContext('practiceState.submitted = true; practiceState.answers = [1]', sbA)
  vm.runInContext('renderPracticeQuestion()', sbA)
  const pRev = sbA._getEl('practiceQuiz').innerHTML
  assert('练习提交后：显示选项文字与对错', pRev.includes('vm-opt-text') && pRev.includes('correct') && pRev.includes('wrong'), pRev.slice(0, 300))
  vm.runInContext(`examState = { phase: 'doing', questions: [${JSON.stringify(VMQ)}], answers: [-1], currentIndex: 0, flagged: new Set() }`, sbA)
  vm.runInContext('renderExamQuestion()', sbA)
  const eLive = sbA._getEl('page-exam').innerHTML
  assert('考试 live：vm 选项、无文字泄露、examSelect 可点', eLive.includes('vm-option') && eLive.includes('vm-hint') && !eLive.includes('vm-opt-text') && eLive.includes('onclick="examSelect(0)"'), eLive.slice(0, 400))
  vm.runInContext(`examState = { phase: 'result', review: [{ q: ${JSON.stringify(VMQ)}, ans: 1, isCorrect: false }], score: 0, correct: 0, total: 1, passed: false, timeout: false }`, sbA)
  vm.runInContext('renderExamResult()', sbA)
  const eRev = sbA._getEl('page-exam').innerHTML
  assert('考试回顾：你的答案/正确答案均显示选项文字 + 🔊 题干朗读', eRev.includes('Minibar') && eRev.includes('Housekeeping') && eRev.includes('listen-btn-sm') && eRev.includes('review-wrong'), eRev.slice(0, 400))
  // 水平测试渲染（独立渲染器也要防泄露）
  vm.runInContext(`placementState = { phase: 'quiz', auto: false, questions: [${JSON.stringify(VMQ)}], index: 0, answers: [-1], result: null }`, sbA)
  vm.runInContext('renderPlacementQuestion()', sbA)
  const pl = sbA._getEl('page-placement').innerHTML
  assert('水平测试 live：vm 选项、无文字泄露、placementPick 可点', pl.includes('vm-option') && pl.includes('vm-hint') && !pl.includes('vm-opt-text') && pl.includes('onclick="placementPick(0)"'), pl.slice(0, 400))

  console.log('\n⑤ 水平测试抽题过滤含 voicematch')
  const sbP = makeSandbox({ doc: {} }, {
    eq_bank_version: '8',
    eq_silly_cleaned_v33: '1',
    eq_course_only_v43: '1',   // v43 清空与本测试无关，预置 flag 跳过
    eq_questions: JSON.stringify(vmSeeds()),
  })
  asAdmin(sbP)
  const picked = await vm.runInContext('buildPlacementQuestions()', sbP)   // v43 起为 async（先派生题库再抽题）
  assert('抽题 24 题（L1-L4 各 6）且全部为 voicematch', picked.length === 24 && picked.every(q => q.type === 'voicematch'), `len=${picked.length}, types=${JSON.stringify([...new Set(picked.map(q => q.type))])}`)
  assert('重排后每题 answer 仍指向题干文本', picked.every(q => q.options[q.answer[0]] === q.question), '')

  console.log('\n⑥ 线下课作答（course-app.js）')
  const sbC = makeSandbox({ doc: {} })
  asStudent(sbC, 's1')
  const vmqJson = JSON.stringify(VMQ)
  // 作业 live
  vm.runInContext(`courseQuiz = { phase: 'quiz', cid: 'c1', aid: 'h1', type: 'homework', title: '作业', questions: [${vmqJson}], index: 0, answers: [-1], submitted: false, correct: 0, startAt: Date.now(), endAt: null, passScore: 60 }`, sbC)
  vm.runInContext('courseRenderTake()', sbC)
  const cLive = sbC._getEl('page-course').innerHTML
  assert('线下课作业 live：vm 选项、coursePick 可点、无文字泄露', cLive.includes('vm-option') && cLive.includes('onclick="coursePick(0)"') && !cLive.includes('vm-opt-text'), cLive.slice(0, 400))
  // 作业提交后（逐题反馈 → review）
  vm.runInContext('courseQuiz.answers = [1]; courseQuiz.submitted = true', sbC)
  vm.runInContext('courseRenderTake()', sbC)
  const cRev = sbC._getEl('page-course').innerHTML
  assert('线下课作业提交后：显示选项文字 + 对错 + 解析', cRev.includes('vm-opt-text') && cRev.includes('feedback') && cRev.includes('原文：Housekeeping'), cRev.slice(0, 400))
  // 考试：选项行禁用 onclick（防作弊一致性）
  vm.runInContext(`courseQuiz = { phase: 'quiz', cid: 'c1', aid: 'e1', type: 'exam', title: '测评', questions: [${vmqJson}], index: 0, answers: [-1], submitted: false, correct: 0, startAt: Date.now(), endAt: null, passScore: 60 }`, sbC)
  vm.runInContext('courseRenderTake()', sbC)
  const cExam = sbC._getEl('page-course').innerHTML
  assert('线下课考试：vm 选项无 onclick（作答由委托处理）、无文字泄露、有答题卡', cExam.includes('vm-option') && !cExam.includes('onclick="coursePick(') && !cExam.includes('vm-opt-text') && cExam.includes('course-grid-cell'), cExam.slice(0, 400))

  console.log('\n⑦ i18n 双语键 + 管理编辑器')
  const sbI = makeSandbox({ doc: {} })
  assert('zh：typeLabels.voicematch = 看字选音', vm.runInContext("t('typeLabels').voicematch", sbI) === '看字选音')
  assert('zh：vmHint 存在且含「题干为英文文字」', vm.runInContext("t('vmHint')", sbI).includes('题干为英文文字'))
  assert('zh：vmQuestionPh / vmOptionPh / vmEditorHint 均非空', ['vmQuestionPh', 'vmOptionPh', 'vmEditorHint'].every(k => vm.runInContext(`t('${k}')`, sbI).length > 8))
  vm.runInContext('LANG = "en"', sbI)
  assert('en：typeLabels.voicematch = Voice Match', vm.runInContext("t('typeLabels').voicematch", sbI) === 'Voice Match')
  assert('en：vmHint 存在', vm.runInContext("t('vmHint')", sbI).includes('Read the English'))
  assert('en：vmQuestionPh / vmOptionPh / vmEditorHint 均非空', ['vmQuestionPh', 'vmOptionPh', 'vmEditorHint'].every(k => vm.runInContext(`t('${k}')`, sbI).length > 8))
  // 管理编辑器
  vm.runInContext('LANG = "zh"', sbI)
  const optsHtml = vm.runInContext(`renderOptionsHtml({ type: 'voicematch', options: ['x'], answer: [0] })`, sbI)
  assert('编辑器：voicematch 选项 placeholder 用专用提示', optsHtml.includes('将朗读给学生'), optsHtml.slice(0, 300))
  const ansHtml = vm.runInContext(`renderAnswerArea({ type: 'voicematch', options: ['x', 'y'], answer: [0] })`, sbI)
  assert('编辑器：正确答案区附 vmEditorHint（选项为英文、作答时隐藏）', ansHtml.includes('作答时不显示文字'), ansHtml.slice(0, 300))
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  assert('编辑器类型下拉含 voicematch', appSrc.includes('<option value="voicematch"'), '')
  const courseSrc = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8')
  assert('线下课编辑器 typeOpts 含 voicematch（v37 起含 typeOpts 2 处 + RATIO_KEYS 1 处 = 3）', (courseSrc.match(/'voicematch'\]/g) || []).length === 3, '')

  console.log()
  console.log(failed ? '❌ v36 有断言失败' : '✅ v36 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('v36 异常:', e); process.exit(1) })
