// ====== 测试 v155：语音题（voicematch）改成「纯听音」+「听不见？显示文字」求助开关 ======
// 背景（学员截图反馈）：「这个语音题为什么后面还有文字 那语音题的意义何在？」
//   挑战页一道中文题干的 voicematch（看字选音）把三个英文选项**原样显示**出来 →
//   「听音选相符项」退化成「看字选字」，语音题名存实亡。
// 沿革：v87 曾把「中文题干」判为「看题选词」而故意显示文字，当时是为了救「有些题目选不了」。
//   v155 推翻该契约：**只要题干非空，作答时一律隐藏选项文字**，另配「听不见？显示文字」开关做兜底。
//
// 本套件覆盖：
//   组〇 源码契约护栏（改动的落点必须真实存在，防「定义了但没接线」）
//   组一 vmHideOptionText 数据形态语义（v155 新契约）
//   组二 vmRevealOn / vmHideNow 三态（数据形态 × 求助开关）
//   组三 vmToggleReveal 翻转 + 就地重渲染（含 data-k/data-r 契约与容错）
//   组四 vmOptionsHtml 渲染（隐藏态 / 展开态 / review 态 / 脏数据态）
//   组五 自动播放 autoplayListen（voicematch 只播首选项、绝不播题干；listen 行为不变）
//   组六 五个消费方同口径（练习 / 考试 / 定级 / 挑战 / 线下课）都接线了 rerender
//   组七 真实题库端到端（艳中中文题干题作答时看不到选项文字）
//   组八 i18n 双语键完备
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

const SRC = {
  app: fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'),
  ch: fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8'),
  course: fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8'),
  i18n: fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'),
  css: fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8'),
  html: fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'),
}

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
      SpeechSynthesisUtterance: function () { this.onstart = null },
      Audio: function () { this.play = () => Promise.resolve() },
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
// 只保留代码行（剥掉整行注释）—— 供「源码里不该再出现某字面量」类否定断言使用，
// 否则注释里写到该字面量本身会造成假失败。
const codeOnly = s => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
// 判「是否泄露选项文字」：选项文本必然出现在 🔊 按钮的 data-w 里（要朗读它），
// 所以必须先把 data-w 剥掉，否则会把朗读属性误判成可见文字。
const visibleOnly = h => String(h).replace(/data-w="[^"]*"/g, '')

// ===== 测试题 =====
// 截图那道（艳中 u1984）：中文题干 + 三个英文句子 —— v155 的核心目标
const U1984 = {
  id: 'u1984', category_id: 12, dept: 'dining/yan', type: 'voicematch', difficulty: 4,
  question: '这是菜单，请您过目。选出正确英文。',
  options: ['Here is the menu for you.', 'May I recommend our signature dishes for you?', 'This is our signature dish.'],
  answer: [0], explanation: 'menu=菜单',
}
// 种子库形态：英文单词题干，选项含题干文本
const SEED = {
  id: 9101, category_id: 12, dept: 'dining/ird', type: 'voicematch', difficulty: 1,
  question: 'Pepsi', options: ['Pepsi', 'registration', 'conversation'], answer: [0],
}
// 无 id 的题（靠题干当键）
const NOID = {
  type: 'voicematch', question: 'reservation',
  options: ['reservation', 'registration'], answer: [0],
}
// 脏数据：题干为空
const NOSTEM = { id: 9199, type: 'voicematch', question: '', options: ['alpha', 'beta'], answer: [0] }

;(async () => {
  console.log('\n🧪 v155 语音题纯听音 + 「听不见？显示文字」回归测试\n')

  console.log('[〇] 源码契约护栏（改动落点必须真实存在）')
  {
    const app = SRC.app
    assert('vmHideOptionText 存在', /function vmHideOptionText\s*\(/.test(app))
    assert('vmHideNow 存在（三态收口）', /function vmHideNow\s*\(/.test(app))
    assert('vmRevealOn 存在', /function vmRevealOn\s*\(/.test(app))
    assert('vmQKey 存在', /function vmQKey\s*\(/.test(app))
    assert('vmToggleReveal 存在', /function vmToggleReveal\s*\(/.test(app))
    assert('vmRevealStem 状态变量存在', /let vmRevealStem\s*=/.test(app))
    // v155 核心：中文题干不再被特判为「显示文字」
    const fnHide = extractFn(app, 'vmHideOptionText')
    assert('vmHideOptionText 内不再出现中文题干特判（v155 核心）',
      !/u4e00/.test(codeOnly(fnHide)), codeOnly(fnHide))
    assert('vmHideOptionText 内不再出现「选项与题干文本比对」逻辑',
      !/opts\.some/.test(codeOnly(fnHide)), codeOnly(fnHide))
    assert('vmHideOptionText 对非空题干返回 true', /return true/.test(codeOnly(fnHide)))
    assert('vmHideOptionText 对空题干返回 false', /if\s*\(!stem\)\s*return false/.test(codeOnly(fnHide)))
    // vmOptRowHtml 必须走 vmHideNow（否则求助开关对选项行不生效 = 定义了没接线）
    const fnRow = extractFn(app, 'vmOptRowHtml')
    assert('vmOptRowHtml 走 vmHideNow（不是裸的 vmHideOptionText）',
      /vmHideNow\(q\)/.test(codeOnly(fnRow)) && !/else if \(vmHideOptionText\(q\)\)/.test(codeOnly(fnRow)),
      codeOnly(fnRow).slice(0, 400))
    // vmOptionsHtml 签名扩到 5 参 + 渲染求助开关
    const fnOpts = extractFn(app, 'vmOptionsHtml')
    assert('vmOptionsHtml 接收 rerender 参数', /function vmOptionsHtml\s*\([^)]*rerender/.test(fnOpts))
    assert('vmOptionsHtml 渲染 vm-reveal 求助开关',
      /vm-reveal/.test(fnOpts) && /vmToggleReveal\(this\)/.test(fnOpts))
    assert('求助开关用 data-k + data-r（内联 onclick 定式：不传值）',
      /data-k=/.test(fnOpts) && /data-r=/.test(fnOpts))
    assert('提示语按 vmHideNow 两态切换', /vmHideNow\(q\)/.test(fnOpts) && /vmShowText/.test(fnOpts) && /vmHideText/.test(fnOpts))
    assert('review 模式不渲染提示/开关', /mode !== 'review'/.test(fnOpts))
    // 五个消费方都必须传 rerender，否则求助开关点了不刷新
    assert('练习页接线 renderPracticeQuestion',
      /vmOptionsHtml\(q, ans, submitted \? 'review' : 'live', 'selectOption', 'renderPracticeQuestion'\)/.test(app))
    assert('考试页接线 renderExamQuestion',
      /vmOptionsHtml\(q, ans, 'live', 'examSelect', 'renderExamQuestion'\)/.test(app))
    assert('定级页接线 renderPlacementQuestion',
      /vmOptionsHtml\(q, ans, 'live', 'placementPick', 'renderPlacementQuestion'\)/.test(app))
    assert('挑战页接线 renderChallengeQuiz',
      /vmOptionsHtml\(q, ans, submitted \? 'review' : 'live', pickFn, 'renderChallengeQuiz'\)/.test(SRC.ch))
    assert('线下课接线 courseRenderTake',
      /vmOptionsHtml\(q, ans, showFeedback \? 'review' : 'live', dis, 'courseRenderTake'\)/.test(SRC.course))
    // 五个 rerender 目标函数都真实存在
    assert('renderPracticeQuestion 存在', /^function renderPracticeQuestion\s*\(/m.test(app))
    assert('renderExamQuestion 存在', /^function renderExamQuestion\s*\(/m.test(app))
    assert('renderPlacementQuestion 存在', /^function renderPlacementQuestion\s*\(/m.test(app))
    assert('renderChallengeQuiz 存在', /^function renderChallengeQuiz\s*\(/m.test(SRC.ch))
    assert('courseRenderTake 存在', /^function courseRenderTake\s*\(/m.test(SRC.course))
    // CSS
    assert('style.css 有 .vm-reveal 样式', /\.vm-reveal\s*\{/.test(SRC.css))
    // 自动播放
    const fnAp = extractFn(app, 'autoplayListen')
    assert('autoplayListen 覆盖 voicematch', /voicematch/.test(codeOnly(fnAp)))
    assert('autoplayListen 对 voicematch 播首选项而非题干',
      /visibleOptionIndexes\(q\.options\)/.test(codeOnly(fnAp)) && /speakEnglish\(first\)/.test(codeOnly(fnAp)))
    assert('autoplayListen 对 voicematch 不朗读题干（不得出现 speakEnglish(q.question) 在该分支）', (() => {
      const code = codeOnly(fnAp)
      const vmIdx = code.indexOf("q.type === 'voicematch'")
      const listenIdx = code.indexOf("q.type === 'listen'")
      const vmBranch = code.slice(vmIdx, listenIdx > vmIdx ? undefined : code.length)
      return !/speakEnglish\(q\.question\)/.test(vmBranch)
    })(), codeOnly(fnAp))
  }

  const sb = makeSandbox({})
  const run = c => vm.runInContext(c, sb)

  console.log('\n[一] vmHideOptionText：作答时是否隐藏选项文字（v155 新契约）')
  assert('中文题干（截图那道）→ 隐藏', run(`vmHideOptionText(${JSON.stringify(U1984)})`) === true)
  assert('英文题干 + 选项含题干 → 隐藏（经典辨音题）', run(`vmHideOptionText(${JSON.stringify(SEED)})`) === true)
  assert('英文题干 + 无选项含题干 → 隐藏（只要有题干就是语音题）',
    run('vmHideOptionText({question:"alpha",options:["beta","gamma"]})') === true)
  assert('题干为空 → 显示（脏数据，给文字至少能点）',
    run('vmHideOptionText({question:"",options:["a","b"]})') === false)
  assert('题干只有空白 → 显示', run('vmHideOptionText({question:"   ",options:["a","b"]})') === false)
  assert('q 为 null → 显示（不抛错）', run('vmHideOptionText(null)') === false)
  assert('q 为 undefined → 显示（不抛错）', run('vmHideOptionText(undefined)') === false)
  assert('options 缺失 → 隐藏（有题干就算语音题）', run('vmHideOptionText({question:"menu"})') === true)
  assert('题干含中英混排 → 隐藏', run('vmHideOptionText({question:"菜单 menu",options:["a","b"]})') === true)

  console.log('\n[二] vmRevealOn / vmHideNow：三态（数据形态 × 求助开关）')
  assert('初始：求助开关关闭', run('vmRevealOn(' + JSON.stringify(U1984) + ')') === false)
  assert('初始：实际隐藏', run('vmHideNow(' + JSON.stringify(U1984) + ')') === true)
  assert('无 id 题用题干当键：初始关闭', run(`vmQKey(${JSON.stringify(NOID)})`) === 'reservation')
  assert('有 id 题用 id 当键', run(`vmQKey(${JSON.stringify(U1984)})`) === 'u1984')
  assert('id 为 0 时仍用 id 作键（0 是合法 id，不当成缺省）',
    run('vmQKey({id:0,question:"alpha"})') === '0', run('vmQKey({id:0,question:"alpha"})'))
  assert('id 为 null 时回退到题干作键',
    run('vmQKey({id:null,question:"alpha2"})') === 'alpha2', run('vmQKey({id:null,question:"alpha2"})'))
  assert('id 为 undefined 时回退到题干作键',
    run('vmQKey({question:"alpha3"})') === 'alpha3', run('vmQKey({question:"alpha3"})'))
  assert('id 为空串时回退到题干作键',
    run('vmQKey({id:"",question:"beta"})') === 'beta', run('vmQKey({id:"",question:"beta"})'))
  assert('脏数据（无题干）始终不隐藏，求助开关无关',
    run(`vmHideNow(${JSON.stringify(NOSTEM)})`) === false)

  console.log('\n[三] vmToggleReveal：翻转 + 就地重渲染')
  {
    // 用真实函数名做重渲染目标，观察是否被调用
    run('globalThis.__rerendered = 0; globalThis.__fakeRender = () => { __rerendered++ }')
    run(`vmToggleReveal({dataset:{k:'u1984', r:'__fakeRender'}})`)
    assert('第一次点：开关打开', run('vmRevealOn(' + JSON.stringify(U1984) + ')') === true)
    assert('第一次点：调用了重渲染函数', run('__rerendered') === 1, String(run('__rerendered')))
    assert('打开后不再隐藏', run('vmHideNow(' + JSON.stringify(U1984) + ')') === false)
    run(`vmToggleReveal({dataset:{k:'u1984', r:'__fakeRender'}})`)
    assert('第二次点：开关关闭（可收起）', run('vmRevealOn(' + JSON.stringify(U1984) + ')') === false)
    assert('第二次点：又重渲染一次', run('__rerendered') === 2)
    assert('收起后重新隐藏', run('vmHideNow(' + JSON.stringify(U1984) + ')') === true)
    // 换题自动回到隐藏
    run(`vmToggleReveal({dataset:{k:'u1984', r:'__fakeRender'}})`)
    assert('打开 u1984 后，换到 SEED 题 → 仍是隐藏态',
      run('vmRevealOn(' + JSON.stringify(SEED) + ')') === false
      && run('vmHideNow(' + JSON.stringify(SEED) + ')') === true)
    assert('回头再看 u1984 → 仍是打开态（记忆按题）',
      run('vmRevealOn(' + JSON.stringify(U1984) + ')') === true)
    run(`vmToggleReveal({dataset:{k:'u1984', r:'__fakeRender'}})`)   // 复位
    // 容错
    run('globalThis.__rerendered = 0')
    const before = run('vmRevealStem')
    run('vmToggleReveal(null)')
    assert('null 参数 → 不抛错且状态不变', run('vmRevealStem') === before, String(run('vmRevealStem')))
    run('vmToggleReveal({})')
    assert('无 dataset → 不抛错且状态不变', run('vmRevealStem') === before)
    run(`vmToggleReveal({dataset:{k:'u1984'}})`)
    assert('有 data-k 无 data-r → 翻转状态但不重渲染（不抛错）',
      run('vmRevealOn(' + JSON.stringify(U1984) + ')') === true && run('__rerendered') === 0)
    run(`vmToggleReveal({dataset:{k:'u1984'}})`)   // 复位
    run(`vmToggleReveal({dataset:{k:'u1984', r:'不存在的函数名'}})`)
    assert('data-r 指向不存在的函数 → 不抛错，状态照常翻转',
      run('vmRevealOn(' + JSON.stringify(U1984) + ')') === true)
    run(`vmToggleReveal({dataset:{k:'u1984', r:'不存在的函数名'}})`)  // 复位
    assert('复位完成：开关关闭', run('vmRevealOn(' + JSON.stringify(U1984) + ')') === false)
  }

  console.log('\n[四] vmOptionsHtml 渲染四态')
  {
    // 隐藏态
    const live = run(`vmOptionsHtml(${JSON.stringify(U1984)}, -1, 'live', 'selectOption', 'renderPracticeQuestion')`)
    assert('隐藏态：不渲染选项文字', (live.match(/vm-opt-text/g) || []).length === 0, live.slice(0, 300))
    assert('隐藏态：剥掉 data-w 后正文无选项文本',
      !visibleOnly(live).includes('Here is the menu') && !visibleOnly(live).includes('signature dish'),
      visibleOnly(live).slice(0, 300))
    assert('隐藏态：仍保留朗读所需的 data-w（否则点 🔊 没得播）',
      (live.match(/data-w=/g) || []).length === 9, String((live.match(/data-w=/g) || []).length))
    assert('隐藏态：三个选项各有 🔊 + 两个兜底播放键 + 选择此项',
      (live.match(/vm-play/g) || []).length === 3
      && (live.match(/vm-online/g) || []).length === 6
      && (live.match(/vm-choose/g) || []).length === 3)
    assert('隐藏态：提示语说「选项只播声音」', live.includes('选项只播声音'))
    assert('隐藏态：有求助开关且文案为「听不见？显示文字」',
      live.includes('vm-reveal') && live.includes('听不见？显示文字'))
    assert('隐藏态：开关带正确的 data-k / data-r',
      live.includes('data-k="u1984"') && live.includes('data-r="renderPracticeQuestion"'))
    assert('隐藏态：整行仍可直接点击选择', live.includes('onclick="selectOption(0)"') && live.includes('onclick="selectOption(2)"'))
    assert('隐藏态：「选择此项」绑定对应下标且不冒泡',
      live.includes('event.stopPropagation();selectOption(0)') && live.includes('event.stopPropagation();selectOption(2)'))

    // 展开态
    run(`vmToggleReveal({dataset:{k:'u1984', r:''}})`)
    const open = run(`vmOptionsHtml(${JSON.stringify(U1984)}, -1, 'live', 'selectOption', 'renderPracticeQuestion')`)
    assert('展开态：三个选项文字全部显示', (open.match(/vm-opt-text/g) || []).length === 3)
    assert('展开态：正文可见选项文本（学员能看到）',
      open.includes('>Here is the menu for you.<') && open.includes('>This is our signature dish.<'), open.slice(0, 300))
    assert('展开态：提示语改为「已显示选项文字」', open.includes('已显示选项文字'))
    assert('展开态：开关文案变「收起文字」', open.includes('收起文字') && !open.includes('听不见？显示文字'))
    assert('展开态：仍可点 🔊 复听', (open.match(/vm-play/g) || []).length === 3)
    assert('展开态：仍可「选择此项」', (open.match(/vm-choose/g) || []).length === 3)
    run(`vmToggleReveal({dataset:{k:'u1984', r:''}})`)   // 复位

    // review 态
    const rev = run(`vmOptionsHtml(${JSON.stringify(U1984)}, 1, 'review', null)`)
    assert('review：显示全部选项文字', (rev.match(/vm-opt-text/g) || []).length === 3)
    assert('review：无提示语、无求助开关、无选择按钮',
      !rev.includes('vm-hint') && !rev.includes('vm-reveal') && !rev.includes('vm-choose'))
    assert('review：无行级 onclick', !rev.includes('selectOption('))
    assert('review：正确项标 correct、错选标 wrong',
      rev.includes('option-item vm-option correct') && rev.includes('option-item vm-option wrong'))
    assert('review：正确项徽标 = ✓', rev.includes('<div class="option-badge">✓</div>'))

    // 脏数据态（无题干）
    const bad = run(`vmOptionsHtml(${JSON.stringify(NOSTEM)}, -1, 'live', 'selectOption', 'renderPracticeQuestion')`)
    assert('脏数据：显示选项文字（不隐藏）', (bad.match(/vm-opt-text/g) || []).length === 2)
    assert('脏数据：不给求助开关（没有可隐藏的东西）', !bad.includes('vm-reveal'))
    assert('脏数据：提示语走「已显示选项文字」态', bad.includes('已显示选项文字'))

    // 无 rerender 参数
    const noR = run(`vmOptionsHtml(${JSON.stringify(SEED)}, -1, 'live', 'chPick')`)
    assert('未传 rerender：data-r 为空串（不崩）', noR.includes('data-r=""'), noR.slice(0, 260))
    assert('未传 rerender：仍渲染求助开关', noR.includes('vm-reveal'))
  }

  console.log('\n[五] autoplayListen：voicematch 只播首选项，绝不播题干')
  {
    // 在沙箱内接管 setTimeout 以便观察排入了什么
    run(`
      globalThis.__queued = [];
      globalThis.__realSetTimeout = setTimeout;
      setTimeout = function(fn, ms){ __queued.push({ src: String(fn), ms: ms }); return 0 };
      globalThis.__spoken = [];
      globalThis.__realSpeakEnglish = speakEnglish;
    `)
    const q = n => run(`JSON.stringify(__queued)`).replace(/"/g, '')
    run('__queued = []')
    run(`autoplayListen(${JSON.stringify(U1984)})`)
    assert('voicematch + local：排入 1 个 350ms 任务', run('__queued.length') === 1 && run('__queued[0].ms') === 350, q())
    assert('voicematch：排入的是 speakEnglish(first)，不是题干',
      run('__queued[0].src').includes('speakEnglish(first)'), run('__queued[0].src'))

    run('__queued = []')
    // 还原并真正执行，看朗读的实际文本
    run('setTimeout = __realSetTimeout')
    run(`
      globalThis.__spoken = [];
      globalThis.__spySpeak = speakEnglish;
      speakEnglish = function(t){ __spoken.push(String(t)) };
    `)
    run(`autoplayListen(${JSON.stringify(U1984)})`)
    await new Promise(r => setTimeout(r, 420))
    assert('voicematch 实际朗读文本 = 第一个选项（不是题干）',
      run('JSON.stringify(__spoken)') === JSON.stringify([U1984.options[0]]), run('JSON.stringify(__spoken)'))
    assert('voicematch 绝未朗读题干', !run('JSON.stringify(__spoken)').includes('这是菜单'))

    // online 模式（安卓/无声机型）不自动播
    run('globalThis.__spoken = []; globalThis.__origLVM = listenVoiceMode; listenVoiceMode = function(){ return "online" }')
    run(`autoplayListen(${JSON.stringify(U1984)})`)
    await new Promise(r => setTimeout(r, 420))
    assert('voicematch + online：不自动播（避免页面一进来就发注定失败的请求）',
      run('JSON.stringify(__spoken)') === '[]', run('JSON.stringify(__spoken)'))

    // 已展开文字 → 不自动播
    run('listenVoiceMode = __origLVM')
    run(`vmToggleReveal({dataset:{k:'u1984', r:''}}); __spoken = []`)
    run(`autoplayListen(${JSON.stringify(U1984)})`)
    await new Promise(r => setTimeout(r, 420))
    assert('voicematch：已展开文字则不自动播（学员已放弃听音）',
      run('JSON.stringify(__spoken)') === '[]', run('JSON.stringify(__spoken)'))
    run(`vmToggleReveal({dataset:{k:'u1984', r:''}})`)   // 复位

    // 空选项 → 不自动播
    run('__spoken = []')
    run(`autoplayListen({type:'voicematch', question:'x', options:[]})`)
    await new Promise(r => setTimeout(r, 420))
    assert('voicematch：无可播选项则不自动播', run('JSON.stringify(__spoken)') === '[]')

    // listen 题行为不变（仍播题干）
    run('__spoken = []')
    run(`autoplayListen({type:'listen', question:'May I help you?'})`)
    await new Promise(r => setTimeout(r, 420))
    assert('listen 题：仍朗读题干（行为不变）',
      run('JSON.stringify(__spoken)') === JSON.stringify(['May I help you?']), run('JSON.stringify(__spoken)'))
    // listen + online 仍不播（原契约）
    run('__spoken = []; listenVoiceMode = function(){ return "online" }')
    run(`autoplayListen({type:'listen', question:'hi'})`)
    await new Promise(r => setTimeout(r, 420))
    assert('listen + online：仍不自动播（原契约不变）', run('JSON.stringify(__spoken)') === '[]')
    run('listenVoiceMode = __origLVM')

    // 空题 / null 不抛错
    run('__spoken = []')
    run('autoplayListen(null)')
    run('autoplayListen(undefined)')
    run(`autoplayListen({})`)
    assert('null/undefined/空对象 → 不抛错不朗读', run('JSON.stringify(__spoken)') === '[]')

    // 恢复 speakEnglish
    run('speakEnglish = __spySpeak')
  }

  console.log('\n[六] 五个消费方同口径（练习 / 考试 / 定级 / 挑战 / 线下课）')
  {
    // 练习页
    run(`globalThis.__revealReset = () => { vmRevealStem = '' }`)
    run('__revealReset()')
    run(`practiceState = { questions: [${JSON.stringify(U1984)}], index: 0, answers: [-1], submitted: false, correctCount: 0 }`)
    run('renderPracticeQuestion()')
    const pLive = sb._getEl('practiceQuiz').innerHTML
    assert('练习页 live：不显示选项文字', (pLive.match(/vm-opt-text/g) || []).length === 0, pLive.slice(0, 300))
    assert('练习页 live：有求助开关且回指 renderPracticeQuestion',
      pLive.includes('vm-reveal') && pLive.includes('data-r="renderPracticeQuestion"'))
    assert('练习页 live：剥掉 data-w 后无选项文本',
      !visibleOnly(pLive).includes('Here is the menu'))
    // 提交后回顾 —— 文字必须出现（学员要能看懂对错）
    run('practiceState.submitted = true; practiceState.answers = [1]')
    run('renderPracticeQuestion()')
    const pRev = sb._getEl('practiceQuiz').innerHTML
    assert('练习页提交后：显示选项文字 + 对错',
      (pRev.match(/vm-opt-text/g) || []).length === 3 && pRev.includes('correct') && pRev.includes('wrong'))
    assert('练习页提交后：无求助开关（回顾态不需要）', !pRev.includes('vm-reveal'))

    // 考试页
    run('__revealReset()')
    run(`examState = { phase:'doing', questions: [${JSON.stringify(U1984)}], answers: [-1], currentIndex: 0, flagged: new Set() }`)
    run('renderExamQuestion()')
    const eLive = sb._getEl('page-exam').innerHTML
    assert('考试页 live：不显示选项文字', (eLive.match(/vm-opt-text/g) || []).length === 0, eLive.slice(0, 300))
    assert('考试页 live：可点 examSelect + 有求助开关回指 renderExamQuestion',
      eLive.includes('onclick="examSelect(0)"') && eLive.includes('data-r="renderExamQuestion"'))

    // 定级页
    run('__revealReset()')
    run(`placementState = { phase:'quiz', auto:false, questions: [${JSON.stringify(U1984)}], index: 0, answers: [-1], result: null }`)
    run('renderPlacementQuestion()')
    const plLive = sb._getEl('page-placement').innerHTML
    assert('定级页 live：不显示选项文字', (plLive.match(/vm-opt-text/g) || []).length === 0, plLive.slice(0, 300))
    assert('定级页 live：可点 placementPick + 求助开关回指 renderPlacementQuestion',
      plLive.includes('onclick="placementPick(0)"') && plLive.includes('data-r="renderPlacementQuestion"'))

    // 挑战页（挑战页函数在 challenge.js，注入沙箱）
    run('__revealReset()')
    vm.runInContext(extractFn(SRC.ch, 'chOptionsHtml'), sb)
    const chLive = run(`chOptionsHtml(${JSON.stringify(U1984)}, false, -1, 'chPick')`)
    assert('挑战页 live：不显示选项文字', (chLive.match(/vm-opt-text/g) || []).length === 0, chLive.slice(0, 300))
    assert('挑战页 live：有求助开关回指 renderChallengeQuiz',
      chLive.includes('vm-reveal') && chLive.includes('data-r="renderChallengeQuiz"'))
    assert('挑战页 live：可点 chPick', chLive.includes('onclick="chPick(0)"'))
    const chRev = run(`chOptionsHtml(${JSON.stringify(U1984)}, true, 1, 'chPick')`)
    assert('挑战页回顾（submitted=true）：显示文字', (chRev.match(/vm-opt-text/g) || []).length === 3)

    // 线下课（course-app.js 已装载）
    run('__revealReset()')
    run(`courseQuiz = { phase:'quiz', cid:'c1', aid:'h1', type:'homework', title:'作业', questions:[${JSON.stringify(U1984)}], index:0, answers:[-1], submitted:false, correct:0, startAt: Date.now(), endAt:null, passScore:60 }`)
    run('courseRenderTake()')
    const cLive = sb._getEl('page-course').innerHTML
    assert('线下课 live：不显示选项文字', (cLive.match(/vm-opt-text/g) || []).length === 0, cLive.slice(0, 400))
    assert('线下课 live：有求助开关回指 courseRenderTake',
      cLive.includes('vm-reveal') && cLive.includes('data-r="courseRenderTake"'))
    assert('线下课 live：可点 coursePick', cLive.includes('onclick="coursePick(0)"'))
    run('courseQuiz.answers=[1]; courseQuiz.submitted=true')
    run('courseRenderTake()')
    const cRev = sb._getEl('page-course').innerHTML
    assert('线下课提交后：显示选项文字 + 对错',
      (cRev.match(/vm-opt-text/g) || []).length === 3 && cRev.includes('feedback'))
    run('__revealReset()')
  }

  console.log('\n[七] 求助开关真的能刷新页面（端到端联动）')
  {
    run('__revealReset()')
    run(`practiceState = { questions: [${JSON.stringify(U1984)}], index: 0, answers: [-1], submitted: false, correctCount: 0 }`)
    run('renderPracticeQuestion()')
    const h1 = sb._getEl('practiceQuiz').innerHTML
    assert('点前：练习页无选项文字', (h1.match(/vm-opt-text/g) || []).length === 0)
    // 模拟学员点「听不见？显示文字」——按钮把自身作为 this 传入
    run(`(function(){
      const m = document.getElementById('practiceQuiz').innerHTML.match(/data-k="([^"]*)" data-r="([^"]*)"/)
      vmToggleReveal({ dataset: { k: m[1], r: m[2] } })
    })()`)
    const h2 = sb._getEl('practiceQuiz').innerHTML
    assert('点后：练习页出现选项文字（就地重渲染生效）',
      (h2.match(/vm-opt-text/g) || []).length === 3, h2.slice(0, 300))
    assert('点后：文字内容正确', h2.includes('>Here is the menu for you.<'))
    assert('点后：开关变「收起文字」', h2.includes('收起文字'))
    // 再点收起
    run(`(function(){
      const m = document.getElementById('practiceQuiz').innerHTML.match(/data-k="([^"]*)" data-r="([^"]*)"/)
      vmToggleReveal({ dataset: { k: m[1], r: m[2] } })
    })()`)
    const h3 = sb._getEl('practiceQuiz').innerHTML
    assert('再点：文字收起（可逆）', (h3.match(/vm-opt-text/g) || []).length === 0)
    // 换题自动隐藏
    run(`practiceState = { questions: [${JSON.stringify(U1984)}, ${JSON.stringify(SEED)}], index: 1, answers: [-1,-1], submitted: false, correctCount: 0 }`)
    run('renderPracticeQuestion()')
    const h4 = sb._getEl('practiceQuiz').innerHTML
    assert('换到下一题：自动回到隐藏态', (h4.match(/vm-opt-text/g) || []).length === 0)
  }

  console.log('\n[八] 真实题库端到端：选项文字不可见')
  {
    const sb2 = makeSandbox({})
    const run2 = c => vm.runInContext(c, sb2)
    // ★ 注意 BANK 的真实结构是 { version, categories, questions }（不是 items）
    const arr = JSON.parse(run2(`JSON.stringify(BANK.questions.filter(q => q.type === 'voicematch').slice(0, 6))`))
    assert('种子库存在 voicematch 题（供真实数据抽查）', arr.length > 0, `got ${arr.length}`)
    const total = run2(`BANK.questions.filter(q => q.type === 'voicematch').length`)
    assert('种子库 voicematch 总数 = 71（与 v155 排查口径一致）', total === 71, `got ${total}`)
    let allHidden = true, badq = ''
    for (const q of arr) {
      const html = run2(`vmOptionsHtml(${JSON.stringify(q)}, -1, 'live', 'selectOption')`)
      // 判定：无 vm-opt-text，且剥掉 data-w 后正文不含任何选项文本
      if ((html.match(/vm-opt-text/g) || []).length !== 0) { allHidden = false; badq = 'has vm-opt-text: ' + JSON.stringify(q).slice(0, 160); break }
      const vis = visibleOnly(html)
      const leaked = (q.options || []).find(o => String(o).trim() && vis.includes(String(o).trim()))
      if (leaked) { allHidden = false; badq = 'leaked "' + leaked + '" in ' + JSON.stringify(q).slice(0, 160); break }
    }
    assert('种子库 voicematch 全部作答时隐藏选项文字（真实数据抽查 6 道）', allHidden, badq)
    // 题库体检：这 71 道题干都非空（否则会走「脏数据不隐藏」分支，白给文字）
    assert('种子库 71 道 voicematch 题干全部非空',
      run2(`BANK.questions.filter(q => q.type === 'voicematch' && !String(q.question||'').trim()).length`) === 0)

    // 截图那道题（艳中上传题形态）走完整练习渲染
    run2(`practiceState = { questions: [${JSON.stringify(U1984)}], index: 0, answers: [-1], submitted: false, correctCount: 0 }`)
    run2('renderPracticeQuestion()')
    const real = sb2._getEl('practiceQuiz').innerHTML
    assert('真实通路：题干（中文）可见 —— 学员知道要选什么',
      real.includes('这是菜单，请您过目'), real.slice(0, 300))
    assert('真实通路：三个英文选项文字不可见（核心修复）',
      (real.match(/vm-opt-text/g) || []).length === 0
      && !visibleOnly(real).includes('Here is the menu')
      && !visibleOnly(real).includes('signature dishes'),
      visibleOnly(real).slice(0, 300))
    assert('真实通路：有「听不见？显示文字」兜底入口', real.includes('听不见？显示文字'))
    assert('真实通路：选项 🔊 仍需带 data-w（否则播不出来）—— 3 选项 × 3 键 = 9',
      (real.match(/data-w=/g) || []).length === 9, String((real.match(/data-w=/g) || []).length))
    assert('真实通路：题干不挂播放键（题干是学员要读的文字，读了等于给答案）',
      !real.includes(`data-w="这是菜单`), '')
  }

  console.log('\n[九] i18n 双语键完备')
  {
    const sbI = makeSandbox({})
    const r = c => vm.runInContext(c, sbI)
    const NEWKEYS = ['vmShowText', 'vmHideText', 'vmHint', 'vmHintText', 'vmChoose', 'vmQuestionPh', 'vmEditorHint']
    for (const k of NEWKEYS) {
      assert(`zh：${k} 非空`, r(`t('${k}')`).length > 0, JSON.stringify(r(`t('${k}')`)))
    }
    assert('zh：vmShowText = 听不见？显示文字', r("t('vmShowText')") === '听不见？显示文字')
    assert('zh：vmHint 说明「选项只播声音」', r("t('vmHint')").includes('选项只播声音'))
    assert('zh：vmHint 里保留 🔊 与兜底通道提示',
      r("t('vmHint')").includes('🔊') && r("t('vmHint')").includes('🌐'))
    assert('zh：vmHintText 说明「已显示选项文字」', r("t('vmHintText')").includes('已显示选项文字'))
    assert('zh：vmHint 不再声称「题干为英文文字」（题干可能是中文）',
      !r("t('vmHint')").includes('题干为英文文字'))
    assert('zh：vmEditorHint 保留「作答时不显示文字」（与新语义一致）',
      r("t('vmEditorHint')").includes('作答时不显示文字'))
    assert('zh：vmQuestionPh 说明选项作答时只播声音',
      r("t('vmQuestionPh')").includes('只播声音'))
    r('LANG = "en"')
    for (const k of NEWKEYS) {
      assert(`en：${k} 非空`, r(`t('${k}')`).length > 0, JSON.stringify(r(`t('${k}')`)))
    }
    assert('en：vmShowText 含 Show text', r("t('vmShowText')").includes('Show text'))
    assert('en：vmHint 含 audio only', r("t('vmHint')").includes('audio only'))
    assert('en：vmHintText 非空且区别于 vmHint', r("t('vmHintText')") !== r("t('vmHint')"))
    assert('en：vmHint 不再要求先读英文题干', !r("t('vmHint')").includes('Read the English'))
    r('LANG = "zh"')
    // zh/en 两语言下所有新键都必须能取到值（逐键对照，防漏翻）
    r('LANG = "zh"')
    const zhVals = NEWKEYS.map(k => r(`t('${k}')`))
    r('LANG = "en"')
    const enVals = NEWKEYS.map(k => r(`t('${k}')`))
    assert('zh/en 新键数量一致', zhVals.length === enVals.length)
    assert('zh/en 新键全部非空且两语言内容不同（无漏翻回退到中文）',
      zhVals.every((v, i) => v.length > 0 && enVals[i].length > 0 && v !== enVals[i]),
      JSON.stringify(zhVals.map((v, i) => [v.slice(0, 12), enVals[i].slice(0, 12)])))
    r('LANG = "zh"')
  }

  console.log('\n[十] 版本号已 bump 到 v155')
  {
    const vers = (SRC.html.match(/\?v=(\d+)/g) || []).map(s => +s.slice(3))
    assert('index.html 资源版本号总数为 12', vers.length === 12, `got ${vers.length}`)
    assert('index.html 资源版本号取值唯一', new Set(vers).size === 1, JSON.stringify([...new Set(vers)]))
    assert('index.html 资源版本号 = 155', vers[0] === 155, `got ${vers[0]}`)
  }

  console.log()
  console.log(failed ? '❌ v155 有断言失败' : '✅ v155 测试全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('v155 异常:', e); process.exit(1) })
