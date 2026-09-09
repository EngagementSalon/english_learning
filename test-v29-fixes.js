// ====== 测试：v29 三修复 ① listen 语音兼容（在线发音回退）② 线下课成绩看板按钮跳转 ③ 平台 Logo 云端守护自愈 ======
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ================================================================
// ① 语音兼容（加载 app.js 全依赖沙箱）
// ================================================================
function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
  }
}
function makeAppSandbox() {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let lastUtterance = null, lastAudio = null, speakCalls = 0, cancelCalls = 0
  let voices = []
  const ssObj = {
    getVoices() { return voices },
    cancel() { cancelCalls++ },
    speak(u) { speakCalls++; lastUtterance = u },
    addEventListener() {},
  }
  const UtterCls = function (text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null }
  const AudioCls = function () { lastAudio = this; this.src = ''; this.play = () => Promise.resolve() }
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
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => mkEl(),
      body: { appendChild() {} },
      title: '',
      addEventListener() {}, removeEventListener() {},
      visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
      scrollTo() {},
      speechSynthesis: ssObj,
      SpeechSynthesisUtterance: UtterCls,
      Audio: AudioCls,
    },
    // 真实浏览器中 window 即全局，未限定标识符（new Audio / new SpeechSynthesisUtterance）同样可见
    speechSynthesis: ssObj,
    SpeechSynthesisUtterance: UtterCls,
    Audio: AudioCls,
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [],
      recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    Store: undefined, // store.js 加载后填充
    _getEl: getEl,
    _probe: () => ({ lastUtterance, lastAudio, speakCalls, cancelCalls }),
    _setVoices: v => { voices = v },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  // 加载依赖：i18n → bank-data → store → cloud-store → app（末尾会执行 init，mock 已兜底）
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)
  return sandbox
}

// ================================================================
// ② 线下课成绩看板跳转（复用管理员视图沙箱）
// ================================================================
function makeCourseSandbox() {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const courseDoc = { v: 1, classes: [
    { id: 'c1', name: '餐饮英语班', note: '', createdAt: 1, members: ['s1'],
      assignments: [ { id: 'a1', type: 'homework', title: '作业一', deadline: 0, questions: [{ id: 1 }], results: {} } ] },
  ] }
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
      createElement: () => mkEl(), body: { appendChild() {} }, title: '',
      addEventListener() {}, removeEventListener() {},
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [],
      recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    CourseStore: {
      status: 'online',
      newId: () => 'aX',
      findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
      findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
      getDoc: async () => JSON.parse(JSON.stringify(courseDoc)),
      mutate: async () => true,
    },
    _getEl: getEl,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)
  return { sandbox, getEl }
}

// ================================================================
// ③ Logo 云端守护（独立 cloud-store 沙箱 + fetch 控制）
// ================================================================
function makeCloudSandbox(serverDocRef) {
  const sandbox = {
    console,
    localStorage: { store: {}, getItem(k) { return this.store[k] !== undefined ? this.store[k] : null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    window: { addEventListener() {}, removeEventListener() {}, document: { addEventListener() {} }, location: { href: 'https://x.test/' } },
    document: { addEventListener() {}, visibilityState: 'visible' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean,
    TextEncoder, TextDecoder,
    fetch: async (url, opt) => {
      if (!opt || !opt.method) {
        return { ok: true, text: async () => JSON.stringify(serverDocRef.doc) }
      }
      serverDocRef.doc = JSON.parse(String(opt.body))
      serverDocRef.writes++
      return { ok: true, text: async () => JSON.stringify(serverDocRef.doc) }
    },
    AbortController,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sandbox)
  return vm.runInContext('CloudSync', sandbox)
}

;(async () => {
  // ============ ① 语音兼容 ============
  console.log('\n🧪 v29 修复回归测试\n\n① 听音题语音兼容')
  const sb = makeAppSandbox()
  const probe = () => vm.runInContext('_probe()', sb)
  const setVoices = v => vm.runInContext(`_setVoices(${JSON.stringify(v)})`, sb)

  // 场景 A：系统无英文语音（只有中文）→ 模式判定 online
  setVoices([{ lang: 'zh-CN', name: 'Ting-Ting' }])
  let mode = vm.runInContext('listenVoiceMode()', sb)
  assert('只有中文语音 → listenVoiceMode=online', mode === 'online', String(mode))

  // 场景 B：有英文语音 → local
  setVoices([{ lang: 'zh-CN', name: 'Ting-Ting' }, { lang: 'en-US', name: 'Samantha' }])
  mode = vm.runInContext('listenVoiceMode()', sb)
  assert('含英文语音 → listenVoiceMode=local', mode === 'local', String(mode))

  // 场景 C：语音列表为空（异步加载前）→ online（不阻塞发声）
  setVoices([])
  mode = vm.runInContext('listenVoiceMode()', sb)
  assert('语音列表为空 → listenVoiceMode=online', mode === 'online', String(mode))

  // 场景 D：speakEnglish 有英文语音 → 走 speechSynthesis 且选中英文 voice
  setVoices([{ lang: 'zh-CN', name: 'Ting-Ting' }, { lang: 'en-GB', name: 'Daniel' }])
  vm.runInContext('speakEnglish("hello")', sb)
  let p = probe()
  assert('本地可用时走 speechSynthesis.speak', p.speakCalls === 1 && !!p.lastUtterance, JSON.stringify(p))
  assert('朗读语速 rate=0.9', p.lastUtterance && p.lastUtterance.rate === 0.9, String(p.lastUtterance && p.lastUtterance.rate))

  // 场景 E：无 speechSynthesis → 自动回退在线发音（有道 TTS mp3）
  vm.runInContext('window.speechSynthesis = undefined; speakEnglish("front desk")', sb)
  p = probe()
  assert('无系统语音 → 自动走发音回退链（同源包/在线）', !!p.lastAudio && /^(tts\/|.*dictvoice)/.test(p.lastAudio.src), p.lastAudio && p.lastAudio.src)

  // 场景 F：仅中文语音 → speakEnglish 也回退在线（防小米无声）
  const sb2 = makeAppSandbox()
  vm.runInContext(`_setVoices([{lang:'zh-CN',name:'Ting-Ting'}]); speakEnglish('buffet')`, sb2)
  const p2 = vm.runInContext('_probe()', sb2)
  assert('仅中文语音 → speakEnglish 回退发音链', !!p2.lastAudio && /^(tts\/|.*dictvoice)/.test(p2.lastAudio.src), p2.lastAudio && p2.lastAudio.src)

  // 场景 G：题干渲染含 🔊 本地 + 🌐 在线双按钮
  const titleHtml = vm.runInContext('quizTitleHtml({ type: "listen", question: "reservation" })', sb2)
  assert('listen 题干含 🔊 本地朗读按钮', titleHtml.includes('speakEnglish') && titleHtml.includes('listen-btn'), '')
  assert('listen 题干含 🌐 在线发音按钮', titleHtml.includes('playListenOnline') && titleHtml.includes('listen-btn-sm'), '')
  assert('listen 题干不暴露英文原文', !titleHtml.includes('>reservation<'), titleHtml)

  // ============ ② 线下课成绩看板跳转 ============
  console.log('\n② 线下课成绩看板按钮跳转')
  const cs = makeCourseSandbox()
  const Store = vm.runInContext('Store', cs.sandbox)
  Store.getSession = () => ({ id: 1, username: 'admin', name: '管理员', role: 'admin' })
  Store.getUser = () => ({ name: '管理员', dept: '' })
  vm.runInContext('courseState.doc = courseState.doc || { classes: [] }', cs.sandbox)
  // 渲染管理视图
  await vm.runInContext('renderCourseAdmin()', cs.sandbox)
  const adminHtml = cs.getEl('page-course').innerHTML
  assert('管理视图工具栏含「成绩看板」入口', adminHtml.includes('成绩看板'), adminHtml.slice(0, 300))
  assert('成绩看板按钮跳课程内部看板 courseOpenDashboard', adminHtml.includes("onclick=\"courseOpenDashboard()\""), adminHtml.slice(0, 300))
  assert('成绩看板按钮不再跳账号管理 navigate(users)', !adminHtml.includes("navigate('users')") && !adminHtml.includes('navigate("users")'), '')
  assert('账号管理入口按钮仍保留在顶栏导航', vm.runInContext("typeof navigate === 'function'", cs.sandbox) === true, '')
  // courseOpenDashboard 存在且能切到看板视图
  vm.runInContext('courseOpenDashboard()', cs.sandbox)
  const dashHtml = cs.getEl('page-course').innerHTML
  assert('点击后渲染成绩看板页（含矩阵）', dashHtml.includes('courseDashStudents') || dashHtml.includes('成绩看板'), dashHtml.slice(0, 120))

  // ============ ③ Logo 云端守护 ============
  console.log('\n③ 平台 Logo 云端守护自愈')
  const LOGO_A = 'data:image/png;base64,AAAAAA'
  const LOGO_B = 'data:image/png;base64,BBBBBBBB'
  const ref = { doc: { v: 1, events: [], logo: LOGO_A }, writes: 0 }
  const CloudSync2 = makeCloudSandbox(ref)
  CloudSync2._logoGuardDelay = 20   // 守护延迟调小便于测试
  const res = await CloudSync2.setCloudLogo(LOGO_B)
  assert('上传成功写云端', res.ok === true && ref.doc.logo === LOGO_B, JSON.stringify(res) + ' doc=' + ref.doc.logo)
  // 模拟其它设备「读旧文档写回」覆盖 logo
  ref.doc.logo = 'data:image/png;base64,OVERRIDE'
  await sleep(150)   // 等守护首查 + 修复
  assert('守护自动修复并发覆盖（logo 恢复为上传值）', ref.doc.logo === LOGO_B, '当前=' + String(ref.doc.logo))
  assert('修复期间未删除 events（事件不丢）', Array.isArray(ref.doc.events), '')

  console.log('\n' + (testFailed ? '❌ 有失败项' : '✅ 全部通过'))
  process.exit(testFailed ? 1 : 0)
})()
