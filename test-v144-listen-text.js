// ====== 测试 v144：听音题朗读文本清洗 + 无语音引擎机型自救 ======
// 背景（红米 K90 现场）：「考试里做不了语音题，提示本设备没有可用的语音引擎」。
// 根因两条：
//   ① 云端课库新导入的听音题题干形如「听音：<英文原文> 选出正确中文。」——中文指令与要朗读的
//      英文挤在同一个 question 字段，旧逻辑整句送去朗读 → 英文引擎硬读中文（杂音/失败），
//      且同源音频包 key 基于整句 → 永远命中不了（网络不通时彻底无声）。
//   ② 设备根本没有 speechSynthesis（红米等 WebView）时，点 🔉 只弹「本设备没有可用的语音引擎」，
//      学员既听不懂也无法自救。
// 实现：app.js `_pickEnText`（提取英文片段，切不出则回退原文）+ `_normSpeakText` 走它；
//      `speakLocalForce` 无引擎时自动改用在线发音并提示已切换；gen-tts.js 同步同口径（key 必须一致）。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
let pass = 0
function assert(name, cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { console.log('  ✗ ' + name + (msg ? '  — ' + msg : '')); testFailed = true }
}
const countOf = (s, needle) => s.split(needle).length - 1

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

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8')
const GEN = fs.readFileSync(path.join(__dirname, 'gen-tts.js'), 'utf-8')
const I18N_SRC = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf-8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

// 只注入被测函数 + 桩：能精确控制「有没有 speechSynthesis」
function mkSb(opts) {
  opts = opts || {}
  const calls = { online: 0, local: 0, toast: [] }
  const sb = {
    console,
    window: {},
    document: { getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    setTimeout: (f) => { try { f() } catch (e) {} return 0 }, clearTimeout() {},
    _calls: calls,
    _ttsToast: (m) => calls.toast.push(m),
    _speakLocal: (t, f) => { calls.local++; return !!opts.localOk },
    playListenOnline: () => { calls.online++ },
    t: (k) => 'T:' + k,
  }
  sb.globalThis = sb
  if (opts.noEngine) { /* 红米等：window 上根本没有 speechSynthesis */ }
  else {
    sb.window.speechSynthesis = { cancel() {}, speak() {}, getVoices: () => [] }
    sb.window.SpeechSynthesisUtterance = function () {}
  }
  vm.createContext(sb)
  vm.runInContext(extractFn(APP, '_pickEnText'), sb)
  vm.runInContext(extractFn(APP, '_normSpeakText'), sb)
  vm.runInContext(extractFn(APP, 'speakLocalForce'), sb)
  return sb
}
const pick = (s) => vm.runInContext('_pickEnText', mkSb())(s)
const norm = (s) => vm.runInContext('_normSpeakText', mkSb())(s)

console.log('\n🧪 v144 听音题朗读文本清洗 + 无引擎自救\n')

// ---------- ① 源码级：定义与接线 ----------
console.log('[1] 源码接线')
assert('app.js 定义 _pickEnText', APP.includes('function _pickEnText'))
assert('_normSpeakText 走英文片段提取（接线）',
  /function _normSpeakText\(s\) \{\s*\n\s*return _pickEnText\(s\)/.test(APP),
  '未在 _normSpeakText 内调用 _pickEnText')
assert('gen-tts.js 同步同口径（否则音频包 key 永远对不上）',
  GEN.includes('function pickEnText') && /const normSpeak = s => pickEnText\(s\)/.test(GEN))
assert('gen-tts 与 app 的提取规则字面量一致（中文字符类）',
  GEN.includes('\\u4e00-\\u9fa5') && APP.includes('\\u4e00-\\u9fa5'))
assert('客户端提取规则改写后仍只读 question（不引入新数据依赖）',
  APP.includes('function _pickEnText') && !APP.includes("q.audio"))

// ---------- ② _pickEnText 行为 ----------
console.log('\n[2] 英文片段提取规则')
assert('听音题干 → 只留英文原文',
  pick('听音：Do you have a reservation? 选出正确中文。') === 'Do you have a reservation',
  '得到: ' + pick('听音：Do you have a reservation? 选出正确中文。'))
assert('长听音题干 → 完整英文句',
  pick("听音：Hello! Welcome to WETBAR, I'm Eric. May I have your names please? 选出正确中文。")
    === "Hello! Welcome to WETBAR, I'm Eric. May I have your names please")
assert('「选出正确英文」尾注同样剥掉',
  pick('听音：Ladies first. 选出正确英文。') === 'Ladies first')
assert('纯英文文本原样返回（不误伤题库既有文本）', pick('Starter / Appetizer') === 'Starter / Appetizer')
assert('纯英文长句原样', pick('May I have your phone number, please?') === 'May I have your phone number, please?')
assert('纯中文题干回退原文（不变成空 → 点了没反应）',
  pick('以下哪个发音时询问客人姓名？') === '以下哪个发音时询问客人姓名？')
assert('中英混排取最长英文片段',
  pick('客人说："Yes, very good." 服务员应该说什么？') === 'Yes, very good')
assert('空值安全', pick('') === '' && pick(null) === '' && pick(undefined) === '')

// ---------- ③ _normSpeakText：提取 + 斜杠规范化 ----------
console.log('\n[3] 规范化（提取 + 斜杠停顿）')
assert('听音题干含斜杠 → 英文片段 + 斜杠转逗号',
  norm('听音：Starter / Appetizer 选出正确中文。') === 'Starter, Appetizer',
  '得到: ' + norm('听音：Starter / Appetizer 选出正确中文。'))
assert('v74 既有行为回归（无中文的斜杠文本）', norm('Bill / Check') === 'Bill, Check')
assert('真实云端听音题样本（WETBAR）不含中文',
  !/[\u4e00-\u9fa5]/.test(norm("听音：Hello! Welcome to WETBAR, I'm Eric. May I have your names please? 选出正确中文。")))

// ---------- ④ speakLocalForce：无引擎时自救 ----------
console.log('\n[4] 无语音引擎机型（红米等）点 🔉 的行为')
{
  const sb = mkSb({ noEngine: true })
  vm.runInContext("speakLocalForce('听音：Do you have a reservation? 选出正确中文。')", sb)
  assert('自动改用在线发音（不再「点了没反应/只弹一句听不懂的提示」）', sb._calls.online === 1,
    'online=' + sb._calls.online)
  assert('提示说明已切换（ttsNoEngineOnline）',
    sb._calls.toast.length === 1 && sb._calls.toast[0] === 'T:ttsNoEngineOnline',
    JSON.stringify(sb._calls.toast))
  assert('不弹旧的「本设备没有可用的语音引擎」', !sb._calls.toast.some(m => m === 'T:ttsNone'))
}
{
  // 有 speechSynthesis 且本地合成可用 → 走系统语音，不转在线
  const sb = mkSb({ localOk: true })
  vm.runInContext("speakLocalForce('Do you have a reservation')", sb)
  assert('本机有系统语音时仍优先系统语音（不改变原自救通道）',
    sb._calls.local === 1 && sb._calls.online === 0 && sb._calls.toast.length === 0,
    JSON.stringify(sb._calls))
}
{
  // 有 speechSynthesis 但 speak 失败（静音 ROM 假成功之外的显式失败）→ 仍弹原提示
  const sb = mkSb({ localOk: false })
  vm.runInContext("speakLocalForce('Do you have a reservation')", sb)
  assert('有引擎但提交失败 → 保留 ttsNone 提示，不误报已在线上',
    sb._calls.toast.length === 1 && sb._calls.toast[0] === 'T:ttsNone',
    JSON.stringify(sb._calls.toast))
}

// ---------- ⑤ i18n ----------
console.log('\n[5] i18n 键')
{
  const sb = { console, globalThis: {} }; sb.globalThis = sb; vm.createContext(sb)
  vm.runInContext(I18N_SRC + ';globalThis.__I18N = I18N;', sb)
  const I = vm.runInContext('globalThis.__I18N', sb)
  assert('ttsNoEngineOnline 中英成对', !!I.zh.ttsNoEngineOnline && !!I.en.ttsNoEngineOnline,
    JSON.stringify({ zh: I.zh.ttsNoEngineOnline, en: I.en.ttsNoEngineOnline }))
  assert('中英文案不同（未漏译）', I.zh.ttsNoEngineOnline !== I.en.ttsNoEngineOnline)
  assert('中文文案含指引关键词「在线发音」', /在线发音/.test(I.zh.ttsNoEngineOnline))
  assert('旧 ttsNone 保留（有引擎但提交失败仍用它）', !!I.zh.ttsNone && !!I.en.ttsNone)
}

// ---------- ⑥ 版本号 ----------
console.log('\n[6] 版本号')
{
  const m = HTML.match(/\?v=(\d+)/g) || []
  const vs = [...new Set(m.map(x => Number(x.slice(3))))]
  assert('index.html 版本号统一且 ≥144（现 ' + vs.join(',') + '，共 ' + m.length + ' 处）',
    vs.length === 1 && vs[0] >= 144 && m.length === 12)
}

console.log('\n' + (testFailed ? '❌ 有断言失败' : '✅ v144 全部通过') + '  PASS=' + pass)
process.exit(testFailed ? 1 : 0)
