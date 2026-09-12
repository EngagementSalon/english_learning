// ====== 标帜餐厅七天英文挑战（v68 引入；v70 入口移入练习页 + Day1/7 双阶段；v71 难度递增+时间锁+防作弊+看板上报；
//        v72 每日 30 题 + 测试每次随机 + 练习错题当天刷到全对 + 前一天错题次日额外复习 + 听音题醒目注解） ======
// 题源：分类 12「标帜餐厅常见词汇」（684 题 = 456 listen + 228 single，v71 起无 voicematch）。
// 练习序列（固定）：按难度分桶（1/2/3）按天配比抽取（CHALLENGE_DIFF_PLAN），Day1 均值 1.0 → Day7 均值 2.2；
//   Day1 巩固练习 10 题 → Day2-6 每日练习 30 题 → Day7 巩固练习 10 题，共 170 题，全员同一套练习题。
// 水平测试（随机，v72）：Day1/Day7 各 20 题 = 每次进入时从全池分层随机抽取（难度1×10 + 难度2×7 + 难度3×3），
//   每位学员、每次进入题目都不同；仍仅一次判分机会。
// 错题闭环（v72）：每日练习首次答错的题必须进入「错题回顾」轮刷到全对，该天才算完成；
//   前一天所有环节（练习+测试）的错题会在次日开始时额外追加到练习题末尾（不占每日 30 题配额），滚动复习。
// 入口在练习页底部（app.js renderPractice 挂入口卡片，navigate('challenge') 打开本页）。
// 进度存 localStorage eq_challenge_v2（绑定登录用户；v72 就地扩展 stage.wrong 字段，旧进度兼容）；
// 每题经 Store.addProgress(mode:'practice', challenge:true) 与 Store.trackPractice 汇入进度页/数据看板。
// 阶段完成经 Store.reportChallengeStage 上报云端（chy 事件，correct/total 为首次作答口径，不含回顾轮）。
// 时间锁（v71）：Day N 解锁需 Day N-1 全部完成且已过完成日次日 0 点（本地时区）——每天只能推进一天。
// 防作弊（v71）：水平测试接入 AntiCheat（切屏 3 次强制交卷计分，与在线考试同口径；管理员自动豁免）。
// 复用 app.js 工具：shuffleOptions / checkAnswer / quizTitleHtml / vmOptionsHtml / autoplayListen。

const CHALLENGE_SEED = 20260912
const CHALLENGE_KEY = 'eq_challenge_v2'
const CHALLENGE_DAYS = [
  { day: 1, stages: [ { kind: 'test', count: 20 }, { kind: 'practice', count: 10 } ] },
  { day: 2, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 3, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 4, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 5, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 6, stages: [ { kind: 'practice', count: 30 } ] },
  { day: 7, stages: [ { kind: 'practice', count: 10 }, { kind: 'test', count: 20 } ] },
]
// 挑战总题量（不含次日额外错题复习；进度条分母）
const CHALLENGE_TOTAL = CHALLENGE_DAYS.reduce((s, d) => s + d.stages.reduce((x, y) => x + y.count, 0), 0)   // 210
// 练习序列难度配比 [难度1, 难度2, 难度3]，与各天 practice 阶段一一对应（10/30/30/30/30/30/10，共 170 题）。
// 合计 82/82/6，均在题库容量 408/252/24 内；Day1 均值 1.0 → Day7 均值 2.2，难度逐日递增。
const CHALLENGE_DIFF_PLAN = [
  [10, 0, 0], [24, 6, 0], [19, 11, 0], [14, 16, 0], [9, 20, 1], [5, 23, 2], [1, 6, 3],
]
// 水平测试分层随机配比：难度1×10 + 难度2×7 + 难度3×3 = 20 题（保证测试覆盖全部难度）
const CHALLENGE_TEST_PLAN = [10, 7, 3]

// mulberry32 伪随机（固定种子 → 分配可复现、全员一致）
function challengeRng(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 练习序列：分类 12 全部题（id 去重防御）→ 按难度分桶（桶内固定种子洗牌）→ 按档配比抽取 170 题。
// 返回数组即练习序列：Day1 巩固练习 10 题在前，依次到 Day7 巩固练习 10 题在后（测试题不占序列，见下）。
// 难度逐日递增：Day1 均值 1.0 → Day7 均值 2.2；题库总量不足配比时自动顺延到下一个难度桶。
function challengePool() {
  const all = Store.getQuestions().filter(q => Number(q.category_id) === 12)
  const seen = new Set()
  const uniq = []
  for (const q of all) {
    const k = String(q.id)
    if (!seen.has(k)) { seen.add(k); uniq.push(q) }
  }
  const buckets = { 1: [], 2: [], 3: [] }
  for (const q of uniq) {
    const d = Math.min(3, Math.max(1, Number(q.difficulty) || 1))
    buckets[d].push(q)
  }
  ;[1, 2, 3].forEach(d => {
    const rng = challengeRng(CHALLENGE_SEED + d * 7919)
    for (let i = buckets[d].length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = buckets[d][i]; buckets[d][i] = buckets[d][j]; buckets[d][j] = tmp
    }
  })
  const out = []
  const cur = { 1: 0, 2: 0, 3: 0 }
  for (const plan of CHALLENGE_DIFF_PLAN) {
    ;[[plan[0], 1], [plan[1], 2], [plan[2], 3]].forEach(([n, d]) => {
      for (let k = 0; k < n; k++) {
        const q = buckets[d][cur[d]++]
        if (q) out.push(q)
      }
    })
  }
  return out
}

// 全部阶段的扁平元数据（切片起点 = 前面各 practice 阶段题数累加；test 随机抽题不占固定序列）
function challengeStageMeta() {
  let start = 0
  const out = []
  for (const d of CHALLENGE_DAYS) {
    d.stages.forEach((s, si) => {
      out.push({ day: d.day, si, kind: s.kind, count: s.count, start })
      if (s.kind === 'practice') start += s.count
    })
  }
  return out
}
function challengeStageInfo(day, si) {
  return challengeStageMeta().find(x => x.day === day && x.si === si)
}
// 水平测试随机抽题（v72）：从全池按 CHALLENGE_TEST_PLAN 分层随机（难度1×10 + 难度2×7 + 难度3×3），
// 每次进入（每位学员、每一场）题目都不同；库存不足时自动少抽。
function challengeRandomQuestions(total) {
  const all = Store.getQuestions().filter(q => Number(q.category_id) === 12)
  const seen = new Set()
  const buckets = { 1: [], 2: [], 3: [] }
  for (const q of all) {
    const k = String(q.id)
    if (!seen.has(k)) {
      seen.add(k)
      const d = Math.min(3, Math.max(1, Number(q.difficulty) || 1))
      buckets[d].push(q)
    }
  }
  const out = []
  ;[1, 2, 3].forEach((d, i) => {
    const b = buckets[d].slice()
    for (let k = b.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1))
      const tmp = b[k]; b[k] = b[j]; b[j] = tmp
    }
    for (let k = 0; k < CHALLENGE_TEST_PLAN[i] && out.length < total && k < b.length; k++) out.push(b[k])
  })
  return out.map(shuffleOptions)
}
// 前一天所有环节的错题（v72）：汇总 stages[].wrong（qid 去重）→ 取回题目 → 选项重洗。
// 旧进度记录无 wrong 字段时返回空数组（兼容 v71 及更早的已完成阶段）。
function chPrevDayWrongQuestions(prevDay) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === prevDay)
  if (!cfg) return []
  const seen = new Set()
  const out = []
  cfg.stages.forEach((_, si) => {
    const r = chStageRec(prevDay, si)
    const ws = r && Array.isArray(r.wrong) ? r.wrong : []
    ws.forEach(qid => {
      const k = String(qid)
      if (seen.has(k)) return
      seen.add(k)
      const q = Store.getQuestion(Number(k)) || Store.getQuestion(k)
      if (q) out.push(shuffleOptions(q))
    })
  })
  return out
}
// 第 N 天第 si 阶段题目：
//   test → 每次随机分层抽 20 题；practice → 固定序列切片 + （Day N≥2 首环节）追加前一天错题（额外，不占配额）。
//   选项顺序每次进入重洗，答案位置不固定。
function challengeStageQuestions(day, si) {
  const m = challengeStageInfo(day, si)
  if (m.kind === 'test') return challengeRandomQuestions(20)
  const qs = challengePool().slice(m.start, m.start + m.count).map(shuffleOptions)
  if (day > 1 && si === 0) {
    const extra = chPrevDayWrongQuestions(day - 1)
    return qs.concat(extra)
  }
  return qs
}
function challengeKindOf(day, si) {
  const m = challengeStageInfo(day, si)
  return m ? m.kind : 'practice'
}

// ---- 挑战进度（localStorage，绑定登录用户） ----
let challengeState = null
function challengeUid() {
  let s = null
  try { s = Store.getSession() } catch (e) {}
  return String((s && (s.username || s.id || s.name)) || 'anon')
}
function challengeLoad() {
  try { challengeState = JSON.parse(localStorage.getItem(CHALLENGE_KEY) || 'null') } catch (e) { challengeState = null }
  if (!challengeState || typeof challengeState !== 'object' || !challengeState.days) challengeState = null
  const uid = challengeUid()
  if (!challengeState || challengeState.uid !== uid) {
    challengeState = { uid, days: {} }
    challengeSave() // 换号重置立即落盘，避免上一账号数据残留 localStorage
  }
}
function challengeSave() {
  try { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(challengeState)) } catch (e) {}
}
function chStageRec(day, si) {
  const d = challengeState && challengeState.days[day]
  return d && d.stages ? d.stages[si] : null
}
function chStageDone(day, si) {
  const r = chStageRec(day, si)
  return !!(r && r.done)
}
// 一天完成 = 当天全部阶段完成
function chDayDone(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  return !!cfg && cfg.stages.every((_, si) => chStageDone(day, si))
}
// 某天全部完成的时间（当天各阶段完成时间的最大值；未完成返回 0）
function chDayLastDoneAt(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  if (!cfg) return 0
  let t = 0
  cfg.stages.forEach((_, si) => {
    const r = chStageRec(day, si)
    if (r && r.done && r.at) t = Math.max(t, r.at)
  })
  return t
}
// v71 时间锁：Day N 解锁需 Day N-1 全部完成，且已过完成日的次日 0 点（本地时区）——
// 保证每天只能推进一天，防止学员一天内把七天全部刷完。
function chDayUnlocked(day) {
  if (day === 1) return true
  if (!chDayDone(day - 1)) return false
  const lastAt = chDayLastDoneAt(day - 1)
  if (!lastAt) return false
  const done = new Date(lastAt)
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    > new Date(done.getFullYear(), done.getMonth(), done.getDate()).getTime()
}
// 阶段解锁：首阶段随天解锁；后续阶段需前一阶段完成
function chStageUnlocked(day, si) {
  return si === 0 ? chDayUnlocked(day) : chStageDone(day, si - 1)
}
function chStageScore(day, si) {
  const r = chStageRec(day, si)
  if (!r || !r.done || !r.total) return null
  return Math.round(r.correct / r.total * 100)
}
// 当天合并正确率（报告条形图用）
function chDayScore(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  if (!cfg) return null
  let c = 0, t = 0
  cfg.stages.forEach((_, si) => {
    const r = chStageRec(day, si)
    if (r && r.done) { c += r.correct; t += r.total }
  })
  return t ? Math.round(c / t * 100) : null
}
// 某天水平测试的正确率（进步报告对比用；无测试的天返回 null）
function chTestScoreOfDay(day) {
  const cfg = CHALLENGE_DAYS.find(x => x.day === day)
  if (!cfg) return null
  const si = cfg.stages.findIndex(s => s.kind === 'test')
  return si >= 0 ? chStageScore(day, si) : null
}

// ---- 挑战会话（内存态，切页保留，退出丢弃） ----
let chs = null

function chStartStage(day, si) {
  challengeLoad()
  if (!chStageUnlocked(day, si)) return
  if (challengeKindOf(day, si) === 'test' && chStageDone(day, si)) return // 水平测试仅一次
  const qs = challengeStageQuestions(day, si)
  if (!qs.length) return
  const m = challengeStageInfo(day, si)
  chs = {
    day, si, kind: challengeKindOf(day, si),
    questions: qs,
    answers: qs.map(() => -1),
    index: 0, phase: 'quiz', submitted: false, correctCount: 0,
    firstWrong: [],                       // v72：首轮答错的题（错题回顾 + 次日追加复习的数据源）
    extraCount: Math.max(0, qs.length - m.count),   // v72：次日追加的前一天错题数
    startedAt: Date.now(),                // v73：阶段开始时间 → chy usedSec（积分榜速度分）
  }
  if (chs.kind === 'test') {
    // v71：水平测试启用防作弊 —— 切屏 3 次强制交卷（按已答判分计次，与在线考试同口径）；管理员自动豁免
    AntiCheat.start({ maxViolations: 3, onSubmit: chCheatSubmit })
  } else {
    AntiCheat.stop() // 每日练习不启用；保险清理上一场残留
  }
  renderChallengeQuiz()
}

// 防作弊强制交卷（AntiCheat 达到切屏上限后回调；会话已不在则忽略）
function chCheatSubmit() {
  if (chs && chs.phase === 'quiz' && chs.kind === 'test') finishChallengeTest()
}

function chQuit() {
  if (chs && (chs.phase === 'quiz' || chs.phase === 'review') && !confirm(t('chQuitConfirm'))) return
  AntiCheat.stop()
  chs = null
  renderChallenge()
}
function chBack() { AntiCheat.stop(); chs = null; renderChallenge() }

function isChAnswered(i) {
  const a = chs && chs.answers[i]
  return a !== -1 && a !== undefined && a !== null
}

// ====== 概览页 ======
// 学员总进度卡（v71）：7 天格子（✓ 完成 / 数字 可做 / 🔒 未解锁）+ 环节与题数总进度条（v72 分母 = CHALLENGE_TOTAL 210）
function chProgressHtml() {
  const meta = challengeStageMeta()
  const doneStages = meta.filter(m => chStageDone(m.day, m.si)).length
  const doneQ = meta.reduce((s, m) => chStageDone(m.day, m.si) ? s + m.count : s, 0)
  const pct = Math.round(doneQ / CHALLENGE_TOTAL * 100)
  const cells = CHALLENGE_DAYS.map(d => {
    const done = chDayDone(d.day)
    const unlocked = chDayUnlocked(d.day)
    const bg = done ? '#059669' : unlocked ? '#f59e0b' : '#e5e7eb'
    const fg = done || unlocked ? '#fff' : '#9ca3af'
    const top = done ? '✓' : unlocked ? String(d.day) : '🔒'
    return `<div style="flex:1;min-width:0">
      <div style="height:34px;border-radius:8px;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800">${top}</div>
      <div style="font-size:11px;color:#6b7280;text-align:center;margin-top:3px;white-space:nowrap">${t('chDay', d.day)}</div>
    </div>`
  }).join('')
  return `
    <div class="card" style="border:2px solid #f59e0b;margin-bottom:16px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
        <h3 style="margin:0">🎯 ${t('chProgressTitle')}</h3>
        <span style="font-size:13px;color:#6b7280">${t('chProgressStages', doneStages)} · ${t('chProgressQ', doneQ)}</span>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:12px">${cells}</div>
      <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#f59e0b,#059669);border-radius:5px"></div>
      </div>
    </div>`
}

// ====== 积分榜前三（v74）======
// 与管理员看板 renderDashChallengeBlock 同口径：每环节按首次完成计（day-si 去重取 at 最早的 chy，
// 重练不刷分），积分 = 答对×100 − 用时秒；学员进挑战页即可看到当前前三（60s 缓存，避免频繁拉云端）
function chLbAggregate(rows) {
  const list = (rows || []).filter(r => r && r.chy && r.chy.length).map(r => {
    const first = {}
    ;(r.chy || []).forEach(x => {
      const k = x.day + '-' + x.si
      if (!first[k] || (x.at || 0) < (first[k].at || 0)) first[k] = x
    })
    let c = 0, tsec = 0
    Object.keys(first).forEach(k => { c += first[k].correct || 0; tsec += first[k].usedSec || 0 })
    return { name: r.name || r.username || '', username: r.username, correct: c, sec: tsec, score: c * 100 - tsec }
  })
  list.sort((a, b) => (b.score - a.score) || (a.sec - b.sec) || (b.correct - a.correct))
  return list.slice(0, 3)
}
function chLbRowsHtml(top) {
  if (!top || !top.length) return `<div style="color:#9ca3af;font-size:13px;padding:2px 0">${t('chLbEmpty')}</div>`
  const medal = i => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1))
  return top.map((p, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:${i < top.length - 1 ? '1px solid #f3f4f6' : 'none'}">
      <span style="font-size:18px;width:28px;text-align:center;flex-shrink:0">${medal(i)}</span>
      <span style="flex:1;min-width:0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</span>
      <span style="color:#6b7280;font-size:12px;flex-shrink:0">${t('dashChThCorrect')} ${p.correct}</span>
      <span style="font-weight:800;color:#b45309;flex-shrink:0">${p.score} ${t('scoreUnit')}</span>
    </div>`).join('')
}
let _chLbCache = { at: 0, top: null }
function chLbFill(top) {
  const el = document.getElementById('chLbBody')
  if (el) el.innerHTML = chLbRowsHtml(top)
}
async function chLoadLeaderboard() {
  const now = Date.now()
  if (_chLbCache.top && now - _chLbCache.at < 60000) { chLbFill(_chLbCache.top); return }
  let top = null
  try {
    if (typeof CloudSync !== 'undefined' && CloudSync.getDashboardData) {
      top = chLbAggregate(await CloudSync.getDashboardData())
    }
  } catch (e) { /* 网络失败保留旧缓存或显示空态 */ }
  if (top) _chLbCache = { at: now, top }
  chLbFill(_chLbCache.top)
}

function renderChallenge() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  challengeLoad()
  if (chs && (chs.phase === 'quiz' || chs.phase === 'review' || chs.phase === 'result')) { renderChallengeQuiz(); return }
  const bankN = Store.getQuestions().filter(q => Number(q.category_id) === 12).length
  const rows = CHALLENGE_DAYS.map(d => chDayBlockHtml(d)).join('')
  el.innerHTML = `
    ${chProgressHtml()}
    <div class="card" style="border:2px solid #f59e0b;margin-bottom:16px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:4px">
        <h3 style="margin:0">🏆 ${t('chLbTitle')}</h3>
        <span style="font-size:11px;color:#9ca3af">${t('chLbRule')}</span>
      </div>
      <div id="chLbBody" style="color:#9ca3af;font-size:13px">${t('cloudLoading')}</div>
      <p class="form-hint" style="margin:6px 0 0">🏆 ${t('dashChPrizeHint')}</p>
    </div>
    ${chReportHtml()}
    <div class="card">
      <h3>${t('chTitle')}</h3>
      <p class="form-hint" style="margin-bottom:8px">${t('chIntro')}</p>
      <p style="font-size:12px;color:#9ca3af;margin-bottom:12px">${t('chPoolInfo', bankN)}</p>
      <div>${rows}</div>
    </div>
  `
  chLoadLeaderboard()
}

function chDayBlockHtml(cfg) {
  const done = chDayDone(cfg.day)
  const unlocked = chDayUnlocked(cfg.day)
  const rows = cfg.stages.map((s, si) => chStageRowHtml(cfg.day, si, s)).join('')
  return `
    <div style="padding:12px 0;border-bottom:1px solid #e5e7eb">
      <div style="font-weight:800;margin-bottom:4px;color:${done ? '#059669' : unlocked ? '#111827' : '#9ca3af'}">${t('chDay', cfg.day)}${done ? ' <span style="font-size:12px;color:#059669">✓</span>' : ''}</div>
      ${rows}
    </div>`
}

function chStageRowHtml(day, si, s) {
  const done = chStageDone(day, si)
  const unlocked = chStageUnlocked(day, si)
  const isTest = s.kind === 'test'
  const score = chStageScore(day, si)
  const tag = isTest ? t('chTestTag') : t('chPracticeTag')
  const tagCls = isTest ? 'tag tag-type' : 'tag tag-category'
  let right = ''
  if (done) {
    if (isTest) {
      const color = score >= 80 ? '#059669' : score >= 60 ? '#d97706' : '#dc2626'
      right = `<div style="text-align:right;flex-shrink:0">
        <div style="font-weight:800;font-size:20px;color:${color}">${score}<span style="font-size:12px"> ${t('scoreUnit')}</span></div>
        <div style="font-size:11px;color:#9ca3af">${t('chOnceOnly')}</div>
      </div>`
    } else {
      right = `<button class="btn btn-ghost btn-sm" onclick="chStartStage(${day},${si})" style="flex-shrink:0">${t('chRetake')}</button>`
    }
  } else if (unlocked) {
    right = `<button class="btn btn-primary btn-sm" onclick="chStartStage(${day},${si})" style="flex-shrink:0">${t('chStart')}</button>`
  } else {
    // 锁定文案：阶段锁（si>0）= 完成上方环节；天锁 = 前置天未完成 → chLocked，已完成但未到次日 → chTomorrow
    const lockText = si > 0 ? t('chStageLocked')
      : (day > 1 && chDayDone(day - 1) ? t('chTomorrow') : t('chLocked'))
    right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${lockText}</span>`
  }
  const rec = done ? chStageRec(day, si) : null
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <div style="flex:1;min-width:0">
        <span class="${tagCls}" style="margin-right:6px">${tag}</span>
        <span style="font-size:13px;color:#6b7280">${t('questionsUnit', s.count)}</span>
        ${rec && !isTest ? `<span style="font-size:12px;color:#059669;margin-left:8px">✓ ${rec.correct}/${rec.total}</span>` : ''}
      </div>
      ${right}
    </div>`
}

// 七天进步报告（Day1 与 Day7 的水平测试均完成后显示；对比测试分，条形图展示每天合并正确率）
function chReportHtml() {
  if (!challengeState) return ''
  const s1 = chTestScoreOfDay(1), s7 = chTestScoreOfDay(7)
  if (s1 == null || s7 == null) return ''
  const bars = CHALLENGE_DAYS.map(({ day }) => {
    const s = chDayScore(day)
    if (s == null) return ''
    const color = s >= 80 ? '#059669' : s >= 60 ? '#d97706' : '#dc2626'
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="width:52px;font-size:12px;color:#6b7280;flex-shrink:0">${t('chDay', day)}</div>
        <div style="flex:1;height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
          <div style="width:${s}%;height:100%;background:${color}"></div>
        </div>
        <div style="width:44px;text-align:right;font-size:12px;font-weight:700">${s}%</div>
      </div>`
  }).join('')
  return `
    <div class="card" style="border:2px solid #059669;margin-bottom:16px">
      <h3>🏆 ${t('chReportTitle')}</h3>
      <p style="font-size:14px;margin-bottom:10px"><strong>${t('chDay', 1)}：${s1} ${t('scoreUnit')}</strong> → <strong>${t('chDay', 7)}：${s7} ${t('scoreUnit')}</strong><br><span style="color:#059669;font-weight:700">${t('chDelta', s7 - s1)}</span></p>
      <p style="font-size:12px;color:#6b7280;margin-bottom:8px">${t('chReportHint')}</p>
      ${bars}
    </div>`
}

// ====== 答题页 ======
function renderChallengeQuiz() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  if (!chs) { el.innerHTML = ''; return }
  if (chs.phase === 'review') { renderChallengeReview(); return }
  if (chs.phase === 'result') { chRenderResult(); return }
  const q = chs.questions[chs.index]
  const isTest = chs.kind === 'test'
  const submitted = !!chs.submitted

  let feedbackHtml = ''
  if (submitted && !isTest) {
    const isCorrect = checkAnswer(q, chs.answers[chs.index])
    feedbackHtml = `<div class="feedback ${isCorrect ? 'correct' : 'wrong'}">
      <strong>${isCorrect ? t('correctFeedback') : t('wrongFeedback')}</strong>
      <div class="explanation">${q.explanation || t('noExplanation')}</div>
      <div class="explanation">${t('correctAnswer')}：${q.answer.map(i => LETTERS[i]).join(', ')}</div>
    </div>`
  }

  const dots = chs.questions.map((_, i) => {
    let cls = 'exam-nav-dot'
    if (i === chs.index) cls += ' current'
    else if (isTest ? isChAnswered(i) : i < chs.index) cls += ' answered'
    const click = isTest ? ` onclick="chGoto(${i})"` : ''
    return `<div class="${cls}"${click}>${i + 1}</div>`
  }).join('')

  let footerBtns = ''
  if (isTest) {
    footerBtns = `
      ${chs.index > 0 ? `<button class="btn btn-ghost" onclick="chGoto(${chs.index - 1})">${t('prevQuestion')}</button>` : ''}
      ${chs.index < chs.questions.length - 1
        ? `<button class="btn btn-primary" onclick="chGoto(${chs.index + 1})">${t('nextQuestion')}</button>`
        : `<button class="btn btn-danger" onclick="chSubmitTest()">${t('chSubmitTest')}</button>`}`
  } else {
    footerBtns = !submitted
      ? `<button class="btn btn-primary" onclick="chSubmitAnswer()">${t('submitAnswer')}</button>`
      : chs.index < chs.questions.length - 1
        ? `<button class="btn btn-primary" onclick="chNext()">${t('nextQuestion')}</button>`
        : `<button class="btn btn-success" onclick="chFinishPractice()">${t('finishPractice')}</button>`
  }

  el.innerHTML = `
    <div class="exam-timer" style="margin-bottom:12px">
      <div>
        <strong>${t('chDay', chs.day)}</strong>
        <span class="tag ${isTest ? 'tag-type' : 'tag-category'}" style="margin-left:8px">${isTest ? t('chTestTag') : t('chPracticeTag')}</span>
      </div>
      <div style="display:flex;gap:8px">
        ${isTest ? `<button class="btn btn-danger btn-sm" onclick="chSubmitTest()">${t('chSubmitTest')}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="chQuit()" title="✕">✕</button>
      </div>
    </div>
    ${isTest ? `<div class="exam-nav" style="margin-bottom:16px">${dots}</div>` : ''}
    <div class="card">
      <div class="q-meta">
        <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
      </div>
      ${quizTitleHtml(q)}
      ${q.type === 'listen' ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:13px;color:#92400e;margin-bottom:12px">🔊 ${t('listenHint')}</div>` : ''}
      <div class="options-list">${chOptionsHtml(q, submitted, chs.answers[chs.index], 'chPick')}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', chs.index + 1, chs.questions.length)}</div>
        <div style="display:flex;gap:8px">${footerBtns}</div>
      </div>
    </div>
  `
  if (!submitted) autoplayListen(q)
}

// 三种单选题型（listen/single/voicematch）选项区（v72 参数化：练习/回顾轮共用）
function chOptionsHtml(q, submitted, ans, pickFn) {
  if (q.type === 'voicematch') {
    return vmOptionsHtml(q, ans, submitted ? 'review' : 'live', pickFn)
  }
  return q.options.map((opt, i) => {
    let cls = 'option-item'
    if (submitted) {
      if (q.answer.includes(i)) cls += ' correct'
      else if (ans === i) cls += ' wrong'
    } else if (ans === i) {
      cls += ' selected'
    }
    const badge = submitted && q.answer.includes(i) ? '✓' : LETTERS[i]
    return `<div class="${cls}" onclick="${submitted ? '' : `${pickFn}(${i})`}">
      <div class="option-badge">${badge}</div>
      <div class="option-text">${opt}</div>
    </div>`
  }).join('')
}

function chPick(i) {
  if (!chs || chs.phase !== 'quiz') return
  chs.answers[chs.index] = i
  renderChallengeQuiz()
}

// 完成记录写入 days[day].stages[si]；并上报云端（chy 事件 → 数据看板挑战统计）。
// v72：stage 记录追加 wrong = 首轮答错的 qid 列表（供次日额外复习）；chy 的 correct/total 为首次作答口径（不含回顾轮）。
// v73：chy 增加 usedSec = 阶段净用时秒（从进入环节到完成；退出重进会重置 startedAt，无法借重练刷速度分）
function chRecordStage(correct, total, wrongQids) {
  if (!challengeState.days[chs.day]) challengeState.days[chs.day] = { stages: {} }
  const d = challengeState.days[chs.day]
  if (!d.stages) d.stages = {}
  d.stages[chs.si] = { done: true, at: Date.now(), correct, total, wrong: (wrongQids || []).map(String) }
  challengeSave()
  Store.trackPractice(correct, total)
  const usedSec = chs.startedAt ? Math.max(0, Math.round((Date.now() - chs.startedAt) / 1000)) : 0
  try { Store.reportChallengeStage(chs.day, chs.si, chs.kind, correct, total, usedSec) } catch (e) {}
}

// ---- 每日练习（逐题反馈） ----
function chSubmitAnswer() {
  const q = chs.questions[chs.index]
  const ans = chs.answers[chs.index]
  if (ans === undefined || ans === -1) return
  chs.submitted = true
  const correct = checkAnswer(q, ans)
  if (correct) chs.correctCount++
  else chs.firstWrong.push(q)   // v72：首轮错题记录（当天回顾轮 + 次日额外复习）
  Store.addProgress({
    question_id: q.id,
    category_id: q.category_id,
    dept: q.dept || '',
    type: q.type,
    correct,
    mode: 'practice',
    challenge: true,
  })
  renderChallengeQuiz()
}
function chNext() {
  if (chs.index < chs.questions.length - 1) {
    chs.index++
    chs.submitted = false
    renderChallengeQuiz()
  }
}
function chFinishPractice() {
  const total = chs.questions.length
  if (chs.firstWrong.length) {
    // v72：当天错题必须刷到全对才算完成 —— 进入错题回顾轮（只做答错的题，循环至全对）
    chs.phase = 'review'
    chs.reviewQs = chs.firstWrong.slice()
    chs.reviewRound = 1
    chs.reviewIdx = 0
    chs.reviewAnswers = chs.reviewQs.map(() => -1)
    chs.reviewSubmitted = false
    chs.reviewWrongNow = []
    renderChallengeReview()
    return
  }
  chRecordStage(chs.correctCount, total, [])
  chs.phase = 'result'
  renderChallengeQuiz()
}

// ---- 错题回顾轮（v72）：只抽本轮仍错的题，全对即完成该阶段 ----
function chReviewPick(i) {
  if (!chs || chs.phase !== 'review') return
  chs.reviewAnswers[chs.reviewIdx] = i
  renderChallengeReview()
}
function chReviewSubmit() {
  const q = chs.reviewQs[chs.reviewIdx]
  const ans = chs.reviewAnswers[chs.reviewIdx]
  if (ans === undefined || ans === -1) return
  chs.reviewSubmitted = true
  const correct = checkAnswer(q, ans)
  if (!correct) chs.reviewWrongNow.push(q)
  Store.addProgress({
    question_id: q.id,
    category_id: q.category_id,
    dept: q.dept || '',
    type: q.type,
    correct,
    mode: 'practice',
    challenge: true,
  })
  renderChallengeReview()
}
function chReviewNext() {
  if (chs.reviewIdx < chs.reviewQs.length - 1) {
    chs.reviewIdx++
    chs.reviewSubmitted = false
    renderChallengeReview()
    return
  }
  // 本轮结束
  if (chs.reviewWrongNow.length) {
    chs.reviewQs = chs.reviewWrongNow.slice()
    chs.reviewRound++
    chs.reviewIdx = 0
    chs.reviewAnswers = chs.reviewQs.map(() => -1)
    chs.reviewSubmitted = false
    chs.reviewWrongNow = []
    renderChallengeReview()
    return
  }
  // 全对 → 阶段完成（chy 上报首次作答口径 correct/total）
  chRecordStage(chs.correctCount, chs.questions.length, chs.firstWrong.map(q => q.id))
  chs.phase = 'result'
  renderChallengeQuiz()
}

// 错题回顾轮渲染（练习模式逐题反馈；顶部显示轮次与回顾提示）
function renderChallengeReview() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  if (!chs || chs.phase !== 'review') { el.innerHTML = ''; return }
  const q = chs.reviewQs[chs.reviewIdx]
  const submitted = !!chs.reviewSubmitted

  let feedbackHtml = ''
  if (submitted) {
    const isCorrect = checkAnswer(q, chs.reviewAnswers[chs.reviewIdx])
    feedbackHtml = `<div class="feedback ${isCorrect ? 'correct' : 'wrong'}">
      <strong>${isCorrect ? t('correctFeedback') : t('wrongFeedback')}</strong>
      <div class="explanation">${q.explanation || t('noExplanation')}</div>
      <div class="explanation">${t('correctAnswer')}：${q.answer.map(i => LETTERS[i]).join(', ')}</div>
    </div>`
  }

  const last = chs.reviewIdx >= chs.reviewQs.length - 1
  const footerBtns = !submitted
    ? `<button class="btn btn-primary" onclick="chReviewSubmit()">${t('submitAnswer')}</button>`
    : last
      ? `<button class="btn btn-success" onclick="chReviewNext()">${chs.reviewWrongNow.length ? t('chReviewNextRound') : t('chReviewFinish')}</button>`
      : `<button class="btn btn-primary" onclick="chReviewNext()">${t('nextQuestion')}</button>`

  el.innerHTML = `
    <div class="exam-timer" style="margin-bottom:12px">
      <div>
        <strong>${t('chDay', chs.day)}</strong>
        <span class="tag tag-category" style="margin-left:8px">${t('chReviewTag')}</span>
        <span style="font-size:12px;color:#6b7280;margin-left:8px">${t('chReviewRound', chs.reviewRound)}</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="chQuit()" title="✕">✕</button>
    </div>
    <div class="card">
      <p class="form-hint" style="margin:0 0 10px">✏️ ${t('chReviewHint')}</p>
      <div class="q-meta">
        <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
      </div>
      ${quizTitleHtml(q)}
      ${q.type === 'listen' ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:13px;color:#92400e;margin-bottom:12px">🔊 ${t('listenHint')}</div>` : ''}
      <div class="options-list">${chOptionsHtml(q, submitted, chs.reviewAnswers[chs.reviewIdx], 'chReviewPick')}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', chs.reviewIdx + 1, chs.reviewQs.length)}</div>
        <div style="display:flex;gap:8px">${footerBtns}</div>
      </div>
    </div>
  `
  if (!submitted) autoplayListen(q)
}

// ---- 水平测试（统一判分） ----
function chGoto(i) {
  if (!chs || chs.phase !== 'quiz') return
  chs.index = i
  chs.submitted = false
  renderChallengeQuiz()
}
function chSubmitTest() {
  const unanswered = chs.answers.filter(a => a === -1 || a === undefined).length
  if (unanswered > 0 && !confirm(t('chConfirmSubmit', unanswered))) return
  finishChallengeTest()
}
function finishChallengeTest() {
  AntiCheat.stop() // 交卷（正常或强制）即停监听
  const total = chs.questions.length
  let correct = 0
  const wrongQids = []
  const review = chs.questions.map((q, i) => {
    const isCorrect = checkAnswer(q, chs.answers[i])
    if (isCorrect) correct++
    else wrongQids.push(q.id)   // v72：测试错题也进入次日额外复习池
    Store.addProgress({
      question_id: q.id,
      category_id: q.category_id,
      dept: q.dept || '',
      type: q.type,
      correct: isCorrect,
      mode: 'practice',
      challenge: true,
    })
    return { q, ans: chs.answers[i], isCorrect }
  })
  chRecordStage(correct, total, wrongQids)
  chs.review = review
  chs.score = Math.round(correct / total * 100)
  chs.phase = 'result'
  renderChallengeQuiz()
}

// ====== 结果页 ======
function chRenderResult() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  const isTest = chs.kind === 'test'
  const total = chs.questions.length
  const correct = isTest ? chs.review.filter(r => r.isCorrect).length : chs.correctCount
  const pct = Math.round(correct / total * 100)
  const hero = isTest ? `
    <div class="result-hero ${pct >= 60 ? 'score-pass' : 'score-fail'}">
      <div class="emoji">${pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '💪'}</div>
      <div class="score">${pct}<span style="font-size:24px">${t('scoreUnit')}</span></div>
      <div class="grade">${t('chTestDone')} · ${correct}/${total}</div>
    </div>` : `
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:12px">${pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '💪'}</div>
      <h2 style="font-size:24px;margin-bottom:8px">${t('chPracticeDone')}</h2>
      <p style="color:#6b7280;margin-bottom:8px">${t('practiceResult', correct, total, pct)}</p>
    </div>`
  const report = isTest && chs.day === 7 ? chReportHtml() : ''
  // v72：练习结果页显示前日错题复习量（本次作答含的额外题数）
  const extraNote = !isTest && chs.extraCount > 0
    ? `<p style="font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;display:inline-block">🔁 ${t('chExtraDone', chs.extraCount)}</p><br>`
    : ''
  const review = isTest ? `
    <h3 class="section-title">${t('reviewTitle')}</h3>
    ${chs.review.map((r, i) => chReviewItemHtml(r, i)).join('')}` : ''
  el.innerHTML = hero + extraNote + report + review + `
    <div style="text-align:center;margin-top:24px">
      <button class="btn btn-primary" onclick="chBack()">${t('chBackToChallenge')}</button>
    </div>`
  window.scrollTo(0, 0)
}

function chReviewItemHtml(r, i) {
  const q = r.q
  const yourAns = r.ans >= 0 ? `${LETTERS[r.ans]}. ${q.options[r.ans] || ''}` : t('notAnswered')
  const correctAns = q.answer.map(a => `${LETTERS[a]}. ${q.options[a]}`).join('；')
  const audioBtns = (q.type === 'listen' || q.type === 'voicematch')
    ? `<button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">${audioIconSvg('up')}</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">${audioIconSvg('down')}</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">${audioIconSvg('globe')}</button> `
    : ''
  return `<div class="review-item ${r.isCorrect ? 'correct' : 'wrong'}">
    <div class="review-q">${i + 1}. ${audioBtns}${escHtml(q.question)}</div>
    <div class="review-ans">${t('yourAnswer')}<span class="${r.isCorrect ? 'review-correct' : 'review-wrong'}">${yourAns}</span></div>
    ${!r.isCorrect ? `<div class="review-ans">${t('correctAnswer')}：<span class="review-correct">${correctAns}</span></div>` : ''}
    ${q.explanation ? `<div class="review-ans" style="color:#6b7280">${q.explanation}</div>` : ''}
  </div>`
}
