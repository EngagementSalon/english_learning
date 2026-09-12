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
// 在线发音（v61 增强版）：多源自动降级——播放报错立即切下一源；看门狗每 TTS_WATCH_MS 检查一次，
// 有加载进度（loadstart/progress/canplay 等）就续等一轮（弱网慢加载不误杀），完全无进度才切换；
// 全部在线源失败时回退本地合成，仍不行才提示学员检查网络。每次尝试用全新 Audio 对象，
// 避免复用出错/无声的旧元素（部分安卓 WebView 的已知问题）。
function playListenOnline(text) {
  if (!text) return
  try {
    const txt = String(text).trim().slice(0, 260)
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
        if (!_speakLocal(txt, true)) _ttsToast(t('ttsFail'))
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
function speakLocalForce(text) {
  if (!text) return
  if (!_speakLocal(String(text).trim(), true)) _ttsToast(t('ttsNone'))
}
// 题干区 HTML：listen 题只显示喇叭按钮（不暴露英文原文），其余题型照常显示题干
function quizTitleHtml(q) {
  if (q.type === 'listen') {
    return `<div class="q-title listen-title">
      <button class="listen-btn" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">🔊</button>
      <button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">🔉</button>
      <button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">🌐</button>
      <span class="listen-hint">${t('listenHint')}</span>
    </div>`
  }
  return `<div class="q-title">${q.question}</div>`
}
// listen 题进入时自动朗读一次（仅本地语音可用时自动播，答题中才朗读，回顾/已提交不自动朗读）
function autoplayListen(q) {
  if (q && q.type === 'listen' && listenVoiceMode() === 'local') setTimeout(() => speakEnglish(q.question), 350)
}

// voicematch（看字选音）选项行：作答中只显示 🔊/🌐 播放按钮（不暴露文字），提交/回顾后显示文字与对错
function vmOptRowHtml(q, ans, i, mode, pickFn) {
  const opt = q.options[i]
  const isCorrect = q.answer.includes(i)
  let cls = 'option-item vm-option'
  if (mode === 'review') { if (isCorrect) cls += ' correct'; else if (ans === i) cls += ' wrong' }
  else if (mode === 'live' && ans === i) cls += ' selected'
  const badge = mode === 'review' && isCorrect ? '✓' : (LETTERS[i] || String.fromCharCode(65 + i))
  const play = `<button class="vm-play" type="button" data-w="${escAttr(opt)}" onclick="event.stopPropagation();speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">🔊</button>`
  const online = `<button class="vm-online" type="button" data-w="${escAttr(opt)}" onclick="event.stopPropagation();speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">🔉</button><button class="vm-online" type="button" data-w="${escAttr(opt)}" onclick="event.stopPropagation();playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">🌐</button>`
  const onClick = mode === 'review' || !pickFn ? '' : `${pickFn}(${i})`
  const inner = mode === 'review'
    ? `${play}${online}<span class="vm-opt-text">${escHtml(opt)}</span>`
    : `${play}${online}<span class="vm-opt-label">${t('listenPlay')}</span>`
  return `<div class="${cls}" ${onClick ? `onclick="${onClick}"` : ''}>
    <div class="option-badge">${badge}</div>
    <div class="option-text vm-opt">${inner}</div>
  </div>`
}
// voicematch 选项整段 HTML
function vmOptionsHtml(q, ans, mode, pickFn) {
  const hint = mode === 'review' ? '' : `<p class="form-hint vm-hint">${t('vmHint')}</p>`
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
function saveProfile() {
  const name = document.getElementById('profileName').value.trim()
  if (!name) return
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
  Store.setUser({ name, dept: readDeptCascade(DEPT_GROUPS.profile) })
  // 同步账号表姓名（看板显示用）
  if (s) Store.updateUser(s.id, { name })
  if (renamed) applyCourseRename(renamed.old, renamed.nu)
  closeProfileSetup()
  updateUserInfoDisplay()
  if (renamed) alert(t('renameDone', renamed.old, renamed.nu))
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
const DEPT_MAJOR_KEYS = ['dining', 'rooms', 'other']
const DEPT_GROUPS = {
  register: ['regDeptMajor', 'regDeptSub', 'regDeptOther'],
  profile: ['profileDeptMajor', 'profileDeptSub', 'profileDeptOther'],
  userModal: ['newDeptMajor', 'newDeptSub', 'newDeptOther'],
  deptModal: ['deptEditMajor', 'deptEditSub', 'deptEditOther'],
}
function deptTree() { return t('deptTree') }

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
  if (key && key !== 'other' && tree[key].subs.indexOf(sub) >= 0) {
    majorSel.value = key
    majorSel.onchange()
    subSel.value = sub
  } else {
    majorSel.value = 'other'
    majorSel.onchange()
    otherIn.value = value
  }
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
  // 学员首次进入：先做水平测试，自动定级 L1-L4
  const s = Store.getSession()
  if (s && s.role === 'student' && !Store.getUserLevel()) {
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
}

// ====== 水平测试（自动分档 L1-L4）======
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
  const optionsHtml = q.type === 'voicematch'
    ? vmOptionsHtml(q, ans, 'live', 'placementPick')
    : q.options.map((opt, i) => {
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
      <button class="btn btn-ghost" onclick="navigate('placement')">${t('regrade')}</button>
    </div>` : (Store.getSession() && Store.getSession().role === 'student' ? `
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
      <div class="feature-card" onclick="navigate('placement')">
        <div class="icon">🎯</div>
        <h3>${t('featurePlacementT')}</h3>
        <p>${t('featurePlacementD')}</p>
      </div>
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
    </div>
    <div id="practiceQuiz"></div>
    ${challengeEntryHtml()}
  `
}

// 七天挑战入口卡片（v70：入口移入练习页下方，不再是独立导航项）
function challengeEntryHtml() {
  challengeLoad()
  const doneDays = CHALLENGE_DAYS.filter(d => chDayDone(d.day)).length
  return `
    <div class="card" onclick="navigate('challenge')" style="cursor:pointer;margin-top:16px;border:2px solid #f59e0b">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:32px">🏅</div>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px">${t('chTitle')}</h3>
          <p class="form-hint" style="margin:0">${t('chEntryHint', doneDays)}</p>
        </div>
        <div style="font-size:22px;color:#9ca3af">›</div>
      </div>
    </div>`
}

function startPractice() {
  const cat = document.getElementById('pCategory').value
  const diff = document.getElementById('pDifficulty').value
  const lvl = document.getElementById('pLevel').value
  let count = Number(document.getElementById('pCount').value)
  const deptKey = Store.isAdmin() ? '' : Store.getSessionDeptKey()
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
  const ans = practiceState.answers[practiceState.index] || (q.type === 'multiple' ? [] : q.type === 'fill' || q.type === 'translate' ? '' : -1)
  const submitted = practiceState.submitted

  let optionsHtml = ''
  if (q.type === 'voicematch') {
    optionsHtml = vmOptionsHtml(q, ans, submitted ? 'review' : 'live', 'selectOption')
  } else if (q.type === 'single' || q.type === 'judge' || q.type === 'pronounce' || q.type === 'listen') {
    optionsHtml = q.options.map((opt, i) => {
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
  } else if (q.type === 'multiple') {
    optionsHtml = q.options.map((opt, i) => {
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
  } else if (q.type === 'fill' || q.type === 'translate') {
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
      ${q.type !== 'fill' && q.type !== 'translate' ? `<div class="explanation">${t('correctAnswer')}：${q.answer.map(i => LETTERS[i]).join(', ')}</div>` : `<div class="explanation">${t('correctAnswer')}：${q.options[0]}</div>`}
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
  let ans = practiceState.answers[practiceState.index] || []
  if (ans.includes(i)) ans = ans.filter(x => x !== i)
  else ans = [...ans, i]
  practiceState.answers[practiceState.index] = ans
  renderPracticeQuestion()
}
function onTextInput(val) {
  practiceState.answers[practiceState.index] = val
}
function checkAnswer(q, ans) {
  if (q.type === 'single' || q.type === 'judge' || q.type === 'pronounce' || q.type === 'listen' || q.type === 'voicematch') {
    return q.answer.includes(ans)
  } else if (q.type === 'multiple') {
    return ans.length === q.answer.length && q.answer.every(i => ans.includes(i))
  } else if (q.type === 'fill' || q.type === 'translate') {
    return ans.toString().trim().toLowerCase() === q.options[0].toString().trim().toLowerCase()
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
  // 考试防作弊：禁止切屏，超 3 次自动交卷
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

  let optionsHtml = ''
  if (q.type === 'voicematch') {
    optionsHtml = vmOptionsHtml(q, ans, 'live', 'examSelect')
  } else if (q.type === 'single' || q.type === 'judge' || q.type === 'pronounce' || q.type === 'listen') {
    optionsHtml = q.options.map((opt, i) => {
      let cls = 'option-item'
      if (ans === i) cls += ' selected'
      return `<div class="${cls}" onclick="examSelect(${i})">
        <div class="option-badge">${LETTERS[i]}</div>
        <div class="option-text">${opt}</div>
      </div>`
    }).join('')
  } else if (q.type === 'multiple') {
    optionsHtml = q.options.map((opt, i) => {
      let cls = 'option-item'
      if (ans.includes(i)) cls += ' selected'
      return `<div class="${cls}" onclick="examToggle(${i})">
        <div class="option-badge">${LETTERS[i]}</div>
        <div class="option-text">${opt}</div>
      </div>`
    }).join('')
  } else if (q.type === 'fill' || q.type === 'translate') {
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
        <div class="review-q">${i+1}. ${q.type === 'listen' || q.type === 'voicematch' ? `<button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">🔊</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">🔉</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">🌐</button> ${q.question}` : q.question}</div>
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
// 三个部门题库 tab 各自独立的筛选状态（dining | rooms | all）
let adminStates = {
  dining: { page: 1, pageSize: 10, keyword: '', category: 0, difficulty: 0 },
  rooms: { page: 1, pageSize: 10, keyword: '', category: 0, difficulty: 0 },
  all: { page: 1, pageSize: 10, keyword: '', category: 0, difficulty: 0 }
}
let adminTab = 'dining' // dining | rooms | all
const adminDeptOf = tab => (tab === 'dining' || tab === 'rooms' || tab === 'all') ? tab : 'all'

function renderAdmin() {
  Object.keys(adminStates).forEach(k => { adminStates[k] = { page: 1, pageSize: 10, keyword: '', category: 0, difficulty: 0 } })
  adminTab = 'dining'
  renderAdminShell()
  renderAdminList()
}

function renderAdminShell() {
  const allQs = Store.getQuestions()
  const count = d => allQs.filter(q => q.dept === d).length
  const el = document.getElementById('page-admin')
  el.innerHTML = `
    <div class="admin-tabs">
      <button class="admin-tab ${adminTab === 'dining' ? 'active' : ''}" onclick="switchAdminTab('dining')">${t('bankDining')} <span class="tab-count">${count('dining')}</span></button>
      <button class="admin-tab ${adminTab === 'rooms' ? 'active' : ''}" onclick="switchAdminTab('rooms')">${t('bankRooms')} <span class="tab-count">${count('rooms')}</span></button>
      <button class="admin-tab ${adminTab === 'all' ? 'active' : ''}" onclick="switchAdminTab('all')">${t('bankGeneral')} <span class="tab-count">${count('all')}</span></button>
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
  const st = adminStates[adminTab] || adminStates.all
  const categories = Store.getCategories()
  const { list, total } = Store.queryQuestions({
    category_id: st.category || undefined,
    difficulty: st.difficulty || undefined,
    deptExact: adminDeptOf(adminTab),
    keyword: st.keyword || undefined,
    page: st.page,
    pageSize: st.pageSize
  })
  const totalPages = Math.ceil(total / st.pageSize)

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
      ${list.length === 0 ? `<div style="padding:40px;text-align:center;color:#9ca3af;">${t('noQuestions')}</div>` : `
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
          ${list.map(q => `<tr>
            <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${q.question}</td>
            <td>${Store.getCategoryName(q.category_id)}</td>
            <td><span class="tag ${q.dept === 'rooms' ? 'tag-diff-3' : q.dept === 'dining' ? 'tag-diff-1' : 'tag-diff-2'}">${deptLabels[q.dept] || t('deptGeneral')}</span></td>
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
              <option value="dining" ${data.dept==='dining'?'selected':''}>${t('deptDining')}</option>
              <option value="rooms" ${data.dept==='rooms'?'selected':''}>${t('deptRooms')}</option>
              <option value="all" ${(data.dept==='all'||!data.dept)?'selected':''}>${t('deptGeneral')}</option>
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
  document.getElementById('editModal').remove()
  renderAdminList()
}

function adminDelete(id) {
  if (!confirm(t('confirmDeleteQuestion'))) return
  Store.deleteQuestion(id)
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
    const q = {
      type: type || 'single',
      question: String(item.question || '').trim(),
      options,
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
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xlsxXmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` }
  ]
  sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: xlsxSheetXml(s.rows) }))
  return xlsxBuildZip(files)
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
  const items = picked.map(r => ({ category_id: 1, dept: 'all', type: r.q.type, difficulty: r.q.difficulty || r.est, question: r.q.question, options: r.q.options, answer: r.q.answer, explanation: r.q.explanation }))
  const result = Store.batchImport(items)
  const el = document.getElementById('importResult')
  if (el) el.innerHTML = `<div class="feedback correct"><strong>✅ ${t('impDoneTitle')}</strong><div class="explanation">${t('impDoneDetail', result.success, result.skipped || 0)}</div></div>`
  setTimeout(() => {
    document.getElementById('importModal') && document.getElementById('importModal').remove()
    adminTab = 'all'   // 上传题 dept=all → 落到「通用」题库，切过去展示
    renderAdminShell(); renderAdminList()
  }, 1600)
}
function importReadFile(file, done) {
  const finish = done || (text => impParseAndPreview(text))
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
function openImportModal() {
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
          <label>${t('impFileLabel')}</label>
          <input type="file" id="importFile" accept=".csv,.txt,.tsv,.json,text/csv,text/plain,application/json" onchange="importReadFile(this.files[0])" style="font-size:13px" />
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
// 每班级成绩矩阵 HTML（infoMap：用户名 → { name, dept }，用于成员列显示中文名+部门）
function _courseMatrices(doc, infoMap) {
  const classes = doc.classes || []
  infoMap = infoMap || {}
  return classes.map(c => {
    const members = c.members || []
    const assigns = c.assignments || []
    if (!assigns.length) return ''
    const headerCells = assigns.map(a => {
      const icon = a.type === 'offline' ? '📅' : (a.type === 'video' ? '🎬' : (a.type === 'exam' ? '🧪' : '📝'))
      return `<th class="dash-th">${icon} ${escHtml(a.title)}</th>`
    }).join('')
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
    return `<div class="card" style="margin-bottom:16px;padding:0;overflow-x:auto">
      <div style="padding:12px 16px;border-bottom:1px solid #e5e7eb"><strong>🎓 ${escHtml(c.name)}</strong>
        <span style="color:#6b7280;font-size:13px;margin-left:8px">👥 ${members.length}${t('courseMembersUnit')} · 📋 ${assigns.length}${t('courseAssignUnit')}</span>
      </div>
      <table class="admin-table dash-table">
        <thead><tr><th style="min-width:80px">${t('courseMatrixStudent')}</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
  }).join('')
}

// ====== 管理员数据加载（账号管理页 / 数据看板页共用）======
async function loadAdminRows() {
  // 先触发云端定级重算（一次性，修正旧 bug 导致的等级虚高）
  if (typeof CloudSync !== 'undefined' && CloudSync.recalcCloudPlacementLevels) {
    try { await CloudSync.recalcCloudPlacementLevels() } catch (e) { /* 忽略，不影响看板加载 */ }
  }

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
  const placedCount = students.filter(u => u.placementLevel).length
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
              <td>${u.role !== 'admin' ? (u.placementLevel ? `<span class="level-badge level-${u.placementLevel}">L${u.placementLevel}</span>` : `<span style="color:#9ca3af;font-size:12px">${t('notPlaced')}</span>`) : '—'}</td>
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
// 职责：数据分「线上数据 / 线下课程」两个标签页
//   线上：登录时长 / 刷题 / 考试 / 定级 / 分类进度 / 每道题正确率
//   线下：班级作业完成率 / 学员线下明细 / 课程成绩矩阵
let dashTab = 'online'   // 'online' 线上数据 | 'offline' 线下课程
function dashSwitchTab(v) {
  dashTab = v
  const ob = document.getElementById('dashOnlineBlock')
  const fb = document.getElementById('dashOfflineBlock')
  if (ob) ob.style.display = v === 'online' ? '' : 'none'
  if (fb) fb.style.display = v === 'offline' ? '' : 'none'
  const bo = document.getElementById('dashTabBtnOnline')
  const bf = document.getElementById('dashTabBtnOffline')
  if (bo) bo.className = 'btn btn-sm ' + (v === 'online' ? 'btn-primary' : 'btn-ghost')
  if (bf) bf.className = 'btn btn-sm ' + (v === 'offline' ? 'btn-primary' : 'btn-ghost')
}
async function renderDashboard() {
  if (!Store.isAdmin()) return
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
      <td>${escHtml(u.name || '—')}</td>
      <td>${escHtml(u.dept || '—')}</td>
      <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : ''}">${u.role === 'admin' ? t('roleAdmin') : t('roleStudent')}</span></td>
      <td>${u.role !== 'admin' ? (u.placementLevel ? `<span class="level-badge level-${u.placementLevel}">L${u.placementLevel}</span>` : `<span style="color:#9ca3af;font-size:12px">${t('notPlaced')}</span>`) : '—'}</td>
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
    <td>${escHtml(u.name || '—')}</td>
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

  el.innerHTML = `
    ${adminWarnCards(cloudRows, courseS, hadChanges, sessionChanged)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn btn-sm ${dashTab === 'online' ? 'btn-primary' : 'btn-ghost'}" id="dashTabBtnOnline" onclick="dashSwitchTab('online')">🌐 ${t('dashTabOnline')}</button>
      <button class="btn btn-sm ${dashTab === 'offline' ? 'btn-primary' : 'btn-ghost'}" id="dashTabBtnOffline" onclick="dashSwitchTab('offline')">🏫 ${t('dashTabOffline')}</button>
    </div>
    <div id="dashOnlineBlock">${onlineHtml}</div>
    <div id="dashOfflineBlock" style="${dashTab === 'offline' ? '' : 'display:none'}">${offlineHtml}</div>
    <p class="form-hint" style="margin-top:12px">${t('dashHint')}</p>
  `
  renderDashCatBlock()
  _perQLastRows = rows
  renderPerQBlock(rows)
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
// 数据来源：各学员云端 perQ 聚合（perQ[qid]={correct,total}），跨所有学员合并成全题统计
let perQDept = ''   // '' 全部 | 'dining' | 'rooms'
let perQSort = 'rate' // 'rate' 按正确率 | 'attempts' 按答题次数
function renderPerQBlock(rows) {
  const el = document.getElementById('perQBlock')
  if (!el) return
  // 1) 合并所有学员的 perQ → 全题统计
  const agg = {}   // qid -> { correct, total }
  ;(rows || []).forEach(r => {
    if (!r || !r.perQ) return
    Object.keys(r.perQ).forEach(qid => {
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
      qid: Number(qid),
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
  const trClass = r => r.rate >= 80 ? 'perq-good' : r.rate >= 60 ? 'perq-ok' : r.rate >= 40 ? 'perq-warn' : 'perq-bad'
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

// ====== Init ======
function init() {
  Store.init()
  Store.recalcPlacementLevels() // 一次性：用新逻辑重算已有定级
  ensureCourseBankSynced()      // v43：后台派生线下课题库（不阻塞首屏；离线时静默沿用本地）
  renderStaticText() // 按 i18n 语言渲染登录页/导航静态文本
  renderLogo()       // 渲染平台品牌 Logo（登录页 + 顶栏；云端新 Logo 到达时经事件自动刷新）
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('eq-logo-updated', () => { try { renderLogo() } catch (e) { /* ignore */ } })
  }
  // 云端同步状态监听
  if (typeof CloudSync !== 'undefined') {
    CloudSync.onStatus(updateCloudStatus)
    updateCloudStatus(CloudSync.status)
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
