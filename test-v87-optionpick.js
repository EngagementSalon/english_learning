// ====== 测试 v87：作答页「有些题目选不了」修复 ======
// 线上反馈：练习与定级测试里有些题目选不了。排查出三条独立成因，本测试逐条守护：
// ① 选项 A 的索引是 0（falsy），而 renderPracticeQuestion 原先写 `answers[i] || 默认值` →
//    选了 A 被当成「未作答」，不高亮 = 学生眼里「点了没反应」。
// ② 课库里有 6 道 voicematch 题实质是「看中文选英文」的普通选择题（题干是中文），
//    而 voicematch 作答中会隐藏选项文字 → 学生看不到任何可选内容。定级测试只从课库抽题，全中招。
// ③ 种子库里 5 道题写成 type:'single' 却只有 1 个选项（v8 迁移会把它们灌进老设备本地库）→ 只有一个选项、
//    且叠加 ① 后永远不高亮。现在改为填空，并用 safeQType 做运行时兜底。
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
    placeholder: '', value: '', readOnly: false, disabled: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}
const QKEYS = {
  QUESTIONS: 'eq_questions', UPLOADED: 'eq_uploaded', CATEGORIES: 'eq_categories', BANK_VERSION: 'eq_bank_version',
}
const BANKVER = (() => {
  const s = {}
  vm.createContext(s)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), s)
  return vm.runInContext('BANK.version', s)
})()
function makeSandbox(preKeys) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const lsStore = Object.assign({}, preKeys || {})
  const sb = {
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
      createElement: () => mkEl(), body: { appendChild() {} }, title: '',
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder, AbortController,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [], recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    CourseStore: {
      status: 'online', newId: () => 'a1', findClass: () => null, findAssign: () => null,
      getDoc: async () => null, mutate: async () => true,
    },
    _els: elements, _getEl: getEl,
  }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(load('i18n.js'), sb)
  vm.runInContext(load('bank-data.js'), sb)
  vm.runInContext(load('store.js'), sb)
  vm.runInContext(load('course-app.js'), sb)
  vm.runInContext(load('app.js'), sb)
  return sb
}
function extractFn(src, name) {
  let start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// 真·辨音题（题干英文文字 = 某选项文字）
const VM_PRON = {
  id: 9001, category_id: 1, dept: 'all', type: 'voicematch', difficulty: 1,
  question: 'reservation', options: ['reservation', 'registration', 'conversation', 'celebration'],
  answer: [0], explanation: '',
}
// 课库实际数据：题干是中文的「看题选词」题被录成了 voicematch（线上选不了的元凶）
const VM_MEANING = {
  id: 9002, category_id: 1, dept: 'all', type: 'voicematch', difficulty: 1,
  question: '以下哪个是旅途', options: ['journey', 'safe', 'address', 'choosing'],
  answer: [0], explanation: '',
}
const SINGLE = {
  id: 9003, category_id: 1, dept: 'all', type: 'single', difficulty: 1,
  question: '「景色」对应的英文是？', options: ['views', 'spectacular', 'stylish', 'cuisine'],
  answer: [0], explanation: '',
}
// 线上老数据形态：单选题却只有 1 个选项（种子 id 85-89 经 v8 迁移灌进本地库）
const MALFORMED = {
  id: 9004, category_id: 1, dept: 'all', type: 'single', difficulty: 2,
  question: '填空（首字母提示）：We s_____ in seafood and grilled meats.（专营）',
  options: ['specialize'], answer: [0], explanation: '',
}

;(async () => {
  console.log('\n🧪 v87 作答页选项可选性回归测试\n')
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
  const sb = makeSandbox({
    [QKEYS.BANK_VERSION]: String(BANKVER),
    [QKEYS.QUESTIONS]: JSON.stringify([SINGLE, MALFORMED]),
  })
  const run = (code) => vm.runInContext(code, sb)

  console.log('[1] safeQType：题型自洽兜底')
  assert('normal single 不变', run('safeQType({type:"single",options:["a","b"]})') === 'single')
  assert('judge 不变', run('safeQType({type:"judge",options:["正确","错误"]})') === 'judge')
  assert('voicematch 不变', run('safeQType({type:"voicematch",options:["a","b","c"]})') === 'voicematch')
  assert('fill/translate 不变', run('safeQType({type:"fill",options:["x"]})') === 'fill' && run('safeQType({type:"translate",options:["x"]})') === 'translate')
  assert('single 仅 1 个选项 → fill（畸形题兜底）', run('safeQType({type:"single",options:["specialize"]})') === 'fill')
  assert('multiple 无选项 → fill', run('safeQType({type:"multiple",options:[]})') === 'fill')
  assert('listen options 缺失 → fill', run('safeQType({type:"listen"})') === 'fill')
  assert('null 题 → 空字符串', run('safeQType(null)') === '')
  assert('不修改原对象', (() => {
    const q = JSON.parse(JSON.stringify(MALFORMED))
    run(`safeQType(${JSON.stringify(q)})`)
    return q.type === 'single' && q.options.length === 1
  })())

  console.log('\n[2] vmHideOptionText：什么时候必须显示选项文字')
  assert('题干英文且等于某选项文字 → 隐藏（真辨音题）', run(`vmHideOptionText(${JSON.stringify(VM_PRON)})`) === true)
  assert('中文题干 → 显示（看题选词题）', run(`vmHideOptionText(${JSON.stringify(VM_MEANING)})`) === false)
  assert('英文题干但无选项与之相同 → 显示', run('vmHideOptionText({question:"alpha",options:["beta","gamma"]})') === false)
  assert('空题干 → 显示', run('vmHideOptionText({question:"",options:["a","b"]})') === false)
  assert('大小写/空格不敏感', run('vmHideOptionText({question:" Housekeeping ",options:["housekeeping","x"]})') === true)
  assert('种子库 12 道 voicematch 全部保持隐藏（真辨音题不被削弱）',
    run('BANK.questions.filter(q=>q.type==="voicematch").every(q=>vmHideOptionText(q))') === true,
    run('JSON.stringify(BANK.questions.filter(q=>q.type==="voicematch"&&!vmHideOptionText(q)).map(q=>q.question))'))

  console.log('\n[3] voicematch 作答行渲染（朗读归 🔊，选择归「选择此项」）')
  {
    const pron = run(`vmOptionsHtml(${JSON.stringify(VM_PRON)}, -1, 'live', 'selectOption')`)
    assert('真辨音题：不泄露选项文字', !pron.includes('vm-opt-text'), pron.slice(0, 200))
    assert('真辨音题：保留 🔊/🔉/🌐 播放按钮',
      (pron.match(/vm-play/g) || []).length === 4 && (pron.match(/vm-online/g) || []).length === 8)
    assert('真辨音题：提示语仍是「题干为英文文字」', pron.includes('题干为英文文字'), '')
    assert('每个选项都有「选择此项」按钮', (pron.match(/vm-choose/g) || []).length === 4)
    assert('「选择此项」绑定对应 pickFn 索引且不冒泡',
      pron.includes('event.stopPropagation();selectOption(0)') && pron.includes('event.stopPropagation();selectOption(3)'))
    assert('整行仍可直接点击选择', pron.includes('onclick="selectOption(0)"'))
    const meaning = run(`vmOptionsHtml(${JSON.stringify(VM_MEANING)}, -1, 'live', 'selectOption')`)
    assert('中文题干 voicematch：选项文字全部显示（核心修复）',
      (meaning.match(/vm-opt-text/g) || []).length === 4 && meaning.includes('journey') && meaning.includes('choosing'),
      meaning.slice(0, 300))
    assert('中文题干 voicematch：提示语换成「看题选词」话术', meaning.includes('选出与题干相符的一项') && !meaning.includes('题干为英文文字'))
    assert('中文题干 voicematch：同样有「选择此项」', (meaning.match(/vm-choose/g) || []).length === 4)
    const rev = run(`vmOptionsHtml(${JSON.stringify(VM_PRON)}, 1, 'review', null)`)
    assert('回顾模式：显示文字、无「选择此项」、无行级 onclick',
      rev.includes('vm-opt-text') && !rev.includes('vm-choose') && !rev.includes('selectOption('))
  }

  console.log('\n[4] 练习页：选项 A（索引 0）必须能高亮')
  const renderPractice = (q, answers, submitted) => {
    run(`practiceState = { questions: [${JSON.stringify(q)}], index: 0, answers: ${JSON.stringify(answers)}, submitted: ${!!submitted}, correctCount: 0 }`)
    run('renderPracticeQuestion()')
    return sb._getEl('practiceQuiz').innerHTML
  }
  {
    const h0 = renderPractice(SINGLE, [0], false)
    assert('选了 A → 第一个选项带 selected', /<div class="option-item selected"/.test(h0), h0.slice(0, 300))
    assert('选了 A → 只有 1 个 selected', (h0.match(/option-item selected/g) || []).length === 1)
    const h2 = renderPractice(SINGLE, [2], false)
    assert('选了 C → 第三个选项 selected', (h2.match(/option-item selected/g) || []).length === 1 && h2.indexOf('option-item selected') !== h2.indexOf('option-item'))
    const hn = renderPractice(SINGLE, [], false)
    assert('未作答 → 无 selected', !hn.includes('option-item selected'), hn.slice(0, 300))
    const hmin = renderPractice(SINGLE, [-1], false)
    assert('answers=-1 → 无 selected', !hmin.includes('option-item selected'))
    const htext = renderPractice(SINGLE, [''], false)
    assert('answers="" → 无 selected', !htext.includes('option-item selected'))
  }
  console.log('\n[5] 畸形题在练习页渲染成可填空（而不是「没有可点选项」）')
  {
    const h = renderPractice(MALFORMED, [], false)
    assert('渲染为文本输入框', h.includes('input-answer') && h.includes('oninput="onTextInput(this.value)"'), h.slice(0, 300))
    assert('不再渲染 option-item', !h.includes('option-item'), h.slice(0, 300))
    assert('判分按填空口径（输入正确答案 → 对）', run(`checkAnswer(${JSON.stringify(MALFORMED)}, 'Specialize')`) === true)
    assert('判分按填空口径（输错 → 错）', run(`checkAnswer(${JSON.stringify(MALFORMED)}, 'specialise')`) === false)
  }

  console.log('\n[6] 定级测试：畸形题不进题池，voicematch 可选')
  {
    const pool = []
    let id = 10000
    for (let lvl = 1; lvl <= 4; lvl++) {
      for (let k = 0; k < 7; k++) {
        pool.push({ id: id++, category_id: 1, dept: 'all', type: k === 6 ? 'voicematch' : 'single', difficulty: lvl, level: lvl, question: 'well' + lvl + k, options: ['a' + lvl + k, 'b' + lvl + k, 'c' + lvl + k], answer: [0], explanation: '' })
      }
      // 每级塞 1 道畸形题（选项只有 1 个）
      pool.push({ id: id++, category_id: 1, dept: 'all', type: 'single', difficulty: lvl, level: lvl, question: 'bad' + lvl, options: ['only'], answer: [0], explanation: '' })
    }
    run(`Store.getQuestionsWithLevel = () => ${JSON.stringify(pool)}`)
    run('Store.isAdmin = () => false')
    run('Store.getSessionDeptKey = () => "dining"')
    const picked = await run('buildPlacementQuestions()')
    assert('抽出 24 题（L1-L4 各 6）', picked.length === 24, 'got ' + picked.length)
    assert('畸形题（仅 1 个选项）已被剔除', picked.every(q => Array.isArray(q.options) && q.options.length >= 2),
      JSON.stringify(picked.filter(q => !q.options || q.options.length < 2).map(q => q.question)))
    assert('voicematch 仍可被抽中', picked.some(q => q.type === 'voicematch'))
    const vmQ = picked.find(q => q.type === 'voicematch')
    const html = run(`(function(){ placementState = { phase:'quiz', auto:false, questions: ${JSON.stringify(picked)}, index: 0, answers: ${JSON.stringify(picked.map(() => -1))}, result: null }; renderPlacementQuestion(); return document.getElementById('page-placement').innerHTML })()`)
    assert('定级页渲染出行级 onclick', html.includes('placementPick('), html.slice(0, 200))
    assert('定级页 voicematch 行给的是 placementPick 的「选择此项」',
      !html.includes('vm-choose') || html.includes('placementPick('))
  }

  console.log('\n[7] 考试页 / 挑战页 / 线下课页同口径')
  {
    const examHtml = run(`(function(){ examState = { phase:'doing', questions: [${JSON.stringify(MALFORMED)}], answers: [-1], currentIndex: 0, remaining: 600, flagged: new Set() }; renderExamQuestion(); return document.getElementById('page-exam').innerHTML })()`)
    assert('考试页畸形题 → 文本输入框', examHtml.includes('input-answer'), examHtml.slice(0, 300))
    // 挑战页
    const chSb = sb
    vm.runInContext(extractFn(chSrc, 'chOptionsHtml'), chSb)
    vm.runInContext(extractFn(chSrc, 'chTextInput'), chSb)
    run(`chs = { phase:'quiz', index: 0, answers: [-1], day: 1, si: 0 }`)
    const chBad = run(`chOptionsHtml(${JSON.stringify(MALFORMED)}, false, -1, 'chPick')`)
    assert('挑战页畸形题 → 文本输入框（oninput 落到 chs.answers）', chBad.includes('input-answer') && chBad.includes('chTextInput'), chBad.slice(0, 200))
    run('chTextInput("specialize")')
    assert('挑战页填空输入写入 chs.answers', run('chs.answers[0]') === 'specialize')
    const chVm = run(`chOptionsHtml(${JSON.stringify(VM_MEANING)}, false, -1, 'chPick')`)
    assert('挑战页中文题干 voicematch → 显示选项文字', (chVm.match(/vm-opt-text/g) || []).length === 4)
    // 线下课页
    const cHtml = run(`(function(){ courseQuiz = { type:'homework', questions: [${JSON.stringify(MALFORMED)}], answers: [-1], index: 0, submitted: false, reviewing: false }; courseRenderTake(); return document.getElementById('page-course').innerHTML })()`)
    assert('线下课页畸形题 → 文本输入框', cHtml.includes('input-answer'), cHtml.slice(0, 200))
    assert('courseCheckAnswer 与练习页同口径', run(`courseCheckAnswer(${JSON.stringify(MALFORMED)}, 'SPECIALIZE ')`) === true)
  }

  console.log('\n[8] 判分容错（answer 未写成数组的脏数据不再抛错）')
  {
    assert('单选题 answer 为数字 → 不抛错且判对', run('checkAnswer({type:"single",options:["a","b"],answer:0}, 0)') === true)
    assert('单选题 answer 为数字 → 选错判错', run('checkAnswer({type:"single",options:["a","b"],answer:0}, 1)') === false)
    assert('多选题 ans 非数组 → 判错不抛错', run('checkAnswer({type:"multiple",options:["a","b"],answer:[0,1]}, 0)') === false)
    assert('填空题答案为数字 → 不抛错', run('checkAnswer({type:"fill",options:[3],answer:[0]}, "3")') === true)
    assert('courseCheckAnswer 同样容错', run('courseCheckAnswer({type:"multiple",options:["a","b"],answer:[0,1]}, undefined)') === false)
  }

  console.log('\n[9] 题库数据体检（防回归：选择题型必须 ≥2 个选项）')
  {
    const bad = run(`JSON.stringify(BANK.questions.filter(q => ['single','judge','pronounce','multiple','listen','voicematch'].includes(q.type) && (!Array.isArray(q.options) || q.options.length < 2)).map(q => q.id))`)
    assert('种子题库无「选择题型 + 选项不足 2 个」', bad === '[]', bad)
    assert('种子库 id 85-89 已改为填空题型',
      run('BANK.questions.filter(q => [85,86,87,88,89].includes(q.id)).every(q => q.type === "fill")') === true,
      run('JSON.stringify(BANK.questions.filter(q => [85,86,87,88,89].includes(q.id)).map(q => q.type))'))
    assert('BANK.version 未变动（=9，避免触发设备端迁移）', run('BANK.version') === 9)
  }

  console.log('\n[10] 老设备本地库形态：畸形题在真实数据通路里也能作答')
  {
    // 模拟 v8 迁移后的设备：本地库里躺着「type:single + 只有 1 个选项」的老题
    run(`localStorage.setItem('eq_questions', ${JSON.stringify(JSON.stringify([MALFORMED]))})`)
    const real = run('JSON.stringify(Store.getQuestions().find(q => q.id === 9004))')
    assert('本地库畸形题仍可被取出（不被静默丢弃）', real && real !== 'undefined', real)
    const q = JSON.parse(real)
    const html = renderPractice(q, [], false)
    assert('真实通路取出的畸形题 → 渲染为填空', html.includes('input-answer'), html.slice(0, 200))
  }

  console.log(failed ? '\n❌ 有断言失败' : '\n✅ v87 测试全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
