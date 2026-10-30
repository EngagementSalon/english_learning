// ====== English Quiz Web App ======

// 标签常量（从 i18n 动态取词，语言切换后即生效）
const TYPE_LABELS = new Proxy({}, { get: (_, k) => t('typeLabels')[k] || k })
const DIFFICULTY_LABELS = new Proxy({}, { get: (_, k) => t('diffLabels')[k] || k })
const LEVEL_LABELS = new Proxy({}, { get: (_, k) => t('levelLabels')[k] || k })
const LEVEL_DESC = new Proxy({}, { get: (_, k) => t('levelDesc')[k] || '' })
const LETTERS = 'ABCDEFGHIJ'

// ====== 答案位置随机化 ======
// 返回题目副本：选项顺序随机打乱，答案索引同步重映射（填空/翻译题不处理）
function shuffleOptions(q) {
  if (!q.options || q.options.length < 2) return q
  if (q.type === 'fill' || q.type === 'translate') return q
  const idx = q.options.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const ansArr = Array.isArray(q.answer) ? q.answer : [q.answer]
  const newAnswer = ansArr.map(a => idx.indexOf(a))
  return { ...q, options: idx.map(i => q.options[i]), answer: Array.isArray(q.answer) ? newAnswer : newAnswer[0] }
}

// ====== 听音选义（listen）：用浏览器语音合成朗读英文，学生选中文释义 ======
// 兼容性：部分安卓设备（小米自带浏览器 / WebView 等）的 speechSynthesis 缺少英文语音或静音无声，
// 故提供「在线发音」（有道词典 TTS mp3，国内网络可用）兜底：系统不可用时自动回退，也可手动点击。
let _listenVoices = null
let _onlineAudio = null
let _ttsSrcIdx = -1          // v60：上次成功播放的在线源下标（优先复用已验证可用的源）
var TTS_WATCH_MS = 3000     // v60：每个在线源等待出声的看门狗时长（超时视为无声，切换下一源；var 便于测试注入）
// 安卓 Chrome/WebView 的 speechSynthesis 普遍存在「列出英文语音但 speak() 静音无声」的已知缺陷
// （需要系统 TTS 服务配合，各家 ROM 行为不一），v38 起安卓一律直接走在线发音，绕开本地合成
function _isAndroid() {
  try { return /Android/i.test((navigator && navigator.userAgent) || '') } catch (e) { return false }
}
// v138：微信内置浏览器（iOS WKWebView / 安卓 XWeb）普遍不暴露 speechSynthesis，
// 系统语音兜底失效 → 在线源全挂时提示的应是「跳出微信 / 换流量」，而不是笼统的「检查网络」
function _isWeChat() {
  try { return /MicroMessenger/i.test((navigator && navigator.userAgent) || '') } catch (e) { return false }
}
function _refreshListenVoices() {
  if (!('speechSynthesis' in window) || !window.speechSynthesis.getVoices) return
  try { _listenVoices = window.speechSynthesis.getVoices() || [] } catch (e) { _listenVoices = [] }
}
// 语音模式：'local' 系统英文语音可用 | 'online' 需走在线发音
function listenVoiceMode() {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return 'online'
  if (_isAndroid()) return 'online'   // v38：安卓本地合成静音问题，直接在线 TTS
  _refreshListenVoices()
  const vs = _listenVoices || []
  if (!vs.length) {
    // 语音列表可能异步加载（voiceschanged 后才有）：本次按在线处理仍能正常发声
    try {
      const ss = window.speechSynthesis
      if (ss.addEventListener && !ss.__wbListenVoicesWired) {
        ss.__wbListenVoicesWired = true
        ss.addEventListener('voiceschanged', () => _refreshListenVoices())
      }
    } catch (e) { /* ignore */ }
    return 'online'
  }
  return vs.some(v => /^en([-_]|$)/i.test(v.lang || '')) ? 'local' : 'online'
}
// v63：FNV-1a 32 位哈希（与 gen-tts.js 生成脚本严格一致），用于同源静态音频文件名
function _ttsKey(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16) + '-' + s.length
}
// 在线 TTS 源列表（v63：首位为同源静态音频包 tts/<key>.mp3——由 gen-tts.js 预生成，
// 不依赖任何第三方域名，学员网络再怎么拦也能响；其后为有道英国音/美国音 + 百度翻译在线兜底，
// 覆盖题库外文本（如上传作业的新题）与音频包未命中的情况）
function _ttsSources(text) {
  const q = encodeURIComponent(text)
  return [
    'tts/' + _ttsKey(text) + '.mp3',
    'https://dict.youdao.com/dictvoice?audio=' + q + '&type=1',
    'https://dict.youdao.com/dictvoice?audio=' + q + '&type=2',
    'https://fanyi.baidu.com/gettts?lan=en&text=' + q + '&spd=3&source=web'
  ]
}
// 播放失败提示（v60：全部在线源失败且本地合成也不可用时告知学员）
function _ttsToast(msg) {
  try {
    let el = document.getElementById('ttsToast')
    if (!el) { el = document.createElement('div'); el.id = 'ttsToast'; document.body.appendChild(el) }
    el.textContent = msg
    el.className = 'tts-toast show'
    clearTimeout(el.__t)
    el.__t = setTimeout(() => { el.className = 'tts-toast' }, 2500)
  } catch (e) { /* ignore */ }
}
// 本地合成（v60：最终兜底；v62 支持 force——未列出英文语音时也用默认语音+en-US 试一次，
// 部分安卓 TTS 引擎 getVoices 返回空但实际能读英文；返回 true=已提交朗读）
function _speakLocal(text, force) {
  try {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false
    _refreshListenVoices()
    const en = (_listenVoices || []).filter(v => /^en([-_]|$)/i.test(v.lang || ''))
    if (!en.length && !force) return false
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    u.rate = 0.9
    if (en.length) u.voice = en[0]
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
    return true
  } catch (e) { return false }
}
// v144：听音题朗读文本提取 —— 题库里存在「听音：<英文原文> 选出正确中文。」这类题干
// （中文指令与要朗读的英文挤在同一个 question 字段，云端课库新导入的听音题多为该格式）。
// 旧逻辑把整句送去朗读 → 英文引擎硬读中文（杂音/整体失败），且同源音频包 key 基于整句
// → 永远命中不了（学员网络不通时彻底无声，红米等无系统语音机型直接「做不了语音题」）。
// 规则：含中文字符时切出最长的英文片段（剔除「听音：」标记与「选出正确中文/英文」尾注）；
// 切不出英文（纯中文题干，如 voicematch 的中文提问）则**回退原文**——保持旧行为，避免点了没反应。
function _pickEnText(s) {
  const raw = String(s == null ? '' : s)
  const t = raw.replace(/^\s*听音\s*[：:]\s*/, '')
  if (!/[\u4e00-\u9fa5]/.test(t)) return t.trim()
  const frags = t.split(/[\u4e00-\u9fa5\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u201c\u201d\u2018\u2019\uff08\uff09\u3010\u3011\u300a\u300b]+/g)
    .map(x => x.replace(/^[\s,.:;!?\-–—"']+|[\s,.:;!?\-–—"']+$/g, '').trim())
    .filter(x => /[A-Za-z]/.test(x))
  if (!frags.length) return raw.trim()
  frags.sort((a, b) => b.length - a.length)
  return frags[0]
}
// v74：朗读文本规范化 —— 斜杠读作停顿（'Starter / Appetizer' → 'Starter, Appetizer'），
// 避免引擎把 '/' 读成 "slash" 或生硬连读；本地合成 / 在线源 / 音频包 key 共用同一规范
// （gen-tts.js 生成音频包时做同样规范化，key 严格一致；带 / 的旧包文件自然失效，由 CI 自动补新）
// v144：先做英文片段提取（_pickEnText），再规范化斜杠 —— gen-tts.js 同步该口径
function _normSpeakText(s) {
  return _pickEnText(s).replace(/\s*\/\s*/g, ', ').trim()
}
// 在线发音（v61 增强版）：多源自动降级——播放报错立即切下一源；看门狗每 TTS_WATCH_MS 检查一次，
// 有加载进度（loadstart/progress/canplay 等）就续等一轮（弱网慢加载不误杀），完全无进度才切换；
// 全部在线源失败时回退本地合成，仍不行才提示学员检查网络。每次尝试用全新 Audio 对象，
// 避免复用出错/无声的旧元素（部分安卓 WebView 的已知问题）。
function playListenOnline(text) {
  if (!text) return
  try {
    const txt = _normSpeakText(text).slice(0, 260)
    if (!txt) return
    const srcs = _ttsSources(txt)
    const order = []
    if (_ttsSrcIdx >= 0 && _ttsSrcIdx < srcs.length) order.push(_ttsSrcIdx)
    for (let i = 0; i < srcs.length; i++) if (order.indexOf(i) < 0) order.push(i)
    let k = 0, cur = null, dead = false
    const tryNext = () => {
      if (dead) return
      if (cur) { try { cur.pause(); cur.removeAttribute && cur.removeAttribute('src') } catch (e) {} cur = null }
      if (k >= order.length) {
        dead = true
        if (!_speakLocal(txt, true)) _ttsToast(_isWeChat() ? t('ttsFailWeChat') : t('ttsFail'))
        return
      }
      const myK = k
      const src = srcs[order[k]]
      let a
      try { a = new Audio() } catch (e) { k++; tryNext(); return }
      a.src = src
      try { a.volume = 1 } catch (e) { /* ignore */ }
      cur = a; _onlineAudio = a
      let played = false, progress = false
      const fail = () => { if (!played && !dead && k === myK) { k++; tryNext() } }
      if (a.addEventListener) {
        try {
          a.addEventListener('error', fail)
          a.addEventListener('playing', () => { played = true; _ttsSrcIdx = order[myK] })
          // 弱网下只要还有加载进度就不算死（v61：修复 3s 看门狗误杀慢加载音频）
          ;['loadstart', 'progress', 'canplay', 'loadedmetadata', 'loadeddata', 'canplaythrough'].forEach(ty => a.addEventListener(ty, () => { progress = true }))
        } catch (e) { /* ignore */ }
      }
      try {
        const p = a.play()
        if (p && p.catch) p.catch(fail)
      } catch (e) { fail(); return }
      const watch = () => {
        if (played || dead || k !== myK) return
        if (progress) { progress = false; setTimeout(watch, TTS_WATCH_MS); return }
        k++; tryNext()
      }
      setTimeout(watch, TTS_WATCH_MS)
    }
    tryNext()
  } catch (e) { try { _speakLocal(String(text)) } catch (e2) { /* ignore */ } }
}
// v61：安卓 / 微信 X5 内核需要在首次用户手势里「解锁」音频通道，否则后续播放可能静音。
// 首次 touchstart/click 时播放一段极短的静音 MP3 完成解锁（一次性）。
function _armAudioUnlock() {
  try {
    if (!document.addEventListener) return
    const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSkxLQ8XjbAL0iQtUKSQ0t/kxLRf2CgED/BAADH+2u6v7+/v6+vre5sUZB4uLei4iIh35QQEED/8UALP9EM1aJMggADBpHeDBCL/8S1/svf/v37+wMEAcUtOjJQsgEIkGLHGuT/+wYPZh72/73nwWEHDoJDiYej4ODg4ODg4OCAkVFRVVFRUZGRkZGRPT09PT09PT08PDw8PDw8PDwQEA8PDw8PDw8ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4P//w8ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg7/wAAA'
    const arm = () => {
      try {
        if (window.__wbAudioUnlocked) return
        window.__wbAudioUnlocked = true
        const a = new Audio(SILENT_MP3)
        a.volume = 0
        const p = a.play()
        if (p && p.catch) p.catch(() => {})
      } catch (e) { /* ignore */ }
    }
    document.addEventListener('touchstart', arm, { once: true, passive: true })
    document.addEventListener('click', arm, { once: true })
  } catch (e) { /* ignore */ }
}
try { _armAudioUnlock() } catch (e) { /* ignore */ }
// 朗读英文（listen 题）：本地英文语音可用则本地朗读，否则自动回退在线发音
// v38：本地 speak() 后若 1.8s 内未触发 onstart（静音/无声的典型表现），自动改用在线发音兜底
// v62：安卓不再跳过本地合成——在线 TTS 在部分校园网络被整体拦截（v61 提示弹窗证实），
//      有英文语音的安卓机型先试本地，1.8s 无声再走在线；系统语音已成为弱网下的主力通道
function speakEnglish(text) {
  if (!text) return
  try {
    text = _normSpeakText(text)
    if (!text) return
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { playListenOnline(text); return }
    _refreshListenVoices()
    const en = (_listenVoices || []).filter(v => /^en([-_]|$)/i.test(v.lang || ''))
    if (en.length) {
      // 有英文语音：选中一个朗读（避免默认中文语音读英文或静音）
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'en-US'
      u.rate = 0.9
      u.voice = en[0]
      let started = false
      u.onstart = () => { started = true }
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
      setTimeout(() => { if (!started) playListenOnline(text) }, 1800)
      return
    }
    playListenOnline(text)   // 无英文语音 → 在线兜底
  } catch (e) { playListenOnline(text) }
}
// v62：强制系统语音（listen 题的 🔉 按钮，在线被网络拦截时的自救通道）
// v144：本机根本没有语音引擎时（红米等 WebView，'speechSynthesis' 都不存在）**自动改用在线发音**
// —— 旧行为只弹一句「本设备没有可用的语音引擎」，学员既听不懂也没法自救；能出声才是硬道理，
// 同时照样弹提示说明已切换（避免学员以为按错了）。
function speakLocalForce(text) {
  if (!text) return
  const txt = _normSpeakText(text)
  if (!txt) return
  if (_speakLocal(txt, true)) return
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
    _ttsToast(t('ttsNoEngineOnline'))
    playListenOnline(text)
    return
  }
  _ttsToast(t('ttsNone'))
}
// v74：发音按钮 SVG 图标（替代 emoji——部分安卓机型 emoji 字体把图标渲染得过大/拉伸变形；
// SVG 固定 viewBox + currentColor 填充，随按钮 font-size 等比缩放且永不变形；样式见 style.css .ic-svg）
function audioIconSvg(kind) {
  const d = kind === 'globe'
    ? 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z'
    : kind === 'down'
      ? 'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z'
      : 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'
  return `<svg class="ic-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`
}
// 题干区 HTML：listen 题只显示喇叭按钮（不暴露英文原文），其余题型照常显示题干
function quizTitleHtml(q) {
  if (q.type === 'listen') {
    return `<div class="q-title listen-title">
      <button class="listen-btn" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">${audioIconSvg('up')}</button>
      <button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">${audioIconSvg('down')}</button>
      <button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">${audioIconSvg('globe')}</button>
      <span class="listen-hint">${t('listenHint')}</span>
    </div>`
  }
  return `<div class="q-title">${q.question}</div>`
}
// listen 题进入时自动朗读一次（仅本地语音可用时自动播，答题中才朗读，回顾/已提交不自动朗读）
function autoplayListen(q) {
  if (!q) return
  if (q.type === 'listen') {
    if (listenVoiceMode() === 'local') setTimeout(() => speakEnglish(q.question), 350)
    return
  }
  // v155：voicematch 作答时不再给选项文字，学员必须立刻知道「这里有声音」→ 自动试播第一个选项。
  // 与 listen 同口径：仅本地语音可用时自动播（安卓/无声机型走 online 时不自动播，
  // 避免页面一进来就发一串注定失败的网络请求；这些设备由「听不见？显示文字」开关兜底）。
  // 绝不朗读题干 —— 题干正是要学员听出来的那一项，读了就等于给答案。
  if (q.type === 'voicematch') {
    if (vmRevealOn(q)) return                      // 已展开文字（说明学员已放弃听音）不再自动播
    if (listenVoiceMode() !== 'local') return
    const idxs = visibleOptionIndexes(q.options)
    if (!idxs.length) return
    const first = String(q.options[idxs[0]] == null ? '' : q.options[idxs[0]]).trim()
    if (first) setTimeout(() => speakEnglish(first), 350)
  }
}

// ====== v87：题型自洽兜底 ======
// 需要选项的题型，若数据里选项不足 2 个（线下课导入的题常出现），按填空题渲染。
// 否则学生看到的是一道「一个可点选项都没有」的题 —— 「有些题目选不了」的一类成因。
// checkAnswer 与各渲染分支都走这里，保证「渲染成什么」与「怎么判分」一致。
// ====== v107：选项渲染去空槽（渲染层兜底）======
// 数据层已在写入/读取时裁掉尾部空槽（store.compactUploadedOptions / cloud-store._optCompact），
// 这里再兜一次：任何来源（云端旧数据、别的设备推送、编辑器手填）的题，渲染前一律丢掉空选项，
// 保证学员永远看不到「有边框、能点、但没字」的空白选项。
// 语义：只裁尾部连续空槽，与数据层口径一致（中间空槽保留原下标，避免 q.answer 下标错位）。
// 返回值 = 保留下来的原始下标数组，渲染时按下标取值即可（q.options[idx]），判分仍用原下标。
function visibleOptionIndexes(options) {
  const arr = Array.isArray(options) ? options : []
  let end = arr.length
  while (end > 0 && String(arr[end - 1] == null ? '' : arr[end - 1]).trim() === '') end--
  const out = []
  for (let i = 0; i < end; i++) out.push(i)
  return out
}
// 题型自洽兜底（v87）+ 空槽兜底（v107）：需要选项的题型，若「有效选项」不足 2 个则按填空渲染。
function safeQType(q) {
  if (!q) return ''
  const t = q.type
  if (t === 'single' || t === 'judge' || t === 'pronounce' || t === 'multiple' || t === 'listen' || t === 'voicematch') {
    const n = visibleOptionIndexes(q.options).length
    if (n < 2) return 'fill'
  }
  return t
}

// voicematch（看字选音）作答中是否隐藏选项文字：
// v155 起：**只要题干非空，作答时一律隐藏选项文字** —— 语音题的作答方式只有一种：听音选相符项。
// 沿革：v87 曾把「中文题干」判为「看题选词」而显示文字（当时是为了救「有些题目选不了」），
// 结果「看字选音」在中文题干题上退化成「看字选字」——学员截图反馈「语音题后面还有文字，语音题的意义何在」。
// 现改为一律隐藏，并配套「听不见？显示文字」求助开关（vmRevealOn / vmToggleReveal），
// 既保住语音题的本义，又不重演 v87「听不到就彻底没法做」的老问题。
// 唯一例外：题干为空 = 脏数据（没有题目任务），显示文字让学员至少有东西可点。
function vmHideOptionText(q) {
  const stem = String((q && q.question) || '').trim()
  if (!stem) return false
  return true
}

// ====== v155：「听不见？显示文字」求助开关 ======
// 语义：只对**当前这一道题**生效（按题目键记忆），换题自动回到隐藏态 ——
// 否则学员点过一次后，后面所有语音题都白给了。
let vmRevealStem = ''
function vmQKey(q) {
  const id = q && q.id
  if (id !== undefined && id !== null && String(id) !== '') return String(id)
  return String((q && q.question) || '')
}
function vmRevealOn(q) { return !!vmRevealStem && vmRevealStem === vmQKey(q) }
// 本行/本题此刻是否真的要隐藏文字（数据形态 && 未被求助开关打开）
function vmHideNow(q) { return vmHideOptionText(q) && !vmRevealOn(q) }
// 点「听不见？显示文字 / 收起文字」：翻转本开关并就地重渲染当前题。
// 重渲染函数名由渲染方通过 data-r 传入（练习/考试/定级/挑战/线下课各不同），
// 沿用本项目内联 onclick 定式：不传值，data-* + onclick="fn(this)"。
function vmToggleReveal(btn) {
  const key = (btn && btn.dataset && btn.dataset.k) || ''
  if (!key) return
  vmRevealStem = (vmRevealStem === key) ? '' : key
  const name = (btn && btn.dataset && btn.dataset.r) || ''
  if (!name) return
  try {
    const fn = (typeof globalThis !== 'undefined') ? globalThis[name] : undefined
    if (typeof fn === 'function') fn()
  } catch (e) { /* ignore */ }
}

// voicematch（看字选音）选项行
// v87：作答中出现明确的「选择此项」按钮。原先行内文字标签写的是「点击朗读」，但点它其实是选中该选项
//（朗读要点 🔊），提示与行为不符，学生普遍反馈「这题选不了」。现在朗读归 🔊/🔉/🌐，选择归「选择此项」，整行仍可点。
function vmOptRowHtml(q, ans, i, mode, pickFn) {
  const opt = q.options[i]
  const isCorrect = q.answer.includes(i)
  let cls = 'option-item vm-option'
  if (mode === 'review') { if (isCorrect) cls += ' correct'; else if (ans === i) cls += ' wrong' }
  else if (mode === 'live' && ans === i) cls += ' selected'
  const badge = mode === 'review' && isCorrect ? '✓' : (LETTERS[i] || String.fromCharCode(65 + i))
  const play = `<button class="vm-play" type="button" data-w="${escAttr(opt)}" onclick="event.stopPropagation();speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">${audioIconSvg('up')}</button>`
  const online = `<button class="vm-online" type="button" data-w="${escAttr(opt)}" onclick="event.stopPropagation();speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">${audioIconSvg('down')}</button><button class="vm-online" type="button" data-w="${escAttr(opt)}" onclick="event.stopPropagation();playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">${audioIconSvg('globe')}</button>`
  const onClick = mode === 'review' || !pickFn ? '' : `${pickFn}(${i})`
  const choose = (mode === 'review' || !pickFn) ? ''
    : `<button class="vm-choose" type="button" onclick="event.stopPropagation();${pickFn}(${i})">${escHtml(t('vmChoose'))}</button>`
  let inner
  if (mode === 'review') inner = `${play}${online}<span class="vm-opt-text">${escHtml(opt)}</span>`
  else if (vmHideNow(q)) inner = `${play}${online}${choose}`
  else inner = `${play}${online}<span class="vm-opt-text">${escHtml(opt)}</span>${choose}`
  return `<div class="${cls}" ${onClick ? `onclick="${onClick}"` : ''}>
    <div class="option-badge">${badge}</div>
    <div class="option-text vm-opt">${inner}</div>
  </div>`
}
// voicematch 选项整段 HTML
// v155：作答提示按「此刻是否隐藏文字」两态话术；隐藏态的题额外给一个「听不见？显示文字」求助开关
//（TTS 完全播不出时学员仍能自救 —— v87「选不了」教训的正式兜底）。
// rerender = 本页「重渲染当前题」的函数名（字符串），供求助开关就地切换后刷新。
function vmOptionsHtml(q, ans, mode, pickFn, rerender) {
  let hint = ''
  if (mode !== 'review') {
    const hide = vmHideNow(q)
    let link = ''
    if (vmHideOptionText(q)) {
      const key = vmQKey(q)
      link = ` <button class="vm-reveal" type="button" data-k="${escAttr(key)}" data-r="${escAttr(String(rerender || ''))}" onclick="event.stopPropagation();vmToggleReveal(this)">${escHtml(t(hide ? 'vmShowText' : 'vmHideText'))}</button>`
    }
    hint = `<p class="form-hint vm-hint">${escHtml(t(hide ? 'vmHint' : 'vmHintText'))}${link}</p>`
  }
  return hint + (q.options || []).map((_, i) => vmOptRowHtml(q, ans, i, mode, pickFn)).join('')
}

// ====== 会话心跳（累计登录时长）======
let _heartbeatTimer = null
function startHeartbeat() {
  stopHeartbeat()
  // 每 60 秒刷新一次会话时长（写入活动日志）
  _heartbeatTimer = setInterval(() => { Store._flushActiveSession() }, 60000)
  // 页面关闭前也刷新一次
  window.addEventListener('beforeunload', () => { Store._flushActiveSession() })
}
function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null }
}

// ====== Navigation ======
// 手机端汉堡菜单
function toggleMobileNav() {
  const nav = document.querySelector('.topbar-nav')
  if (nav) nav.classList.toggle('open')
}

function navigate(page) {
  // 权限守卫：题库管理/账号管理/数据看板 仅管理员可见
  if ((page === 'admin' || page === 'users' || page === 'dashboard') && !Store.isAdmin()) {
    alert(t('adminOnlyPage'))
    page = 'home'
  }
  document.querySelectorAll('.page').forEach(el => el.style.display = 'none')
  document.getElementById('page-' + page).style.display = ''
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page)
  })
  const mobNav = document.querySelector('.topbar-nav')
  if (mobNav) mobNav.classList.remove('open')   // 切页后收起手机菜单
  const renderFn = { home: renderHome, placement: renderPlacement, practice: renderPractice, exam: renderExam, challenge: renderChallenge, progress: renderProgress, course: renderCoursePage, admin: renderAdmin, users: renderUsers, dashboard: renderDashboard }
  if (renderFn[page]) renderFn[page]()
  window.scrollTo(0, 0)
}

// ====== Profile ======
function openProfileSetup() {
  const u = Store.getUser()
  const s = Store.getSession()
  document.getElementById('profileName').value = u ? u.name : ''
  setDeptCascade(DEPT_GROUPS.profile, u ? u.dept : '')
  // 登录用户名（登录后可自行修改；未登录时只读占位）
  const nuEl = document.getElementById('profileUsername')
  if (nuEl) {
    nuEl.value = s ? s.username : ''
    nuEl.readOnly = !s
  }
  document.getElementById('profileModalTitle').textContent = u ? t('profileEditTitle') : t('profileTitle')
  document.getElementById('profileModal').style.display = 'flex'
}
function closeProfileSetup() {
  document.getElementById('profileModal').style.display = 'none'
}
async function saveProfile() {
  const name = document.getElementById('profileName').value.trim()
  if (!name) return
  // v156：部门设为必选项 —— 原先读不到会静默存空串，导致后续练习页/挑战页收窄无依据
  const dept = readDeptCascade(DEPT_GROUPS.profile)
  if (!dept) return alert(t('errDeptRequired'))
  const s = Store.getSession()
  // —— 学员自助改登录用户名 ——
  let renamed = null
  const nuEl = document.getElementById('profileUsername')
  if (s && nuEl && !nuEl.readOnly) {
    const nu = nuEl.value.trim()
    if (nu && nu !== s.username) {
      const r = Store.renameUser(s.id, nu)
      if (!r.ok) return alert(r.msg)
      renamed = r
    }
  }
  Store.setUser({ name, dept })
  // 同步账号表姓名（看板显示用）
  if (s) Store.updateUser(s.id, { name })
  // v199：部门变更走统一收口 _applyDeptChange（写账号表 + 同步会话 + 云端 dept 事件），
  //   与「管理端-学员管理-修改部门」同链路。旧行为只改 eq_user 个人资料缓存：
  //   session.dept 不变 → 挑战营期/题库仍按旧部门解析（2026-10-30 用户实测：
  //   资料里换成日照-房务后，挑战横幅仍显示日照-餐饮第一期；且重新登录后改动整体丢失）。
  //   幂等：部门未变化时 _applyDeptChange 内部早退，无副作用。
  if (s && typeof Store.setUserDept === 'function') {
    try { await Store.setUserDept(s.id, dept) } catch (e) { /* 失败也能入队，下次定时推送 */ }
  }
  // 部门可能已变 → 立即重渲染依赖部门的可见页（练习页的挑战入口卡 / 挑战页的营期横幅），
  //   不等下一次云端拉取的门禁轮询。
  if (typeof refreshDeptAwarePages === 'function') refreshDeptAwarePages()
  if (renamed) applyCourseRename(renamed.old, renamed.nu)
  closeProfileSetup()
  updateUserInfoDisplay()
  if (renamed) alert(t('renameDone', renamed.old, renamed.nu))
}
// v199：部门变更后立即重渲染当前可见的部门敏感页。
//   挑战入口卡在练习页内（challengeEntryHtml），营期横幅在挑战页；不重渲染的话
//   要等下一次云端拉取的门禁轮询（最长一个推送周期）才换期，用户会误以为「没生效」。
function refreshDeptAwarePages() {
  try {
    // v201：切部门后营次结构可能变（v3↔七天），顶栏挑战导航命名同步刷新
    if (typeof refreshChallengeNavLabel === 'function') refreshChallengeNavLabel()
    const pages = document.querySelectorAll('.page')
    for (let i = 0; i < pages.length; i++) {
      const el = pages[i]
      if (!el || el.style.display === 'none') continue
      if (el.id === 'page-practice') { renderPractice(); return }
      if (el.id === 'page-challenge') { renderChallenge(); return }
    }
  } catch (e) { /* 切页时本就会重渲染，这里忽略 */ }
}
function updateUserInfoDisplay() {
  const s = Store.getSession()
  const u = Store.getUser()
  document.getElementById('userInfoDisplay').textContent = s ? s.name : (u ? u.name : t('notSet'))
  const badge = document.getElementById('userRoleBadge')
  if (badge) {
    badge.textContent = s && s.role === 'admin' ? t('roleAdmin') : t('roleStudent')
    badge.className = 'role-badge' + (s && s.role === 'admin' ? ' role-admin' : '')
  }
  const lvBadge = document.getElementById('userLevelBadge')
  if (lvBadge) {
    const lv = Store.getUserLevel()
    if (lv) {
      lvBadge.textContent = 'L' + lv
      lvBadge.className = 'level-badge level-' + lv
      lvBadge.style.display = ''
      lvBadge.title = t('currentLevelTitle') + LEVEL_LABELS[lv]
    } else {
      lvBadge.style.display = 'none'
    }
  }
}

// ====== 部门二级联动（注册 / 个人资料 / 管理员建账号共用） ======
// v196：新增日照大部门（rizhao）—— 日照-餐饮 / 日照-房务，挑战为「21 天挑战」（chPlan:'v3'）
const DEPT_MAJOR_KEYS = ['dining', 'rooms', 'rizhao', 'other']
const DEPT_GROUPS = {
  register: ['regDeptMajor', 'regDeptSub', 'regDeptOther'],
  profile: ['profileDeptMajor', 'profileDeptSub', 'profileDeptOther'],
  userModal: ['newDeptMajor', 'newDeptSub', 'newDeptOther'],
  deptModal: ['deptEditMajor', 'deptEditSub', 'deptEditOther'],
}
function deptTree() { return t('deptTree') }
// ====== v89：部门归一（四分队制）======
// 目标规范名（按大部门）——用于把历史自由文本/旧分部门名映射到现行四分队
const DEPT_CANON = {
  dining: ['标帜餐厅', '艳中餐厅', '酒吧团队', '客房送餐'],
  rooms: ['迎宾前台', '礼宾部', '随时随需', '客房造型', '健身及水疗中心'],
  rizhao: [],
}
// 反向索引：分部门名（含别名，中英双写、去空格小写）→ { majorKey, majorName, subName }
function _deptSubIndex() {
  const tree = deptTree()
  const idx = {}
  const put = (raw, majorKey, sub) => {
    const k = String(raw == null ? '' : raw).trim()
    if (!k) return
    if (!idx[k]) idx[k] = { majorKey: majorKey, majorName: tree[majorKey].name, subName: sub }
  }
  DEPT_MAJOR_KEYS.forEach(mk => {
    if (mk === 'other') return
    const subs = (tree[mk] && tree[mk].subs) || []
    const canon = DEPT_CANON[mk] || []
    subs.forEach((s, i) => {
      // 中英文子部门名一一对应（en 与 zh 的 subs 顺序一致）
      put(s, mk, s)
      const c = canon[i]
      if (c) put(c, mk, s)
    })
  })
  // 显式别名表（i18n）——覆盖 WOOBAR/WETBAR/LIQUID → 酒吧团队 等
  const alias = t('deptSubAlias') || {}
  Object.keys(alias).forEach(a => put(a, 'dining', alias[a]))
  return idx
}
// 归一单个分部门名 → { majorKey, majorName, subName }，无法识别返回 null
function normDeptSub(subName) {
  const raw = String(subName == null ? '' : subName).trim()
  if (!raw) return null
  const idx = _deptSubIndex()
  if (idx[raw]) return idx[raw]
  const lc = raw.toLowerCase().replace(/\s+/g, '')
  for (const k in idx) {
    if (k.toLowerCase().replace(/\s+/g, '') === lc) return idx[k]
  }
  // 包含式兜底（"客房送餐部" ⊃ "客房送餐"；"WOOBAR 吧台" ⊃ "WOOBAR"）
  for (const k in idx) {
    const kk = k.toLowerCase().replace(/\s+/g, '')
    if (kk.length >= 2 && (lc.indexOf(kk) >= 0 || kk.indexOf(lc) >= 0)) return idx[k]
  }
  return null
}
// 归一完整部门值（'饮食部·标帜餐厅' / 'WOOBAR' / '酒吧团队'）→
// { majorKey, majorName, subName, key(分部门 slug), value('大部门·分部门') }；无法识别返回 null
function normDept(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return null
  const i = s.indexOf('·')
  const majorRaw = i >= 0 ? s.slice(0, i).trim() : ''
  const subRaw = i >= 0 ? s.slice(i + 1).trim() : s
  const hit = normDeptSub(subRaw)
  if (!hit) return null
  const tree = deptTree()
  // 大部门与分部门冲突（如 '房务部·酒吧团队'）以分部门归属为准
  if (majorRaw) {
    const mk = DEPT_MAJOR_KEYS.find(k => tree[k].name === majorRaw)
    if (mk && mk !== 'other' && mk !== hit.majorKey) return null
  }
  return {
    majorKey: hit.majorKey,
    majorName: tree[hit.majorKey].name,
    subName: hit.subName,
    key: deptSlug(hit.majorKey, hit.subName),
    value: tree[hit.majorKey].name + '·' + hit.subName
  }
}
// 分部门 slug（题库 dept 字段 / 营次适用范围共用；与中英文无关，切语言不丢数据）
// v196：日照大部门两个分部 slug（'rizhao/canyin' 日照-餐饮 / 'rizhao/fangwu' 日照-房务）
const DEPT_SUB_SLUGS = {
  dining: { '标帜餐厅': 'sig', '艳中餐厅': 'yan', '酒吧团队': 'bar', '客房送餐': 'ird' },
  rooms: { '迎宾前台': 'fo', '礼宾部': 'concierge', '随时随需': 'ww', '客房造型': 'styling', '健身及水疗中心': 'spa' },
  rizhao: { '日照-餐饮': 'canyin', '日照-房务': 'fangwu' },
}
const DEPT_SUB_BY_SLUG = (() => {
  const out = {}
  Object.keys(DEPT_SUB_SLUGS).forEach(mk => {
    Object.keys(DEPT_SUB_SLUGS[mk]).forEach(sub => { out[mk + '/' + DEPT_SUB_SLUGS[mk][sub]] = sub })
  })
  return out
})()
function deptSlug(majorKey, subName) {
  const m = DEPT_SUB_SLUGS[majorKey]
  if (!m) return ''
  const raw = String(subName == null ? '' : subName).trim()
  if (m[raw]) return majorKey + '/' + m[raw]
  // 别名 / 英文名先归一，再查中文 slug 表
  const hit = normDeptSub(raw)
  if (hit) {
    const hm = DEPT_SUB_SLUGS[hit.majorKey]
    if (hm && hm[hit.subName]) return hit.majorKey + '/' + hm[hit.subName]
  }
  // 兜底：按「规范名顺序 / 大部门子部门顺序」的同位对齐（跨语言时名字可能是另一语言）
  const order = Object.keys(m)
  const canon = DEPT_CANON[majorKey] || []
  let ci = canon.indexOf(raw)
  if (ci < 0) ci = (((deptTree()[majorKey] || {}).subs) || []).indexOf(raw)
  if (ci >= 0 && order[ci]) return majorKey + '/' + m[order[ci]]
  return ''
}
// slug → 本地化显示名（'dining/bar' → '酒吧团队' / 'Bar Team'）
function deptSlugName(slug) {
  const s = String(slug || '')
  const i = s.indexOf('/')
  if (i < 0) return s
  const mk = s.slice(0, i)
  const sub = DEPT_SUB_BY_SLUG[s]
  if (!sub) return s
  const names = t('chDeptNames') || {}
  if (names[sub]) return names[sub]
  const tree = deptTree()
  const arr = (tree[mk] && tree[mk].subs) || []
  const ci = (DEPT_CANON[mk] || []).indexOf(sub)
  return ci >= 0 && arr[ci] ? arr[ci] : sub
}
// 当前登录学员的分部门 slug（'dining/bar'）；管理员/其他部门返回 ''
function sessionDeptSlug() {
  const hit = normDept(Store.getSessionDept())
  return hit ? hit.key : ''
}
// 部门分组 key（indexedDB 统计用）：dining / rooms / other
function deptGroupKey(value) {
  const hit = normDept(value)
  return hit ? hit.majorKey : 'other'
}

// 构建一组级联控件（清空已有选择）
function buildDeptCascade(g) {
  const majorSel = document.getElementById(g[0])
  const subSel = document.getElementById(g[1])
  const otherIn = document.getElementById(g[2])
  if (!majorSel || !subSel || !otherIn) return
  const tree = deptTree()
  majorSel.innerHTML = '<option value="">' + escHtml(t('deptSelectPh')) + '</option>' +
    DEPT_MAJOR_KEYS.map(k => '<option value="' + k + '">' + escHtml(tree[k].name) + '</option>').join('')
  subSel.style.display = 'none'
  subSel.innerHTML = ''
  subSel.value = ''
  otherIn.style.display = 'none'
  otherIn.value = ''
  majorSel.onchange = () => {
    const k = majorSel.value
    subSel.style.display = 'none'
    otherIn.style.display = 'none'
    subSel.value = ''
    otherIn.value = ''
    if (!k) return
    if (k === 'other') {
      otherIn.style.display = ''
    } else {
      subSel.innerHTML = '<option value="">' + escHtml(t('deptSelectPh')) + '</option>' +
        tree[k].subs.map(s => '<option value="' + escAttr(s) + '">' + escHtml(s) + '</option>').join('')
      subSel.style.display = ''
    }
  }
}

// 读取级联控件的完整部门值（格式：大部门·分部门），未选全返回 ''
function readDeptCascade(g) {
  const majorSel = document.getElementById(g[0])
  if (!majorSel) return ''
  const k = majorSel.value
  if (!k) return ''
  const majorName = deptTree()[k].name
  if (k === 'other') {
    const v = document.getElementById(g[2]).value.trim()
    return v ? majorName + '·' + v : ''
  }
  const sub = document.getElementById(g[1]).value
  return sub ? majorName + '·' + sub : ''
}

// 回填已有部门值（旧数据/跨语言/自由文本统一归入「其他部门」）
function setDeptCascade(g, value) {
  buildDeptCascade(g)
  if (!value) return
  const majorSel = document.getElementById(g[0])
  const subSel = document.getElementById(g[1])
  const otherIn = document.getElementById(g[2])
  const tree = deptTree()
  const idx = value.indexOf('·')
  const majorName = idx >= 0 ? value.slice(0, idx) : value
  const sub = idx >= 0 ? value.slice(idx + 1) : ''
  const key = DEPT_MAJOR_KEYS.find(k => tree[k].name === majorName)
  // v89：分部门名先归一（旧名 WOOBAR/WETBAR/LIQUID/客房送餐部 等自动落到四分队）
  if (key && key !== 'other') {
    const subs = tree[key].subs
    let target = subs.indexOf(sub) >= 0 ? sub : ''
    if (!target) {
      const hit = normDeptSub(sub)
      const canon = DEPT_CANON[key] || []
      const ci = canon.indexOf(sub)
      if (ci >= 0 && subs[ci]) target = subs[ci]
      else if (hit && hit.majorKey === key && subs.indexOf(hit.subName) >= 0) target = hit.subName
    }
    if (target) {
      majorSel.value = key
      majorSel.onchange()
      subSel.value = target
      return
    }
  }
  // v89：仅填了分部门（无大部门）时也尝试按分部门归一
  if (!sub && !key) {
    const hit = normDeptSub(majorName)
    if (hit && hit.majorKey !== 'other' && tree[hit.majorKey].subs.indexOf(hit.subName) >= 0) {
      majorSel.value = hit.majorKey
      majorSel.onchange()
      subSel.value = hit.subName
      return
    }
  }
  majorSel.value = 'other'
  majorSel.onchange()
  otherIn.value = value
}

// 语言切换后重建所有级联控件（保留已选值）
function refreshDeptCascades() {
  Object.values(DEPT_GROUPS).forEach(g => {
    const majorSel = document.getElementById(g[0])
    if (!majorSel) return
    const oldMajor = majorSel.value
    const oldSub = document.getElementById(g[1]).value
    const oldOther = document.getElementById(g[2]).value
    buildDeptCascade(g)
    if (oldMajor) {
      majorSel.value = oldMajor
      majorSel.onchange()
      if (oldMajor === 'other') document.getElementById(g[2]).value = oldOther
      else document.getElementById(g[1]).value = oldSub
    }
  })
}

// ====== 认证（登录/注册/退出） ======
function showLoginForm() {
  document.getElementById('loginForm').style.display = ''
  document.getElementById('registerForm').style.display = 'none'
  hideAuthError('login')
}
function showRegisterForm() {
  document.getElementById('loginForm').style.display = 'none'
  document.getElementById('registerForm').style.display = ''
  buildDeptCascade(DEPT_GROUPS.register)
  hideAuthError('register')
}
function showAuthError(which, msg) {
  const el = document.getElementById(which + 'Error')
  el.textContent = msg
  el.style.display = ''
}
function hideAuthError(which) {
  document.getElementById(which + 'Error').style.display = 'none'
}
async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim()
  const password = document.getElementById('loginPassword').value
  if (!username || !password) return showAuthError('login', t('errInputUserPwd'))
  // 跨设备：本地匹配或云端校验均可登录
  let user = null
  try { user = await Store.loginAllowCloud(username, password) }
  catch (e) { /* 降级到纯本地校验 */ }
  if (!user) user = await Store.login(username, password)
  if (!user) return showAuthError('login', t('errWrongCredential'))
  enterApp()
}
async function doRegister() {
  const username = document.getElementById('regUsername').value.trim()
  const password = document.getElementById('regPassword').value
  const name = document.getElementById('regName').value.trim()
  const dept = readDeptCascade(DEPT_GROUPS.register)
  if (!username || !password || !name) return showAuthError('register', t('errRegisterFields'))
  if (!dept) return showAuthError('register', t('errDeptRequired'))
  if (password.length < 4) return showAuthError('register', t('errPwdTooShort'))
  const result = await Store.register({ username, password, name, dept })
  if (!result.ok) return showAuthError('register', result.msg)
  await Store.login(username, password)
  enterApp()
}
function doLogout() {
  if (!confirm(t('confirmLogout'))) return
  stopHeartbeat() // —— 停止心跳 ——
  Store.logout()
  document.getElementById('app').style.display = 'none'
  document.getElementById('authScreen').style.display = 'flex'
  document.getElementById('loginPassword').value = ''
  showLoginForm()
}
function enterApp() {
  document.getElementById('authScreen').style.display = 'none'
  document.getElementById('app').style.display = ''
  applyRoleVisibility()
  updateUserInfoDisplay()
  startHeartbeat() // —— 启动会话心跳，累计登录时长 ——
  // 学员首次进入：先做水平测试，自动定级 L1-L4（v81 起由 PLACEMENT_ENABLED 控制，暂时关闭 → 直达首页）
  const s = Store.getSession()
  if (PLACEMENT_ENABLED && s && s.role === 'student' && !Store.getUserLevel()) {
    placementState = { phase: 'intro', auto: true }
    navigate('placement')
  } else {
    navigate('home')
  }
}
// 按角色显示/隐藏导航与入口
function applyRoleVisibility() {
  const isAdmin = Store.isAdmin()
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none'
  })
  // v81：水平测试暂时关闭 → 导航栏入口一并隐藏（PLACEMENT_ENABLED 恢复 true 即回来）
  const np = document.getElementById('navPlacement')
  if (np) np.style.display = PLACEMENT_ENABLED ? '' : 'none'
}

// ====== 水平测试（自动分档 L1-L4）======
// v81：水平测试暂时关闭（功能与代码全部保留）——恢复方法：把 PLACEMENT_ENABLED 改回 true，
// 登录后强制测评、导航栏「🎯 水平测试」、首页功能卡/未定级卡/重新定级按钮即全部恢复显示。
const PLACEMENT_ENABLED = false
let placementState = { phase: 'intro', auto: false, questions: [], index: 0, answers: [], result: null }

function renderPlacement() {
  if (!placementState || !placementState.phase) placementState = { phase: 'intro', auto: false }
  if (placementState.phase === 'quiz') return renderPlacementQuestion()
  if (placementState.phase === 'result') return renderPlacementResult()
  // ===== 介绍页 =====
  const el = document.getElementById('page-placement')
  const lv = Store.getUserLevel()
  const first = placementState.auto
  el.innerHTML = `
    <div class="card placement-card">
      <div class="placement-hero">🎯</div>
      <h2>${t('placementTitle')}</h2>
      <p class="placement-sub">${t('placementSub')}</p>
      <div class="placement-rules">
        <div class="rule-item"><span class="rule-icon">📋</span>${t('placementRule1')}</div>
        <div class="rule-item"><span class="rule-icon">⏱️</span>${t('placementRule2')}</div>
        <div class="rule-item"><span class="rule-icon">🙈</span>${t('placementRule3')}</div>
        <div class="rule-item"><span class="rule-icon">🔁</span>${t('placementRule4')}</div>
      </div>
      ${lv ? `
      <div class="placement-current">
        <span class="level-badge level-${lv}" style="display:inline-flex">${LEVEL_LABELS[lv]}</span>
        <span class="placement-current-text">${t('placementCurrent')}</span>
      </div>` : ''}
      ${first ? `<p class="placement-welcome">${t('placementWelcome')}</p>` : ''}
      <div class="placement-actions">
        <button class="btn btn-primary btn-lg" onclick="startPlacement()">${lv ? t('restartTest') : t('startTest')}</button>
        ${first ? `<button class="btn btn-ghost" onclick="skipPlacement()">${t('skipTest')}</button>` : `<button class="btn btn-ghost" onclick="navigate('home')">${t('backHome')}</button>`}
      </div>
    </div>
  `
}

function skipPlacement() {
  placementState = { phase: 'intro', auto: false }
  navigate('home')
}

// v43：线下课题库 = 线下课班级（房务部/餐饮部等）已激活作业（非草稿 homework/exam）中的题目，
// 由 Store.rebuildBankFromCourse 从云端班级文档动态派生到本地题库，统一归入分类 id=1「线下课题库」
const COURSE_BANK_CAT_ID = 1

// 确保本地题库已从线下课云端文档派生同步（离线时沿用本地暂存题库）
async function ensureCourseBankSynced() {
  try {
    if (typeof CourseStore !== 'undefined' && CourseStore.getDoc && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) {
      const doc = await CourseStore.getDoc()
      if (doc && doc.classes) Store.rebuildBankFromCourse(doc.classes)
    }
  } catch (e) { /* 离线/云文档不可达：沿用本地题库 */ }
}

// 从题库按等级抽题：L1-L4 各 6 题，只选选择题（单选/判断/读音/听音选义/看字选音），选项随机
// v43 起只从派生的线下课题库（分类 id=1）抽题；某等级题目不足时从相邻等级就近借用补足
async function buildPlacementQuestions() {
  await ensureCourseBankSynced()
  const PER_LEVEL = 6
  const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()
  let qs = Store.getQuestionsWithLevel(deptKey).filter(q => ['single', 'judge', 'pronounce', 'listen', 'voicematch'].includes(q.type))
  qs = qs.filter(q => Number(q.category_id) === COURSE_BANK_CAT_ID)
  // v87：剔除畸形题（如选项不足 2 个的单选题）—— 这类题在页面上没有可点的选项，学生只会反馈「选不了」
  qs = qs.filter(q => safeQType(q) === q.type)
  const byLevel = { 1: [], 2: [], 3: [], 4: [] }
  qs.forEach(q => { if (byLevel[q.level]) byLevel[q.level].push(q) })
  const picked = []
  const used = new Set()
  const takeFrom = (l, n) => {
    let got = 0
    for (const q of (byLevel[l] || []).sort(() => Math.random() - 0.5)) {
      if (got >= n) break
      if (used.has(q.id)) continue
      used.add(q.id)
      picked.push(shuffleOptions(q))
      got++
    }
    return got
  }
  for (let l = 1; l <= 4; l++) {
    let got = takeFrom(l, PER_LEVEL)
    for (let d = 1; got < PER_LEVEL && d <= 3; d++) {
      if (l - d >= 1) got += takeFrom(l - d, PER_LEVEL - got)
      if (l + d <= 4 && got < PER_LEVEL) got += takeFrom(l + d, PER_LEVEL - got)
    }
  }
  return picked
}

async function startPlacement() {
  const questions = await buildPlacementQuestions()
  if (questions.length < 8) {
    alert(t('errNotEnoughQuestions'))
    return
  }
  placementState = { phase: 'quiz', auto: false, questions, index: 0, answers: questions.map(() => -1), result: null }
  renderPlacementQuestion()
}

function renderPlacementQuestion() {
  const el = document.getElementById('page-placement')
  const st = placementState
  const q = st.questions[st.index]
  const ans = st.answers[st.index]
  const pct = Math.round(st.index / st.questions.length * 100)
  // 题池已由 buildPlacementQuestions 过滤掉畸形题（safeQType !== q.type），这里只会是规范选择题型
  const qt = safeQType(q)
  const optionsHtml = qt === 'voicematch'
    ? vmOptionsHtml(q, ans, 'live', 'placementPick', 'renderPlacementQuestion')
    : visibleOptionIndexes(q.options).map(i => {
        const opt = q.options[i]
        const cls = 'option-item' + (ans === i ? ' selected' : '')
        return `<div class="${cls}" onclick="placementPick(${i})">
          <div class="option-badge">${LETTERS[i]}</div>
          <div class="option-text">${opt}</div>
        </div>`
      }).join('')
  el.innerHTML = `
    <div class="card">
      <div class="placement-quiz-header">
        <span class="placement-quiz-label">${t('placementQuizLabel')}</span>
        <span class="placement-quiz-count">${t('questionOf', st.index + 1, st.questions.length)}</span>
      </div>
      <div class="progress-bar-wrap placement-progress">
        <div class="progress-bar-fill blue" style="width:${pct}%"></div>
      </div>
      <div class="q-meta">
        <span class="tag tag-category">${Store.getCategoryName(q.category_id)}</span>
        <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
        <span class="tag tag-level level-tag-${q.level}">${LEVEL_LABELS[q.level]}</span>
      </div>
      ${quizTitleHtml(q)}
      <div class="options-list">${optionsHtml}</div>
    </div>
  `
  autoplayListen(q)
}

function placementPick(i) {
  const st = placementState
  if (st.answers[st.index] !== -1) return // 已选，防连点
  st.answers[st.index] = i
  // 短暂显示选中态后进入下一题
  const items = document.querySelectorAll('#page-placement .option-item')
  if (items[i]) items[i].classList.add('selected')
  setTimeout(() => {
    st.index++
    if (st.index >= st.questions.length) finishPlacement()
    else renderPlacementQuestion()
  }, 240)
}

function finishPlacement() {
  const st = placementState
  const perLevel = {}
  let score = 0
  st.questions.forEach((q, i) => {
    if (!perLevel[q.level]) perLevel[q.level] = { correct: 0, total: 0 }
    perLevel[q.level].total++
    const ok = Array.isArray(q.answer) ? q.answer.includes(st.answers[i]) : q.answer === st.answers[i]
    if (ok) { perLevel[q.level].correct++; score++ }
  })
  // 定级：逐级递进 —— 从 L1 开始，只有当前级达标（≥60%）才看下一级；
  // 一旦某级未达标，后续高级别即使达标也不算（防止跳级）
  // 阈值 60%：4 选 1 随机猜对 25%，判断题 50%，60% 能排除运气成分
  const THRESHOLD = 0.6
  let level = 1
  for (let l = 1; l <= 4; l++) {
    const s = perLevel[l]
    const acc = s && s.total > 0 ? s.correct / s.total : 0
    if (acc >= THRESHOLD) {
      level = l          // 本级达标，更新到本级
    } else {
      break              // 本级未达标，停止递进（高级别不再考虑）
    }
  }
  // 推荐练习等级：本等级已很扎实（≥80%）且存在更高等级时，推荐挑战下一级
  let practiceLevel = level
  if (level < 4 && perLevel[level] && perLevel[level].total > 0 && perLevel[level].correct / perLevel[level].total >= 0.8) {
    practiceLevel = level + 1
  }
  st.result = { level, practiceLevel, score, total: st.questions.length, perLevel }
  st.phase = 'result'
  Store.saveUserLevel(level, st.result)
  updateUserInfoDisplay()
  renderPlacementResult()
}

function renderPlacementResult() {
  const el = document.getElementById('page-placement')
  const r = placementState.result
  if (!r) return renderPlacement()
  const bars = [1, 2, 3, 4].map(l => {
    const s = r.perLevel[l] || { correct: 0, total: 0 }
    const pct = s.total > 0 ? Math.round(s.correct / s.total * 100) : 0
    const cls = pct >= 80 ? 'green' : pct >= 60 ? 'yellow' : 'red'
    return `
      <div class="cat-progress-item">
        <div class="cat-name">${LEVEL_LABELS[l]}</div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
        <div class="cat-stats">${s.correct}/${s.total} · ${pct}%</div>
      </div>
    `
  }).join('')
  const pct = Math.round(r.score / r.total * 100)
  el.innerHTML = `
    <div class="card placement-card">
      <div class="placement-hero">🎉</div>
      <h2>${t('testDone')}</h2>
      <p class="placement-sub">${t('testResultSub', r.score, r.total, pct)}</p>
      <div class="placement-level-badge level-${r.level}">L${r.level}</div>
      <div class="placement-level-name">${LEVEL_LABELS[r.level]}</div>
      <div class="placement-desc">${LEVEL_DESC[r.level]}</div>
      <h3 class="section-title" style="text-align:left">${t('perLevelAcc')}</h3>
      <div class="category-progress">${bars}</div>
      <div class="placement-actions">
        <button class="btn btn-primary btn-lg" onclick="goPracticeAtLevel(${r.practiceLevel})">${r.practiceLevel !== r.level ? t('startChallengeLevel', r.practiceLevel) : t('startPracticeLevel', r.level)}</button>
        <button class="btn btn-ghost" onclick="retakePlacement()">${t('retakeTest')}</button>
        <button class="btn btn-ghost" onclick="navigate('home')">${t('backHome')}</button>
      </div>
    </div>
  `
}

function retakePlacement() {
  placementState = { phase: 'intro', auto: false }
  renderPlacement()
}

// 跳转到练习页并预选等级
let practicePresetLevel = null
function goPracticeAtLevel(lv) {
  practicePresetLevel = lv
  navigate('practice')
}

// ====== Home Page ======
function renderHome() {
  const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()
  const stats = Store.getStats(deptKey)
  const totalCount = stats.totalQuestions
  const lv = Store.getUserLevel()
  const el = document.getElementById('page-home')
  el.innerHTML = `
    <div class="hero">
      <h2>${t('heroTitle')}</h2>
      <p>${t('heroSub')}</p>
    </div>
    ${lv ? `
    <div class="level-status-card">
      <div class="level-status-left">
        <span class="level-badge level-${lv}">L${lv}</span>
        <div>
          <div class="level-status-name">${LEVEL_LABELS[lv]}</div>
          <div class="level-status-desc">${LEVEL_DESC[lv]}</div>
        </div>
      </div>
      ${PLACEMENT_ENABLED ? `<button class="btn btn-ghost" onclick="navigate('placement')">${t('regrade')}</button>` : ''}
    </div>` : (PLACEMENT_ENABLED && Store.getSession() && Store.getSession().role === 'student' ? `
    <div class="level-status-card level-status-pending">
      <div class="level-status-left">
        <span class="level-badge level-0">?</span>
        <div>
          <div class="level-status-name">${t('notPlaced')}</div>
          <div class="level-status-desc">${t('notPlacedDesc')}</div>
        </div>
      </div>
      <button class="btn btn-primary" onclick="navigate('placement')">${t('startPlacement')}</button>
    </div>` : '')}
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">${t('statTotalQuestions')}</div>
        <div class="stat-value">${totalCount}<span class="stat-unit">${t('unitQuestion')}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('statTotalAnswered')}</div>
        <div class="stat-value">${stats.totalAnswered}<span class="stat-unit">${t('unitTime')}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('statAccuracy')}</div>
        <div class="stat-value">${stats.accuracy}<span class="stat-unit">%</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">${t('statExamCount')}</div>
        <div class="stat-value">${stats.examCount}<span class="stat-unit">${t('unitTime')}</span></div>
      </div>
    </div>
    <h3 class="section-title">${t('sectionFeatures')}</h3>
    <div class="feature-grid">
      ${PLACEMENT_ENABLED ? `
      <div class="feature-card" onclick="navigate('placement')">
        <div class="icon">🎯</div>
        <h3>${t('featurePlacementT')}</h3>
        <p>${t('featurePlacementD')}</p>
      </div>` : ''}
      <div class="feature-card" onclick="navigate('practice')">
        <div class="icon">✏️</div>
        <h3>${t('featurePracticeT')}</h3>
        <p>${t('featurePracticeD')}</p>
      </div>
      <div class="feature-card" onclick="navigate('exam')">
        <div class="icon">📝</div>
        <h3>${t('featureExamT')}</h3>
        <p>${t('featureExamD')}</p>
      </div>
      <div class="feature-card" onclick="navigate('progress')">
        <div class="icon">📊</div>
        <h3>${t('featureProgressT')}</h3>
        <p>${t('featureProgressD')}</p>
      </div>
      ${Store.isAdmin() ? `
      <div class="feature-card" onclick="navigate('admin')">
        <div class="icon">🗂️</div>
        <h3>${t('featureAdminT')}</h3>
        <p>${t('featureAdminD')}</p>
      </div>
      <div class="feature-card" onclick="navigate('users')">
        <div class="icon">👥</div>
        <h3>${t('featureUsersT')}</h3>
        <p>${t('featureUsersD')}</p>
      </div>` : ''}
    </div>
    <h3 class="section-title">${t('sectionCategoryProgress')}</h3>
    <div class="card">
      <div class="category-progress">
        ${stats.categoryStats.map(cat => {
          const pct = cat.totalQuestions > 0 ? Math.round(cat.answered / cat.totalQuestions * 100) : 0
          const cls = pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red'
          return `
            <div class="cat-progress-item">
              <div class="cat-name">${cat.name}</div>
              <div class="progress-bar-wrap">
                <div class="progress-bar-fill ${cls}" style="width:${pct}%"></div>
              </div>
              <div class="cat-stats">${cat.answered}/${cat.totalQuestions} · ${cat.accuracy}%</div>
            </div>
          `
        }).join('')}
      </div>
    </div>
  `
}

// ====== Practice Page ======
let practiceState = { questions: [], index: 0, answers: [], submitted: false, correctCount: 0 }
// v156：学员练习页抽题口径收窄到「分部门」（v92 起一直走大部门 key → 混题）。
//   背景：v154 只修了挑战页抽题池；练习页 startPractice() 仍取 Store.getSessionDeptKey()
//   （恒为大部门 key 'dining'/'rooms'）→ 标帜餐厅学员能抽到艳中/送餐的题，管理员更是全库混题。
//   用户拍板（2026-10-09）：练习页也收窄成跟分部门走，与挑战页学员口径对齐。
//   口径：
//     · 管理员 → 沿用切片 practiceDept（'' = 全部，v92 行为不变）
//     · 学员   → sessionDeptSlug()（'dining/sig' 等）；无分部门（其他部门/旧数据）回落 ''
//   注意：仅**练习页抽题**收窄。首页/进度页的**统计数**（getStats）与考试/水平测试**暂不改**，
//   它们各有独立门禁，不在本次拍板范围内 —— 避免「练习页能看到但统计数对不上」的二次困惑。
function practiceDeptKey() {
  try {
    if (typeof Store !== 'undefined' && Store.isAdmin && Store.isAdmin()) {
      return (typeof practiceDept !== 'undefined' && PRACTICE_DEPT_SLUGS.indexOf(practiceDept) >= 0) ? practiceDept : ''
    }
    if (typeof sessionDeptSlug === 'function') return sessionDeptSlug()
  } catch (e) {}
  return ''
}
// v92：管理员练习页部门切片 —— 可切到任一部门/分队视角抽题。
//   ''      = 全部题目（管理员默认，等同 v91 行为）
//   'dining'/'rooms' = 该大部门（含其所有分队 + 通用）
//   'dining/bar' 等分队 slug = 该分队 + 大部门自身 + 通用
//   'all'   = 仅通用题
// 非管理员不使用本变量（恒走 practiceDeptKey()），切片 UI 也不渲染。
// v109：一级栏目层级化 —— 顶部一级行只放 全部部门/饮食部/房务部/通用 四项（用户口径：
//   「应该只有餐饮部和房务部两个栏目」），分部门不再平铺在一级行，选中大部门时在下方展开二级行。
const PRACTICE_DEPT_TABS = ['', 'dining', 'rooms', 'rizhao', 'all']
// v109：合法切片全集（一级 + 二级分部门）。setPracticeDept 校验与 chDeptKey 联动（challenge.js）都用它，
//   否则点二级分部门按钮会被误判非法而回落「全部部门」。
// v196：日照大部门 + 两个分部切片。
const PRACTICE_DEPT_SLUGS = ['', 'dining', 'rooms', 'rizhao', 'all',
  'dining/sig', 'dining/yan', 'dining/bar', 'dining/ird',
  'rooms/fo', 'rooms/concierge', 'rooms/ww', 'rooms/styling', 'rooms/spa',
  'rizhao/canyin', 'rizhao/fangwu']
let practiceDept = ''
// 切片项显示名
function practiceDeptTabLabel(k) {
  if (k === '') return t('deptAll')
  if (k === 'all') return t('deptGeneral')
  const tree = deptTree()
  if (k === 'dining') return tree.dining.name
  if (k === 'rooms') return tree.rooms.name
  if (k === 'rizhao') return tree.rizhao.name
  return deptSlugName(k) || k
}
// 该部门视角下可练习题数（不叠加分类/难度/等级筛选，作为切换时的即时反馈）
function practiceDeptCount(k) {
  try {
    return k ? Store.getQuestionsByDept(k).length : Store.getQuestions().length
  } catch (e) { return 0 }
}
// 管理员练习页部门切片（仅管理员渲染）
// v109：层级化 —— 一级行只放四个一级栏目；选中「饮食部/房务部」（或其二级行里的分部门）时，
//   在下方展开该大部门的分部门二级行，点分部门才切到对应题库切片。
function practiceDeptSwitchHtml() {
  if (!Store.isAdmin()) return ''
  if (typeof DEPT_SUB_SLUGS === 'undefined') return ''
  const btn = (k, sub) => {
    const on = practiceDept === k
    const n = practiceDeptCount(k)
    const cls = on ? 'btn-primary' : 'btn-ghost'
    // 空题库的分队切片淡显（仍可点，避免误以为功能失效）
    const dim = n === 0 ? ';opacity:.55' : ''
    const small = sub ? 'font-size:12px;' : ''
    return `<button class="btn btn-sm ${cls}" style="white-space:nowrap${dim}${small}" onclick="setPracticeDept('${k}')">${escHtml(practiceDeptTabLabel(k))}<span style="font-size:11px;opacity:.75"> ${n}</span></button>`
  }
  const mainBtns = PRACTICE_DEPT_TABS.map(k => btn(k, false)).join('')
  // 二级行：一级选中饮食部/房务部（或其分部门）时展开；DEPT_SUB_SLUGS 键为中文显示名、值为 slug
  const major = String(practiceDept || '').split('/')[0]
  let subRow = ''
  if ((major === 'dining' || major === 'rooms' || major === 'rizhao') && DEPT_SUB_SLUGS[major]) {
    const subs = Object.keys(DEPT_SUB_SLUGS[major])
      .map(name => major + '/' + DEPT_SUB_SLUGS[major][name])
      .map(k => btn(k, true)).join('')
    subRow = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;padding-left:2px">${subs}</div>`
  }
  return `
    <div class="filter-row" style="margin-top:10px;padding-top:10px;border-top:1px dashed #e5e7eb">
      <div class="filter-group" style="flex:1;min-width:0">
        <label>🏷️ ${t('practiceDeptLabel')}</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${mainBtns}</div>
        ${subRow}
        <p class="form-hint" style="margin:4px 0 0">${t('practiceDeptAdminHint')}</p>
      </div>
    </div>`
}
function setPracticeDept(val) {
  practiceDept = PRACTICE_DEPT_SLUGS.indexOf(val) >= 0 ? val : ''
  renderPractice()
}

function renderPractice() {
  const el = document.getElementById('page-practice')
  const categories = Store.getCategories()
  const userLevel = Store.getUserLevel()
  // 优先使用跳转时预选的等级，其次默认当前定级
  const presetLevel = practicePresetLevel != null ? practicePresetLevel : userLevel || 0
  practicePresetLevel = null
  const levelHint = presetLevel ? t('levelPresetHint', presetLevel) : ''
  el.innerHTML = `
    <div class="card" id="practiceConfig">
      <h3>${t('practiceSettings')}${levelHint}</h3>
      <div class="filter-row">
        <div class="filter-group">
          <label>${t('levelFilter')}</label>
          <select id="pLevel">
            <option value="0">${t('allLevels')}</option>
            <option value="1" ${presetLevel === 1 ? 'selected' : ''}>${t('levelLabels')[1]}</option>
            <option value="2" ${presetLevel === 2 ? 'selected' : ''}>${t('levelLabels')[2]}</option>
            <option value="3" ${presetLevel === 3 ? 'selected' : ''}>${t('levelLabels')[3]}</option>
            <option value="4" ${presetLevel === 4 ? 'selected' : ''}>${t('levelLabels')[4]}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>${t('categoryFilter')}</label>
          <select id="pCategory">
            <option value="0">${t('allCategories')}</option>
            ${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="filter-group">
          <label>${t('difficultyFilter')}</label>
          <select id="pDifficulty">
            <option value="0">${t('allDifficulties')}</option>
            <option value="1">${t('diffLabels')[1]}</option>
            <option value="2">${t('diffLabels')[2]}</option>
            <option value="3">${t('diffLabels')[3]}</option>
          </select>
        </div>
        <div class="filter-group">
          <label>${t('countFilter')}</label>
          <select id="pCount">
            <option value="5">${t('questionsUnit', 5)}</option>
            <option value="10" selected>${t('questionsUnit', 10)}</option>
            <option value="20">${t('questionsUnit', 20)}</option>
            <option value="0">${t('countAll')}</option>
          </select>
        </div>
        <div class="filter-group" style="justify-content:flex-end">
          <button class="btn btn-primary" onclick="startPractice()">${t('startPracticeBtn')}</button>
        </div>
      </div>
      ${practiceDeptSwitchHtml()}
    </div>
    <div id="practiceQuiz"></div>
    ${challengeEntryHtml()}
  `
}

// 七天挑战入口卡片（v70：入口移入练习页下方，不再是独立导航项；v77 未开放/已结束时提示锁定态）
// v88：多期营次 —— 显示当前营次名；锁定态分「未开始 / 未开放 / 已结束」三种文案。
// v89：标题按学员所属分部门（各部门题不同、各自上传）
// v107：按适用部门门禁 —— 只有饮食部四个二级分队（标帜/艳中/酒吧团队/客房送餐）可进；
//       房务部/其他部门学员看到的是「不可参加」的说明卡（不可点击），不再是进去后「未开放」的死胡同。
// v109：营次动态门禁 —— 有资格但本部门在当前营次列表没有专属营次（如酒吧团队/客房送餐，
//       目前只有标帜/艳中开了营）时，显示「本部门暂无挑战」卡，不再渲染「本部门标题 + 别队营次名」的错位卡。
// v110：一级部门视角（饮食部）汇总展示其下所有分部门的挑战 —— 卡片列出本视角各期（部门标签 + 期名 + 开放态）。
function challengeEntryHtml() {
  challengeLoad()
  // v107：部门白名单门禁（管理员豁免）
  const deptOk = typeof chDeptAllowed === 'function' ? chDeptAllowed() : true
  if (!deptOk) return challengeEntryBlockedHtml()
  // v109：本部门暂无专属营次 → 说明卡（管理员切片到无营次部门时同样生效）
  // v110：判定已按「视角营次列表」——大部门视角其下分部门有营次即不拦（修复「饮食部看不到下属部门挑战」）
  if (typeof chNoRoundForDept === 'function' && chNoRoundForDept()) return challengeEntryNoRoundHtml()
  const doneDays = CHALLENGE_DAYS.filter(d => chDayDone(d.day)).length
  const locked = typeof chOpenLocked === 'function' && chOpenLocked()
  const st = typeof chRoundOpenState === 'function' ? chRoundOpenState() : { state: 'closed' }
  const rName = typeof chRoundName === 'function' ? chRoundName() : '第一期'
  const title = typeof chTitleText === 'function' ? chTitleText() : t('chTitle')
  const deptName = typeof chDeptName === 'function' ? chDeptName() : ''
  const lockHint = locked
    ? `<p class="form-hint" style="margin:4px 0 0;color:#9ca3af">${st.state === 'upcoming' ? '⏳ ' + t('chRoundUpcoming', rName) : st.state === 'ended' ? '🏁 ' + t('chEnded') : '🔒 ' + t('chNotOpen')}</p>`
    : ''
  return `
    <div class="card" onclick="navigate('challenge')" style="cursor:pointer;margin-top:16px;border:2px solid #f59e0b">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:32px">🏅</div>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px">${escHtml(title)} <span style="font-size:12px;font-weight:600;color:#2563eb">· ${escHtml(rName)}</span></h3>
          ${deptName ? `<p class="form-hint" style="margin:0 0 2px"><span style="font-size:11px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:999px;padding:1px 8px">🏷️ ${escHtml(deptName)}</span></p>` : ''}
          <p class="form-hint" style="margin:0">${t('chEntryHint', doneDays)}</p>
          ${lockHint}
        </div>
        <div style="font-size:22px;color:#9ca3af">›</div>
      </div>
      ${challengeEntryRoundPreviewHtml()}
    </div>`
}

// v110：入口卡内嵌「本部门历期」预览（两期以上才渲染，与挑战页 chRoundListHtml 同源口径）。
// v153 收紧：汇总视角不再列别队营次 —— 取数与挑战页同走 chRoundCardList（汇总视角只显示登录账号自己部门）。
// 让学员在练习页就能看到「本部门已开了哪几期」而无需进挑战页。
function challengeEntryRoundPreviewHtml() {
  try {
    // v153：优先走与挑战页同源的 chRoundCardList；旧沙箱/部分加载只注入了 chRoundListForView 时回落旧口径
    const list = (typeof chRoundCardList === 'function')
      ? chRoundCardList()
      : ((typeof chRoundListForView === 'function') ? chRoundListForView() : [])
    if (list.length < 2) return ''
    const rows = list.map(r => {
      const st = (typeof roundOpenState === 'function') ? roundOpenState(r, Date.now()) : { state: 'closed' }
      const depts = (Array.isArray(r && r.depts) ? r.depts : [])
        .map(d => (typeof deptSlugName === 'function' && deptSlugName(d)) || d)
        .filter(Boolean)
      const tags = depts.length
        ? depts.map(n => `<span style="font-size:11px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:999px;padding:1px 8px">🏷️ ${escHtml(n)}</span>`).join(' ')
        : ''
      const stateTag = st.state === 'open'
        ? `<span style="font-size:11px;color:#059669;font-weight:700">● ${t('chRoundOpenTag')}</span>`
        : st.state === 'upcoming'
          ? `<span style="font-size:11px;color:#b45309;font-weight:700">⏳ ${t('chRoundUpcomingTag')}</span>`
          : st.state === 'ended'
            ? `<span style="font-size:11px;color:#6b7280;font-weight:700">🏁 ${t('chEnded')}</span>`
            : `<span style="font-size:11px;color:#9ca3af;font-weight:700">🔒 ${t('chNotOpen')}</span>`
      return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0">
        <span style="font-weight:700;font-size:12px">${escHtml(String(r.name || r.id || ''))}</span>${stateTag}${tags}</div>`
    }).join('')
    return `<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #fde68a">
      <p class="form-hint" style="margin:0 0 2px;font-weight:700">📋 ${t('chRoundListTitle', list.length)}</p>
      ${rows}
    </div>`
  } catch (e) { return '' }
}

// v107：不具备七天挑战部门资格时的说明卡（不可点击，非锁定态 —— 是「不适用」而非「未开放」）。
// 列出四个适用分队，让学员清楚该找谁参加；未设部门的提示去个人资料补选。
function challengeEntryBlockedHtml() {
  const reason = typeof chDeptBlockReason === 'function' ? chDeptBlockReason() : 'chDeptNotEligible'
  const slugs = (typeof CH_DEPT_SLUGS !== 'undefined' ? CH_DEPT_SLUGS : [])
    .map(s => (typeof deptSlugName === 'function' && deptSlugName(s)) || s)
  const list = slugs.length
    ? `<p class="form-hint" style="margin:6px 0 0">${t('chDeptEligibleList')}</p>
       <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
         ${slugs.map(n => `<span style="font-size:11px;background:#f3f4f6;color:#4b5563;border:1px solid #e5e7eb;border-radius:999px;padding:2px 10px">${escHtml(n)}</span>`).join('')}
       </div>`
    : ''
  const cta = reason === 'chDeptNeedSet'
    ? `<button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="event.stopPropagation();openProfileSetup()">${t('chDeptGoSet')}</button>`
    : ''
  return `
    <div class="card" style="margin-top:16px;border:2px dashed #d1d5db;background:#fafafa">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:32px;opacity:.5">🏅</div>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px;color:#6b7280">${escHtml(t('chTitle'))}</h3>
          <p class="form-hint" style="margin:0;color:#9ca3af">🚫 ${t(reason)}</p>
          ${list}
          ${cta}
        </div>
      </div>
    </div>`
}

// v109：有资格但本部门暂无专属营次时的说明卡（酒吧团队/客房送餐等；管理员切片到无营次部门同此卡）。
// 列出当前实际开设了营次的部门，学员一眼看清「现在谁的挑战开着」；不显示别队营次名，避免错位。
function challengeEntryNoRoundHtml() {
  let names = []
  try {
    const rounds = (typeof CloudSync !== 'undefined' && Array.isArray(CloudSync._chRounds)) ? CloudSync._chRounds : []
    rounds.forEach(r => {
      ;(Array.isArray(r && r.depts) ? r.depts : []).forEach(d => {
        if (!d) return
        let n = d
        if (d.indexOf('/') >= 0) n = (typeof deptSlugName === 'function' && deptSlugName(d)) || d
        else try { n = (deptTree()[d] || {}).name || d } catch (e) {}
        if (names.indexOf(n) < 0) names.push(n)
      })
    })
  } catch (e) { names = [] }
  const list = names.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${names.map(n => `<span style="font-size:11px;background:#fffbeb;color:#b45309;border:1px solid #fde68a;border-radius:999px;padding:2px 10px">${escHtml(n)}</span>`).join('')}</div>`
    : ''
  return `
    <div class="card" style="margin-top:16px;border:2px dashed #fde68a;background:#fffbeb">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:32px;opacity:.5">🏅</div>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px;color:#6b7280">${escHtml(t('chTitle'))}</h3>
          <p class="form-hint" style="margin:0;color:#9ca3af">🚫 ${t('chDeptNoRound')}</p>
          ${list}
        </div>
      </div>
    </div>`
}

function startPractice() {
  const cat = document.getElementById('pCategory').value
  const diff = document.getElementById('pDifficulty').value
  const lvl = document.getElementById('pLevel').value
  let count = Number(document.getElementById('pCount').value)
  // v156：统一走 practiceDeptKey() —— 管理员=切片，学员=本人分部门（v92 起学员走大部门 key → 混题）
  const deptKey = practiceDeptKey()
  let { list } = Store.queryQuestions({
    category_id: cat !== '0' ? cat : undefined,
    difficulty: diff !== '0' ? diff : undefined,
    dept: deptKey
  })
  // 等级筛选
  if (lvl !== '0') list = list.map(q => ({ ...q, level: levelOf(q) })).filter(q => q.level === Number(lvl))
  else list = list.map(q => ({ ...q, level: levelOf(q) }))
  // shuffle 题目顺序 + 随机打乱选项（答案位置不固定）
  list = list.sort(() => Math.random() - 0.5).map(shuffleOptions)
  if (count > 0) list = list.slice(0, count)
  if (list.length === 0) {
    document.getElementById('practiceQuiz').innerHTML = `<div class="card"><p style="text-align:center;color:#9ca3af;">${t('noMatchQuestions')}</p></div>`
    return
  }
  practiceState = { questions: list, index: 0, answers: [], submitted: false, correctCount: 0 }
  renderPracticeQuestion()
}

function renderPracticeQuestion() {
  const q = practiceState.questions[practiceState.index]
  const el = document.getElementById('practiceQuiz')
  const qt = safeQType(q)
  // v87：原先写 `answers[i] || ...`，而选项 A 的索引是 0（falsy）→ 渲染时被当成「未作答」，
  // 学生点了 A 选项却不高亮，看起来「这题选不了」。改为严格判空。
  const rawAns = practiceState.answers[practiceState.index]
  const ans = (rawAns === undefined || rawAns === null)
    ? (qt === 'multiple' ? [] : qt === 'fill' || qt === 'translate' ? '' : -1)
    : rawAns
  const submitted = practiceState.submitted

  let optionsHtml = ''
  if (qt === 'voicematch') {
    optionsHtml = vmOptionsHtml(q, ans, submitted ? 'review' : 'live', 'selectOption', 'renderPracticeQuestion')
  } else if (qt === 'single' || qt === 'judge' || qt === 'pronounce' || qt === 'listen') {
    // v107：只渲染有效选项（同步删除尾部空槽），判分下标仍用原始 i
    optionsHtml = visibleOptionIndexes(q.options).map(i => {
      const opt = q.options[i]
      let cls = 'option-item'
      if (submitted) {
        if (q.answer.includes(i)) cls += ' correct'
        else if (ans === i) cls += ' wrong'
      } else if (ans === i) {
        cls += ' selected'
      }
      const badge = submitted && q.answer.includes(i) ? '✓' : LETTERS[i]
      return `<div class="${cls}" onclick="${submitted ? '' : `selectOption(${i})`}">
        <div class="option-badge">${badge}</div>
        <div class="option-text">${opt}</div>
      </div>`
    }).join('')
  } else if (qt === 'multiple') {
    optionsHtml = visibleOptionIndexes(q.options).map(i => {
      const opt = q.options[i]
      let cls = 'option-item'
      const selected = ans.includes(i)
      if (submitted) {
        if (q.answer.includes(i)) cls += ' correct'
        else if (selected) cls += ' wrong'
      } else if (selected) {
        cls += ' selected'
      }
      const badge = submitted && q.answer.includes(i) ? '✓' : LETTERS[i]
      return `<div class="${cls}" onclick="${submitted ? '' : `toggleOption(${i})`}">
        <div class="option-badge">${badge}</div>
        <div class="option-text">${opt}</div>
      </div>`
    }).join('')
  } else if (qt === 'fill' || qt === 'translate') {
    let cls = 'input-answer'
    if (submitted) {
      cls += ans.toString().trim().toLowerCase() === q.options[0].toString().trim().toLowerCase() ? ' correct' : ' wrong'
    }
    optionsHtml = `<input type="text" class="${cls}" placeholder="${t('answerPlaceholder')}" value="${ans}"
      oninput="onTextInput(this.value)" ${submitted ? 'disabled' : ''} />`
  }

  let feedbackHtml = ''
  if (submitted) {
    const isCorrect = checkAnswer(q, ans)
    feedbackHtml = `<div class="feedback ${isCorrect ? 'correct' : 'wrong'}">
      <strong>${isCorrect ? t('correctFeedback') : t('wrongFeedback')}</strong>
      <div class="explanation">${q.explanation || t('noExplanation')}</div>
      ${qt !== 'fill' && qt !== 'translate' ? `<div class="explanation">${t('correctAnswer')}：${(Array.isArray(q.answer) ? q.answer : [q.answer]).map(i => LETTERS[i]).join(', ')}</div>` : `<div class="explanation">${t('correctAnswer')}：${q.options[0]}</div>`}
    </div>`
  }

  el.innerHTML = `
    <div class="card">
      <div class="q-meta">
        <span class="tag tag-category">${Store.getCategoryName(q.category_id)}</span>
        <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
        <span class="tag tag-level level-tag-${q.level || levelOf(q)}">${LEVEL_LABELS[q.level || levelOf(q)]}</span>
        <span class="tag tag-diff-${q.difficulty}">${DIFFICULTY_LABELS[q.difficulty]}</span>
      </div>
      ${quizTitleHtml(q)}
      <div class="options-list">${optionsHtml}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', practiceState.index + 1, practiceState.questions.length)}</div>
        <div>
          ${!submitted ? `<button class="btn btn-primary" onclick="submitPractice()">${t('submitAnswer')}</button>` :
            practiceState.index < practiceState.questions.length - 1 ?
            `<button class="btn btn-primary" onclick="nextPractice()">${t('nextQuestion')}</button>` :
            `<button class="btn btn-success" onclick="finishPractice()">${t('finishPractice')}</button>`}
        </div>
      </div>
    </div>
  `
  if (!submitted) autoplayListen(q)
}

function selectOption(i) {
  const q = practiceState.questions[practiceState.index]
  practiceState.answers[practiceState.index] = i
  renderPracticeQuestion()
}
function toggleOption(i) {
  const q = practiceState.questions[practiceState.index]
  const cur = practiceState.answers[practiceState.index]
  let ans = Array.isArray(cur) ? cur.slice() : []
  if (ans.includes(i)) ans = ans.filter(x => x !== i)
  else ans = [...ans, i]
  practiceState.answers[practiceState.index] = ans
  renderPracticeQuestion()
}
function onTextInput(val) {
  practiceState.answers[practiceState.index] = val
}
// 判分口径与渲染口径共用 safeQType（v87）：选项不足 2 个的选择题按填空判分，
// 避免「页面渲染成填空、判分却按选项索引比」的错位；同时容忍 answer 未写成数组的历史数据。
function checkAnswer(q, ans) {
  const t = safeQType(q)
  const ansArr = Array.isArray(q.answer) ? q.answer : [q.answer]
  if (t === 'single' || t === 'judge' || t === 'pronounce' || t === 'listen' || t === 'voicematch') {
    return ansArr.includes(ans)
  } else if (t === 'multiple') {
    const sel = Array.isArray(ans) ? ans : []
    return sel.length === ansArr.length && ansArr.every(i => sel.includes(i))
  } else if (t === 'fill' || t === 'translate') {
    const target = (q.options && q.options[0] != null) ? q.options[0] : ''
    return String(ans == null ? '' : ans).trim().toLowerCase() === String(target).trim().toLowerCase()
  }
  return false
}
function submitPractice() {
  const q = practiceState.questions[practiceState.index]
  const ans = practiceState.answers[practiceState.index]
  if (ans === undefined || ans === -1 || (Array.isArray(ans) && ans.length === 0) || (typeof ans === 'string' && !ans.trim())) {
    return
  }
  practiceState.submitted = true
  const correct = checkAnswer(q, ans)
  if (correct) practiceState.correctCount++
  // Save to progress
  Store.addProgress({
    question_id: q.id,
    category_id: q.category_id,
    dept: q.dept || '',
    type: q.type,
    correct,
    mode: 'practice'
  })
  renderPracticeQuestion()
}
function nextPractice() {
  if (practiceState.index < practiceState.questions.length - 1) {
    practiceState.index++
    practiceState.submitted = false
    renderPracticeQuestion()
  }
}
function finishPractice() {
  const el = document.getElementById('practiceQuiz')
  const total = practiceState.questions.length
  const correct = practiceState.correctCount
  const pct = Math.round(correct / total * 100)
  // —— 追踪练习完成 ——
  Store.trackPractice(correct, total)
  el.innerHTML = `
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:12px">${pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '💪'}</div>
      <h2 style="font-size:24px;margin-bottom:8px">${t('practiceDone')}</h2>
      <p style="color:#6b7280;margin-bottom:24px">${t('practiceResult', correct, total, pct)}</p>
      <button class="btn btn-primary" onclick="renderPractice()">${t('anotherRound')}</button>
    </div>
  `
}

// ====== Exam Page ======
let examState = null
let examTimer = null

function renderExam() {
  if (examState && examState.phase === 'quiz') return // don't re-render during exam
  if (examState && examState.phase === 'result') {
    renderExamResult()
    return
  }
  // 离开考试回到配置页：确保防作弊已关闭
  if (typeof AntiCheat !== 'undefined') AntiCheat.stop()
  examState = null
  const categories = Store.getCategories()
  const el = document.getElementById('page-exam')
  const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()
  const totalQ = Store.getQuestionsByDept(deptKey).length
  el.innerHTML = `
    <div class="card">
      <h3>${t('examSettings')}</h3>
      <p style="color:#6b7280;margin-bottom:16px;font-size:14px">${t('examAvailable', totalQ)}</p>
      <div class="config-grid">
        <div class="config-item">
          <label>${t('categoryFilter')}</label>
          <select id="eCategory">
            <option value="0">${t('allCategories')}</option>
            ${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="config-item">
          <label>${t('difficultyFilter')}</label>
          <select id="eDifficulty">
            <option value="0">${t('allDifficulties')}</option>
            <option value="1">${t('diffLabels')[1]}</option>
            <option value="2">${t('diffLabels')[2]}</option>
            <option value="3">${t('diffLabels')[3]}</option>
          </select>
        </div>
        <div class="config-item">
          <label>${t('countFilter')}</label>
          <select id="eCount">
            <option value="5">${t('questionsUnit', 5)}</option>
            <option value="10" selected>${t('questionsUnit', 10)}</option>
            <option value="20">${t('questionsUnit', 20)}</option>
            <option value="50">${t('questionsUnit', 50)}</option>
          </select>
        </div>
        <div class="config-item">
          <label>${t('durationLabel')}</label>
          <select id="eDuration">
            <option value="5">${t('minutesUnit', 5)}</option>
            <option value="10" selected>${t('minutesUnit', 10)}</option>
            <option value="20">${t('minutesUnit', 20)}</option>
            <option value="30">${t('minutesUnit', 30)}</option>
            <option value="60">${t('minutesUnit', 60)}</option>
          </select>
        </div>
      </div>
      <div style="margin-top:20px">
        <button class="btn btn-primary" onclick="startExam()">${t('startExamBtn')}</button>
      </div>
    </div>
  `
}

function startExam() {
  const cat = document.getElementById('eCategory').value
  const diff = document.getElementById('eDifficulty').value
  const count = Number(document.getElementById('eCount').value)
  const duration = Number(document.getElementById('eDuration').value) * 60

  const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()
  let { list } = Store.queryQuestions({
    category_id: cat !== '0' ? cat : undefined,
    difficulty: diff !== '0' ? diff : undefined,
    dept: deptKey
  })
  // shuffle 题目顺序 + 随机打乱选项（答案位置不固定）
  list = list.sort(() => Math.random() - 0.5).map(shuffleOptions).slice(0, count)

  if (list.length === 0) {
    alert(t('errNoQuestions'))
    return
  }

  const answers = list.map(q => {
    if (q.type === 'multiple') return []
    if (q.type === 'fill' || q.type === 'translate') return ''
    return -1   // single / judge / pronounce / listen
  })

  examState = {
    phase: 'quiz',
    questions: list,
    answers,
    currentIndex: 0,
    duration,
    startTime: Date.now(),
    remaining: duration,
    flagged: new Set()
  }

  startExamTimer()
  // 考试防作弊：禁止切屏，超 3 次自动交卷（管理员/日照账号在 AntiCheat 内部自动豁免，v200）
  if (typeof AntiCheat !== 'undefined') {
    AntiCheat.start({ maxViolations: 3, onSubmit: function () { finishExam(false) } })
  }
  renderExamQuestion()
}

function startExamTimer() {
  if (examTimer) clearInterval(examTimer)
  examTimer = setInterval(() => {
    if (!examState || examState.phase !== 'quiz') return
    examState.remaining--
    if (examState.remaining <= 0) {
      examState.remaining = 0
      clearInterval(examTimer)
      finishExam(true)
      return
    }
    updateTimerDisplay()
  }, 1000)
}

function updateTimerDisplay() {
  const el = document.getElementById('examTimerDisplay')
  if (!el) return
  const m = Math.floor(examState.remaining / 60)
  const s = examState.remaining % 60
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  el.classList.toggle('warning', examState.remaining <= 30)
}

function renderExamQuestion() {
  const q = examState.questions[examState.currentIndex]
  const ans = examState.answers[examState.currentIndex]
  const el = document.getElementById('page-exam')
  const qt = safeQType(q)

  let optionsHtml = ''
  if (qt === 'voicematch') {
    optionsHtml = vmOptionsHtml(q, ans, 'live', 'examSelect', 'renderExamQuestion')
  } else if (qt === 'single' || qt === 'judge' || qt === 'pronounce' || qt === 'listen') {
    // v107：只渲染有效选项（同步删除尾部空槽）
    optionsHtml = visibleOptionIndexes(q.options).map(i => {
      const opt = q.options[i]
      let cls = 'option-item'
      if (ans === i) cls += ' selected'
      return `<div class="${cls}" onclick="examSelect(${i})">
        <div class="option-badge">${LETTERS[i]}</div>
        <div class="option-text">${opt}</div>
      </div>`
    }).join('')
  } else if (qt === 'multiple') {
    optionsHtml = visibleOptionIndexes(q.options).map(i => {
      const opt = q.options[i]
      let cls = 'option-item'
      if (Array.isArray(ans) && ans.includes(i)) cls += ' selected'
      return `<div class="${cls}" onclick="examToggle(${i})">
        <div class="option-badge">${LETTERS[i]}</div>
        <div class="option-text">${opt}</div>
      </div>`
    }).join('')
  } else if (qt === 'fill' || qt === 'translate') {
    optionsHtml = `<input type="text" class="input-answer" placeholder="${t('answerPlaceholder')}" value="${ans}"
      oninput="examInput(this.value)" />`
  }

  el.innerHTML = `
    <div class="exam-timer">
      <div>
        <span style="font-size:13px;color:#6b7280">${t('timeRemaining')}</span>
        <span class="timer-display" id="examTimerDisplay"></span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="examFlag()"> ${examState.flagged.has(examState.currentIndex) ? t('unflagBtn') : t('flagBtn')}</button>
        <button class="btn btn-danger btn-sm" onclick="confirmSubmitExam()">${t('submitExam')}</button>
      </div>
    </div>
    <div class="exam-nav" style="margin-bottom:16px">
      ${examState.questions.map((_, i) => {
        let cls = 'exam-nav-dot'
        if (i === examState.currentIndex) cls += ' current'
        else if (isExamAnswered(i)) cls += ' answered'
        if (examState.flagged.has(i)) cls += ' flagged'
        return `<div class="${cls}" onclick="examGoto(${i})">${i+1}</div>`
      }).join('')}
    </div>
    <div class="card">
      <div class="q-meta">
        <span class="tag tag-category">${Store.getCategoryName(q.category_id)}</span>
        <span class="tag tag-type">${TYPE_LABELS[q.type]}</span>
        <span class="tag tag-diff-${q.difficulty}">${DIFFICULTY_LABELS[q.difficulty]}</span>
      </div>
      ${quizTitleHtml(q)}
      <div class="options-list">${optionsHtml}</div>
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', examState.currentIndex + 1, examState.questions.length)}</div>
        <div style="display:flex;gap:8px">
          ${examState.currentIndex > 0 ? `<button class="btn btn-ghost" onclick="examPrev()">${t('prevQuestion')}</button>` : ''}
          ${examState.currentIndex < examState.questions.length - 1 ? `<button class="btn btn-primary" onclick="examNext()">${t('nextQuestion')}</button>` : `<button class="btn btn-danger" onclick="confirmSubmitExam()">${t('submitExam')}</button>`}
        </div>
      </div>
    </div>
  `
  updateTimerDisplay()
  autoplayListen(q)
}

function isExamAnswered(i) {
  const ans = examState.answers[i]
  if (ans === -1 || ans === undefined) return false
  if (Array.isArray(ans)) return ans.length > 0
  if (typeof ans === 'string') return ans.trim().length > 0
  return true
}
function examSelect(i) {
  examState.answers[examState.currentIndex] = i
  renderExamQuestion()
}
function examToggle(i) {
  let ans = examState.answers[examState.currentIndex]
  if (ans.includes(i)) ans = ans.filter(x => x !== i)
  else ans = [...ans, i]
  examState.answers[examState.currentIndex] = ans
  renderExamQuestion()
}
function examInput(val) {
  examState.answers[examState.currentIndex] = val
}
function examPrev() {
  if (examState.currentIndex > 0) {
    examState.currentIndex--
    renderExamQuestion()
  }
}
function examNext() {
  if (examState.currentIndex < examState.questions.length - 1) {
    examState.currentIndex++
    renderExamQuestion()
  }
}
function examGoto(i) {
  examState.currentIndex = i
  renderExamQuestion()
}
function examFlag() {
  if (examState.flagged.has(examState.currentIndex)) examState.flagged.delete(examState.currentIndex)
  else examState.flagged.add(examState.currentIndex)
  renderExamQuestion()
}
function confirmSubmitExam() {
  const unanswered = examState.answers.filter(a => !isExamAnswered2(a)).length
  if (unanswered > 0) {
    if (!confirm(t('confirmSubmit', unanswered))) return
  }
  finishExam(false)
}
function isExamAnswered2(ans) {
  if (ans === -1 || ans === undefined) return false
  if (Array.isArray(ans)) return ans.length > 0
  if (typeof ans === 'string') return ans.trim().length > 0
  return true
}

function finishExam(timeout) {
  if (examTimer) clearInterval(examTimer)
  if (typeof AntiCheat !== 'undefined') AntiCheat.stop()
  examState.phase = 'result'
  // Grade
  let correct = 0
  const review = examState.questions.map((q, i) => {
    const ans = examState.answers[i]
    const isCorrect = checkAnswer(q, ans)
    if (isCorrect) correct++
    return { q, ans, isCorrect }
  })
  const total = examState.questions.length
  const score = Math.round(correct / total * 100)
  const passed = score >= 60

  // Save exam record
  Store.addExam({
    score,
    total,
    correct,
    duration: examState.duration,
    elapsed: examState.duration - examState.remaining,
    passed,
    config: {
      category: examState.questions[0]?.category_id,
      difficulty: null,
      count: total
    }
  })
  // —— 追踪考试完成（管理员看板可见）——
  Store.trackExam(score, total, correct, passed)
  // Also save individual question progress
  review.forEach(r => {
    Store.addProgress({
      question_id: r.q.id,
      category_id: r.q.category_id,
      dept: r.q.dept || '',
      type: r.q.type,
      correct: r.isCorrect,
      mode: 'exam'
    })
  })

  examState.review = review
  examState.score = score
  examState.correct = correct
  examState.total = total
  examState.passed = passed
  examState.timeout = timeout

  renderExamResult()
}

// ====== v108：成绩同步状态徽章（bug5「确保以后不会再有成绩进不来」）======
// 学员交卷后最关心的一件事是「我的成绩到底传上去了没有」。这里把 cloud-store 的
// 队列状态直接摊开给他看：已同步 ✅ / 同步中 ⏳ / 待同步 ⚠️（自动重试中）。
// 状态由 CloudSync.syncState() 实时计算（队列长度 + 最近一次连接结果），
// 页面刷新后依然如实 —— 队列是 localStorage 持久化的，不会因为刷新就变「已同步」。
function syncBadgeHtml(id) {
  if (typeof CloudSync === 'undefined' || typeof CloudSync.syncState !== 'function') return ''
  const s = CloudSync.syncState()
  const map = {
    synced: { icon: '✅', key: 'syncDone', color: '#059669', bg: '#d1fae5', bd: '#a7f3d0' },
    pending: { icon: '⏳', key: 'syncPending', color: '#92400e', bg: '#fffbeb', bd: '#fde68a' },
    error: { icon: '⚠️', key: 'syncError', color: '#b45309', bg: '#fef3c7', bd: '#fcd34d' },
  }
  const v = map[s] || map.pending
  return `<div id="${escAttr(id)}" style="margin:14px auto 0;max-width:560px;padding:10px 14px;border-radius:10px;background:${v.bg};border:1px solid ${v.bd};color:${v.color};font-size:13px;display:flex;align-items:center;gap:8px;justify-content:center;flex-wrap:wrap">
    <span style="font-size:15px">${v.icon}</span><span>${t(v.key)}</span>
    ${s !== 'synced' ? `<button class="btn btn-sm" style="padding:2px 10px;font-size:12px" onclick="retrySyncNow(this)">${t('syncRetryNow')}</button>` : ''}
  </div>`
}
// 手动催一次上报（平时无需点，纯粹给学员一个安心按钮）
async function retrySyncNow(btn) {
  if (typeof CloudSync === 'undefined') return
  if (btn) { btn.disabled = true; btn.textContent = t('syncing') }
  try { await CloudSync.pushPending() } catch (e) { /* 状态徽章会自动反映结果 */ }
  refreshSyncBadges()
}
// 就地刷新页面上所有同步徽章（不重绘整页，避免打断学员看解析）
function refreshSyncBadges() {
  if (typeof CloudSync === 'undefined' || typeof CloudSync.syncState !== 'function') return
  document.querySelectorAll('[data-sync-badge]').forEach(el => {
    const id = el.id
    const tmp = document.createElement('div')
    tmp.innerHTML = syncBadgeHtml(id)
    const fresh = tmp.firstElementChild
    if (fresh) { fresh.setAttribute('data-sync-badge', '1'); el.replaceWith(fresh) }
  })
}
// 状态变化时自动刷新徽章（注册一次即可，见 init 末尾）
function bindSyncBadgeListener() {
  if (typeof CloudSync === 'undefined' || typeof CloudSync.onSyncState !== 'function') return
  CloudSync.onSyncState(() => refreshSyncBadges())
}

function renderExamResult() {
  const el = document.getElementById('page-exam')
  el.innerHTML = `
    <div class="result-hero ${examState.passed ? 'score-pass' : 'score-fail'}">
      <div class="emoji">${examState.passed ? '🎉' : '😅'}</div>
      <div class="score">${examState.score}<span style="font-size:24px">${t('scoreUnit')}</span></div>
      <div class="grade">${examState.passed ? t('examPassed') : t('examFailed')}${examState.timeout ? t('autoSubmitTimeout') : ''}</div>
      <div class="result-stats">
        <div class="result-stat">
          <div class="val">${examState.correct}</div>
          <div class="lbl">${t('statCorrect')}</div>
        </div>
        <div class="result-stat">
          <div class="val" style="color:#dc2626">${examState.total - examState.correct}</div>
          <div class="lbl">${t('statWrong')}</div>
        </div>
        <div class="result-stat">
          <div class="val" style="color:#DD3D00">${examState.total}</div>
          <div class="lbl">${t('statTotal')}</div>
        </div>
      </div>
    </div>
    <div data-sync-badge="1">${syncBadgeHtml('syncBadgeExam')}</div>
    <h3 class="section-title">${t('reviewTitle')}</h3>
    ${examState.review.map((r, i) => {
      const q = r.q
      let yourAns = ''
      let correctAns = ''
      if (q.type === 'single' || q.type === 'judge' || q.type === 'pronounce' || q.type === 'listen' || q.type === 'voicematch') {
        yourAns = r.ans >= 0 ? `${LETTERS[r.ans]}. ${q.options[r.ans] || ''}` : t('notAnswered')
        correctAns = q.answer.map(a => `${LETTERS[a]}. ${q.options[a]}`).join('；')
      } else if (q.type === 'multiple') {
        yourAns = r.ans.length > 0 ? r.ans.map(a => `${LETTERS[a]}. ${q.options[a]}`).join('；') : t('notAnswered')
        correctAns = q.answer.map(a => `${LETTERS[a]}. ${q.options[a]}`).join('；')
      } else {
        yourAns = r.ans || t('notAnswered')
        correctAns = q.options[0]
      }
      return `<div class="review-item ${r.isCorrect ? 'correct' : 'wrong'}">
        <div class="review-q">${i+1}. ${q.type === 'listen' || q.type === 'voicematch' ? `<button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">${audioIconSvg('up')}</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">${audioIconSvg('down')}</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">${audioIconSvg('globe')}</button> ${q.question}` : q.question}</div>
        <div class="review-ans">${t('yourAnswer')}<span class="${r.isCorrect ? 'review-correct' : 'review-wrong'}">${yourAns}</span></div>
        ${!r.isCorrect ? `<div class="review-ans">${t('correctAnswer')}：<span class="review-correct">${correctAns}</span></div>` : ''}
        ${q.explanation ? `<div class="review-ans" style="color:#6b7280">${q.explanation}</div>` : ''}
      </div>`
    }).join('')}
    <div style="text-align:center;margin-top:24px">
      <button class="btn btn-primary" onclick="examState=null;renderExam()">${t('retakeExam')}</button>
    </div>
  `
}

// ====== Progress Page ======
function renderProgress() {
  const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()
  const stats = Store.getStats(deptKey)
  const el = document.getElementById('page-progress')
  const allHistory = [...Store.getProgress().slice(0, 30)]
  const lv = Store.getUserLevel()
  el.innerHTML = `
    <div class="progress-stats">
      <div class="progress-stat-card">
        <div class="val ${lv ? 'purple' : ''}">${lv ? 'L' + lv : '—'}</div>
        <div class="lbl">${t('currentLevel')}${lv ? '（' + t('levelShort')[lv] + '）' : t('notPlacedYet')}</div>
      </div>
      <div class="progress-stat-card">
        <div class="val green">${stats.accuracy}%</div>
        <div class="lbl">${t('totalAccuracy')}</div>
      </div>
      <div class="progress-stat-card">
        <div class="val blue">${stats.totalAnswered}</div>
        <div class="lbl">${t('totalAnsweredCount')}</div>
      </div>
      <div class="progress-stat-card">
        <div class="val">${stats.correctCount}</div>
        <div class="lbl">${t('correctCountLabel')}</div>
      </div>
      <div class="progress-stat-card">
        <div class="val orange">${stats.examCount}</div>
        <div class="lbl">${t('examCountLabel')}</div>
      </div>
      <div class="progress-stat-card">
        <div class="val">${stats.examAvgScore}</div>
        <div class="lbl">${t('examAvgScore')}</div>
      </div>
      <div class="progress-stat-card">
        <div class="val blue">${stats.totalQuestions}</div>
        <div class="lbl">${t('bankTotal')}</div>
      </div>
    </div>

    <h3 class="section-title">${t('categoryCoverage')}</h3>
    <div class="card">
      ${stats.categoryStats.map(cat => {
        const pct = cat.totalQuestions > 0 ? Math.round(cat.answered / cat.totalQuestions * 100) : 0
        const cls = pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red'
        return `<div class="cat-progress-item">
          <div class="cat-name">${cat.name}</div>
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill ${cls}" style="width:${pct}%"></div>
          </div>
          <div class="cat-stats">${cat.answered}/${cat.totalQuestions} · ${cat.accuracy}%</div>
        </div>`
      }).join('')}
    </div>

    <h3 class="section-title">${t('recentHistory')}</h3>
    <div class="history-list">
      ${allHistory.length === 0 ? `<div class="card"><p style="text-align:center;color:#9ca3af;">${t('noHistory')}</p></div>` :
        allHistory.map(h => {
          const q = Store.getQuestion(h.question_id)
          return `<div class="history-item">
            <div class="h-left">
              <span class="h-mode ${h.mode}">${h.mode === 'exam' ? t('modeExam') : t('modePractice')}</span>
              <span style="font-size:14px">${q ? q.question.substring(0, 30) + (q.question.length > 30 ? '...' : '') : t('questionDeleted')}</span>
            </div>
            <div style="display:flex;gap:12px;align-items:center">
              <span class="h-result ${h.correct ? 'green' : 'red'}">${h.correct ? t('resultCorrect') : t('resultWrong')}</span>
              <span class="h-time">${formatTime(h.timestamp)}</span>
            </div>
          </div>`
        }).join('')}
    </div>
  `
}

function formatTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  if (diff < 60000) return t('justNow')
  if (diff < 3600000) return t('minutesAgo', Math.floor(diff/60000))
  if (diff < 86400000) return t('hoursAgo', Math.floor(diff/3600000))
  return t('monthDay', d.getMonth()+1, d.getDate())
}

// ====== Admin Page ======
// v89：题库 tab 各自独立的筛选状态（饮食部四分队 slug + 房务部 + 通用）
// v196：日照两分部进入题库管理 tab（题库按部门上传/统计/保存均走 adminDeptSetOf）
const ADMIN_DEPT_TABS = ['dining/sig', 'dining/yan', 'dining/bar', 'dining/ird', 'rizhao/canyin', 'rizhao/fangwu', 'rooms', 'all']
let adminStates = (() => {
  const m = {}
  ADMIN_DEPT_TABS.forEach(k => { m[k] = { page: 1, pageSize: 10, keyword: '', category: 0, difficulty: 0 } })
  return m
})()
let adminTab = 'dining/sig' // 分部门 slug | 大部门 key | 'all'
// tab → 该 tab 下「精确 dept」集合（保存题目/统计用；'all' 含无 dept 字段的历史题）
function adminDeptSetOf(tab) {
  const k = ADMIN_DEPT_TABS.indexOf(tab) >= 0 ? tab : 'all'
  if (k === 'all') return ['all', '']
  if (k.indexOf('/') >= 0) return [k]
  // 大部门 tab（房务部）：大部门自身 + 其所有分部门 slug
  const hasSub = typeof DEPT_SUB_SLUGS !== 'undefined' && DEPT_SUB_SLUGS[k]
  const extra = hasSub ? Object.keys(DEPT_SUB_SLUGS[k]).map(s => k + '/' + DEPT_SUB_SLUGS[k][s]) : []
  return [k].concat(extra)
}
const ADMIN_DEPT_TAB_LABELS = {
  'dining/sig': 'sig', 'dining/yan': 'yan', 'dining/bar': 'bar', 'dining/ird': 'ird',
  'rizhao/canyin': 'canyin', 'rizhao/fangwu': 'fangwu',
}
function adminTabLabel(tab) {
  const sub = ADMIN_DEPT_TAB_LABELS[tab]
  if (sub) return (t('chDeptNames') || {})[DEPT_SUB_BY_SLUG[tab] || ''] || tab
  if (tab === 'rooms') return t('bankRooms')
  return t('bankGeneral')
}
// v89：题目归属部门下拉（四分队 + 房务部 + 通用）；兼容历史 dept='dining'/''
function adminDeptOptionsHtml(curDept) {
  const tree = deptTree()
  const cur = String(curDept == null ? '' : curDept)
  const norm = cur === '' ? 'all' : cur
  const out = []
  ADMIN_DEPT_TABS.forEach(k => {
    out.push(`<option value="${k}" ${norm === k ? 'selected' : ''}>${escHtml(adminTabLabel(k))}</option>`)
  })
  // 历史值：大部门 key（dining）/ 旧分部门 slug 不在 tab 列表里 → 显示为遗留项避免误改
  if (ADMIN_DEPT_TABS.indexOf(norm) < 0) {
    const name = norm === 'dining' ? tree.dining.name : (deptSlugName(norm) || norm)
    out.push(`<option value="${escAttr(norm)}" selected>${escHtml(name)}（${t('legacyTag')}）</option>`)
  }
  return out.join('')
}

function renderAdmin() {
  Object.keys(adminStates).forEach(k => { adminStates[k] = { page: 1, pageSize: 10, keyword: '', category: 0, difficulty: 0 } })
  adminTab = 'dining/sig'
  renderAdminShell()
  renderAdminList()
}

function renderAdminShell() {
  const allQs = Store.getQuestions()
  const count = tab => {
    const set = adminDeptSetOf(tab)
    return allQs.filter(q => set.indexOf(q.dept || 'all') >= 0).length
  }
  const tabHtml = ADMIN_DEPT_TABS.map(k =>
    `<button class="admin-tab ${adminTab === k ? 'active' : ''}" onclick="switchAdminTab('${k}')">${adminTabLabel(k)} <span class="tab-count">${count(k)}</span></button>`
  ).join('')
  const el = document.getElementById('page-admin')
  el.innerHTML = `
    <div class="admin-tabs">
      ${tabHtml}
    </div>
    <div id="adminTabBody"></div>
  `
}

function switchAdminTab(tab) {
  adminTab = tab
  renderAdminShell()
  renderAdminList()
}

function renderAdminList() {
  // v107：进题库列表时自动清理上传库的选项空槽并推云端（管理员无需手动操作，历史数据自愈）
  compactAndPushUploaded()
  const st = adminStates[adminTab] || adminStates.all
  const categories = Store.getCategories()
  // v89：按 tab 的 dept 集合精确筛选（支持分部门 slug）
  const deptSet = adminDeptSetOf(adminTab)
  const { list } = Store.queryQuestions({
    category_id: st.category || undefined,
    difficulty: st.difficulty || undefined,
    keyword: st.keyword || undefined,
    page: 1,
    pageSize: 100000
  })
  const filtered = list.filter(q => deptSet.indexOf(q.dept || 'all') >= 0)
  const total = filtered.length
  const totalPages = Math.ceil(total / st.pageSize)
  const start = (st.page - 1) * st.pageSize
  const pagedList = filtered.slice(start, start + st.pageSize)

  const deptLabels = { dining: t('deptDining'), rooms: t('deptRooms'), all: t('deptGeneral') }

  const el = document.getElementById('adminTabBody') || document.getElementById('page-admin')
  el.innerHTML = `
    <div class="admin-toolbar">
      <input type="text" placeholder="${t('searchQuestions')}" value="${st.keyword}" oninput="adminSearch(this.value)" style="flex:1;min-width:200px" />
      <select onchange="adminFilterCat(this.value)">
        <option value="0">${t('allCategories')}</option>
        ${categories.map(c => `<option value="${c.id}" ${st.category == c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
      <select onchange="adminFilterDiff(this.value)">
        <option value="0">${t('allDifficulties')}</option>
        <option value="1" ${st.difficulty == 1 ? 'selected' : ''}>${t('diffLabels')[1]}</option>
        <option value="2" ${st.difficulty == 2 ? 'selected' : ''}>${t('diffLabels')[2]}</option>
        <option value="3" ${st.difficulty == 3 ? 'selected' : ''}>${t('diffLabels')[3]}</option>
      </select>
      <button class="btn btn-primary" onclick="openEditModal()">${t('newQuestion')}</button>
      <button class="btn btn-ghost" onclick="openImportModal()">${t('batchImport')}</button>
      <button class="btn btn-ghost" onclick="openCategoryModal()">${t('categoryManage')}</button>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;-webkit-overflow-scrolling:touch">
      ${pagedList.length === 0 ? `<div style="padding:40px;text-align:center;color:#9ca3af;">${t('noQuestions')}</div>` : `
      <table class="admin-table">
        <thead>
          <tr>
            <th>${t('thQuestion')}</th>
            <th>${t('thCategory')}</th>
            <th>${t('deptFilter')}</th>
            <th>${t('thType')}</th>
            <th>${t('thDifficulty')}</th>
            <th>${t('thAction')}</th>
          </tr>
        </thead>
        <tbody>
          ${pagedList.map(q => `<tr>
            <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${q.question}</td>
            <td>${Store.getCategoryName(q.category_id)}</td>
            <td><span class="tag ${q.dept === 'all' || !q.dept ? 'tag-diff-2' : q.dept.indexOf('rooms') === 0 ? 'tag-diff-3' : 'tag-diff-1'}">${deptLabels[q.dept] || deptSlugName(q.dept) || t('deptGeneral')}</span></td>
            <td><span class="tag tag-type">${TYPE_LABELS[q.type]}</span></td>
            <td><span class="tag tag-diff-${q.difficulty}">${DIFFICULTY_LABELS[q.difficulty]}</span></td>
            <td>
              ${q._seed ? `<span class="tag tag-type">${t('seedReadOnly')}</span>` : `
              <div class="admin-actions">
                <button class="btn btn-ghost btn-sm" onclick="openEditModal('${q.id}')">${t('editBtn')}</button>
                <button class="btn btn-danger btn-sm" onclick="adminDelete('${q.id}')">${t('deleteBtn')}</button>
              </div>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    ${totalPages > 1 ? `
    <div class="pagination">
      <button class="btn btn-ghost btn-sm" ${st.page <= 1 ? 'disabled' : ''} onclick="adminGotoPage(${st.page - 1})">${t('prevPage')}</button>
      <span style="font-size:14px;color:#6b7280">${t('pageOf', st.page, totalPages, total)}</span>
      <button class="btn btn-ghost btn-sm" ${st.page >= totalPages ? 'disabled' : ''} onclick="adminGotoPage(${st.page + 1})">${t('nextPage')}</button>
    </div>` : ''}
  `
}

// 简单 HTML 转义
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;') }

// ====== 平台品牌 Logo（登录页 + 顶栏）======
// Logo 由管理员上传：本机存 eq_logo 缓存，云端存文档顶层 logo 字段，全平台设备自动同步
function logoImgHtml(url) {
  return url ? `<img class="brand-img" src="${escAttr(url)}" alt="logo">` : '📚'
}
// 渲染两处 Logo 位（登录页 auth-logo / 顶栏 brand .logo）
function renderLogo() {
  const url = Store.getLogo()
  const authLogo = document.querySelector('.auth-logo')
  const topLogo = document.querySelector('.topbar-brand .logo')
  if (authLogo) authLogo.innerHTML = logoImgHtml(url)
  if (topLogo) topLogo.innerHTML = logoImgHtml(url)
}
// 把图片压缩成小尺寸 dataURL（透明底 PNG 优先；过大自动降级 JPEG / 缩小尺寸）
// 上限 ~90KB，控制云端 1MB 存储占用
function compressLogoImage(file) {
  return new Promise(resolve => {
    if (!file || !/^image\//.test(file.type || '')) return resolve(null)
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        try {
          const sizes = [220, 170, 130, 96]
          for (const MAX of sizes) {
            const scale = Math.min(1, MAX / Math.max(img.width, img.height))
            const w = Math.max(1, Math.round(img.width * scale))
            const h = Math.max(1, Math.round(img.height * scale))
            const canvas = document.createElement('canvas')
            canvas.width = w; canvas.height = h
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0, w, h)
            let url = canvas.toDataURL('image/png')
            if (url.length > 90000) url = canvas.toDataURL('image/jpeg', 0.85)  // PNG 过大 → JPEG（白底）
            if (url.length <= 90000) return resolve(url)
          }
          resolve(null) // 所有尺寸都超限
        } catch (e) { resolve(null) }
      }
      img.onerror = () => resolve(null)
      img.src = reader.result
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

// ---- Logo 上传弹窗（管理员）----
let _logoPick = null   // null = 未重新选择（沿用当前）；'' = 移除；dataURL = 新图
function logoModalCurrent() {
  return _logoPick !== null ? _logoPick : Store.getLogo()
}
function openLogoModal() {
  const old = document.getElementById('logoModal')
  if (old) old.remove()
  _logoPick = null
  const modal = document.createElement('div')
  modal.id = 'logoModal'
  modal.className = 'modal-overlay'
  modal.style.display = 'flex'
  modal.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-header">
        <h3>${t('logoModalTitle')}</h3>
        <span class="modal-close" onclick="closeLogoModal()">✕</span>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${t('logoPreviewLabel')}</label>
          <div class="logo-preview" id="logoPreview"></div>
        </div>
        <div class="form-group">
          <label>${t('logoChooseFile')}</label>
          <input type="file" id="logoFileInput" accept="image/*" onchange="logoFilePicked(this)" />
          <p class="form-hint" style="margin-top:6px">${t('logoPickHint')}</p>
        </div>
        <p class="form-hint" style="color:#9ca3af;font-size:12px">${t('logoWhereShow')}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveLogoToPlatform()">${t('logoSaveBtn')}</button>
        <button class="btn btn-ghost" id="logoRemoveBtn" onclick="removePlatformLogo()" style="color:#dc2626;border-color:#fecaca">${t('logoRemoveBtn')}</button>
        <button class="btn btn-ghost" onclick="closeLogoModal()">${t('cancelBtn')}</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  renderLogoPreview()
}
function closeLogoModal() {
  const m = document.getElementById('logoModal')
  if (m) m.remove()
  _logoPick = null
}
function renderLogoPreview() {
  const box = document.getElementById('logoPreview')
  const rmBtn = document.getElementById('logoRemoveBtn')
  const url = logoModalCurrent()
  if (box) box.innerHTML = url ? `<img class="brand-img" src="${escAttr(url)}" alt="logo">` : `<span class="logo-preview-empty">📚</span>`
  if (rmBtn) rmBtn.style.display = url ? '' : 'none'
}
async function logoFilePicked(input) {
  const f = input.files && input.files[0]
  if (!f) return
  if (!/^image\//.test(f.type)) return alert(t('logoTypeErr'))
  if (f.size > 3 * 1024 * 1024) return alert(t('logoTooBig'))
  const url = await compressLogoImage(f)
  if (!url) return alert(t('logoProcessFail'))
  _logoPick = url
  renderLogoPreview()
}
// 保存：本地缓存 + 云端同步（所有设备自动拉取）
async function saveLogoToPlatform() {
  const data = logoModalCurrent()   // 沿用当前 / 新图 / ''（移除）
  const removing = data === ''
  let cloudOk = true
  if (typeof CloudSync !== 'undefined' && typeof CloudSync.setCloudLogo === 'function') {
    try {
      const res = await CloudSync.setCloudLogo(data)
      if (!res || !res.ok) cloudOk = false
    } catch (e) { cloudOk = false }
  }
  Store.setLogo(data)   // 本机立即生效
  renderLogo()
  closeLogoModal()
  alert(removing
    ? (cloudOk ? t('logoRemoveDone') : t('logoRemoveFailCloud'))
    : (cloudOk ? t('logoSaveOk') : t('logoSaveFail')))
}
async function removePlatformLogo() {
  if (!confirm(t('logoRemoveConfirm'))) return
  _logoPick = ''
  await saveLogoToPlatform()
}

// ====== 管理员调整学员部门（弹窗 + 级联选择）======
let _deptEdit = null   // { id, username }
function changeUserDeptUI(id, username, dept) {
  const old = document.getElementById('deptEditModal')
  if (old) old.remove()
  _deptEdit = { id: Number(id) || 0, username: String(username || '') }
  const modal = document.createElement('div')
  modal.id = 'deptEditModal'
  modal.className = 'modal-overlay'
  modal.style.display = 'flex'
  modal.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-header">
        <h3>${t('deptModalTitle')}</h3>
        <span class="modal-close" onclick="closeDeptModal()">✕</span>
      </div>
      <div class="modal-body">
        <p class="form-hint" style="margin-bottom:14px">${t('deptModalHint', escHtml(_deptEdit.username))}</p>
        <div class="form-group">
          <label>${t('deptMajorOpt')}</label>
          <select id="deptEditMajor"></select>
        </div>
        <div class="form-group">
          <label>${t('deptSubOpt')}</label>
          <select id="deptEditSub" style="display:none"></select>
          <input type="text" id="deptEditOther" placeholder="${t('deptOtherPh')}" style="display:none" />
        </div>
        <p class="form-hint" style="color:#9ca3af;font-size:12px">${t('deptModalEffect')}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveDeptEdit()">${t('saveBtn')}</button>
        <button class="btn btn-ghost" onclick="closeDeptModal()">${t('cancelBtn')}</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  setDeptCascade(DEPT_GROUPS.deptModal, dept)
}
function closeDeptModal() {
  const m = document.getElementById('deptEditModal')
  if (m) m.remove()
  _deptEdit = null
}
async function saveDeptEdit() {
  if (!_deptEdit) return
  const dept = readDeptCascade(DEPT_GROUPS.deptModal)
  if (!dept) return alert(t('deptNoChange'))
  const { id, username } = _deptEdit
  let r
  try {
    r = id ? await Store.setUserDept(id, dept) : await Store.setUserDeptByUsername(username, dept)
  } catch (e) { return alert(t('deptSaveFail')) }
  if (!r.ok) return alert(r.msg || t('deptNoChange'))
  alert(t('deptSaveOk', username, r.dept))
  closeDeptModal()
  renderUsers()
}

// Admin filters（每个部门题库 tab 独立记忆）
let searchTimer = null
function adminSearch(val) {
  adminStates[adminTab].keyword = val
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    adminStates[adminTab].page = 1
    renderAdminList()
  }, 300)
}
function adminFilterCat(val) {
  adminStates[adminTab].category = Number(val)
  adminStates[adminTab].page = 1
  renderAdminList()
}
function adminFilterDiff(val) {
  adminStates[adminTab].difficulty = Number(val)
  adminStates[adminTab].page = 1
  renderAdminList()
}
function adminGotoPage(p) {
  adminStates[adminTab].page = p
  renderAdminList()
}

// Admin: Edit modal
function openEditModal(id) {
  const categories = Store.getCategories()
  const q = id ? Store.getQuestion(id) : null
  // 新增题默认部门跟随当前题库 tab（培训 tab 下默认通用）
  const defDept = adminDeptOf(adminTab)
  const data = q || { category_id: categories[0]?.id || '', type: 'single', question: '', options: ['','','',''], answer: [], explanation: '', difficulty: 1, dept: defDept }

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.style.display = 'flex'
  overlay.id = 'editModal'

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${q ? t('editTitle') + t('thQuestion') : t('newQuestion')}</h3>
        <span class="modal-close" onclick="document.getElementById('editModal').remove()">✕</span>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-col form-group">
            <label>${t('categoryLabel')}</label>
            <select id="editCat">
              ${categories.map(c => `<option value="${c.id}" ${data.category_id == c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-col form-group">
            <label>${t('deptLabel')}</label>
            <select id="editDept">
              ${adminDeptOptionsHtml(data.dept)}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-col form-group">
            <label>${t('typeLabel')}</label>
            <select id="editType" onchange="onTypeChange()">
              <option value="single" ${data.type==='single'?'selected':''}>${t('typeLabels').single}</option>
              <option value="multiple" ${data.type==='multiple'?'selected':''}>${t('typeLabels').multiple}</option>
              <option value="judge" ${data.type==='judge'?'selected':''}>${t('typeLabels').judge}</option>
              <option value="fill" ${data.type==='fill'?'selected':''}>${t('typeLabels').fill}</option>
              <option value="translate" ${data.type==='translate'?'selected':''}>${t('typeLabels').translate}</option>
              <option value="pronounce" ${data.type==='pronounce'?'selected':''}>${t('typeLabels').pronounce}</option>
              <option value="listen" ${data.type==='listen'?'selected':''}>${t('typeLabels').listen}</option>
              <option value="voicematch" ${data.type==='voicematch'?'selected':''}>${t('typeLabels').voicematch}</option>
            </select>
          </div>
          <div class="form-col form-group">
            <label>${t('diffLabel')}</label>
            <select id="editDiff">
              <option value="1" ${data.difficulty==1?'selected':''}>${t('diffLabels')[1]}</option>
              <option value="2" ${data.difficulty==2?'selected':''}>${t('diffLabels')[2]}</option>
              <option value="3" ${data.difficulty==3?'selected':''}>${t('diffLabels')[3]}</option>
              <option value="4" ${data.difficulty==4?'selected':''}>${t('diffLabels')[4]}</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>${t('questionTextLabel')}</label>
          <textarea id="editQuestion" placeholder="${data.type === 'listen' ? t('listenQuestionPh') : data.type === 'voicematch' ? t('vmQuestionPh') : t('questionTextPh')}">${data.question}</textarea>
        </div>
        <div class="form-group" id="optionsContainer">
          <label>${t('optionsTextLabel')}</label>
          <div id="optionsList">${renderOptionsHtml(data)}</div>
        </div>
        <div class="form-group" id="answerContainer">
          <label>${t('correctAnswerLabel')}</label>
          <div id="answerArea">${renderAnswerArea(data)}</div>
        </div>
        <div class="form-group">
          <label>${t('explanationOptional')}</label>
          <textarea id="editExplanation" placeholder="${t('explanationOptionalPh')}">${data.explanation || ''}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveEdit(${id == null ? 'null' : "'" + String(id).replace(/'/g, "\\'") + "'"})">${t('saveBtn')}</button>
        <button class="btn btn-ghost" onclick="document.getElementById('editModal').remove()">${t('cancelBtn')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
}

function renderOptionsHtml(data) {
  const type = data.type
  if (type === 'fill' || type === 'translate') {
    return `<input type="text" class="input-answer" id="opt0" value="${data.options[0] || ''}" placeholder="${t('answerPlaceholder')}" />`
  }
  if (type === 'judge') {
    return `
      <input type="text" class="input-answer" id="opt0" value="${data.options[0] || t('trueOption')}" />
      <input type="text" class="input-answer" id="opt1" style="margin-top:8px" value="${data.options[1] || t('falseOption')}" />
    `
  }
  // single, multiple, pronounce, listen, voicematch
  let html = ''
  const ph = (i) => type === 'voicematch' ? t('vmOptionPh') : t('optionPh', LETTERS[i])
  const count = Math.max(data.options.length, 4)
  for (let i = 0; i < count; i++) {
    html += `<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
      <span style="font-weight:700;color:#DD3D00">${LETTERS[i]}</span>
      <input type="text" class="input-answer" id="opt${i}" value="${data.options[i] || ''}" placeholder="${ph(i)}" style="flex:1" />
    </div>`
  }
  html += `<button class="btn btn-ghost btn-sm" onclick="addOption()">${t('addOption')}</button>`
  return html
}

function renderAnswerArea(data) {
  const type = data.type
  if (type === 'fill' || type === 'translate') {
    return `<p class="form-hint">${t('answerFilledAbove')}</p>`
  }
  if (type === 'judge') {
    return `
      <select id="answerSelect">
        <option value="0" ${data.answer.includes(0)?'selected':''}>${t('trueOption')}</option>
        <option value="1" ${data.answer.includes(1)?'selected':''}>${t('falseOption')}</option>
      </select>
    `
  }
  if (type === 'multiple') {
    // render checkboxes for each option
    let html = ''
    const count = Math.max(data.options.length, 4)
    for (let i = 0; i < count; i++) {
      html += `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:16px;cursor:pointer">
        <input type="checkbox" class="answer-cb" data-idx="${i}" ${data.answer.includes(i)?'checked':''} />
        ${LETTERS[i]}
      </label>`
    }
    return html
  }
  // single, pronounce, listen, voicematch
  let html = ''
  const count = Math.max(data.options.length, 4)
  for (let i = 0; i < count; i++) {
    html += `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:16px;cursor:pointer">
      <input type="radio" name="answerRadio" class="answer-radio" data-idx="${i}" ${data.answer.includes(i)?'checked':''} />
      ${LETTERS[i]}
    </label>`
  }
  if (type === 'voicematch') html += `<p class="form-hint" style="margin-top:8px">${t('vmEditorHint')}</p>`
  return html
}

function onTypeChange() {
  const type = document.getElementById('editType').value
  const data = { type, options: collectOptions(), answer: [] }
  document.getElementById('optionsList').innerHTML = renderOptionsHtml(data)
  document.getElementById('answerArea').innerHTML = renderAnswerArea(data)
  // listen 题题干是"将被朗读的英文"，voicematch 题干是"显示给学生的英文文字"，提示语不同
  const qEl = document.getElementById('editQuestion')
  if (qEl) qEl.placeholder = (type === 'listen') ? t('listenQuestionPh') : (type === 'voicematch') ? t('vmQuestionPh') : t('questionTextPh')
}

function addOption() {
  const list = document.getElementById('optionsList')
  const i = list.querySelectorAll('input').length
  if (i >= 10) return
  const type = document.getElementById('editType')?.value
  const div = document.createElement('div')
  div.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center'
  div.innerHTML = `
    <span style="font-weight:700;color:#DD3D00">${LETTERS[i]}</span>
    <input type="text" class="input-answer" id="opt${i}" placeholder="${type === 'voicematch' ? t('vmOptionPh') : t('optionPh', LETTERS[i])}" style="flex:1" />
    <button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove();refreshAnswerArea()">${t('deleteBtn')}</button>
  `
  // Insert before the add button
  const addBtn = list.querySelector('button')
  list.insertBefore(div, addBtn)
  refreshAnswerArea()
}

function refreshAnswerArea() {
  const type = document.getElementById('editType').value
  const data = { type, options: collectOptions(), answer: [] }
  document.getElementById('answerArea').innerHTML = renderAnswerArea(data)
}

function collectOptions() {
  const type = document.getElementById('editType').value
  if (type === 'fill' || type === 'translate') {
    const v = document.getElementById('opt0')?.value || ''
    return [v]
  }
  if (type === 'judge') {
    return [
      document.getElementById('opt0')?.value || t('trueOption'),
      document.getElementById('opt1')?.value || t('falseOption')
    ]
  }
  const opts = []
  let i = 0
  while (document.getElementById('opt' + i)) {
    const v = document.getElementById('opt' + i).value
    if (v.trim()) opts.push(v)
    i++
  }
  return opts
}

function collectAnswer() {
  const type = document.getElementById('editType').value
  if (type === 'fill' || type === 'translate') return [0]
  if (type === 'judge') return [Number(document.getElementById('answerSelect').value)]
  if (type === 'multiple') {
    const result = []
    document.querySelectorAll('.answer-cb').forEach(cb => {
      if (cb.checked) result.push(Number(cb.dataset.idx))
    })
    return result
  }
  // single, pronounce
  let result = []
  document.querySelectorAll('.answer-radio').forEach(r => {
    if (r.checked) result.push(Number(r.dataset.idx))
  })
  return result
}

function saveEdit(id) {
  const category_id = Number(document.getElementById('editCat').value)
  const dept = document.getElementById('editDept').value
  const type = document.getElementById('editType').value
  const difficulty = Number(document.getElementById('editDiff').value)
  const question = document.getElementById('editQuestion').value.trim()
  const explanation = document.getElementById('editExplanation').value.trim()
  const options = collectOptions()
  const answer = collectAnswer()

  if (!question) { alert(t('errQuestionRequired')); return }
  if (options.length === 0 || (type !== 'fill' && type !== 'translate' && options.length < 2)) { alert(t('errOptionsMin')); return }
  if (answer.length === 0) { alert(t('errSelectAnswer')); return }

  const data = { category_id, dept, type, difficulty, question, options, answer, explanation }
  if (id) {
    Store.updateQuestion(id, data)
  } else {
    Store.addQuestion(data)
  }
  // v95：新增必入上传库（'u' 前缀）；编辑上传题同样 → 推送云端
  if (!id || String(id).charAt(0) === 'u') pushUploadedBankSoon()
  document.getElementById('editModal').remove()
  renderAdminList()
}

function adminDelete(id) {
  if (!confirm(t('confirmDeleteQuestion'))) return
  Store.deleteQuestion(id)
  pushUploadedBankSoon()   // v95：删的是上传题时同步云端；删派生题时推送无害（全量替换）
  renderAdminList()
}

// ====== v52：批量上传题目（模板下载 + 文件/粘贴解析 + 预览 + 自动难度）======
// 模板列（位置固定，CSV/Excel 通用；第 10 列难度留空=导入时自动判定）
const IMPORT_COLS = ['题型', '题干', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '正确答案', '解析', '难度(L1-L4 选填)']
// 示例行（题型单元格以「示例」开头 → 解析时整行跳过）
const IMPORT_EXAMPLE = ['示例（请删除或覆盖本行后填写）', 'What does "escort" mean?', '引导、陪同', '催促', '打电话', '预订', '', '', 'A', 'escort = 引导/护送。', 'L2']
const IMPORT_COLS_EN = ['Type', 'Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Option E', 'Option F', 'Correct Answer', 'Explanation', 'Difficulty (L1-L4, optional)']
const IMPORT_EXAMPLE_EN = ['Example (delete or overwrite this row)', 'What does "escort" mean?', 'to guide', 'to hurry', 'to call', 'to book', '', '', 'A', 'escort = guide / accompany.', 'L2']

// 题型归一化（中英文别名 → 存储 type）
function impNormType(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[（(].*?[)）]/g, '').trim()
  if (!s) return ''
  if (['single', '单选', '单选题', '单项选择'].includes(s)) return 'single'
  if (['multiple', '多选', '多选题', '多项选择'].includes(s)) return 'multiple'
  if (['judge', '判断', '判断题', '对错'].includes(s)) return 'judge'
  if (['fill', '填空', '填空题'].includes(s)) return 'fill'
  if (['translate', '翻译', '翻译题'].includes(s)) return 'translate'
  if (['pronounce', '朗读', '发音', '朗读题'].includes(s)) return 'pronounce'
  if (['listen', '听音', '听音选义', '听力'].includes(s)) return 'listen'
  if (['voicematch', '看字选音'].includes(s)) return 'voicematch'
  if (s.indexOf('单选') >= 0) return 'single'
  if (s.indexOf('多选') >= 0) return 'multiple'
  if (s.indexOf('判断') >= 0 || s.indexOf('对错') >= 0) return 'judge'
  if (s.indexOf('填空') >= 0) return 'fill'
  if (s.indexOf('翻译') >= 0) return 'translate'
  if (s.indexOf('朗读') >= 0 || s.indexOf('发音') >= 0) return 'pronounce'
  if (s.indexOf('听音') >= 0) return 'listen'
  if (s.indexOf('选音') >= 0 || s === 'vm') return 'voicematch'
  return ''
}
// 难度归一化：L1-L4 / 1-4 / 中文标签 → 1-4；空/无法识别返回 0（调用方走自动判定）
function impNormDiff(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return 0
  const m = s.match(/^l([1-4])$/)
  if (m) return Number(m[1])
  if (/^[1-4]$/.test(s)) return Number(s)
  if (['简单', '易', '入门'].includes(s)) return 1
  if (['中等', '基础', '中'].includes(s)) return 2
  if (['困难', '难', '进阶', '高'].includes(s)) return 3
  if (['l4高难', '超难', '精通', '专家', '难高'].includes(s)) return 4
  return 0
}
// 题干+选项文本中提取英文词（去 HTML/引号干扰）
function impEnglishWords() {
  const src = Array.prototype.slice.call(arguments).filter(x => x).join(' ')
  const clean = String(src).replace(/<[^>]*>/g, ' ').replace(/[“”"«»]/g, ' ')
  const words = clean.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []
  return words.map(w => w.toLowerCase())
}
// v52：内置智能规则预估 L1-L4（网页兜底；对话 AI 精判的回传文件直接填难度列则不走这里）
// 特征：题干英文词数/长词占比 + 选项英文词数 + 题型难度偏置；输出 1-4
function impEstimateLevel(entry) {
  const q = entry || {}
  const type = impNormType(q.type) || 'single'
  const opts = Array.isArray(q.options) ? q.options : []
  const stem = String(q.question || '')
  const ws = impEnglishWords(stem, opts.join(' '))
  const W = ws.length
  const long = ws.filter(w => w.length >= 7).length
  const avg = W ? ws.reduce((s, w) => s + w.length, 0) / W : 0
  const stemW = impEnglishWords(stem).length
  const typeBias = { judge: 0, pronounce: 0, listen: 0.5, voicematch: 0.5, single: 1, multiple: 1.5, fill: 1.5, translate: 2 }[type] || 1
  let score = typeBias * 2
  if (stemW === 0) score += 0            // 纯中文释义/理解题 → 偏易
  else if (stemW <= 3) score += 0.5
  else if (stemW <= 8) score += 1.5
  else if (stemW <= 16) score += 2.5
  else score += 3.5
  if (long >= 2) score += 0.8
  if (avg >= 6.5 && long >= 1) score += 0.7
  score += Math.min(1.2, W * 0.06)
  if (score <= 2.2) return 1
  if (score <= 4.2) return 2
  if (score <= 6.2) return 3
  return 4
}
// 判断答案文本是否为「选项字母」形态
const IMP_LETTER_RE = /^[a-fA-F]+$/
// v107：裁掉选项数组尾部的空槽（模板 6 格只填 3 格留下的空位）。
// 尾部空槽一定在答案之后，裁掉不会改动任何答案下标；中间空槽保留原下标。
function impTrimEmptyTail(options) {
  const arr = Array.isArray(options) ? options.slice() : []
  let end = arr.length
  while (end > 0 && String(arr[end - 1] == null ? '' : arr[end - 1]).trim() === '') end--
  return arr.slice(0, end)
}
// 单行解析为标准化题目（不进库，仅校验+预估）。返回 { ok, err, q, est, rowNo }
function impEntryFromCells(cells, rowNo) {
  const get = i => (cells[i] == null ? '' : String(cells[i])).trim()
  const type = impNormType(get(0))
  const question = get(1)
  const optionLetters = ['', 'A', 'B', 'C', 'D', 'E', 'F']
  const rawOpts = [get(2), get(3), get(4), get(5), get(6), get(7)]
  const answerText = get(8)
  const explanation = get(9)
  const diffRaw = get(10)
  const errs = []
  if (!type) errs.push(t('impErrType'))
  if (!question) errs.push(t('impErrQuestion'))
  const isText = type === 'fill' || type === 'translate'
  const isJudge = type === 'judge'
  if (!isText && !isJudge) {
    if (rawOpts.filter(o => o).length < 2) errs.push(t('impErrOptions'))
  }
  let options = []
  let answer = []
  let est = 0
  if (type && !errs.length) {
    // 选项数组：字母位与模板一致，空位保留 ''（保证 answer 下标与 A-F 对应）
    options = isText ? [''] : rawOpts
    if (isText) {
      // 填空/翻译：题干已在上面，答案文本作为唯一 options[0]
      options = [answerText || question]
      answer = [0]
      if (!answerText) errs.push(t('impErrAnswer'))
    } else if (isJudge) {
      // 判断：默认「正确/错误」；模板若填了 A/B 文本则用填的
      options = [rawOpts[0] || t('trueOption'), rawOpts[1] || t('falseOption')]
      const s = answerText.toLowerCase()
      if (s === 'a' || s === '对' || s === '正确' || s === 'true' || s === 't') answer = [0]
      else if (s === 'b' || s === '错' || s === '错误' || s === 'false' || s === 'f') answer = [1]
      else errs.push(t('impErrJudgeAnswer'))
    } else if (type === 'voicematch') {
      // 看字选音：答案=与题干一致的选项字母；不填则自动匹配题干文本
      let sel = -1
      const s = answerText ? answerText.toLowerCase() : ''
      if (IMP_LETTER_RE.test(s) && s.length === 1) {
        sel = s.charCodeAt(0) - 97
      } else {
        const stem = question.toLowerCase()
        sel = options.findIndex(o => o && o.trim().toLowerCase() === stem)
        if (sel < 0) errs.push(t('impErrVmAuto'))
      }
      if (sel >= 0 && sel < options.length && options[sel]) answer = [sel]
      else errs.push(t('impErrVmAnswer'))
    } else {
      // single / multiple / pronounce / listen：字母答案（多选可组合）
      const s = answerText.toLowerCase()
      if (!IMP_LETTER_RE.test(s) || !s) errs.push(t('impErrAnswerLetters'))
      else {
        const idxs = []
        for (const ch of s) {
          const i = ch.charCodeAt(0) - 97
          if (i < 0 || i >= 6) { errs.push(t('impErrAnswerLetters')); break }
          if (options[i] == null || !options[i]) { errs.push(t('impErrAnswerOptMissing', String.fromCharCode(65 + i).toUpperCase())); break }
          if (!idxs.includes(i)) idxs.push(i)
        }
        if (type === 'multiple') {
          if (idxs.length < 2) errs.push(t('impErrMultiMin'))
        } else if (idxs.length !== 1) errs.push(t('impErrSingleOne'))
        answer = idxs
      }
    }
  }
  const diff = impNormDiff(diffRaw)
  const difficulty = diff || 0
  est = diff || impEstimateLevel({ type, question, options })
  const q = { type: type || 'single', question, options: isText ? (options[0] ? options : [answerText]) : options, answer, explanation, difficulty }
  // v107：选项尾部空槽 = 模板里没填的选项格（每题 6 格只填 3 格）→ 直接裁掉，
  // 否则学员端会渲染出「有边框、能点、但没字」的空白选项（「有几道题选项有空选项」）。
  // 裁尾槽不影响 answer 下标（被裁的都是答案之外的尾部槽位，上面已校验过答案对应选项非空）。
  if (!isText && q.options.length > 1) {
    let end = q.options.length
    while (end > 0 && String(q.options[end - 1] == null ? '' : q.options[end - 1]).trim() === '') end--
    if (end < q.options.length) q.options = q.options.slice(0, end)
  }
  if (errs.length) return { ok: false, err: errs.join('；'), q: null, est: 0, rowNo, type, question }
  return { ok: true, err: '', q, est, rowNo }
}
// 通用分隔文本解析：支持带引号换行单元格（CSV 规则）
function impParseDelimited(text, delim) {
  const rows = []
  let row = [], cell = '', inQ = false
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else inQ = false }
      else cell += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === delim) {
      row.push(cell); cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(c => c.trim() !== '')) rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some(c => c.trim() !== '')) rows.push(row)
  return rows
}
// 去掉表头行：首格为表头文案时丢弃
function impIsHeader(row) {
  const c0 = String(row[0] || '').trim()
  if (c0 === '题型' || c0 === 'Type' || c0 === 'type') return true
  return false
}
// JSON 数组（AI 回传/旧格式）→ 标准化条目
function impFromJsonList(list) {
  return list.map((item, i) => {
    if (!item || typeof item !== 'object') return { ok: false, err: t('impErrRow'), q: null, est: 0, rowNo: i + 1 }
    const type = impNormType(item.type || '')
    const options = Array.isArray(item.options) ? item.options : []
    const ansRaw = Array.isArray(item.answer) ? item.answer : []
    // v107：JSON 里带来的选项数组同样要裁掉尾部空槽（AI 回传常补足 6 格）
    const q = {
      type: type || 'single',
      question: String(item.question || '').trim(),
      options: (type === 'fill' || type === 'translate') ? options : impTrimEmptyTail(options),
      answer: item.answerText != null ? [] : ansRaw,
      explanation: String(item.explanation || ''),
      difficulty: item.difficultyText != null ? 0 : (Number(item.difficulty) || 0)
    }
    // fill/translate 的答案在 options[0]；若给了 answerText 则转换
    if (item.answerText != null) {
      if (type === 'fill' || type === 'translate') { q.options = [String(item.answerText).trim()]; q.answer = [0] }
      else {
        const en = impEntryFromCells(['', q.question, q.options[0], q.options[1], q.options[2], q.options[3], q.options[4], q.options[5], String(item.answerText), q.explanation, ''], i + 1)
        return en
      }
    }
    const est = q.difficulty || impEstimateLevel(q)
    if (!q.question || !type) return { ok: false, err: t('impErrRow'), q: null, est: 0, rowNo: i + 1 }
    return { ok: true, err: '', q, est, rowNo: i + 1 }
  })
}
// 入口：任意文本（JSON 数组 / CSV / TSV）→ 标准化条目数组（已去示例/表头/空行）
function impParseText(text) {
  const s = String(text || '').trim()
  if (!s) return []
  if (s[0] === '[') {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return impFromJsonList(arr)
    } catch (e) { return [{ ok: false, err: t('impErrJson'), q: null, est: 0, rowNo: 1 }] }
  }
  const delim = s.indexOf('\t') >= 0 && s.indexOf('\t') < s.indexOf(',') ? '\t' : ','
  const rows = impParseDelimited(s, delim)
  const out = []
  rows.forEach((row, i) => {
    if (impIsHeader(row)) return
    const c0 = String(row[0] || '').trim()
    if (!c0 || c0.indexOf('示例') >= 0 || c0 === 'Example') return
    out.push(impEntryFromCells(row, i + 1))
  })
  return out
}
// CSV 文本生成（模板下载 + 供导出）
function impCsvRow(cells) {
  return cells.map(c => {
    const s = c == null ? '' : String(c)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }).join(',')
}
function impTemplateCsv(lang) {
  const head = lang === 'en' ? IMPORT_COLS_EN : IMPORT_COLS
  const ex = lang === 'en' ? IMPORT_EXAMPLE_EN : IMPORT_EXAMPLE
  return '\ufeff' + impCsvRow(head) + '\n' + impCsvRow(ex) + '\n'
}
// 通用 xlsx 组装（复用 course-app 的全局 OOXML 写入器；不存在时返回 null）
function impXlsxFromSheets(sheets) {
  if (typeof xlsxBuildZip !== 'function' || typeof xlsxSheetXml !== 'function') return null
  const list = Array.isArray(sheets) ? sheets.filter(Boolean) : []
  if (!list.length) return null
  // v139：只要任一 sheet 声明了 merges/cols，或单元格写成对象 → 启用富版式（附带 styles.xml）。
  // 否则完全走老路径 —— 产物与升级前逐字节相同（别让线下课导出等旧功能受影响）。
  const rich = (typeof xlsxSheetXmlRich === 'function' && typeof xlsxStyleBook === 'function')
    && list.some(s => s.merges || s.cols
      || (Array.isArray(s.rows) && s.rows.some(r => (r || []).some(c => c && typeof c === 'object'))))
  const bk = rich ? xlsxStyleBook() : null
  const styleOverride = bk ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : ''
  const styleRel = bk ? '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ''
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${styleOverride}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${xlsxXmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}${styleRel}</Relationships>` }
  ]
  // ⚠️ 次序要紧：必须先渲染 sheet（样式注册表在这期间被填充），styles.xml 才能最后生成
  const sheetFiles = list.map((s, i) => ({
    name: 'xl/worksheets/sheet' + (i + 1) + '.xml',
    data: bk ? xlsxSheetXmlRich(s, bk) : xlsxSheetXml(s.rows)
  }))
  const out = files.concat(sheetFiles)
  if (bk) out.push({ name: 'xl/styles.xml', data: bk.xml() })
  return xlsxBuildZip(out)
}
function impDownloadBlob(bytes, fname, mime) {
  const blob = bytes instanceof Uint8Array ? new Blob([bytes], { type: mime }) : new Blob([bytes], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fname
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
// 模板下载入口
function downloadImportTemplate() {
  // .csv（UTF-8 BOM，Excel 可直接打开填写；乱码时另存为 UTF-8 亦可）
  impDownloadBlob(impTemplateCsv('zh'), t('impTemplateFile') + '.csv', 'text/csv;charset=utf-8')
  // 附送 .xlsx（可填写；若平台无内置写入器则跳过）
  const head = IMPORT_COLS
  const guideRows = [[t('impTemplateGuide')], [''], [t('impGuide1')], [t('impGuide2')], [t('impGuide3')], [t('impGuide4')], [t('impGuide5')], [t('impGuide6')], [t('impGuide7')]]
  const sheets = [
    { name: '题目模板', rows: [IMPORT_COLS, IMPORT_EXAMPLE] },
    { name: '填写说明', rows: guideRows }
  ]
  const bytes = impXlsxFromSheets(sheets)
  if (bytes) impDownloadBlob(bytes, t('impTemplateFile') + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  else alert(t('impXlsxUnavailable'))
}

// 预览状态（全局，便于行级交互）
let impRows = []
function renderImportPreview() {
  const box = document.getElementById('importPreview')
  if (!box) return
  const valid = impRows.filter(r => r.ok)
  const bad = impRows.filter(r => !r.ok)
  if (!impRows.length) { box.innerHTML = `<p class="form-hint">${t('impNoRows')}</p>`; return }
  const shown = impRows.slice(0, 300)
  const cap = impRows.length > 300 ? `<p class="form-hint">${t('impCap', impRows.length)}</p>` : ''
  const rowsHtml = shown.map((r, i) => {
    const origin = impRows.indexOf(r)
    const checked = r.ok ? 'checked' : 'disabled'
    const typeName = TYPE_LABELS[r.q ? r.q.type : (r.type || '')] || (r.type || '')
    if (!r.ok) {
      return `<tr style="background:#fef2f2"><td><input type="checkbox" disabled /></td><td>${r.rowNo}</td><td>${escHtml(r.question || '')}</td><td colspan="2" style="color:#dc2626">⚠ ${escHtml(r.err)}</td></tr>`
    }
    const sel = `<select onchange="impSetDiff(${origin}, this.value)">
      ${[1, 2, 3, 4].map(d => `<option value="${d}" ${r.q.difficulty === d ? 'selected' : ''}>${t('levelLabels')[d]}</option>`).join('')}
    </select>${r.est !== r.q.difficulty ? `<span class="form-hint" style="display:block;font-size:11px">🤖 ${t('impEstTag')}</span>` : ''}`
    return `<tr>
      <td><input type="checkbox" class="imp-cb" data-i="${origin}" ${checked} /></td>
      <td>${r.rowNo}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="tag tag-type">${typeName}</span> ${escHtml(r.q.question)}</td>
      <td>${sel}</td>
      <td>${r.q.answer.length ? escHtml(String(r.q.answer.join(','))) : '—'}</td>
    </tr>`
  }).join('')
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <strong>${t('impPreviewTitle')}</strong>
      <span class="form-hint">${t('impStat', valid.length, bad.length)}</span>
    </div>
    ${cap}
    <div style="overflow-x:auto;max-height:340px;border:1px solid var(--border);border-radius:8px">
    <table class="admin-table" style="font-size:12px">
      <thead><tr><th></th><th>#</th><th>${t('thQuestion')}</th><th style="min-width:120px">${t('thDifficulty')}</th><th>${t('thAnswer')}</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`
}
function impRowsSelected() {
  return impRows.filter(r => r.ok && document.querySelector(`.imp-cb[data-i="${impRows.indexOf(r)}"]`)?.checked)
}
function impSetDiff(origin, val) {
  const r = impRows[origin]
  if (!r || !r.ok) return
  r.q.difficulty = Number(val)
  renderImportPreview()
}
function impToggleAll(checked) {
  impRows.forEach((r, i) => {
    if (!r.ok) return
    const cb = document.querySelector(`.imp-cb[data-i="${i}"]`)
    if (cb) cb.checked = checked
  })
}
function impParseAndPreview(text) {
  impRows = impParseText(text)
  renderImportPreview()
}
function confirmImportRows() {
  const picked = impRowsSelected()
  if (!picked.length) { alert(t('impNoneSelected')); return }
  // v89：上传时选定归属部门（分部门 slug / 大部门 / all），学员只看到本部门题
  const el2 = document.getElementById('importDept')
  const dept = (el2 && el2.value) || 'all'
  // v95：栏目可选 —— cat 12 = 七天挑战抽题池（chBankQuestions 只收该栏目）
  const elCat = document.getElementById('importCat')
  const catId = Number(elCat && elCat.value) || 1
  const items = picked.map(r => ({ category_id: catId, dept: dept, type: r.q.type, difficulty: r.q.difficulty || r.est, question: r.q.question, options: r.q.options, answer: r.q.answer, explanation: r.q.explanation }))
  const result = Store.batchImport(items)
  const el = document.getElementById('importResult')
  if (el) el.innerHTML = `<div class="feedback correct"><strong>✅ ${t('impDoneTitle')}</strong><div class="explanation">${t('impDoneDetail', result.success, result.skipped || 0)} · ${t('deptLabel')}：${escHtml(adminTabLabel(dept))} · ${t('impCatLabel')}：${escHtml(Store.getCategoryName(catId))}</div></div>`
  // v95：上传库已变化 → 推送云端（学员端/其他设备下次拉取即见）
  if (result.success > 0) pushUploadedBankSoon()
  setTimeout(() => {
    document.getElementById('importModal') && document.getElementById('importModal').remove()
    adminTab = dept   // 切到刚上传的题库 tab 直接展示
    renderAdminShell(); renderAdminList()
  }, 1600)
}

// v95：上传库（eq_uploaded）变化后推送云端 doc.upq。800ms 合并连续写入（批量导入只推一次）。
// 学员端与其他管理设备经 CloudSync._getDoc 拉取路径自动吸收（Store.absorbCloudUploaded）。
let _upqPushTimer = null
function pushUploadedBankSoon() {
  if (typeof CloudSync === 'undefined' || !CloudSync.setUploadedBank) return
  if (_upqPushTimer) clearTimeout(_upqPushTimer)
  _upqPushTimer = setTimeout(() => {
    _upqPushTimer = null
    try { CloudSync.setUploadedBank(Store._getUploaded()) } catch (e) { /* 静默：下次操作再推 */ }
  }, 800)
}
// v107：新增/编辑题目后，若该题选项尾部还有空槽（历史数据、模板导入、JSON 回传），一律先清干净再推云端。
// 幂等：已干净时不产生写入。返回被修正的题数。
function compactAndPushUploaded() {
  try {
    if (!Store.compactUploadedOptions || !Store._getUploaded) return 0
    const before = Store._getUploaded()
    const res = Store.compactUploadedOptions(before)
    if (res.fixed > 0) {
      Store._setUploaded(res.list)
      pushUploadedBankSoon()
    }
    return res.fixed
  } catch (e) { return 0 }
}
// v125：.xlsx 上传收口 —— xlsx 是 ZIP 二进制，不能当文本读。
// 解包取首个工作表 → 二维数组 → CSV 文本 → 复用 impParseAndPreview 预览勾选链路。
// 管理员题库上传与线下课作业上传共用此入口。
function importFileChange(input) {
  const f = input && input.files && input.files[0]
  if (!f) return
  importReadFile(f)
}
function importReadFile(file, done) {
  const finish = done || (text => impParseAndPreview(text))
  if (/\.xlsx$/i.test(String((file && file.name) || ''))) {
    if (typeof QGen === 'undefined' || !QGen.xlsxToRows) { alert(t('qgenBadXlsx')); return }
    file.arrayBuffer().then(buf => QGen.xlsxToRows(buf))
      .then(rows => finish(courseRowsToCsv(rows)))
      .catch(() => alert(t('qgenBadXlsx')))
    return
  }
  const fr = new FileReader()
  fr.onload = () => {
    let text = String(fr.result || '')
    // UTF-8 解码异常（Excel 中文版另存 CSV 常为 GBK）→ 用 GBK 重解
    if (text.indexOf('\uFFFD') >= 0) {
      try {
        file.arrayBuffer().then(buf => {
          const gbk = new TextDecoder('gbk')
          const alt = gbk.decode(buf)
          finish(alt.indexOf('\uFFFD') < 0 ? alt : text)
        }).catch(() => finish(text))
        return
      } catch (e) { /* noop */ }
    }
    finish(text)
  }
  fr.readAsText(file, 'utf-8')
}

// Admin: Import modal（v52：模板下载 + 文件/粘贴 + 预览确认）
// v95：新增「题目栏目」下拉 —— 批量导入此前硬编码 category_id:1，而七天挑战抽题池只收
// category 12（chBankQuestions），导致上传的题永远进不了挑战。现可选栏目；从挑战页/
// 营次面板入口打开时默认选中「七天挑战题库」(cat 12)。presetCat/presetDept 均可省略。
function openImportModal(presetCat, presetDept) {
  const CH_BANK_CAT = 12
  const cats = (typeof Store !== 'undefined' && Store.getCategories ? Store.getCategories() : [])
    .slice().sort((a, b) => Number(a.id) - Number(b.id))
  const selCat = Number(presetCat) || 1
  const selDept = ADMIN_DEPT_TABS.indexOf(String(presetDept || '')) >= 0 ? String(presetDept) : adminTab
  const catOpts = cats.map(c => {
    const id = Number(c.id)
    // v96：挑战栏目不再拼接种子的老名字（「标帜餐厅常见词汇」让人误以为只有标帜一家有挑战题库）
    const label = id === CH_BANK_CAT ? t('impChallengeTag') : c.name
    return `<option value="${id}" ${id === selCat ? 'selected' : ''}>${escHtml(label)}</option>`
  }).join('')
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.style.display = 'flex'
  overlay.id = 'importModal'
  overlay.innerHTML = `
    <div class="modal" style="max-width:860px;width:92%">
      <div class="modal-header">
        <h3>📤 ${t('importTitle')}</h3>
        <span class="modal-close" onclick="document.getElementById('importModal').remove()">✕</span>
      </div>
      <div class="modal-body">
        <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <strong>${t('impStep1')}</strong>
            <button class="btn btn-primary btn-sm" onclick="downloadImportTemplate()">⬇️ ${t('dlTemplate')}</button>
          </div>
          <p class="form-hint" style="margin:6px 0 0">${t('impFileHint')}</p>
        </div>
        <div class="form-group">
          <label>${t('impCatLabel')}</label>
          <select id="importCat">${catOpts}</select>
          <p class="form-hint" style="margin:4px 0 0">${t('impCatHint')}</p>
        </div>
        <div class="form-group">
          <label>${t('deptLabel')}</label>
          <select id="importDept" onchange="impSyncDeptHint()">
            ${ADMIN_DEPT_TABS.map(k => `<option value="${k}" ${selDept === k ? 'selected' : ''}>${escHtml(adminTabLabel(k))}</option>`).join('')}
          </select>
          <p class="form-hint" id="impDeptHintEl" style="margin:4px 0 0">${t('impDeptHint')}</p>
        </div>
        <div class="form-group">
          <label>${t('impFileLabel')}</label>
          <input type="file" id="importFile" accept=".csv,.txt,.tsv,.json,.xlsx,text/csv,text/plain,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange="importFileChange(this)" style="font-size:13px" />
        </div>
        <div class="form-group">
          <label>${t('impPasteLabel')}</label>
          <textarea id="importData" style="min-height:110px;font-family:monospace;font-size:12px" placeholder="${t('impPastePh')}" oninput="impParseAndPreview(this.value)"></textarea>
        </div>
        <div id="importResult"></div>
        <div id="importPreview"></div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="impToggleAll(true)">${t('impSelAll')}</button>
        <button class="btn btn-primary" onclick="confirmImportRows()">${t('impConfirmBtn')}</button>
        <button class="btn btn-ghost" onclick="document.getElementById('importModal').remove()">${t('cancelBtn')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  renderImportPreview()
  impSyncDeptHint()
}

// v96：部门下拉变化时同步「所属部门」提示 —— 栏目选「七天挑战题库」时明确告知
// 题目将归入哪个部门的挑战题库（四个分部门共用一个栏目，归属由部门决定）。
function impSyncDeptHint() {
  const el = document.getElementById('impDeptHintEl')
  if (!el) return
  const dSel = document.getElementById('importDept')
  const cSel = document.getElementById('importCat')
  const dept = (dSel && dSel.value) || 'all'
  // v198：挑战题库 = 分类 >= 12（分类 12 餐饮词库 + 分类 13 房务词库），提示文案同口径
  const isChallengeBank = !!(cSel && Number(cSel.value) >= 12)
  el.textContent = isChallengeBank
    ? (dept === 'all' ? t('impChDeptHintAll') : t('impChDeptHint', adminTabLabel(dept)))
    : t('impDeptHint')
}

// Admin: Category management
function openCategoryModal() {
  const categories = Store.getCategories()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.style.display = 'flex'
  overlay.id = 'catModal'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${t('categoryManage')}</h3>
        <span class="modal-close" onclick="document.getElementById('catModal').remove()">✕</span>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${t('newCategory')}</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="newCatName" placeholder="${t('categoryNamePh')}" style="flex:1" />
            <input type="text" id="newCatDesc" placeholder="${t('categoryDescPh')}" style="flex:1" />
            <button class="btn btn-primary" onclick="addCategoryFromModal()">${t('addBtn')}</button>
          </div>
        </div>
        <div id="catList">
          ${categories.map(c => `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #e5e7eb">
            <div>
              <strong>${c.name}</strong>
              <span style="color:#9ca3af;font-size:13px;margin-left:8px">${c.description || ''}</span>
            </div>
            <button class="btn btn-danger btn-sm" onclick="deleteCategoryFromModal(${c.id})">${t('deleteBtn')}</button>
          </div>`).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('catModal').remove()">${t('closeBtn')}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
}

function addCategoryFromModal() {
  const name = document.getElementById('newCatName').value.trim()
  if (!name) { alert(t('errCategoryName')); return }
  const desc = document.getElementById('newCatDesc').value.trim()
  Store.addCategory(name, desc)
  openCategoryModal() // refresh
  document.getElementById('catModal').querySelector('#newCatName').focus()
  // Re-render the modal
  const overlay = document.createElement('div')
  overlay.id = 'temp'
  // Actually just re-open
  document.getElementById('catModal').remove()
  openCategoryModal()
}

function deleteCategoryFromModal(id) {
  const result = Store.deleteCategory(id)
  if (!result.ok) { alert(result.msg); return }
  document.getElementById('catModal').remove()
  openCategoryModal()
}

// ====== 统一数据看板（管理员）—— 线上学习 + 线下课程 ======
// 计算单个学员的线下课程统计
function _courseStatsForUser(doc, username) {
  let done = 0, total = 0, scores = [], best = 0
  ;(doc.classes || []).forEach(c => {
    if (!(c.members || []).includes(username)) return
    ;(c.assignments || []).forEach(a => {
      total++
      const r = (a.results || {})[username]
      if (r) {
        done++
        // 视频 / 线下课无分数，不计入均分/最高分
        if (a.type !== 'video' && a.type !== 'offline') {
          scores.push(r.score || 0)
          if ((r.score || 0) > best) best = r.score
        }
      }
    })
  })
  return { done, total, avg: scores.length ? Math.round(scores.reduce((s,x)=>s+x,0)/scores.length) : 0, best }
}
// 计算线下课程全局汇总
function _courseSummary(doc) {
  const studentSet = new Set()
  let totalAssigns = 0, totalDone = 0
  const allScores = []
  ;(doc.classes || []).forEach(c => {
    ;(c.members || []).forEach(m => studentSet.add(m))
    const assigns = c.assignments || []
    totalAssigns += assigns.length
    assigns.forEach(a => {
      const results = a.results || {}
      ;(c.members || []).forEach(m => {
        if (results[m]) {
          totalDone++
          // 视频 / 线下课无分数，不计入均分
          if (a.type !== 'video' && a.type !== 'offline') allScores.push(results[m].score || 0)
        }
      })
    })
  })
  return {
    classes: (doc.classes || []).length, students: studentSet.size, assigns: totalAssigns,
    completion: studentSet.size * totalAssigns > 0 ? Math.round(totalDone / (studentSet.size * totalAssigns) * 100) : 0,
    avgScore: allScores.length ? Math.round(allScores.reduce((s,x)=>s+x,0)/allScores.length) : 0
  }
}
// 看板行数组 → 用户名→{name,dept} 映射（供 _courseMatrices 成员列显示中文名+部门）
function _userInfoMapFromRows(rows) {
  const map = {}
  ;(rows || []).forEach(r => { if (r && r.username) map[r.username] = { name: r.name || '', dept: r.dept || '' } })
  return map
}
// v178：看板「线下课」标签的班级切换态。一律为 classId —— 不再有「全部班级」总览态。
//   ★ v176 时 '' = 全部班级平铺总览；v178 按用户要求去掉整体回顾（84 列平铺太臃肿），
//     改为「直接选中某个班看该班数据」。'' 仅作为「尚未选班」的瞬间态，会被自动落到第一个班。
//   ★ 单一状态源，切班只重渲染矩阵容器（#dashCourseMatrixBox），不动整页 —— 避免重算
//     整个数据看板（含云端聚合），也避免页面滚动位置丢失。
let dashCourseSel = ''
// v176：下拉切班时的局部重渲染数据源（由 _courseMatrices 每次调用刷新）。
//   ★ 必须与 dashCourseSel 一起声明在 _courseMatrices 之前 —— 后面用 `let` 声明而前面提前
//     引用会落进 TDZ（ReferenceError），虽然实际调用在脚本加载后，语义上也不应依赖这个巧合。
let dashCourseDocCache = null
let dashCourseInfoCache = {}

// v176：单班完成度统计（KPI 卡数据源）。
//   ★ 口径必须与 _courseSummary / renderCourseDashboard 一致：
//     · 分母 = 成员数 × 已发布任务数（草稿不计）
//     · offline / video 无分数 → 不进平均分
//     · 一个格子「已完成」的判据与矩阵着色完全同源（见 _courseCellDone）
function _courseClassStat(c) {
  const members = (c && c.members) || []
  const assigns = ((c && c.assignments) || []).filter(a => a.status !== 'draft')
  let done = 0
  const scores = []
  assigns.forEach(a => {
    members.forEach(u => {
      const r = (a.results || {})[u]
      if (!r) return
      if (_courseCellDone(a, r)) done++
      // 视频 / 线下课无分数，不计入均分（与 _courseSummary 同口径）
      if (a.type !== 'video' && a.type !== 'offline') {
        const sc = Number(r.score)
        if (Number.isFinite(sc)) scores.push(sc)
      }
    })
  })
  const cells = members.length * assigns.length
  return {
    members: members.length,
    assigns: assigns.length,
    done,
    cells,
    completion: cells > 0 ? Math.round(done / cells * 100) : 0,
    avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
  }
}

// v176：一个格子是否算「已完成」—— 矩阵着色与 KPI 完成度共用同一判据，避免两处口径漂移。
//   · offline：只有被标注出席（done）才算完成
//   · video  ：观看 ≥90% 且（无小测 或 小测已作答）才算完成（v44 语义：看完 ≠ 完成）
//   · 其余   ：有成绩记录即完成
function _courseCellDone(a, r) {
  if (!r) return false
  if (a.type === 'offline') return !!r.done
  if (a.type === 'video') {
    const pct = r.watchedPct != null ? Math.min(100, Math.round(r.watchedPct)) : 100
    if (pct < 90) return false
    const hasQuiz = Array.isArray(a.quiz) && a.quiz.length > 0
    if (hasQuiz && r.quizTotal == null) return false   // 配了小测但没答 → 未完成
    return true
  }
  return true
}

// v179：任务列按「章节」分组 —— 成绩矩阵列头的横排太长，按老师录入的章节切段更易读。
//   ★ 语义与学员端进度页完全一致（course-app.js 进度流同款）：章节是「一段连续区间」，
//     相邻同章的任务自动归为一组；章节名变化处开新组。
//   ★ 无章节（空串 / 未录）的任务**不丢弃、不合并**，归到「未分章节」组 ——
//     实测线上 202609 两班 17/18 与 18/18 个任务都没录章节，必须给兜底组，
//     否则这两个班会退化成「一组都没有」。
//   ★ 兜底组的显示名 = 该组第一个任务的章节名（空 → courseChapterNone），
//     与学员端「章节未命名」文案同源，避免新增 i18n 键。
//   返回 [{ name, items:[assign] }]，items 保持原顺序，便于表头 colspan 与 tfoot 对齐。
function _courseChapterGroups(assigns) {
  const groups = []
  ;(assigns || []).forEach(a => {
    const ch = String(a && a.chapter == null ? '' : a.chapter).trim()
    const last = groups.length ? groups[groups.length - 1] : null
    if (!last || last.ch !== ch) groups.push({ ch, items: [] })
    groups[groups.length - 1].items.push(a)
  })
  return groups
}

// v179：矩阵表头两行渲染（第一行 = 章节名，第二行 = 任务名）。
//   ★ 只在「确有章节」（至少一组有非空章节名）时才输出章节行 ——
//     否则整班都没录章节时，凭空多出一行全宽的「未分章节」纯属噪音。
//   ★ 表头与数据列数必须严格对齐：章节行 colspan = 该组任务数，合计 = assigns.length。
//   ★ 首列（学员 / 学生）也要占位：无章节行时首列 rowspan=1 单行；
//     有章节行时首列 rowspan=2，否则表头会错位一格。
function _courseHeaderRows(assigns, sel, opt) {
  opt = opt || {}
  const cellFn = opt.cellFn || (a => escHtml(a.title))
  const firstTh = opt.firstTh || ''            // 首列表头 HTML（学员列）
  const thCls = opt.thCls || 'dash-th'
  const chapterCls = opt.chapterCls || 'dash-ch'
  // ★ v179：任务列宽度约束必须保留 —— v41 锁定「任务列 min-width:110px」（成绩看板）+
  //   数据看板用 90px。重构表头时若丢掉这个 style，列宽会被内容挤压抖动。
  const thStyle = opt.thStyle ? ` style="${opt.thStyle}"` : ''
  const groups = _courseChapterGroups(assigns)
  const hasChapter = groups.some(g => g.ch)
  const taskTh = a => `<th class="${thCls}"${thStyle}>${cellFn(a)}</th>`
  const bodyRow = `<tr>${firstTh}${assigns.map(taskTh).join('')}</tr>`
  if (!hasChapter) return bodyRow
  const chCells = groups.map(g =>
    `<th class="${chapterCls}" colspan="${g.items.length}">${escHtml(g.ch || t('courseChapterNone'))}</th>`
  ).join('')
  // 首列跨两行：学员列在章节行与任务行都居中占据同一列
  const firstWithRowspan = firstTh.replace(/^<th\b/, '<th rowspan="2"')
  return `<tr>${firstWithRowspan}${chCells}</tr>` + `<tr>${assigns.map(taskTh).join('')}</tr>`
}

// v176：按任务类型的完成度小条（让老师一眼看出「卡在视频还是卡在作业」）。
function _courseTypeBars(c) {
  const members = (c && c.members) || []
  const assigns = ((c && c.assignments) || []).filter(a => a.status !== 'draft')
  const order = ['homework', 'exam', 'video', 'offline', 'coursefinal']
  const byType = {}
  assigns.forEach(a => {
    const ty = a.type || 'homework'
    if (!byType[ty]) byType[ty] = { total: 0, done: 0 }
    members.forEach(u => {
      byType[ty].total++
      const r = (a.results || {})[u]
      if (r && _courseCellDone(a, r)) byType[ty].done++
    })
  })
  const label = ty => ty === 'offline' ? t('courseTypeOffline')
    : ty === 'video' ? t('courseTypeVideo')
    : ty === 'coursefinal' ? t('courseTypeCourseFinal')
    : ty === 'exam' ? t('courseTypeExam') : t('courseTypeHomework')
  const icon = ty => ty === 'offline' ? '📅' : ty === 'video' ? '🎬' : ty === 'exam' ? '🧪' : ty === 'coursefinal' ? '🏆' : '📝'
  return order.filter(ty => byType[ty]).map(ty => {
    const v = byType[ty]
    const pct = v.total > 0 ? Math.round(v.done / v.total * 100) : 0
    const cls = pct >= 80 ? 'good' : pct >= 40 ? 'ok' : 'bad'
    return `<div class="dcs-type-row">
      <span class="dcs-type-name">${icon(ty)} ${escHtml(label(ty))}</span>
      <span class="dcs-type-bar"><span class="dcs-type-bar-in ${cls}" style="width:${pct}%"></span></span>
      <span class="dcs-type-num">${v.done}/${v.total}<em>${pct}%</em></span>
    </div>`
  }).join('')
}

// v176：班级 KPI 卡 —— 完成率环 + 平均分 + 已完成格数 + 分类型完成度。
// v178：横向瘦身 —— 原「4 个数字 + 右侧分类型条」在宽屏上要横铺 ~900px，观感臃肿。
//   改法：① 去掉「成员数 / 任务数」两个数字（卡头已用「👥 N人 · 📋 N任务」表达，重复）
//         ② 分类型条改为 2 列网格（宽屏）→ 宽度减半；③ 数值列改自适应收窄。
function _courseKpiCard(c) {
  const st = _courseClassStat(c)
  const R = 26, CIRC = 2 * Math.PI * R
  const ring = `<div class="dcs-ring">
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <circle cx="32" cy="32" r="${R}" fill="none" stroke="#e5e7eb" stroke-width="6"></circle>
        <circle cx="32" cy="32" r="${R}" fill="none" stroke="var(--primary)" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${(CIRC * (1 - st.completion / 100)).toFixed(1)}"
          transform="rotate(-90 32 32)"></circle>
      </svg>
      <span class="dcs-ring-txt">${st.completion}%</span>
    </div>`
  const avgTxt = st.avgScore == null ? '—' : st.avgScore + (LANG === 'en' ? '' : '分')
  // v178：第一行（环 + 数字）裹进 .dcs-kpi-top，与第二行（分类型条）分成两个块级行
  return `<div class="dcs-kpi">
    <div class="dcs-kpi-top">
      ${ring}
      <div class="dcs-kpi-stats">
        <div class="dcs-kpi-item"><b>${st.done}<em>/${st.cells}</em></b><span>${escHtml(t('dcsDoneCells'))}</span></div>
        <div class="dcs-kpi-item"><b>${avgTxt}</b><span>${escHtml(t('dcsAvgScore'))}</span></div>
      </div>
    </div>
    <div class="dcs-types">${_courseTypeBars(c)}</div>
  </div>`
}

// v176：班级下拉选择器。切换后只重渲染矩阵容器，不重算整页。
function dashCoursePick(v) {
  dashCourseSel = String(v == null ? '' : v)
  const el = document.getElementById('dashCourseMatrixBox')
  if (el) el.innerHTML = _courseMatrices(dashCourseDocCache, dashCourseInfoCache)
}

// 每班级成绩矩阵 HTML（infoMap：用户名 → { name, dept }，用于成员列显示中文名+部门）
// v178：去掉「全部班级」平铺总览 —— 一律直出单个班（84 列平铺太臃肿）。
//   · 下拉只列班级（无「全部班级」项），首次进入自动选中第一个班
//   · 选中的班被删 / 未选 → 回落到第一个班（不再回落总览）
//   ★ 下拉与 KPI 都只影响「视图」，不改任何统计口径与数据。
function _courseMatrices(doc, infoMap) {
  const classes = (doc && doc.classes) || []
  infoMap = infoMap || {}
  // v176：缓存文档与映射，供下拉切换时局部重渲染使用（避免把 doc 挂到 window 上）
  dashCourseDocCache = doc
  dashCourseInfoCache = infoMap
  if (!classes.length) return ''
  // v178：选中班级不存在（被删）或尚未选 → 回落到第一个班（v176 此处回落的是「总览」）
  if (!dashCourseSel || !classes.some(c => c.id === dashCourseSel)) dashCourseSel = classes[0].id

  // v178：下拉条简化 —— 只列班级，去掉「全部班级（总览）」项
  const selHtml = `<div class="dcs-bar">
    <label class="dcs-bar-lbl">${escHtml(t('dcsPickClass'))}</label>
    <select class="dcs-sel" onchange="dashCoursePick(this.value)">
      ${classes.map(c => {
        const st = _courseClassStat(c)
        return `<option value="${escAttr(c.id)}"${dashCourseSel === c.id ? ' selected' : ''}>${escHtml(c.name)} · ${escHtml(t('courseProgressOf', st.done, st.cells))}</option>`
      }).join('')}
    </select>
  </div>`

  // v178：只渲染选中的那一个班（不再有平铺总览分支）
  const shown = classes.filter(c => c.id === dashCourseSel)
  const body = shown.map(c => {
    const members = c.members || []
    const assigns = c.assignments || []
    if (!assigns.length) return ''
    // v179：任务列按章节分组（章节名作跨列大表头，无章节归「未分章节」）
    const headRows = _courseHeaderRows(assigns, dashCourseSel, {
      firstTh: `<th class="dash-student-th" style="min-width:80px">${t('courseMatrixStudent')}</th>`,
      cellFn: a => {
        const icon = a.type === 'offline' ? '📅' : (a.type === 'video' ? '🎬' : (a.type === 'exam' ? '🧪' : '📝'))
        return `${icon} ${escHtml(a.title)}`
      },
    })
    const rows = (members.length ? members : []).map(u => {
      const cells = assigns.map(a => {
        const r = (a.results || {})[u]
        if (!r) return `<td class="dash-cell not-done">${t('courseDashNotDone')}</td>`
        // 线下课：只有完成（✓ 已标注）状态
        if (a.type === 'offline') {
          return r.done
            ? `<td class="dash-cell good">✓ ${t('courseDoneTag')}</td>`
            : `<td class="dash-cell not-done">${t('courseDashNotDone')}</td>`
        }
        if (a.type === 'video') {
          const pct = r.watchedPct != null ? Math.min(100, Math.round(r.watchedPct)) : 100
          const cls = pct >= 90 ? 'good' : 'ok'
          return `<td class="dash-cell ${cls}">✓ ${pct}%</td>`
        }
        const cls = r.score >= 80 ? 'good' : r.score >= 60 ? 'ok' : 'bad'
        // v58：与 course-app.js 成绩看板对齐 —— 有 history 列历次分数（96→88），替代 ×N；旧数据无 history 退回 ×N
        const histArr = (Array.isArray(r.history) && r.history.length > 1) ? r.history : null
        const tries = histArr
          ? `<div class="dash-hist" title="${escAttr(t('courseHistTitle'))}">${histArr.map(h => h.score).join('→')}</div>`
          : (r.attempts > 1 ? ` <span style="font-size:10px;color:#9ca3af">×${r.attempts}</span>` : '')
        return `<td class="dash-cell ${cls}">${r.score}${LANG === 'en' ? '' : '分'}${tries}</td>`
      }).join('')
      return `<tr><td class="dash-student">${courseMemberCell(u, infoMap)}</td>${cells}</tr>`
    }).join('') || `<tr><td colspan="${assigns.length + 1}" style="text-align:center;color:#9ca3af;padding:20px">${t('courseNoMembers')}</td></tr>`
    // v176：选中单个班级时，标题右侧补上 KPI 卡（完成率环 + 均分 + 分类型完成度），
    //   一眼看清「这个班到底进行到哪了」，不用去数矩阵格子。
    //   v178：现在恒为单班视图，KPI 卡恒显示。
    const kpi = _courseKpiCard(c)
    return `<div class="card" style="margin-bottom:16px;padding:0;overflow-x:auto">
      <div style="padding:12px 16px;border-bottom:1px solid #e5e7eb"><strong>🎓 ${escHtml(c.name)}</strong>
        <span style="color:#6b7280;font-size:13px;margin-left:8px">👥 ${members.length}${t('courseMembersUnit')} · 📋 ${assigns.length}${t('courseAssignUnit')}</span>
      </div>
      ${kpi}
      <table class="admin-table dash-table">
        <thead>${headRows}</thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
  }).join('')
  // v178：选中的班存在但一个任务都没有 → 提示卡（有班级的情形在上面已保证 sel 有效）
  const inner = body || `<div class="card" style="padding:24px;text-align:center;color:#9ca3af">${escHtml(t('dashOfflineEmpty'))}</div>`
  return `<div id="dashCourseMatrixBox">${selHtml}${inner}</div>`
}

// ====== 管理员数据加载（账号管理页 / 数据看板页共用）======
// v167：看板「等级」列 —— **只认七天挑战能力等级**（云端 base[u].chLevel）。
//   ★ 口径统一：全站分级一律走七天挑战。水平测定级（placementLevel）**不再参与显示**。
//   为什么去掉回落：水平测验在 v81 已关闭（PLACEMENT_ENABLED=false），placementLevel 只是
//     历史遗留的「一次性摸底结果」，与挑战等级是两套完全不同的口径。同名列混显会让管理员
//     误读成挑战等级（v166 加虚线弱化仍不够 —— 用户实测反馈「分不清 / 一堆未评定」）。
//   ★ 与 v166 的一致性：`chLevel` 本就是独立字段，这里只是把显示侧的回落摘掉，
//     数据侧（云端字段、事件、回放、升降级）**一律不动**。
function _chLevelCell(u) {
  const cl = Number(u && u.chLevel) || 0
  if (cl >= 1 && cl <= 4) {
    return `<span class="level-badge level-${cl}" title="${escAttr(t('dashChLevelTip'))}">L${cl}</span>`
  }
  return `<span style="color:#9ca3af;font-size:12px" title="${escAttr(t('dashChLevelNoneTip'))}">${t('dashChLevelNone')}</span>`
}

async function loadAdminRows() {
  // v167：**移除** openDashboard 时的 recalcCloudPlacementLevels() 调用。
  //   原因：看板等级列已改为只认挑战等级，水平测定级不再参与显示 → 这次重算已无消费方；
  //   而它本身会用水平测数据**改写 placementLevel 且只降不升**，且只在 localStorage 无
  //   `eq_cloud_recalc_v2` 时运行（= 换设备/清缓存才触发）→ 纯属休眠副作用，去掉更稳。
  //   ★ 函数本体与事件流保留（学员端 getStats 等仍读 placementLevel），只是不再主动触发。

  // 打开时再强制拉一次云端 → 保证看到的是云端最终态（其他设备的角色变更会立刻反映）
  let pullSummary = { ok: false }
  try { pullSummary = await Store.pullCloudChanges() } catch (e) { /* ignore */ }
  const hadChanges = pullSummary && pullSummary.ok && pullSummary.applied && (
    (pullSummary.applied.roleChanged ? pullSummary.applied.roleChanged.length : 0) +
    (pullSummary.applied.renamed ? pullSummary.applied.renamed.length : 0) +
    (pullSummary.applied.deleted ? pullSummary.applied.deleted.length : 0) +
    (pullSummary.applied.added ? pullSummary.applied.added.length : 0) +
    (pullSummary.applied.deptChanged ? pullSummary.applied.deptChanged.length : 0)) > 0

  // 拉取后 session 角色被云端覆盖（说明本机先前显示是旧值），提示管理员重新进入题库/学员界面
  let sessionChanged = false
  if (pullSummary && pullSummary.ok && pullSummary.applied && pullSummary.applied.sessionRoleSync) {
    sessionChanged = true
  }

  // 并行加载线上 + 线下数据
  const [cloudResult, courseDoc] = await Promise.all([
    CloudSync.getDashboardData().catch(() => null),
    (typeof CourseStore !== 'undefined' ? CourseStore.getDoc().catch(() => ({ v:1, classes:[] })) : Promise.resolve({ v:1, classes:[] }))
  ])
  const cloudRows = cloudResult
  const courseS = _courseSummary(courseDoc)

  // 本机账号表：云端行挂上本机 id，本机独有用户回退本地统计
  const localUsers = Store.getUsers()
  const rows = []
  if (cloudRows) {
    cloudRows.forEach(r => {
      const lu = localUsers.find(u => u.username === r.username)
      if (lu) r.id = lu.id
      else r.cloudOnly = true
      rows.push(r)
    })
  }
  localUsers.forEach(lu => {
    if (rows.some(r => r.username === lu.username)) return
    const st = Store.getUserStats(lu.id)
    rows.push({
      id: lu.id, username: lu.username, name: lu.name, dept: lu.dept, role: lu.role,
      createdAt: lu.createdAt, loginCount: st.loginCount, loginSec: st.loginSec,
      practiceCount: st.practiceCount, practiceCorrect: st.practiceCorrect, practiceTotal: st.practiceTotal,
      examCount: st.examCount, examScoreSum: st.examCount > 0 ? st.examAvg * st.examCount : 0,
      examBest: st.examBest, examPassCount: Math.round(st.examCount * st.examPassRate / 100),
      placementLevel: st.placementLevel, lastActive: st.lastActive
    })
  })

  // 派生显示字段 + 线下统计
  rows.forEach(r => {
    r.loginDuration = (r.loginSec || 0) > 0 ? Store._fmtDuration(r.loginSec) : '—'
    r.practiceAccuracy = (r.practiceTotal || 0) > 0 ? Math.round((r.practiceCorrect || 0) / r.practiceTotal * 100) : 0
    r.examAvg = (r.examCount || 0) > 0 ? Math.round((r.examScoreSum || 0) / r.examCount) : 0
    // 线下课程统计
    const cs = _courseStatsForUser(courseDoc, r.username)
    r.courseDone = cs.done
    r.courseTotal = cs.total
    r.courseAvg = cs.avg
    r.courseBest = cs.best
  })
  rows.sort((a, b) => ((b.role === 'admin') - (a.role === 'admin')) || ((b.lastActive || 0) - (a.lastActive || 0)))

  const students = rows.filter(u => u.role !== 'admin')
  // 线上汇总
  const totalPractice = students.reduce((s, u) => s + (u.practiceCount || 0), 0)
  const totalExams = students.reduce((s, u) => s + (u.examCount || 0), 0)
  const examAvail = students.filter(u => u.examCount > 0)
  const avgExam = examAvail.length > 0 ? Math.round(examAvail.reduce((s, u) => s + u.examAvg, 0) / examAvail.length) : 0
  // v167：口径统一为挑战等级（水平测定级不再计入）
  const placedCount = students.filter(u => u.chLevel >= 1 && u.chLevel <= 4).length
  // 线下汇总
  const courseStudents = students.filter(u => u.courseTotal > 0)
  const courseAvgAll = courseStudents.length ? Math.round(courseStudents.reduce((s,u)=>s+u.courseAvg,0)/courseStudents.length) : 0

  return { rows, students, courseDoc, courseS, cloudRows, hadChanges, sessionChanged, totalPractice, totalExams, avgExam, placedCount, courseAvgAll }
}

// 管理员页面通用横幅（云端离线 / 课程缓存 / 拉取变化）
function adminWarnCards(cloudRows, courseS, hadChanges, sessionChanged) {
  return `
    ${cloudRows === null ? `<div class="card" style="padding:12px 16px;border-left:4px solid #f59e0b;margin-bottom:16px;font-size:13px;color:#92400e;background:#fffbeb">${t('cloudOfflineWarn')}</div>` : ''}
    ${CourseStore && CourseStore.status !== 'online' && courseS.assigns > 0 ? `<div class="card" style="padding:12px 16px;border-left:4px solid #f59e0b;margin-bottom:16px;font-size:13px;color:#92400e;background:#fffbeb">${t('courseCacheWarn')}</div>` : ''}
    ${hadChanges ? `<div class="card" style="padding:12px 16px;border-left:4px solid #10b981;margin-bottom:16px;font-size:13px;color:#065f46;background:#ecfdf5">
      ☁️ ${t('cloudPullJustDone')}${sessionChanged ? ' · ' + t('cloudRoleChangedSelf') : ''}
    </div>` : ''}`
}

// ====== 账号管理页（管理员）======
// 职责：账号的增删改 / 重置密码 / 角色与定级管理；学习数据见「数据看板」页
async function renderUsers() {
  if (!Store.isAdmin()) return
  const session = Store.getSession()
  const el = document.getElementById('page-users')
  el.innerHTML = `<div class="card" style="text-align:center;padding:48px;color:#6b7280"><div style="font-size:28px;margin-bottom:10px">☁️</div>${t('cloudLoading')}</div>`

  const d = await loadAdminRows()
  const { rows, cloudRows, courseS, hadChanges, sessionChanged } = d

  el.innerHTML = `
    ${adminWarnCards(cloudRows, courseS, hadChanges, sessionChanged)}
    <div class="admin-toolbar">
      <span style="font-size:14px;color:#6b7280;flex:1">${t('usersPageTitle')}</span>
      <button class="btn btn-ghost" onclick="openLogoModal()">🖼 ${t('logoUploadBtn')}</button>
      <button class="btn btn-ghost" onclick="openMergeModal()" style="color:#b45309;border-color:#fde68a">🔗 ${t('mergeBtn')}</button>
      <button class="btn btn-ghost" onclick="clearAllPlacements()" style="color:#dc2626;border-color:#fecaca">${t('clearPlacementBtn')}</button>
      <button class="btn btn-primary" onclick="openUserModal()">${t('newAccount')}</button>
    </div>
    <div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead>
          <tr>
            <th>${t('thUsername')}</th>
            <th>${t('thName')}</th>
            <th>${t('thDept')}</th>
            <th>${t('thRole')}</th>
            <th>${t('thLevel')}</th>
            <th>${t('thLastActive')}</th>
            <th>${t('thAction')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(u => {
            const lastActive = u.lastActive ? new Date(u.lastActive).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
            const rowId = u.id || 0
            const deptChangeBtn = u.role !== 'admin'
              ? `<button class="btn btn-ghost btn-sm" onclick="changeUserDeptUI(${rowId}, ${escAttr(JSON.stringify(u.username))}, ${escAttr(JSON.stringify(u.dept || ''))})">${t('changeDeptBtn')}</button>`
              : ''
            return `<tr>
              <td>${escHtml(u.username)}${u.id === session.id ? ` <span style="color:#9ca3af;font-size:10px">${t('meTag')}</span>` : ''}${u.cloudOnly ? ` <span style="color:#2563eb;font-size:10px" title="${t('cloudUserTip')}">☁</span>` : ''}</td>
              <td>${escHtml(u.name || '—')}</td>
              <td>${escHtml(u.dept || '—')}</td>
              <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : ''}">${u.role === 'admin' ? t('roleAdmin') : t('roleStudent')}</span></td>
              <td>${u.role !== 'admin' ? _chLevelCell(u) : '—'}</td>
              <td style="font-size:12px;color:#6b7280">${lastActive}</td>
              <td>
                ${rowId ? `<div class="admin-actions">
                  ${deptChangeBtn}
                  <button class="btn btn-ghost btn-sm" onclick="resetUserPassword(${rowId}, ${escAttr(JSON.stringify(u.username))})">${t('resetPwd')}</button>
                  <button class="btn btn-ghost btn-sm" onclick="renameUserAccount(${rowId}, ${escAttr(JSON.stringify(u.username))})">${t('renameUserBtn')}</button>
                  ${u.role === 'admin'
                    ? (u.id === session.id ? `<span style="font-size:12px;color:#9ca3af">${t('currentUser')}</span>` : `<button class="btn btn-ghost btn-sm" onclick="setUserRoleUI(${rowId}, ${escAttr(JSON.stringify(u.username))}, 'student')">${t('cancelAdminBtn')}</button>`)
                    : `<button class="btn btn-ghost btn-sm" onclick="setUserRoleUI(${rowId}, ${escAttr(JSON.stringify(u.username))}, 'admin')">${t('setAdminBtn')}</button>`}
                  ${u.id !== session.id ? `<button class="btn btn-danger btn-sm" onclick="deleteUserAccount(${rowId}, ${escAttr(JSON.stringify(u.username))})">${t('deleteAccount')}</button>` : ''}
                </div>` : `<div class="admin-actions">
                  ${deptChangeBtn}
                  <button class="btn btn-ghost btn-sm" onclick="setUserRoleUI(0, ${escAttr(JSON.stringify(u.username))}, ${u.role === 'admin' ? "'student'" : "'admin'"})" title="${t('cloudUserTip')}">${u.role === 'admin' ? t('cancelAdminBtn') : t('setAdminBtn')}</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteUserAccount(0, ${escAttr(JSON.stringify(u.username))})" title="${t('cloudUserTip')}">${t('deleteAccount')}</button>
                </div>`}
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    </div>

    <p class="form-hint" style="margin-top:12px">${t('usersPageHint')}</p>
  `
}

// ====== 数据看板页（管理员）======
// 职责：数据分三个标签页（v113：七天挑战从「线上培训」里拆出来独立成标签）
//   线上培训：登录时长 / 刷题 / 考试 / 定级 / 分类进度 / 每道题正确率
//   线下课：班级作业完成率 / 学员线下明细 / 课程成绩矩阵
//   七天挑战：营次管理 / 开关面板 / 挑战成绩统计（原属线上，v113 拆出）
let dashTab = 'online'   // 'online' 线上培训 | 'offline' 线下课 | 'challenge' 七天挑战
const DASH_TABS = [
  { v: 'online',    btn: 'dashTabBtnOnline',    block: 'dashOnlineBlock',    ico: '🌐', label: 'dashTabOnline' },
  { v: 'offline',   btn: 'dashTabBtnOffline',   block: 'dashOfflineBlock',   ico: '🏫', label: 'dashTabOffline' },
  { v: 'challenge', btn: 'dashTabBtnChallenge', block: 'dashChallengeTabBlock', ico: '🏅', label: 'dashTabChallenge' },
]
function dashSwitchTab(v) {
  dashTab = v
  DASH_TABS.forEach(c => {
    const b = document.getElementById(c.block)
    if (b) b.style.display = (c.v === v) ? '' : 'none'
    const btn = document.getElementById(c.btn)
    if (btn) btn.className = 'btn btn-sm ' + (c.v === v ? 'btn-primary' : 'btn-ghost')
  })
}
// v75：云端存储用量指示条（共享用户数据文档 / 1MB 上限，数据看板顶部）
function dashStorageBarHtml() {
  const bytes = (typeof CloudSync !== 'undefined' && CloudSync._lastDocBytes) || 0
  if (!bytes) return ''
  const CAP = 1024 * 1024
  const pct = Math.min(100, Math.round(bytes / CAP * 100))
  const kb = Math.round(bytes / 1024)
  const color = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#16a34a'
  return `
    <div class="card" style="margin-bottom:16px;padding:12px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px">
        <span style="font-size:13px;font-weight:700">💾 ${t('dashStoreTitle')}</span>
        <span style="font-size:12px;font-weight:700;color:${color}">${kb} KB / 1 MB · ${pct}%</span>
      </div>
      <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <p class="form-hint" style="margin:6px 0 0">${t('dashStoreHint')}</p>
    </div>`
}

async function renderDashboard() {
  if (!Store.isAdmin()) return
  // ★ v189：姓名可点链接。**必须在函数内用 typeof 守卫自包含** —— 既有套件按源码切片
  //   只注入本函数（沙箱里没有 upNameLink），直接引用会 ReferenceError 让整片套件假红
  //   （v182 拆函数、v139 同款坑）。切片沙箱里 typeof 恒 undefined → 退回纯文本，行为不变。
  const _nameLink = (typeof upNameLink === 'function') ? upNameLink : ((_u, _x) => escHtml(_x || '—'))
  const session = Store.getSession()
  const el = document.getElementById('page-dashboard')
  el.innerHTML = `<div class="card" style="text-align:center;padding:48px;color:#6b7280"><div style="font-size:28px;margin-bottom:10px">☁️</div>${t('cloudLoading')}</div>`

  const d = await loadAdminRows()
  const { rows, students, courseDoc, courseS, cloudRows, hadChanges, sessionChanged, totalPractice, totalExams, avgExam, placedCount } = d

  // ---- 线上明细表（账号 + 线上学习列）----
  const onlineRowsHtml = rows.map(u => {
    const lastActive = u.lastActive ? new Date(u.lastActive).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
    return `<tr>
      <td>${escHtml(u.username)}${u.id === session.id ? ` <span style="color:#9ca3af;font-size:10px">${t('meTag')}</span>` : ''}${u.cloudOnly ? ` <span style="color:#2563eb;font-size:10px" title="${t('cloudUserTip')}">☁</span>` : ''}</td>
      <td>${_nameLink(u.username, u.name || '—')}</td>
      <td>${escHtml(u.dept || '—')}</td>
      <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : ''}">${u.role === 'admin' ? t('roleAdmin') : t('roleStudent')}</span></td>
      <td>${u.role !== 'admin' ? _chLevelCell(u) : '—'}</td>
      <td style="text-align:center">${u.loginCount || 0}</td>
      <td>${u.loginDuration}</td>
      <td style="text-align:center">${u.practiceCount || 0}${u.practiceCount ? ' · ' + u.practiceAccuracy + '%' : ''}</td>
      <td style="text-align:center">${u.examCount ? u.examAvg + (LANG === 'en' ? '' : '分') : '—'}${u.examBest ? ' / ' + u.examBest : ''}</td>
      <td style="font-size:12px;color:#6b7280">${lastActive}</td>
    </tr>`
  }).join('')
  const onlineHtml = `
    <div class="dashboard-summary">
      <div class="dash-stat"><div class="dash-val">${rows.length}</div><div class="dash-lbl">${t('dashTotalUsers')}</div></div>
      <div class="dash-stat"><div class="dash-val">${students.length}</div><div class="dash-lbl">${t('dashStudents')}</div></div>
      <div class="dash-stat"><div class="dash-val">${placedCount}</div><div class="dash-lbl">${t('dashPlaced')}</div></div>
      <div class="dash-stat"><div class="dash-val">${totalPractice}</div><div class="dash-lbl">${t('dashTotalPractice')}</div></div>
      <div class="dash-stat"><div class="dash-val">${totalExams}</div><div class="dash-lbl">${t('dashTotalExams')}</div></div>
      <div class="dash-stat"><div class="dash-val">${avgExam}</div><div class="dash-lbl">${t('dashExamAvg')}</div></div>
    </div>

    <div id="dashCatBlock"></div>

    <h2 style="margin:24px 0 12px;font-size:18px">📊 ${t('dashDetailTitle')}</h2>
    <div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead><tr>
          <th>${t('thUsername')}</th><th>${t('thName')}</th><th>${t('thDept')}</th>
          <th>${t('thRole')}</th><th>${t('thLevel')}</th>
          <th>${t('thLoginCount')}</th><th>${t('thLoginDuration')}</th>
          <th>${t('thPracticeCount')}</th><th>${t('thExamAvg')}</th><th>${t('thLastActive')}</th>
        </tr></thead>
        <tbody>${onlineRowsHtml}</tbody>
      </table>
    </div>

    <div id="perQBlock"></div>`

  // ---- 线下明细表（学员线下课程完成情况）----
  const offlineRowsHtml = students.map(u => `<tr>
    <td>${escHtml(u.username)}${u.cloudOnly ? ` <span style="color:#2563eb;font-size:10px" title="${t('cloudUserTip')}">☁</span>` : ''}</td>
    <td>${_nameLink(u.username, u.name || '—')}</td>
    <td>${escHtml(u.dept || '—')}</td>
    <td style="text-align:center">${u.courseTotal > 0 ? u.courseDone + '/' + u.courseTotal : '—'}</td>
    <td style="text-align:center">${u.courseDone > 0 ? u.courseAvg + (LANG === 'en' ? '' : '分') : '—'}</td>
    <td style="text-align:center">${u.courseBest > 0 ? u.courseBest + (LANG === 'en' ? '' : '分') : '—'}</td>
  </tr>`).join('')
  const offlineHtml = `
    <div class="dashboard-summary">
      <div class="dash-stat"><div class="dash-val">${courseS.classes}</div><div class="dash-lbl">${t('dashCourseClasses')}</div></div>
      <div class="dash-stat"><div class="dash-val">${courseS.assigns}</div><div class="dash-lbl">${t('dashCourseAssigns')}</div></div>
      <div class="dash-stat"><div class="dash-val">${courseS.completion}%</div><div class="dash-lbl">${t('dashCourseCompletion')}</div></div>
      <div class="dash-stat"><div class="dash-val">${courseS.avgScore}${LANG === 'en' ? '' : '分'}</div><div class="dash-lbl">${t('dashCourseAvg')}</div></div>
    </div>

    <h2 style="margin:24px 0 12px;font-size:18px">📋 ${t('dashOfflineDetail')}</h2>
    <div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead><tr>
          <th>${t('thUsername')}</th><th>${t('thName')}</th><th>${t('thDept')}</th>
          <th>${t('thCourseDone')}</th><th>${t('thCourseAvg')}</th><th>${t('thCourseBest')}</th>
        </tr></thead>
        <tbody>${offlineRowsHtml}</tbody>
      </table>
    </div>

    ${courseS.assigns > 0
      ? `<h2 style="margin:24px 0 12px;font-size:18px">📊 ${t('dashCourseMatrixTitle')}</h2>
         <div>${_courseMatrices(courseDoc, _userInfoMapFromRows(rows))}</div>`
      : `<div class="card" style="padding:32px;text-align:center;color:#9ca3af;margin-top:16px">${t('dashOfflineEmpty')}</div>`}`

  // ---- 七天挑战块（v113：原在「线上培训」内，现独立成标签；三个面板保持原相对顺序）----
  //   顺序「营次管理 → 挑战成绩统计」被 v76 / v77 / v107 的历史断言约束，不要调换。
  //   v118：原独立的「🎛️ 七天挑战开关」卡片区（#dashChGate）已并入营次管理表两列，容器随之下线。
  const challengeHtml = `
    ${typeof dashChViewBarHtml === 'function' ? dashChViewBarHtml() : ''}
    <div id="dashRoundsPanel">${dashRoundsPanelHtml()}</div>

    <div id="dashChallengeBlock"></div>`

  el.innerHTML = `
    ${adminWarnCards(cloudRows, courseS, hadChanges, sessionChanged)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${DASH_TABS.map(c => `<button class="btn btn-sm ${dashTab === c.v ? 'btn-primary' : 'btn-ghost'}" id="${c.btn}" onclick="dashSwitchTab('${c.v}')">${c.ico} ${t(c.label)}</button>`).join('\n      ')}
    </div>
    ${dashStorageBarHtml()}
    <div id="dashOnlineBlock" style="${dashTab === 'online' ? '' : 'display:none'}">${onlineHtml}</div>
    <div id="dashOfflineBlock" style="${dashTab === 'offline' ? '' : 'display:none'}">${offlineHtml}</div>
    <div id="dashChallengeTabBlock" style="${dashTab === 'challenge' ? '' : 'display:none'}">${challengeHtml}</div>
    <p class="form-hint" style="margin-top:12px">${t('dashHint')}</p>
  `
  renderDashCatBlock()
  renderDashChallengeBlock(rows)
  _perQLastRows = rows
  renderPerQBlock(rows)
}

// ====== 管理员看板：七天挑战开关（v77 总开关 + v76 期末考试开关；v107 按营次逐个；v118 并入营次表）======
// 背景（v107 修的 bug）：「确保考试开关出现在每个不同的营期下面，而不是一开都开」。
//   数据层早就按期隔离了（开关存在营次的 open / examOpen 字段，见 cloud-store _roundsNorm），
//   但界面只有一张卡、只读 CloudSync._chExamOpen / _chOpen（= 指针那一期），
//   管理员永远只能操作「当前指针期」→ 想把第 2 期的考试打开却把第 1 期改了，看起来就是「一开都开」。
// v107 起：按营次逐期渲染，点击时把该期 id 作为 roundId 传给 cloud-store 精确落刀
//   （setChallengeOpen / setChallengeExamOpen）。
// v118 起（反转 v107 的「独立卡片区」形态）：原本另起一个 🎛️ 卡片区逐期列卡，问题是
//   ① 同一个营次要跨两个面板看（营次表里看排期、开关区里看开关），信息被割裂；
//   ② 开关卡片区曾**跟随看板部门筛选**（老 dashRoundsForGate 按 dashChDept 过滤），
//      管理员切成「标帜餐厅」后只看到标帜那一期，误以为「别的餐厅的开关没有了」。
//   现在把「挑战」「考试」各作一列并进**营次管理表**：一期一行，状态与开关同屏，且
//   营次表始终列全部营次（不跟随部门筛选）→ 不会再出现「其他餐厅看不到」的错觉。
// 注意：营次表**不按部门筛选**是有意为之——它是全集视图；看板挑战统计卡另有 dashChDept 筛选。
// 单期「挑战」列单元格。r = 营次记录
function dashChOpenCellHtml(r) {
  const open = r.open === true
  const rid = escAttr(r.id)
  const badge = open
    ? `<span style="font-size:12px;font-weight:800;color:#059669;background:#d1fae5;border-radius:10px;padding:2px 10px">● ${t('dashChOpenOn')}</span>`
    : `<span style="font-size:12px;font-weight:800;color:#9ca3af;background:#f3f4f6;border-radius:10px;padding:2px 10px">● ${t('dashChOpenOff')}</span>`
  return `
      <td style="white-space:nowrap;text-align:center">
        <div style="margin-bottom:5px">${badge}</div>
        <button class="btn btn-sm ${open ? 'btn-danger' : 'btn-primary'}" style="padding:3px 8px;font-size:12px"
          data-rid="${rid}" onclick="dashToggleChOpen(this)"
          title="${escAttr(t('dashChOpenHint'))}">${open ? t('dashChOpenCloseBtn') : t('dashChOpenOpenBtn')}</button>
      </td>`
}
// 单期「考试」列单元格。r = 营次记录（与 dashChOpenCellHtml 同型，文案/字段各自独立）
function dashChExamCellHtml(r) {
  const examOpen = r.examOpen === true
  const rid = escAttr(r.id)
  const badge = examOpen
    ? `<span style="font-size:12px;font-weight:800;color:#059669;background:#d1fae5;border-radius:10px;padding:2px 10px">● ${t('dashChExamOn')}</span>`
    : `<span style="font-size:12px;font-weight:800;color:#9ca3af;background:#f3f4f6;border-radius:10px;padding:2px 10px">● ${t('dashChExamOff')}</span>`
  return `
      <td style="white-space:nowrap;text-align:center">
        <div style="margin-bottom:5px">${badge}</div>
        <button class="btn btn-sm ${examOpen ? 'btn-danger' : 'btn-primary'}" style="padding:3px 8px;font-size:12px"
          data-rid="${rid}" onclick="dashToggleChExam(this)"
          title="${escAttr(t('dashChExamHint'))}">${examOpen ? t('dashChExamCloseBtn') : t('dashChExamOpenBtn')}</button>
      </td>`
}
// 就地刷新营次表（开关写成功后调用，避免整页 renderDashboard 打断滚动位置）。
// v118 前叫 dashRefreshChGate（刷独立的 #dashChGate 卡片区）；现开关就在营次表里，故改刷 #dashRoundsPanel。
function dashRefreshRoundsPanel() {
  const box = document.getElementById('dashRoundsPanel')
  if (box) box.innerHTML = dashRoundsPanelHtml()
}
// 兼容旧调用名（v107 起的 dashRefreshChGate；v118 开关并入营次表后保留别名，防外部/旧代码引用报错）
function dashRefreshChGate() { dashRefreshRoundsPanel() }
async function dashToggleChOpen(btn) {
  const rid = (btn && btn.dataset && btn.dataset.rid) || ''
  const rec = dashRoundList().find(r => r.id === rid)
  if (!rec) { alert(t('dashChExamFail')); return }
  const next = rec.open !== true
  if (btn) btn.disabled = true
  try {
    const res = await CloudSync.setChallengeOpen({ open: next, roundId: rid })
    if (res && res.ok) {
      rec.open = next
      if (next) rec.at = Date.now()
      dashRefreshRoundsPanel()   // v118：开关在营次表里，就地重绘该表
    } else {
      alert(t('dashChExamFail'))
      if (btn) btn.disabled = false
    }
  } catch (e) {
    alert(t('dashChExamFail'))
    if (btn) btn.disabled = false
  }
}

// v129：营次「编辑」按钮（操作列）。原来是「建了就改不了」——只能删了重建，
//   但删除会连带丢掉该营次的成绩归属线索，代价太大。现改为就地编辑名称/起止时间/适用部门。
function dashEditRoundBtnHtml(r) {
  return `<button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:12px;margin-right:4px" data-rid="${escAttr(r.id)}" onclick="dashOpenEditRound(this)">${t('dashRoundEdit')}</button>`
}
// 时间戳 → datetime-local 值（本地时区，yyyy-MM-ddTHH:mm）；与 dashParseLocalDT 互逆
function dashTsToLocalDT(ts) {
  const v = Number(ts) || 0
  if (!v) return ''
  const d = new Date(v)
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
}
// 编辑营次弹窗：直接在看板面板顶部插入内嵌表单（不另开 modal，避免与看板重绘生命期打架）
let _dashEditRoundId = ''
function dashOpenEditRound(el) {
  const rid = (el && el.dataset && el.dataset.rid) || ''
  const rec = dashRoundList().find(r => r.id === rid)
  if (!rec) return
  _dashEditRoundId = rid
  const host = document.getElementById('dashRoundForm')
  if (!host) return
  host.style.display = 'block'
  // 与「新建」表单共用同一容器：编辑态下标题/按钮/字段都换成编辑语义
  host.innerHTML = `
    <div style="font-weight:700;font-size:14px;margin-bottom:10px">✏️ ${t('dashRoundEditTitle')} — ${escHtml(rec.name)}</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px">
      <input id="dashEditRoundName" class="input-answer" style="flex:1;min-width:180px" placeholder="${escAttr(t('dashRoundNamePh'))}" value="${escAttr(rec.name)}" />
      <input id="dashEditRoundStart" type="datetime-local" class="input-answer" style="flex:1;min-width:180px" title="${escAttr(t('dashRoundStartPh'))}" value="${escAttr(dashTsToLocalDT(rec.startAt))}" />
      <input id="dashEditRoundEnd" type="datetime-local" class="input-answer" style="flex:1;min-width:180px" title="${escAttr(t('dashRoundEndPh'))}" value="${escAttr(dashTsToLocalDT(rec.endAt))}" />
    </div>
    <p class="form-hint" style="margin:0 0 10px">⏰ ${t('dashRoundEditScheduleHint')}</p>
    <div style="border-top:1px dashed #c7d2fe;padding-top:10px;margin-bottom:10px">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px">🏷️ ${t('roundDeptLabel')}</div>
      <div class="dashEditRoundDeptBox">${dashDeptOptionsHtml(rec.depts || [])}</div>
      <p class="form-hint" style="margin:0">${t('dashRoundDeptHint')}</p>
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:13px;font-weight:700;display:block;margin-bottom:6px">🗓️ ${t('dashRoundPlanLabel')}</label>
      <select id="dashEditRoundPlan" style="padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;min-width:220px">
        <option value="" ${!rec.chPlan ? 'selected' : ''}>${t('dashRoundPlanV1')}</option>
        <option value="v2" ${rec.chPlan === 'v2' ? 'selected' : ''}>${t('dashRoundPlanV2')}</option>
        <option value="v3" ${rec.chPlan === 'v3' ? 'selected' : ''}>${t('dashRoundPlanV3')}</option>
      </select>
      <p class="form-hint" style="margin:4px 0 0">${t('dashRoundPlanHint')}</p>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" id="dashEditRoundSaveBtn" onclick="dashSaveRoundEdit()">${t('dashRoundEditSave')}</button>
      <button class="btn btn-ghost btn-sm" onclick="dashCloseEditRound()">${t('dashRoundCancel')}</button>
    </div>`
}
// 编辑态下部门复选框也在同一容器内 —— 取值时必须只取编辑表单里的（新建表单已整体替换，不会同名冲突）
function dashPickedEditDepts() {
  const box = document.querySelector('.dashEditRoundDeptBox')
  if (!box) return []
  const out = []
  box.querySelectorAll('input[type=checkbox]').forEach(cb => { if (cb.checked) out.push(cb.value) })
  return out
}
function dashCloseEditRound() {
  _dashEditRoundId = ''
  const host = document.getElementById('dashRoundForm')
  if (host) { host.style.display = 'none'; host.innerHTML = '' }
  // 还原为「新建」表单（下次点「新建营次」仍可用）
  const p = document.getElementById('dashRoundsPanel')
  if (p) p.innerHTML = dashRoundsPanelHtml()
}
async function dashSaveRoundEdit() {
  const rid = _dashEditRoundId
  if (!rid || typeof CloudSync === 'undefined' || !CloudSync.setChallengeRound) return
  const nameEl = document.getElementById('dashEditRoundName')
  const startEl = document.getElementById('dashEditRoundStart')
  const endEl = document.getElementById('dashEditRoundEnd')
  const name = (nameEl && nameEl.value || '').trim()
  const startAt = dashParseLocalDT(startEl && startEl.value)
  const endAt = dashParseLocalDT(endEl && endEl.value)
  const depts = dashPickedEditDepts()
  // v196：挑战结构（不改动 = 保持原值 —— patch 不带 chPlan 字段时云端不会动它）
  const planEl = document.getElementById('dashEditRoundPlan')
  const patch = { name, startAt, endAt, depts }
  if (planEl && planEl.value) patch.chPlan = planEl.value
  if (startAt && endAt && endAt <= startAt) { alert(t('dashRoundCreateFail')); return }
  const btn = document.getElementById('dashEditRoundSaveBtn')
  if (btn) btn.disabled = true
  try {
    const res = await CloudSync.setChallengeRound(rid, patch)
    if (res && res.ok) {
      _dashEditRoundId = ''
      alert(t('dashRoundEditSaved', name || rid))
      renderDashboard()
    } else {
      alert(t('dashRoundEditFail'))
      if (btn) btn.disabled = false
    }
  } catch (e) {
    alert(t('dashRoundEditFail'))
    if (btn) btn.disabled = false
  }
}
// ====== 管理员看板：七天挑战营次管理（v88） ======
// 管理员自助新建营次（可设起止时间 → 到点自动开放、到期自动关闭），切换当前营次，删除营次。
// 云端结构见 cloud-store.js 顶部「营次（Round）」说明；此处只负责渲染与调用。
// 排期结算与 cloud-store roundOpenState 同口径（看板只读，不依赖 CloudSync 方法是否已加载）。
function dashRoundOpenState(r, now) {
  const t0 = Number(now) || Date.now()
  const startAt = Number(r && r.startAt) || 0
  const endAt = Number(r && r.endAt) || 0
  const manual = !!(r && r.open)
  if (endAt > 0 && t0 >= endAt) return 'ended'
  if (startAt > 0 && t0 < startAt) return 'upcoming'
  return manual ? 'open' : 'closed'
}
function dashRoundStateTag(st) {
  if (st === 'open') return `<span style="font-size:11px;font-weight:800;color:#059669;background:#d1fae5;border-radius:10px;padding:2px 8px">● ${t('dashRoundOpenTag')}</span>`
  if (st === 'upcoming') return `<span style="font-size:11px;font-weight:800;color:#b45309;background:#fef3c7;border-radius:10px;padding:2px 8px">⏳ ${t('dashRoundUpcomingTag')}</span>`
  if (st === 'ended') return `<span style="font-size:11px;font-weight:800;color:#6b7280;background:#f3f4f6;border-radius:10px;padding:2px 8px">🏁 ${t('dashRoundEndedTag')}</span>`
  return `<span style="font-size:11px;font-weight:800;color:#6b7280;background:#f3f4f6;border-radius:10px;padding:2px 8px">● ${t('dashRoundClosedTag')}</span>`
}
function dashRoundWindowText(r) {
  const s = Number(r && r.startAt) || 0
  const e = Number(r && r.endAt) || 0
  const f = ts => new Date(ts).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  if (s && e) return `${f(s)} → ${f(e)}`
  if (s) return LANG === 'en' ? `from ${f(s)}` : `${f(s)} 起`
  if (e) return LANG === 'en' ? `until ${f(e)}` : `至 ${f(e)}`
  return `<span style="color:#9ca3af">${t('dashRoundNoWindow')}</span>`
}
function dashRoundList() {
  try {
    if (typeof CloudSync === 'undefined') return []
    return Array.isArray(CloudSync._chRounds) ? CloudSync._chRounds : []
  } catch (e) { return [] }
}
function dashRoundCurId() {
  try {
    if (typeof CloudSync !== 'undefined' && CloudSync._chRoundCurId) return String(CloudSync._chRoundCurId)
  } catch (e) {}
  return 'r1'
}
// 营次 slug 归一（与 challenge.js chRoundSlug 同口径）：
//   '' / undefined / 'r1' / '第一期' → '第一期'（v87 及更早的记录不带 rd 字段，一律归第一期）
//   其余原样返回（营次 id，如 'r2'）
// ⚠️ v102：**绝不能把营次名称当记录键**。历史事故见 cloud-store.js `_roundSlugKey` 注释——
//   v88 曾用营次名称作键，v90 改名后存量记录与新记录双双对不上，成绩在看板整体丢失。
function dashRoundSlug(id) {
  const s = String(id == null ? '' : id).trim()
  if (!s) return '第一期'
  if (s === 'r1' || s === '第一期') return '第一期'
  return s
}
// v89：营次适用部门（空数组 = 全部部门，兼容 v88 存量营次）→ 本地化显示文本
function dashRoundDeptText(r) {
  const list = (r && Array.isArray(r.depts)) ? r.depts.filter(x => x) : []
  if (!list.length) return `<span style="color:#9ca3af">${t('roundDeptAll')}</span>`
  return list.map(d => {
    const name = (typeof deptSlugName === 'function' && deptSlugName(d)) || d
    return `<span style="font-size:11px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:999px;padding:1px 7px;white-space:nowrap;display:inline-block">${escHtml(name)}</span>`
  }).join(' ')
}
// 部门多选清单（营次新建/编辑共用）：饮食部四分队 + 房务部各分队 + 大部门整包
function dashDeptOptionsHtml(selected) {
  const sel = Array.isArray(selected) ? selected : []
  const out = []
  const tree = deptTree()
  if (typeof DEPT_SUB_SLUGS === 'undefined') return ''
  DEPT_MAJOR_KEYS.forEach(mk => {
    if (mk === 'other') return
    const subs = DEPT_SUB_SLUGS[mk] || {}
    const names = t('chDeptNames') || {}
    Object.keys(subs).forEach(sub => {
      const slug = mk + '/' + subs[sub]
      const label = names[sub] || sub
      out.push(`<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0 12px 6px 0;cursor:pointer">
        <input type="checkbox" class="dashRoundDept" value="${escAttr(slug)}" ${sel.indexOf(slug) >= 0 ? 'checked' : ''}>
        <span>${escHtml(label)}</span>
      </label>`)
    })
  })
  return out.join('')
}
// 看板营次面板：营次列表（状态 / 排期 / 查看 / 设为当前 / 删除）+ 新建表单
// 说明：v88 起不再提供「关闭挑战」作为常驻操作——本期结束后新建下一期即可；
//   若需临时关闭当前期，展开该营次的排期设置把「自动关闭时间」设为过去即可（下次重绘生效）。
// v89：营次带「适用部门」——一个营次可只对本部门开放（如酒吧团队单独一期）；
//   不勾选任何部门 = 全部部门适用（v88 行为）。
function dashRoundsPanelHtml() {
  const list = dashRoundList()
  const curId = dashRoundCurId()
  const now = Date.now()
  const rows = list.map(r => {
    const st = dashRoundOpenState(r, now)
    const isCur = r.id === curId
    const viewed = dashRoundView === r.id
    // v152：显示「本部门组内的期号」徽章 —— 让管理员一眼看出「标帜第 2 期 / 客房送餐第 1 期」
    //   是各成一列的，而不是被全局序号搅在一起的。
    const dseq = (typeof CloudSync !== 'undefined' && typeof CloudSync.roundSeqOf === 'function')
      ? CloudSync.roundSeqOf(r.id)
      : (Number(r.seq) || 0)
    const seqTag = dseq > 0
      ? ` <span title="${escAttr(t('dashRoundSeqTitle'))}" style="font-size:11px;font-weight:800;color:#7c3aed;background:#f3e8ff;border-radius:10px;padding:2px 8px">#${dseq}</span>`
      : ''
    // v188：天结构徽章 —— Day1/Day7 只考试的新结构（chPlan:'v2'）与老结构并存时，
    //   管理员必须能一眼分辨哪一期是哪种，否则会拿新口径去质问老数据。
    // v196：v3 = 21 天挑战徽章（紫色调，与 v2 绿色区分）。
    const planTag = (r.chPlan === 'v3')
      ? ` <span title="${escAttr(t('dashRoundPlanV3Title'))}" style="font-size:11px;font-weight:800;color:#6d28d9;background:#ede9fe;border-radius:10px;padding:2px 8px">${t('dashRoundPlanV3Tag')}</span>`
      : (r.chPlan === 'v2')
      ? ` <span title="${escAttr(t('dashRoundPlanV2Title'))}" style="font-size:11px;font-weight:800;color:#047857;background:#d1fae5;border-radius:10px;padding:2px 8px">${t('dashRoundPlanV2Tag')}</span>`
      : ''
    return `<tr${viewed ? ' style="background:#eff6ff"' : ''}>
      <td style="white-space:nowrap">${escHtml(r.name)}${seqTag}${planTag}${isCur ? ` <span style="font-size:11px;font-weight:800;color:#2563eb;background:#dbeafe;border-radius:10px;padding:2px 8px">${t('dashRoundCurrent')}</span>` : ''}</td>
      <td style="white-space:nowrap">${dashRoundStateTag(st)}</td>
      <td>${dashRoundDeptText(r)}</td>
      <td style="white-space:nowrap;font-size:12px;color:#6b7280">${dashRoundWindowText(r)}</td>
      ${dashChOpenCellHtml(r)}
      ${dashChExamCellHtml(r)}
      <td style="white-space:nowrap;text-align:center">
        ${viewed ? '' : `<button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:12px;margin-right:4px" data-rid="${escAttr(r.id)}" onclick="dashViewRound(this)">${t('dashRoundView')}</button>`}
        ${dashEditRoundBtnHtml(r)}
        ${isCur ? '' : `<button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:12px;margin-right:4px" data-rid="${escAttr(r.id)}" onclick="dashSetRoundCur(this)">${t('dashRoundMakeCur')}</button>`}
        <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:12px;color:#dc2626" data-rid="${escAttr(r.id)}" data-n="${escAttr(r.name)}" onclick="dashDelRound(this)">${t('dashRoundDel')}</button>
      </td>
    </tr>`
  }).join('')
  return `
    <div class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px">
        <h3 style="margin:0;font-size:16px">📆 ${t('dashRoundTitle')}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="openImportModal(12,'${escAttr(dashChDept)}')" title="${escAttr(t('chUploadHint'))}">📤 ${t('chUploadBtn')}</button>
          <button class="btn btn-primary btn-sm" id="dashRoundAddBtn" onclick="dashToggleRoundForm()">${t('dashRoundAddBtn')}</button>
        </div>
      </div>
      <p class="form-hint" style="margin-bottom:12px">${t('dashRoundHint')}</p>
      <p class="form-hint" style="margin:-6px 0 12px">${t('dashRoundCurHint')}</p>
      <p class="form-hint" style="margin:-6px 0 12px">🎛️ ${t('dashRoundSwitchHint')}</p>
      <div id="dashRoundForm" style="display:none;border:1px dashed #c7d2fe;background:#f8faff;border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px">🆕 ${t('dashRoundNewTitle')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px">
          <input id="dashRoundName" class="input-answer" style="flex:1;min-width:180px" placeholder="${escAttr(t('dashRoundNamePh'))}" />
          <input id="dashRoundStart" type="datetime-local" class="input-answer" style="flex:1;min-width:180px" title="${escAttr(t('dashRoundStartPh'))}" />
          <input id="dashRoundEnd" type="datetime-local" class="input-answer" style="flex:1;min-width:180px" title="${escAttr(t('dashRoundEndPh'))}" />
        </div>
        <p class="form-hint" style="margin:0 0 10px">⏰ ${t('dashRoundScheduleHint')}</p>
        <div style="border-top:1px dashed #c7d2fe;padding-top:10px;margin-bottom:10px">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px">🏷️ ${t('roundDeptLabel')}</div>
          <div>${dashDeptOptionsHtml([])}</div>
          <p class="form-hint" style="margin:0">${t('dashRoundDeptHint')}</p>
        </div>
        <div style="margin-bottom:10px">
          <label style="font-size:13px;font-weight:700;display:block;margin-bottom:6px">🗓️ ${t('dashRoundPlanLabel')}</label>
          <select id="dashRoundPlan" style="padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;min-width:220px">
            <option value="v2" selected>${t('dashRoundPlanV2')}</option>
            <option value="v3">${t('dashRoundPlanV3')}</option>
            <option value="">${t('dashRoundPlanV1')}</option>
          </select>
          <p class="form-hint" style="margin:4px 0 0">${t('dashRoundPlanHint')}</p>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="dashRoundMakeCur" checked />
          <span>${t('dashRoundMakeCurLabel')}</span>
        </label>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" id="dashRoundCreateBtn" onclick="dashCreateRound()">${t('dashRoundCreate')}</button>
          <button class="btn btn-ghost btn-sm" onclick="dashToggleRoundForm()">${t('dashRoundCancel')}</button>
        </div>
      </div>
      ${list.length ? `
      <div style="overflow-x:auto">
        <table class="admin-table" style="font-size:13px">
          <thead><tr>
            <th>${t('dashRoundNameLabel')}</th>
            <th>${t('dashRoundStatusLabel')}</th>
            <th>${t('roundDeptLabel')}</th>
            <th>${t('dashRoundWindowLabel')}</th>
            <th style="text-align:center">${t('dashChOpenTitle')}</th>
            <th style="text-align:center">${t('dashChExamTitle')}</th>
            <th style="text-align:center">${t('dashRoundOpsLabel')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<div style="padding:18px;text-align:center;color:#9ca3af;font-size:13px">${t('dashRoundEmpty')}</div>`}
    </div>`
}
// 收集新建表单里勾选的适用部门（空 = 全部部门）
function dashPickedDepts() {
  const out = []
  document.querySelectorAll('.dashRoundDept').forEach(cb => { if (cb.checked) out.push(cb.value) })
  return out
}
function dashToggleRoundForm() {
  const el = document.getElementById('dashRoundForm')
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none'
}
// datetime-local → 毫秒时间戳（本地时区；空值 → 0）
function dashParseLocalDT(v) {
  const s = String(v || '').trim()
  if (!s) return 0
  const ts = new Date(s).getTime()
  return isNaN(ts) ? 0 : ts
}
async function dashCreateRound() {
  if (typeof CloudSync === 'undefined' || !CloudSync.addChallengeRound) return
  const nameEl = document.getElementById('dashRoundName')
  const startEl = document.getElementById('dashRoundStart')
  const endEl = document.getElementById('dashRoundEnd')
  const curEl = document.getElementById('dashRoundMakeCur')
  const name = (nameEl && nameEl.value || '').trim()
  const startAt = dashParseLocalDT(startEl && startEl.value)
  const endAt = dashParseLocalDT(endEl && endEl.value)
  // v89：适用部门（不勾 = 全部部门）
  const depts = dashPickedDepts()
  // v196：挑战结构（缺省 v2 = 考试独占一天；可选 v3 = 21 天挑战；'' = 旧结构）
  const planEl = document.getElementById('dashRoundPlan')
  const chPlan = (planEl && planEl.value === 'v3') ? 'v3' : (planEl && planEl.value === '' ? '' : 'v2')
  // v152：显式选择是否顺手切换当前营次（不勾 = 只建期，当前期保持不动）
  const makeCurrent = !(curEl && curEl.checked === false)
  if (startAt && endAt && endAt <= startAt) { alert(t('dashRoundCreateFail')); return }
  const btn = document.getElementById('dashRoundCreateBtn')
  if (btn) btn.disabled = true
  try {
    // v152：labelOf 把 slug 转中文 → 默认名形如「客房送餐部七天挑战第一期」
    const res = await CloudSync.addChallengeRound({
      name, startAt, endAt, depts, makeCurrent, chPlan,
      labelOf: (k) => (typeof adminTabLabel === 'function' ? adminTabLabel(k) : k),
    })
    if (res && res.ok) {
      alert(t('dashRoundCreated', name || dashRoundDefaultNameHint(depts)))
      dashRoundView = res.id
      renderDashboard()
    } else {
      alert(t('dashRoundCreateFail'))
      if (btn) btn.disabled = false
    }
  } catch (e) {
    alert(t('dashRoundCreateFail'))
    if (btn) btn.disabled = false
  }
}
// v152：新建成功但用户没填名字时，给个与云端同口径的默认名提示（按**部门组**编号）
function dashRoundDefaultNameHint(depts) {
  const labelOf = (k) => (typeof adminTabLabel === 'function' ? adminTabLabel(k) : k)
  // ★ 必须直接复用云端同一个函数：存量营次没有 seq 字段，
  //   若在这里自己按 `Number(r.seq) || 0` 取最大值，会漏算存量期 → 提示恒为「第 1 期」。
  try {
    if (typeof CloudSync !== 'undefined' && typeof CloudSync.roundDefaultName === 'function') {
      return CloudSync.roundDefaultName(depts, labelOf)
    }
  } catch (e) { /* 回落下面的本地兜底 */ }
  const list = (dashRoundList() || [])
  const key = (Array.isArray(depts) && depts.length) ? depts.slice().sort().join('+') : '__all__'
  const same = list.filter(r => {
    const d = (Array.isArray(r.depts) ? r.depts.filter(Boolean).slice().sort().join('+') : '') || '__all__'
    return d === key
  })
  let seq = same.length
  try {
    if (typeof CloudSync !== 'undefined' && typeof CloudSync.roundNextSeq === 'function') {
      seq = CloudSync.roundNextSeq(depts)
    }
  } catch (e) { /* 用 same.length 兜底 */ }
  const prefix = (Array.isArray(depts) && depts.length)
    ? depts.map(labelOf).join('、') + '七天挑战第'
    : '第 '
  return prefix + seq + (Array.isArray(depts) && depts.length ? '期' : ' 期')
}
async function dashSetRoundCur(el) {
  const rid = (el && el.dataset && el.dataset.rid) || ''
  if (!rid || typeof CloudSync === 'undefined' || !CloudSync.setChallengeRoundCurrent) return
  const rec = dashRoundList().find(r => r.id === rid)
  const label = (rec && rec.name) || rid
  // v117 文案订正：原文案写「全体学员切换到该营次」是错的——营次按部门隔离，
  //   切指针只影响「该营次适用部门」的学员，其他部门各走各的解析链、完全不受影响。
  //   （v89 起 _roundCurrentForDept 先按学员部门匹配，指针不适用本部门时自动跳过。）
  if (!confirm(t('dashRoundMakeCurConfirm', label))) return
  if (el) el.disabled = true
  try {
    const res = await CloudSync.setChallengeRoundCurrent(rid)
    if (res && res.ok) { alert(t('dashRoundSwitched', label)); dashRoundView = rid; renderDashboard() }
    else { alert(t('dashRoundSwitchFail')); if (el) el.disabled = false }
  } catch (e) {
    alert(t('dashRoundSwitchFail'))
    if (el) el.disabled = false
  }
}
async function dashDelRound(el) {
  const rid = (el && el.dataset && el.dataset.rid) || ''
  const nm = (el && el.dataset && el.dataset.n) || rid
  if (!rid || typeof CloudSync === 'undefined' || !CloudSync.deleteChallengeRound) return
  if (!confirm(t('dashRoundDelConfirm', nm))) return
  if (el) el.disabled = true
  try {
    const res = await CloudSync.deleteChallengeRound(rid)
    if (res && res.ok) { alert(t('dashRoundDeleted', nm)); if (dashRoundView === rid) dashRoundView = ''; renderDashboard() }
    else { alert(t('dashRoundDeleteFail')); if (el) el.disabled = false }
  } catch (e) {
    alert(t('dashRoundDeleteFail'))
    if (el) el.disabled = false
  }
}
// 切换看板统计所查看的营次（只影响统计口径，不动学员端指针）
function dashViewRound(el) {
  dashRoundView = (el && el.dataset && el.dataset.rid) || ''
  renderDashChallengeBlock(_perQLastRows || [])
  const p = document.getElementById('dashRoundsPanel')
  if (p) p.innerHTML = dashRoundsPanelHtml()   // v118：营次表内含开关列，重绘即同步
}
// 兼容旧调用名（v100 起的 dashRefreshExamGate → v107 并入 dashRefreshChGate）
function dashRefreshExamGate() { dashRefreshChGate() }
let dashRoundView = ''   // '' = 当前营次；否则为指定营次 id（看板统计筛选）
// v105：最近一次渲染的挑战明细行（供批量补录筛选「进度已到 Day7 但 D7 无成绩」的学员）
let _chDashRows = []
// v89：看板挑战统计的部门筛选（'all' = 全部部门；否则大部门 key / 分部门 slug）
let dashChDept = 'all'
function dashChSetDept(k) {
  dashChDept = String(k || 'all')
  renderDashChallengeBlock(_perQLastRows || [])
}
// v180：管理后台「按历史数据重算全体等级」。
//   背景：v165 的定级只在本机「完成练习那一刻」触发（chRecordStage → chLevelApply），
//   v165 上线**之前**练完的学员本机无依据、之后不再练 → 云端永远没有等级。
//   实测线上 49 人有练习记录、仅 5 人有等级 → 这里一次把漏掉的人按「过往所有正确率」补上。
//   口径（与 chLevelAcc / chLevelBench 完全同源，绝不另起一套）：
//     · 准确率 = 云端 chy 全量（跨营次、按 day-si 去重取 at 最早、cleared 跳过）累计首答准确率
//     · 基准   = 该学员练到过的**最高 day** 的名义计划均值（进阶期用 HARD 计划）
//     · 等级   = 阈值 0.90/0.60/0.30 + 难度档压顶（chLevelCapOfBench），与学员端逐字一致
//     · 线下课 30% 加权**不参与**（后台无 courseState.doc → 与学员端「未加载」时同口径）
//   安全：只对「确有首答记录」的人写等级；从没练过的人一律跳过（绝不写假 L1）。
//   ★ 上报走 Store.reportChallengeLevel → chlevel 事件（最后写入者胜，天然幂等）。
//   ★ 不覆盖更高的既有等级：云端现值更高时保留（等级只升不降 —— 与 chAbsorbCloudLevel 同纪律）。
async function dashRebuildLevels() {
  if (!Store.isAdmin()) return
  const btn = document.getElementById('dashLvRebuildBtn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ' + t('dashLvRebuildRunning') }
  try {
    let rows = []
    try {
      rows = (typeof CloudSync !== 'undefined' && CloudSync.getDashboardData) ? await CloudSync.getDashboardData() : []
    } catch (e) { rows = [] }
    if (!rows.length) { alert(t('dashLvRebuildFail')); return }
    // ===== v182：基准所需「该营次属于进阶期吗」=====
    // ★★★ 旧实现是错的（用户实测踩到）：`list.forEach(r => hardSet[r.id] = true)` 把**每一个**营次
    //   都标成进阶期 → planFor 恒返回 CHALLENGE_DIFF_PLAN_HARD → 第一期学员的 bench 被抬到硬档
    //   → 重算出的等级偏高（本该 L1 的被抬成 L2）。
    //   ★ 修法：**不在这里另写期号推导**，直接调 challenge.js 的 chRoundIsHard(rid)（唯一真相源，
    //     与挑战页 chIsHardRound 同一口径：seq 优先 / 存量期按部门组顺序现算 / 空 depts → '__all__'）。
    //     缺函数 → 保守回落第一期计划（宁可偏松，不可偏紧）。
    const planFor = (slug) => {
      try {
        if (typeof CHALLENGE_DIFF_PLAN_HARD === 'undefined') return CHALLENGE_DIFF_PLAN
        const hard = (typeof chRoundIsHard === 'function') ? chRoundIsHard(slug) === true : false
        return hard ? CHALLENGE_DIFF_PLAN_HARD : CHALLENGE_DIFF_PLAN
      } catch (e) { return CHALLENGE_DIFF_PLAN }
    }
    const slugOf = s => { try { return (typeof chRoundSlug === 'function') ? chRoundSlug(String(s || '')) : String(s || '') } catch (e) { return String(s || '') } }
    let done = 0, skipped = 0
    rows.forEach(r => {
      if (!r || r.role === 'admin' || !r.username) return
      const chy = Array.isArray(r.chy) ? r.chy : []
      if (!chy.length) { skipped++; return }
      // ① 首次完成去重 + 累计准确率 + 最高 day（同 chLevelAcc / chLevelBench 口径）
      const first = {}
      let maxDay = 0
      chy.forEach(x => {
        if (!x || x.cleared) return
        const q = Number(x.total) || 0
        const day = Number(x.day) || 0
        if (!q || !day) return
        const k = day + '-' + (Number(x.si) || 0)
        const at = Number(x.at) || 0
        if (!first[k] || at < (first[k].at || 0)) first[k] = { at: at, c: Number(x.correct) || 0, t: q }
        if (String(x.kind || 'practice') === 'practice' && day > maxDay) maxDay = day
      })
      let c = 0, tq = 0
      Object.keys(first).forEach(k => { c += first[k].c; tq += first[k].t })
      if (!tq) { skipped++; return }
      // ② 基准 = 最高 day 的名义均值（用该营次的计划；查不到营次就用第一期）
      const acc = Math.round(Math.min(1, c / tq) * 100)
      const raw = acc >= 90 ? 4 : acc >= 60 ? 3 : acc >= 30 ? 2 : 1
      let bench = 0
      if (maxDay) {
        const rd = (chy.find(x => x && !x.cleared && (Number(x.day) || 0) === maxDay) || {}).rd
        bench = chPlanDayAvg(planFor(slugOf(rd)), maxDay)
      }
      if (!bench) { skipped++; return }
      // ③ 难度档压顶（与 chLevelOf 同一函数，绝不重写阈值）
      //   ★ v180：必须把 maxDay 与 acc 一并传入 —— L3 的「Day7 + ≥95%」质量门槛
      //     判的就是这两项，漏传 = 门槛永不生效（静默失效，与沙箱漏注入同款陷阱）。
      const lv = Math.max(1, Math.min(4, (typeof chLevelCapOfBench === 'function')
        ? chLevelCapOfBench(bench, raw, maxDay, acc)
        : Math.min(raw, Math.round(bench))))
      // ④ 只升不降：云端现值更高则保留
      const cloudLv = Number(r.chLevel) || 0
      if (cloudLv >= lv) { skipped++; return }
      // ★★★ v182 修复：必须走 reportChallengeLevelFor(username, lv) —— **指定上报对象**。
      //   旧写法 `reportChallengeLevel(lv, r.username)` 把「用户名」塞进了「营次」参数位，
      //   而该方法的 u 恒取 getSession() → 99 名学员的等级事件全挂到 admin 名下，
      //   学员 chLevel 从未写入 → 用户实测「点了重算，账号管理仍全员未评定」。
      //   且旧代码无条件 done++ → 「成功 N 人」的提示是**假数**（实际 0 人成功）。
      //   → 现在按返回值计数，done 必须等于云端真被写入的人数。
      let okWrite = false
      try {
        okWrite = (typeof Store.reportChallengeLevelFor === 'function')
          ? Store.reportChallengeLevelFor(r.username, lv) === true
          : false
      } catch (e) { okWrite = false }
      if (okWrite) done++
      else skipped++
    })
    alert(t('dashLvRebuildDone', done, skipped))
    // 重新拉数刷新看板（等级列与「已评定」计数随之更新）
    try { await renderDashboard() } catch (e) { /* 刷新失败不影响已写入的数据 */ }
  } finally {
    const b2 = document.getElementById('dashLvRebuildBtn')
    if (b2) { b2.disabled = false; b2.textContent = '🔁 ' + t('dashLvRebuildBtn') }
  }
}
// ====== v163：全站统一的准确率配色（唯一口径） ======
// 产品口径（用户拍板）：>90% 绿 · 80–90% 粉 rgb(237,57,151) · ≤80% 红 rgb(221,61,0)。
// ★ 90 整算「粉」（「90以上」与「90及以下」在 90 处重叠 → 用户明确选「90 算粉」）。
// 配色来源必须**唯一**：当期看板成绩明细 / 累计总览两列准确率 / 每道题正确率表，全部走本函数；
//   任何一处再写死阈值，就会出现「同一个数字两种颜色」。
// ★★ 但**调用点不能直接裸调本函数**：既有套件按源码切片只注入目标函数体，
//    盒外没有 accRateClass 时会 ReferenceError 让整片套件崩（v161/v162 两次教训）。
//    → 各调用点写成 `typeof accRateClass === 'function' ? accRateClass(v) : <同口径内联>`
//      （typeof 对未声明标识符安全返回 'undefined'，不会抛错）
function accRateClass(v) {
  const n = Number(v)
  if (!isFinite(n)) return 'perq-low'   // 无数据/非法值 → 最低档（调用点通常已渲染成「-」）
  if (n > 90) return 'perq-good'        // >90 绿
  if (n > 80) return 'perq-high'        // 81–90 粉 #ED3997
  return 'perq-low'                     // ≤80 红 #DD3D00
}

// ====== v162：七天挑战看板视图切换（营次越铺越多 → 需要一本「总账」）======
// 'round' = 当期看板（原样：营次筛选 + 成绩明细 + 积分榜）
// 'total' = 累计总览（跨**全部营次**累计答题数与准确率，按学员一行）
// 动机（用户原话）：「之后每个部门的七天挑战会越来越多，能否加一个页面看到他所有挑战的
//   累计答题数和准确率」——原来只能一期一期看，跨期总账无处可看。
let dashChView = 'round'
// 视图切换条（渲染在挑战标签顶部，营次管理面板之上）
function dashChViewBarHtml() {
  const cur = (typeof dashChView === 'undefined') ? 'round' : dashChView
  const btn = (v, ico, key, id) => `<button class="btn btn-sm ${cur === v ? 'btn-primary' : 'btn-ghost'}" id="${id}" style="padding:4px 12px;font-size:12px" onclick="dashChSetView('${v}')">${ico} ${t(key)}</button>`
  return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <span style="font-size:12px;color:#6b7280">${t('dashChViewLabel')}：</span>
      ${btn('round', '🏅', 'dashChViewRound', 'dashChViewBtnRound')}
      ${btn('total', '🗂️', 'dashChViewTotal', 'dashChViewBtnTotal')}
    </div>`
}
// 切换视图。累计总览是「总账页」——顺手把营次管理面板收起，避免两个面板抢视线；
// 切回当期看板即恢复（营次管理/开关仍可正常使用）。
function dashChSetView(v) {
  dashChView = (v === 'total') ? 'total' : 'round'
  const rp = document.getElementById('dashRoundsPanel')
  if (rp) rp.style.display = dashChView === 'total' ? 'none' : ''
  // ★ typeof 守卫：既有套件按源码切片注入本函数时**没有** _perQLastRows ——
  //   直接引用会 ReferenceError（v162 自测实撞，v161 同类教训）。
  const rows = (typeof _perQLastRows === 'undefined') ? [] : (_perQLastRows || [])
  renderDashChallengeBlock(rows)
}

// ====== v163：累计总览「可点表头排序 + 全局名次 + 分部门筛选」======
// 需求（用户原话）：「给这个新的排名表出分部门功能 以及 可以按准确率排名」
//   → 后续修正：「排名不要分部门啊 所有人一起排序」
// 拍板：① **所有学员一起排**（不做分部门分组、不做部门列合并单元格）
//       ② 「分部门」= 顶部部门筛选条（切到某部门即只看该部门，名次在该筛选结果内连续）
//       ③ 三个表头都能点（累计答题数 / 首答准确率 / 正确率(含重做)），可升可降
//       ④ 90 整算粉档；配色全站统一（见 accRateClass）
// 规则：**全局**按当前排序键排 → 全表第一行 = 整体最好；名次 = 1..N 连续，与部门无关。
//   ★ 并列时按题量、再按首答题量兜底 → 顺序稳定可复现（不依赖 Array.sort 的稳定性）。
let dashChTotalSort = 'q'   // 'q' | 'accFirst' | 'accAll'
let dashChTotalDir = -1     // -1 降序 / 1 升序
// 点表头：同键 → 升降序取反；换键 → 回到该键的默认方向（降序）
function dashChTotalSetSort(k) {
  const key = (k === 'accFirst' || k === 'accAll') ? k : 'q'
  if (dashChTotalSort === key) dashChTotalDir = (dashChTotalDir === -1) ? 1 : -1
  else { dashChTotalSort = key; dashChTotalDir = -1 }
  const rows = (typeof _perQLastRows === 'undefined') ? [] : (_perQLastRows || [])
  renderDashChallengeBlock(rows)
}
// 全局排序（v163：所有人一起排，与部门无关）→ 返回已排好的扁平数组
// ★ 与 dashChTotalGroups 同一套取值/比较口径：accFirst/accAll 缺失记为 -1（排最后），
//   并列时按题量、再按首答题量兜底，保证顺序稳定可复现。
function dashChTotalSortList(list, key, dir) {
  const kk = (key === 'accFirst' || key === 'accAll') ? key : 'q'
  const dd = (dir === 1) ? 1 : -1
  const val = p => kk === 'accFirst' ? (p.accFirst == null ? -1 : p.accFirst)
    : kk === 'accAll' ? (p.accAll == null ? -1 : p.accAll)
      : (Number(p.q) || 0)
  const cmp = (a, b) => ((val(a) - val(b)) * dd) || (b.q - a.q) || (b.fQ - a.fQ)
  return (list || []).slice().sort(cmp)
}
// 分组 + 组内排序 → 返回 [{deptLabel, items:[...]}]（items 已按当前键排好，[0] = 组内第一）
// ★ v163 终版：累计总览已改为「所有人一起排」，本函数暂不再被渲染调用；
//   刻意保留（同名同签名），因为 test-v163 的切片沙箱按名注入它做组间/组内断言，
//   删掉会让既有套件整片 ReferenceError。后续若确实没有使用场景再单独清理。
function dashChTotalGroups(list, key, dir) {
  const kk = (key === 'accFirst' || key === 'accAll') ? key : 'q'
  const dd = (dir === 1) ? 1 : -1
  const val = p => kk === 'accFirst' ? (p.accFirst == null ? -1 : p.accFirst)
    : kk === 'accAll' ? (p.accAll == null ? -1 : p.accAll)
      : (Number(p.q) || 0)
  // 并列时按题量（与 v162 默认口径一致），保证顺序稳定可复现
  const cmp = (a, b) => ((val(a) - val(b)) * dd) || (b.q - a.q) || (b.fQ - a.fQ)
  const groups = []
  const gmap = {}
  ;(list || []).forEach(p => {
    const hit = (typeof normDept === 'function') ? normDept(p && p.dept) : null
    const k = hit ? hit.key : ('zz|' + String((p && p.dept) || ''))
    if (!gmap[k]) { gmap[k] = { key: k, hit: hit, raw: String((p && p.dept) || ''), items: [] }; groups.push(gmap[k]) }
    gmap[k].items.push(p)
  })
  groups.forEach(g => g.items.sort(cmp))
  // 组间：按「组内第一名」的排序值 —— 降序时最强的组在最前，升序时最弱的组在最前（方向一致）
  groups.sort((a, b) => {
    const x = a.items[0], y = b.items[0]
    if (!x && !y) return 0
    if (!x) return 1
    if (!y) return -1
    return cmp(x, y)
  })
  // 组标签：归一化成功 → 分部门短名；否则回落原始字符串
  groups.forEach(g => {
    g.label = g.hit ? (g.hit.subName || g.raw) : (g.raw || '—')
  })
  return groups
}

// ====== 管理员看板：重置某学员的挑战考试成绩（v83 引入，v84 收窄口径，v85 修按钮接线） ======
// 二次确认后调 CloudSync.setChallengeReset：① 云端过滤掉该学员 chy 中 kind==='test' 的记录
//（Day1 摸底 / Day7 期末考试成绩清零，看板两列成绩与积分中的考试部分同步归零）
// ② doc.chResets[用户名] 时间戳 + chResetModes[用户名]='exam' → 该学员端下次打开挑战页只清本地测试阶段记录
//（可重新参加考试），练习进度 / 每日打卡 / 挑战错题 / 练习积分全部保留。
// 题库级统计（每题正确率 __q）与普通练习记录 perQ 不受影响。
//
// ⚠️ v85 修复（v83/v84 按钮点了完全没反应）：按钮原来把参数写进内联属性，属性值本身用双引号
//   包裹，而运行时 JSON.stringify 产出的字符串也自带双引号 → 渲染出的属性在第一个 " 处被
//   HTML 解析器截断，onclick 实际只剩函数名加一个左括号 → 点击即 SyntaxError，静默失败
//   （所以线上云端文档里连 chResets 字段都没写入）。凡是内联属性里塞带引号的字符串都会中招。
//   现改为 data-u / data-n 承载用户名与姓名（escAttr 转义），onclick 只传 this 与行索引。
//   兼容旧签名直调：dashResetChUser('alice', 'Alice', 0)。
async function dashResetChUser(btnOrUser, nameOrIdx, legacyIdx) {
  const fromBtn = !!(btnOrUser && typeof btnOrUser === 'object' && btnOrUser.dataset)
  const username = fromBtn ? (btnOrUser.dataset.u || '') : String(btnOrUser || '')
  const name = fromBtn ? (btnOrUser.dataset.n || '') : String(typeof nameOrIdx === 'string' ? nameOrIdx : '')
  const btn = fromBtn ? btnOrUser : document.getElementById('dashChResetBtn_' + (legacyIdx != null ? legacyIdx : nameOrIdx))
  if (!username) return
  const label = name && name !== username ? `${name}（${username}）` : username
  if (!confirm(t('dashChResetConfirm', label))) return
  if (btn) { btn.disabled = true; btn.textContent = t('dashChResetWorking') }
  try {
    const res = await CloudSync.setChallengeReset(username, name)
    if (res && res.ok) {
      alert(t('dashChResetOk', label))
      dashRoundView = ''   // v88：重置只作用于当前营次 → 统计视图回到当前营次，避免看到未刷新的其它期
      renderDashboard()   // 重新拉取云端聚合（setChallengeReset 内已刷新缓存）→ 两列成绩与积分中的考试部分归零
    } else {
      alert(t('dashChResetFail'))
      if (btn) { btn.disabled = false; btn.textContent = t('dashChResetBtn') }
    }
  } catch (e) {
    alert(t('dashChResetFail'))
    if (btn) { btn.disabled = false; btn.textContent = t('dashChResetBtn') }
  }
}

// ====== 管理员看板：手动补录挑战考试成绩（v105 引入） ======
// 用途：营次在学员页面打开之后才创建时（v104 修的 bug），学员端被总闸拦下 → 云端零上报，
//   但界面上进度与成绩照常显示，学员与管理员两边对不上。让学员重考是首选；
//   学员已离场/不便重考时，用这里手动补录。
//
// ⚠️ 一律沿用 v85 的传参模式：参数走 data-* 属性（escAttr 转义），onclick 只传 this,
//    绝不把用户名/姓名拼进内联 onclick —— 名字里一个引号就能让属性被 HTML 解析器截断，
//    按钮会静默失效（v83/v84 就是这么坏的）。
//
// 补录的口径：
//   · Day 可选 1（摸底，固定 20 题）或 7（期末，固定 20 题）
//   · 只录入「答对数」，正确率与积分按现有规则由云端聚合计算（与真实考试同口径）
//   · usedSec 用于积分中的用时扣减，补录时默认给 0 秒（等于不扣），可手动填
//   · overwrite 勾选时推 chyfix 覆写已有成绩（录错了再改），否则新增一条
function dashManualScoreOpen(usernames, name) {
  const list = (Array.isArray(usernames) ? usernames : [usernames]).map(x => String(x || '')).filter(Boolean)
  if (!list.length) return
  const label = list.length === 1
    ? ((name && name !== list[0]) ? `${name}（${list[0]}）` : list[0])
    : t('dashChManualMultiLabel', list.length)
  const old = document.getElementById('dashChManualModal')
  if (old) old.remove()
  const box = document.createElement('div')
  box.id = 'dashChManualModal'
  box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:16px'
  box.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:420px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.2)">
      <h3 style="margin:0 0 4px;font-size:16px">✍️ ${t('dashChManualTitle')}</h3>
      <p style="margin:0 0 14px;font-size:13px;color:#6b7280">${escHtml(label)}</p>
      <div style="display:flex;flex-direction:column;gap:12px">
        <label style="font-size:13px">${t('dashChManualDay')}
          <select id="dashChManualDay" style="width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:8px">
            ${dashChDayCount() === 21
              ? `<option value="21">${t('dashChManualDay21')}</option><option value="1">${t('dashChManualDay1')}</option>`
              : `<option value="7">${t('dashChManualDay7')}</option><option value="1">${t('dashChManualDay1')}</option>`}
          </select>
        </label>
        <label style="font-size:13px">${t('dashChManualCorrect')}
          <input id="dashChManualCorrect" type="number" min="0" max="${dashChDayCount() === 21 ? 30 : 20}" value="${dashChDayCount() === 21 ? 30 : 20}"
            style="width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:8px">
        </label>
        <label style="font-size:13px">${t('dashChManualSec')}
          <input id="dashChManualSec" type="number" min="0" value="0"
            style="width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:8px">
        </label>
        <label style="font-size:13px;display:flex;align-items:center;gap:8px">
          <input id="dashChManualOverwrite" type="checkbox" style="width:16px;height:16px">
          <span>${t('dashChManualOverwrite')}</span>
        </label>
      </div>
      <p style="margin:12px 0 0;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px">${t('dashChManualWarn')}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-ghost" onclick="dashManualScoreClose()">${t('dashChManualCancel')}</button>
        <button class="btn btn-primary" id="dashChManualOk" data-u="${escAttr(list.join(','))}">${t('dashChManualSubmit')}</button>
      </div>
    </div>`
  document.body.appendChild(box)
  const ok = document.getElementById('dashChManualOk')
  if (ok) ok.onclick = () => dashManualScoreSubmit(ok)
}
function dashManualScoreClose() {
  const el = document.getElementById('dashChManualModal')
  if (el) el.remove()
}
// 表内按钮入口：参数一律走 data-*（v85 教训，绝不用内联引号拼用户名）
function dashManualScoreFromBtn(btn) {
  if (!btn || !btn.dataset) return
  const u = btn.dataset.u || ''
  const n = btn.dataset.n || ''
  if (u) dashManualScoreOpen([u], n)
}
async function dashManualScoreSubmit(btn) {
  const usernames = String((btn && btn.dataset && btn.dataset.u) || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!usernames.length) return
  const day = Number((document.getElementById('dashChManualDay') || {}).value) || 7
  // v196：考试题量按营次结构取（21 天营次考试 30 题，其余 20 题）；
  //   阶段号 si：旧结构 Day7 的 test 在 si=1（前面还有练习），v2/v3 每天单阶段恒 si=0。
  const total = dashChDayCount() === 21 ? 30 : 20
  const siOf = d => (dashChDayCount() === 21) ? 0 : (Number(d) === 7 ? 1 : 0)
  let correct = Number((document.getElementById('dashChManualCorrect') || {}).value)
  if (!isFinite(correct)) correct = total
  correct = Math.max(0, Math.min(total, Math.round(correct)))
  const usedSec = Math.max(0, Math.round(Number((document.getElementById('dashChManualSec') || {}).value) || 0))
  const overwrite = !!((document.getElementById('dashChManualOverwrite') || {}).checked)
  if (overwrite && !confirm(t('dashChManualOverwriteConfirm'))) return
  if (btn) { btn.disabled = true; btn.textContent = t('dashChManualWorking') }
  try {
    const res = await CloudSync.setChallengeManualScore(usernames, {
      day, si: siOf(day), kind: 'test', correct, total, usedSec, overwrite,
    })
    if (res && res.ok) {
      dashManualScoreClose()
      alert(t('dashChManualOk', res.count, correct, total))
      renderDashboard()
    } else {
      alert(t('dashChManualFail'))
      if (btn) { btn.disabled = false; btn.textContent = t('dashChManualSubmit') }
    }
  } catch (e) {
    alert(t('dashChManualFail'))
    if (btn) { btn.disabled = false; btn.textContent = t('dashChManualSubmit') }
  }
}
// 批量补录：把当前表格里所有「进度已到 Day7 但 D7 无成绩」的学员一次性纳入弹窗
function dashManualScoreBatch() {
  const lack = (_chDashRows || []).filter(p => p.s7 == null && p.maxDay >= 7).map(p => p.username)
  if (!lack.length) { alert(t('dashChManualBatchEmpty')); return }
  if (!confirm(t('dashChManualBatchConfirm', lack.length))) return
  dashManualScoreOpen(lack, '')
}

// ====== 管理员看板：核对成绩（v108 引入，bug5 的第三道保险）======
// 场景：学员交了卷、界面也显示成绩，但云端没收到（早先的 bug、断网、云端写冲突都可能）。
//   数据层修好后这种事故已经很难发生，但「再也不会」需要一道可核对的兜底 ——
//   就是这里：以**本机成绩底账**（CloudSync._ledger，本地不可删）为线索，
//   和云端 base + events 逐条比对，缺哪条补哪条。
// 口径：
//   · 底账是「本机」的 → 只能补出这台设备上产生/处理过的成绩，看板上已如实标注
//   · 判重按 学员 + 营次 + day + si + kind（与云端 chy 记录同口径）
//   · 补录用 chy 事件（幂等 id 'rec_<学员>_<营次>_<day>_<si>_<kind>'）→ 重复点击不会造重复成绩
//   · 补录出的记录带 recovered:true，界面沿用「手动录入」标记，便于事后区分
let _dashReconcileLast = null
async function dashReconcileScores(btn) {
  if (btn) { btn.disabled = true; btn.textContent = t('dashChReconcileWorking') }
  let res
  try {
    res = await CloudSync.reconcileScores()
  } catch (e) {
    res = { ok: false, reason: 'network' }
  }
  if (btn) { btn.disabled = false; btn.textContent = t('dashChReconcileBtn') }
  if (!res || !res.ok) { alert(t('dashChReconcileFail')); return }
  _dashReconcileLast = res
  if (!res.checked) { alert(t('dashChReconcileNone')); return }
  if (!res.missing.length) { alert(t('dashChReconcileOk', res.checked)); return }
  dashReconcileResultOpen(res)
}
function dashReconcileResultOpen(res) {
  const old = document.getElementById('dashReconcileModal')
  if (old) old.remove()
  const list = res.missing.slice(0, 60)
  // 环节名：test 且 day=7 → 期末；test 且 day=1 → 摸底；其余为每日练习
  const stageLabel = m => (m.kind === 'test' ? (Number(m.day) === (dashChDayCount() === 21 ? 21 : 7) ? t(dashChDayCount() === 21 ? 'dashChManualDay21' : 'dashChManualDay7') : t('dashChManualDay1')) : t('dashChReconcilePractice'))
  const box = document.createElement('div')
  box.id = 'dashReconcileModal'
  box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:16px'
  box.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:640px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.2);max-height:86vh;display:flex;flex-direction:column">
      <h3 style="margin:0 0 4px;font-size:16px">🧮 ${t('dashChReconcileTitle')}</h3>
      <p style="margin:0 0 10px;font-size:13px;color:#6b7280">${t('dashChReconcileMissing', res.checked, res.missing.length)} ${t('dashChReconcileLocalOnly')}</p>
      <div style="overflow:auto;border:1px solid #e5e7eb;border-radius:8px">
        <table class="admin-table" style="font-size:12px;width:100%">
          <thead><tr>
            <th>${t('thUsername')}</th><th>${t('thName')}</th>
            <th>${t('dashChThProgress')}</th>
            <th style="text-align:center">${t('dashChThCorrect')}</th>
          </tr></thead>
          <tbody>
            ${list.map(m => `<tr>
              <td>${escHtml(m.u)}</td>
              <td>${escHtml(m.n || '—')}</td>
              <td style="white-space:nowrap">D${m.day} · ${stageLabel(m)} · ${m.kind === 'test' ? t('dashChReconcileExam') : t('dashChReconcilePractice')}</td>
              <td style="text-align:center">${m.correct}/${m.total}</td>
            </tr>`).join('')}
            ${res.missing.length > list.length ? `<tr><td colspan="4" style="text-align:center;color:#9ca3af">…</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      <p style="margin:10px 0 0;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px">${t('dashChManualWarn')}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-ghost" onclick="dashReconcileClose()">${t('dashChManualCancel')}</button>
        <button class="btn btn-primary" id="dashReconcileOk">${t('dashChReconcileFix', res.missing.length)}</button>
      </div>
    </div>`
  document.body.appendChild(box)
  const ok = document.getElementById('dashReconcileOk')
  if (ok) ok.onclick = () => dashReconcilePush(ok)
}
function dashReconcileClose() {
  const el = document.getElementById('dashReconcileModal')
  if (el) el.remove()
}
async function dashReconcilePush(btn) {
  const res = _dashReconcileLast
  if (!res || !res.missing || !res.missing.length) { dashReconcileClose(); return }
  if (!confirm(t('dashChReconcileConfirm', res.missing.length))) return
  if (btn) { btn.disabled = true; btn.textContent = t('dashChReconcileFixing') }
  let out
  try { out = await CloudSync.reconcilePushScores(res.missing) } catch (e) { out = { ok: false } }
  if (!out || !out.ok) { alert(t('dashChReconcileFail')); if (btn) { btn.disabled = false; btn.textContent = t('dashChReconcileFix', res.missing.length) } return }
  dashReconcileClose()
  alert(t('dashChReconcileFixed', out.pushed))
  _dashReconcileLast = null
  renderDashboard()
}

// ====== 管理员看板：期末考试开关（v76；v107 改为按营次） ======
// 七天挑战第 7 天期末考试为手动开放：存云端对应营次的 examOpen（cloud-store setChallengeExamOpen），
// 学员端经 _getDoc 侧信道读取；零参与时也要显示（管理员可提前开考）。
// v107：按钮改为按期渲染，点击时带该期 roundId 精确落刀。
// v118：渲染位置由独立开关卡片改为**营次管理表**的「考试」列（见 dashChExamCellHtml）。
async function dashToggleChExam(btn) {
  const rid = (btn && btn.dataset && btn.dataset.rid) || ''
  const rec = dashRoundList().find(r => r.id === rid)
  if (!rec) { alert(t('dashChExamFail')); return }
  const next = rec.examOpen !== true
  if (btn) btn.disabled = true
  try {
    const res = await CloudSync.setChallengeExamOpen({ open: next, roundId: rid })
    if (res && res.ok) {
      rec.examOpen = next
      // v107：只有当改的是「本端当前期」时才动侧信道，避免学员端读到别的期次的开关
      if (rid === dashRoundCurId()) CloudSync._chExamOpen = next
      dashRefreshRoundsPanel()   // v118：就地重绘营次表（徽章 + 按钮文案）
    } else {
      alert(t('dashChExamFail'))
      if (btn) btn.disabled = false
    }
  } catch (e) {
    alert(t('dashChExamFail'))
    if (btn) btn.disabled = false
  }
}

// ====== 管理员看板：七天挑战统计（v71） ======
// 数据来源：chy 事件（阶段完成：参与名单 / 进度 / 每阶段分数 / Day1-Day7 测试分）
//          + perq 的 ch 标记（chQ[qid] = { correct:0, total:错次 }，错题排行）
// ====== v139：三段分组口径（看板与导出共用，保证「所见即所得」）======
// 参照线下报表《七天挑战成绩》把学员按「前测/后测齐全度」分三段：
//   完全有效组(Fully Valid)      前测 + 后测都有成绩
//   单边缺失组(Partial Missing)  只有其中之一
//   无效/未参与组(Invalid/Non-participant)  两个都没有，或答题数低于门槛
// ⚠️ DASH_CH_MIN_Q 是「事实性」配置，不是随便取的：原表里答 20 题的 Iris Zhang 被归入
//    无效组，而答 30 题的 Star Zhang 留在单边缺失组 → 门槛落在 (20, 30]，取 30
//    （30 = 完整做完 Day1 一天的量：摸底测试 20 题 + 练习 10 题）。要调只改这一个数。
const DASH_CH_MIN_Q = 30
const DASH_CH_GROUPS = ['full', 'partial', 'invalid']
// D1–D7：1 = 当日全部阶段完成，-1 = 未完成全部阶段。
// ⚠️ 原表只有 1 / -1 两态（不是看板的三态 ✅/◐/—）：证据是原表 Star Zhang 答 30 题
//    = Day1 的「测试 20 + 练习 10」，且 D1=1、D2–D7 全为 -1 —— 说明「整日全部完成」才算 1。
function dashChDayMark(p, d) {
  const ck = (p && p.checkin) || []
  return ck[d - 1] === 2 ? 1 : -1
}
// v196：当前查看的营次天数（'v3' = 21，其余 = 7）。导出 Excel / 补录弹窗共用同一口径，
//   与成绩矩阵的 chN 同源（都从 dashRoundView 指向的营次记录取 chPlan）。
function dashChDayCount() {
  const want = String(dashRoundView || dashRoundCurId() || '')
  const list = dashRoundList()
  const rec = list.find(r => String(r && r.id) === want) ||
              list.find(r => String(r && r.id) === String(dashRoundCurId() || ''))
  return (rec && rec.chPlan === 'v3') ? 21 : 7
}
function dashChGroupKey(p) {  // ⚠️ 判据次序要紧：门槛先判，再判成绩齐全度。
  //    「答题数够、但两场测试分都没有」是真实存在的形态——管理员用「重置考试成绩」
  //    （v84 的 exam 模式只删两场水平测试的阶段记录）之后就是这样：练习进度 q 还在，
  //    分数没了。这种人绝不能归进「无效/未参与组」（他就是参与了，只是成绩被清了），
  //    所以「两侧都缺」与「缺一侧」同归「单边缺失组」= 成绩不成对。
  const q = Number((p && p.q) || 0)
  if (q < DASH_CH_MIN_Q) return 'invalid'
  const has1 = !!(p && p.s1 != null), has7 = !!(p && p.s7 != null)
  return (has1 && has7) ? 'full' : 'partial'
}
function dashChGroupLabel(key) {
  return key === 'full' ? t('dashChGrpFull') : key === 'partial' ? t('dashChGrpPartial') : t('dashChGrpInvalid')
}
// 提分 = 后测 − 前测；任一侧缺考 → '-'（半角连字符，与原表一致，不是 0）
function dashChScoreChange(p) {
  const a = (p && p.s1), b = (p && p.s7)
  if (a == null || b == null) return '-'
  return b - a
}
// 三段分组：保留原数组顺序，组内按答题数降序（与原表一致）
function dashChScoreBlocks(list) {
  const rows0 = Array.isArray(list) ? list.filter(Boolean) : []
  return DASH_CH_GROUPS.map(k => ({
    key: k,
    label: dashChGroupLabel(k),
    rows: rows0.filter(p => dashChGroupKey(p) === k).slice().sort((a, b) => (Number(b.q) || 0) - (Number(a.q) || 0))
  }))
}
// 明细表列宽（px → 写入器换算成字符宽）；顺序与 dashChExportHeader 一一对应
// v196：前 9 列固定，后 chN 列（D1–D7 或 D1–D21）按 60px 追加 —— 列宽随营次结构动态生成
const DASH_CH_COL_PX_BASE = [179, 151, 120, 147, 147, 100, 100, 111]
function dashChColPx() {
  return DASH_CH_COL_PX_BASE.concat(new Array(dashChDayCount()).fill(60))
}
// 明细表列标题。⚠️ 英文值刻意与原表逐字一致（Department / Questions Answered / Accuracy Rate /
//    Pre-test / Final Test / Score Change）——先把站点切到 EN 再导出，得到的表头就和原文件一模一样。
// v196：D 列按营次天数动态（D1–D7 / D1–D21）。
function dashChExportHeader() {
  const N = dashChDayCount()
  return [t('dashChColDept'), t('dashChColName'), t('dashChColUser'), t('dashChColQ'), t('dashChColAcc'),
    t('dashChColPre'), t('dashChColFinal'), t('dashChColChange')]
    .concat(Array.from({ length: N }, (_, i) => 'D' + (i + 1)))
}

// v116：七天挑战成绩导出（Excel，双 sheet：成绩明细 + 积分榜）。
// 数据口径与看板完全一致：直接吃 renderDashChallengeBlock 算好的 _chDashRows
//（已是当前部门 + 营次筛选结果）——「所见即所得」，看板上是什么就导出什么。
// v139：成绩明细按参考文件改成「三段纵向堆叠」——分组横幅（整行合并）+ 列标题 + 数据行
//        + Average 汇总行，并还原版式：部门列纵向合并、表头灰底 #747373、外框加粗内框细、
//        数字格式（前测/后测一位小数、提分两位小数、正确率百分比）、提分写成公式。
function dashChExportSheets(list) {
  const rows0 = Array.isArray(list) ? list : []
  const cols = dashChColPx()
  const nCol = cols.length
  const lastCol = xlsxColRef(nCol - 1)
  const rows = [], merges = []
  const HDR = dashChExportHeader()
  // 单元格样式工厂：边线按「外框 medium / 内框 thin」算，与原文件一致
  const edge = (c, i, n) => ({
    align: 'center',
    bl: c === 0 ? 'medium' : 'thin',
    br: c === nCol - 1 ? 'medium' : 'thin',
    bt: 'thin',
    bb: i === n - 1 ? 'medium' : 'thin',
  })
  const head = v => ({ v, s: { fill: '747373', align: 'center', valign: 'center', bl: 'thin', br: 'thin', bt: 'medium', bb: 'thin' } })
  const num = (v, s, fmt, color) => {
    const st = Object.assign({}, s)
    if (fmt) st.fmt = fmt
    if (color) st.color = color
    return { v, s: st }
  }
  dashChScoreBlocks(rows0).forEach(b => {
    const n = b.rows.length
    // ---- 分组横幅（整行合并；左右两端补上空单元格，合并区的边框才有来源）----
    const bannerAt = rows.length + 1
    const banner = new Array(nCol).fill(null)
    banner[0] = { v: b.label, s: { align: 'left', valign: 'center', bl: 'medium', bt: 'thin', bb: 'thin' } }
    banner.forEach((_, ci) => { if (ci && ci < nCol - 1) banner[ci] = { v: null, s: { bt: 'thin', bb: 'thin' } } })
    banner[nCol - 1] = { v: null, s: { br: 'medium', bt: 'thin', bb: 'thin' } }
    rows.push(banner)
    merges.push('A' + bannerAt + ':' + lastCol + bannerAt)
    // ---- 列标题 ----
    rows.push(HDR.map(h => head(h)))
    // ---- 数据行（部门列纵向合并：连续同部门合成一段）----
    const start = rows.length + 1
    const runs = []
    b.rows.forEach((p, i) => {
      const d = String(p.dept || '')
      const tail = runs[runs.length - 1]
      if (tail && tail.dept === d) tail.to = i
      else runs.push({ dept: d, from: i, to: i })
    })
    b.rows.forEach((p, i) => {
      const E = c => edge(c, i, n)
      const row = new Array(nCol).fill(null)
      const run = runs.filter(r => r.from === i)[0]
      // 合并段内除首行外留空；但空单元格仍要带样式，否则合并区的边线会缺一截
      row[0] = num(run ? (p.dept || '') : null, E(0))
      row[1] = num(p.name || '', E(1))
      row[2] = num(p.username || '', E(2))
      row[3] = num(Number(p.q) || 0, E(3), '0')
      const hasQ = (Number(p.q) || 0) > 0
      row[4] = hasQ ? num((Number(p.acc) || 0) / 100, E(4), '0%') : num('-', E(4))
      row[5] = p.s1 == null ? num('-', E(5)) : num(p.s1, E(5), '0.0', p.m1 ? 'FF0000' : null)
      row[6] = p.s7 == null ? num('-', E(6)) : num(p.s7, E(6), '0.0', p.m7 ? 'FF0000' : null)
      const chg = dashChScoreChange(p)
      const rn = start + i
      row[7] = (chg === '-')
        ? num('-', E(7))
        : { v: chg, f: xlsxColRef(6) + rn + '-' + xlsxColRef(5) + rn, s: Object.assign({}, E(7), { fmt: '0.0' }) }
      for (let d = 1; d <= dashChDayCount(); d++) row[7 + d] = num(dashChDayMark(p, d), E(7 + d))
      rows.push(row)
    })
    runs.forEach(rr => { if (rr.to > rr.from) merges.push('A' + (start + rr.from) + ':A' + (start + rr.to)) })
    // ---- Average 汇总行（原表只在「完全有效组」末尾有；有数据时才出；原表拼写 Avearge 已按用户拍板改正）----
    if (b.key === 'full' && n > 0) {
      const at = rows.length + 1
      const arow = new Array(nCol).fill(null)
      arow[0] = { v: t('dashChAvgLabel'), s: { align: 'center', valign: 'center', bl: 'medium', bt: 'thin', bb: 'medium' } }
      for (let ci = 1; ci < nCol; ci++) {
        arow[ci] = { v: null, s: { bl: 'thin', br: ci === nCol - 1 ? 'medium' : 'thin', bt: 'thin', bb: 'medium' } }
      }
      ;[5, 6, 7].forEach(ci => {
        const L = xlsxColRef(ci)
        const vals = b.rows.map(p => (ci === 5 ? p.s1 : ci === 6 ? p.s7 : dashChScoreChange(p)))
          .filter(v => typeof v === 'number')
        if (!vals.length) return
        const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100) / 100
        arow[ci] = {
          v: avg, f: 'AVERAGE(' + L + start + ':' + L + (start + n - 1) + ')',
          s: { align: 'center', fmt: '0.00', bl: 'thin', br: 'thin', bt: 'thin', bb: 'medium' },
        }
      })
      rows.push(arow)
      merges.push('A' + at + ':C' + at)
    }
  })
  // 积分榜口径与看板一致：管理员不参加排名；同分用时短者在前，再比答对数（v73/v78）；积分含首答准确率乘数（v160）
  // v196b：本期零首答记录的人不入导出积分榜（与看板积分榜 / 学员端 chLbAggregate 同口径）
  const lb = rows0.filter(p => p.role !== 'admin' && (p.lbStages || 0) > 0).slice()
    .sort((a, b) => (b.lbScore - a.lbScore) || (a.lbT - b.lbT) || (b.lbC - a.lbC))
  const rankRows = [[
    t('dashChThRank'), t('thUsername'), t('thName'), t('thDept'),
    t('dashChThScore'), t('dashChThCorrect'), t('dashChThFirstAcc'), t('dashChThUseSec')
  ]]
  lb.forEach((p, i) => {
    rankRows.push([i + 1, p.username || '', p.name || '', p.dept || '',
      p.lbScore || 0, p.lbC || 0,
      // v160：首答准确率（0~1，Excel 里按百分比显示）—— 积分乘的就是这一列，导出也要看得见
      { v: (p.lbQ > 0 ? Math.min(1, (p.lbC || 0) / p.lbQ) : 1), s: { align: 'center', fmt: '0%' } },
      p.lbT || 0])
  })
  return [
    { name: t('dashChSheetDetail'), rows: rows, merges: merges, cols: cols },
    { name: t('dashChSheetRank'), rows: rankRows }
  ]
}
function dashChExportScores() {
  const list = _chDashRows || []
  if (!list.length) { alert(t('dashChExportEmpty')); return }
  if (typeof impXlsxFromSheets !== 'function' || typeof impDownloadBlob !== 'function') {
    alert(t('dashChExportNoXlsx')); return
  }
  const bytes = impXlsxFromSheets(dashChExportSheets(list))
  if (!bytes) { alert(t('dashChExportNoXlsx')); return }
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const fname = t('dashChExportFile') + '_' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.xlsx'
  impDownloadBlob(bytes, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}
// v78 积分权重：第七天期末考试（day 7 的 test）答对每题 3 倍，其余 1 倍；管理员不参加排名。
function dashChStageWeight(day, kind) {
  if (typeof chLbStageWeight === 'function') return chLbStageWeight(day, kind)   // 优先复用 challenge.js 同口径实现
  return (Number(day) === 7 && kind === 'test') ? 3 : 1
}
// v94：营次是否「属于」管理员所选部门（看板营次筛选用）。
// ⚠️ 不要复用 cloud-store 的 roundDeptMatch —— 那是**学员方向**（给定学员的 slug，判断某营次是否适用他）：
//   roundDeptMatch(r, 'dining') 在 r.depts=['dining/sig'] 时返回 false，
//   因为 r.depts 里没有字面量 'dining'。而管理员看板的语义是**筛选方向**：
//   选了「饮食部」应当看到所有饮食部子部门的营次。两者方向相反，必须分开实现。
// 规则：sel 为空 / 'all' → 全通过；营次未限定部门（depts 空）→ 全通过；
//       营次 depts 含 sel → 通过；sel 是大部门 → 其任一子部门 slug 命中即通过；
//       sel 是分部门 → 要求 depts 精确含该 slug（或含其大部门）。
function dashRoundUnderDept(r, sel) {
  const k = String(sel == null ? '' : sel)
  if (!k || k === 'all') return true
  const list = (r && Array.isArray(r.depts)) ? r.depts.filter(x => x) : []
  if (!list.length) return true                    // 未限定部门 → 全部部门适用
  if (list.indexOf(k) >= 0) return true
  const major = k.split('/')[0]
  const isSub = k.indexOf('/') >= 0
  if (!isSub) {
    // sel 是大部门（'dining'）→ 营次挂在任一子部门也算属于它
    const hasSub = typeof DEPT_SUB_SLUGS !== 'undefined' && DEPT_SUB_SLUGS[major]
    if (hasSub) {
      const subs = Object.keys(DEPT_SUB_SLUGS[major]).map(s => major + '/' + DEPT_SUB_SLUGS[major][s])
      if (list.some(d => subs.indexOf(d) >= 0)) return true
    }
  } else {
    // ⚠️ sel 是分部门（'dining/sig'）→ 只比本 slug，**绝不能**展开同门兄弟
    //    （否则选标帜餐厅会把艳中/酒吧的营次也列出来——正是 v94 要修的 bug）。
    //    仅当营次挂的是其大部门整包时才算属于它。
    if (list.indexOf(major) >= 0) return true
  }
  return false
}
function renderDashChallengeBlock(rows) {
  // ★ v189：姓名链接的沙箱守卫（同上，见 renderDashboard 开头注释）
  const _nameLink = (typeof upNameLink === 'function') ? upNameLink : ((_u, _x) => escHtml(_x || '—'))
  const el = document.getElementById('dashChallengeBlock')
  if (!el) return
  // v162：累计总览视图 → 交给独立渲染函数（跨**全部营次**的总账，不再按营次筛选）。
  //   ★ 必须用 typeof 守卫：既有套件（test-v71/v74/v78/v139/v160/v161 …）按源码切片只注入
  //     本函数，沙箱里既没有 dashChView 也没有 renderDashChTotalBlock —— 直接引用会
  //     ReferenceError 让整片套件崩（v161 血泪同款）。切片沙箱里 typeof 恒为 undefined → 走原路径。
  const _chView = (typeof dashChView === 'undefined') ? 'round' : dashChView
  if (_chView === 'total' && typeof renderDashChTotalBlock === 'function') return renderDashChTotalBlock(rows)
  // v94：营次列表必须按所选部门过滤——选了「标帜餐厅」就不该再看到「艳中餐厅第一期」。
  // 用 dashRoundUnderDept（筛选方向，见该函数注释），不要用学员方向的 roundDeptMatch。
  const rdAll = dashRoundList()
  // 「全部」时不缩减；选定部门时只留属于该部门的营次（depts 为空 = 全部部门适用，仍保留）
  const rdList = rdAll.filter(r => dashRoundUnderDept(r, dashChDept))
  // v94：原 want 可能指向被筛掉的营次（如选标帜餐厅却停在「艳中餐厅第一期」）→ 回落到本部门当前营次
  const wantRaw = dashRoundView || dashRoundCurId()
  const want = (dashChDept === 'all' || rdList.some(r => r.id === wantRaw))
    ? wantRaw
    : ((rdList.length ? rdList[rdList.length - 1].id : '') || wantRaw)
  const wantSlug = dashRoundSlug(want)
  // 记录营次归一：'' / 'r1' / undefined 均视同第一期（v87 及更早的记录不带 rd 字段）
  const recSlug = x => dashRoundSlug((x && x.rd) || '')
  // ★v184：营次归属的「唯一真相」= 该学员在本部门**跑过**哪些营次（见下方口径注释）。
  //   这里把「属于本营次的记录」收成一个函数，成绩查找与打卡查找都调它，
  //   避免两处各写一套过滤条件导致口径分叉（v183 教训：同文件两套 done 判定互不一致）。
  const chyOfSlug = (r, slug) => (r && Array.isArray(r.chy) ? r.chy.filter(x => recSlug(x) === slug) : [])
  // ★ 保留 `x => recSlug(x) === wantSlug` 这一字面写法：test-v88-rounds 以源码模式校验
  //   「看板按营次筛选 chy」这一行为，改成只调 chyOfSlug 会让该断言失去锚点。
  const chyOf = r => (r && r.chy ? r.chy.filter(x => recSlug(x) === wantSlug) : [])
  // ★★★v185（线上实测：切到「艳中第二期」后，9 个学员全都显示第一期成绩）
  //   v184 曾用 chyAnyOf「本营次为空 → 回落到同部门最近营次」，后果是**把上一期的成绩
  //   当成这一期的成绩展示**，制造了比原缺陷更严重的问题：管理员看到的是编造的数据。
  //   真实数据（10-19 快照）：r6 第二期只有 2 人 3 条记录（何旭艳 2、杨宇航 1，均为当日写入），
  //   而 r2 第一期有 89 条 → 回落把 7 个只在第一期参与过的人「搬」进了第二期。
  //   ★ 结论（红线）：**成绩、打卡、题量、正确率、积分、导出、汇总，全部只用本营次记录**，
  //     绝不跨期取数。上一期只允许以「灰色 + 上标」的方式出现在单元格里作参照，
  //     且必须带 tooltip 说明「不计入本期统计」。
  //   ★ 为什么要参照而不是干脆不显示：学员本期没做前测（本机进度未清零，见 §0·补），
  //     管理员需要知道他上期考了多少分才能判断水平；但绝不能让他误以为这是本期成绩。
  //   ★ 术语澄清：那位学员「前测没有成绩」不是同步失败 —— 第二期他确实没做前测。
  const _rdObj = (rdList.find(r => r.id === want) || dashRoundList().find(r => r.id === want) || {})
  const wantDepts = (Array.isArray(_rdObj.depts) ? _rdObj.depts.filter(Boolean) : []).map(String)
  const _deptOfUser = r => {
    const hit = (typeof normDept === 'function') ? normDept(r && r.dept) : null
    if (!hit) return { key: '', majorKey: '' }
    // hit.key 就是分部门 slug（'dining/yan'）；majorKey 是大部门（'dining'）。
    // 营次 depts 里两种写法都可能出现（v89 起两种都允许），所以两个都拿去比。
    return { key: String(hit.key || ''), majorKey: String(hit.majorKey || '') }
  }
  const _roundInSameDept = (r, slug) => {
    if (!wantDepts.length) return true            // 本营次「全部门适用」→ 不限制
    const d = _deptOfUser(r)
    return wantDepts.some(w => w === d.key || w === d.majorKey)
  }
  // 上期 = 同部门、非本营次、记录时间最晚的那一期（只供参照，绝不进统计）
  const _prevSlugOf = r => {
    let best = null
    for (const x of (Array.isArray(r && r.chy) ? r.chy : [])) {
      const slug = recSlug(x)
      if (slug === wantSlug) continue
      if (!_roundInSameDept(r, slug)) continue
      const at = Number(x && x.at) || 0
      if (!best || at > best.at) best = { slug, at }
    }
    return best ? best.slug : ''
  }
  const chyPrevOf = r => {
    const fb = _prevSlugOf(r)
    return fb ? chyOfSlug(r, fb) : []
  }
  // v89 部门筛选：'all' = 全部部门；否则按大部门 key / 分部门 slug 过滤学员
  const deptFilter = r => {
    if (dashChDept === 'all') return true
    const hit = (typeof normDept === 'function') ? normDept(r && r.dept) : null
    if (!hit) return false
    if (dashChDept.indexOf('/') >= 0) return hit.key === dashChDept
    return hit.majorKey === dashChDept
  }
  // ★v185 参与名单：本期有记录的人 + 本期没有但上期参与过的人（后者打「仅上期」角标）。
  //   保留上期人员是为了「人不上榜」不会让管理员误判他没参加过；
  //   但其所有数字由 chyOf（严格本期）算出，自然全为空/0，不会污染汇总。
  const parts = (rows || []).filter(r => r && (chyOf(r).length || chyPrevOf(r).length) && deptFilter(r))
  // v89 部门筛选按钮组（饮食部四分队 + 房务部 + 全部）：各部门题不同 → 需要分开看
  const deptBarOptions = ['all'].concat(
    (typeof ADMIN_DEPT_TABS !== 'undefined' ? ADMIN_DEPT_TABS : []).filter(k => k !== 'all')
  )
  const deptLabelOf = k => k === 'all'
    ? t('roundDeptAll')
    : ((typeof adminTabLabel === 'function' && adminTabLabel(k)) || k)
  const deptBar = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <span style="font-size:12px;color:#6b7280">${t('dashChDeptFilterLabel')}：</span>
      ${deptBarOptions.map(k => `<button class="btn btn-sm ${dashChDept === k ? 'btn-primary' : 'btn-ghost'}" style="padding:3px 10px;font-size:12px" onclick="dashChSetDept('${escAttr(k)}')">${escHtml(deptLabelOf(k))}</button>`).join('')}
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-ghost" style="padding:3px 10px;font-size:12px" id="dashLvRebuildBtn"
        onclick="dashRebuildLevels()" title="${escAttr(t('dashLvRebuildHint'))}">🔁 ${t('dashLvRebuildBtn')}</button>
    </div>`
  // 营次名（rdList 已按部门过滤，见函数开头 v94 段）
  const rdObj = rdList.find(r => r.id === want) || {}
  const rdName = rdObj.name || (want === 'r1' ? '第一期' : want)
  // ★★★ v188：本营次天结构。chPlan:'v2' = 考试独占一天（Day1 前测 / Day2-6 刷题 / Day7 期末考），
  //   每天只有一个环节 → 打卡只有「做了 ✓」与「没做 –」两态，结构上不可能再出现半圆 ◐。
  //   字段缺省 = 旧结构（Day1/Day7 各两环节），存量营次 r1–r7 一律不重算、不迁移。
  // v196：chPlan:'v3' = 21 天挑战（Day1/Day21 考试 30 题、Day2-20 每天 30 题练习，总 630 题）。
  //   矩阵列数 / 打卡格 / 期末列全部按 N 动态生成，绝不写死 7。
  const planV2 = !!(rdObj && rdObj.chPlan === 'v2')
  const planV3 = !!(rdObj && rdObj.chPlan === 'v3')
  const chN = planV3 ? 21 : 7                      // 本营次天数（列数 / 打卡循环上限）
  const chLastTest = planV3 ? 21 : 7               // 本营次最后一个考试日（期末列 / 上期期末参照）
  // v88 营次筛选按钮组（多期并存时才有意义；单期时只显示提示行）
  // v94：rdList 已按 dashChDept 过滤 → 切到某部门后只列该部门的营次
  const filterBar = rdList.length > 1
    ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <span style="font-size:12px;color:#6b7280">${t('dashRoundFilterLabel')}：</span>
        ${rdList.map(r => `<button class="btn btn-sm ${r.id === want ? 'btn-primary' : 'btn-ghost'}" style="padding:3px 10px;font-size:12px" data-rid="${escAttr(r.id)}" onclick="dashViewRound(this)">${escHtml(r.name)}</button>`).join('')}
      </div>`
    : ''
  if (!parts.length) {
    el.innerHTML = `<div class="card" style="margin-top:16px">${deptBar}${filterBar}<div style="padding:24px;text-align:center;color:#9ca3af">🏅 ${t('dashChNone')}</div>
      <p class="form-hint" style="text-align:center;margin:0">${t('dashRoundStatHint', rdName)}</p></div>`
    return
  }
  // 汇总
  let totalQ = 0, totalC = 0
  const list = parts.map(r => {
    // ★★★v185 红线：统计口径**只用本营次记录**（chyOf），绝不跨期合并。
    //   v184 曾在此处用 chyAnyOf（本期为空则回落上一期），导致「第二期全是第一期结果」。
    //   q / acc / checkin / maxDay / 积分 / 导出 全部由 chy 派生 → 天然只含本期。
    const chy = chyOf(r)
    const q = chy.reduce((s, c) => s + (c.total || 0), 0)
    const c = chy.reduce((s, x) => s + (x.correct || 0), 0)
    totalQ += q; totalC += c
    // 进度：完成的（day,si）去重取最新；最高天
    const seen = {}
    let stagesDone = 0, maxDay = 0
    chy.forEach(x => {
      const k = x.day + '-' + x.si
      if (!seen[k]) { seen[k] = true; stagesDone++ }
      if (x.day > maxDay) maxDay = x.day
    })
    // v82 每日打卡：每天完成的阶段数（chy 按 day-si 去重）→ 2=全部完成（打卡）/1=部分/0=未打卡。
    // 阶段数与 challenge.js 的天结构对应（旧结构 Day1/7 各 2 阶段，其余各 1 阶段），本地声明避免跨文件依赖
    // v188：新结构每天 1 阶段（见上方 planV2）→ 半圆不会再出现
    // v196：21 天结构每天同样只 1 阶段（Day1/Day21 考试、其余练习）
    const stageCnt = (planV2 || planV3)
      ? (() => { const m = {}; for (let d = 1; d <= chN; d++) m[d] = 1; return m })()
      : { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2 }
    const checkin = []
    for (let d = 1; d <= chN; d++) {
      let n = 0
      for (let si = 0; si < stageCnt[d]; si++) if (seen[d + '-' + si]) n++
      checkin.push(n === 0 ? 0 : n === stageCnt[d] ? 2 : 1)
    }
    // 测试分：Day1 / 期末（Day7 或 Day21）的水平测试（test 只上报一次）；v84：成绩被管理员重置的存根跳过 → 显示「—」
    const t1 = chy.find(x => x.kind === 'test' && x.day === 1 && !x.cleared)
    const t7 = chy.find(x => x.kind === 'test' && x.day === chLastTest && !x.cleared)
    // ★v185 上期参照值：**只取上期期末成绩（Day7/Day21 考试分）**，且只喂给单元格做灰色显示，
    //   绝不参与 q/acc/积分/汇总/导出。上期前测不展示（用户 10-19 明确：只显示上期期末成绩）。
    const prevChy = chyPrevOf(r)
    const p7 = prevChy.find(x => x.kind === 'test' && x.day === chLastTest && !x.cleared)
    const score = x => x && x.total ? Math.round(x.correct / x.total * 100) : null
    // v73 积分榜：每环节按首次完成计（day-si 去重取 at 最早一条，重练不刷速度分）；
    // v78：答对分按环节权重（第七天期末考试 3 倍），用时扣分不变
    // v161：积分里的计时改为**计分用时** —— 每个阶段先按 total × 30 秒封顶再累加。
    //   动机（用户质疑「排前面的没别人答得多、也没别人准」的真因之一）：原口径直接取 chy 的 usedSec
    //   = 「进入环节 → 完成」的净耗时。学员中途被工作打断、页面就那么挂着，时长照样全额累积。
    //   线上实测：有学员单个 30 题练习阶段耗 3675 秒（122.5 秒/题），而全体每题用时 P90 仅约 25 秒
    //   → 单个环节白扣 3675 分（≈37 道题的分），名次实际由「谁没被打断」决定，而不是「谁答得又多又准」。
    //   为什么 30 秒/题：实测每题用时 中位≈9~13s、P75≈10~17s、P90≈13~25s → 留了约 20% 余量，
    //   正常作答（含较慢的学员）一分不扣，只削「被中断」那条长尾。day7 权重 3 倍仍照常计答对分。
    //   ★ 刻意定义在函数内部、不抽到模块级：本块会被各测试套件按源码切片注入，
    //     抽出去会让所有既有套件的沙箱缺注入而整片报错（challenge.js chLbAggregate 同此处理）。
    //   ★ total 缺失（老记录 / 手动补录异常）时**不封顶** —— 绝不凭空给老数据加分。
    const LB_SEC_PER_Q_CAP = 30
    const lbDeductSec = x => {
      const sec = Math.max(0, Number(x && x.usedSec) || 0)
      const total = Number(x && x.total) || 0
      if (total <= 0) return sec
      return Math.min(sec, total * LB_SEC_PER_Q_CAP)
    }
    // v84：成绩已重置的考试存根不计分（重考后产生的新记录才计入）
    const firstByStage = {}
    chy.forEach(x => {
      if (x.cleared) return
      const k = x.day + '-' + x.si
      if (!firstByStage[k] || (x.at || 0) < (firstByStage[k].at || 0)) firstByStage[k] = x
    })
    // v160：积分乘上「首答准确率」——答对分与准确率必须同源（都用去重后的首次完成记录）。
    //   ★ 绝不能用明细表那个「正确率」（含重做的全部作答）：学生把环节重做几遍就能把准确率刷高，
    //     而积分里的答对数恰恰按 v73 去重防的就是这个刷分路径。故此处独立累计 lbQ。
    // v161：lbT = **计分用时**（每阶段每题封顶 30 秒，见 lbDeductSec）；lbTa = 实际用时（仅供看板对照显示）。
    //   ★ lbT 的既有一切消费点（排序次位 / 导出 / 积分公式）语义不变，只是取值改成了封顶后的值。
    let lbC = 0, lbQ = 0, lbT = 0, lbTa = 0, lbPts = 0
    Object.keys(firstByStage).forEach(k => {
      const x = firstByStage[k]
      lbC += x.correct || 0
      lbQ += x.total || 0
      lbT += lbDeductSec(x)
      lbTa += Math.max(0, x.usedSec || 0)
      lbPts += (x.correct || 0) * 100 * dashChStageWeight(x.day, x.kind)
    })
    // 首答准确率（0~1）：lbQ=0（旧记录缺 total）时按 1 处理 → 与加乘数前完全等价，不让老数据归零
    const lbAcc = lbQ > 0 ? Math.min(1, lbC / lbQ) : 1
    return {
      username: r.username, name: r.name, dept: r.dept, role: r.role,
      maxDay, stagesDone, q, acc: q > 0 ? Math.round(c / q * 100) : 0,
      s1: score(t1), s7: score(t7),
      // ★v185：只保留上期期末成绩作参照（s7p），上期前测不展示
      s7p: score(p7),
      // v105：该场成绩是否来自管理员手动补录（看板打「手动录入」标记，便于事后区分人工数据）
      m7: !!(t7 && t7.manual), m1: !!(t1 && t1.manual),
      checkin,
      lbC, lbQ, lbAcc, lbT, lbTa, lbScore: Math.round(lbPts * lbAcc) - lbT,
      // v196b：本期有效首答阶段数 —— 积分榜入榜资格判据（>0 才有排名资格），明细表保留全员不受影响
      lbStages: Object.keys(firstByStage).length,
      chQ: r.chQ || {},
    }
  })
  list.sort((a, b) => b.q - a.q)
  _chDashRows = list   // v105：供批量补录读取（「进度已到 Day7 但 D7 无成绩」的学员集合）
  // v82 每日打卡汇总：每天完成（全部阶段）的人数（v196：按营次天数动态）
  const checkinStats = new Array(chN).fill(0)
  list.forEach(p => (p.checkin || []).forEach((c, i) => { if (c === 2) checkinStats[i]++ }))
  // v139：原三态打卡单元格（✅/◐/—）随「三段分组 + D1–D7 用 1/-1」的改造下线，
  // 由下面的 dayCell 取代 —— 别再引入第二套打卡渲染，否则口径会分叉。
  // v160 积分榜排序：积分（答对×权重×100×首答准确率−用时秒）高者在前；同分用时短者在前，再比答对数
  // v78：管理员账号不参加排名（进度明细表与汇总仍含管理员，便于自查）
  // v196b：本期零首答记录的人（含「仅上期」人员）不入积分榜 —— 与学员端 chLbAggregate 同口径
  const lbList = list.filter(p => p.role !== 'admin' && (p.lbStages || 0) > 0).slice().sort((a, b) => (b.lbScore - a.lbScore) || (a.lbT - b.lbT) || (b.lbC - a.lbC))
  const fmtSec = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
  const medal = i => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1))
  // 错题排行：跨学员合并 chQ（错次），取错误次数最多的 50 题
  const wrongAgg = {}
  list.forEach(p => {
    Object.keys(p.chQ).forEach(qid => {
      const rec = p.chQ[qid]
      if (!rec) return
      const a = wrongAgg[qid] || (wrongAgg[qid] = { wrong: 0 })
      a.wrong += rec.total
    })
  })
  const qMap = {}
  Store.getQuestions().forEach(q => { qMap[q.id] = q })
  const wrongList = Object.keys(wrongAgg)
    .filter(qid => qMap[qid])
    .map(qid => {
      const q = qMap[qid]
      return { qid: q.id, question: q.question, type: TYPE_LABELS[q.type] || q.type, wrong: wrongAgg[qid].wrong }
    })
    .sort((a, b) => b.wrong - a.wrong)
    .slice(0, 50)
  const avgAcc = totalQ > 0 ? Math.round(totalC / totalQ * 100) : 0
  // v105：进度已到期末（Day7/Day21）但期末无成绩的人数 → 提示补录入口（正是本次事故的表现形态）
  const lack7 = list.filter(p => p.s7 == null && p.maxDay >= chLastTest).length
  // 本期成绩单元格：**只渲染本期成绩**，两参。
  // ★v187：v185 曾让第 3 参把上期分数塞进「期末」列做灰色带「上」的替身 —— 用户明确不要
  //   （10-19：「上次成绩不要做阴影处理了，只要单独做一列上一期期末成绩即可」）。
  //   现在上期成绩走独立的 prevCell 列，本期两列保持纯净：有分就按红黄绿判定，没分就是「—」。
  const scoreCell = (s, manual) => (s == null
    ? '<span style="color:#9ca3af;font-size:12px">—</span>'
    : `<span style="font-weight:700;color:${s >= 80 ? '#059669' : s >= 60 ? '#d97706' : '#dc2626'}">${s}</span>`)
    // v105：手动补录的成绩加标记，避免事后与真实考试成绩混淆
    + (manual && s != null ? `<span title="${escAttr(t('dashChManualBadgeHint'))}" style="margin-left:4px;font-size:10px;color:#92400e;background:#fef3c7;border-radius:6px;padding:1px 5px;vertical-align:middle">${t('dashChManualBadge')}</span>` : '')
  // ★v187 上期期末成绩：**独立一列**，纯中性灰 —— 不做红黄绿判定、不带角标、不参与本期任何统计。
  //   它存在的唯一意义是让管理员看到「这个人上一期考了多少」，属于参照信息而非本期数据。
  const prevCell = v => (v == null
    ? '<span style="color:#9ca3af;font-size:12px">—</span>'
    : `<span style="color:#6b7280">${v}</span>`)
  // v139：明细表 = 三段分组（部门列 rowspan 合并、D1–D7 用 1/-1）——与导出的 Excel 同形态
  const chgCell = v => (v === '-'
    ? '<span style="color:#9ca3af">-</span>'
    : `<span style="font-weight:700;color:${v > 0 ? '#059669' : v < 0 ? '#dc2626' : '#6b7280'}">${v > 0 ? '+' + v : v}</span>`)
  // D1–D7 单元格（网页显示，v141 起改为符号两态；v143 部分完成改「半实心圆 ◐」并统一放大字号）：
  // 参与且全阶段完成=绿色 ✓；只完成部分=深灰 ◐ +tooltip；未参与=灰色 −。
  // ⚠️ font-size 写在最前，保持 `color:#059669;font-weight:700` 前缀稳定（多个测试断言依赖该前缀）。
  // ⚠️ **导出 Excel 仍是原表的 1 / −1 两态**（dashChDayMark 负责导出值，别在这里取）——
  // 别再引入第二套打卡渲染，否则口径会分叉。
  const dayCell = (p, d) => {
    const c = ((p && p.checkin) || [])[d - 1]
    const big = 'font-size:15px'
    if (c === 2) return `<span style="${big};color:#059669;font-weight:700">✓</span>`
    if (c === 1) return `<span title="${escAttr(t('dashChDayPartialHint'))}" style="${big};color:#374151;font-weight:700">◐</span>`
    return `<span style="${big};color:#9ca3af">−</span>`
  }
  const detailGroups = dashChScoreBlocks(list).map(b => {
    const n = b.rows.length
    // 部门列纵向合并：连续同部门合成一段（与 Excel 的 rowspan/mergeCell 同口径）
    const runs = []
    b.rows.forEach((p, i) => {
      const d = String(p.dept || '')
      const tail = runs[runs.length - 1]
      if (tail && tail.dept === d) tail.to = i
      else runs.push({ dept: d, from: i, to: i })
    })
    const body = b.rows.map((p, i) => {
      const pi = list.indexOf(p)   // 供操作按钮定位（沿用原 pi 语义）
      const run = runs.filter(r => r.from === i)[0]
      // v163：配色与累计总览/正确率表统一（>90 绿 / 80–90 粉 / ≤80 红）；★ 见 accRateClass 的 typeof 守卫说明
      const accCell = (Number(p.q) || 0) > 0
        ? `<span class="perq-rate ${(typeof accRateClass === 'function') ? accRateClass(p.acc) : (Number(p.acc) > 90 ? 'perq-good' : Number(p.acc) > 80 ? 'perq-high' : 'perq-low')}">${p.acc}%</span>`
        : '<span style="color:#9ca3af">-</span>'
      return `<tr>
        ${run ? `<td rowspan="${run.to - run.from + 1}" style="vertical-align:middle;text-align:center;color:#6b7280;font-size:12px">${escHtml(p.dept || '—')}</td>` : ''}
        <td style="white-space:nowrap">${_nameLink(p.username, p.name || '—')}</td>
        <td style="white-space:nowrap;color:#6b7280;font-size:12px">${escHtml(p.username || '—')}</td>
        <td style="text-align:center">${Number(p.q) || 0}</td>
        <td style="text-align:center">${accCell}</td>
        <td style="text-align:center;border-left:2px solid #e5e7eb">${scoreCell(p.s1, p.m1)}</td>
        <td style="text-align:center">${scoreCell(p.s7, p.m7)}</td>
        <td style="text-align:center" title="${escAttr(t('dashChPrevHint'))}">${prevCell(p.s7p)}</td>
        <td style="text-align:center">${chgCell(dashChScoreChange(p))}</td>
        ${Array.from({ length: chN }, (_, i) => i + 1).map(d => `<td style="text-align:center;border-left:${d === 1 ? '2px solid #e5e7eb' : 'none'}">${dayCell(p, d)}</td>`).join('')}
        <td style="text-align:center;border-left:2px solid #e5e7eb;white-space:nowrap">
          <button class="btn btn-ghost" id="dashChResetBtn_${pi}" style="padding:4px 10px;font-size:12px;white-space:nowrap"
            data-u="${escAttr(p.username)}" data-n="${escAttr(p.name || '')}"
            onclick="dashResetChUser(this, ${pi})">${t('dashChResetBtn')}</button>
          <button class="btn btn-ghost" id="dashChManualBtn_${pi}" style="padding:4px 10px;font-size:12px;white-space:nowrap;margin-left:4px"
            data-u="${escAttr(p.username)}" data-n="${escAttr(p.name || '')}"
            onclick="dashManualScoreFromBtn(this)">${t('dashChManualBtn')}</button>
        </td>
      </tr>`
    }).join('')
    // Average 汇总行：原表只在「完全有效组」末尾出现（缺考组求平均没有意义；原表拼写 Avearge 已改正）
    let avgRow = ''
    if (b.key === 'full' && n > 0) {
      const avgOf = ci => {
        const vals = b.rows.map(p => (ci === 5 ? p.s1 : ci === 6 ? p.s7 : dashChScoreChange(p)))
          .filter(v => typeof v === 'number')
        return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100) / 100 : null
      }
      const fmtAvg = v => (v == null ? '-' : v)
      // v196：天数列 + 操作列 = chN + 1 列（旧结构 7+1=8，21 天 21+1=22）
      avgRow = `<tr style="background:#f9fafb;font-weight:700">
        <td colspan="3" style="text-align:center;color:#6b7280">${escHtml(t('dashChAvgLabel'))}</td>
        <td colspan="2"></td>
        <td style="text-align:center">${fmtAvg(avgOf(5))}</td>
        <td style="text-align:center">${fmtAvg(avgOf(6))}</td>
        <td style="text-align:center"></td>
        <td style="text-align:center">${fmtAvg(avgOf(7))}</td>
        <td colspan="${chN + 1}"></td>
      </tr>`
    }
    return `<tbody>
      <tr><td colspan="${10 + chN}" style="background:#eef2f7;font-weight:700;text-align:left;padding:6px 10px">${escHtml(b.label)} · ${t('dashChJoinCount', n)}</td></tr>
      <tr>
        <th style="text-align:center">${t('dashChColDept')}</th><th>${t('dashChColName')}</th><th>${t('dashChColUser')}</th>
        <th style="text-align:center">${t('dashChColQ')}</th>
        <th style="text-align:center">${t('dashChColAcc')}</th>
        <th style="text-align:center;border-left:2px solid #e5e7eb">${t('dashChColPre')}</th>
        <th style="text-align:center">${t('dashChColFinal')}</th>
        <th style="text-align:center;color:#6b7280" title="${escAttr(t('dashChPrevHint'))}">${t('dashChColPrevFinal')}</th>
        <th style="text-align:center">${t('dashChColChange')}</th>
        <th colspan="${chN}" style="text-align:center;border-left:2px solid #e5e7eb">📅 ${t('dashChThCheckin')}（D1–D${chN}）</th>
        <th style="text-align:center;border-left:2px solid #e5e7eb">${t('dashChThOps')}</th>
      </tr>
      ${body || `<tr><td colspan="${10 + chN}" style="text-align:center;color:#9ca3af;padding:14px">${t('dashChGrpEmpty')}</td></tr>`}
      ${avgRow}
    </tbody>`
  }).join('')
  el.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <h3 style="margin:0">🏅 ${t('dashChTitle')} · <span style="color:#2563eb">${escHtml(rdName)}</span></h3>
        <button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="dashChExportScores()">⬇️ ${t('dashChExportBtn')}</button>
      </div>
      ${deptBar}
      ${filterBar}
      <div class="dashboard-summary" style="margin-bottom:12px">
        <div class="dash-stat"><div class="dash-val">${list.length}</div><div class="dash-lbl">${t('dashChJoin')}</div></div>
        <div class="dash-stat"><div class="dash-val">${totalQ}</div><div class="dash-lbl">${t('dashChTotalQ')}</div></div>
        <div class="dash-stat"><div class="dash-val">${avgAcc}%</div><div class="dash-lbl">${t('dashChAvg')}</div></div>
      </div>
      ${lack7 > 0 ? `<div style="margin:0 0 10px;padding:10px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px;color:#1e40af">✍️ ${t('dashChManualLack', lack7)}</span>
        <button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="dashManualScoreBatch()">${t('dashChManualBatchBtn')}</button>
      </div>` : ''}
      <div style="margin:0 0 10px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px;color:#166534">🧮 ${t('dashChReconcileHint')} <span style="color:#4d7c0f">${t('dashChReconcileLocalOnly')}</span></span>
        <button class="btn btn-ghost btn-sm" style="flex-shrink:0" onclick="dashReconcileScores(this)">${t('dashChReconcileBtn')}</button>
      </div>
      <p class="form-hint" style="margin:0 0 10px">${t('dashRoundStatHint', rdName)}</p>
      <div style="margin:4px 0 10px;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e;font-size:14px;font-weight:600">🏆 ${t('dashChPrizeHint')}</div>
      <h4 style="margin:14px 0 6px">🏆 ${t('dashChRankTitle')}</h4>
      <p class="form-hint" style="margin:0 0 8px">${t('dashChScoreRule')}</p>
      <p class="form-hint" style="margin:0 0 8px">${t('dashChNoAdminRank')}</p>
      <div style="overflow-x:auto">
        <table class="admin-table" style="font-size:13px">
          <thead><tr>
            <th style="text-align:center">${t('dashChThRank')}</th>
            <th>${t('thUsername')}</th><th>${t('thName')}</th><th>${t('thDept')}</th>
            <th style="text-align:center">${t('dashChThScore')}</th>
            <th style="text-align:center">${t('dashChThCorrect')}</th>
            <th style="text-align:center">${t('dashChThFirstAcc')}</th>
            <th style="text-align:center">${t('dashChThTime')}</th>
          </tr></thead>
          <tbody>
            ${lbList.length ? lbList.map((p, i) => `<tr${i < 3 ? ' style="background:#fffbeb"' : ''}>
              <td style="text-align:center;font-size:15px">${medal(i)}</td>
              <td>${escHtml(p.username)}</td>
              <td>${_nameLink(p.username, p.name || '—')}</td>
              <td>${escHtml(p.dept || '—')}</td>
              <td style="text-align:center;font-weight:700;color:#b45309">${p.lbScore}</td>
              <td style="text-align:center">${p.lbC}</td>
              <td style="text-align:center;color:#6b7280">${Math.round((p.lbAcc == null ? 0 : p.lbAcc) * 100)}%</td>
              <td style="text-align:center;color:#6b7280"${(p.lbTa || 0) > (p.lbT || 0) ? ' title="' + escAttr(t('dashChTimeCapped', fmtSec(p.lbT))) + '"' : ''}>${fmtSec(p.lbTa)}${(p.lbTa || 0) > (p.lbT || 0) ? ' <span style="color:#b45309" title="' + escAttr(t('dashChTimeCapped', fmtSec(p.lbT))) + '">*</span>' : ''}</td>
            </tr>`).join('') : `<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px">${t('dashChRankEmpty')}</td></tr>`}
          </tbody>
        </table>
      </div>
      <h4 style="margin:18px 0 6px">📋 ${t('dashChSheetDetail')}</h4>
      <p class="form-hint" style="margin:0 0 4px">${t('dashChGrpRuleHint', DASH_CH_MIN_Q)}</p>
      <p class="form-hint" style="margin:0 0 10px">${t('dashChDayMarkHint')}</p>
      <div style="overflow-x:auto">
        <table class="admin-table ch-detail" style="font-size:13px">
          ${detailGroups}
        </table>
      </div>
      <p class="form-hint" style="margin:8px 0 0">${t('dashChCheckinStatsLabel')}：${checkinStats.map((n, i) => `D${i + 1} ${n}`).join(' · ')}</p>
      <p class="form-hint" style="margin:4px 0 0">♻️ ${t('dashChResetHint')}</p>
      <p class="form-hint" style="margin:4px 0 0">${t('dashChHint')}</p>
    </div>
    ${wrongList.length ? `
    <div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:8px">📌 ${t('dashChWrongTitle')} · <span style="color:#2563eb">${escHtml(rdName)}</span></h3>
      <p class="form-hint" style="margin-bottom:10px">${t('dashChWrongHint')}</p>
      <div style="overflow-x:auto">
        <table class="admin-table" style="font-size:13px">
          <thead><tr>
            <th>${t('perQThQid')}</th>
            <th style="min-width:220px">${t('perQThQuestion')}</th>
            <th>${t('perQThCat')}</th>
            <th style="text-align:center">${t('dashChThWrong')}</th>
          </tr></thead>
          <tbody>
            ${wrongList.map(x => `<tr>
              <td style="color:#6b7280">#${x.qid}</td>
              <td>${escHtml(x.question)}</td>
              <td>${escHtml(x.type)}</td>
              <td style="text-align:center"><span class="perq-rate perq-bad">${x.wrong}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `
}

// ====== v162：七天挑战「累计总览」——跨全部营次的累计答题数与准确率 ======
// 用户诉求（原话）：「之后每个部门的七天挑战会越来越多，能否在管理员后台加一个页面，
//   看到他所有挑战的累计答题数和准确率」——此前只能一期一期看，跨期总账无处可查。
// 口径（两个准确率**并列显示**，因为含义不同，只给一个必然误导）：
//   · 累计答题数     = Σ 全部 chy 记录的 total（含重做）—— 与明细表「答题数」同口径的跨期累加
//   · 正确率(含重做) = Σ correct / Σ total              —— 与明细表「正确率」同口径的跨期累加
//   · 首答准确率     = 各营次各阶段**首次完成**记录的 correct/total —— 与积分榜 (v160) 同口径
// ★★ 正确性红线：首答去重键必须带**营次 slug**（`rd|day|si`）。
//    若只按 `day-si` 去重，会把不同营次的「同一天同一阶段」误判成同一阶段 —— 第 2 期跑完
//    反而把第 1 期挤掉，累计值会「越练越少」。当期看板里只有一个营次，所以那边不需要 rd。
// ★ 其余护栏与当期看板逐条对齐：`cleared`（v84 成绩重置存根）不计入首答；准确率钳在 0~100%；
//    分母为 0（无作答）显示「-」而不是 0%，与「答了但全错」区分开。
function dashChTotalRows(rows, deptSel) {
  const sel = String(deptSel == null ? 'all' : deptSel) || 'all'
  // 部门筛选（与当期看板 deptFilter 同口径：'all' / 大部门 key / '大部门/分部门' slug）
  const deptHit = r => {
    if (sel === 'all') return true
    const hit = (typeof normDept === 'function') ? normDept(r && r.dept) : null
    if (!hit) return false
    if (sel.indexOf('/') >= 0) return hit.key === sel
    return hit.majorKey === sel
  }
  const pct = (a, b) => (b > 0 ? Math.round(Math.min(1, a / b) * 100) : null)
  const out = []
  ;(rows || []).forEach(r => {
    if (!r || !Array.isArray(r.chy) || !r.chy.length) return
    if (!deptHit(r)) return
    const slugOf = x => (typeof dashRoundSlug === 'function')
      ? dashRoundSlug(x && x.rd)
      : String((x && x.rd) || '第一期')
    let q = 0, c = 0
    const first = {}
    const seenRounds = {}
    r.chy.forEach(x => {
      q += Number(x.total) || 0
      c += Number(x.correct) || 0
      const slug = slugOf(x)
      seenRounds[slug] = true
      if (x.cleared) return                        // v84：成绩重置存根不计首答
      const k = slug + '|' + x.day + '|' + x.si    // ★★ 必须带营次（见上方红线）
      if (!first[k] || (x.at || 0) < (first[k].at || 0)) first[k] = x
    })
    let fQ = 0, fC = 0
    Object.keys(first).forEach(k => { fQ += Number(first[k].total) || 0; fC += Number(first[k].correct) || 0 })
    const roundSlugs = Object.keys(seenRounds)
    out.push({
      username: r.username, name: r.name, dept: r.dept, role: r.role,
      rounds: roundSlugs.length, roundSlugs: roundSlugs,
      stages: Object.keys(first).length,
      q: q, c: c, accAll: pct(c, q),
      fQ: fQ, fC: fC, accFirst: pct(fC, fQ),
    })
  })
  // 累计答题数降序（与当期明细表组内排序同口径）；并列时按首答题量
  out.sort((a, b) => (b.q - a.q) || (b.fQ - a.fQ))
  return out
}

function renderDashChTotalBlock(rows) {
  // ★ v189：姓名链接的沙箱守卫（同上，见 renderDashboard 开头注释）
  const _nameLink = (typeof upNameLink === 'function') ? upNameLink : ((_u, _x) => escHtml(_x || '—'))
  const el = document.getElementById('dashChallengeBlock')
  if (!el) return
  // 累计总览是「总账页」→ 把营次管理面板收起，避免两个面板抢视线（切回当期看板即恢复）。
  // ★ 刻意**不动 renderDashboard 模板里那行字面量**：test-v76 / test-v118 的正则就锚在
  //   `<div id="dashRoundsPanel">${dashRoundsPanelHtml()}</div>` 上，改它等于把两条接线断言弄红
  //   （本轮实撞）。收起动作放在这里，位置变了行为不变。
  const rp = document.getElementById('dashRoundsPanel')
  if (rp) rp.style.display = 'none'
  const sel = (typeof dashChDept === 'undefined') ? 'all' : dashChDept
  const list = dashChTotalRows(rows, sel)
  // 部门筛选条（与当期看板同款）。★ 刻意**内联、不抽公共函数**：既有套件按源码切片注入，
  //   抽成模块级函数会让 renderDashChallengeBlock 的沙箱缺注入而整片报错（v161 同款教训）。
  const deptBarOptions = ['all'].concat(
    (typeof ADMIN_DEPT_TABS !== 'undefined' ? ADMIN_DEPT_TABS : []).filter(k => k !== 'all')
  )
  const deptLabelOf = k => k === 'all'
    ? t('roundDeptAll')
    : ((typeof adminTabLabel === 'function' && adminTabLabel(k)) || k)
  const deptBar = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      <span style="font-size:12px;color:#6b7280">${t('dashChDeptFilterLabel')}：</span>
      ${deptBarOptions.map(k => `<button class="btn btn-sm ${sel === k ? 'btn-primary' : 'btn-ghost'}" style="padding:3px 10px;font-size:12px" onclick="dashChSetDept('${escAttr(k)}')">${escHtml(deptLabelOf(k))}</button>`).join('')}
    </div>`
  // 营次名映射：「参与营次」列悬停显示含哪几期（营次已删 → 回落原始 slug）
  const rdList = (typeof dashRoundList === 'function') ? dashRoundList() : []
  const rdNameOf = slug => {
    const hit = rdList.filter(r => ((typeof dashRoundSlug === 'function') ? dashRoundSlug(r.id) : r.id) === slug)[0]
    return (hit && hit.name) || slug
  }
  const totQ = list.reduce((s, p) => s + p.q, 0)
  const totC = list.reduce((s, p) => s + p.c, 0)
  const totFQ = list.reduce((s, p) => s + p.fQ, 0)
  const totFC = list.reduce((s, p) => s + p.fC, 0)
  const pctText = (a, b) => (b > 0 ? Math.round(Math.min(1, a / b) * 100) + '%' : '—')
  // v163：全站统一配色（>90 绿 / 80–90 粉 / ≤80 红）。★ typeof 守卫见 accRateClass 注释
  const accCls = v => (typeof accRateClass === 'function')
    ? accRateClass(v)
    : (Number(v) > 90 ? 'perq-good' : Number(v) > 80 ? 'perq-high' : 'perq-low')
  const accCell = v => (v == null
    ? '<span style="color:#9ca3af">-</span>'
    : `<span class="perq-rate ${accCls(v)}">${v}%</span>`)
  // v163：**所有人一起排**（不做分部门分组、不做部门列合并）→ 名次 = 1..N 连续全局名次
  const sortKey = (typeof dashChTotalSort === 'undefined') ? 'q' : dashChTotalSort
  const sortDir = (typeof dashChTotalDir === 'undefined') ? -1 : dashChTotalDir
  const sorted = (typeof dashChTotalSortList === 'function')
    ? dashChTotalSortList(list, sortKey, sortDir)
    : (list || []).slice()   // ★ 切片沙箱兜底（既有套件没有 dashChTotalSortList）
  const dirIco = k => (sortKey === k ? (sortDir === -1 ? ' ▼' : ' ▲') : '')
  const thSort = k => `style="text-align:center;cursor:pointer;white-space:nowrap" title="${escAttr(t('dashChTotalSortHint'))}" onclick="dashChTotalSetSort('${k}')"`
  const body = sorted.map((p, i) => `<tr>
      <td style="text-align:center;color:#6b7280;font-size:12px" title="${escAttr(t('dashChTotalRankHint'))}">${i + 1}</td>
      <td style="white-space:nowrap;text-align:center;color:#6b7280;font-size:12px">${escHtml(p.dept || '—')}</td>
      <td style="white-space:nowrap">${_nameLink(p.username, p.name || '—')}${p.role === 'admin' ? ` <span style="font-size:10px;color:#92400e;background:#fef3c7;border-radius:6px;padding:1px 5px">${escHtml(t('roleAdmin'))}</span>` : ''}</td>
      <td style="white-space:nowrap;color:#6b7280;font-size:12px">${escHtml(p.username || '—')}</td>
      <td style="text-align:center" title="${escAttr(p.roundSlugs.map(rdNameOf).join('、'))}">${p.rounds}</td>
      <td style="text-align:center;font-weight:700">${p.q}</td>
      <td style="text-align:center">${accCell(p.accFirst)}</td>
      <td style="text-align:center">${accCell(p.accAll)}</td>
      <td style="text-align:center;color:#9ca3af;font-size:12px" title="${escAttr(t('dashChTotalStagesHint'))}">${p.stages}</td>
    </tr>`).join('')
  // 配色图例（与 accRateClass 同口径；三档直接用真实徽章，避免「说明和实际不一致」）
  const legend = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px">
      <span style="font-size:12px;color:#6b7280">${t('dashChTotalColorHint')}：</span>
      <span class="perq-rate ${accCls(95)}">&gt;90%</span>
      <span class="perq-rate ${accCls(85)}">81–90%</span>
      <span class="perq-rate ${accCls(70)}">≤80%</span>
    </div>`
  el.innerHTML = `
    <div class="card" style="margin-top:16px">
      <h3 style="margin:0 0 8px">🗂️ ${t('dashChTotalTitle')}</h3>
      ${deptBar}
      <div class="dashboard-summary" style="margin-bottom:12px">
        <div class="dash-stat"><div class="dash-val">${list.length}</div><div class="dash-lbl">${t('dashChTotalStatPeople')}</div></div>
        <div class="dash-stat"><div class="dash-val">${totQ}</div><div class="dash-lbl">${t('dashChTotalStatQ')}</div></div>
        <div class="dash-stat"><div class="dash-val">${pctText(totFC, totFQ)}</div><div class="dash-lbl">${t('dashChTotalStatFirst')}</div></div>
        <div class="dash-stat"><div class="dash-val">${pctText(totC, totQ)}</div><div class="dash-lbl">${t('dashChTotalStatAll')}</div></div>
      </div>
      <p class="form-hint" style="margin:0 0 10px">${t('dashChTotalHint')}</p>
      <p class="form-hint" style="margin:0 0 10px">${t('dashChTotalSortHint')}</p>
      ${legend}
      <div style="overflow-x:auto">
        <table class="admin-table" style="font-size:13px">
          <thead><tr>
            <th style="text-align:center">${t('dashChTotalThRank')}</th>
            <th style="text-align:center">${t('thDept')}</th>
            <th>${t('thName')}</th>
            <th>${t('thUsername')}</th>
            <th style="text-align:center">${t('dashChTotalThRounds')}</th>
            <th ${thSort('q')}>${t('dashChTotalThQ')}${dirIco('q')}</th>
            <th ${thSort('accFirst')}>${t('dashChTotalThFirst')}${dirIco('accFirst')}</th>
            <th ${thSort('accAll')}>${t('dashChTotalThAll')}${dirIco('accAll')}</th>
            <th style="text-align:center">${t('dashChTotalThStages')}</th>
          </tr></thead>
          <tbody>
            ${body || `<tr><td colspan="9" style="text-align:center;color:#9ca3af;padding:16px">${t('dashChTotalEmpty')}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`
}

// ====== v189：学员档案（点姓名 → 个人走势）======
// 用户诉求（2026-10-20）：「我可以点击每个人的名字，然后看到这个人具体七天挑战和线下课
//   以及定级的走势，要有每次七天挑战的折线图分数走势」。
//
// ★★★ 口径红线（承 v185）：本档案**逐营次独立取数、绝不跨期合并或回落**。
//   每个营次一个数据点，没参加就是空的 —— 宁可显示「—」，也不许拿上一期顶替。
//   · 分数 = round(correct / total * 100)，与看板 score() 同口径；cleared（成绩重置存根）不计。
//   · 前测 = 该营次 day===1 的 test（取最晚一条，兼容重置后重考）；期末 = 该营次 day 最大且
//     >1 的 test（同样取最晚）。用「最大 day」而非写死 7：v188 起新结构仍以 Day7 收尾，
//     存量营次里也有提前开考只做到 Day7 的情况，max 天然兼容两种。
//   · 线下课只读 CourseStore 文档里的 results，不写回、不触发任何上报。
//   · 定级走势 = chlevel 事件的**变化点**（v166 A 案），不是从 chy 反推 ——
//     chy 里的 lv 只是阶段快照（cloud-store 注释已警告），拿它画线会造出从未有过的等级。
//   · 折线图是纯手写 SVG（站点无图表库依赖）。宽度按点数自适应 + 横向滚动：
//     手机 360px 下整体缩放会把 11px 字压成 7px，看不清，宁可让它滚。
function dashUserRoundSeries(r) {
  const recs = (r && Array.isArray(r.chy)) ? r.chy.filter(Boolean) : []
  const slugOf = x => (typeof dashRoundSlug === 'function')
    ? dashRoundSlug((x && x.rd) || '')
    : (String((x && x.rd) || '') || '第一期')
  const groups = {}
  const order = []
  recs.forEach(x => {
    const slug = slugOf(x)
    if (!groups[slug]) { groups[slug] = []; order.push(slug) }
    groups[slug].push(x)
  })
  const rdList = (typeof dashRoundList === 'function') ? dashRoundList() : []
  const nameOf = slug => {
    const hit = rdList.filter(x => ((typeof dashRoundSlug === 'function') ? dashRoundSlug(x.id) : x.id) === slug)[0]
    return (hit && hit.name) || slug
  }
  const pctOf = x => {
    const tt = Number(x && x.total) || 0
    const cc = Number(x && x.correct) || 0
    return tt > 0 ? Math.round(Math.min(1, cc / tt) * 100) : null
  }
  const atOf = x => Number(x && x.at) || 0
  const latest = arr => arr.slice().sort((a, b) => atOf(a) - atOf(b)).pop() || null
  const out = order.map(slug => {
    const list = groups[slug].slice().sort((a, b) => atOf(a) - atOf(b))
    const tests = list.filter(x => x.kind === 'test' && !x.cleared)
    const dayOf = x => Number(x && x.day) || 0
    const dMax = tests.length ? Math.max.apply(null, tests.map(dayOf)) : 0
    const pre = latest(tests.filter(x => dayOf(x) === 1))
    // 单日营次（只做过 Day1）→ 期末留空，绝不把前测复制成期末
    const fin = dMax > 1 ? latest(tests.filter(x => dayOf(x) === dMax)) : null
    let q = 0, c = 0
    const first = {}
    list.forEach(x => {
      q += Number(x.total) || 0
      c += Number(x.correct) || 0
      if (x.cleared) return                       // v84：重置存根不计首答
      const k = dayOf(x) + '|' + (Number(x.si) || 0)
      if (!first[k] || atOf(x) < atOf(first[k])) first[k] = x
    })
    let fQ = 0, fC = 0
    Object.keys(first).forEach(k => { fQ += Number(first[k].total) || 0; fC += Number(first[k].correct) || 0 })
    const days = {}
    list.forEach(x => { if (!x.cleared) days[dayOf(x)] = true })
    return {
      slug, name: nameOf(slug),
      at: atOf(list[0]), endAt: atOf(list[list.length - 1]),
      pre: pctOf(pre), final: pctOf(fin),
      q, acc: q > 0 ? Math.round(Math.min(1, c / q) * 100) : null,
      firstQ: fQ, firstAcc: fQ > 0 ? Math.round(Math.min(1, fC / fQ) * 100) : null,
      days: Object.keys(days).length,
    }
  })
  // 时间升序：X 轴必须是「第一次参与的先后」，不是营次创建顺序
  return out.sort((a, b) => (a.at - b.at) || String(a.slug).localeCompare(String(b.slug)))
}

// 定级走势：chlevel 事件的变化点 + 当前值兜底。
//   events 结构 = 云端事件队列（{ u, ty:'chlevel', ts, d:{ lv } | { clear:true } }）。
//   相邻同值合并：管理员「重算历史等级」会一次刷出十几条同值事件，逐条画点会糊成一片。
function dashUserLevelSeries(username, events, curLv) {
  const u = String(username || '')
  const pts = []
  ;(Array.isArray(events) ? events : [])
    .filter(ev => ev && ev.ty === 'chlevel' && String(ev.u || '') === u)
    .map(ev => {
      const d = ev.d || {}
      if (d.clear === true) return { at: Number(ev.ts) || 0, lv: 0 }   // 清除 = 回到「未评定」
      const n = Number(d.lv)
      return (Number.isInteger(n) && n >= 1 && n <= 4) ? { at: Number(ev.ts) || 0, lv: n } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .forEach(p => {
      const last = pts[pts.length - 1]
      if (last && last.lv === p.lv) { last.at = p.at; return }
      pts.push({ at: p.at, lv: p.lv })
    })
  const cur = Number(curLv) || 0
  const last = pts[pts.length - 1]
  // 末尾补当前值（事件流拉不到时至少有一个点）；已有同值就不重复补
  if (cur > 0 && (!last || last.lv !== cur)) pts.push({ at: 0, lv: cur })
  return pts
}

// ====== v194：七天挑战每日准确率走势 ======
// 数据来源：r.chy 里每条 { day, si, kind, correct, total, at, rd }，**同字段结构已有，不新增上报**。
//
// 每日的环节构成（实测 10-20 全库分布）：
//   Day1: test|si0（前测 20 题）+ practice|si1（10 题热身）
//   Day2–6: practice|si0（30 题）
//   Day7: practice|si0（30 题）+ test|si1（期末 20 题）
//   → 所以「当天准确率」必须是**按题量加权**，不能把各环节百分比简单平均
//     （20 题 60% 与 10 题 100% 简单平均 = 80%，真实是 73%）。
//
// ★★★ 三条红线：
//   ① 同一 (day, si) 可能有多条 —— 实测 38 人有重刷记录。必须取**最早那条（首答）**，
//      否则「重刷到满分」会把走势图拉成虚假上升。这与 firstAcc 的口径完全一致。
//   ② cleared（重置存根）**一律剔除**，它不是一次作答。
//   ③ 某天没数据 → 该点必须是 null，让折线**断开**。绝不补 0、绝不把相邻两天连起来
//      （补 0 会被读成「这天考了 0 分」，跨缺口连线会被读成「慢慢下滑」，都是假信息）。
//
// 返回：{ days: [{ day, q, acc, stages }], avg: 有份量的平均值, covered: 有效天数, total: 总天数 }
//   · avg = 全期累计 正确题数 / 总题数（加权），**不是**每日 acc 的算术平均。
//   · cum：逐日累计准确率（第 1 天=第 1 天，第 2 天=前 2 天合计…），用于「平均准确率走势」。
function dashUserDailyAcc(r, totalDays) {
  const recs = (r && Array.isArray(r.chy)) ? r.chy.filter(Boolean) : []
  const N = Math.max(1, Number(totalDays) || 7)
  // ① 按 (day|si) 取首答
  const first = {}
  recs.forEach(x => {
    if (x.cleared) return                              // ② 重置存根不算作答
    const day = Number(x.day) || 0
    if (day < 1 || day > N) return                     // 越界天数（老方案 210 题口径的残留）丢弃
    const q = Number(x.total) || 0
    if (q <= 0) return
    const k = day + '|' + (Number(x.si) || 0)
    const at = Number(x.at) || 0
    if (!first[k] || at < (Number(first[k].at) || 0)) first[k] = { day, q, c: Number(x.correct) || 0, at, kind: String(x.kind || 'practice') }
  })
  // ③ 按天加权合并
  const byDay = {}
  Object.keys(first).forEach(k => {
    const it = first[k]
    if (!byDay[it.day]) byDay[it.day] = { q: 0, c: 0, stages: 0 }
    byDay[it.day].q += it.q
    byDay[it.day].c += Math.max(0, Math.min(it.q, it.c))   // 脏数据兜底：correct 不得超过 total
    byDay[it.day].stages += 1
  })
  const days = []
  let cq = 0, cc = 0, covered = 0
  for (let d = 1; d <= N; d++) {
    const b = byDay[d]
    if (!b || b.q <= 0) {
      // ★ null = 该天无数据 → 折线断开。绝不写 0。
      days.push({ day: d, q: 0, acc: null, cum: cq > 0 ? Math.round(cc / cq * 100) : null, stages: 0 })
      continue
    }
    covered++
    cq += b.q; cc += b.c
    days.push({
      day: d, q: b.q, c: b.c, stages: b.stages,
      acc: Math.round(Math.min(1, b.c / b.q) * 100),
      cum: Math.round(Math.min(1, cc / cq) * 100),
    })
  }
  return {
    days,
    avg: cq > 0 ? Math.round(Math.min(1, cc / cq) * 100) : null,
    covered,
    total: N,
  }
}

// ====== v195：每日准确率走势扩展到「全部营次」 ======
// 用户诉求（10-21 原话）：「新增加的走势图能否包含所有的过去的七天挑战？」
//
// 做法：把 chy 按 rd 分组（组序 = 组内最早作答时间升序，与 dashUserRoundSeries 的
// 「第一次参与先后」一致），每组跑一遍 dashUserDailyAcc（7 天全展开），然后把所有组
// 的天**顺序拼接**成一条 X 轴：标签 `1·D3` = 第 1 个营次的第 3 天。
//
// ★ 三条红线：
//   ① 累计（平均）线**跨营次延续**——「平均准确率」的语义是「到目前为止整体什么水平」，
//     在营次边界重置 cum 会让第 2 期 D1 看起来像「从头开始」，掩盖跨期的真实水平。
//   ② 缺天 = null 断线（沿 v194 红线）；老数据 rd 为空 → 归入第 1 组（legacy 兜底）。
//   ③ 组数不封顶，X 轴自然变宽（_upLineChartSvg 已有横向滚动）；标签用 `n·Dm` 短码，
//     因为营次全名（「标帜餐厅七天挑战第三期」）放不进 X 轴，全名只在表格里。
function dashUserDailyAllAcc(r) {
  const recs = (r && Array.isArray(r.chy)) ? r.chy.filter(Boolean) : []
  const slugOf = x => (typeof dashRoundSlug === 'function') ? dashRoundSlug(x.rd || '') : String(x.rd || '')
  const groups = {}
  const order = []
  recs.forEach(x => {
    if (x.cleared) return
    const k = slugOf(x) || ''
    if (!groups[k]) { groups[k] = []; order.push(k) }
    groups[k].push(x)
  })
  // 组按「最早一条记录的 at」升序 —— 时间线顺序，不是营次创建顺序
  order.sort((a, b) => {
    const ta = groups[a].length ? Math.min.apply(null, groups[a].map(x => Number(x.at) || 0)) : 0
    const tb = groups[b].length ? Math.min.apply(null, groups[b].map(x => Number(x.at) || 0)) : 0
    return (ta - tb) || String(a).localeCompare(String(b))
  })
  const rdList = (typeof dashRoundList === 'function') ? dashRoundList() : []
  const nameOf = slug => {
    const hit = rdList.filter(x => ((typeof dashRoundSlug === 'function') ? dashRoundSlug(x.id) : x.id) === slug)[0]
    return (hit && hit.name) || slug
  }
  const cells = []
  let cq = 0, cc = 0, covered = 0
  // v196：单营次天数按营次结构取（'v3' = 21 天，其余 = 7 天）—— 绝不写死 7，
  //   否则 21 天营次的第 8 天起会被 dashUserDailyAcc 的 day>N 过滤整段丢弃。
  const daysOfSlug = slug => {
    const hit = rdList.filter(x => ((typeof dashRoundSlug === 'function') ? dashRoundSlug(x.id) : x.id) === slug)[0]
    return (hit && hit.chPlan === 'v3') ? 21 : 7
  }
  order.forEach((slug, gi) => {
    const d = dashUserDailyAcc({ chy: groups[slug] }, daysOfSlug(slug))
    d.days.forEach(x => {
      const has = x.q > 0
      if (has) { cq += x.q; cc += x.c; covered++ }
      cells.push({
        label: (gi + 1) + '·D' + x.day,
        roundNo: gi + 1,
        round: nameOf(slug),
        day: x.day, q: x.q, c: x.c, stages: x.stages,
        acc: x.acc,
        // ★ 全局累计：跨营次延续，不在组边界重置
        cum: cq > 0 ? Math.round(Math.min(1, cc / cq) * 100) : null,
      })
    })
  })
  return {
    cells,
    avg: cq > 0 ? Math.round(Math.min(1, cc / cq) * 100) : null,
    covered,
    roundCount: order.length,
  }
}

// 线下课：该学员在各班级任务上的成绩序列（只读）。offline 无分数、video 取小测分。
function dashUserCourseSeries(courseDoc, username) {
  const u = String(username || '')
  const out = []
  const classes = (courseDoc && Array.isArray(courseDoc.classes)) ? courseDoc.classes : []
  classes.forEach(c => {
    const members = Array.isArray(c && c.members) ? c.members : []
    const assigns = Array.isArray(c && c.assignments) ? c.assignments : []
    assigns.forEach(a => {
      if (!a || a.status === 'draft') return        // 草稿未发布 → 不算
      const res = (a.results || {})[u]
      if (!res) return
      const ty = String(a.type || '')
      let sc = null
      if (ty === 'exam' || ty === 'coursefinal' || ty === 'homework') {
        const n = Number(res.score)
        sc = Number.isFinite(n) ? n : null
      } else if (ty === 'video') {
        const n = Number(res.quizScore)
        sc = Number.isFinite(n) ? n : null
      }
      out.push({
        className: c.name || '', title: a.title || '', type: ty, score: sc,
        at: Number(res.at) || 0, attempts: Number(res.attempts) || 0,
        done: (typeof _courseCellDone === 'function') ? _courseCellDone(a, res) : !!(res && res.done),
        isMember: members.indexOf(u) >= 0,
      })
    })
  })
  return out.sort((a, b) => (a.at || 0) - (b.at || 0))
}

// ====== v193：学员档案「错题」======
// 数据来源与口径（都来自云端 base 记录的既有字段，未新增任何上报）：
//   · r.chQ  = 七天挑战里答错的题（只在该题**最终仍答错**时 +1，见 cloud-store 'perq' 的 d.ch 分支）
//   · r.perQ = 普通练习/考试里答错的题（答对不再记录，所以这里只会有错题）
//   两者都是 { qid: { correct, total } } —— **没有时间戳**，所以只能按「错了几次」排序，
//   绝不能编一个「最近错题」顺序出来（那是伪造信息）。
//
// ★★ 三条红线：
//   ① 题面一律从 Store.getQuestions() 现取（种子 + 派生 + 上传 + 云端 upq 的唯一入口），
//      绝不把题干冗余存进云端 —— storage 只有 1MB，且题库改了题干后冗余副本会立刻过期。
//   ② 取不到题面的 qid（历史遗留 id / 已被删除的题）**不静默丢弃**，单独计数并说明，
//      否则用户会以为「我明明错了 20 题怎么只显示 12 道」。
//   ③ 只读。不写任何存储、不上报、不改 chQ/perQ。
function dashUserWrongList(row, questions) {
  const r = row || {}
  const pool = Array.isArray(questions) ? questions : []
  const byId = new Map()
  pool.forEach(q => { if (q && q.id != null) byId.set(String(q.id), q) })

  const collect = (src, bucket) => {
    const tbl = (r[src] && typeof r[src] === 'object') ? r[src] : {}
    Object.keys(tbl).forEach(qid => {
      const rec = tbl[qid] || {}
      const total = Number(rec.total) || 0
      if (total <= 0) return
      // correct/total 口径：只有「一次都没答对」才是纯错题；混有答对的仍算错题，但错次取 total-correct
      const wrong = Math.max(0, total - (Number(rec.correct) || 0))
      if (wrong <= 0) return
      bucket.push({ qid: String(qid), wrong, total, q: byId.get(String(qid)) || null })
    })
  }

  const ch = [], pr = []
  collect('chQ', ch)
  collect('perQ', pr)

  const pack = arr => arr
    .sort((a, b) => (b.wrong - a.wrong) || (String(a.qid) < String(b.qid) ? -1 : 1))
    .map(x => ({
      qid: x.qid,
      wrong: x.wrong,
      question: x.q ? String(x.q.question || '') : '',
      type: x.q ? String(x.q.type || '') : '',
      options: (x.q && Array.isArray(x.q.options)) ? x.q.options.map(o => String(o == null ? '' : o)) : [],
      answer: (x.q && Array.isArray(x.q.answer)) ? x.q.answer.slice() : [],
      explanation: x.q ? String(x.q.explanation || '') : '',
      found: !!x.q,
    }))

  const chP = pack(ch), prP = pack(pr)
  const miss = chP.concat(prP).filter(x => !x.found).length
  return {
    challenge: chP,
    practice: prP,
    total: chP.length + prP.length,
    missing: miss,                    // 题面取不到的条数（仍计入 total）
    found: chP.length + prP.length - miss,
  }
}

// 手绘 SVG 折线图。series = [{ name, color, values:[num|null] }]；null = 该点没数据。
//   ★ 缺值必须断线，不能跨缺口连直线 —— 那等于用视线编造出一段不存在的走势。
function _upLineChartSvg(opt) {
  opt = opt || {}
  const labels = Array.isArray(opt.labels) ? opt.labels : []
  const series = (Array.isArray(opt.series) ? opt.series : []).filter(s => s && Array.isArray(s.values))
  let n = Math.max(labels.length, 1)
  series.forEach(s => { n = Math.max(n, s.values.length) })
  let yMin = (opt.yMin == null) ? 0 : Number(opt.yMin)
  let yMax = (opt.yMax == null) ? 100 : Number(opt.yMax)
  let ticks = Array.isArray(opt.yTicks) ? opt.yTicks : [0, 25, 50, 75, 100]
  // ★ 分数轴按**本人实际分数**自适应（10-20 两轮反馈：先「每 25 分太大了」→ 再「100 和 95
  //   这种曲线弧度能否明显点」）。固定 60–100 跨 40 分，5 分的差只占图高 1/8，看着就是平的。
  //   现在粒度跟着数据跨度走：跨度 ≤20 用 5 分档、≤55 用 10 分档、更大用 20 分档。
  //   ★ 硬底线不能破：yMin 恒 ≤ 本图最低分（向下取整再留一格），**绝不把点画到框外**。
  //     真实数据最低 35 分（523 条里 7 条 <60），所以不能为了放大一律切 60。
  if (opt.scoreAxis) {
    let low = Infinity, high = -Infinity
    series.forEach(s => s.values.forEach(v => {
      const num = Number(v)
      if (v != null && Number.isFinite(num)) {
        low = Math.min(low, num)
        high = Math.max(high, num)
      }
    }))
    if (!Number.isFinite(low)) { low = 100; high = 100 }
    const raw = high - low
    const step0 = (raw <= 20) ? 5 : (raw <= 55 ? 10 : 20)
    // 上下各留一格余量，令点不贴边
    let lo = Math.floor((low - step0) / step0) * step0
    if (lo < 0) lo = 0
    let hi = Math.ceil((high + step0) / step0) * step0
    if (hi > 100) hi = 100            // 分数制上限就是 100
    if (hi <= lo) hi = lo + step0
    // 至少 3 个刻度段 —— 只有 2 段时两个点会贴着上下边框，反而看不出走势
    while ((hi - lo) / step0 < 3 && lo - step0 >= 0) lo -= step0
    yMin = lo
    yMax = hi
    ticks = []
    for (let v = lo; v <= hi; v += step0) ticks.push(v)
  }
  const tickText = (typeof opt.tickText === 'function') ? opt.tickText : (v => String(v))
  const W = Math.max(460, 76 * (n - 1) + 108)
  // ★ 10-20 用户「这个趋势线不明显 我希望更明显一点」→ 图长高 22px、线加粗到 3.4、
  //   点改实心、每根线加一条向下淡出的渐变面积。单靠一根 2px 的线在 90~100 之间
  //   几乎看不出起伏，面积把「量」显出来，趋势才立得住。
  const H = 232
  const padL = 46, padR = 18, padT = 26, padB = 40
  const iw = W - padL - padR, ih = H - padT - padB
  const baseY = padT + ih
  const xOf = i => padL + (n === 1 ? iw / 2 : iw * i / (n - 1))
  const yOf = v => padT + ih - ih * ((Number(v) - yMin) / Math.max(1e-6, yMax - yMin))
  const grid = ticks.map(v => `<line x1="${padL}" y1="${yOf(v).toFixed(1)}" x2="${W - padR}" y2="${yOf(v).toFixed(1)}" stroke="#e9edf3" stroke-width="1"></line>`
    + `<text x="${padL - 8}" y="${(yOf(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${escHtml(String(tickText(v)))}</text>`).join('')
  const shortLb = lb => {
    const s = String(lb == null ? '' : lb)
    // ★ 截断必须保留**尾部**：实测营次名是「标帜餐厅七天挑战第一期 / 第二期」，
    //   砍掉后半段会让两期标签长得一模一样（10-20 真实数据踩到），尾部才是区分点。
    return s.length > 6 ? '…' + s.slice(-5) : s
  }
  const xLabels = labels.map((lb, i) =>
    `<text x="${xOf(i).toFixed(1)}" y="${H - padB + 17}" text-anchor="middle" font-size="11" fill="#6b7280">${escHtml(shortLb(lb))}</text>`).join('')
  // 渐变面积 id：同色同序号可能跨图重复，但重复时定义完全一致（同色同透明度），取哪份都一样。
  const gradId = (s, i) => 'upg' + String(s.color || '#000').replace(/[^0-9a-zA-Z]/g, '') + '_' + i
  // opt.area === false → 不画面积（定级图：L1–L4 是离散档位，填了会被误读成「等级 25% 满」）
  const defs = (opt.area === false) ? '' : series.map((s, i) => `<linearGradient id="${gradId(s, i)}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${s.color}" stop-opacity="0.26"></stop>`
    + `<stop offset="100%" stop-color="${s.color}" stop-opacity="0.01"></stop></linearGradient>`).join('')
  const areas = (opt.area === false) ? '' : series.map((s, i) => {
    // ★ 面积同样必须按「连续段」闭合 —— 缺值处断开，绝不跨缺口连成一块（同折线红线）
    const segs = []
    let cur = []
    s.values.forEach((v, idx) => {
      const num = Number(v)
      if (v == null || !Number.isFinite(num)) { if (cur.length) segs.push(cur); cur = []; return }
      cur.push({ x: xOf(idx), y: yOf(num) })
    })
    if (cur.length) segs.push(cur)
    const d = segs.filter(g => g.length >= 2).map(g => {
      let p = 'M' + g[0].x.toFixed(1) + ' ' + baseY.toFixed(1)
      g.forEach(q => { p += 'L' + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + ' ' })
      return p + 'L' + g[g.length - 1].x.toFixed(1) + ' ' + baseY.toFixed(1) + ' Z'
    }).join(' ')
    return d ? `<path d="${d}" fill="url(#${gradId(s, i)})" stroke="none"></path>` : ''
  }).join('')
  const paths = series.map(s => {
    let d = '', pen = false
    s.values.forEach((v, i) => {
      const num = Number(v)
      if (v == null || !Number.isFinite(num)) { pen = false; return }
      d += (pen ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(num).toFixed(1) + ' '
      pen = true
    })
    const dots = s.values.map((v, i) => {
      const num = Number(v)
      if (v == null || !Number.isFinite(num)) return ''
      return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(num).toFixed(1)}" r="4.4" fill="${s.color}" stroke="#fff" stroke-width="2.2"></circle>`
        // 标签压在面积上也要读得清 → 白色描边打底（paint-order 让描边画在字下面）
        + `<text x="${xOf(i).toFixed(1)}" y="${(yOf(num) - 10).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${s.color}" stroke="#fff" stroke-width="3.2" paint-order="stroke" stroke-linejoin="round">${escHtml(String(num))}</text>`
    }).join('')
    return `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"></path>${dots}`
  }).join('')
  const legend = series.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#6b7280">`
    + `<span style="width:16px;height:4px;border-radius:2px;background:${s.color};display:inline-block"></span>${escHtml(s.name || '')}</span>`).join('')
  return `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" style="display:block"><defs>${defs}</defs>${grid}${areas}${xLabels}${paths}</svg>
    </div>
    ${legend ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin:6px 0 0">${legend}</div>` : ''}`
}

// 姓名单元格里的可点链接。★ 用户名走 data-u（v85 教训：名字里一个引号就能截断内联 onclick）
function upNameLink(username, text) {
  const u = String(username || '')
  if (!u) return escHtml(text || '—')
  return `<a href="javascript:void 0" class="up-link" data-u="${escAttr(u)}" title="${escAttr(t('upOpenHint'))}" onclick="openUserProfileFromEl(this)">${escHtml(text || u)}</a>`
}
function openUserProfileFromEl(el) {
  if (!el || !el.dataset) return
  openUserProfile(el.dataset.u || '')
}
function closeUserProfile() {
  const el = document.getElementById('upProfileModal')
  if (el) el.remove()
}

// 档案弹窗内容（纯函数，便于沙箱断言）
function _upProfileHtml(r, courseDoc, events, wrong) {
  r = r || {}
  const u = String(r.username || '')
  const rounds = dashUserRoundSeries(r)
  const lvPts = dashUserLevelSeries(u, events, r.chLevel)
  const courses = dashUserCourseSeries(courseDoc, u)
  const lvNow = Number(r.chLevel) || 0
  const lvBadge = lvNow
    ? `<span class="level-badge level-${lvNow}" title="${escAttr(t('dashChLevelTip'))}">L${lvNow}</span>`
    : `<span style="color:#9ca3af;font-size:12px">${t('dashChLevelNone')}</span>`
  const fmtAt = ts => (ts ? new Date(ts).toLocaleDateString(LANG === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit' }) : '—')
  const dash = v => (v == null ? '<span style="color:#9ca3af">—</span>' : String(v))

  // ---- 七天挑战：每日准确率走势 + 累计（平均）准确率走势 ----
  // ★ v195 起覆盖**全部营次**（用户 10-21：「新增加的走势图能否包含所有的过去的七天挑战？」）：
  //   X 轴 = 期序·天（`1·D3`），组按最早作答时间升序拼接；累计线跨营次延续不重置。
  //   老数据 rd 为空 → 归入第 1 组兜底。单营次学员效果与 v194 完全一致。
  const dailyAll = dashUserDailyAllAcc(r)
  const hasDaily = dailyAll.covered > 0
  const dailyChart = hasDaily
    ? _upLineChartSvg({
        labels: dailyAll.cells.map(x => x.label),
        series: [{ name: t('upSeriesDailyAcc'), color: '#0891b2', values: dailyAll.cells.map(x => x.acc) }],
        scoreAxis: true,
      })
    : ''
  // 平均（累计）准确率：第 n 个点 = 从第 1 期 D1 到现在的**合并**正确率（跨营次延续）。
  // ★ 不画「每日 acc 的算术平均」——那会让单日波动把整条平均线拽歪，
  //   而且与表里的 firstAcc 口径不一致。累计口径天然平滑，才是「平均水平怎么走」。
  const cumChart = hasDaily
    ? _upLineChartSvg({
        labels: dailyAll.cells.map(x => x.label),
        series: [{ name: t('upSeriesCumAcc'), color: '#7c3aed', values: dailyAll.cells.map(x => x.cum) }],
        scoreAxis: true,
      })
    : ''
  const dailyRows = dailyAll.cells.filter(x => x.q > 0)
  const dailyTable = hasDaily
    ? `<table class="admin-table" style="font-size:12px;min-width:520px;margin-top:8px">
        <thead><tr><th>${t('upThRound')}</th><th ${'style="text-align:center;color:#6b7280;font-weight:700;font-size:12px"'}>${t('upThDay')}</th><th style="text-align:center;color:#6b7280;font-size:12px">${t('upThDailyQ')}</th>
        <th style="text-align:center;color:#6b7280;font-size:12px">${t('upThDailyAcc')}</th>
        <th style="text-align:center;color:#6b7280;font-size:12px">${t('upThCumAcc')}</th></tr></thead>
        <tbody>${dailyRows.map(x => {
          // ★ 题量少于 10 的天标灰 + 加注：实测有「3 题 100%」这种点，加权时它只贡献 3 题，
          //   但读者看着 100% 会以为那天学得最好。不隐去、不篡改，只如实标注样本太小。
          const thin = x.q < 10
          const qCell = thin ? `<span style="color:#b45309" title="${escAttr(t('upDailyThinTip'))}">${x.q}*</span>` : String(x.q)
          return `<tr>
          <td style="white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis">${escHtml(x.round || '—')}</td>
          <td style="text-align:center;white-space:nowrap">${x.roundNo}·D${x.day}</td>
          <td style="text-align:center">${qCell}</td>
          <td style="text-align:center;font-weight:700;color:#0891b2">${x.acc == null ? '<span style="color:#9ca3af">—</span>' : x.acc + '%'}</td>
          <td style="text-align:center;font-weight:700;color:#7c3aed">${x.cum == null ? '<span style="color:#9ca3af">—</span>' : x.cum + '%'}</td>
        </tr>`
        }).join('')}</tbody>
      </table>
      ${dailyRows.some(x => x.q < 10) ? `<p class="form-hint" style="margin:4px 0 0">${t('upDailyThinNote')}</p>` : ''}` : ''

  // ---- 七天挑战：分数走势（前测 / 期末两条线）----
  const chLabels = rounds.map(x => x.name)
  const chChart = rounds.length
    ? _upLineChartSvg({
        labels: chLabels,
        series: [
          { name: t('upSeriesPre'), color: '#2563eb', values: rounds.map(x => x.pre) },
          { name: t('upSeriesFinal'), color: '#059669', values: rounds.map(x => x.final) },
        ],
        scoreAxis: true,
      })
    : `<div style="padding:18px;text-align:center;color:#9ca3af;font-size:13px">${t('upNoChallenge')}</div>`
  const chRows = rounds.map(x => {
    const d = (x.pre != null && x.final != null) ? (x.final - x.pre) : null
    const dTxt = d == null ? '<span style="color:#9ca3af">—</span>'
      : `<span style="font-weight:700;color:${d > 0 ? '#059669' : d < 0 ? '#dc2626' : '#6b7280'}">${d > 0 ? '+' + d : d}</span>`
    return `<tr>
      <td style="white-space:nowrap">${escHtml(x.name)}</td>
      <td style="text-align:center;color:#6b7280;font-size:12px;white-space:nowrap">${fmtAt(x.at)}</td>
      <td style="text-align:center;font-weight:700;color:#2563eb">${dash(x.pre)}</td>
      <td style="text-align:center;font-weight:700;color:#059669">${dash(x.final)}</td>
      <td style="text-align:center">${dTxt}</td>
      <td style="text-align:center">${x.q}</td>
      <td style="text-align:center">${x.firstAcc == null ? '<span style="color:#9ca3af">-</span>' : x.firstAcc + '%'}</td>
      <td style="text-align:center;color:#6b7280">${x.days}</td>
    </tr>`
  }).join('')

  // ---- 定级走势 ----
  // ★ 只有一个点时不画图（单点折线毫无「走势」可言，看着像坏掉）：
  //   改为徽章 + 说明。存量学员常见这种情形 —— 等级是 v166 迁移直接写进 base 的，没有事件历史。
  const lvChart = lvPts.length >= 2
    ? _upLineChartSvg({
        labels: lvPts.map(p => (p.at ? fmtAt(p.at) : t('upNow'))),
        series: [{ name: t('upSeriesLevel'), color: '#7c3aed', values: lvPts.map(p => p.lv) }],
        yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], area: false,
        tickText: v => (Number(v) === 0 ? t('upLvNone') : 'L' + v),
      })
    : ''
  const lvFlat = `<div style="padding:12px 0;text-align:center;color:#6b7280;font-size:13px">
      <div style="margin-bottom:4px">${t('upLevelNow')}：${lvBadge}</div>
      <div style="color:#9ca3af;font-size:12px">${lvPts.length === 1 ? t('upLvSingle') : t('upLvNoHistory')}</div>
    </div>`

  // ---- 线下课：分数走势 + 明细 ----
  const scored = courses.filter(c => c.score != null)
  const coChart = scored.length
    ? _upLineChartSvg({
        labels: scored.map((c, i) => '#' + (i + 1)),
        series: [{ name: t('upSeriesCourse'), color: '#d97706', values: scored.map(c => c.score) }],
        scoreAxis: true,
      })
    : ''
  const typeLabel = ty => (typeof courseAssignTypeLabel === 'function') ? courseAssignTypeLabel(ty) : ty
  const coRows = courses.map((c, i) => {
    // 图上标签 #n 与表格序号一一对应（任务名太长，塞不进 X 轴）
    const idx = (c.score != null) ? '#' + (scored.indexOf(c) + 1) : '—'
    return `<tr>
      <td style="text-align:center;color:#6b7280;font-size:12px">${idx}</td>
      <td style="white-space:nowrap;color:#6b7280;font-size:12px">${escHtml(c.className)}</td>
      <td>${escHtml(c.title)}</td>
      <td style="text-align:center;color:#6b7280;font-size:12px;white-space:nowrap">${escHtml(typeLabel(c.type))}</td>
      <td style="text-align:center">${c.done ? '✅' : '<span style="color:#9ca3af">—</span>'}</td>
      <td style="text-align:center;font-weight:700;color:#d97706">${c.score == null ? '<span style="color:#9ca3af">—</span>' : c.score}</td>
      <td style="text-align:center;color:#6b7280;font-size:12px;white-space:nowrap">${fmtAt(c.at)}</td>
    </tr>`
  }).join('')

  const th = 'style="text-align:center;color:#6b7280;font-weight:700;font-size:12px"'
  return `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0 0 4px;font-size:17px">👤 ${escHtml(r.name || u)} <span style="font-size:12px;color:#6b7280;font-weight:400">${escHtml(u)}</span></h3>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#6b7280">
          <span>${escHtml(r.dept || '—')}</span>
          <span>·</span>
          <span>${t('upLevelNow')}：${lvBadge}</span>
          <span>·</span>
          <span>${t('upRoundCount', rounds.length)}</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="closeUserProfile()">✕ ${t('upClose')}</button>
    </div>

    <h4 style="margin:16px 0 6px;font-size:14px">📈 ${t('upDailyTitle')}</h4>
    <p class="form-hint" style="margin:0 0 6px">${t('upDailyHint', dailyAll.roundCount, dailyAll.covered, dailyAll.avg == null ? '—' : dailyAll.avg + '%')}</p>
    ${hasDaily ? `${dailyChart}` : `<div style="padding:14px;text-align:center;color:#9ca3af;font-size:13px">${t('upDailyNone')}</div>`}
    ${hasDaily ? `<div style="margin-top:4px"><span style="font-size:12px;font-weight:700;color:#374151">${t('upCumTitle')}</span></div>${cumChart}${dailyTable}` : ''}

    <h4 style="margin:18px 0 6px;font-size:14px">🏅 ${t('upChTitle')}</h4>
    <p class="form-hint" style="margin:0 0 6px">${t('upChHint')}</p>
    ${chChart}
    ${rounds.length ? `<div style="overflow-x:auto;margin-top:10px">
      <table class="admin-table" style="font-size:12px;min-width:560px">
        <thead><tr>
          <th>${t('upThRound')}</th><th ${th}>${t('upThStart')}</th>
          <th ${th}>${t('dashChColPre')}</th><th ${th}>${t('dashChColFinal')}</th><th ${th}>${t('dashChColChange')}</th>
          <th ${th}>${t('dashChColQ')}</th><th ${th}>${t('dashChTotalThFirst')}</th><th ${th}>${t('upThDays')}</th>
        </tr></thead>
        <tbody>${chRows}</tbody>
      </table></div>` : ''}

    <h4 style="margin:18px 0 6px;font-size:14px">🎚️ ${t('upLvTitle')}</h4>
    <p class="form-hint" style="margin:0 0 6px">${t('upLvHint')}</p>
    ${lvChart || lvFlat}

    <h4 style="margin:18px 0 6px;font-size:14px">🏫 ${t('upCourseTitle')}</h4>
    <p class="form-hint" style="margin:0 0 6px">${t('upCourseHint')}</p>
    ${coChart}
    ${courses.length ? `<div style="overflow-x:auto;margin-top:10px">
      <table class="admin-table" style="font-size:12px;min-width:600px">
        <thead><tr>
          <th ${th}>#</th><th>${t('upThClass')}</th><th>${t('upThTask')}</th>
          <th ${th}>${t('upThType')}</th><th ${th}>${t('upThDone')}</th><th ${th}>${t('upThScore')}</th><th ${th}>${t('upThStart')}</th>
        </tr></thead>
        <tbody>${coRows}</tbody>
      </table></div>` : `<div style="padding:18px;text-align:center;color:#9ca3af;font-size:13px">${t('upNoCourse')}</div>`}

    <h4 style="margin:18px 0 6px;font-size:14px">✍️ ${t('upWrongTitle')}
      ${wrong && wrong.total ? `<span style="font-size:12px;color:#dc2626;font-weight:700">(${wrong.total})</span>` : ''}</h4>
    <p class="form-hint" style="margin:0 0 6px">${t('upWrongHint')}</p>
    ${_upWrongSectionHtml(wrong)}
  `
}

async function openUserProfile(username) {
  const u = String(username || '').trim()
  if (!u) return
  const old = document.getElementById('upProfileModal')
  if (old) old.remove()
  const box = document.createElement('div')
  box.id = 'upProfileModal'
  box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.45);padding:16px;overflow-y:auto'
  box.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:880px;width:100%;margin:auto;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.2)">
      <div style="padding:24px;text-align:center;color:#6b7280">☁️ ${t('cloudLoading')}</div>
    </div>`
  document.body.appendChild(box)
  box.addEventListener('click', e => { if (e.target === box) closeUserProfile() })
  const inner = box.firstElementChild
  let rows = null, courseDoc = null
  try {
    const jobs = [
      (typeof CloudSync !== 'undefined' && CloudSync.getDashboardData)
        ? CloudSync.getDashboardData().catch(() => null)
        : Promise.resolve(null),
      (typeof CourseStore !== 'undefined' && CourseStore.getDoc)
        ? CourseStore.getDoc().catch(() => null)
        : Promise.resolve(null),
    ]
    const res = await Promise.all(jobs)
    rows = res[0]; courseDoc = res[1]
  } catch (e) { /* 离线：下面按「无数据」渲染 */ }
  const r = (Array.isArray(rows) ? rows : []).filter(x => x && x.username === u)[0] || null
  // 等级事件：getDashboardData 已把本次重放用的事件流挂在 _lastEvents 上（cloud-store v189）
  const events = (typeof CloudSync !== 'undefined' && Array.isArray(CloudSync._lastEvents)) ? CloudSync._lastEvents : []
  if (!r) {
    inner.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <h3 style="margin:0;font-size:16px">👤 ${escHtml(u)}</h3>
        <button class="btn btn-ghost btn-sm" onclick="closeUserProfile()">✕ ${t('upClose')}</button>
      </div>
      <p style="margin:16px 0;color:#92400e;font-size:13px">${t('upNoCloudRow')}</p>`
    return
  }
  inner.innerHTML = _upProfileHtml(r, courseDoc, events, dashUserWrongList(r,
    (typeof Store !== 'undefined' && Store.getQuestions) ? Store.getQuestions() : []))
}

// 学员档案：错题卡片（纯函数，便于沙箱断言）。
// 展示顺序：先「错得最多」——次数是最有信息量的维度（同一题错 5 次 vs 错 1 次，处理优先级完全不同）。
function _upWrongCardHtml(item, idx) {
  const q = item || {}
  // ★ 题型标签走既有 t('typeLabels') 表（不要自造 typeSingle 这类不存在的键，
  //   t() 对未知键原样返回键名，会直接在界面显示 "typeSingle"）
  const tyLabel = (ty) => {
    const m = (typeof t === 'function' && t('typeLabels')) || {}
    return (m && m[ty]) || ty || '—'
  }
  // 题型 → 正确答案的展示形式。listen/voicematch 的「选项」就是候选读音文本，
  // 直接列出会被误读成「多个正确答案」，所以只标出正确那一条。
  const ty = String(q.type || '')
  const ansIdx = Array.isArray(q.answer) ? q.answer : []
  const opts = Array.isArray(q.options) ? q.options : []
  let ansHtml = ''

  if (!ansIdx.length) {
    ansHtml = `<span style="color:#9ca3af">${t('upWrongNoAnswer')}</span>`
  } else if (ty === 'fill' || ty === 'translate') {
    // 这两类 options[0] 就是参考答案（见 store 的 compactUploadedOptions 注释）
    ansHtml = `<span style="color:#059669;font-weight:700">${escHtml(opts[0] == null ? '' : opts[0])}</span>`
  } else if (ty === 'judge' && opts.length >= 2) {
    ansHtml = ansIdx.map(i => `<span style="color:#059669;font-weight:700">${escHtml(opts[i] == null ? '' : opts[i])}</span>`).join(' / ')
  } else if (opts.length) {
    // single / multiple / listen / voicematch / pronounce：按下标取
    ansHtml = ansIdx.map(i => {
      const v = opts[i]
      return `<span style="color:#059669;font-weight:700">${escHtml(v == null ? '—' : v)}</span>`
    }).join(' / ')
  } else {
    ansHtml = ansIdx.map(i => `<span style="color:#059669;font-weight:700">${escHtml(String(i))}</span>`).join(', ')
  }

  // 题面：listen/voicematch 的题干可能是中文提示（如「选出正确英文」），也可能就是英文原文
  const stem = String(q.question || '')
  const stemHtml = q.found
    ? escHtml(stem.length > 160 ? stem.slice(0, 160) + '…' : stem)
    : `<span style="color:#9ca3af;font-style:italic">(#${escHtml(q.qid)} 题干已不在题库)</span>`

  return `<div style="border:1px solid #eef0f3;border-radius:8px;padding:9px 11px;margin-bottom:7px;background:#fff">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span style="flex:none;min-width:22px;text-align:center;font-size:11px;font-weight:700;color:#dc2626;background:#fef2f2;border-radius:5px;padding:1px 5px">${idx}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;line-height:1.5">${stemHtml}</div>
          <div style="margin-top:5px;font-size:12px;color:#6b7280">
            <span>${t('upWrongAnswer')}：</span>${ansHtml}
          </div>
          <div style="margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#9ca3af">
            <span>${escHtml(tyLabel(ty))}</span>
            <span style="color:#dc2626;font-weight:700">${t('upWrongTimes', q.wrong || 0)}</span>
          </div>
        </div>
      </div>
    </div>`
}

function _upWrongSectionHtml(wrong) {
  const w = wrong || { challenge: [], practice: [], total: 0, missing: 0 }
  if (!w.total) {
    return `<div style="padding:16px;text-align:center;color:#9ca3af;font-size:13px">${t('upWrongNone')}</div>`
  }
  const group = (list, title) => {
    if (!list.length) return ''
    return `<div style="margin-top:10px">
        <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px">${title}
          <span style="color:#9ca3af;font-weight:400">(${list.length})</span></div>
        ${list.map((x, i) => _upWrongCardHtml(x, i + 1)).join('')}
      </div>`
  }
  // 上限 60 条：再多就刷不动了（实测单人最多 92 条），超出部分只报数量，别让弹窗卡死
  const LIMIT = 60
  const trim = list => (list.length > LIMIT ? { show: list.slice(0, LIMIT), more: list.length - LIMIT } : { show: list, more: 0 })
  const chT = trim(w.challenge), prT = trim(w.practice)
  const moreNote = n => (n > 0 ? `<div style="margin-top:6px;color:#9ca3af;font-size:11.5px;text-align:center">… 还有 ${n} 道未列出</div>` : '')
  return `${w.missing ? `<p class="form-hint" style="margin:0 0 8px;color:#92400e">${t('upWrongMissing', w.missing)}</p>` : ''}
    ${group(chT.show, t('upWrongCh'))}${moreNote(chT.more)}
    ${group(prT.show, t('upWrongPr'))}${moreNote(prT.more)}`
}

// ====== 管理员看板：分类题库分布（按部门切换） ======
let dashDept = '' // '' 全部 | 'dining' | 'rooms'
function dashDeptStats() {
  return Store.getStats(dashDept || undefined)
}
function renderDashCatBlock() {
  const el = document.getElementById('dashCatBlock')
  if (!el) return
  const stats = dashDeptStats()
  const deptLabel = dashDept === 'dining' ? t('deptDining') : dashDept === 'rooms' ? t('deptRooms') : t('deptAll')
  el.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
        <h3 style="margin:0;font-size:16px">${t('dashCatTitle')}</h3>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm ${dashDept === '' ? 'btn-primary' : 'btn-ghost'}" onclick="setDashDept('')">${t('deptAll')}</button>
          <button class="btn btn-sm ${dashDept === 'dining' ? 'btn-primary' : 'btn-ghost'}" onclick="setDashDept('dining')">${t('deptDining')}</button>
          <button class="btn btn-sm ${dashDept === 'rooms' ? 'btn-primary' : 'btn-ghost'}" onclick="setDashDept('rooms')">${t('deptRooms')}</button>
        </div>
      </div>
      <p class="form-hint" style="margin-bottom:12px">${t('dashCatHint', deptLabel)}</p>
      <div class="category-progress">
        ${stats.categoryStats.map(cat => {
          const pct = cat.totalQuestions > 0 ? Math.round(cat.answered / cat.totalQuestions * 100) : 0
          const cls = pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red'
          return `<div class="cat-progress-item">
            <div class="cat-name">${cat.name}</div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill ${cls}" style="width:${pct}%"></div>
            </div>
            <div class="cat-stats">${cat.totalQuestions}${t('unitQuestion')} · ${cat.answered}${t('dashCatAnswered')} · ${cat.accuracy}%</div>
          </div>`
        }).join('')}
      </div>
    </div>
  `
}
function setDashDept(val) {
  dashDept = val
  renderDashCatBlock()
}

// ====== 每道题正确率（管理员看板）======
// 数据来源（v75 瘦身）：全局聚合 CloudSync._lastQStats（__q[qid]=[correct,total]，含对/错全量，
// 随云端 base 折叠保留）；个人 perQ 瘦身后只记错题，仅在 __q 缺该题时补充（防旧数据双算）
let perQDept = ''   // '' 全部 | 'dining' | 'rooms'
let perQSort = 'rate' // 'rate' 按正确率 | 'attempts' 按答题次数
function renderPerQBlock(rows) {
  const el = document.getElementById('perQBlock')
  if (!el) return
  // 1) 合并全题统计：__q 优先，旧完整 perQ 补充 __q 没有的题
  const agg = {}   // qid -> { correct, total }
  const _qs = (typeof CloudSync !== 'undefined' && CloudSync._lastQStats) || {}
  Object.keys(_qs).forEach(qid => {
    const a = _qs[qid]
    if (a && a.length === 2) agg[qid] = { correct: a[0], total: a[1] }
  })
  ;(rows || []).forEach(r => {
    if (!r || !r.perQ) return
    Object.keys(r.perQ).forEach(qid => {
      if (agg[qid]) return   // __q 已含该题全量（新语义），跳过避免错题双算
      const rec = r.perQ[qid]
      if (!rec) return
      const a = agg[qid] || (agg[qid] = { correct: 0, total: 0 })
      a.correct += rec.correct || 0
      a.total += rec.total || 0
    })
  })
  const qids = Object.keys(agg)
  const qMap = {}
  Store.getQuestions().forEach(q => { qMap[q.id] = q })
  // 3) 组装表格行（只显示有答题记录的题；v57：题目已从题库删除的记录直接丢弃，不再显示兜底行）
  let list = qids.filter(qid => qMap[qid]).map(qid => {
    const q = qMap[qid]
    const a = agg[qid]
    return {
      qid: q.id,
      question: q.question,
      category: Store.getCategoryName(q.category_id),
      difficulty: q.difficulty || 1,
      dept: q.dept || '',
      correct: a.correct,
      total: a.total,
      rate: a.total > 0 ? Math.round(a.correct / a.total * 100) : 0
    }
  })
  // 部门筛选（基于题目 dept）
  if (perQDept) list = list.filter(x => !x.dept || x.dept === 'all' || x.dept === perQDept)
  // 排序
  list.sort((a, b) => perQSort === 'attempts'
    ? b.total - a.total
    : a.rate - b.rate)
  const shown = list.slice(0, 100)
  const totalAnswered = list.reduce((s, x) => s + x.total, 0)
  const totalCorrect = list.reduce((s, x) => s + x.correct, 0)
  const overallRate = totalAnswered > 0 ? Math.round(totalCorrect / totalAnswered * 100) : 0
  // v163：每道题正确率也走全站统一配色（>90 绿 / 80–90 粉 / ≤80 红）；★ typeof 守卫见 accRateClass
  const trClass = r => (typeof accRateClass === 'function')
    ? accRateClass(r.rate)
    : (Number(r.rate) > 90 ? 'perq-good' : Number(r.rate) > 80 ? 'perq-high' : 'perq-low')
  el.innerHTML = `
    <h2 style="margin:24px 0 12px;font-size:18px">📈 ${t('perQTitle')}</h2>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <span style="font-size:13px;color:#6b7280">${t('perQHint')} · ${t('perQCovered', list.length)} · ${t('perQOverall', overallRate + '%')}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="input" onchange="perQSetDept(this.value)" style="width:auto">
            <option value="" ${perQDept === '' ? 'selected' : ''}>${t('deptAll')}</option>
            <option value="dining" ${perQDept === 'dining' ? 'selected' : ''}>${t('deptDining')}</option>
            <option value="rooms" ${perQDept === 'rooms' ? 'selected' : ''}>${t('deptRooms')}</option>
          </select>
          <button class="btn btn-sm ${perQSort === 'rate' ? 'btn-primary' : 'btn-ghost'}" onclick="perQSetSort('rate')">${t('perQSortRate')}</button>
          <button class="btn btn-sm ${perQSort === 'attempts' ? 'btn-primary' : 'btn-ghost'}" onclick="perQSetSort('attempts')">${t('perQSortAttempts')}</button>
        </div>
      </div>
      ${list.length === 0
        ? `<p class="form-hint" style="padding:12px 0">${t('perQEmpty')}</p>`
        : `<div style="overflow-x:auto"><table class="admin-table" style="font-size:13px">
            <thead><tr>
              <th>${t('perQThQid')}</th>
              <th style="min-width:220px">${t('perQThQuestion')}</th>
              <th>${t('perQThCat')}</th>
              <th>${t('perQThDiff')}</th>
              <th>${t('perQThResult')}</th>
              <th>${t('perQThRate')}</th>
            </tr></thead>
            <tbody>
              ${shown.map(x => `<tr>
                <td style="color:#6b7280">#${x.qid}</td>
                <td>${escHtml(x.question)}</td>
                <td>${escHtml(x.category)}</td>
                <td style="text-align:center">${x.difficulty}</td>
                <td style="text-align:center">${x.correct}/${x.total}</td>
                <td style="text-align:center"><span class="perq-rate ${trClass(x)}">${x.rate}%</span></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          ${list.length > 100 ? `<p class="form-hint" style="margin-top:8px">${t('perQMore', list.length - 100)}</p>` : ''}`}
    </div>
  `
}
function perQSetDept(val) {
  perQDept = val
  renderPerQBlockFromRows()
}
function perQSetSort(val) {
  perQSort = val
  renderPerQBlockFromRows()
}
// 重新渲染时复用最近一次 rows（避免重新拉云端）
let _perQLastRows = []
function renderPerQBlockFromRows() {
  renderPerQBlock(_perQLastRows)
}

async function clearAllPlacements() {
  if (!Store.isAdmin()) return
  if (!confirm(t('confirmClearPlacement'))) return
  // 1. 先清空本机
  Store.clearAllPlacements()
  // 2. 再清空云端
  let cloudMsg = ''
  if (typeof CloudSync !== 'undefined' && CloudSync.clearCloudPlacements) {
    try {
      const res = await CloudSync.clearCloudPlacements()
      if (res.done && res.cleared > 0) {
        cloudMsg = t('clearPlacementDone', res.cleared)
      } else if (res.done && res.cleared === 0) {
        cloudMsg = t('clearPlacementNone')
      } else {
        cloudMsg = t('clearPlacementFail')
      }
    } catch (e) {
      cloudMsg = t('clearPlacementFail')
    }
  }
  alert(cloudMsg || t('clearPlacementNone'))
  renderUsers()
}

function openUserModal() {
  const old = document.getElementById('userModal')
  if (old) old.remove()
  const modal = document.createElement('div')
  modal.id = 'userModal'
  modal.className = 'modal-overlay'
  modal.style.display = 'flex'
  modal.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <h3>${t('accountModalTitle')}</h3>
        <span class="modal-close" onclick="closeUserModal()">✕</span>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${t('username')} *</label>
          <input type="text" id="newUsername" placeholder="${t('usernameModalPh')}" />
        </div>
        <div class="form-group">
          <label>${t('password')} *</label>
          <input type="text" id="newPassword" placeholder="${t('passwordModalPh')}" />
        </div>
        <div class="form-group">
          <label>${t('fullName')} *</label>
          <input type="text" id="newName" placeholder="${t('nameModalPh')}" />
        </div>
        <div class="form-group">
          <label>${t('deptMajorOpt')}</label>
          <select id="newDeptMajor"></select>
        </div>
        <div class="form-group">
          <label>${t('deptSubOpt')}</label>
          <select id="newDeptSub" style="display:none"></select>
          <input type="text" id="newDeptOther" placeholder="${t('deptOtherPh')}" style="display:none" />
        </div>
        <div class="form-group">
          <label>${t('roleLabel')}</label>
          <select id="newRole">
            <option value="student">${t('roleStudent')}</option>
            <option value="admin">${t('roleAdmin')}</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="createUserAccount()">${t('createBtn')}</button>
        <button class="btn btn-ghost" onclick="closeUserModal()">${t('cancelBtn')}</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  buildDeptCascade(DEPT_GROUPS.userModal)
}
function closeUserModal() {
  const m = document.getElementById('userModal')
  if (m) m.remove()
}
async function createUserAccount() {
  const username = document.getElementById('newUsername').value.trim()
  const password = document.getElementById('newPassword').value
  const name = document.getElementById('newName').value.trim()
  const dept = readDeptCascade(DEPT_GROUPS.userModal)
  const role = document.getElementById('newRole').value
  if (!username || !password || !name) return alert(t('errRegisterFields'))
  if (password.length < 4) return alert(t('errPwdTooShort'))
  const result = await Store.addUser({ username, password, name, dept, role })
  if (!result.ok) return alert(result.msg)
  closeUserModal()
  renderUsers()
}
async function resetUserPassword(id, username) {
  const pwd = prompt(t('promptResetPwd', username))
  if (pwd === null) return
  if (pwd.length < 4) return alert(t('errPwdTooShort'))
  await Store.resetPassword(id, pwd)
  alert(t('pwdResetDone'))
}
// ====== 用户改名（管理员改学员 / 学员改自己）======
function applyCourseRename(oldU, newU) {
  if (typeof CourseStore === 'undefined' || !oldU || !newU) return
  // 先记待办：离线或失败时，下次进入线下课页面自动补做
  try { localStorage.setItem('eq_pending_course_rename', JSON.stringify({ from: oldU, to: newU, ts: Date.now() })) } catch (e) { /* ignore */ }
  CourseStore.renameUser(oldU, newU)
    .then(ok => { if (ok !== false) { try { localStorage.removeItem('eq_pending_course_rename') } catch (e) { /* ignore */ } } })
    .catch(() => { /* 离线：保留待办 */ })
}
function renameUserAccount(id, oldUsername) {
  const nu = prompt(t('promptRenameUser', oldUsername), oldUsername)
  if (nu === null) return
  const r = Store.renameUser(id, nu.trim())
  if (!r.ok) return alert(r.msg)
  applyCourseRename(r.old, r.nu)
  alert(t('renameDone', r.old, r.nu))
  renderUsers()
}
async function deleteUserAccount(id, username) {
  if (!confirm(t('confirmDeleteUser', username))) return
  if (!id) {
    // 其他终端注册的账号：仅从云端移除（本机没有该账号记录）
    if (typeof CloudSync !== 'undefined') {
      CloudSync.enqueue({ u: username, ty: 'delete', d: {} })
      await CloudSync.pushPending()
    }
    renderUsers()
    return
  }
  Store.deleteUser(id)
  // 立即推送删除事件到云端，避免竞态导致用户重新出现
  if (typeof CloudSync !== 'undefined') {
    await CloudSync.pushPending()
  }
  renderUsers()
}
// ====== v137：账号合并（仅管理员）======
// 场景：同一名学员注册了两次（用户名不同或前后有空格/别名），数据被劈成两条 →
//   登录时长、刷题数、考试成绩、七天挑战记录、线下课作业分散在两个账号上。
// 做法：把「被合并账号」的全部数据并入「保留账号」，被合并账号随后从名单消失。
//   复用既有的 rename 通道（云端聚合 + 班级成绩都会合并），另加：
//     ① doc.merges 不灭标记（源账号设备的迟到事件也会被吸收，不会长出幽灵账号）
//     ② 本机账号表/日志吸收（Store.mergeUsersLocal，刻意不发云端 delete 事件）
// 安全：仅管理员；管理员账号不得参与（避免权限被合并吞掉）；执行前云端留档备份；
//   必须手工输入被合并账号的用户名才可执行（不可逆操作，防误点）。
let mergeState = { src: '', tgt: '', rows: [], q: '', busy: false }

function mergeNormName(u) {
  const n = String((u && u.name) || '').trim().toLowerCase()
  return n || ('@' + String((u && u.username) || '').trim().toLowerCase())
}
// 同名分组：剔除管理员后，按「姓名」归组，返回出现 2 次及以上的组（同名账号的典型现场）
function mergeDupGroups(rows) {
  const g = {}
  ;(rows || []).forEach(u => {
    if (!u || u.role === 'admin') return
    const k = mergeNormName(u)
    ;(g[k] = g[k] || []).push(u)
  })
  return Object.keys(g).map(k => g[k]).filter(list => list.length > 1)
}
function mergeFmtLast(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function mergeChyCount(u) { return (u && Array.isArray(u.chy)) ? u.chy.length : 0 }
// 合并预览：源 / 保留 / 合计 三列口径（合计只对可加量求和，比率类按合计重算）
function mergePreviewHtml(srcRow, tgtRow) {
  const sum = (a, b) => (a || 0) + (b || 0)
  const pTot = sum(srcRow.practiceTotal, tgtRow.practiceTotal)
  const pCor = sum(srcRow.practiceCorrect, tgtRow.practiceCorrect)
  const eCnt = sum(srcRow.examCount, tgtRow.examCount)
  const eSum = Math.round(sum(srcRow.examScoreSum, tgtRow.examScoreSum))
  // v166/v167：等级一行同时列两种口径 —— 挑战等级（cl）与水平测定级（pl）。
  //   两者合并规则不同：挑战等级云端取 max（见 cloud-store rename 分支），水平测定级取「保留账号优先」。
  //   这里如实展示，避免管理员以为「合并只保一个」。
  //   ★ v167 说明：看板列表列已只认挑战等级；此处是**合并确认预览**（管理员主动操作的确认视图），
  //     保留两列是为了让管理员看清合并后 placementLevel 会不会跟着变 —— 与列表口径不冲突。
  const clv = Math.max(srcRow.chLevel || 0, tgtRow.chLevel || 0)
  const plvl = Math.max(srcRow.placementLevel || 0, tgtRow.placementLevel || 0)
  const lvlTxt = (cl, pl) => `L${cl || '—'} / ${pl ? 'L' + pl : '—'}`
  const line = (label, a, b, m) => `<tr><td style="color:#6b7280">${label}</td><td>${a}</td><td>${b}</td><td style="font-weight:700;color:#b45309">${m}</td></tr>`
  return `<table class="admin-table dash-table" style="margin-top:8px">
    <thead><tr>
      <th>${t('mergeColItem')}</th>
      <th>${escHtml(srcRow.username)}<div style="font-weight:400;font-size:11px;color:#6b7280">${t('mergeColSrc')}</div></th>
      <th>${escHtml(tgtRow.username)}<div style="font-weight:400;font-size:11px;color:#6b7280">${t('mergeColTgt')}</div></th>
      <th>${t('mergeColMerged')}</th>
    </tr></thead>
    <tbody>
      ${line(t('mergeMLoginCount'), srcRow.loginCount || 0, tgtRow.loginCount || 0, sum(srcRow.loginCount, tgtRow.loginCount))}
      ${line(t('mergeMDuration'), Store._fmtDuration(srcRow.loginSec || 0), Store._fmtDuration(tgtRow.loginSec || 0), Store._fmtDuration(sum(srcRow.loginSec, tgtRow.loginSec)))}
      ${line(t('mergeMPractice'), srcRow.practiceCount || 0, tgtRow.practiceCount || 0, sum(srcRow.practiceCount, tgtRow.practiceCount))}
      ${line(t('mergeMAccuracy'), (srcRow.practiceAccuracy || 0) + '%', (tgtRow.practiceAccuracy || 0) + '%', (pTot > 0 ? Math.round(pCor / pTot * 100) : 0) + '%')}
      ${line(t('mergeMExamCount'), srcRow.examCount || 0, tgtRow.examCount || 0, eCnt)}
      ${line(t('mergeMExamAvg'), srcRow.examCount ? (srcRow.examAvg + '') : '—', tgtRow.examCount ? (tgtRow.examAvg + '') : '—', eCnt ? Math.round(eSum / eCnt) : '—')}
      ${line(t('mergeMExamBest'), srcRow.examBest || 0, tgtRow.examBest || 0, Math.max(srcRow.examBest || 0, tgtRow.examBest || 0))}
      ${line(t('mergeMLevel'), lvlTxt(srcRow.chLevel, srcRow.placementLevel), lvlTxt(tgtRow.chLevel, tgtRow.placementLevel), lvlTxt(clv, plvl))}
      ${line(t('mergeMChallenge'), mergeChyCount(srcRow), mergeChyCount(tgtRow), sum(mergeChyCount(srcRow), mergeChyCount(tgtRow)))}
      ${line(t('mergeMCourse'), (srcRow.courseDone || 0) + '/' + (srcRow.courseTotal || 0), (tgtRow.courseDone || 0) + '/' + (tgtRow.courseTotal || 0), (sum(srcRow.courseDone, tgtRow.courseDone)) + '/' + (sum(srcRow.courseTotal, tgtRow.courseTotal)))}
    </tbody>
  </table>`
}

async function openMergeModal() {
  if (!Store.isAdmin()) return                       // 双重保险：仅管理员可开
  const old = document.getElementById('mergeModal')
  if (old) old.remove()
  mergeState = { src: '', tgt: '', rows: [], q: '', busy: false }
  const modal = document.createElement('div')
  modal.id = 'mergeModal'
  modal.className = 'modal-overlay'
  modal.style.display = 'flex'
  modal.innerHTML = `
    <div class="modal" style="max-width:780px">
      <div class="modal-header">
        <h3>🔗 ${t('mergeTitle')}</h3>
        <span class="modal-close" onclick="closeMergeModal()">✕</span>
      </div>
      <div class="modal-body" id="mergeBody">
        <div style="text-align:center;padding:32px;color:#6b7280">${t('cloudLoading')}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="mergeRunBtn" disabled onclick="mergeUsersRun()">${t('mergeRunBtn')}</button>
        <button class="btn btn-ghost" onclick="closeMergeModal()">${t('cancelBtn')}</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  let rows = []
  try {
    const d = await loadAdminRows()
    rows = (d && d.rows) || []
  } catch (e) { rows = [] }
  mergeState.rows = rows
  renderMergeBody()
}
function closeMergeModal() {
  const m = document.getElementById('mergeModal')
  if (m) m.remove()
}
// 选择：kind='src' 被合并方（将被吸收） / 'tgt' 保留方
function mergePick(kind, username) {
  if (kind === 'src') {
    mergeState.src = username
    if (mergeState.tgt === username) mergeState.tgt = ''
  } else {
    mergeState.tgt = username
    if (mergeState.src === username) mergeState.src = ''
  }
  renderMergeBody()
}
function mergeSearch(val) {
  mergeState.q = String(val || '').trim().toLowerCase()
  // 只重画列表：整块重渲染会把输入框一起换掉 → 用户每敲一个字就丢焦点
  const w = document.getElementById('mergeListWrap')
  if (w) w.innerHTML = mergeListHtml()
  else renderMergeBody()
}
function mergeSyncRunBtn() {
  const btn = document.getElementById('mergeRunBtn')
  if (!btn) return
  const ok = mergeState.src && mergeState.tgt && mergeState.src !== mergeState.tgt
  btn.disabled = !ok || mergeState.busy
}
function mergeTailHtml() {
  const srcRow = mergeState.rows.find(u => u.username === mergeState.src)
  const tgtRow = mergeState.rows.find(u => u.username === mergeState.tgt)
  if (!srcRow || !tgtRow) return `<p class="form-hint" style="margin-top:12px">${t('mergePickHint')}</p>`
  return `
    <div style="margin-top:14px;padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:13px;color:#92400e">
      ${t('mergeOrderHint')}
    </div>
    ${mergePreviewHtml(srcRow, tgtRow)}
    <div class="form-group" style="margin-top:14px">
      <label>${t('mergeConfirmLabel', srcRow.username)}</label>
      <input type="text" id="mergeConfirmInput" autocomplete="off" placeholder="${escAttr(srcRow.username)}"
             oninput="mergeSyncRunBtn()" />
    </div>`
}
// 账号列表区（可单独重画：搜索时不能让搜索框本身被重建，否则每敲一个字就丢焦点）
function mergeListHtml() {
  const q = mergeState.q
  const listable = (mergeState.rows || [])
    .filter(u => u && u.role !== 'admin')
    .filter(u => !q
      || String(u.username || '').toLowerCase().includes(q)
      || String(u.name || '').toLowerCase().includes(q))
  const rowHtml = (u) => `<tr>
      <td>${escHtml(u.username)}${u.cloudOnly ? ` <span style="color:#2563eb;font-size:10px" title="${t('cloudUserTip')}">☁</span>` : ''}</td>
      <td>${escHtml(u.name || '—')}</td>
      <td>${escHtml(u.dept || '—')}</td>
      <td style="font-size:12px;color:#6b7280">${mergeFmtLast(u.lastActive)}</td>
      <td style="font-size:12px;color:#6b7280">${u.loginCount || 0}</td>
      <td style="font-size:12px;color:#6b7280">${u.practiceCount || 0}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="mergePick('src', ${escAttr(JSON.stringify(u.username))})">${t('mergeSetSrc')}</button>
        <button class="btn btn-ghost btn-sm" onclick="mergePick('tgt', ${escAttr(JSON.stringify(u.username))})">${t('mergeSetTgt')}</button>
      </td>
    </tr>`
  return `<div style="max-height:220px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px">
      <table class="admin-table dash-table">
        <thead><tr><th>${t('thUsername')}</th><th>${t('thName')}</th><th>${t('thDept')}</th><th>${t('thLastActive')}</th><th>${t('mergeColLogin')}</th><th>${t('mergeColPractice')}</th><th>${t('thAction')}</th></tr></thead>
        <tbody>${listable.length ? listable.map(rowHtml).join('') : `<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:16px">${t('mergeNoMatch')}</td></tr>`}</tbody>
      </table>
    </div>`
}
function renderMergeBody() {
  const el = document.getElementById('mergeBody')
  if (!el) return
  const dups = mergeDupGroups(mergeState.rows)
  const dupHtml = dups.length ? `
    <div style="margin:6px 0 12px;padding:10px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px">
      <div style="font-size:13px;font-weight:700;color:#1d4ed8;margin-bottom:6px">${t('mergeDupTitle', dups.length)}</div>
      ${dups.map(list => `<div style="font-size:13px;color:#1e3a8a;margin:2px 0">👥 ${escHtml(list[0].name || list[0].username)}：
        ${list.map(u => `<a href="javascript:;" onclick="mergePick('src', ${escAttr(JSON.stringify(u.username))})" style="color:#1d4ed8;text-decoration:underline">${escHtml(u.username)}</a>`).join(' / ')}
        <span style="color:#6b7280;font-size:12px">（${t('mergeDupTip')}）</span></div>`).join('')}
    </div>` : `<div style="margin:6px 0 12px;font-size:13px;color:#6b7280">${t('mergeNoDup')}</div>`
  const pickChip = (label, name, kind) => `<div style="flex:1;min-width:200px;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb">
      <div style="font-size:12px;color:#6b7280">${label}</div>
      <div style="font-weight:700;color:${name ? '#111827' : '#9ca3af'}">${name ? escHtml(name) : t('mergeNotPicked')}</div>
    </div>`
  el.innerHTML = `
    <p class="form-hint" style="margin-bottom:10px">${t('mergeIntro')}</p>
    ${dupHtml}
    <div style="display:flex;gap:10px;margin-bottom:10px">
      ${pickChip(t('mergeColSrc') + '（被吸收）', mergeState.src, 'src')}
      ${pickChip(t('mergeColTgt') + '（保留）', mergeState.tgt, 'tgt')}
    </div>
    <input type="text" id="mergeSearchInput" value="${escAttr(mergeState.q)}" placeholder="${t('mergeSearchPh')}"
           oninput="mergeSearch(this.value)" style="width:100%;margin-bottom:8px" />
    <div id="mergeListWrap">${mergeListHtml()}</div>
    <div id="mergeTail">${mergeTailHtml()}</div>`
  mergeSyncRunBtn()
}
async function mergeUsersRun() {
  if (!Store.isAdmin()) return alert(t('mergeAdminOnly'))       // 权限闸门：仅管理员
  const src = String(mergeState.src || '').trim()
  const tgt = String(mergeState.tgt || '').trim()
  if (mergeState.busy) return
  if (!src || !tgt || src === tgt) return alert(t('mergeNeedPick'))
  const srcRow = mergeState.rows.find(u => u.username === src)
  const tgtRow = mergeState.rows.find(u => u.username === tgt)
  if (!srcRow || !tgtRow) return alert(t('mergeNeedPick'))
  // 管理员账号不得参与：源被吸收会把管理员权限一起吞掉；目标被合并则统计被污染
  if (srcRow.role === 'admin' || tgtRow.role === 'admin') return alert(t('mergeNoAdminAccount'))
  const inp = document.getElementById('mergeConfirmInput')
  if (String((inp && inp.value) || '').trim() !== src) return alert(t('mergeConfirmMismatch', src))
  if (!confirm(t('mergeFinalConfirm', src, tgt))) return
  mergeState.busy = true
  mergeSyncRunBtn()
  try {
    // ① 云端留档备份（不可逆操作，先留一份本机快照，最多保留最近 3 份）
    let backupOk = false
    try {
      const s = await CloudSync.fetchSyncSummary()
      if (s && s.ok && s.doc) {
        const key = 'eq_merge_backup_' + Date.now()
        localStorage.setItem(key, JSON.stringify(s.doc))
        backupOk = true
        const keys = Object.keys(localStorage).filter(k => k.indexOf('eq_merge_backup_') === 0).sort()
        while (keys.length > 3) { localStorage.removeItem(keys.shift()) }
      }
    } catch (e) { /* 备份失败不阻断，但会在结果里提示 */ }
    // ② 云端合并：不灭标记 + rename 事件 + 回读校验
    const r = (typeof CloudSync !== 'undefined' && CloudSync.mergeAccounts)
      ? await CloudSync.mergeAccounts(src, tgt)
      : { ok: false, reason: 'no-cloudsync' }
    // ③ 本机侧吸收：删本机源账号 + 活动日志/定级历史重挂（不发云端 delete）
    let local = { removedLocal: 0, relogged: 0 }
    try { local = Store.mergeUsersLocal(src, tgt) } catch (e) { /* ignore */ }
    // ④ 线下课：班级成员 / 创建者 / 成绩记录迁移（复用改名通道，内部会合并历次成绩）
    try { applyCourseRename(src, tgt) } catch (e) { /* ignore */ }
    alert(r.ok
      ? t('mergeDone', src, tgt) + (backupOk ? '' : '\n\n' + t('mergeBackupWarn'))
      : t('mergePartial', src, tgt) + (backupOk ? '' : '\n\n' + t('mergeBackupWarn')))
    closeMergeModal()
    if (typeof renderUsers === 'function') renderUsers()
  } finally {
    mergeState.busy = false
  }
}
// 设置 / 取消管理员权限
async function setUserRoleUI(id, username, role) {
  const isAdminRole = role === 'admin'
  if (!confirm(isAdminRole ? t('confirmSetAdmin', username) : t('confirmCancelAdmin', username))) return
  let r
  try {
    r = id ? await Store.setUserRole(id, role) : await Store.setUserRoleByUsername(username, role)
  } catch (e) { return alert(t('cloudSyncOffShort') || '云端连接失败，请稍后再试') }
  if (!r.ok) return alert(r.msg)
  alert(t('roleChangeDone', username, isAdminRole ? t('roleAdmin') : t('roleStudent')))
  renderUsers()
}

// ====== 云端同步状态指示（顶栏） ======
function updateCloudStatus(s) {
  const el = document.getElementById('cloudStatus')
  if (!el) return
  const map = {
    online: { cls: 'cloud-status on', txt: '☁ ' + t('cloudSyncOn') },
    syncing: { cls: 'cloud-status busy', txt: '☁ ' + t('cloudSyncBusy') },
    offline: { cls: 'cloud-status off', txt: '☁ ' + t('cloudSyncOff') }
  }
  const m = map[s] || map.offline
  el.className = m.cls
  el.textContent = m.txt
  el.title = t('cloudStatusTitle')
  el.style.display = ''
}

// ====== v158：前端版本号（页面显眼处显示） ======
// ★ 单一数据源：版本号只存在于 index.html 的资源声明 `?v=N`（12 处，测试强约束「取值唯一」），
//   这里从 DOM 反读 —— 绝不另立 JS 常量（否则每次 bump 要手改两处、必漏其一）。
// ★ 也绝不往 index.html 里再塞 `?v=` 字面量（会打破「恰好 12 处」的契约，多个套件会红）。
// ★ 语义正确性：读的是「当前这份 HTML 声明的版本」= 用户实际加载的 JS 版本；
//   若浏览器拿到的是缓存旧 HTML，徽章显示旧版号 —— 正是我们要的诊断信号。
function appVersionFromDom() {
  const els = Array.from(document.querySelectorAll('script[src*="v="], link[href*="v="]'))
  const pick = (el) => {
    const u = el.getAttribute('src') || el.getAttribute('href') || ''
    const m = u.match(/[?&]v=(\d+)/)
    return m ? Number(m[1]) : 0
  }
  // ★ 只认 app.js 自己：正则绝不能写成 /app\.js/ 去匹配 src ——
  //   course-app.js 含 'app.js' 子串，会误命中（本项目反复踩过的「前缀/子串」坑）。
  const own = els.find(el => /(^|\/)app\.js\?/.test(el.getAttribute('src') || ''))
  const v = own ? pick(own) : 0
  if (v) return v
  for (const el of els) { const x = pick(el); if (x) return x }
  return 0
}
function appVersionText() {
  const v = appVersionFromDom()
  return v ? ('v' + v) : 'v?'
}
function renderAppVersion() {
  const text = appVersionText()
  const ids = ['appVerBadge', 'authVerBadge']
  for (const id of ids) {
    const el = document.getElementById(id)
    if (el) el.textContent = text
  }
  return text
}

// ====== Init ======
function init() {
  Store.init()
  // v89：先把当前登录者的分部门同步给 CloudSync —— 必须在任何 _getDoc 之前，
  // 否则首屏会按「不限部门」挑营次，多部门并存时学员可能看到别的部门的期次。
  Store.syncDeptSlug()
  Store.recalcPlacementLevels() // 一次性：用新逻辑重算已有定级
  ensureCourseBankSynced()      // v43：后台派生线下课题库（不阻塞首屏；离线时静默沿用本地）
  renderStaticText() // 按 i18n 语言渲染登录页/导航静态文本
  renderLogo()       // 渲染平台品牌 Logo（登录页 + 顶栏；云端新 Logo 到达时经事件自动刷新）
  renderAppVersion() // v158：把前端版本号写进登录页 + 顶栏徽章（从资源 ?v= 反读）
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('eq-logo-updated', () => { try { renderLogo() } catch (e) { /* ignore */ } })
  }
  // 云端同步状态监听
  if (typeof CloudSync !== 'undefined') {
    CloudSync.onStatus(updateCloudStatus)
    updateCloudStatus(CloudSync.status)
    // v108：成绩同步状态变化 → 就地刷新结果页徽章（学员看得见「已同步」）
    bindSyncBadgeListener()
  }
  // 课程云端从 offline 恢复时自动重新渲染看板（"本地缓存"警告自动消失）
  window.addEventListener('course-store-online', () => {
    if (Store.isLoggedIn() && Store.isAdmin()) {
      const active = document.querySelector('.nav-item.active')
      const page = active && active.dataset ? active.dataset.page : ''
      if (page === 'users' && typeof renderUsers === 'function') renderUsers()
      else if (page === 'dashboard' && typeof renderDashboard === 'function') renderDashboard()
    }
  })
  if (Store.isLoggedIn()) {
    enterApp()
  } else {
    // 未登录：显示登录界面
    document.getElementById('app').style.display = 'none'
    document.getElementById('authScreen').style.display = 'flex'
    showLoginForm()
  }
  // 回车快捷登录
  document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
  document.getElementById('loginUsername').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
}

init()
