// ====== 测试 v53：错题回顾直到答对（作业 / 测评 / 视频课后小测）======
// ① courseReviewPending / courseTaskDone：首次作答有错 → 待回顾未完成；全对/老记录/题数已变 → 完成
// ② 成绩条目播种 review：courseBuildResultEntry / courseVideoQuizBuildEntry 有错写 review、全对清除、成绩字段不动
// ③ 学员卡片：待回顾错题徽标 + 回顾错题按钮；清空后恢复完成态
// ④ 行为级作业：首次作答留错 → 结果页回顾 CTA → 回顾轮次答错/答对收缩 wrongs → 全对后任务完成，成绩保留首次
// ⑤ 行为级测评：交卷后不可整卷重考，但待回顾时 courseStart 路由到回顾；视频小测同链路
// ⑥ course-store _applyResultOp review 重放（幂等：at 新旧 / 无基础记录 / 任务已删）
// ⑦ i18n 双语键齐全
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let failed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); failed = true }
}
function sliceBetween(s, a, b) {
  const i = s.indexOf(a)
  if (i < 0) return ''
  const j = b ? s.indexOf(b, i + a.length) : s.length
  return j < 0 ? '' : s.slice(i, j)
}

function mkEl() {
  return {
    innerHTML: '', style: {}, dataset: {}, textContent: '', className: '', title: '',
    placeholder: '', value: '', readOnly: false,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {}, lastElementChild: null, scrollIntoView() {},
  }
}

function makeSandbox(courseDocRef) {
  const elements = {}
  const getEl = id => elements[id] || (elements[id] = mkEl())
  let lastCreated = null
  const load = p => fs.readFileSync(path.join(__dirname, p), 'utf-8')
  const sandbox = {
    console,
    localStorage: {
      store: { eq_bank_version: '999', eq_course_only_v43: '1' },
      getItem(k) { return this.store[k] !== undefined ? this.store[k] : null },
      setItem(k, v) { this.store[k] = String(v) },
      removeItem(k) { delete this.store[k] },
    },
    document: {
      getElementById: getEl,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => { lastCreated = mkEl(); return lastCreated },
      body: { appendChild() {} }, title: '',
      addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    },
    window: {
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, scrollTo() {},
      speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] },
      SpeechSynthesisUtterance: function () {}, Audio: function () { this.play = () => Promise.resolve() },
    },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
    alert(m) { sandbox._lastAlert = String(m) }, confirm() { return true }, prompt() { return null },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, String, Number, Array, Object, Boolean, parseInt, parseFloat, isNaN,
    RegExp, Set, Map, Promise, TextEncoder, TextDecoder,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, events: [], map: {} }) }),
    AbortController,
    CloudSync: {
      status: 'online', onStatus() {}, enqueue() {}, addDuration() {},
      fetchSyncSummary: async () => ({ ok: true, doc: { events: [] }, map: {} }),
      getDashboardData: async () => [], recalcCloudPlacementLevels: async () => ({}),
      flushDuration() {}, pushPending: async () => {},
    },
    // 在线 CourseStore 模拟：mutate 直写 courseDocRef.doc（写后即最新）
    CourseStore: {
      status: 'online',
      newId: () => 'aX' + Math.floor(Math.random() * 1e6),
      findClass: (doc, id) => ((doc || {}).classes || []).find(c => c.id === id) || null,
      findAssign: (c, aid) => ((c || {}).assignments || []).find(a => a.id === aid) || null,
      getDoc: async () => JSON.parse(JSON.stringify(courseDocRef.doc)),
      mutate: async fn => {
        const doc = JSON.parse(JSON.stringify(courseDocRef.doc))
        const ret = fn(doc)
        if (ret === false) return null
        courseDocRef.doc = doc
        return true
      },
      enqueuePending: op => { (sandbox._pending = sandbox._pending || []).push(op); return true },
      pendingCount: () => (sandbox._pending || []).length,
    },
    _els: elements, _getEl: getEl, _lastCreated: () => lastCreated,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(load('i18n.js'), sandbox)
  vm.runInContext(load('bank-data.js'), sandbox)
  vm.runInContext(load('store.js'), sandbox)
  vm.runInContext(load('qgen.js'), sandbox)
  vm.runInContext(load('course-app.js'), sandbox)
  vm.runInContext(load('app.js'), sandbox)
  vm.runInContext('async function courseTestSeedDoc(){ courseState.doc = await CourseStore.getDoc() }', sandbox)
  return sandbox
}

function asStudent(sb, name) {
  const Store = vm.runInContext('Store', sb)
  Store.getSession = () => ({ id: 1, username: name, name })
  Store.getUser = () => ({ name, dept: '' })
  return Store
}

// 在沙箱里按每题作答：pat='r' 答对 / 'w' 答错（单选用非正确项；未答也视为错）
function answerPattern(pat) {
  return `(() => {
    const qz = courseQuiz
    const p = ${JSON.stringify(pat)}
    for (let i = 0; i < qz.questions.length; i++) {
      qz.index = i
      const q = qz.questions[i]
      if (p[i] === 'r') { qz.answers[i] = q.answer[0] }
      else {
        let wi = -1
        for (let k = 0; k < (q.options || []).length; k++) if (!q.answer.includes(k)) { wi = k; break }
        qz.answers[i] = wi
      }
      courseSubmitAnswer()
      if (i < qz.questions.length - 1) courseNextQ()
    }
    return qz.correct
  })()`
}

const Q3 = [
  { type: 'single', question: 'Q0', options: ['A', 'B'], answer: [0], explanation: 'e0', category_id: 1 },
  { type: 'single', question: 'Q1', options: ['A', 'B'], answer: [1], explanation: 'e1', category_id: 1 },
  { type: 'single', question: 'Q2', options: ['A', 'B'], answer: [0], explanation: 'e2', category_id: 1 },
]
const QUIZ2 = [
  { type: 'single', question: 'Z0', options: ['A', 'B'], answer: [0], explanation: 'z0' },
  { type: 'single', question: 'Z1', options: ['A', 'B'], answer: [1], explanation: 'z1' },
]

function mkDoc(assigns) {
  return { doc: { v: 1, classes: [{ id: 'c1', name: '班', note: '', createdAt: 1, createdBy: 'admin', members: ['s1'], assignments: assigns }] } }
}

async function main() {
  // ---------- ① 判定纯函数 ----------
  console.log('\n[1] courseReviewPending / courseTaskDone')
  {
    const sb = makeSandbox(mkDoc([]))
    const r = vm.runInContext(`
      (() => {
        const hw = { type: 'homework', questions: [{}, {}, {}] }
        const ex = { type: 'exam', questions: [{}, {}, {}] }
        const old = { type: 'homework', questions: [{}, {}, {}] }
        const resOld = { score: 60, correct: 2, total: 3 }
        const resOk = { score: 100, correct: 3, total: 3, review: { wrongs: [], qn: 3 } }
        const resBad = { score: 67, correct: 2, total: 3, review: { wrongs: [1], qn: 3 } }
        const resMismatch = { score: 67, correct: 2, total: 3, review: { wrongs: [1], qn: 4 } }
        const vid = { type: 'video', quiz: [{}, {}] }
        const vidWatchOnly = { type: 'video' }
        const resV = { watchedPct: 100, quizTotal: 2, quizCorrect: 1, review: { wrongs: [1], qn: 2 } }
        const resVNotAnswered = { watchedPct: 100 }   // 小测还没答
        const resVLow = { watchedPct: 30, quizTotal: 2, quizCorrect: 0, review: { wrongs: [0, 1], qn: 2 } }
        const resVCleared = { watchedPct: 100, quizTotal: 2, quizCorrect: 2, review: { wrongs: [], qn: 2 } }
        return {
          p1: courseReviewPending(hw, null),
          p2: courseReviewPending(hw, resOld),
          p3: courseReviewPending(hw, resOk),
          p4: courseReviewPending(hw, resBad),
          p5: courseReviewPending(hw, resMismatch),
          p6: courseReviewPending(ex, resBad),
          p7: courseReviewPending(vid, resV),
          p8: courseReviewPending(vid, resVNotAnswered),
          p9: courseReviewPending(vid, resVLow),
          p10: courseReviewPending(vid, resVCleared),
          p11: courseReviewPending(vidWatchOnly, resV),
          d1: courseTaskDone(hw, null),
          d2: courseTaskDone(hw, resOld),
          d3: courseTaskDone(hw, resOk),
          d4: courseTaskDone(hw, resBad),
          d5: courseTaskDone(hw, resMismatch),
          d6: courseTaskDone(ex, resBad),
          d7: courseTaskDone(vid, resV),
          d8: courseTaskDone(vid, resVNotAnswered),
          d9: courseTaskDone(vid, resVCleared),
          d10: courseTaskDone({ type: 'offline' }, { done: true }),
        }
      })()
    `, sb)
    assert('无记录 → 不需回顾', r.p1 === false)
    assert('老记录（无 review 字段）→ 不触发回顾（向后兼容）', r.p2 === false)
    assert('全对 wrongs=[] → 不需回顾', r.p3 === false)
    assert('作业有错题待回顾 → pending=true', r.p4 === true)
    assert('管理员改题（qn 不一致）→ 回顾链失效不阻塞', r.p5 === false)
    assert('测评有错题 → 同样待回顾', r.p6 === true)
    assert('视频小测已答有错 → 待回顾', r.p7 === true)
    assert('视频小测未答（待答题态）→ 不算回顾（先答题）', r.p8 === false)
    assert('视频完成度过低(30%) → 先补看，不归回顾', r.p9 === false)
    assert('视频小测全对 → 不需回顾', r.p10 === false)
    assert('纯观看视频（无小测）即使带 review 字段 → 不触发', r.p11 === false)
    assert('无记录 → 未完成', r.d1 === false)
    assert('老记录 → 完成', r.d2 === true)
    assert('全对 → 完成', r.d3 === true)
    assert('有待回顾错题 → 未完成（阻塞线性进度）', r.d4 === false)
    assert('题数变化 → 视为完成', r.d5 === true)
    assert('测评待回顾 → 未完成', r.d6 === false)
    assert('视频小测待回顾 → 未完成', r.d7 === false)
    assert('视频未答题 → 未完成（待答题态保留）', r.d8 === false)
    assert('视频小测全对 → 完成', r.d9 === true)
    assert('线下课 done → 完成', r.d10 === true)
  }

  // ---------- ② 成绩条目播种 review ----------
  console.log('\n[2] courseBuildResultEntry / courseVideoQuizBuildEntry 播种 review')
  {
    const sb = makeSandbox(mkDoc([]))
    const r = vm.runInContext(`
      (() => {
        const a = { type: 'homework', deadline: 0 }
        const w = { wq: [1, 4], qn: 10 }
        const e1 = courseBuildResultEntry(a, null, 80, 8, 10, 100, 1000, w)
        const eAll = courseBuildResultEntry(a, null, 100, 10, 10, 100, 1001, { wq: [], qn: 10 })
        // prev 已有更早 review（如前一轮未清）→ rounds 继承
        const ePrev = courseBuildResultEntry(a, { score: 80, review: { at: 500, qn: 10, wrongs: [2], rounds: 2 } }, 60, 6, 10, 100, 2000, { wq: [0, 3], qn: 10 })
        // 低分重做保留高分：成绩字段取 prev，review 仍按本次错题播种
        const eKeep = courseBuildResultEntry(a, { score: 90, correct: 9, total: 10, wq: [2], qn: 10, attempts: 1 }, 70, 7, 10, 50, 3000, { wq: [0, 1], qn: 10 })
        const eNone = courseBuildResultEntry(a, null, 80, 8, 10, 100, 4000, null)
        const va = { type: 'video', quiz: [1, 2] }
        const v1 = courseVideoQuizBuildEntry(va, { watchedPct: 92, attempts: 1 }, { watchedPct: 92 }, 8, 10, 5000, { wq: [7], qn: 10 })
        const vAll = courseVideoQuizBuildEntry(va, { watchedPct: 92 }, { watchedPct: 92 }, 10, 10, 5001, { wq: [], qn: 10 })
        return { e1, eAll, ePrev, eKeep, eNone, v1, vAll }
      })()
    `, sb)
    assert('有错 → review 播种（at/qn/wrongs）', r.e1.review && r.e1.review.qn === 10 && JSON.stringify(r.e1.review.wrongs) === '[1,4]' && r.e1.review.at === 1000, JSON.stringify(r.e1.review))
    assert('成绩字段照旧（score/correct/wq）', r.e1.score === 80 && r.e1.correct === 8 && JSON.stringify(r.e1.wq) === '[1,4]')
    assert('全对 → review 键被清除', !('review' in r.eAll))
    assert('继承已有 rounds（2 → 保持，仅全对轮才 +1 由回顾写入方处理）', r.ePrev.review.rounds === 2 && JSON.stringify(r.ePrev.review.wrongs) === '[0,3]')
    assert('低分重做：成绩保留 prev(90)/wq=[2]，review 按本次错题播种', r.eKeep.score === 90 && JSON.stringify(r.eKeep.wq) === '[2]' && JSON.stringify(r.eKeep.review.wrongs) === '[0,1]')
    assert('wrong=null → 不动 review（无键）', !('review' in r.eNone))
    assert('视频小测有错 → review 播种且成绩字段保留', r.v1.review && r.v1.quizCorrect === 8 && JSON.stringify(r.v1.review.wrongs) === '[7]')
    assert('视频小测全对 → review 清除', !('review' in r.vAll))
  }

  // ---------- ③ 学员卡片状态 ----------
  console.log('\n[3] 学员卡片：待回顾徽标 / 回顾按钮 / 清空恢复')
  {
    const docP = mkDoc([{ id: 'hw1', type: 'homework', title: '餐具英语', desc: '', deadline: 0, createdAt: 1,
      questions: JSON.parse(JSON.stringify(Q3)),
      results: { s1: { at: 100, score: 67, correct: 2, total: 3, usedSec: 10, attempts: 1, wq: [1], qn: 3, review: { at: 100, qn: 3, wrongs: [1], rounds: 0 } } } }])
    const sbP = makeSandbox(docP)
    asStudent(sbP, 's1')
    await vm.runInContext('courseTestSeedDoc()', sbP)
    vm.runInContext('renderCourseStudent()', sbP)
    const card = sbP._els['page-course'].innerHTML
    assert('作业待回顾 → 卡片含「待回顾错题」徽标', card.includes('待回顾错题') && card.includes('· 1'))
    assert('作业待回顾 → 显示「回顾错题」按钮（courseReviewStart）', card.includes("courseReviewStart('c1','hw1')") && card.includes('回顾错题'))
    assert('待回顾 → 不显示已完成 ✓', sliceBetween(card, '餐具英语', 'course-card-actions').indexOf('✓') < 0)
    // 线性进度：待回顾不算完成
    assert('线性进度节点不标完成', !sliceBetween(card, 'cp-path', 'cp-tip').includes('cp-node done'))
    // 清空后恢复完成
    const docD = mkDoc([{ id: 'hw1', type: 'homework', title: '餐具英语', desc: '', deadline: 0, createdAt: 1,
      questions: JSON.parse(JSON.stringify(Q3)),
      results: { s1: { at: 100, score: 67, correct: 2, total: 3, usedSec: 10, attempts: 1, wq: [1], qn: 3, review: { at: 200, qn: 3, wrongs: [], rounds: 1 } } } }])
    const sbD = makeSandbox(docD)
    asStudent(sbD, 's1')
    await vm.runInContext('courseTestSeedDoc()', sbD)
    vm.runInContext('renderCourseStudent()', sbD)
    const card2 = sbD._els['page-course'].innerHTML
    assert('wrongs=[] → 显示已完成 ✓', card2.includes('✓') && !card2.includes('待回顾错题'))
    // 测评待回顾卡片
    const docE = mkDoc([{ id: 'ex1', type: 'exam', title: '定级测评', desc: '', deadline: 0, duration: 0, createdAt: 1,
      questions: JSON.parse(JSON.stringify(Q3)),
      results: { s1: { at: 100, score: 67, correct: 2, total: 3, usedSec: 10, attempts: 1, wq: [1], qn: 3, review: { at: 100, qn: 3, wrongs: [1], rounds: 0 } } } }])
    const sbE = makeSandbox(docE)
    asStudent(sbE, 's1')
    await vm.runInContext('courseTestSeedDoc()', sbE)
    vm.runInContext('renderCourseStudent()', sbE)
    const cardE = sbE._els['page-course'].innerHTML
    assert('测评待回顾 → 徽标 + 回顾按钮（而不是“已完成”）', cardE.includes('待回顾错题') && cardE.includes('courseReviewStart'))
  }

  // ---------- ④ 作业行为级全链路 ----------
  console.log('\n[4] 作业全链路：首答留错 → 结果页回顾 CTA → 错题收缩 → 全对完成，成绩保留首次')
  {
    const ref = mkDoc([{ id: 'hw1', type: 'homework', title: '餐具英语作业', desc: '', deadline: 0, createdAt: 1,
      questions: JSON.parse(JSON.stringify(Q3)), results: {} }])
    const sb = makeSandbox(ref)
    asStudent(sb, 's1')
    await vm.runInContext('courseTestSeedDoc()', sb)
    vm.runInContext("courseStart('c1','hw1')", sb)
    assert('首次整卷 3 题', vm.runInContext('courseQuiz.questions.length', sb) === 3)
    // 显示序被 courseStart 随机打乱；对「显示第 2 题」答错 → 其 assignment 原下标 _oi 才是期望错题
    const expO = vm.runInContext('courseQuiz.questions[1]._oi', sb)
    // 答：对、错、对 → 得分 67，错 1 题
    const correct = vm.runInContext(answerPattern(['r', 'w', 'r']), sb)
    await vm.runInContext('courseFinishHomework()', sb)
    assert('作答正确题数 2', correct === 2)
    assert('交卷 phase=result', vm.runInContext('courseQuiz.phase', sb) === 'result')
    assert('pendingWq 记录答错那题的下标', vm.runInContext('courseQuiz.pendingWq.length', sb) === 1
      && vm.runInContext('courseQuiz.pendingWq[0]', sb) === expO)
    const resHtml = sb._els['page-course'].innerHTML
    assert('结果页出现回顾 CTA（需回顾错题 + 立即回顾按钮）', resHtml.includes('立即回顾错题（1）') && resHtml.includes('courseReviewFromResult'))
    assert('结果页保留得分 67 分', resHtml.includes('67') && resHtml.includes('分'))
    assert('强制：结果页无「稍后回顾 / 返回列表」出口（唯一操作=回顾）', !resHtml.includes('稍后回顾') && !resHtml.includes('返回列表') && !resHtml.includes('courseQuit('))
    // 云端记录：score 67 + review.wrongs=[_oi]
    const doc1 = await vm.runInContext('CourseStore.getDoc()', sb)
    const rec1 = doc1.classes[0].assignments[0].results.s1
    assert('云端成绩=首次（67 / 2/3 / wq 1 题）', rec1.score === 67 && rec1.correct === 2 && rec1.total === 3 && rec1.wq.length === 1)
    assert('云端 review 已播种（wrongs 指向答错那题 / rounds 0）', rec1.review && rec1.review.wrongs.length === 1 && rec1.review.wrongs[0] === expO && rec1.review.qn === 3 && rec1.review.rounds === 0)
    // 结果页 → 立即回顾：只抽 1 个错题
    vm.runInContext('courseReviewFromResult()', sb)
    assert('回顾会话 reviewing=true', vm.runInContext('courseQuiz.reviewing === true && courseQuiz.phase === "quiz"', sb) === true)
    assert('回顾作答页无「退出」链接（强制，不能中途放弃本轮）', !sb._els['page-course'].innerHTML.includes('course-quit'))
    assert('回顾轮只含错题（1 题）', vm.runInContext('courseQuiz.questions.length', sb) === 1)
    assert('回顾题保留原下标 _oi（等于答错那题）', vm.runInContext('courseQuiz.questions[0]._oi', sb) === expO,
      'expO=' + expO
      + ' oi=' + vm.runInContext('courseQuiz.questions[0]._oi', sb)
      + ' wrongs=' + vm.runInContext('JSON.stringify(courseQuiz.wrongs)', sb)
      + ' qpool=' + vm.runInContext('JSON.stringify((courseQuiz.pool||[]).map(q=>q._oi))', sb))
    // 第一轮回顾仍答错 → wrongs 不清空
    vm.runInContext(answerPattern(['w']), sb)
    await vm.runInContext('courseReviewRoundFinish()', sb)
    const doc2 = await vm.runInContext('CourseStore.getDoc()', sb)
    const rec2 = doc2.classes[0].assignments[0].results.s1
    assert('本轮仍答错 → review.wrongs 保留、rounds+1', rec2.review.wrongs.length === 1 && rec2.review.rounds === 1)
    assert('成绩仍是首次 67（review 轮不动成绩）', rec2.score === 67 && rec2.correct === 2)
    assert('回顾轮结果页提示「继续回顾」', sb._els['page-course'].innerHTML.includes('继续回顾（1）'))
    assert('仍有错 → 结果页无「返回列表」出口（唯一操作=继续回顾）', !sb._els['page-course'].innerHTML.includes('返回列表') && !sb._els['page-course'].innerHTML.includes('courseQuit('))
    // 重新拉云端 → 判定仍为未完成（有错题待回顾）
    await vm.runInContext('courseTestSeedDoc()', sb)
    assert('回顾轮结果页未完成（仍有错）', vm.runInContext('courseTaskDone(courseState.doc.classes[0].assignments[0], courseState.doc.classes[0].assignments[0].results.s1)', sb) === false)
    // 继续回顾 → 答对 → 全对完成
    vm.runInContext('courseReviewRoundBegin()', sb)
    vm.runInContext(answerPattern(['r']), sb)
    await vm.runInContext('courseReviewRoundFinish()', sb)
    const doc3 = await vm.runInContext('CourseStore.getDoc()', sb)
    const rec3 = doc3.classes[0].assignments[0].results.s1
    assert('全对轮 → review.wrongs=[]、rounds=2', rec3.review.wrongs.length === 0 && rec3.review.rounds === 2)
    assert('成绩保留首次 67（不因全对变 100）', rec3.score === 67 && rec3.correct === 2 && rec3.total === 3)
    assert('完成页出现「全部答对，任务完成」', sb._els['page-course'].innerHTML.includes('全部答对，任务完成'))
    // 重新拉云端 → 任务完成判定为 true
    await vm.runInContext('courseTestSeedDoc()', sb)
    assert('任务完成判定为 true', vm.runInContext('courseTaskDone(courseState.doc.classes[0].assignments[0], courseState.doc.classes[0].assignments[0].results.s1)', sb) === true)
    assert('无待补传 op（全在线）', (sb._pending || []).length === 0)
  }

  // ---------- ⑤ 测评 / 视频小测 行为级 ----------
  console.log('\n[5] 测评与视频小测：交卷后不可整卷重考但可回顾；视频小测同链路')
  {
    // 测评
    const refE = mkDoc([{ id: 'ex1', type: 'exam', title: '阶段测评', desc: '', deadline: 0, duration: 0, passScore: 60, createdAt: 1,
      questions: JSON.parse(JSON.stringify(Q3)), results: {} }])
    const sbE = makeSandbox(refE)
    asStudent(sbE, 's1')
    await vm.runInContext('courseTestSeedDoc()', sbE)
    vm.runInContext("courseStart('c1','ex1')", sbE)
    vm.runInContext(answerPattern(['r', 'w', 'r']), sbE)
    await vm.runInContext('courseExamSubmit(false)', sbE)
    assert('测评交卷 phase=result + pendingWq 1', vm.runInContext('courseQuiz.phase === "result" && courseQuiz.pendingWq.length === 1', sbE) === true)
    assert('测评结果页出现回顾入口', sbE._els['page-course'].innerHTML.includes('立即回顾错题（1）'))
    assert('强制：测评结果页无「稍后回顾」出口', !sbE._els['page-course'].innerHTML.includes('稍后回顾') && !sbE._els['page-course'].innerHTML.includes('courseQuit('))
    // 模拟离开（浏览器返回 / 关页，而非页面上可点的按钮）→ 待回顾状态；courseStart 应路由到回顾而非「已考完」弹窗
    vm.runInContext('courseQuit()', sbE)
    await vm.runInContext('courseTestSeedDoc()', sbE)
    vm.runInContext("courseStart('c1','ex1')", sbE)
    assert('测评待回顾 → courseStart 进入回顾会话', vm.runInContext('courseQuiz && courseQuiz.reviewing === true && courseQuiz.phase === "quiz"', sbE) === true)
    vm.runInContext(answerPattern(['r']), sbE)
    await vm.runInContext('courseReviewRoundFinish()', sbE)
    const docE = await vm.runInContext('CourseStore.getDoc()', sbE)
    const recE = docE.classes[0].assignments[0].results.s1
    assert('测评全对轮 → review 清空、成绩仍 67', recE.review.wrongs.length === 0 && recE.score === 67)
    vm.runInContext('courseQuit()', sbE)
    await vm.runInContext('courseTestSeedDoc()', sbE)
    vm.runInContext("courseStart('c1','ex1')", sbE)
    assert('测评已完成后 → 弹「已完成」而非再考（恢复原守卫）', sbE._lastAlert && sbE._lastAlert.indexOf('已完成') >= 0)
  }
  {
    // 视频小测：看完 → 答题留 1 错 → 结果页回顾 → 全对
    const refV = mkDoc([{ id: 'v1', type: 'video', title: '入住流程视频', desc: '', deadline: 0, createdAt: 1, videoUrl: 'https://x.mp4',
      quiz: JSON.parse(JSON.stringify(QUIZ2)),
      results: { s1: { at: 100, watched: true, watchedPct: 100, watchedSec: 200, duration: 200, difficulty: 3, attempts: 1 } } }])
    const sbV = makeSandbox(refV)
    asStudent(sbV, 's1')
    await vm.runInContext('courseTestSeedDoc()', sbV)
    vm.runInContext("courseVideoQuizStart('c1','v1','s1')", sbV)
    vm.runInContext(answerPattern(['r', 'w']), sbV)
    await vm.runInContext('courseVideoQuizFinish()', sbV)
    assert('小测交卷 pendingWq=1 + 结果页回顾入口', vm.runInContext('courseQuiz.pendingWq.length', sbV) === 1 && sbV._els['page-course'].innerHTML.includes('立即回顾错题（1）'))
    assert('强制：小测结果页无「稍后回顾」出口', !sbV._els['page-course'].innerHTML.includes('稍后回顾') && !sbV._els['page-course'].innerHTML.includes('courseQuit('))
    vm.runInContext('courseReviewFromResult()', sbV)
    vm.runInContext(answerPattern(['r']), sbV)
    await vm.runInContext('courseReviewRoundFinish()', sbV)
    const docV = await vm.runInContext('CourseStore.getDoc()', sbV)
    const recV = docV.classes[0].assignments[0].results.s1
    assert('视频小测全对轮 → review 清空', recV.review && recV.review.wrongs.length === 0)
    assert('小测成绩保留首次（quizScore 50）', recV.quizCorrect === 1 && recV.quizTotal === 2 && recV.quizScore === 50)
    assert('观看字段保留（watchedPct 100）', recV.watchedPct === 100)
  }

  // ---------- ⑥ course-store review 重放 ----------
  console.log('\n[6] course-store _applyResultOp review 重放（幂等合并）')
  {
    const CS = require('./course-store.js')
    const base = { at: 500, score: 67, correct: 2, total: 3, wq: [1], qn: 3, attempts: 1, review: { at: 500, qn: 3, wrongs: [1], rounds: 0 } }
    const opNew = { id: 'op1', atype: 'review', cid: 'c1', aid: 'hw1', u: 's1', entry: { at: 900, review: { at: 900, qn: 3, wrongs: [1], rounds: 1 } } }
    const d1 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'hw1', type: 'homework', results: { s1: JSON.parse(JSON.stringify(base)) } }] }] }
    const r1 = CS._applyResultOp(d1, JSON.parse(JSON.stringify(opNew)))
    const rec1 = d1.classes[0].assignments[0].results.s1
    assert('较新的回顾轮 → applied 且只更新 review', r1 === 'applied' && rec1.review.rounds === 1 && rec1.review.wrongs.length === 1 && rec1.score === 67 && rec1.correct === 2)
    const d2 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'hw1', type: 'homework', results: { s1: JSON.parse(JSON.stringify(base)) } }] }] }
    d2.classes[0].assignments[0].results.s1.review = { at: 999, qn: 3, wrongs: [], rounds: 2 }
    const r2 = CS._applyResultOp(d2, JSON.parse(JSON.stringify(opNew)))
    assert('云端已有更新的回顾轮（review.at 更大）→ drop', r2 === 'drop' && d2.classes[0].assignments[0].results.s1.review.rounds === 2)
    const d3 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'hw1', type: 'homework', results: { s1: { at: 2000, score: 90 } } }] }] }
    const r3 = CS._applyResultOp(d3, JSON.parse(JSON.stringify(opNew)))
    assert('云端作答时间更新（at 更大）→ drop', r3 === 'drop')
    const d4 = { v: 1, classes: [{ id: 'c1', assignments: [{ id: 'hw1', type: 'homework', results: {} }] }] }
    const r4 = CS._applyResultOp(d4, JSON.parse(JSON.stringify(opNew)))
    assert('无基础成绩记录 → drop（等待首答 op 先入）', r4 === 'drop' && !d4.classes[0].assignments[0].results.s1)
    const r5 = CS._applyResultOp({ v: 1, classes: [] }, { id: 'x', atype: 'review', cid: 'cX', aid: 'aX', u: 's1', entry: {} })
    assert('任务/班级已删除 → drop', r5 === 'drop')
  }

  // ---------- ⑦ i18n ----------
  console.log('\n[7] i18n 双语键')
  {
    const sb = makeSandbox(mkDoc([]))
    const keys = ['courseReviewTag', 'courseReviewBtn', 'courseReviewVideoTip', 'courseReviewNeedHint', 'courseReviewNeedKeep',
      'courseReviewStartNow', 'courseReviewFirstTitle', 'courseReviewFirstExamTitle', 'courseReviewSubmitBtn',
      'courseReviewClearedTitle', 'courseReviewClearedMsg', 'courseReviewScoreKept', 'courseReviewAgainTitle', 'courseReviewAgainMsg',
      'courseReviewMustHint', 'courseReviewContinue']
    const r = vm.runInContext(`
      (() => {
        setLang('zh')
        const zh = ${JSON.stringify(keys)}.map(k => t(k, 3))
        setLang('en')
        const en = ${JSON.stringify(keys)}.map(k => t(k, 3))
        setLang('zh')
        return { zh, en }
      })()
    `, sb)
    keys.forEach((k, i) => {
      assert(`zh.${k}`, typeof r.zh[i] === 'string' && r.zh[i].length > 0 && r.zh[i] !== k, r.zh[i])
    })
    keys.forEach((k, i) => {
      assert(`en.${k}`, typeof r.en[i] === 'string' && r.en[i].length > 0 && r.en[i] !== k, r.en[i])
    })
    assert('中文回顾按钮文案', r.zh[keys.indexOf('courseReviewBtn')] === '回顾错题')
    assert('英文回顾按钮文案', r.en[keys.indexOf('courseReviewBtn')] === 'Review mistakes')
  }

  console.log(failed ? '\n===== v53 测试：存在失败 =====' : '\n===== v53 测试：全部通过 =====')
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.error('测试执行异常:', e); process.exit(1) })
