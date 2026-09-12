// ====== 标帜餐厅七天英文挑战（v68；v69 测试改 20 题） ======
// 题源：分类 12「标帜餐厅常见词汇」（684 题）。固定种子（CHALLENGE_SEED）洗牌后按天切片：
// Day1/Day7 水平测试各 20 题，Day2-6 每日练习各 50 题（共 290 题，全员同一套题）。
// Day1/Day7 = 水平测试（统一判分、仅可作答一次）；Day2-6 = 每日练习（逐题即时反馈、可重练）。
// 进度存 localStorage eq_challenge_v1（按登录用户绑定）；每题经 Store.addProgress(mode:'practice')
// 与 Store.trackPractice 汇入进度页/数据看板（口径与普通练习一致，分类 12 自动聚合）。
// 复用 app.js 工具：shuffleOptions / checkAnswer / quizTitleHtml / vmOptionsHtml / autoplayListen。

const CHALLENGE_SEED = 20260912
const CHALLENGE_TEST_COUNT = 20
const CHALLENGE_KEY = 'eq_challenge_v1'
const CHALLENGE_DAYS = [
  { day: 1, kind: 'test', count: CHALLENGE_TEST_COUNT },
  { day: 2, kind: 'practice', count: 50 },
  { day: 3, kind: 'practice', count: 50 },
  { day: 4, kind: 'practice', count: 50 },
  { day: 5, kind: 'practice', count: 50 },
  { day: 6, kind: 'practice', count: 50 },
  { day: 7, kind: 'test', count: CHALLENGE_TEST_COUNT },
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

// 第 N 关题目（id 序稳定；切片起点 = 前面各关题数累加；选项顺序每次进入重洗，答案位置不固定）
function challengeDayQuestions(day) {
  let start = 0
  for (const d of CHALLENGE_DAYS) {
    if (d.day === day) break
    start += d.count
  }
  const cfg = CHALLENGE_DAYS.find(d => d.day === day)
  return challengePool().slice(start, start + cfg.count).map(shuffleOptions)
}

function challengeKind(day) {
  const d = CHALLENGE_DAYS.find(x => x.day === day)
  return d ? d.kind : 'practice'
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
function challengeDayDone(day) {
  const d = challengeState && challengeState.days[day]
  return !!(d && d.done)
}
function challengeDayUnlocked(day) {
  return day === 1 || challengeDayDone(day - 1)
}
function challengeScore(day) {
  const d = challengeState && challengeState.days[day]
  if (!d || !d.done || !d.total) return null
  return Math.round(d.correct / d.total * 100)
}

// ---- 挑战会话（内存态，切页保留，退出丢弃） ----
let chs = null

function chStartDay(day) {
  challengeLoad()
  if (!challengeDayUnlocked(day)) return
  if (challengeKind(day) === 'test' && challengeDayDone(day)) return // 水平测试仅一次
  const qs = challengeDayQuestions(day)
  if (!qs.length) return
  chs = {
    day, kind: challengeKind(day),
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
  const rows = CHALLENGE_DAYS.map(d => chDayRowHtml(d)).join('')
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

function chDayRowHtml(cfg) {
  const day = cfg.day
  const done = challengeDayDone(day)
  const unlocked = challengeDayUnlocked(day)
  const isTest = cfg.kind === 'test'
  const tag = isTest ? t('chTestTag') : t('chPracticeTag')
  const tagCls = isTest ? 'tag tag-type' : 'tag tag-category'
  const score = challengeScore(day)
  let right = ''
  if (done) {
    if (isTest) {
      const color = score >= 80 ? '#059669' : score >= 60 ? '#d97706' : '#dc2626'
      right = `<div style="text-align:right;flex-shrink:0">
        <div style="font-weight:800;font-size:20px;color:${color}">${score}<span style="font-size:12px"> ${t('scoreUnit')}</span></div>
        <div style="font-size:11px;color:#9ca3af">${t('chOnceOnly')}</div>
      </div>`
    } else {
      right = `<button class="btn btn-ghost btn-sm" onclick="chStartDay(${day})" style="flex-shrink:0">${t('chRetake')}</button>`
    }
  } else if (unlocked) {
    right = `<button class="btn btn-primary btn-sm" onclick="chStartDay(${day})" style="flex-shrink:0">${t('chStart')}</button>`
  } else {
    right = `<span style="font-size:12px;color:#9ca3af;flex-shrink:0">🔒 ${t('chLocked')}</span>`
  }
  const dRec = done ? challengeState.days[day] : null
  const left = `
    <div style="min-width:52px;font-weight:800;color:${done ? '#059669' : unlocked ? '#111827' : '#9ca3af'}">${t('chDay', day)}</div>
    <div style="flex:1;min-width:0">
      <div><span class="${tagCls}" style="margin-right:6px">${tag}</span><span style="font-size:13px;color:#6b7280">${t('questionsUnit', cfg.count)}</span></div>
      ${dRec ? `<div style="font-size:12px;color:#059669;margin-top:2px">✓ ${t('chDayDoneTag')} · ${dRec.correct}/${dRec.total}</div>` : ''}
    </div>`
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #e5e7eb">
      ${left}
      ${right}
    </div>`
}

// 七天进步报告（Day1 与 Day7 均完成后显示）
function chReportHtml() {
  if (!challengeState) return ''
  const d1 = challengeState.days[1], d7 = challengeState.days[7]
  if (!d1 || !d1.done || !d7 || !d7.done) return ''
  const s1 = challengeScore(1), s7 = challengeScore(7)
  const bars = CHALLENGE_DAYS.map(({ day }) => {
    const s = challengeScore(day)
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
  const total = chs.questions.length
  const correct = chs.correctCount
  challengeState.days[chs.day] = { done: true, at: Date.now(), correct, total }
  challengeSave()
  Store.trackPractice(correct, total)
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
  challengeState.days[chs.day] = { done: true, at: Date.now(), correct, total }
  challengeSave()
  Store.trackPractice(correct, total)
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
