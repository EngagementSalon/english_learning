// ====== 测试：v138 微信内置浏览器 TTS 失败提示专属文案 ======
// 背景：微信 webview（iOS WKWebView / 安卓 XWeb）普遍不暴露 speechSynthesis，
// 「系统语音」最终兜底失效；在线 4 源（tts 包 / 有道 ×2 / 百度）全挂时，
// 旧文案「发音加载失败，请检查网络后重试」对微信场景是误导 —— 正确指引是
// 「点右上角 ··· 选『在浏览器打开』，或换手机流量再试」。
// 实现：app.js 新增 _isWeChat()（UA 含 MicroMessenger），_ttsToast 按环境选 ttsFailWeChat / ttsFail。
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

// Audio mock：failPlay=true 时 play() 一律 reject（模拟 4 源全挂）；否则 5ms 后触发 playing
function makeSandbox(ua, failPlay) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let playCalls = 0, speakCalls = 0
  const ssObj = {
    getVoices() { return [] },
    cancel() {},
    speak() { speakCalls++ },
    addEventListener() {},
  }
  const UtterCls = function (text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null }
  const AudioCls = function () {
    playCalls++; this.src = ''; this._h = {}
    this.addEventListener = (ty, fn) => { (this._h[ty] = this._h[ty] || []).push(fn) }
    this.pause = () => {}
    this.removeAttribute = () => {}
    this.play = () => {
      if (failPlay) return Promise.reject(new Error('mock net fail'))
      setTimeout(() => { (this._h.playing || []).forEach(f => f()) }, 5)
      return Promise.resolve()
    }
  }
  const sandbox = {
    console,
    navigator: { userAgent: ua },
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
    _probe: () => ({ playCalls, speakCalls }),
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

// 靠 vm 真跑 i18n 取词条（v137 教训：别用正则猜 zh/en 块）
function loadI18N() {
  const sb = { console, globalThis: {} }
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8') + ';globalThis.__I18N = I18N;', sb)
  return vm.runInContext('globalThis.__I18N', sb)
}

async function main() {
  // ---------- §A 源码级 ----------
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  assert('新增 _isWeChat()（UA 检测 MicroMessenger）', src.includes('function _isWeChat') && src.includes('/MicroMessenger/i'))
  assert('调用点接线：按环境二选一提示', src.includes("_ttsToast(_isWeChat() ? t('ttsFailWeChat') : t('ttsFail'))"),
    'app.js 里没有精确接线串')
  assert('旧的无条件调用已清除（代码行，非注释）',
    src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      .indexOf("if (!_speakLocal(txt, true)) _ttsToast(t('ttsFail'))") < 0)

  const I = loadI18N()
  assert('i18n.zh.ttsFailWeChat 已定义（字符串、非空、≠ ttsFail）',
    typeof I.zh.ttsFailWeChat === 'string' && I.zh.ttsFailWeChat.length > 0 && I.zh.ttsFailWeChat !== I.zh.ttsFail)
  assert('中文文案含可执行指引（浏览器打开 / 流量）',
    I.zh.ttsFailWeChat.indexOf('在浏览器打开') >= 0 && I.zh.ttsFailWeChat.indexOf('流量') >= 0,
    I.zh.ttsFailWeChat)
  assert('i18n.en.ttsFailWeChat 已定义（≠ en ttsFail）',
    typeof I.en.ttsFailWeChat === 'string' && I.en.ttsFailWeChat.length > 0 && I.en.ttsFailWeChat !== I.en.ttsFail)
  assert('英文文案含可执行指引（Open in browser / mobile data）',
    /Open in browser/.test(I.en.ttsFailWeChat) && /mobile data/.test(I.en.ttsFailWeChat), I.en.ttsFailWeChat)
  assert('zh/en 均保留原 ttsFail（非微信场景不变）',
    typeof I.zh.ttsFail === 'string' && typeof I.en.ttsFail === 'string')

  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')
  assert('index.html ?v=138 ×12', (html.match(/\?v=138/g) || []).length === 12)
  assert('index.html 无 ?v=137 残留', html.indexOf('?v=137') < 0)

  // ---------- §B 行为：微信 UA + 4 源全挂 + 无系统语音 → 弹微信专属文案 ----------
  const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49'
  {
    const sb = makeSandbox(WECHAT_UA, true)
    vm.runInContext('window.speechSynthesis = undefined; speechSynthesis && (speechSynthesis = undefined)', sb)
    vm.runInContext('playListenOnline("welcome to the banquet")', sb)
    await sleep(150)
    const el = sb._getEl('ttsToast')
    assert('微信内全源失败 → 弹 ttsFailWeChat 专属文案',
      /show/.test(el.className) && el.textContent === vm.runInContext("t('ttsFailWeChat')", sb),
      'className=' + el.className + ' text=' + el.textContent)
    assert('微信文案确实指向「在浏览器打开」', el.textContent.indexOf('在浏览器打开') >= 0, el.textContent)
  }

  // ---------- §C 行为：非微信 UA 同样场景 → 保持原文案（回归保护） ----------
  {
    const sb = makeSandbox('Mozilla/5.0 (Linux; Android 14) Chrome/120', true)
    vm.runInContext('window.speechSynthesis = undefined; speechSynthesis && (speechSynthesis = undefined)', sb)
    vm.runInContext('playListenOnline("welcome to the banquet")', sb)
    await sleep(150)
    const el = sb._getEl('ttsToast')
    assert('非微信全源失败 → 仍是原 ttsFail 文案',
      /show/.test(el.className) && el.textContent === vm.runInContext("t('ttsFail')", sb),
      'text=' + el.textContent)
  }

  // ---------- §D 行为：微信 UA 但首源成功 → 不弹任何提示 ----------
  {
    const sb = makeSandbox(WECHAT_UA, false)
    vm.runInContext('playListenOnline("lobby")', sb)
    await sleep(150)
    const el = sb._getEl('ttsToast')
    assert('微信内首源出声 → 不弹提示', !/show/.test(el.className), 'className=' + el.className)
  }

  console.log(n + ' assertions, ' + (testFailed ? 'FAILED' : 'ALL PASS'))
  process.exit(testFailed ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
