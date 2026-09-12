// ====== 标帜餐厅七天英文挑战（v68 引入；v70 入口移入练习页 + Day1/7 双阶段） ======
// 题源：分类 12「标帜餐厅常见词汇」（684 题）。固定种子（CHALLENGE_SEED）洗牌后按阶段切片：
//   Day1 = 水平测试 20 题 → 巩固练习 30 题；Day2-6 = 每日练习 50 题；Day7 = 巩固练习 30 题 → 水平测试 20 题。
// 全员同一套题（挑战共用 350 题）；Day1 与 Day7 的测试题集不同，进步数据真实。
// 入口在练习页底部（app.js renderPractice 挂入口卡片，navigate('challenge') 打开本页）。
// 进度存 localStorage eq_challenge_v2（绑定登录用户）；每题经 Store.addProgress(mode:'practice')
// 与 Store.trackPractice 汇入进度页/数据看板（口径与普通练习一致，分类 12 自动聚合）。
// 复用 app.js 工具：shuffleOptions / checkAnswer / quizTitleHtml / vmOptionsHtml / autoplayListen。

const CHALLENGE_SEED = 20260912
const CHALLENGE_KEY = 'eq_challenge_v2'
const CHALLENGE_DAYS = [
  { day: 1, stages: [ { kind: 'test', count: 20 }, { kind: 'practice', count: 30 } ] },
  { day: 2, stages: [ { kind: 'practice', count: 50 } ] },
  { day: 3, stages: [ { kind: 'practice', count: 50 } ] },
  { day: 4, stages: [ { kind: 'practice', count: 50 } ] },
  { day: 5, stages: [ { kind: 'practice', count: 50 } ] },
  { day: 6, stages: [ { kind: 'practice', count: 50 } ] },
  { day: 7, stages: [ { kind: 'practice', count: 30 }, { kind: 'test', count: 20 } ] },
]

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

// 挑战题池：分类 12 全部题（id 去重防御）按固定种子洗牌
function challengePool() {
  const all = Store.getQuestions().filter(q => Number(q.category_id) === 12)
  const seen = new Set()
  const uniq = []
  for (const q of all) {
    const k = String(q.id)
    if (!seen.has(k)) { seen.add(k); uniq.push(q) }
  }
  const rng = challengeRng(CHALLENGE_SEED)
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = uniq[i]; uniq[i] = uniq[j]; uniq[j] = tmp
  }
  return uniq
}

// 全部阶段的扁平元数据（切片起点 = 前面各阶段题数累加）
function challengeStageMeta() {
  let start = 0
  const out = []
  for (const d of CHALLENGE_DAYS) {
    d.stages.forEach((s, si) => {
      out.push({ day: d.day, si, kind: s.kind, count: s.count, start })
      start += s.count
    })
  }
  return out
}
function challengeStageInfo(day, si) {
  return challengeStageMeta().find(x => x.day === day && x.si === si)
}
// 第 N 天第 si 阶段题目（id 序稳定；选项顺序每次进入重洗，答案位置不固定）
function challengeStageQuestions(day, si) {
  const m = challengeStageInfo(day, si)
  return challengePool().slice(m.start, m.start + m.count).map(shuffleOptions)
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
function chDayUnlocked(day) {
  return day === 1 || chDayDone(day - 1)
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
  chs = {
    day, si, kind: challengeKindOf(day, si),
    questions: qs,
    answers: qs.map(() => -1),
    index: 0, phase: 'quiz', submitted: false, correctCount: 0,
  }
  renderChallengeQuiz()
}

function chQuit() {
  if (chs && chs.phase === 'quiz' && !confirm(t('chQuitConfirm'))) return
  chs = null
  renderChallenge()
}
function chBack() { chs = null; renderChallenge() }

function isChAnswered(i) {
  const a = chs && chs.answers[i]
  return a !== -1 && a !== undefined && a !== null
}

// ====== 概览页 ======
function renderChallenge() {
  const el = document.getElementById('page-challenge')
  if (!el) return
  challengeLoad()
  if (chs && (chs.phase === 'quiz' || chs.phase === 'result')) { renderChallengeQuiz(); return }
  const poolN = challengePool().length
  const rows = CHALLENGE_DAYS.map(d => chDayBlockHtml(d)).join('')
  el.innerHTML = `
    ${chReportHtml()}
    <div class="card">
      <h3>${t('chTitle')}</h3>
      <p class="form-hint" style="margin-bottom:8px">${t('chIntro')}</p>
      <p style="font-size:12px;color:#9ca3af;margin-bottom:12px">${t('chPoolInfo', poolN)}</p>
      <div>${rows}</div>
    </div>
  `
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
    const lockText = si > 0 ? t('chStageLocked') : t('chLocked')
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
      <div class="options-list">${chOptionsHtml(q, submitted)}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div class="quiz-progress">${t('questionOf', chs.index + 1, chs.questions.length)}</div>
        <div style="display:flex;gap:8px">${footerBtns}</div>
      </div>
    </div>
  `
  if (!submitted) autoplayListen(q)
}

// 三种单选题型（listen/single/voicematch）选项区
function chOptionsHtml(q, submitted) {
  const ans = chs.answers[chs.index]
  if (q.type === 'voicematch') {
    return vmOptionsHtml(q, ans, submitted ? 'review' : 'live', 'chPick')
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
    return `<div class="${cls}" onclick="${submitted ? '' : `chPick(${i})`}">
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

// 完成记录写入 days[day].stages[si]
function chRecordStage(correct, total) {
  if (!challengeState.days[chs.day]) challengeState.days[chs.day] = { stages: {} }
  const d = challengeState.days[chs.day]
  if (!d.stages) d.stages = {}
  d.stages[chs.si] = { done: true, at: Date.now(), correct, total }
  challengeSave()
  Store.trackPractice(correct, total)
}

// ---- 每日练习（逐题反馈） ----
function chSubmitAnswer() {
  const q = chs.questions[chs.index]
  const ans = chs.answers[chs.index]
  if (ans === undefined || ans === -1) return
  chs.submitted = true
  const correct = checkAnswer(q, ans)
  if (correct) chs.correctCount++
  Store.addProgress({
    question_id: q.id,
    category_id: q.category_id,
    dept: q.dept || '',
    type: q.type,
    correct,
    mode: 'practice',
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
  chRecordStage(chs.correctCount, chs.questions.length)
  chs.phase = 'result'
  renderChallengeQuiz()
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
  const total = chs.questions.length
  let correct = 0
  const review = chs.questions.map((q, i) => {
    const isCorrect = checkAnswer(q, chs.answers[i])
    if (isCorrect) correct++
    Store.addProgress({
      question_id: q.id,
      category_id: q.category_id,
      dept: q.dept || '',
      type: q.type,
      correct: isCorrect,
      mode: 'practice',
    })
    return { q, ans: chs.answers[i], isCorrect }
  })
  chRecordStage(correct, total)
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
  const review = isTest ? `
    <h3 class="section-title">${t('reviewTitle')}</h3>
    ${chs.review.map((r, i) => chReviewItemHtml(r, i)).join('')}` : ''
  el.innerHTML = hero + report + review + `
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
    ? `<button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakEnglish(this.dataset.w)" title="${escAttr(t('listenPlay'))}">🔊</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="speakLocalForce(this.dataset.w)" title="${escAttr(t('listenLocal'))}">🔉</button><button class="listen-btn-sm" type="button" data-w="${escAttr(q.question)}" onclick="playListenOnline(this.dataset.w)" title="${escAttr(t('listenOnline'))}">🌐</button> `
    : ''
  return `<div class="review-item ${r.isCorrect ? 'correct' : 'wrong'}">
    <div class="review-q">${i + 1}. ${audioBtns}${escHtml(q.question)}</div>
    <div class="review-ans">${t('yourAnswer')}<span class="${r.isCorrect ? 'review-correct' : 'review-wrong'}">${yourAns}</span></div>
    ${!r.isCorrect ? `<div class="review-ans">${t('correctAnswer')}：<span class="review-correct">${correctAns}</span></div>` : ''}
    ${q.explanation ? `<div class="review-ans" style="color:#6b7280">${q.explanation}</div>` : ''}
  </div>`
}
