// ====== v205：挑战每日跟读（免费方案：录音回放对比 + 可选浏览器识别 + 自评打卡） ======
// 设计要点（2026-11-26 用户拍板：免费方案 + 挑战每日环节 + 复用题库例句）：
//   · 不接第三方评测（讯飞方案因「密钥暴露 + 额度限制」被否）；判定 = 回放自听对比，
//     浏览器 SpeechRecognition 可用时附赠识别匹配度（纯参考值），打卡为学员自评星级。
//   · 跟读是**每日附加环节**：不改 CHALLENGE_DAYS* 的 stages 数组（阶段按 si 索引存档，
//     插入环节会让全体在读学员存档错位 —— v188/r3 半圆教训）、不改进度分母、不卡解锁链。
//     麦克风不可用的学员（微信内置 iOS 很常见）可直接自评打卡，绝不被卡死。
//   · 句子来源：运行时从 BANK.questions 抽取可跟读英文（translate 选项 / fill 回填 /
//     judge 英文句 / explanation 引号原句），句子不足回落单词（listen/voicematch 题干）。
//   · 选句确定性：seed = FNV1a(round|dept|day) —— 同营次同部门同天恒定 3 句，刷新不变。
//   · 存档：challengeState.read[day] = { done, at, stars }（本地权威，与 stages 同级顶层，
//     challengeLoad 只校验 days 字段，未知字段天然存活）。
//   · 云端：Store.reportChallengeRead → chread 事件 → cloud-store._apply 留痕 r.chRead[]
//     （无音频上云 —— textdb 总共 1MB，音频不可行；只留天数/星级/营次）。
// 依赖（运行时 typeof 守卫，全部可选注入）：challenge.js 的 chDayUnlocked / chOpenLocked /
//   chCurrentRound / chDeptKey / renderChallenge；app.js 的 speakEnglish / escHtml；
//   challenge.js 的 chPoolExpandDepts（日照大类跨部门借句）；i18n.js 的 t。

// ---------- 抽句器 ----------

// 是否可作跟读句的英文串：无中文、字母占比高
function _chReadIsEnglish(s) {
  const str = String(s || '')
  if (!str) return false
  if (/[\u4e00-\u9fff]/.test(str)) return false
  const letters = (str.match(/[A-Za-z]/g) || []).length
  return letters >= 8 && letters / str.length > 0.6
}
function _chReadWordCount(s) { return (String(s || '').match(/[A-Za-z]+/g) || []).length }
// 规范化去重键：小写、去标点、压空格
function _chReadKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
// fill 题回填：'填空：May I know if you have a "______"（预订）?' + options[0]='reservation'
//   → 'May I know if you have a "reservation"?'
function _chReadFillSentence(q) {
  let s = String(q.question || '')
  const ans = String(((q.options || [])[(q.answer || [])[0]] || ''))
  s = s.replace(/_{2,}（[^）]*）/g, ans).replace(/_{2,}/g, ans)
  s = s.replace(/^填空[：:]\s*/, '')
  s = s.replace(/（[^）]*[\u4e00-\u9fff][^）]*）/g, '')   // 去掉中文注解括注
  return s.trim()
}
// 从 explanation / question 里抠引号原句：原对话中的英文句
function _chReadQuoted(s) {
  const out = []
  const str = String(s || '')
  let m
  let re = /"([^"\n]{6,200})"/g          // 直引号对
  while ((m = re.exec(str)) !== null) out.push(m[1])
  re = new RegExp('[\u201C]([^\u201D\n]{6,200})[\u201D]', 'g')   // 弯引号对（避免源码里写弯引号被工具链转坏）
  while ((m = re.exec(str)) !== null) out.push(m[1])
  return out
}

const _chReadPoolCache = {}
// 按部门汇总可跟读素材。返回 [{ text, kind }]，kind: 'sentence' | 'word'
function chReadPoolFor(deptKey) {
  const key = String(deptKey || '')
  if (_chReadPoolCache[key]) return _chReadPoolCache[key]
  const qs = (typeof BANK !== 'undefined' && BANK && BANK.questions) || []
  const depts = (typeof chPoolExpandDepts === 'function') ? chPoolExpandDepts([key]) : [key]
  const inDept = q => depts.indexOf(String(q.dept || '')) >= 0
  const seen = {}
  const sentences = []
  const words = []
  const pushItem = (text, kind, q) => {
    const t2 = String(text || '').trim()
    if (!_chReadIsEnglish(t2)) return
    const wc = _chReadWordCount(t2)
    if (kind === 'sentence' && (wc < 4 || wc > 20)) return
    if (kind === 'word' && (wc < 1 || wc > 3)) return
    const k = _chReadKey(t2)
    if (!k || seen[k]) return
    seen[k] = true
    ;(kind === 'sentence' ? sentences : words).push({ text: t2, kind, src: q && q.dept || '' })
  }
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]
    // 句子素材：全库收集（句子池是稀缺资源，宽进；部门过滤在选择时做）
    if (q.type === 'translate') { (q.options || []).forEach(o => pushItem(o, 'sentence', q)) }
    else if (q.type === 'fill') { pushItem(_chReadFillSentence(q), 'sentence', q) }
    else if (q.type === 'judge' && _chReadIsEnglish(q.question)) { pushItem(q.question, 'sentence', q) }
    ;(q.explanation ? _chReadQuoted(q.explanation) : []).forEach(x => pushItem(x, 'sentence', q))
    ;(q.explanation ? _chReadQuoted(q.question) : []).forEach(x => pushItem(x, 'sentence', q))
    // 单词素材：listen/voicematch 题干 = 单词（本部门优先收集）
    if ((q.type === 'listen' || q.type === 'voicematch') && inDept(q)) pushItem(q.question, 'word', q)
  }
  let pool = sentences.filter(x => _chReadInDept(x, depts))
  if (pool.length < 6) pool = sentences.slice()                 // 句子太少 → 全库句子池
  if (pool.length < 3) pool = pool.concat(words.filter(x => _chReadInDept(x, depts)))
  if (pool.length < 3) pool = pool.concat(words.slice())
  const out = pool.slice(0, 400)
  _chReadPoolCache[key] = out
  return out
}
function _chReadInDept(x, depts) { return depts.indexOf(String(x.src || '')) >= 0 }

// FNV-1a 32 位（选句种子；Math.imul 防 32 位溢出）
function _chReadFnv(str) {
  let h = 0x811c9dc5
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h = h ^ s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
// 每日选句：同营次同部门同天恒定 3 句（素材不足给几条算几条）
function chReadPickFor(day, deptKey, round) {
  const pool = chReadPoolFor(deptKey)
  if (!pool.length) return []
  let h = _chReadFnv(String(round || '') + '|' + String(deptKey || '') + '|' + String(day))
  const n = Math.min(3, pool.length)
  const used = {}
  const out = []
  let guard = 0
  while (out.length < n && guard++ < 300) {
    h = (Math.imul(h, 0x01000193) ^ 0x9e3779b9) >>> 0
    const i = h % pool.length
    if (!used[i]) { used[i] = true; out.push(pool[i]) }
  }
  return out
}

// ---------- 识别比对（可选，纯参考） ----------

// 词级相似度（Levenshtein on 归一化词序列）→ 0~100
function chReadSim(said, target) {
  const norm = s => _chReadKey(s).split(' ').filter(Boolean)
  const a = norm(said), b = norm(target)
  if (!a.length || !b.length) return 0
  const m = a.length, n2 = b.length
  const dp = new Array(n2 + 1)
  for (let j = 0; j <= n2; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n2; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return Math.round((1 - dp[n2] / Math.max(m, n2)) * 100)
}

// ---------- 跟读会话 ----------

let chRead = null          // { day, items:[{text,kind}], idx, recs:[{url,asr,sim}|null], stars }
let _chReadRecorder = null
let _chReadChunks = []
let _chReadMicErr = false  // 麦克风不可用/被拒 → 允许直接自评打卡（绝不卡流程）

function chReadActive() { return !!chRead }

function chOpenRead(day) {
  const dept = (typeof chDeptKey === 'function') ? chDeptKey() : ''
  const round = (typeof chCurrentRound === 'function') ? chCurrentRound() : ''
  const items = chReadPickFor(day, dept, round)
  if (!items.length) { try { alert(t('chReadNoPool')) } catch (e) {} return }
  chRead = { day: day, items: items, idx: 0, recs: items.map(() => null), stars: 0 }
  _chReadMicErr = false
  renderChallengeRead()
}

function chReadBack() {
  chRead = null
  try { _chReadRecStopCleanup() } catch (e) {}
  if (typeof renderChallenge === 'function') renderChallenge()
}

// ---------- 录音 ----------
function _chReadRecStopCleanup() {
  if (_chReadRecorder) {
    try { if (_chReadRecorder.state === 'recording') _chReadRecorder.stop() } catch (e) {}
    try { _chReadRecorder.stream && _chReadRecorder.stream.getTracks().forEach(tr => tr.stop()) } catch (e) {}
    _chReadRecorder = null
  }
}
function chReadRecToggle() {
  if (!chRead) return
  if (_chReadRecorder) { _chReadRecStopCleanup(); renderChallengeRead(); return }
  chReadRecStart()
}
async function chReadRecStart() {
  if (!chRead) return
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _chReadMicErr = true
    renderChallengeRead()
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    _chReadChunks = []
    const rec = new MediaRecorder(stream)
    _chReadRecorder = rec
    rec.ondataavailable = e => { if (e.data && e.data.size) _chReadChunks.push(e.data) }
    rec.onstop = () => {
      try { stream.getTracks().forEach(tr => tr.stop()) } catch (e) {}
      const blob = new Blob(_chReadChunks, { type: rec.mimeType || 'audio/webm' })
      if (chRead && chRead.recs[chRead.idx]) {
        try { URL.revokeObjectURL(chRead.recs[chRead.idx].url) } catch (e) {}
      }
      if (chRead) chRead.recs[chRead.idx] = { url: URL.createObjectURL(blob), asr: '', sim: -1 }
      _chReadRecorder = null
      _chReadAsrTry(chRead ? chRead.idx : -1)
      if (chRead) renderChallengeRead()
    }
    rec.start()
    renderChallengeRead()
  } catch (e) {
    _chReadMicErr = true
    renderChallengeRead()
  }
}
function chReadPlayMine() {
  if (!chRead) return
  const r = chRead.recs[chRead.idx]
  if (!r) return
  try { new Audio(r.url).play() } catch (e) {}
}
// 听示范：复用 listen 题同款朗读链路（本地 TTS 优先，1.8s 无声自动在线兜底）
function chReadListen(idx) {
  if (!chRead || !chRead.items[idx]) return
  if (typeof speakEnglish !== 'function') return
  speakEnglish(chRead.items[idx].text)
}

// ---------- 可选识别比对 ----------
function _chReadAsrTry(idx) {
  if (idx < 0 || !chRead || !chRead.recs[idx]) return
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const r = new SR()
    r.lang = 'en-US'
    r.interimResults = false
    r.maxAlternatives = 1
    r.onresult = e => {
      if (!chRead || !chRead.recs[idx]) return
      const said = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || ''
      chRead.recs[idx].asr = said
      chRead.recs[idx].sim = chReadSim(said, chRead.items[idx].text)
      renderChallengeRead()
    }
    r.onerror = () => { if (chRead && chRead.recs[idx]) chRead.recs[idx].sim = -1 }
    r.start()
  } catch (e) { /* 识别不可用 → 静默，纯参考功能 */ }
}

// ---------- 翻页 / 打卡 ----------
function chReadNext() {
  if (!chRead) return
  if (chRead.idx < chRead.items.length - 1) {
    chRead.idx++
    renderChallengeRead()
    return
  }
  renderChallengeRead()   // 最后一句 → 显示自评打卡区
}
function chReadComplete(stars) {
  if (!chRead) return
  const n = Number(stars)
  if (!Number.isInteger(n) || n < 1 || n > 3) return
  const day = chRead.day
  try {
    if (typeof challengeState !== 'undefined' && challengeState) {
      challengeState.read = challengeState.read || {}
      challengeState.read[day] = { done: true, at: Date.now(), stars: n }
      if (typeof challengeSave === 'function') challengeSave()
    }
    if (typeof Store !== 'undefined' && Store && typeof Store.reportChallengeRead === 'function') {
      Store.reportChallengeRead(day, n, (typeof chCurrentRound === 'function') ? chCurrentRound() : '')
    }
  } catch (e) { /* 本机优先：上报失败不影响打卡 */ }
  try { _chReadRecStopCleanup() } catch (e) {}
  chRead = null
  if (typeof renderChallenge === 'function') renderChallenge()
}

// ---------- 渲染 ----------

// 日卡里的跟读行（challenge.js chDayBlockHtml 调用；仅含 practice 环节的天出现）
function chReadRowHtml(cfg) {
  if (!cfg || !Array.isArray(cfg.stages)) return ''
  const hasPractice = cfg.stages.some(s => s && s.kind === 'practice')
  if (!hasPractice) return ''
  if (typeof t !== 'function' || typeof challengeState === 'undefined') return ''
  const rec = challengeState && challengeState.read && challengeState.read[cfg.day]
  const locked = (typeof chOpenLocked === 'function') ? chOpenLocked() : false
  const unlocked = (typeof chDayUnlocked === 'function') ? chDayUnlocked(cfg.day) : true
  const n = (typeof chReadPickFor === 'function') ? Math.max(1, chReadPickFor(cfg.day, (typeof chDeptKey === 'function') ? chDeptKey() : '', (typeof chCurrentRound === 'function') ? chCurrentRound() : '').length) : 3
  let right
  if (rec) {
    right = `<span style="font-size:12px;color:#059669;flex-shrink:0">${'⭐'.repeat(rec.stars)} ${t('chReadDone')}</span>`
  } else if (locked) {
    const st = (typeof chRoundOpenState === 'function') ? chRoundOpenState() : null
    const closedTxt = st && st.state === 'upcoming' ? t('chRoundUpcomingShort') : (st && st.state === 'ended' ? t('chEnded') : t('chNotOpenShort'))
    right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${closedTxt}</span>`
  } else if (unlocked) {
    right = `<button class="btn btn-primary btn-sm" onclick="chOpenRead(${cfg.day})" style="flex-shrink:0">${t('chReadStart')}</button>`
  } else {
    right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${t('chLocked')}</span>`
  }
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <div style="flex:1;min-width:0">
        <span class="tag tag-type" style="margin-right:6px">🎤 ${t('chReadRowTag')}</span>
        <span style="font-size:13px;color:#6b7280">${t('chReadCount', n)}</span>
        ${rec ? `<span style="font-size:12px;color:#6366f1;margin-left:8px">✓</span>` : ''}
      </div>
      ${right}
    </div>`
}

function renderChallengeRead() {
  const el = document.getElementById('page-challenge')
  if (!el || !chRead) return
  const items = chRead.items
  const n = items.length
  const esc = (typeof escHtml === 'function') ? escHtml : (s => s)
  const stepOf = i => {
    const it = items[i]
    const r = chRead.recs[i]
    const cur = i === chRead.idx
    const border = cur ? '#2563eb' : (r ? '#059669' : '#e5e7eb')
    let controls = ''
    if (cur) {
      controls = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn btn-ghost btn-sm" onclick="chReadListen(${i})">${t('chReadListen')}</button>
          <button class="btn ${_chReadRecorder ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="chReadRecToggle()">${_chReadRecorder ? t('chReadRecStop') : t('chReadRecStart')}</button>
          ${r ? `<button class="btn btn-ghost btn-sm" onclick="chReadPlayMine()">${t('chReadPlay')}</button>` : ''}
          ${r ? `<button class="btn btn-ghost btn-sm" onclick="chReadRecStart()">${t('chReadReRec')}</button>` : ''}
        </div>
        <div style="margin-top:8px;font-size:12px;color:#6b7280">
          ${r && r.sim >= 0 ? t('chReadSimLabel', r.sim) : t('chReadSimNA')}
        </div>
        ${_chReadMicErr ? `<div class="feedback" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;margin-top:8px">${t('chReadMicNA')}</div>` : ''}
        <div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="chReadNext()">${i < n - 1 ? t('chReadOkBtn') : t('chReadFinish')}</button></div>`
    } else {
      controls = `<div style="margin-top:6px;font-size:12px;color:#9ca3af">${r ? '✓' : '·'}</div>`
    }
    return `
      <div style="border:2px solid ${border};border-radius:10px;padding:12px;margin-bottom:10px;${cur ? 'background:#eff6ff' : ''}">
        <div style="font-size:11px;color:#9ca3af;margin-bottom:4px">${t('chReadStep', i + 1, n)}</div>
        <div style="font-size:16px;font-weight:700;line-height:1.5">${esc(it.text)}</div>
        ${controls}
      </div>`
  }
  el.innerHTML = `
    <div class="card" style="border:2px solid #2563eb">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <h3 style="margin:0">🎤 ${t('chReadTitle', t('chDay', chRead.day))}</h3>
        <button class="btn btn-ghost btn-sm" onclick="chReadBack()">${t('chReadBack')}</button>
      </div>
      <p style="font-size:13px;color:#6b7280;margin:8px 0 12px">${t('chReadHint')}</p>
      ${items.map((_, i) => stepOf(i)).join('')}
      ${chRead.idx === n - 1 ? `
        <div style="border-top:1px solid #e5e7eb;margin-top:10px;padding-top:10px">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px">${t('chReadRateAsk')}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${[1, 2, 3].map(s => `<button class="btn btn-primary btn-sm" onclick="chReadComplete(${s})">${'⭐'.repeat(s)} ${t('chReadFinish')}</button>`).join('')}
          </div>
        </div>` : ''}
    </div>`
}
