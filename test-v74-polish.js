// ====== 测试 v74：体验打磨四连 ======
// ① 牛排熟度 12 题（cat12，id 8277-8288）：四个选项全为熟度四档（三分熟/五分熟/七分熟/全熟），
//    正确项恒首位（answer [0]，运行时 shuffleOptions 重洗），同词各题释义一致、选项顺序各异
// ② _normSpeakText：斜杠读作停顿（'/' → ', '），speakEnglish / speakLocalForce / playListenOnline 三入口统一规范
// ③ playListenOnline 音频包 key 基于规范化文本（与 gen-tts.js normSpeak 严格一致，带 / 旧 key 自然失效）
// ④ chLbAggregate：学员端挑战页「当前积分榜前三」（与看板同口径：day-si 去重取 at 最早 chy，score=答对×100−用时）
// ⑤ 源码接线：发音按钮 emoji → SVG（audioIconSvg + .ic-svg）、i18n zh/en 成对、gen-tts 同步规范化
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
let n = 0
function assert(name, cond, msg) {
  n++
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function extractFn(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('fn not found: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

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

// 复用 test-v60 的整载沙箱（app.js 全量加载 + Audio mock 记录 src/play）
function makeSandbox() {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let playCalls = 0, lastAudio = null, speakCalls = 0, cancelCalls = 0
  const ssObj = {
    getVoices() { return [] },
    cancel() { cancelCalls++ },
    speak(u) { speakCalls++ },
    addEventListener() {},
  }
  const UtterCls = function (text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null }
  const AudioCls = function () {
    playCalls++; lastAudio = this; this.src = ''; this._h = {}
    this.addEventListener = (ty, fn) => { (this._h[ty] = this._h[ty] || []).push(fn) }
    this.pause = () => {}
    this.removeAttribute = () => {}
    this.play = () => {
      setTimeout(() => { (this._h.playing || []).forEach(f => f()) }, 5)
      return Promise.resolve()
    }
  }
  const sandbox = {
    console,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' },
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
    Store: undefined,
    _getEl: getEl,
    _probe: () => ({ playCalls, speakCalls, cancelCalls, lastAudio }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8'), sandbox)
  vm.runInContext('TTS_WATCH_MS = 30', sandbox)   // 缩短看门狗便于测试
  return sandbox
}

;(async () => {
  console.log('\n🧪 v74 体验打磨测试（熟度选项 / 朗读停顿 / SVG 图标 / 学员端前三）')
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  const chSrc = fs.readFileSync(path.join(__dirname, 'challenge.js'), 'utf-8')
  const cssSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8')
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  const genSrc = fs.readFileSync(path.join(__dirname, 'gen-tts.js'), 'utf-8')

  // ---------- ① 熟度 12 题 ----------
  console.log('\n[1] 牛排熟度 12 题（选项全为熟度四档）')
  const DONE = { 'Medium-rare': '三分熟', 'Medium': '五分熟', 'Medium-well': '七分熟', 'Well-done': '全熟' }
  const DVALS = Object.keys(DONE).map(k => DONE[k])
  {
    const sb = { console, window: {}, document: { addEventListener() {} }, localStorage: { store: {}, getItem() { return null }, setItem() {}, removeItem() {} } }
    vm.createContext(sb)
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'bank-data.js'), 'utf-8'), sb)
    const BANK = vm.runInContext('BANK', sb)
    const q12 = BANK.questions.filter(q => Number(q.category_id) === 12)
    assert('cat12 仍为 684 题（BANK v9）', q12.length === 684 && BANK.version === 9, `got ${q12.length} / v${BANK.version}`)
    const done12 = q12.filter(q => DONE[q.question])
    assert('熟度题共 12 道（4 词 × listen原生/listen改造/single）', done12.length === 12, `got ${done12.length}`)
    assert('12 题全部 4 选项 + answer [0] + 无重复选项', done12.every(q => q.options.length === 4 && JSON.stringify(q.answer) === '[0]' && new Set(q.options).size === 4))
    assert('12 题选项 ⊆ 熟度四档（无主菜/黄油等无关干扰项）', done12.every(q => q.options.every(o => DVALS.includes(o))),
      JSON.stringify(done12.filter(q => !q.options.every(o => DVALS.includes(o))).map(q => [q.id, q.options])))
    assert('正确项恒首位且释义正确（options[0] = 该词熟度）', done12.every(q => q.options[0] === DONE[q.question]),
      JSON.stringify(done12.filter(q => q.options[0] !== DONE[q.question]).map(q => [q.id, q.question, q.options[0]])))
    let perWordOk = true, perWordMsg = ''
    Object.keys(DONE).forEach(w => {
      const g = done12.filter(q => q.question === w)
      const types = g.map(q => q.type).sort().join(',')
      const orders = new Set(g.map(q => JSON.stringify(q.options)))
      if (!(g.length === 3 && types === 'listen,listen,single' && orders.size === 3)) { perWordOk = false; perWordMsg = w + ' → ' + g.map(q => q.id + ':' + q.type).join(' ') }
    })
    assert('每词 3 题型齐全（2 listen + 1 single）且选项顺序各异（防背位置）', perWordOk, perWordMsg)
    assert('同词各题正确释义一致', (() => {
      const g = {}
      done12.forEach(q => { (g[q.question] = g[q.question] || []).push(q.options[q.answer[0]]) })
      return Object.keys(g).every(w => new Set(g[w]).size === 1)
    })())
    assert('12 题解析含熟度四档说明', done12.every(q => (q.explanation || '').includes('熟度四档')))
    assert('熟度题干扰项 ≠ 正确项（中文四档互为干扰）', done12.every(q => q.options.filter(o => o === q.options[q.answer[0]]).length === 1))
  }

  // ---------- ② _normSpeakText ----------
  console.log('\n[2] _normSpeakText 斜杠停顿规范化')
  {
    const sb = { console, String }
    vm.createContext(sb)
    vm.runInContext(extractFn(appSrc, '_normSpeakText'), sb)
    const f = s => vm.runInContext(`_normSpeakText(${JSON.stringify(s)})`, sb)
    assert("'Starter / Appetizer' → 'Starter, Appetizer'", f('Starter / Appetizer') === 'Starter, Appetizer', f('Starter / Appetizer'))
    assert("'a/b' → 'a, b'（紧凑斜杠同样规范化）", f('a/b') === 'a, b')
    assert("'Sauteed  /  Pan-fried' → 'Sauteed, Pan-fried'（多空格收敛）", f('Sauteed  /  Pan-fried') === 'Sauteed, Pan-fried')
    assert("'a / b / c' → 'a, b, c'（多斜杠逐一处理）", f('a / b / c') === 'a, b, c')
    assert("'T-Bone / Tomahawk / Ribeye' → 'T-Bone, Tomahawk, Ribeye'", f('T-Bone / Tomahawk / Ribeye') === 'T-Bone, Tomahawk, Ribeye')
    assert("无斜杠文本原样保留（仅 trim）", f('medium rare') === 'medium rare' && f('  Medium-rare  ') === 'Medium-rare')
    assert("空值安全（null / '' → ''）", f(null) === '' && f('') === '')
    assert("'5oz / 150g.' → '5oz, 150g.'（数字单位分隔同样生效）", f('5oz / 150g.') === '5oz, 150g.')
  }

  // ---------- ③ 音频包 key 与规范化一致 ----------
  console.log('\n[3] playListenOnline 音频 key = _ttsKey(规范化文本)')
  {
    assert("app.js 与 gen-tts.js 使用同一规范化正则", appSrc.includes(".replace(/\\s*\\/\\s*/g, ', ')") && genSrc.includes(".replace(/\\s*\\/\\s*/g, ', ')"))
    assert("gen-tts.js normSpeak 应用于 finalTexts 汇集点（单点覆盖三源）", genSrc.includes('normSpeak(t)') && genSrc.includes('finalTexts = [...new Set([...uniq, ...texts].map(t => normSpeak(t)).filter(Boolean))]'))
    const sb = makeSandbox()
    vm.runInContext(`playListenOnline('Starter / Appetizer')`, sb)
    await sleep(150)
    const p = sb._probe()
    const expectKey = vm.runInContext(`_ttsKey(_normSpeakText('Starter / Appetizer'))`, sb)
    const rawKey = vm.runInContext(`_ttsKey('Starter / Appetizer')`, sb)
    assert("首源音频 src = tts/<规范化 key>.mp3", p.playCalls === 1 && p.lastAudio.src === 'tts/' + expectKey + '.mp3', 'src=' + p.lastAudio.src + ' expect=tts/' + expectKey + '.mp3')
    assert("规范化确实改变 key（带 / 旧包自然失效，CI 自动补新）", rawKey !== expectKey)
    assert("三入口统一走 _normSpeakText（speakEnglish/speakLocalForce/playListenOnline）",
      (appSrc.match(/_normSpeakText\(/g) || []).length === 4 && appSrc.includes('const txt = _normSpeakText(text).slice(0, 260)') && appSrc.includes('text = _normSpeakText(text)') && appSrc.includes('!_speakLocal(_normSpeakText(text), true)'),
      'count=' + (appSrc.match(/_normSpeakText\(/g) || []).length)
    assert("空文本规范化后不再发起播放（防脏 key）", vm.runInContext(`(function(){ playListenOnline('  /  '); return true })()`, sb) === true)
  }

  // ---------- ④ 学员端积分榜前三（与看板同口径） ----------
  console.log('\n[4] chLbAggregate 当前前三聚合')
  {
    const sb = { console, Math, JSON, Object, Array, String, Number }
    vm.createContext(sb)
    vm.runInContext(extractFn(chSrc, 'chLbAggregate'), sb)
    const rows = [
      {
        username: 'bob', name: '小王', dept: 'dining',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 16, total: 20, at: 100, usedSec: 120 },
          { day: 1, si: 1, kind: 'practice', correct: 25, total: 30, at: 101, usedSec: 200 },
          { day: 1, si: 1, kind: 'practice', correct: 30, total: 30, at: 103, usedSec: 60 },   // 重练：不计积分
          { day: 2, si: 0, kind: 'practice', correct: 40, total: 50, at: 200, usedSec: 300 },
        ],
      },
      {
        username: 'carol', name: '小李', dept: 'rooms',
        chy: [
          { day: 1, si: 0, kind: 'test', correct: 8, total: 20, at: 100, usedSec: 480 },
          { day: 7, si: 0, kind: 'practice', correct: 30, total: 30, at: 500, usedSec: 260 },
          { day: 7, si: 1, kind: 'test', correct: 18, total: 20, at: 501, usedSec: 150 },
        ],
      },
    ]
    const top = vm.runInContext(`chLbAggregate(${JSON.stringify(rows)})`, sb)
    assert('bob 7480（81 对×100−620s，重练 30 对/60s 不计）', top[0].username === 'bob' && top[0].score === 7480 && top[0].correct === 81 && top[0].sec === 620, JSON.stringify(top[0]))
    assert('carol 4710（56 对×100−890s）', top[1].username === 'carol' && top[1].score === 4710 && top[1].correct === 56 && top[1].sec === 890, JSON.stringify(top[1]))
    assert('积分降序（🥇bob 在前）', top[0].score > top[1].score)
    // slice 3 + 同分按用时升序
    const rows4 = rows.concat([{ username: 'dave', name: '老张', chy: [{ day: 1, si: 0, correct: 80, total: 100, at: 1, usedSec: 520 }] }])   // 7480 分 / 520s → 同分先于 bob
    const top3 = vm.runInContext(`chLbAggregate(${JSON.stringify(rows4)})`, sb)
    assert('只取前三（第 4 人 carol 被截断）', top3.length === 3 && top3.map(x => x.username).join(',') === 'dave,bob,carol', JSON.stringify(top3.map(x => x.username)))
    assert('同分按用时升序（dave 520s 先于 bob 620s）', top3[0].username === 'dave' && top3[0].score === 7480 && top3[0].sec === 520)
    // 同分同秒比答对数
    const rowsTie = [
      { username: 'nina', name: 'N', chy: [{ day: 1, si: 0, correct: 50, total: 60, at: 1, usedSec: 100 }] },   // 5000 分 / 100s
      { username: 'mike', name: 'M', chy: [{ day: 1, si: 0, correct: 51, total: 60, at: 1, usedSec: 100 }] },   // 5000 分 / 100s
    ]
    const tie = vm.runInContext(`chLbAggregate(${JSON.stringify(rowsTie)})`, sb)
    assert('同分同秒比答对数（mike 51 对先于 nina 50 对）', tie[0].username === 'mike' && tie[1].username === 'nina', JSON.stringify(tie.map(x => x.username)))
    assert('无 chy / 空 rows / null 安全（返回空数组）', vm.runInContext(`chLbAggregate([]).length === 0 && chLbAggregate([{ username: 'x' }]).length === 0 && chLbAggregate(null).length === 0`, sb))
    assert('无姓名学员回退 username', vm.runInContext(`chLbAggregate([{ username: 'jack', chy: [{ day: 1, si: 0, correct: 10, total: 10, at: 1, usedSec: 0 }] }])[0].name === 'jack'`, sb))
  }

  // ---------- ⑤ 源码接线 ----------
  console.log('\n[5] 源码接线（SVG 图标 / i18n / 挑战页积分榜）')
  {
    assert('audioIconSvg 定义 + 9 处调用（quiz 3 + vm 3 + 考试回顾 3）', (appSrc.match(/audioIconSvg\(/g) || []).length === 10, 'count=' + (appSrc.match(/audioIconSvg\(/g) || []).length)
    assert('challenge.js 回顾按钮同样用 SVG（3 处）', (chSrc.match(/audioIconSvg\(/g) || []).length === 3, 'count=' + (chSrc.match(/audioIconSvg\(/g) || []).length)
    assert('SVG 固定 viewBox + currentColor（随按钮字号缩放不变形）', appSrc.includes('<svg class="ic-svg" viewBox="0 0 24 24"') && appSrc.includes('aria-hidden="true"'))
    assert('发音按钮不再使用 emoji 图标（app.js / challenge.js）',
      !appSrc.includes('>🔊</button>') && !appSrc.includes('>🔉</button>') && !appSrc.includes('>🌐</button>') &&
      !chSrc.includes('>🔊</button>') && !chSrc.includes('>🔉</button>') && !chSrc.includes('>🌐</button>'))
    assert('style.css 含 .ic-svg（1em 等比 + fill:currentColor）', cssSrc.includes('.ic-svg { width:1em; height:1em; fill:currentColor; display:inline-block; vertical-align:-0.12em; }'))
    assert('challenge.js 积分榜：聚合/渲染/填充/加载四函数齐备', chSrc.includes('function chLbAggregate') && chSrc.includes('function chLbRowsHtml') && chSrc.includes('function chLbFill') && chSrc.includes('async function chLoadLeaderboard'))
    assert('challenge.js 挑战主页渲染积分榜卡（chLbBody + 60s 缓存）', chSrc.includes('id="chLbBody"') && chSrc.includes('chLoadLeaderboard()') && chSrc.includes('< 60000'))
    assert('积分榜空态与规则文案接 i18n', chSrc.includes("t('chLbEmpty')") && chSrc.includes("t('chLbTitle')") && chSrc.includes("t('chLbRule')"))
    ;['chLbTitle', 'chLbEmpty', 'chLbRule'].forEach(k => {
      const cnt = (i18nSrc.match(new RegExp(k + ':', 'g')) || []).length
      assert(`i18n ${k} zh/en 成对（恰好 2 处）`, cnt === 2, 'count=' + cnt)
    })
    assert('i18n 中文文案正确', i18nSrc.includes("chLbTitle: '当前积分榜前三'") && i18nSrc.includes("chLbEmpty: '还没有学员完成挑战环节，快来做第一个！'") && i18nSrc.includes("chLbRule: '答对越多、用时越短，积分越高'"))
    assert('i18n 英文文案正确', i18nSrc.includes("chLbTitle: 'Current Top 3'") && i18nSrc.includes("chLbEmpty: 'No one has finished a challenge stage yet — be the first!'") && i18nSrc.includes("chLbRule: 'More correct answers in less time scores higher'"))
    assert('app.js 看板积分榜（v73）未回退', appSrc.includes('lbScore') && i18nSrc.includes("dashChRankTitle: '七天挑战积分榜'"))
  }

  console.log('\n' + n + ' assertions, ' + (testFailed ? '❌ FAILED' : '✅ ALL PASS'))
  process.exit(testFailed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
