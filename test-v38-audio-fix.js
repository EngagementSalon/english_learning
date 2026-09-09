// ====== v38 测试：安卓发音修复 + 看字选音无效错答的分数修正 ======
// A. listenVoiceMode：安卓 UA → 'online'；桌面有英文语音 → 'local'
// B. speakEnglish：本地 speak 后无 onstart（静音）→ 1.8s 自动回退在线发音
// C. _fixVoicematchScores：eq_progress 剔除 / eq_exams 重算 / perqfix+examfix 事件 / activity 重算 / 幂等
// D. cloud _apply：perqfix 分母剔除、examfix 聚合修正
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}

// ============ A/B：app.js 语音函数 ============
function makeAudioSandbox({ ua, voices, utterOnstart }) {
  const onlinePlays = []
  const elements = {}
  function mkEl() {
    return { innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '', placeholder: '', value: '', readOnly: false,
      addEventListener() {}, removeEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] },
      classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, remove() {} }
  }
  const getEl = id => elements[id] || (elements[id] = mkEl())
  const utterCtor = function (t) { this.text = t }
  let localSpeaks = 0
  const sb = {
    console, TextEncoder, navigator: { userAgent: ua },
    localStorage: { store: {}, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
    window: {
      addEventListener() {}, scrollTo() {},
      // 真实浏览器 window 即全局：SpeechSynthesisUtterance 须同时挂在 window 上（'in window' 检查）
      SpeechSynthesisUtterance: utterCtor,
      speechSynthesis: {
        getVoices: () => voices || [],
        addEventListener() {},
        cancel() {},
        speak(u) { localSpeaks++; if (utterOnstart) setTimeout(() => u.onstart && u.onstart(), 30) },
      },
    },
    SpeechSynthesisUtterance: utterCtor,
    Audio: function (src) {
      this.src = src || ''
      this.ended = false
      this.play = () => { onlinePlays.push(this.src); return Promise.resolve() }
    },
    document: { getElementById: getEl, querySelector: () => null, querySelectorAll: () => [], createElement: () => mkEl(), body: { appendChild() {} }, title: '', addEventListener() {} },
    alert() {}, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, RegExp, Set, Map, Promise,
    CloudSync: { status: 'online', onStatus() {}, enqueue() {}, pushPending: async () => {}, flushDuration() {}, recalcCloudPlacementLevels: async () => ({}), getDashboardData: async () => ([]) },
    // app.js 末尾 init 会调用多个 Store 方法（init/recalcPlacementLevels/…），用 Proxy 兜底为 no-op
    Store: new Proxy({ getSession() { return { username: 'tester', name: '测试' } } }, {
      get(t, k) { return k in t ? t[k] : function () { return undefined } },
    }),
  }
  sb.globalThis = sb
  vm.createContext(sb)
  return { sb, onlinePlays, getLocalSpeaks: () => localSpeaks }
}

;(async () => {
  console.log('\n🧪 A. listenVoiceMode 平台判定')
  {
    // A1: 安卓 UA → online（即使系统报告有英文语音）
    const { sb } = makeAudioSandbox({ ua: 'Mozilla/5.0 (Linux; Android 14; M2012K11AC) Chrome/120.0 Mobile', voices: [{ lang: 'en-US' }, { lang: 'zh-CN' }] })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sb)
    const m1 = vm.runInContext('listenVoiceMode()', sb)
    assert('安卓 UA（有英文语音）→ online', m1 === 'online', 'got ' + m1)
    // A2: 桌面 Chrome 有英文语音 → local
    const s2 = makeAudioSandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', voices: [{ lang: 'en-US' }, { lang: 'zh-CN' }] })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), s2.sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), s2.sb)
    const m2 = vm.runInContext('listenVoiceMode()', s2.sb)
    assert('桌面有英文语音 → local', m2 === 'local', 'got ' + m2)
    // A3: 桌面无英文语音 → online
    const s3 = makeAudioSandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', voices: [{ lang: 'zh-CN' }] })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), s3.sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), s3.sb)
    const m3 = vm.runInContext('listenVoiceMode()', s3.sb)
    assert('桌面无英文语音 → online', m3 === 'online', 'got ' + m3)
    // A4: v62 起安卓不再跳过本地合成——有英文语音先走本地（onlinePlays=0），无英文语音才在线
    const a4 = makeAudioSandbox({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile', voices: [{ lang: 'en-US' }] })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), a4.sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), a4.sb)
    vm.runInContext('speakEnglish("reservation")', a4.sb)
    await new Promise(r => setTimeout(r, 50))
    assert('安卓 speakEnglish（有英文语音）→ 本地合成优先', a4.onlinePlays.length === 0 && a4.getLocalSpeaks() >= 1, JSON.stringify({ online: a4.onlinePlays, local: a4.getLocalSpeaks() }))
    // A4b: 安卓无英文语音 → 仍直接走在线
    const a4b = makeAudioSandbox({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile', voices: [] })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), a4b.sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), a4b.sb)
    vm.runInContext('speakEnglish("reservation")', a4b.sb)
    await new Promise(r => setTimeout(r, 50))
    assert('安卓 speakEnglish（无英文语音）→ 走发音回退链', a4b.onlinePlays.length === 1 && /^tts\//.test(a4b.onlinePlays[0]), JSON.stringify(a4b.onlinePlays))
    // A5: 桌面 speak 正常触发 onstart → 不回退在线
    const a5 = makeAudioSandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', voices: [{ lang: 'en-US' }], utterOnstart: true })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), a5.sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), a5.sb)
    vm.runInContext('speakEnglish("reservation")', a5.sb)
    await new Promise(r => setTimeout(r, 1900))
    assert('桌面本地发声成功 → 不回退在线', a5.onlinePlays.length === 0, JSON.stringify(a5.onlinePlays))
    // A6: 桌面本地静音（无 onstart）→ 1.8s 后自动回退在线
    const a6 = makeAudioSandbox({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', voices: [{ lang: 'en-US' }], utterOnstart: false })
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), a6.sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), a6.sb)
    vm.runInContext('speakEnglish("reservation")', a6.sb)
    assert('静音后未立即回退（等待期）', a6.onlinePlays.length === 0, JSON.stringify(a6.onlinePlays))
    await new Promise(r => setTimeout(r, 2000))
    assert('1.8s 无 onstart → 自动回退发音链', a6.onlinePlays.length === 1 && /^tts\//.test(a6.onlinePlays[0]), JSON.stringify(a6.onlinePlays))
  }

  console.log('\n🧪 C. _fixVoicematchScores 分数修正')
  const FIX_TS = Date.parse('2026-09-03T15:00:00+08:00')
  const tPre = FIX_TS - 60 * 1000        // 修复前
  const tPost = FIX_TS + 60 * 1000       // 修复后（不修正）
  const cloudQueue = []
  function makeFixSandbox() {
    const ls = {
      // 修复前的 voicematch 错答：2 道练习 + 2 道考试（同一时刻 tExam，对应一场考试）
      'eq_progress': JSON.stringify([
        { id: 'p1', question_id: 525, type: 'voicematch', mode: 'practice', correct: false, timestamp: tPre },
        { id: 'p2', question_id: 526, type: 'voicematch', mode: 'practice', correct: false, timestamp: tPre },
        { id: 'p3', question_id: 525, type: 'voicematch', mode: 'exam', correct: false, timestamp: tExam1 },
        { id: 'p4', question_id: 527, type: 'voicematch', mode: 'exam', correct: false, timestamp: tExam1 + 300 },
        { id: 'p5', question_id: 528, type: 'voicematch', mode: 'practice', correct: false, timestamp: tPost },   // 修复后 → 保留
        { id: 'p6', question_id: 529, type: 'voicematch', mode: 'practice', correct: true, timestamp: tPre },     // 答对 → 保留
        { id: 'p7', question_id: 530, type: 'single', mode: 'practice', correct: false, timestamp: tPre },        // 非 vm → 保留
      ]),
      // 考试卷：40 题对 32（80 分）→ 补回 2 题无效错答 = 34/40 = 85 分
      'eq_exams': JSON.stringify([
        { id: 'e1', score: 80, total: 40, correct: 32, passed: true, timestamp: tExam1 },
        { id: 'e2', score: 50, total: 40, correct: 20, passed: false, timestamp: tExam2 },
      ]),
      'eq_activity': JSON.stringify([
        { id: 'a1', userId: 9, username: 's1', type: 'exam', timestamp: tExam1, data: { score: 80, total: 40, correct: 32, passed: true } },
        { id: 'a2', userId: 9, username: 's1', type: 'login', timestamp: tExam1, data: {} },
      ]),
    }
    const sb = {
      console, TextEncoder, navigator: { userAgent: 'node' },
      localStorage: { store: ls, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } },
      window: { addEventListener() {} },
      document: { addEventListener() {} },
      setInterval() { return 0 }, clearInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
      Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, RegExp, Set, Map, Promise,
      t: (k) => k,
      CloudSync: { status: 'online', onStatus() {}, setUser() {}, pushPending() { return Promise.resolve() }, flushDuration() {},
        enqueue(ev) { cloudQueue.push(ev) } },
    }
    sb.globalThis = sb
    vm.createContext(sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sb)
    return sb
  }
  const tExam1 = tPre, tExam2 = tExam1 + 60000

  {
    const sb = makeFixSandbox()
    // 跑迁移（直接调用，避免依赖 init 全流程）
    vm.runInContext(`Store._fixVoicematchScores(${FIX_TS})`, sb)
    const prog = JSON.parse(sb.localStorage.getItem('eq_progress'))
    assert('4 条无效错答被剔除', prog.length === 3 && !prog.some(p => ['p1', 'p2', 'p3', 'p4'].includes(p.id)), 'n=' + prog.length)
    assert('修复后错答/答对/非vm记录保留', prog.some(p => p.id === 'p5') && prog.some(p => p.id === 'p6') && prog.some(p => p.id === 'p7'), '')
    const exams = JSON.parse(sb.localStorage.getItem('eq_exams'))
    const e1 = exams.find(e => e.id === 'e1')
    const e2 = exams.find(e => e.id === 'e2')
    assert('考试 e1 重算 32+2=34/40 → 85 分', e1 && e1.score === 85 && e1.correct === 34 && e1.passed === true, JSON.stringify(e1))
    assert('修正痕迹 vmFixed=2', e1 && e1.vmFixed === 2, JSON.stringify(e1))
    assert('无错答匹配的考试 e2 不变', e2 && e2.score === 50 && !e2.vmFixed, JSON.stringify(e2))
    const perqfix = cloudQueue.filter(ev => ev.ty === 'perqfix')
    const examfix = cloudQueue.filter(ev => ev.ty === 'examfix')
    assert('perqfix 事件 4 条（2 练习 + 2 考试）', perqfix.length === 4, 'n=' + perqfix.length)
    assert('perqfix 携带 qid', perqfix.every(ev => ev.d.qid > 0 && ev.d.wrongFix === 1), JSON.stringify(perqfix))
    assert('examfix 事件 1 条', examfix.length === 1, 'n=' + examfix.length)
    assert('examfix 80→85 passed 保持', examfix.length === 1 && examfix[0].d.scoreOld === 80 && examfix[0].d.scoreNew === 85 && examfix[0].d.passedOld === true && examfix[0].d.passedNew === true, JSON.stringify(examfix))
    const acts = JSON.parse(sb.localStorage.getItem('eq_activity'))
    const a1 = acts.find(a => a.id === 'a1')
    assert('活动日志 exam 记录重算 → 85 分', a1 && a1.data.score === 85 && a1.data.correct === 34, JSON.stringify(a1 && a1.data))
    // 幂等：再跑一次不重复修正
    const q2 = cloudQueue.length
    vm.runInContext(`Store._fixVoicematchScores(${FIX_TS})`, sb)
    const prog2 = JSON.parse(sb.localStorage.getItem('eq_progress'))
    assert('重复执行无副作用（无错答可剔）', prog2.length === 3 && cloudQueue.length === q2, 'prog=' + prog2.length + ' queue+=' + (cloudQueue.length - q2))
  }

  console.log('\n🧪 D. cloud _apply：perqfix / examfix 聚合')
  {
    const lsStore = {}
    const ls = { store: lsStore, getItem(k) { return this.store[k] || null }, setItem(k, v) { this.store[k] = String(v) }, removeItem(k) { delete this.store[k] } }
    const sb = {
      console, TextEncoder, localStorage: ls,
      window: { addEventListener() {}, dispatchEvent() {} },
      document: { addEventListener() {} },
      setInterval() { return 0 }, clearInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
      TextEncoder, Uint8Array, crypto,
      Date, JSON, Math, String, Number, Array, Object, Promise, Set, Map,
      CloudSync: { status: 'online', onStatus() {}, enqueue() {}, pushPending() { return Promise.resolve() }, setUser() {}, flushDuration() {} },
    }
    sb.globalThis = sb
    vm.createContext(sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sb)
    const out = vm.runInContext(`(() => {
      const map = {}
      const evs = [
        { u: 's1', ty: 'register', d: {} },
        { u: 's1', ty: 'perq', d: { qid: 525, correct: 1 } },
        { u: 's1', ty: 'perq', d: { qid: 525, correct: 0 } },
        { u: 's1', ty: 'exam', d: { score: 80, total: 40, correct: 32, passed: true } },
        { u: 's1', ty: 'perqfix', d: { qid: 525, wrongFix: 1 } },
        { u: 's1', ty: 'examfix', d: { scoreOld: 80, scoreNew: 85, passedOld: true, passedNew: true } },
      ]
      evs.forEach(ev => CloudSync._apply(map, ev))
      return map.s1
    })()`, sb)
    assert('perqfix：qid525 分母 2→1，正确数不变', out.perQ && out.perQ['525'].total === 1 && out.perQ['525'].correct === 1, JSON.stringify(out.perQ))
    assert('examfix：均分 80→85（examCount 不变）', out.examScoreSum === 85 && out.examCount === 1, JSON.stringify({ sum: out.examScoreSum, n: out.examCount }))
    assert('examfix：best 85', out.examBest === 85, 'got ' + out.examBest)
    // 未及格 → 及格修正
    const out2 = vm.runInContext(`(() => {
      const map = {}
      ;[
        { u: 's2', ty: 'register', d: {} },
        { u: 's2', ty: 'exam', d: { score: 55, total: 40, correct: 22, passed: false } },
        { u: 's2', ty: 'examfix', d: { scoreOld: 55, scoreNew: 63, passedOld: false, passedNew: true } },
      ].forEach(ev => CloudSync._apply(map, ev))
      return map.s2
    })()`, sb)
    assert('examfix：55→63 且及格数 +1', out2.examScoreSum === 63 && out2.examPassCount === 1, JSON.stringify({ sum: out2.examScoreSum, pass: out2.examPassCount }))
    // 保护：perqfix 超额剔除不小于 correct
    const out3 = vm.runInContext(`(() => {
      const map = {}
      ;[
        { u: 's3', ty: 'register', d: {} },
        { u: 's3', ty: 'perq', d: { qid: 9, correct: 1 } },
        { u: 's3', ty: 'perq', d: { qid: 9, correct: 1 } },
        { u: 's3', ty: 'perqfix', d: { qid: 9, wrongFix: 5 } },
      ].forEach(ev => CloudSync._apply(map, ev))
      return map.s3.perQ['9']
    })()`, sb)
    assert('perqfix 超额剔除 → total 下限 = correct', out3.total === 2 && out3.correct === 2, JSON.stringify(out3))
  }

  console.log(failed ? '\n❌ 有失败项' : '\n✅ 全部通过')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
