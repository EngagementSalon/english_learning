// ====== 测试：v60 在线 TTS 多源降级（有道英/美 + 百度翻译 + 本地合成最终兜底）======
// 背景：v55~v59 迁移 GitHub Pages 后，多台安卓机型反馈听音题无声（原逻辑仅单源有道，接口失效即全哑）。
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

// 可配置的 Audio mock：failPlay=true 时 play() 一律 reject；否则 5ms 后触发 playing 事件
function makeSandbox({ failPlay, voices }) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let playCalls = 0, lastAudio = null, speakCalls = 0, cancelCalls = 0
  const ssObj = {
    getVoices() { return voices },
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
      if (failPlay) return Promise.reject(new Error('mock net fail'))
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

async function main() {
  // ---------- 源码级断言 ----------
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
  assert('在线源含有道英国音 type=1', src.includes("dictvoice?audio=' + q + '&type=1"))
  assert('在线源含有道美国音 type=2', src.includes("dictvoice?audio=' + q + '&type=2"))
  assert('在线源含百度翻译 gettts 兜底', src.includes('fanyi.baidu.com/gettts'))
  assert('有无声看门狗（超时切换下一源）', src.includes('TTS_WATCH_MS') && src.includes('tryNext'))
  assert('全部在线源失败回退本地合成 _speakLocal', src.includes('if (!_speakLocal(txt)) _ttsToast'))
  const i18nSrc = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
  assert('i18n 含 ttsFail 中文词条', i18nSrc.includes("ttsFail: '发音加载失败，请检查网络后重试'"))
  assert('i18n 含 ttsFail 英文词条', i18nSrc.includes("ttsFail: 'Audio failed to load. Check your network and retry.'"))
  const cssSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8')
  assert('style.css 含 tts-toast 提示样式', cssSrc.includes('.tts-toast.show'))

  // ---------- 行为 A：全部在线源失败 → 自动回退本地合成（有英文语音） ----------
  {
    const sb = makeSandbox({ failPlay: true, voices: [{ lang: 'en-US', name: 'Samantha' }] })
    vm.runInContext('playListenOnline("front desk")', sb)
    await sleep(150)
    const p = sb._probe()
    assert('三路在线源均尝试（play ×3）', p.playCalls === 3, 'playCalls=' + p.playCalls)
    assert('在线全败后本地合成兜底（speak ×1）', p.speakCalls === 1, 'speakCalls=' + p.speakCalls)
  }

  // ---------- 行为 B：在线全败且无英文语音 → 显示失败提示 toast ----------
  {
    const sb = makeSandbox({ failPlay: true, voices: [] })
    vm.runInContext('playListenOnline("front desk")', sb)
    await sleep(150)
    const el = sb._getEl('ttsToast')
    assert('全败且本地不可用 → 弹出失败提示', /show/.test(el.className) && /发音|network/i.test(el.textContent), 'className=' + el.className + ' text=' + el.textContent)
  }

  // ---------- 行为 C：首源正常出声 → 不再切换、不触发本地兜底 ----------
  {
    const sb = makeSandbox({ failPlay: false, voices: [{ lang: 'en-US', name: 'Samantha' }] })
    vm.runInContext('playListenOnline("front desk")', sb)
    await sleep(150)
    const p = sb._probe()
    assert('首源出声后停止降级（play ×1）', p.playCalls === 1, 'playCalls=' + p.playCalls)
    assert('首源成功不触发本地合成（speak ×0）', p.speakCalls === 0, 'speakCalls=' + p.speakCalls)
  }

  // ---------- 行为 D：安卓端 speakEnglish 直接走在线链路 ----------
  {
    const sb = makeSandbox({ failPlay: false, voices: [{ lang: 'en-US', name: 'Samantha' }] })
    vm.runInContext('speakEnglish("lobby")', sb)
    await sleep(150)
    const p = sb._probe()
    assert('安卓 speakEnglish → 在线发音（play ×1，不走本地）', p.playCalls === 1 && p.speakCalls === 0, JSON.stringify(p))
  }

  console.log(n + ' assertions, ' + (testFailed ? 'FAILED' : 'ALL PASS'))
  process.exit(testFailed ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
