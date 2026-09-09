// ====== 线下课模块：班级 / 作业 / 测评 ======
// 依赖：store.js（会话/题库）、cloud-store.js（看板用户名单/事件上报）、
//       course-store.js（班级云端仓库）、qgen.js（课程文件出题）、i18n.js（t()）

let courseState = { view: 'list', doc: null, classId: null, assignId: null, adminView: false }
let courseQuiz = null       // 进行中的作答会话
let courseTimerId = null
let courseDraft = null      // 新建作业的草稿（含题目预览）

// ====== 工具 ======
function courseUser() { const s = Store.getSession(); return s ? s.username : '' }
function courseUserName() { const s = Store.getSession(); return s ? (s.name || s.username) : '' }
function courseFmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function courseFind(cid) { return CourseStore.findClass(courseState.doc || { classes: [] }, cid) }
function courseFindAssign(cid, aid) { const c = courseFind(cid); return CourseStore.findAssign(c, aid) }

// ====== 成员信息映射（用户名 → 中文名 / 部门）======
// 数据源：云端看板（全量注册用户，含其他设备自注册账号）+ 本机账号表，缓存 60 秒避免重复拉取
let _courseInfoCache = { at: 0, map: {} }
async function courseUserInfoMap() {
  if (_courseInfoCache.map && Date.now() - _courseInfoCache.at < 60000) return _courseInfoCache.map
  const map = {}
  try {
    Store.getUsers().forEach(u => { if (u && u.username) map[u.username] = { name: u.name || '', dept: u.dept || '' } })
  } catch (e) { /* ignore */ }
  try {
    const rows = await CloudSync.getDashboardData()
    rows.forEach(r => {
      const prev = map[r.username] || {}
      map[r.username] = { name: r.name || prev.name || '', dept: r.dept || prev.dept || '' }
    })
  } catch (e) { /* 离线：仅本机账号表 */ }
  _courseInfoCache = { at: Date.now(), map }
  return map
}
// 成员展示单元格：中文名加粗 + 用户名小字（便于识别账号）+ 部门换行灰字
// 无资料时回退为纯用户名
function courseMemberCell(u, map) {
  const info = (map || {})[u] || {}
  const name = info.name ? String(info.name).trim() : ''
  const dept = info.dept ? String(info.dept).trim() : ''
  if (!name && !dept) return `<strong>${escHtml(u)}</strong>`
  let html = `<strong>${escHtml(name || u)}</strong>`
  if (name) html += ` <span style="color:#9ca3af;font-size:11px">${escHtml(u)}</span>`
  if (dept) html += `<div style="color:#6b7280;font-size:12px">${escHtml(dept)}</div>`
  return html
}

// ====== 主入口（navigate('course')）======
// 用户改名时若离线，改名的班级迁移会先记入待办（eq_pending_course_rename），
// 每次进入线下课页面时自动重试，成功后清除待办
async function courseApplyPendingRename() {
  let pending = null
  try { pending = JSON.parse(localStorage.getItem('eq_pending_course_rename') || 'null') } catch (e) { /* ignore */ }
  if (!pending || !pending.from || !pending.to) return
  try {
    const ok = await CourseStore.renameUser(pending.from, pending.to)
    if (ok !== false) localStorage.removeItem('eq_pending_course_rename')
  } catch (e) { /* 离线：保留待办，下次再试 */ }
}

async function renderCoursePage() {
  const el = document.getElementById('page-course')
  if (!el) return
  // 作答进行中：不重新加载，保持作答界面
  if (courseQuiz && courseQuiz.phase === 'quiz') return courseRenderTake()
  if (courseQuiz && courseQuiz.phase === 'result') return courseQuiz.reviewing ? courseRenderReviewRoundResult() : courseRenderTakeResult()
  el.innerHTML = `<div class="card" style="text-align:center;padding:40px;color:#6b7280">${t('courseLoading')}</div>`
  try {
    courseState.doc = await CourseStore.getDoc()
  } catch (e) {
    el.innerHTML = `
      <div class="card" style="text-align:center;padding:40px">
        <div style="font-size:40px;margin-bottom:10px">📡</div>
        <p style="color:#6b7280;margin-bottom:20px">${t('courseOffline')}</p>
        <button class="btn btn-primary" onclick="renderCoursePage()">${t('courseRetry')}</button>
      </div>`
    return
  }
  // 补做离线期间的用户改名迁移（成功后重取文档）
  await courseApplyPendingRename()
  if (localStorage.getItem('eq_pending_course_rename')) {
    try { courseState.doc = await CourseStore.getDoc() } catch (e) { /* 用现有文档渲染 */ }
  }
  // v43：把已激活作业中的题目派生到本地题库（水平测试/刷题共用；指纹无变化时跳过写库）
  try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
  // 管理员：默认以学员视角浏览（可切换到管理模式）
  if (Store.isAdmin()) {
    if (courseState.adminView) return renderCourseAdmin()
    return renderCourseStudent()
  }
  return renderCourseStudent()
}

// 管理员在 学员视图 ↔ 管理模式 之间切换
function courseToggleAdminView() {
  courseState.adminView = !courseState.adminView
  renderCoursePage()
}

// ================================================================
// 学员端
// ================================================================
// 学员「我的班级」卡片 —— 线下课（无作答，只展示信息与完成状态）
function courseStudentOfflineCard(c, a, me) {
  const res = (a.results || {})[me]
  const done = !!(res && res.done)
  const absentSelf = !done && a.held && Array.isArray(a.absent) && a.absent.indexOf(me) >= 0
  const statusHtml = done
    ? `<span class="course-status done">✓ ${t('courseDoneTag')}</span>`
    : absentSelf
      ? `<span class="course-status pending">🚫 ${t('courseOfflineAbsentSelf')}</span>`
      : `<span class="course-status pending">${a.held ? t('courseOfflineMissed') : t('courseOfflinePending')}</span>`
  const whenHtml = a.date
    ? `<span>🕐 ${t('courseOfflineWhen')}：${courseOfflineWhen(a)}</span>`
    : `<span>🕐 ${t('courseOfflineWhen')}：${t('courseUnlimited')}</span>`
  const markInfo = done && res.by ? ` · ${t('courseOfflineMarkedBy', escHtml(courseMarkedByName(res.by)))}` : ''
  return `
    <div class="card course-card">
      <div class="course-card-head">
        <span class="course-type offline">📅 ${t('courseTypeOffline')}</span>
        <span class="course-class-tag">${escHtml(c.name)}</span>
        ${statusHtml}
      </div>
      <div class="course-card-title">${escHtml(a.title)}</div>
      ${a.desc ? `<div class="course-card-desc">${escHtml(a.desc)}</div>` : ''}
      <div class="course-card-meta">
        ${whenHtml}
        ${a.held ? `<span>✅ ${t('courseOfflineHeld')}</span>` : ''}
        ${markInfo}
      </div>
      <div class="course-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseOfflineView')}</button>
      </div>
    </div>`
}

// 学员「线性学习进度」：每个已加入班级的任务序列 → 节点路径 + 进度条 + 下一步引导
function courseStudentPathHtml(myClasses, me) {
  if (!myClasses || !myClasses.length) return ''
  const blocks = []
  myClasses.forEach(c => {
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')
    if (!assigns.length) return
    const total = assigns.length
    const doneCount = assigns.reduce((s, a) => s + (courseTaskDone(a, (a.results || {})[me]) ? 1 : 0), 0)
    const pct = Math.round(doneCount / total * 100)
    const nextIdx = assigns.findIndex(a => !courseTaskDone(a, (a.results || {})[me]))
    let chain = ''
    for (let i = 0; i < total; i++) {
      const a = assigns[i]
      const d = courseTaskDone(a, (a.results || {})[me])
      const isNext = i === nextIdx
      const dotTxt = d ? '✓' : (isNext ? '▶' : String(i + 1))
      const short = a.title.length > 9 ? a.title.slice(0, 9) + '…' : a.title
      chain += `<div class="cp-node${d ? ' done' : ''}${isNext ? ' next' : ''}" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')" title="${escAttr(a.title)}">
          <span class="cp-dot">${dotTxt}</span>
          <span class="cp-lbl">${courseTaskIcon(a)} ${escHtml(short)}</span>
        </div>`
      if (i < total - 1) {
        const nd = courseTaskDone(assigns[i + 1], (assigns[i + 1].results || {})[me])
        chain += `<span class="cp-conn${d && nd ? ' on' : ''}"></span>`
      }
    }
    let tipHtml
    if (nextIdx === -1) {
      tipHtml = `<div class="cp-tip ok">🎉 ${t('courseProgressAllDone')}</div>`
    } else {
      const na = assigns[nextIdx]
      const goBtn = courseIsOffline(na)
        ? `<button class="btn btn-ghost btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(na.id)}')">${t('courseOfflineView')}</button>`
        : `<button class="btn btn-primary btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(na.id)}')">${courseTaskIcon(na)} ${t('courseProgressGo')}</button>`
      tipHtml = `<div class="cp-tip">${t('courseProgressNext')}：<strong>${escHtml(na.title)}</strong> ${goBtn}</div>`
    }
    blocks.push(`
      <div class="card course-path-card">
        <div class="cp-head">
          <span class="course-class-tag">🎓 ${escHtml(c.name)}</span>
          <span class="cp-count">${t('courseProgressOf', doneCount, total)} · ${pct}%</span>
        </div>
        <div class="cp-bar"><div class="cp-bar-in" style="width:${pct}%"></div></div>
        <div class="cp-path">${chain}</div>
        ${tipHtml}
      </div>`)
  })
  if (!blocks.length) return ''
  return `<div class="course-progress-block">
    <h2 style="margin-bottom:12px">📈 ${t('courseMyProgressTitle')}</h2>
    ${blocks.join('')}
  </div>`
}

function renderCourseStudent() {
  const el = document.getElementById('page-course')
  const me = courseUser()
  const all = courseState.doc.classes || []
  const myClasses = all.filter(c => (c.members || []).includes(me))
  const availClasses = all.filter(c => !(c.members || []).includes(me))
  const warn = CourseStore.status !== 'online' ? `<p class="form-hint" style="color:#b45309">${t('courseCacheWarn')}</p>` : ''
  // v40：本地暂存待补传的成绩条数（云端写入失败时先落本机，恢复后自动上传）
  const pendN = (typeof CourseStore.pendingCount === 'function') ? CourseStore.pendingCount() : 0
  const pendHtml = pendN ? `<div style="padding:10px 16px;margin-bottom:16px;font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">⏳ ${t('coursePendingUpload', pendN)}</div>` : ''
  const now = Date.now()

  // --- 我的班级 ---
  let myCardsHtml = ''
  if (!myClasses.length) {
    myCardsHtml = `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">
      <p>${t('courseNoClass')}</p></div>`
  } else {
    myClasses.forEach(c => {
    // 草稿（未发送）作业对学员不可见
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')
    if (!assigns.length) {
      myCardsHtml += `<div class="card course-card"><div class="course-card-head">
        <span class="course-class-tag">${escHtml(c.name)}</span>
        <span style="color:#9ca3af;font-size:13px">${t('courseNoAssign')}</span></div></div>`
      return
    }
    assigns.forEach(a => {
      // 线下课：无作答，走独立卡片（信息 + 管理员标注状态）
      if (courseIsOffline(a)) { myCardsHtml += courseStudentOfflineCard(c, a, me); return }
      const res = (a.results || {})[me]
      const expired = a.deadline && now > a.deadline
      const isVideo = a.type === 'video'
      // 视频：仅完成记录 ≥90% 视为已完成；低完成度记录（如 3% 脏数据）视为未完成，引导重看刷新
      const videoLow = isVideo && !!res && res.watchedPct != null && Number(res.watchedPct) < 90
      // v44：配了小测且还没答 → 已看完也视为未完成，引导去答题
      const quizPending = isVideo && !!res && !videoLow && courseVideoQuizPending(a, res)
      // v53：首次作答有错题 → 待回顾（强制回顾至全对才算完成，成绩保留首次）
      const reviewPending = !!res && courseReviewPending(a, res)
      const done = !!res && !videoLow && !quizPending && !reviewPending
      let statusHtml, actionHtml
      if (done) {
        const overTag = res.overdue ? ` <span class="course-status expired">${t('courseOverdue')}</span>` : ''
        statusHtml = isVideo
          ? `<span class="course-status done">✓ ${t('courseDoneTag')}${res.watchedPct != null ? ' · ' + Math.min(100, Math.round(res.watchedPct)) + '%' : ''}${res.quizTotal != null ? ` · 📝 ${res.quizCorrect}/${res.quizTotal}` : ''}</span>${overTag}`
          : `<span class="course-status done">✓ ${t('courseDoneTag')} · ${res.score}${LANG === 'en' ? '' : '分'}</span>${overTag}`
        actionHtml = isVideo
          ? `<button class="btn btn-ghost btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseRetakeBtn')}</button>`
          : (a.type === 'homework' ? `<button class="btn btn-ghost btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseRetakeBtn')}</button>` : '')
      } else if (reviewPending) {
        const left = Array.isArray(res.review.wrongs) ? res.review.wrongs.length : 0
        statusHtml = expired
          ? `<span class="course-status expired">🔁 ${t('courseReviewTag')} · ${left}</span>`
          : `<span class="course-status review">🔁 ${t('courseReviewTag')} · ${left}</span>`
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="courseReviewStart('${escAttr(c.id)}','${escAttr(a.id)}')">🔁 ${t('courseReviewBtn')}</button>`
      } else if (quizPending) {
        statusHtml = expired
          ? `<span class="course-status expired">📝 ${t('courseVideoQuizTag')}</span>`
          : `<span class="course-status pending">📝 ${t('courseVideoQuizTag')}</span>`
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseVideoQuizBtn')}</button>`
      } else if (videoLow) {
        const low = Math.min(100, Math.round(Number(res.watchedPct)))
        statusHtml = expired
          ? `<span class="course-status expired">${t('courseVideoLowTag', low)}</span>`
          : `<span class="course-status pending">${t('courseVideoLowTag', low)}</span>`
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseWatchBtn')}</button>`
      } else if (expired) {
        statusHtml = `<span class="course-status expired">${t('courseExpiredOpen')}</span>`
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${isVideo ? t('courseWatchBtn') : t('courseStartBtn')}</button>`
      } else {
        statusHtml = `<span class="course-status pending">${t('coursePending')}</span>`
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')">${isVideo ? t('courseWatchBtn') : t('courseStartBtn')}</button>`
      }
      const typeBadge = isVideo ? `<span class="course-type video">🎬 ${t('courseTypeVideo')}</span>`
        : a.type === 'exam' ? `<span class="course-type exam">🧪 ${t('courseTypeExam')}</span>` : `<span class="course-type hw">📝 ${t('courseTypeHomework')}</span>`
      myCardsHtml += `
        <div class="card course-card">
          <div class="course-card-head">
            ${typeBadge}
            <span class="course-class-tag">${escHtml(c.name)}</span>
            ${statusHtml}
          </div>
          <div class="course-card-title">${escHtml(a.title)}</div>
          ${a.desc ? `<div class="course-card-desc">${escHtml(a.desc)}</div>` : ''}
          <div class="course-card-meta">
            ${isVideo
              ? `<span>🎬 ${t('courseVideoLabel')}</span>${a.quiz && a.quiz.length ? `<span>📝 ${t('courseQuizCount', a.quiz.length)}</span>` : ''}`
              : `<span>📦 ${(a.questions || []).length}${t('courseQuestions')}</span>`}
            <span>⏰ ${t('courseDeadline')}：${a.deadline ? courseFmtDate(a.deadline) : t('courseNoDeadline')}</span>
            ${a.type === 'exam' && a.duration ? `<span>⏱️ ${a.duration}${LANG === 'en' ? ' min' : ' 分钟'}</span>` : ''}
          </div>
          <div class="course-card-actions">${actionHtml}</div>
        </div>`
    })
  })
  }

  // --- 可加入的班级 ---
  let availHtml = ''
  if (availClasses.length) {
    availHtml = availClasses.map(c => {
      const aCount = (c.assignments || []).filter(a => a.status !== 'draft').length
      const mCount = (c.members || []).length
      return `<div class="card course-card">
        <div class="course-card-head">
          <span class="course-class-tag">${escHtml(c.name)}</span>
          <span style="color:#9ca3af;font-size:13px">👥 ${mCount}${t('courseMembersUnit')}</span>
        </div>
        ${c.note ? `<div class="course-card-desc">${escHtml(c.note)}</div>` : ''}
        <div class="course-card-meta">
          <span>📋 ${aCount}${t('courseAssignUnit')}</span>
          <span>🕐 ${c.createdAt ? courseFmtDate(c.createdAt) : '—'}</span>
        </div>
        <div class="course-card-actions">
          <button class="btn btn-primary btn-sm" onclick="courseJoinClass('${escAttr(c.id)}')">${t('courseJoinBtn')}</button>
        </div>
      </div>`
    }).join('')
  } else {
    availHtml = `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">
      <p>${t('courseNoAvail')}</p></div>`
  }

  const pathHtml = courseStudentPathHtml(myClasses, me)
  el.innerHTML = `
    ${Store.isAdmin() ? `<div class="card" style="padding:12px 16px;border-left:4px solid #CDCF2C;margin-bottom:16px;font-size:13px;color:#5F6121;background:#F2F3CE;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="flex:1">${t('courseAdminPreviewBanner')}</span>
      <button class="btn btn-ghost btn-sm" onclick="courseToggleAdminView()">🛠️ ${t('courseSwitchAdminMode')}</button>
    </div>` : ''}
    ${pathHtml}
    ${pendHtml}
    <h2 style="margin-bottom:16px">🎓 ${t('courseMyTitle')}</h2>
    <div class="course-list">${myCardsHtml}</div>
    <h2 style="margin:28px 0 16px">📚 ${t('courseAvailTitle')}</h2>
    <div class="course-list">${availHtml}</div>
  ` + warn
}

async function courseJoinClass(cid) {
  const c = courseFind(cid)
  if (!c) return
  if (!confirm(t('courseJoinConfirm', c.name))) return
  try {
    await CourseStore.mutate(doc => {
      const cl = CourseStore.findClass(doc, cid)
      if (!cl) return false
      cl.members = cl.members || []
      if (cl.members.includes(courseUser())) return false   // 幂等：已加入不重复
      cl.members.push(courseUser())
    })
    alert(t('courseJoinOk'))
  } catch (e) { alert(t('courseJoinFail')); return }
  courseState.doc = await CourseStore.getDoc()
  renderCourseStudent()
}

// ================================================================
// 学员作答
// ================================================================
function courseStart(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  if (a.status === 'draft') { alert(t('courseDraftNotOpen')); return }   // 草稿（未发送）不可作答
  const me = courseUser()
  const res = (a.results || {})[me]
  // 线下课：线下授课，无作答 → 展示课程信息
  if (courseIsOffline(a)) { return courseOfflineInfoModal(cid, aid) }
  // 视频任务：走视频播放页
  if (a.type === 'video') { return courseStartVideo(cid, aid) }
  // v53：作业/测评有错题待回顾 → 直接进回顾（直到全对才算完成；成绩保留首次）
  if (res && (a.type === 'homework' || a.type === 'exam') && courseReviewPending(a, res)) {
    return courseReviewStart(cid, aid)
  }
  if (a.type === 'exam' && res) { alert(t('courseExamDoneAlert')); return }
  if (a.type === 'exam' && !confirm(t('courseExamStartConfirm', a.title))) return
  // v51：给每题标 _oi（assignment 内原下标），逐题错题明细按原题序记录
  const questions = (a.questions || []).map((q, i) => ({ ...q, _oi: i }))
    .sort(() => Math.random() - 0.5)
    .map(q => { const s = shuffleOptions(q); return { ...s, _cat: q.category_id, _oi: q._oi } })
  courseQuiz = {
    phase: 'quiz', cid, aid, type: a.type, title: a.title,
    questions, index: 0, answers: [], submitted: false, correct: 0,
    startAt: Date.now(),
    endAt: a.type === 'exam' && a.duration ? Date.now() + a.duration * 60000 : null,
    passScore: a.passScore || 60
  }
  if (courseQuiz.endAt) courseStartTimer()
  // 防作弊（v39 起作业+测评均启用）：禁止切屏，v59 起超 2 次强制结束本次作答
  // 强制结束 → courseForceTerminate：不计成绩、不计作答次数（不写 results/attempts/history），
  // 学员可重新开始作答（切屏计数重新累计）
  if ((a.type === 'exam' || a.type === 'homework') && typeof AntiCheat !== 'undefined') {
    AntiCheat.start({
      maxViolations: 2,
      finalKey: 'anticheatTerminate',
      onSubmit: function () { courseForceTerminate() },
    })
  }
  courseRenderTake()
}

// 线下课信息弹窗（学员视角：查看上课时间 / 备注 / 自己的完成状态）
function courseOfflineInfoModal(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const me = courseUser()
  const res = (a.results || {})[me]
  const done = !!(res && res.done)
  const absentSelf = !done && a.held && Array.isArray(a.absent) && a.absent.indexOf(me) >= 0
  const when = a.date ? courseFmtDate(a.date) : t('courseUnlimited')
  const status = done
    ? `<span class="course-status done">✓ ${t('courseDoneTag')}</span>`
    : absentSelf
      ? `<span class="course-status pending">🚫 ${t('courseOfflineAbsentSelf')}</span>`
      : `<span class="course-status pending">${a.held ? t('courseOfflineMissed') : t('courseOfflinePending')}</span>`
  const markInfo = done && res.by ? ` · ${t('courseOfflineMarkedBy', escHtml(courseMarkedByName(res.by)))} · ${courseFmtDate(res.at)}` : ''
  const footHint = absentSelf
    ? t('courseOfflineInfoAbsentHint')
    : (a.held ? t('courseOfflineInfoHeldHint') : t('courseOfflineInfoPendingHint'))
  courseModalOpen(t('courseOfflineInfoTitle'), `
    <div class="form-group"><label>${t('courseTypeLabel')}</label>
      <div style="padding-top:4px">📅 ${t('courseTypeOffline')} · 🎓 ${escHtml(c.name)}</div></div>
    <div class="form-group"><label>${t('courseThTitle')}</label>
      <div style="padding-top:4px;font-weight:600">${escHtml(a.title)}</div></div>
    <div class="form-group"><label>${t('courseOfflineWhen')}</label>
      <div style="padding-top:4px">🕐 ${when}</div></div>
    ${a.desc ? `<div class="form-group"><label>${t('courseClassNote')}</label><div style="padding-top:4px">${escHtml(a.desc)}</div></div>` : ''}
    <div class="form-group"><label>${t('courseThScore')}</label>
      <div style="padding-top:4px">${status}${markInfo}</div></div>
    <p class="form-hint">${footHint}</p>`,
    `<button class="btn btn-primary" onclick="courseModalClose()">${t('closeBtn')}</button>`)
}

function courseStartTimer() {
  courseStopTimer()
  courseTimerId = setInterval(() => {
    if (!courseQuiz || !courseQuiz.endAt) return courseStopTimer()
    if (Date.now() >= courseQuiz.endAt) {
      courseStopTimer()
      alert(t('courseExamTimeout'))
      courseExamSubmit(true)
    } else {
      const el = document.getElementById('courseTimer')
      if (el) {
        const left = Math.max(0, Math.floor((courseQuiz.endAt - Date.now()) / 1000))
        el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
        el.classList.toggle('urgent', left < 60)
      }
    }
  }, 1000)
}
function courseStopTimer() { if (courseTimerId) { clearInterval(courseTimerId); courseTimerId = null } }

// ================================================================
// 视频任务：播放 + 播完确认 + 完成追踪
// ================================================================
let courseVideoSnap = null   // 本次确认完成时的播放快照（提交时不再依赖 live 元素，防重绘/时长抖动）

// 视频完成度最终记录值：自然播完（ended）/ 无法读取时长 → 记 100%。
// 防止跨域时长元数据异常（duration 偏大或抖动）把完成度记成 3% 之类的低值并永远卡住。
function courseVideoFinalPct(o) {
  const dur = Number(o && o.duration) || 0
  const sec = Math.max(0, Number(o && o.watchedSec) || 0)
  if ((o && o.ended) || dur <= 0) return 100
  return Math.min(100, Math.round(sec / dur * 100))
}
// 幂等 + 自愈升级：无历史记录 → 允许写入；
// 新完成度更高（如 3% 脏数据 → 100%）→ 允许覆盖刷新；否则拒绝（幂等，不重复写）
function courseVideoEntryAllowed(prev, newPct) {
  if (!prev) return true
  const prevPct = prev.watchedPct != null ? Number(prev.watchedPct) : 100
  return newPct > prevPct
}

// ---- v39 防快进：覆盖式观看统计 ----
// 把实际播放经过的秒区间标记为「已看」；拖动进度条跳过的片段不标记 → 无法靠快进凑完成度
function courseWatchMark(watched, from, to) {
  const a = Math.max(0, Math.ceil(Number(from) || 0))
  const b = Math.floor(Number(to) || 0)
  for (let s = a; s < b; s++) watched.add(s)
}
// 有效观看百分比：已看秒数 / 总时长（读不到时长返回 0，由调用方走累计秒兜底）
function courseWatchedPct(watched, dur) {
  if (!(Number(dur) > 0)) return 0
  return Math.min(100, Math.round((watched.size / Number(dur)) * 100))
}
// 自然播完是否可信（旧整秒口径，保留供纯函数测试/历史调用；实际播放路径见 courseEndedTrustedBySec）：
// - 有时长 → 覆盖 ≥90%（v39 防快进：拖到结尾覆盖不足不算播完）
// - 无时长 → 用「自然播完位置 endPos」做覆盖比对：诚实看到结尾覆盖≈100% 通过；
//   拖到结尾覆盖≈0 不放行；位置读不到（ended 后 currentTime 归零等）才退化累计播放秒兜底。
//   v45：修复无时长视频诚实看到结尾、但累计秒未到 180s 兜底线被判不可信 → 永远无法确认进入小测
function courseEndedTrusted(watched, dur, accSec, fallback, endPos) {
  if (Number(dur) > 0) return courseWatchedPct(watched, dur) >= 90
  const p = Math.max(0, Number(endPos) || 0)
  if (p >= 5) return watched.size >= Math.max(8, Math.ceil(p * 0.85))
  return accSec >= fallback
}

// ---- v46：浮点有效观看秒口径（播放监控实际使用） ----
// 背景：旧 courseWatchMark 用「整秒取整区间」记账，依赖单次采样跨越 ≥1 整秒。
// 真实浏览器 timeupdate 约 4Hz（250ms 一跳）+ 1s 兜底定时器的采样间隔普遍 <1s 且相位错开，
// 导致几乎记不上任何整秒 → 视频播到 100% 但「已观看」恒 0%、无法确认、进不了课后小测。
// 新口径：有效观看秒 effSec 为浮点累计（真实播放每跳的经过秒直接累加，任意采样频率不丢秒），
// 快进跳段由调用方按「单次前进 >3s」拦截（不计入），因此无需整秒取整、也不依赖 paused/seeking 标志。
// 有效观看百分比（有时长）
function coursePctBySec(effSec, dur) {
  if (!(Number(dur) > 0)) return 0
  return Math.min(100, Math.round((Number(effSec) || 0) / Number(dur) * 100))
}
// 自然播完是否可信（浮点口径）：
// - 有时长 → 有效观看秒占比 ≥90%（拖到结尾 effSec 不足 → 不放行，需补看）
// - 无时长 → 用「自然播完位置 endPos」比对：诚实看到结尾 effSec≈endPos 通过；
//   拖到结尾 effSec 远小于位置 → 不放行；位置读不到才退 180s 累计秒兜底
function courseEndedTrustedBySec(effSec, dur, fallback, endPos) {
  if (Number(dur) > 0) return (Number(effSec) || 0) / Number(dur) >= 0.9
  const p = Math.max(0, Number(endPos) || 0)
  if (p >= 5) return (Number(effSec) || 0) >= Math.max(8, Math.ceil(p * 0.85))
  return (Number(effSec) || 0) >= fallback
}

// ================================================================
// 线下课（type:'offline'）公共工具
// 数据模型：assignment { type:'offline', title(主题名), topicId(题库分类id, 0=自定义),
//   custom(true=自定义主题), desc, date(上课时间戳, 0=未填), held(是否已下课标注),
//   heldAt, absent:[缺席成员用户名], results:{ 出席(完成)成员:{ done:true, at, by } } }
//   —— results 记录「出席」者，absent 记录「没来」者，二者互补（v35）
// ================================================================
function courseIsOffline(a) { return !!(a && a.type === 'offline') }

// v53：答题类任务（作业/测评/视频课后小测）「错题待回顾」判定。
// 首次作答有错 → 成绩条目写入 review = { at, qn, wrongs:[原题序下标], rounds }，
// 任务未完成，必须回顾（每轮只抽仍未答对的题）直到某轮全对（wrongs 清空）才算完成。
// 管理端改题导致题数与 review.qn 不一致 → 回顾链失效，不阻塞（按原成绩视为完成）。
function courseReviewPending(a, res) {
  if (!res || !res.review || !Array.isArray(res.review.wrongs) || !res.review.wrongs.length) return false
  if (!a) return false
  if (a.type === 'video') {
    if (!Array.isArray(a.quiz) || !a.quiz.length) return false   // 纯观看视频没有题，谈不上回顾
    if (res.quizTotal == null) return false                       // 小测还没答（「待答题」态）不归回顾管
    if (res.watchedPct != null && Number(res.watchedPct) < 90) return false  // 观看未达标 → 先补看，不归回顾
  } else if (a.type !== 'homework' && a.type !== 'exam') {
    return false
  }
  const qn = a.type === 'video' ? (a.quiz || []).length : (a.questions || []).length
  if (Number(res.review.qn) !== qn) return false
  return true
}

// 学员视角的任务完成判定（线性进度/列表共用）
// - 作业/测评：有成绩记录即完成；v53：有错题待回顾 → 未完成
// - 视频：记录 ≥90% 且（无小测 或 小测已作答）；v53：小测有错题待回顾 → 未完成
// - 线下课：管理员标注 done
function courseTaskDone(a, res) {
  if (!res) return false
  if (courseIsOffline(a)) return !!res.done
  if (a.type === 'video') {
    if (res.watchedPct != null && Number(res.watchedPct) < 90) return false
    if (courseVideoQuizPending(a, res)) return false
    return !courseReviewPending(a, res)
  }
  if (courseReviewPending(a, res)) return false
  return true
}

// v44：视频任务配了小测且该学员还没答 → 任务未完成（res.quizTotal 有值才算答过）
function courseVideoQuizPending(a, res) {
  return !!(a && a.type === 'video' && Array.isArray(a.quiz) && a.quiz.length &&
    (!res || res.quizTotal == null))
}

// v48：视频任务配了小测且已答完 → 返回课后小测正确率 {acc 四舍五入整数 %, correct, total}
//       否则返回 null（没配小测 / 还没答题）——成绩看板与 Excel 都按此优先显示正确率而非观看完成率
function courseVideoQuizScore(a, r) {
  if (!a || a.type !== 'video' || !Array.isArray(a.quiz) || !a.quiz.length) return null
  if (!r || r.quizTotal == null) return null
  const total = Math.max(1, Number(r.quizTotal) || 0)
  const correct = Math.max(0, Math.min(total, Number(r.quizCorrect) || 0))
  return { acc: Math.round(correct / total * 100), correct, total }
}

// v50：某任务全班错题率 —— 作业/测评按学员最终记录 correct/total 聚合（作业重做保留最高分那次，不重复计）；
//       视频配了小测 → 按已答学员 quizCorrect/quizTotal 聚合（看完未答的不计）；线下课 / 无小测视频 / 无人作答 → null
// 返回 { wrong: 答错题次, total: 答题题次, rate: 四舍五入整数错题率 %, n: 参与学员数 }——看板汇总行与 Excel 共用
function courseTaskWrongRate(a) {
  if (!a || courseIsOffline(a)) return null
  const isVideoQuiz = a.type === 'video' && Array.isArray(a.quiz) && a.quiz.length > 0
  let wrong = 0, total = 0, n = 0
  const results = a.results || {}
  Object.keys(results).forEach(u => {
    const r = results[u]
    let c = null, t = null
    if (isVideoQuiz) {
      if (r && r.quizTotal != null) { c = Number(r.quizCorrect) || 0; t = Number(r.quizTotal) || 0 }
    } else if (r && r.correct != null && r.total != null) {
      c = Number(r.correct) || 0; t = Number(r.total) || 0   // 无小测视频 / 老记录没有 correct → 跳过
    }
    if (t > 0) { wrong += Math.max(0, t - c); total += t; n++ }
  })
  if (!total) return null
  return { wrong, total, rate: Math.round(wrong / total * 100), n }
}

// v50：错题率单元格配色（错题率越低越好：≤20 绿 / ≤40 黄 / >40 红）
function courseWrongRateCls(rate) {
  return rate <= 20 ? 'good' : rate <= 40 ? 'ok' : 'bad'
}

// v50：错题率汇总文本（Excel 底部汇总行用）：无作答 → '—'；否则 '✗ 27% (8/30)'
function courseWrongRateText(a) {
  const wr = courseTaskWrongRate(a)
  return wr ? `✗ ${wr.rate}% (${wr.wrong}/${wr.total})` : '—'
}

// v51：任务是否有逐题错题率可看（作业/测评带题，或视频配了小测；线下课/纯观看视频不可）
function courseWrongDetailable(a) {
  if (!a || courseIsOffline(a)) return false
  if (a.type === 'video') return Array.isArray(a.quiz) && a.quiz.length > 0
  return Array.isArray(a.questions) && a.questions.length > 0
}

// v51：逐题错题统计。只统计带逐题明细（wq/qn）的记录，且 qn 与任务当前题数一致（作答后改过题的不计）。
// 返回 { qn, n, per: [{ wrong, ans, rate }] } per[i] 对应原题序第 i 题；无任何有效明细 → null
function courseTaskWrongDetail(a) {
  if (!courseWrongDetailable(a)) return null
  const src = a.type === 'video' ? a.quiz : a.questions
  const qn = src.length
  const per = Array.from({ length: qn }, () => ({ wrong: 0, ans: 0 }))
  let n = 0
  const results = a.results || {}
  Object.keys(results).forEach(u => {
    const r = results[u]
    if (!r || !Array.isArray(r.wq) || Number(r.qn) !== qn) return        // 老记录 / 题集已变 → 跳过
    const t = a.type === 'video' ? Number(r.quizTotal) : Number(r.total)
    if (t !== qn) return                                                 // 答题不完整 → 跳过
    const seen = {}
    r.wq.forEach(i => { seen[i] = true })
    for (let i = 0; i < qn; i++) { per[i].ans++; if (seen[i]) per[i].wrong++ }
    n++
  })
  if (!n) return null
  return { qn, n, per: per.map(p => ({ wrong: p.wrong, ans: p.ans, rate: Math.round(p.wrong / Math.max(1, p.ans) * 100) })) }
}

// v51：逐题错题率弹窗（成绩看板汇总格 / 任务行按钮共用入口）
function courseWrongDetailModal(cid, aid) {
  const c = courseFind(cid)
  const a = c ? courseFindAssign(cid, aid) : null
  if (!c || !a) return
  const d = courseTaskWrongDetail(a)
  const foot = `<button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`
  if (!d) {
    courseModalOpen(`${t('courseWrongDetailTitle')}：${escHtml(a.title)}`,
      `<p class="form-hint">${t('courseWrongDetailNone')}</p>`, foot)
    return
  }
  const src = a.type === 'video' ? a.quiz : (a.questions || [])
  const items = src.map((q, i) => {
    const p = d.per[i]
    const icon = q.type === 'multiple' ? '☑️' : (q.type === 'fill' || q.type === 'translate') ? '✍️'
      : q.type === 'listen' ? '🔊' : q.type === 'voicematch' ? '🔤' : q.type === 'judge' ? '⚖️' : '🔘'
    const stem = String(q.question || '').replace(/<[^>]*>/g, '')
    const short = stem.length > 90 ? stem.slice(0, 90) + '…' : stem
    return `<div class="course-wr-item">
      <div class="course-wr-head">
        <span class="course-wr-no">#${i + 1}</span><span class="course-wr-icon">${icon}</span>
        <span class="course-wr-q">${escHtml(short) || '—'}</span>
        <span class="course-wr-rate ${courseWrongRateCls(p.rate)}">${t('courseWrongRateLbl')} ${p.rate}%</span>
      </div>
      <div class="course-wr-meta">${t('courseWrongDetailStat', p.wrong, p.ans)}</div>
    </div>`
  }).join('')
  courseModalOpen(`${t('courseWrongDetailTitle')}：${escHtml(a.title)}`,
    `<div class="course-wr-total">${t('courseWrongDetailHead', d.n)}</div>
     <div class="course-wr-list">${items}</div>
     <p class="form-hint" style="margin-top:8px">${t('courseWrongDetailScope')}</p>`, foot)
}

// 任务类型图标（看板矩阵列头 / 学员卡片共用）
function courseTaskIcon(a) {
  if (!a) return '📝'
  if (a.type === 'offline') return '📅'
  if (a.type === 'video') return '🎬'
  if (a.type === 'exam') return '🧪'
  return '📝'
}

// 线下课行内的「上课时间」文本（日期格式复用截止时间的日期格式化）
function courseOfflineWhen(a) {
  return a && a.date ? courseFmtDate(a.date) : t('courseUnlimited')
}

// 标注人显示名：本地账号表有资料时显示姓名，否则回退用户名（学员端可能无云端账号表）
function courseMarkedByName(u) {
  if (!u) return ''
  try {
    const users = Store.getUsers()
    const hit = (users || []).find(x => x.username === u)
    if (hit && hit.name) return hit.name
  } catch (e) { /* ignore */ }
  return u
}

function courseStartVideo(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const me = courseUser()
  const res = (a.results || {})[me]
  const el = document.getElementById('page-course')
  const videoUrl = a.videoUrl || ''
  if (!videoUrl) { el.innerHTML = `<div class="card" style="text-align:center;padding:40px;color:#6b7280">${t('courseVideoNoUrl')}</div>`; return }
  // 已看完（历史记录 ≥90%）：展示完成态，可回看
  // 若历史完成度过低（如脏数据 3%）：视为未完成，提示重看并自动刷新记录（自愈）
  // v44：已看完但配了小测还没答 → 展示「去答题」入口
  const prevPct = res ? (res.watchedPct != null ? Number(res.watchedPct) : 100) : 0
  const quizPending = !!res && prevPct >= 90 && courseVideoQuizPending(a, res)
  // v53：小测已答但有错题待回顾 → 视频页提供「回顾错题」入口（不直接算完成）
  const reviewPending = !!res && prevPct >= 90 && res.quizTotal != null && courseReviewPending(a, res)
  const done = !!res && prevPct >= 90 && !quizPending && !reviewPending
  const confirmHtml = done
    ? `<p class="course-status done" style="margin-top:16px;font-size:15px">✓ ${t('courseVideoDoneMsg')}</p>
       <button class="btn btn-ghost btn-sm" onclick="courseBackStudent()">${t('courseBackStudent')}</button>`
    : reviewPending
      ? `<div style="margin-top:16px;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
          <p style="font-size:14px;color:#92400e;margin:0 0 10px">🔁 ${t('courseReviewVideoTip', (res.review && res.review.wrongs) ? res.review.wrongs.length : 0)}</p>
          <button class="btn btn-primary btn-sm" onclick="courseReviewStart('${escAttr(cid)}','${escAttr(aid)}')">🔁 ${t('courseReviewBtn')}</button>
        </div>`
    : quizPending
      ? `<div style="margin-top:16px;padding:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
          <p style="font-size:14px;color:#1e40af;margin:0 0 10px">📝 ${t('courseQuizCount', (a.quiz || []).length)} · ${t('courseVideoQuizTip')}</p>
          <button class="btn btn-primary btn-sm" onclick="courseVideoQuizStart('${escAttr(cid)}','${escAttr(aid)}','${escAttr(me)}')">${t('courseVideoQuizBtn')}</button>
        </div>`
      : (res ? `<p class="form-hint" style="color:#b45309;margin-bottom:8px">${t('courseVideoRecheckTip')}</p>` : '')
        + `<div id="courseVideoConfirmArea"></div>`
  el.innerHTML = `
    <div class="course-back"><a onclick="courseBackStudent()">← ${t('courseBackStudent')}</a></div>
    <h2 style="margin-bottom:4px">🎬 ${escHtml(a.title)}</h2>
    ${a.desc ? `<p style="color:#6b7280;margin-bottom:16px">${escHtml(a.desc)}</p>` : '<div style="height:12px"></div>'}
    <div class="card">
      <video id="courseVideoEl" controls preload="metadata" playsinline
        webkit-playsinline x5-playsinline x5-video-player-type="h5"
        style="width:100%;max-height:70vh;background:#000;border-radius:8px"
        src="${escAttr(videoUrl)}"></video>
      <div id="courseVideoProgress" style="margin-top:12px;font-size:13px;color:#6b7280">${t('courseVideoStartTip')}</div>
      ${confirmHtml}
    </div>`
  if (done) return
  const v = document.getElementById('courseVideoEl')
  const prog = document.getElementById('courseVideoProgress')
  courseVideoSnap = null   // 新一轮观看会话：重置确认快照
  const THRESHOLD = 0.90   // 播放到 90% 视为看完
  // ---- 跨域兜底：读不到视频总时长时，改用累计观看秒数判定 ----
  // COS 等存储未配 CORS 时 video.duration 可能是 NaN/Infinity，
  // 此时无法算百分比，退化为「累计播放 N 秒」判定。
  const FALLBACK_SEC = 180   // 兜底：累计播放满 3 分钟即视为看完（管理员可配 a.fallbackSec 覆盖）
  let fallback = Number(a.fallbackSec) || FALLBACK_SEC
  // 高位水线：进度只增不减，防止播放时间抖动 / 进度条拖动造成百分比回退、卡在低值不刷新
  let maxT = 0        // 本次观看到达的最大秒数（仅用于断点续看定位）
  let effSec = 0, lastT = null   // v46：有效观看秒（浮点累计，真实播放每跳直接累加，不丢亚秒）
  let ended = false
  let knownDur = 0
  let intervalId = null
  let fsFrom = null   // 全屏/系统播放器接管起点（接管期间页面收不到 timeupdate，退出时回填）
  const MAX_JUMP_SEC = 3   // 单次采样允许的最大「正常播放」间隔（秒）。>3s = 拖动跳段/断档恢复，不计
  const readDur = () => {
    const d = v.duration
    const ok = typeof d === 'number' && isFinite(d) && d > 0
    if (ok) knownDur = d
    return ok ? d : 0
  }
  const updateProg = () => {
    if (!v) return
    // 页面已被重渲染（视频元素被移除）→ 停止兜底定时器，避免悬空刷新
    if (document.getElementById('courseVideoEl') !== v) { if (intervalId) { clearInterval(intervalId); intervalId = null } return }
    const nowT = v.currentTime || 0
    // v46：有效观看累计不再依赖 paused / seeking 标志 —— 部分安卓/内嵌浏览器这两个标志在播放中
    // 异常（卡 true），旧判定（!paused && !seeking）会让整段真实播放一秒钟都不累计 → 进度恒 0%。
    // 改「时间前进即视为播放」：暂停/缓冲时 currentTime 不动 → 自动不计；
    // seek 回退（nowT<lastT）→ 不计；单次前进 >3s（拖动快进 / 全屏断档恢复）→ 视为跳段不计，
    // 防快进语义（跳过片段需补看）保持不变。
    // 兼容任意采样频率：timeupdate(≈4Hz) / 1s 兜底定时器 / 节流后的 >1s 采样，按真实经过秒累计，不再丢秒。
    if (lastT !== null && nowT > lastT && (nowT - lastT) <= MAX_JUMP_SEC) {
      effSec += (nowT - lastT)
    }
    lastT = nowT
    if (nowT > maxT) maxT = nowT
    try { localStorage.setItem('eq_course_video_pos_' + aid, String(maxT)) } catch (e) {}
    const dur = readDur()
    if (ended) {   // 可信的自然播完：按 100% 显示并开放确认
      prog.textContent = t('courseVideoProgressMsg', 100)
      showVideoConfirm(100, true)
      return
    }
    if (dur > 0) {
      const pct = coursePctBySec(effSec, dur)   // 有效观看秒占比（浮点累计，细采样也不丢）
      prog.textContent = t('courseVideoProgressMsg', pct)
      if (pct >= THRESHOLD * 100) showVideoConfirm(pct, false)
    } else {
      // 读不到时长（跨域元数据受限）：显示累计秒数（拖动跳段不计）。
      // 接近当前位置（已覆盖该位置 85% 的观看量）即可确认 —— 诚实看到结尾无需等满 180s 兜底线；
      // 拖动到结尾只累计了少量秒数 → 不放行，需拖回补看
      prog.textContent = t('courseVideoAccMsg', Math.round(effSec), fallback)
      const posGoal = nowT >= 5 ? Math.max(8, Math.ceil(nowT * 0.85)) : fallback
      if (effSec >= Math.min(posGoal, fallback)) showVideoConfirm(0, false)
    }
  }
  // 断点续看：等元数据就绪后再定位（过早设置 currentTime 在部分移动端浏览器会被忽略）
  const tryResume = () => {
    if (!v) return
    let lp = 0
    try { lp = Number(localStorage.getItem('eq_course_video_pos_' + aid) || 0) } catch (e) {}
    if (!(lp > 5)) return
    const dur = readDur()
    if (dur > 0 && lp >= dur - 5) return
    try { v.currentTime = lp } catch (e) { /* 忽略：元数据未就绪时设置会被浏览器丢弃 */ }
  }
  let confirmShown = false
  const showVideoConfirm = (pct, isEnded) => {
    if (confirmShown) {
      // 已定格过快照（如 90% 时出过确认按钮），随后自然播完（ended）→ 把快照升级为
      // 「自然播完 100%」，避免提交时把看完的视频记成 90%；界面按钮无需重复渲染
      if (isEnded && courseVideoSnap && courseVideoSnap.watchedPct < 100) {
        courseVideoSnap.ended = true
        courseVideoSnap.watchedPct = 100
        if (knownDur > 0) courseVideoSnap.watchedSec = Math.round(knownDur)
      }
      return
    }
    confirmShown = true
    // 快照本次结果（有效观看秒/时长/是否播完），提交时统一换算，避免元素被重绘后取到错误的时长
    const snapSec = knownDur > 0 ? Math.min(effSec, knownDur) : effSec   // 有效观看秒：不含拖动跳过的片段
    courseVideoSnap = { cid, aid, username: me, ended: !!isEnded, watchedPct: Math.min(100, Math.round(pct)), watchedSec: Math.round(snapSec), duration: knownDur || 0 }
    const area = document.getElementById('courseVideoConfirmArea')
    if (!area) return
    area.innerHTML = `
      <div style="margin-top:16px;padding:14px;background:var(--color-background-info,#ecfdf5);border:1px solid #a7f3d0;border-radius:8px">
        <p style="font-size:14px;color:#065f46;margin:0 0 10px">${t('courseVideoCanConfirm')}</p>
        <button class="btn btn-primary btn-sm" onclick="courseVideoShowRating('${escAttr(cid)}','${escAttr(aid)}','${escAttr(me)}')">${t('courseVideoConfirmBtn')}</button>
      </div>`
  }
  // 退出全屏 / 系统播放器接管：把接管期间的前进播放量回填为有效观看。
  // 全屏播放器（iOS Safari / 安卓 x5 / ExoPlayer）接管期间页面收不到 timeupdate，
  // 不做处理则诚实看完也因零累计永远卡 0%。进入全屏记起点、退出补差量（信任观看；
  // 全屏内无法逐秒监测属平台固有限制，内联播放的防快进语义不受影响）。
  const fsExit = () => {
    const nowT = v.currentTime || 0
    if (fsFrom != null && nowT > fsFrom + 5) effSec += (nowT - fsFrom)
    fsFrom = null
    updateProg()
  }
  // timeupdate 之外再补 play / durationchange / 1s 兜底定时器：
  // 即使浏览器节流 timeupdate 或进度事件偶发丢失，百分比也会持续刷新、不会卡住
  v.addEventListener('loadedmetadata', () => { readDur(); tryResume(); updateProg() })
  v.addEventListener('durationchange', () => { readDur(); tryResume(); updateProg() })
  v.addEventListener('timeupdate', updateProg)
  v.addEventListener('play', updateProg)
  v.addEventListener('ended', () => {
    // v39 防快进：拖到结尾也会触发 ended，但只有真实观看达标才算「自然播完」记 100%；
    // 否则视为快进，不开放确认，学员需拖回未看片段继续观看
    // v46：用有效观看秒占比判定（浮点累计，细采样不丢秒）；传自然播完位置 endPos
    // 供无时长视频在诚实看到结尾时解锁（部分播放器 ended 后 currentTime 归零，用 maxT 兜底）
    const endPos = (v.currentTime && v.currentTime > 1) ? v.currentTime : maxT
    ended = courseEndedTrustedBySec(effSec, readDur(), fallback, endPos)
    if (ended) { try { localStorage.removeItem('eq_course_video_pos_' + aid) } catch (e) {} }
    updateProg()
  })
  try { v.addEventListener('webkitbeginfullscreen', () => { fsFrom = (v.currentTime || 0) }) } catch (e) {}
  try { v.addEventListener('webkitendfullscreen', fsExit) } catch (e) {}
  try {
    document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) { fsFrom = (v.currentTime || 0) } else fsExit() })
  } catch (e) {}
  try {
    document.addEventListener('webkitfullscreenchange', () => { if (document.webkitFullscreenElement) { fsFrom = (v.currentTime || 0) } else fsExit() })
  } catch (e) {}
  try { v.addEventListener('x5videoenterfullscreen', () => { fsFrom = (v.currentTime || 0) }) } catch (e) {}
  try { v.addEventListener('x5videoexitfullscreen', fsExit) } catch (e) {}
  intervalId = setInterval(updateProg, 1000)
  setTimeout(tryResume, 800)   // 兼容：部分移动端 loadedmetadata 事件滞后
}

// 学员点「确认看完」→ 弹出难度打分（1-5），选完才正式提交完成
function courseVideoShowRating(cid, aid, username) {
  const area = document.getElementById('courseVideoConfirmArea')
  if (!area) return
  const stars = [1,2,3,4,5].map(n =>
    `<button class="course-rate-btn" data-rate="${n}" onclick="courseVideoSelectRate(this,${n})" style="font-size:26px;background:none;border:none;cursor:pointer;color:#d1d5db;padding:0 4px">★</button>`).join('')
  area.innerHTML = `
    <div style="margin-top:16px;padding:16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
      <p style="font-size:14px;color:#78350f;margin:0 0 4px;font-weight:600">${t('courseVideoRateTitle')}</p>
      <p style="font-size:12px;color:#a16207;margin:0 0 8px">${t('courseVideoRateHint')}</p>
      <div style="display:flex;gap:2px;margin-bottom:12px" id="courseRateStars">${stars}</div>
      <p style="font-size:13px;color:#92400e;margin:0 0 10px" id="courseRateHint">${t('courseVideoRateHint')}</p>
      <button class="btn btn-primary btn-sm" id="courseRateSubmit" disabled onclick="courseVideoSubmitRating('${escAttr(cid)}','${escAttr(aid)}','${escAttr(username)}')">${t('courseVideoSubmitBtn')}</button>
      <button class="btn btn-ghost btn-sm" onclick="courseVideoCancelRating('${escAttr(cid)}','${escAttr(aid)}','${escAttr(username)}')">${t('cancelBtn')}</button>
    </div>`
}
// 选星：高亮已选星，激活提交按钮
function courseVideoSelectRate(el, n) {
  const area = document.getElementById('courseVideoConfirmArea')
  if (!area) return
  area.dataset.rate = n
  area.querySelectorAll('.course-rate-btn').forEach((b, i) => {
    const num = Number(b.dataset.rate)
    b.style.color = num <= n ? '#f59e0b' : '#d1d5db'
    b.style.textShadow = num <= n ? '0 1px 3px rgba(245,158,11,.4)' : 'none'
  })
  const submit = document.getElementById('courseRateSubmit')
  if (submit) submit.disabled = false
  const hint = document.getElementById('courseRateHint')
  if (hint) hint.textContent = t('courseVideoRateSelected', n)
}
// 取消打分：回到确认按钮（可重新打分）
function courseVideoCancelRating(cid, aid, username) {
  const area = document.getElementById('courseVideoConfirmArea')
  if (!area) return
  area.innerHTML = `
    <div style="margin-top:16px;padding:14px;background:var(--color-background-info,#ecfdf5);border:1px solid #a7f3d0;border-radius:8px">
      <p style="font-size:14px;color:#065f46;margin:0 0 10px">${t('courseVideoCanConfirm')}</p>
      <button class="btn btn-primary btn-sm" onclick="courseVideoShowRating('${escAttr(cid)}','${escAttr(aid)}','${escAttr(username)}')">${t('courseVideoConfirmBtn')}</button>
    </div>`
}
// 带难度正式提交
async function courseVideoSubmitRating(cid, aid, username) {
  const area = document.getElementById('courseVideoConfirmArea')
  if (!area || !area.dataset.rate) { alert(t('courseVideoRateRequired')); return }
  const difficulty = Number(area.dataset.rate)
  const v = document.getElementById('courseVideoEl')
  const snap = (courseVideoSnap && courseVideoSnap.aid === aid) ? courseVideoSnap : {}
  const watchedSec = Math.round(Number(snap.watchedSec) || 0) || Math.round((v && v.currentTime) || 0)
  const duration = Number(snap.duration) || ((v && v.duration && isFinite(v.duration)) ? Math.round(v.duration) : 0)
  // 播完（ended）/ 无法读时长 → 记 100%；否则按时长比例计算（防止把完成度记成 3% 等低值）
  const watchedPct = courseVideoFinalPct({ ended: !!snap.ended, watchedSec, duration })
  const now = Date.now()
  let queued = false
  try {
    const r = await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      a.results = a.results || {}
      const prev = a.results[username]
      // 幂等 + 自愈：无记录则写入；新完成度更高（3% 脏数据 → 100%）允许覆盖刷新；否则拒绝
      if (!courseVideoEntryAllowed(prev, watchedPct)) return false
      const entry = { at: now, watched: true, watchedPct, watchedSec, duration, difficulty, attempts: (prev && prev.attempts) ? prev.attempts + 1 : 1 }
      // 逾期提交留标记：截止时间后确认完成的视频作业记录 overdue=true
      if (a.deadline && now > a.deadline) entry.overdue = true
      a.results[username] = entry
    })
    if (r === false) queued = true   // 重试用尽（持续被并发覆盖）
  } catch (e) {
    queued = true   // 网络失败
  }
  if (queued) {
    // v40：云端写入失败 → 完成记录先落本机待补传队列，网络恢复后自动重放上传
    const c = courseFind(cid)
    const a = c ? CourseStore.findAssign(c, aid) : null
    const prev = a && a.results ? a.results[username] : null
    const entry = { at: now, watched: true, watchedPct, watchedSec, duration, difficulty, attempts: (prev && prev.attempts) ? prev.attempts + 1 : 1 }
    if (a && a.deadline && now > a.deadline) entry.overdue = true
    CourseStore.enqueuePending({ atype: 'video', cid, aid, u: username, entry })
  }
  // v44：配了课后小测 → 记录观看快照，直接进入答题（不再弹完成提示）
  const cA = courseFindAssign(cid, aid)
  if (cA && Array.isArray(cA.quiz) && cA.quiz.length) {
    courseVideoQuizSnap = { cid, aid, username, watchedPct, watchedSec, duration, difficulty }
    courseVideoQuizStart(cid, aid, username)
    return
  }
  alert(queued ? t('courseSaveQueuedAlert') : t('courseVideoDoneAlert'))
  // 记录线上学员活动（用于看板/时长统计）
  if (typeof CloudSync !== 'undefined' && CloudSync.enqueue) {
    CloudSync.enqueue({ u: username, n: username, ty: 'video', d: { watched: true, watchedSec, watchedPct, difficulty } })
  }
  courseState.doc = await CourseStore.getDoc()
  renderCourseStudent()
}

// ================================================================
// v44 视频课后小测：读音题（listen，自动朗读题干英文）+ 选择题（single），最多 10 题
// 数据模型：assignment.quiz = [{ type:'single'|'listen', question, options, answer:[idx], explanation }]
//           results[u] 增补 quizCorrect / quizTotal / quizScore / quizAt 字段
// ================================================================
let courseVideoQuizSnap = null   // 进入小测时的观看快照（courseVideoSubmitRating 写入 / 从已有记录构造）

// 开启答题会话：优先用刚看完的快照；从「去答题」进入时回退已有观看记录
function courseVideoQuizStart(cid, aid, username) {
  const a = courseFindAssign(cid, aid)
  if (!a || a.type !== 'video' || !a.quiz || !a.quiz.length) return
  if (!courseVideoQuizSnap || courseVideoQuizSnap.aid !== aid || courseVideoQuizSnap.username !== username) {
    const res = (a.results || {})[username] || {}
    courseVideoQuizSnap = { cid, aid, username, watchedPct: res.watchedPct != null ? Number(res.watchedPct) : 100, watchedSec: res.watchedSec || 0, duration: res.duration || 0, difficulty: res.difficulty || 0 }
  }
  // v51：同样给 quiz 题标 _oi（a.quiz 内原下标），错题明细按原题序记录
  const questions = a.quiz.map((q, i) => ({ ...q, _oi: i }))
    .sort(() => Math.random() - 0.5)
    .map(q => { const s = shuffleOptions(q); return { ...s, _cat: 1, _oi: q._oi } })
  courseQuiz = {
    phase: 'quiz', cid, aid, type: 'videoquiz', title: a.title,
    questions, index: 0, answers: [], submitted: false, correct: 0,
    startAt: Date.now(), endAt: null, passScore: 60
  }
  courseRenderTake()
}

// 构建小测成绩条目（在线提交与离线待补传共用）：保留已有观看字段，叠加测验字段
function courseVideoQuizBuildEntry(a, prev, snap, correct, total, now, wrong) {
  const entry = Object.assign({}, prev || {}, {
    at: now, watched: true,
    watchedPct: prev && prev.watchedPct != null ? Number(prev.watchedPct) : (snap && snap.watchedPct != null ? Number(snap.watchedPct) : 100),
    watchedSec: Math.max(Number(prev && prev.watchedSec) || 0, Number(snap && snap.watchedSec) || 0),
    duration: Number(prev && prev.duration) || Number(snap && snap.duration) || 0,
    difficulty: (prev && prev.difficulty) || (snap && snap.difficulty) || 0,
    attempts: ((prev && prev.attempts) || 0) + 1,
    quizCorrect: correct, quizTotal: total,
    quizScore: Math.round(correct / Math.max(1, total) * 100),
    quizAt: now
  })
  // v51：逐题错题明细（wq 原题序错题下标 + qn）；生成失败 → 去掉 prev 旧明细防错位
  if (wrong && wrong.qn) { entry.wq = wrong.wq; entry.qn = wrong.qn } else { delete entry.wq; delete entry.qn }
  // v53：错题回顾状态（有错 → 待回顾；全对 → 清除）
  if (wrong && wrong.qn) {
    if (Array.isArray(wrong.wq) && wrong.wq.length) {
      const pv = (prev && prev.review) || {}
      entry.review = { at: now, qn: wrong.qn, wrongs: wrong.wq.slice(), rounds: Number(pv.rounds) || 0 }
    } else {
      delete entry.review
    }
  }
  if (a && a.deadline && now > a.deadline) entry.overdue = true
  return entry
}

// 交卷：判分 → 写入云端（观看记录 + 测验成绩合一）→ 结果页
async function courseVideoQuizFinish() {
  const qz = courseQuiz
  if (!qz || qz.phase !== 'quiz' || qz.type !== 'videoquiz') return
  let correct = 0
  qz.questions.forEach((q, i) => { if (courseCheckAnswer(q, qz.answers[i])) correct++ })
  const total = qz.questions.length
  const wrong = courseWrongIdxOf(qz, total)   // v51：逐题错题明细
  qz.pendingWq = wrong && Array.isArray(wrong.wq) ? wrong.wq.slice() : []   // v53：结果页回顾入口
  const snap = (courseVideoQuizSnap && courseVideoQuizSnap.aid === qz.aid) ? courseVideoQuizSnap : {}
  const username = snap.username || courseUser()
  const now = Date.now()
  let queued = false
  let savedEntry = null
  try {
    const r = await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, qz.cid)
      const a = CourseStore.findAssign(c, qz.aid)
      if (!a) return false
      a.results = a.results || {}
      savedEntry = courseVideoQuizBuildEntry(a, a.results[username], snap, correct, total, now, wrong)
      a.results[username] = savedEntry
    })
    if (r === false) queued = true
  } catch (e) {
    queued = true
  }
  if (queued || !savedEntry) {
    // v40 同款兜底：云端写入失败 → 落本机待补传队列（atype videoquiz，恢复后合并重放）
    const c = courseFind(qz.cid)
    const a = c ? CourseStore.findAssign(c, qz.aid) : null
    const prev = a && a.results ? a.results[username] : null
    savedEntry = courseVideoQuizBuildEntry(a, prev, snap, correct, total, now, wrong)
    CourseStore.enqueuePending({ atype: 'videoquiz', cid: qz.cid, aid: qz.aid, u: username, entry: savedEntry })
  }
  // 记录线上学员活动（看板/统计）
  try {
    if (typeof CloudSync !== 'undefined' && CloudSync.enqueue) {
      CloudSync.enqueue({ u: username, n: courseUserName(), ty: 'video', d: { watched: true, watchedSec: savedEntry.watchedSec, watchedPct: savedEntry.watchedPct, difficulty: savedEntry.difficulty, quizScore: savedEntry.quizScore } })
    }
  } catch (e) { /* ignore */ }
  alert(queued ? t('courseSaveQueuedAlert') : t('courseVideoQuizDoneAlert'))
  qz.correct = correct
  qz.resultScore = savedEntry.quizScore
  qz.savedLocal = queued
  qz.phase = 'result'
  courseRenderTakeResult()
}

function courseBackStudent() {
  courseState.view = 'list'
  courseStopTimer()
  renderCoursePage()
}

function courseCheckAnswer(q, ans) {
  if (q.type === 'single' || q.type === 'judge' || q.type === 'pronounce' || q.type === 'listen' || q.type === 'voicematch') return q.answer.includes(ans)
  if (q.type === 'multiple') return Array.isArray(ans) && ans.length === q.answer.length && q.answer.every(i => ans.includes(i))
  if (q.type === 'fill' || q.type === 'translate') return String(ans).trim().toLowerCase() === String(q.options[0]).trim().toLowerCase()
  return false
}

// v51：按原题序生成逐题错题明细。qz.questions 每项带 _oi（原 assignment 下标），answers[i] 为用户所选；
// 未答视为错。返回 { wq: 错题下标数组(升序), qn: 题数 }；任一 _oi 越界（作答期间题目被改动）→ null 放弃明细防错位。
// wq 为 [] 表示全对（同样是有意义的明细，必须保留）
function courseWrongIdxOf(qz, len) {
  const wq = []
  const qs = qz.questions || []
  for (let i = 0; i < qs.length; i++) {
    const oi = qs[i]._oi != null ? qs[i]._oi : i
    if (oi < 0 || oi >= len) return null
    if (!courseCheckAnswer(qs[i], qz.answers[i])) wq.push(oi)
  }
  wq.sort((x, y) => x - y)
  return { wq, qn: len }
}

// ================================================================
// v53 错题回顾直到答对
// 语义：作业/测评/视频课后小测首次作答若有错 → 结果条目写入
//   review = { at, qn, wrongs:[原题序下标], rounds }，courseTaskDone 判未完成；
//   学员进入回顾（每轮只抽仍未答对的题，逐题即时反馈 + 解析），直到某轮全对才完成。
//   成绩与错题率保留首次作答：回顾轮只更新 review 字段，不动 score/correct/wq/qn。
//   中途退出 = 待回顾（卡片黄标 + 线性进度未完成，可随时回来继续）。
// ================================================================
// 从任务卡片/视频页进入回顾（读云端已存 review 状态重建会话）
function courseReviewStart(cid, aid) {
  const c = courseFind(cid)
  const a = c ? courseFindAssign(cid, aid) : null
  if (!c || !a) return
  const me = courseUser()
  const res = (a.results || {})[me]
  if (!courseReviewPending(a, res)) return
  const src = a.type === 'video' ? (a.quiz || []) : (a.questions || [])
  const pool = src.map((q, i) => ({ ...q, _oi: i }))
  courseQuiz = {
    phase: 'quiz', reviewing: true, reviewOf: a.type, cid, aid,
    type: a.type === 'video' ? 'videoquiz' : a.type,
    title: a.title, pool, wrongs: (res.review.wrongs || []).slice(),
    reviewQn: src.length,
    questions: [], index: 0, answers: [], submitted: false, correct: 0,
    startAt: Date.now(), endAt: null, passScore: a.passScore || 60,
  }
  courseReviewRoundBegin()
}

// 首次交卷结果页「立即回顾」：直接基于本次会话题目进入回顾（云端暂不可写也立即可用）
function courseReviewFromResult() {
  const qz = courseQuiz
  if (!qz || qz.phase !== 'result' || qz.reviewing) return
  const wrongs = Array.isArray(qz.pendingWq) ? qz.pendingWq : []
  if (!wrongs.length) return
  qz.reviewing = true
  qz.pool = (qz.pool || qz.questions || []).map(q => ({ ...q }))
  qz.wrongs = wrongs
  qz.reviewQn = qz.reviewQn || (qz.questions || []).length
  courseReviewRoundBegin()
}

// 开始 / 继续一轮回顾：只抽 wrongs（仍未答对）的题，保持 _oi，逐题即时反馈
function courseReviewRoundBegin() {
  const qz = courseQuiz
  if (!qz || !qz.reviewing) return
  const pool = qz.pool || []
  const wrongs = Array.isArray(qz.wrongs) ? qz.wrongs : []
  if (!wrongs.length) { qz.phase = 'result'; courseRenderReviewRoundResult(); return }
  const set = {}
  wrongs.forEach(oi => { set[oi] = true })
  let qs = pool.filter(q => set[q._oi])
  qs = qs.sort(() => Math.random() - 0.5).map(q => ({ ...shuffleOptions(q), _oi: q._oi }))
  if (!qs.length) { qz.phase = 'result'; courseRenderReviewRoundResult(); return }
  Object.assign(qz, { phase: 'quiz', questions: qs, index: 0, answers: [], submitted: false, correct: 0, startAt: Date.now(), endAt: null })
  courseRenderTake()
}

// 一轮回顾答完（最后一题反馈页点「提交本轮回顾」）→ 判定剩余错题 → 云端更新 review 状态
async function courseReviewRoundFinish() {
  const qz = courseQuiz
  if (!qz || qz.phase !== 'quiz' || !qz.reviewing) return
  const still = []
  let correct = 0
  ;(qz.questions || []).forEach((q, i) => {
    if (courseCheckAnswer(q, qz.answers[i])) correct++
    else if (q._oi != null) still.push(q._oi)
  })
  still.sort((x, y) => x - y)
  const username = courseUser()
  const now = Date.now()
  const totalSrc = qz.reviewQn || (qz.pool || []).length
  let queued = false
  try {
    const r = await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, qz.cid)
      const a = c ? CourseStore.findAssign(c, qz.aid) : null
      if (!a) return false
      a.results = a.results || {}
      const prev = a.results[username]
      if (!prev) { queued = true; return false }   // 首次成绩仍未入库（离线）→ 走待补传队列保持先后顺序
      const pv = prev.review || {}
      prev.review = { at: now, qn: totalSrc, wrongs: still, rounds: (Number(pv.rounds) || 0) + 1 }
    })
    if (r === false && !queued) queued = true
  } catch (e) {
    queued = true
  }
  if (queued) {
    // v40 同款兜底：云端写失败 → review 状态入待补传队列（atype 'review'，恢复后按 at 合并）
    let prevRev = null
    const c = courseFind(qz.cid)
    const a = c ? CourseStore.findAssign(c, qz.aid) : null
    const prev = a && a.results ? a.results[username] : null
    if (prev && prev.review) prevRev = prev.review
    CourseStore.enqueuePending({
      atype: 'review', cid: qz.cid, aid: qz.aid, u: username,
      entry: { at: now, review: { at: now, qn: totalSrc, wrongs: still, rounds: (Number(prevRev && prevRev.rounds) || 0) + 1 } },
    })
  }
  qz.wrongs = still
  qz.phase = 'result'
  courseRenderReviewRoundResult()
}

// 回顾轮次结果页：全对 → 任务完成；仍有错 → 唯一操作「继续回顾」（强制循环，无返回列表出口）
function courseRenderReviewRoundResult() {
  const el = document.getElementById('page-course')
  const qz = courseQuiz
  if (!el || !qz) return
  const cleared = !Array.isArray(qz.wrongs) || !qz.wrongs.length
  const c = courseFind(qz.cid)
  const a = c ? courseFindAssign(c, qz.aid) : null
  const me = courseUser()
  const res = a && a.results ? a.results[me] : null
  let grade = null
  if (res) {
    if (res.score != null) grade = res.score
    else if (qz.type === 'videoquiz' && res.quizScore != null) grade = res.quizScore
  }
  const gradeTxt = grade != null ? ` · ${t('courseReviewScoreKept', grade)}` : ''
  el.innerHTML = cleared ? `
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:12px">🎉</div>
      <h2 style="font-size:22px;margin-bottom:8px">${t('courseReviewClearedTitle')}</h2>
      <p style="color:#6b7280;margin-bottom:4px">${t('courseReviewClearedMsg')}${gradeTxt}</p>
      <div style="margin-top:24px">
        <button class="btn btn-primary" onclick="courseQuit()">${t('courseBackList')}</button>
      </div>
    </div>`
    : `
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:12px">🔁</div>
      <h2 style="font-size:22px;margin-bottom:8px">${t('courseReviewAgainTitle', qz.wrongs.length)}</h2>
      <p style="color:#6b7280;margin-bottom:6px">${t('courseReviewAgainMsg')}</p>
      <p class="form-hint" style="color:#b45309">${t('courseReviewMustHint')}</p>
      <div style="margin-top:24px">
        <button class="btn btn-primary" onclick="courseReviewRoundBegin()">🔁 ${t('courseReviewContinue', qz.wrongs.length)}</button>
      </div>
    </div>`
}

function courseRenderTake() {
  const el = document.getElementById('page-course')
  const qz = courseQuiz
  const q = qz.questions[qz.index]
  const ans = qz.answers[qz.index] !== undefined ? qz.answers[qz.index] : (q.type === 'multiple' ? [] : (q.type === 'fill' || q.type === 'translate') ? '' : -1)
  // v53：回顾模式逐题即时反馈（即使源任务是测评，也走作业式逐题流程）
  const isExam = qz.type === 'exam' && !qz.reviewing
  const answered = a => a !== undefined && a !== -1 && !(Array.isArray(a) && !a.length) && !(typeof a === 'string' && !a.trim())
  const showFeedback = !isExam && qz.submitted

  let optionsHtml = ''
  if (q.type === 'voicematch') {
    const dis = (isExam || qz.submitted) ? '' : 'coursePick'
    optionsHtml = vmOptionsHtml(q, ans, showFeedback ? 'review' : 'live', dis)
  } else if (q.type === 'single' || q.type === 'judge' || q.type === 'pronounce' || q.type === 'listen') {
    optionsHtml = q.options.map((opt, i) => {
      let cls = 'option-item'
      if (showFeedback) { if (q.answer.includes(i)) cls += ' correct'; else if (ans === i) cls += ' wrong' }
      else if (ans === i) cls += ' selected'
      const badge = showFeedback && q.answer.includes(i) ? '✓' : LETTERS[i]
      const dis = (isExam || qz.submitted) ? '' : `coursePick(${i})`
      return `<div class="${cls}" ${dis ? `onclick="${dis}"` : ''}>
        <div class="option-badge">${badge}</div><div class="option-text">${opt}</div></div>`
    }).join('')
  } else if (q.type === 'multiple') {
    optionsHtml = q.options.map((opt, i) => {
      let cls = 'option-item'
      const sel = Array.isArray(ans) && ans.includes(i)
      if (showFeedback) { if (q.answer.includes(i)) cls += ' correct'; else if (sel) cls += ' wrong' }
      else if (sel) cls += ' selected'
      const badge = showFeedback && q.answer.includes(i) ? '✓' : LETTERS[i]
      const dis = (isExam || qz.submitted) ? '' : `courseTogglePick(${i})`
      return `<div class="${cls}" ${dis ? `onclick="${dis}"` : ''}>
        <div class="option-badge">${badge}</div><div class="option-text">${opt}</div></div>`
    }).join('')
  } else {
    let cls = 'input-answer'
    if (showFeedback) cls += courseCheckAnswer(q, ans) ? ' correct' : ' wrong'
    optionsHtml = `<input type="text" class="${cls}" placeholder="${t('answerPlaceholder')}" value="${escAttr(ans)}"
      oninput="courseType(this.value)" ${(isExam || qz.submitted) ? 'disabled' : ''} />`
  }

  let feedbackHtml = ''
  if (showFeedback) {
    const ok = courseCheckAnswer(q, ans)
    feedbackHtml = `<div class="feedback ${ok ? 'correct' : 'wrong'}">
      <strong>${ok ? t('correctFeedback') : t('wrongFeedback')}</strong>
      <div class="explanation">${q.explanation || t('noExplanation')}</div></div>`
  }

  const grid = isExam ? `
    <div class="course-exam-grid">
      ${qz.questions.map((_, i) => `<span class="course-grid-cell ${answered(qz.answers[i]) ? 'answered' : ''} ${i === qz.index ? 'current' : ''}" onclick="courseGoto(${i})">${i + 1}</span>`).join('')}
    </div>` : ''

  const timerHtml = qz.endAt ? `<span id="courseTimer" class="course-timer"></span>` : ''

  let footerBtns = ''
  if (isExam) {
    footerBtns = `
      <button class="btn btn-ghost" onclick="courseGoto(${Math.max(0, qz.index - 1)})" ${qz.index === 0 ? 'disabled' : ''}>←</button>
      <button class="btn btn-ghost" onclick="courseGoto(${Math.min(qz.questions.length - 1, qz.index + 1)})" ${qz.index === qz.questions.length - 1 ? 'disabled' : ''}>→</button>
      <button class="btn btn-primary" onclick="courseExamAskSubmit()">${t('courseSubmitExam')}</button>`
  } else if (!qz.submitted) {
    footerBtns = `<button class="btn btn-primary" onclick="courseSubmitAnswer()">${t('courseSubmitAnswer')}</button>`
  } else if (qz.index < qz.questions.length - 1) {
    footerBtns = `<button class="btn btn-primary" onclick="courseNextQ()">${t('courseNextQ')}</button>`
  } else {
    // v53：回顾模式最后一题反馈页 → 提交本轮回顾；其余按原类型走作业/视频小测完成
    const submitFn = qz.reviewing ? 'courseReviewRoundFinish' : (qz.type === 'videoquiz' ? 'courseVideoQuizFinish' : 'courseFinishHomework')
    const submitLbl = qz.reviewing ? t('courseReviewSubmitBtn') : (qz.type === 'videoquiz' ? t('courseVideoSubmitBtn') : t('courseFinishBtn'))
    footerBtns = `<button class="btn btn-success" onclick="${submitFn}()">${submitLbl}</button>`
  }

  el.innerHTML = `
    <div class="card">
      <div class="quiz-topinfo">
        <span class="tag tag-type">${qz.reviewing ? `🔁 ${t('courseReviewTag')}` : (isExam ? t('courseTypeExam') : (qz.type === 'videoquiz' ? `📝 ${t('courseQuizLabel')}` : t('courseTypeHomework')))}</span>
        <span style="font-weight:600">${escHtml(qz.title)}</span>
        ${timerHtml}
        <span class="quiz-progress">${t('courseQOf', qz.index + 1, qz.questions.length)}</span>
      </div>
      ${grid}
      ${quizTitleHtml(q)}
      <div class="options-list">${optionsHtml}</div>
      ${feedbackHtml}
      <div class="quiz-footer">
        <div></div>
        <div>${footerBtns}</div>
      </div>
      ${qz.reviewing ? '' : `<div class="course-quit"><a onclick="courseQuit()">${t('courseQuitLink')}</a></div>`}
    </div>`
  if (!showFeedback) autoplayListen(q)
}

function coursePick(i) { const q = courseQuiz.questions[courseQuiz.index]; courseQuiz.answers[courseQuiz.index] = i; courseRenderTake() }
function courseTogglePick(i) {
  const q = courseQuiz.questions[courseQuiz.index]
  let ans = Array.isArray(courseQuiz.answers[courseQuiz.index]) ? courseQuiz.answers[courseQuiz.index].slice() : []
  ans = ans.includes(i) ? ans.filter(x => x !== i) : [...ans, i]
  courseQuiz.answers[courseQuiz.index] = ans
  courseRenderTake()
}
function courseType(v) { courseQuiz.answers[courseQuiz.index] = v }
function courseGoto(i) { courseQuiz.index = i; if (courseQuiz.type === 'homework') courseQuiz.submitted = false; courseRenderTake() }
function courseSubmitAnswer() {
  const qz = courseQuiz
  const q = qz.questions[qz.index]
  const ans = qz.answers[qz.index]
  const answered = a => a !== undefined && a !== -1 && !(Array.isArray(a) && !a.length) && !(typeof a === 'string' && !a.trim())
  if (!answered(ans)) { alert(t('courseAnswerFirst')); return }
  qz.submitted = true
  if (courseCheckAnswer(q, ans)) qz.correct++
  courseRenderTake()
}
function courseNextQ() { courseQuiz.index++; courseQuiz.submitted = false; courseRenderTake() }

function courseQuit() {
  if (!confirm(t('courseQuitConfirm'))) return
  courseStopTimer()
  if (typeof AntiCheat !== 'undefined') AntiCheat.stop()
  courseQuiz = null
  renderCoursePage()
}

// v59：防作弊切屏超限 → 强制终止本次作答
// 不计成绩、不计作答次数（不写 results/attempts/history/错题明细），已答内容全部作废；
// 学员回到任务列表可重新开始作答，切屏计数重新累计。
function courseForceTerminate() {
  const qz = courseQuiz
  if (!qz || qz.phase !== 'quiz') return
  courseStopTimer()
  if (typeof AntiCheat !== 'undefined') AntiCheat.stop()
  courseQuiz = null
  renderCoursePage()
}

async function courseFinishHomework() {
  const qz = courseQuiz
  if (!qz || qz.phase !== 'quiz') return
  courseStopTimer()
  if (typeof AntiCheat !== 'undefined') AntiCheat.stop()   // v39：作业防作弊结束后关闭监听
  // v53：交卷时记录错题 → 结果页出现「立即回顾错题」入口（强制回顾至全对）
  const wr = courseWrongIdxOf(qz, qz.questions.length)
  qz.pendingWq = wr && Array.isArray(wr.wq) ? wr.wq.slice() : []
  const savedCloud = await courseSaveResult(qz.correct, qz.questions.length, Math.round((Date.now() - qz.startAt) / 1000))
  qz.savedLocal = !savedCloud   // v40：云端写入失败 → 已暂存本机，结果页提示
  qz.phase = 'result'
  qz.resultScore = Math.round(qz.correct / qz.questions.length * 100)
  courseRenderTakeResult()
}

function courseExamAskSubmit() {
  const qz = courseQuiz
  const unanswered = qz.questions.filter((_, i) => {
    const a = qz.answers[i]
    return a === undefined || a === -1 || (Array.isArray(a) && !a.length) || (typeof a === 'string' && !a.trim())
  }).length
  if (unanswered > 0 && !confirm(t('courseUnanswered', unanswered))) return
  if (!confirm(t('courseConfirmSubmitExam'))) return
  courseExamSubmit(false)
}

async function courseExamSubmit(timeout) {
  const qz = courseQuiz
  if (!qz || qz.phase !== 'quiz') return
  courseStopTimer()
  if (typeof AntiCheat !== 'undefined') AntiCheat.stop()
  let correct = 0
  qz.questions.forEach((q, i) => { if (courseCheckAnswer(q, qz.answers[i])) correct++ })
  const total = qz.questions.length
  const usedSec = Math.min(Math.round((Date.now() - qz.startAt) / 1000), (qz.endAt - qz.startAt) / 1000 | 0)
  const wr = courseWrongIdxOf(qz, total)   // v53：交卷记录错题 → 结果页回顾入口
  qz.pendingWq = wr && Array.isArray(wr.wq) ? wr.wq.slice() : []
  const savedCloud = await courseSaveResult(correct, total, Math.round(usedSec))
  qz.savedLocal = !savedCloud   // v40：云端写入失败 → 已暂存本机，结果页提示
  qz.phase = 'result'
  qz.resultScore = Math.round(correct / total * 100)
  qz.usedSec = Math.round(usedSec)
  courseRenderTakeResult()
}

function courseRenderTakeResult() {
  const el = document.getElementById('page-course')
  const qz = courseQuiz
  const score = qz.resultScore
  const passed = score >= qz.passScore
  // v53/v54：交卷有错题 → 强制回顾。结果页唯一操作 = 立即回顾错题，不给「稍后回顾/返回列表」出口；
  // 中途离开只能靠浏览器/关页（回来任务仍为待回顾，courseStart/卡片/视频页入口只会进回顾）。
  const needReview = Array.isArray(qz.pendingWq) && qz.pendingWq.length > 0
  const icon = needReview ? '🔁' : (qz.type === 'exam' ? (passed ? '🎉' : '💪') : (score >= 80 ? '🎉' : '👍'))
  const title = needReview
    ? (qz.type === 'exam' ? t('courseReviewFirstExamTitle') : t('courseReviewFirstTitle'))
    : (qz.type === 'exam' ? t('courseExamDoneTitle') : (qz.type === 'videoquiz' ? t('courseVideoQuizDoneTitle') : t('courseHwDoneTitle')))
  const reviewCta = needReview ? `
      <div style="margin:14px auto 0;max-width:380px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;text-align:left">
        <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#92400e">🔁 ${t('courseReviewNeedHint', qz.pendingWq.length)}</p>
        <p class="form-hint" style="margin:0 0 10px;color:#b45309">${t('courseReviewNeedKeep')}</p>
        <button class="btn btn-primary" style="width:100%" onclick="courseReviewFromResult()">${t('courseReviewStartNow', qz.pendingWq.length)}</button>
      </div>` : ''
  el.innerHTML = `
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:12px">${icon}</div>
      <h2 style="font-size:24px;margin-bottom:8px">${title}</h2>
      <p style="color:#6b7280;margin-bottom:6px">${t('courseCorrectOf', qz.correct, qz.questions.length)}</p>
      <div class="course-score ${qz.type === 'exam' ? (passed ? 'pass' : 'fail') : ''}">
        ${t('courseYourScore')}：${score}${LANG === 'en' ? '' : '分'}
        ${qz.type === 'exam' ? `<span class="course-pass-tag ${passed ? 'ok' : 'no'}">${passed ? t('coursePassed') : t('courseFailed')}</span>` : ''}
      </div>
      ${qz.savedLocal ? `<p style="margin:14px 0 0;font-size:13px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px">⏳ ${t('courseSaveQueuedTip')}</p>` : ''}
      ${reviewCta}
      ${needReview ? '' : `<div style="margin-top:24px"><button class="btn btn-primary" onclick="courseQuit()">${t('courseBackList')}</button></div>`}
    </div>`
}

// ====== v56 历次作答成绩 ======
// 需求：作业可重做多遍，需要能看到学员每一次的真实成绩，而不是只留最高分那次。
// 数据模型：results[u].history = [{ at, score, correct, total, usedSec }, ...] 按作答时间升序（第 1 次在前）。
//   score/correct/total/wq/qn 仍是判定口径（作业=历史最高分那次，含错题回顾语义）；
//   history 只用于展示「每次真实成绩」，两者解耦 —— 重做低分不会改变完成/统计。
// 旧记录（无 history）在下次重做时自动把既有成绩补为第 1 次，避免只显示第 2 次以后。
function courseHistoryOf(prev, rec) {
  let hist
  if (prev && Array.isArray(prev.history)) {
    hist = prev.history.slice()
  } else if (prev && (prev.score != null || prev.at)) {
    // 老记录升级为第 1 次尝试
    hist = [{ at: prev.at || rec.at, score: prev.score != null ? prev.score : rec.score,
      correct: prev.correct != null ? prev.correct : rec.correct,
      total: prev.total != null ? prev.total : rec.total,
      usedSec: Number(prev.usedSec) || 0 }]
  } else {
    hist = []
  }
  hist.push(rec)
  // 防 textdb 1MB 容量膨胀：只保留最近 20 次（score 字段仍独立保留最高分那次）
  if (hist.length > 20) hist = hist.slice(hist.length - 20)
  return hist
}

// 构建成绩条目（在线提交与离线待补传共用同一合并规则）
function courseBuildResultEntry(a, prev, score, correct, total, usedSec, now, wrong) {
  const entry = { at: now, score, correct, total, usedSec, attempts: (prev ? (prev.attempts || 1) : 0) + 1 }
  // v56：先把本次真实成绩记入 history —— 必须在下方「作业保留最高分」覆盖前执行，低分轮同样留存
  entry.history = courseHistoryOf(prev, { at: now, score, correct, total, usedSec })
  // v51：逐题错题明细（wq 原题序错题下标 + qn）
  if (wrong && wrong.qn) { entry.wq = wrong.wq; entry.qn = wrong.qn } else { delete entry.wq; delete entry.qn }
  // 逾期提交留标记：截止时间后提交的作业记录 overdue=true，便于管理员追踪补交
  if (a && a.deadline && now > a.deadline) entry.overdue = true
  // 作业可重做，保留历史最高分；测评只保留首次成绩
  if (a && a.type === 'homework' && prev && (prev.score || 0) > score) {
    entry.score = prev.score; entry.correct = prev.correct; entry.total = prev.total
    // 明细跟随保留的那次作答（prev 无明细 → 本次低分明细一并丢弃）
    if (Array.isArray(prev.wq) && prev.qn) { entry.wq = prev.wq; entry.qn = prev.qn } else { delete entry.wq; delete entry.qn }
    // 保留高分来自截止前的正常提交 → 本次逾期重做不覆盖逾期标记
    if (!prev.overdue) delete entry.overdue
  }
  // v53：错题回顾状态。有错 → 记录本轮错题（强制回顾至全对才算完成）；全对 → 清除待回顾。
  // 只影响「是否完成」，不动成绩/错题率统计字段（score/correct/wq/qn 保持 grade 语义）
  if (wrong && wrong.qn) {
    if (Array.isArray(wrong.wq) && wrong.wq.length) {
      const pv = (prev && prev.review) || {}
      entry.review = { at: now, qn: wrong.qn, wrongs: wrong.wq.slice(), rounds: Number(pv.rounds) || 0 }
    } else {
      delete entry.review
    }
  }
  return entry
}

// v59：线下课作业/测评的每题对错上报 → 数据看板「每题正确率」（perq 事件聚合）
// 题目 id 与派生题库对齐：指纹 type|题干（与 rebuildBankFromCourse 去重键一致）映射题库 id；
// 匹配不到的题（如刚导入还未派生、题干被改过）跳过；未作答的题不计入。
function coursePerQReport(qz) {
  try {
    if (!qz || qz.reviewing || (qz.type !== 'homework' && qz.type !== 'exam')) return
    if (!Array.isArray(qz.questions)) return
    const map = {}
    Store.getQuestions().forEach(q => { map[(q.type || 'single') + '|' + String(q.question || '').trim()] = q.id })
    const me = courseUser()
    qz.questions.forEach((q, i) => {
      const ans = (qz.answers || [])[i]
      if (ans === undefined || ans === -1 || (Array.isArray(ans) && !ans.length) || (typeof ans === 'string' && !String(ans).trim())) return
      const qid = map[(q.type || 'single') + '|' + String(q.question || '').trim()]
      if (qid == null) return
      CloudSync.enqueue({ u: me, n: courseUserName(), ty: 'perq', d: { qid: Number(qid), correct: courseCheckAnswer(q, ans) ? 1 : 0 } })
    })
  } catch (e) { /* 上报失败不影响交卷 */ }
}

// 返回 true=已写入云端；false=云端写入失败（成绩已入本地待补传队列，恢复后自动上传）
async function courseSaveResult(correct, total, usedSec) {
  const me = courseUser()
  const qz = courseQuiz
  const score = Math.round(correct / Math.max(1, total) * 100)
  const now = Date.now()
  const wrong = courseWrongIdxOf(qz, total)   // v51：逐题错题明细
  coursePerQReport(qz)   // v59：每题对错计入数据看板
  let queued = false
  try {
    const r = await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, qz.cid)
      const a = CourseStore.findAssign(c, qz.aid)
      if (!c || !a) return false
      a.results = a.results || {}
      const prev = a.results[me]
      a.results[me] = courseBuildResultEntry(a, prev, score, correct, total, usedSec, now, wrong)
    })
    if (r === false) queued = true   // 重试用尽（持续被并发覆盖）
  } catch (e) {
    queued = true   // 网络失败
  }
  if (queued) {
    // v40：云端写入失败 → 成绩先落本机待补传队列，网络恢复后自动重放上传
    const c = courseFind(qz.cid)
    const a = c ? CourseStore.findAssign(c, qz.aid) : null
    const prev = a && a.results ? a.results[me] : null
    CourseStore.enqueuePending({
      atype: (a && a.type) || qz.type, cid: qz.cid, aid: qz.aid, u: me,
      entry: courseBuildResultEntry(a, prev, score, correct, total, usedSec, now, wrong)
    })
  }
  // 同步计入数据看板：作业→练习事件，测评→考试事件
  try {
    if (qz.type === 'homework') {
      CloudSync.enqueue({ u: me, n: courseUserName(), ty: 'practice', d: { correct, total } })
    } else {
      CloudSync.enqueue({ u: me, n: courseUserName(), ty: 'exam', d: { score, correct, total, passed: score >= (qz.passScore || 60) } })
    }
  } catch (e) { /* ignore */ }
  return !queued
}

// ================================================================
// 管理员端
// ================================================================
function renderCourseAdmin() {
  const el = document.getElementById('page-course')
  const classes = courseState.doc.classes || []
  let totalAssign = 0, totalExam = 0, totalSubmit = 0
  classes.forEach(c => (c.assignments || []).forEach(a => {
    if (a.status === 'draft') return   // 草稿不计入统计
    totalAssign++
    if (a.type === 'exam') totalExam++
    totalSubmit += Object.keys(a.results || {}).length
  }))
  const cards = classes.map(c => {
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')
    const done = assigns.reduce((s, a) => s + Object.keys(a.results || {}).length, 0)
    return `<div class="card course-card">
      <div class="course-card-head">
        <span class="course-class-tag">${escHtml(c.name)}</span>
        <span class="course-status pending">👥 ${(c.members || []).length}${t('courseMembersUnit')}</span>
      </div>
      ${c.note ? `<div class="course-card-desc">${escHtml(c.note)}</div>` : ''}
      <div class="course-card-meta">
        <span>📋 ${assigns.length}${t('courseAssignUnit')}</span>
        <span>✅ ${done}${t('courseSubmitUnit')}</span>
        <span>🕐 ${c.createdAt ? courseFmtDate(c.createdAt) : '—'}</span>
      </div>
      <div class="course-card-actions">
        <button class="btn btn-primary btn-sm" onclick="courseOpenClass('${escAttr(c.id)}')">${t('courseOpenClass')}</button>
        <button class="btn btn-danger btn-sm" onclick="courseDeleteClass('${escAttr(c.id)}','${escAttr(c.name)}')">${t('courseDeleteBtn')}</button>
      </div>
    </div>`
  }).join('')

  el.innerHTML = `
    <div class="dashboard-summary">
      <div class="dash-stat"><div class="dash-val">${classes.length}</div><div class="dash-lbl">${t('courseClassCount')}</div></div>
      <div class="dash-stat"><div class="dash-val">${totalAssign - totalExam}</div><div class="dash-lbl">${t('courseHwCount')}</div></div>
      <div class="dash-stat"><div class="dash-val">${totalExam}</div><div class="dash-lbl">${t('courseExamCount')}</div></div>
      <div class="dash-stat"><div class="dash-val">${totalSubmit}</div><div class="dash-lbl">${t('courseSubmitCount')}</div></div>
    </div>
    <div class="admin-toolbar">
      <span style="font-size:14px;color:#6b7280;flex:1">${t('courseAdminTitle')}</span>
      <button class="btn btn-ghost" onclick="courseToggleAdminView()">👁 ${t('courseSwitchStudentView')}</button>
      <button class="btn btn-ghost" onclick="courseOpenDashboard()">📊 ${t('courseDashboard')}</button>
      <button class="btn btn-primary" onclick="courseCreateClassModal()">${t('courseNewClass')}</button>
    </div>
    ${classes.length ? `<div class="course-list">${cards}</div>` :
      `<div class="card" style="text-align:center;padding:40px;color:#6b7280">${t('courseNoClasses')}</div>`}`
}

// ---------- 创建班级 ----------
function courseCreateClassModal() {
  courseModalOpen(t('courseNewClass'), `
    <div class="form-group"><label>${t('courseClassName')} *</label>
      <input type="text" id="courseClassNameInput" placeholder="${t('courseClassNamePh')}" /></div>
    <div class="form-group"><label>${t('courseClassNote')}</label>
      <input type="text" id="courseClassNoteInput" placeholder="${t('courseClassNotePh')}" /></div>`,
    `<button class="btn btn-primary" onclick="courseCreateClass()">${t('courseCreate')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseCreateClass() {
  const name = document.getElementById('courseClassNameInput').value.trim()
  if (!name) { alert(t('courseErrClassName')); return }
  const note = document.getElementById('courseClassNoteInput').value.trim()
  const id = CourseStore.newId('c')
  try {
    await CourseStore.mutate(doc => {
      doc.classes = doc.classes || []
      if (doc.classes.some(c => c.id === id)) return false   // 幂等：重试不重复
      doc.classes.push({ id, name, note, createdAt: Date.now(), createdBy: courseUser(), members: [], assignments: [] })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  courseState.doc = await CourseStore.getDoc()
  renderCourseAdmin()
}

async function courseDeleteClass(cid, name) {
  if (!confirm(t('courseDeleteClassConfirm', name))) return
  try { await CourseStore.mutate(doc => { doc.classes = doc.classes.filter(c => c.id !== cid) }) }
  catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseState.view = 'list'
  renderCourseAdmin()
}

// ---------- 班级详情 ----------
function courseOpenClass(cid) {
  courseState.view = 'class'
  courseState.classId = cid
  courseRenderClass()
}

async function courseRenderClass() {
  const el = document.getElementById('page-course')
  let c = courseFind(courseState.classId)
  if (!c || CourseStore.status !== 'online') {
    try { courseState.doc = await CourseStore.getDoc() } catch (e) {}
    c = courseFind(courseState.classId)
  }
  if (!c) { courseState.view = 'list'; return renderCourseAdmin() }

  const infoMap = await courseUserInfoMap()
  const memberChips = (c.members || []).map(u => {
    const info = infoMap[u] || {}
    const label = info.name ? escHtml(info.name) : escHtml(u)
    const dept = info.dept ? ` <span style="color:#6b7280;font-size:11px">${escHtml(info.dept)}</span>` : ''
    return `<span class="course-chip" title="${escAttr(u)}">${label}${dept} <a onclick="courseRemoveMember(${escAttr(JSON.stringify(courseState.classId))},${escAttr(JSON.stringify(u))})" title="${t('courseRemoveMember')}">✕</a></span>`
  }).join('')

  const assignTotal = (c.assignments || []).length
  const assignRows = (c.assignments || []).map((a, idx) => {
    if (a.type === 'offline') return courseOfflineAdminRow(c, a, idx, assignTotal)
    const members = c.members || []
    const isDraft = a.status === 'draft'
    const isVideo = a.type === 'video'
    const done = Object.keys(a.results || {}).filter(u => members.includes(u)).length
    const scores = Object.values(a.results || {}).map(r => r.score || 0)
    const avg = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0
    const draftTag = isDraft ? `<span class="course-draft-tag">⏳ ${t('courseDraftTag')}</span> ` : ''
    return `<tr${isDraft ? ' class="row-draft"' : ''}>
      <td class="course-sort-cell">${courseSortBtns(c.id, a.id, idx, assignTotal)}</td>
      <td>${draftTag}${escHtml(a.title)}</td>
      <td>${isVideo ? t('courseTypeVideo') : (a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework'))}</td>
      <td style="text-align:center">${isVideo ? ((a.quiz && a.quiz.length) ? a.quiz.length : '—') : (a.questions || []).length}</td>
      <td style="font-size:12px">${isDraft
        ? `<span style="color:#92400E">${t('courseDraftNotSent')}</span>`
        : (a.deadline ? courseFmtDate(a.deadline) : t('courseUnlimited'))}</td>
      <td style="text-align:center">${isDraft ? '—' : done + '/' + members.length}</td>
      <td style="text-align:center">${isDraft || isVideo ? '—' : (scores.length ? avg + (LANG === 'en' ? '' : '分') : '—')}</td>
      <td>
        <div class="admin-actions">
          ${isDraft
            ? `<button class="btn btn-primary btn-sm" onclick="courseSendAssign('${escAttr(c.id)}','${escAttr(a.id)}')">📨 ${t('courseSendBtn')}</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="courseAssignDetail('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseDetailBtn')}</button>`}
          ${isVideo
            ? `<button class="btn btn-ghost btn-sm" onclick="courseEditVideoUrlModal('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseEditVideoUrl')}</button>
               <button class="btn btn-ghost btn-sm" onclick="courseEditQuizModal('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseEditQuizBtn')}</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="courseEditAssignModal('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseEditBtn')}</button>`}
          ${courseWrongDetailable(a)
            ? `<button class="btn btn-ghost btn-sm" title="${escAttr(t('courseWrongDetailTitle'))}" onclick="courseWrongDetailModal('${escAttr(c.id)}','${escAttr(a.id)}')">📊 ${t('courseWrongRateBtn')}</button>`
            : ''}
          <button class="btn btn-ghost btn-sm" title="${escAttr(t('courseCopyTitle'))}" onclick="courseCopyAssignModal('${escAttr(c.id)}','${escAttr(a.id)}')">📋 ${t('courseCopyBtn')}</button>
          <button class="btn btn-danger btn-sm" onclick="courseDeleteAssign('${escAttr(c.id)}','${escAttr(a.id)}','${escAttr(a.title)}')">${t('courseDeleteBtn')}</button>
        </div>
      </td>
    </tr>`
  }).join('')

  el.innerHTML = `
    <div class="course-back"><a onclick="courseBackAdmin()">← ${t('courseBackAdmin')}</a></div>
    <h2 style="margin-bottom:4px">🎓 ${escHtml(c.name)}</h2>
    ${c.note ? `<p style="color:#6b7280;margin-bottom:16px">${escHtml(c.note)}</p>` : '<div style="height:12px"></div>'}

    <div class="card">
      <h3 style="margin-bottom:10px">${t('courseMembers')}（${(c.members || []).length}）</h3>
      <div class="course-chips">${memberChips || `<span style="color:#9ca3af">${t('courseNoMembers')}</span>`}</div>
      <div class="course-member-add">
        <input type="text" id="courseMemberInput" placeholder="${t('courseMemberPh')}"
          onkeydown="if(event.key==='Enter')courseAddMember('${escAttr(c.id)}')" />
        <button class="btn btn-primary btn-sm" onclick="courseAddMember('${escAttr(c.id)}')">${t('courseAdd')}</button>
        <button class="btn btn-ghost btn-sm" onclick="courseLoadCloudUsers('${escAttr(c.id)}')">${t('courseLoadCloudUsers')}</button>
      </div>
      <div id="courseCloudUsers"></div>
    </div>

    <div class="admin-toolbar" style="margin-top:20px">
      <span style="font-size:14px;color:#6b7280;flex:1">${t('courseAssignments')}</span>
      <button class="btn btn-ghost" onclick="courseCreateOfflineModal('${escAttr(c.id)}')">📅 ${t('courseNewOffline')}</button>
      <button class="btn btn-primary" onclick="courseCreateAssignModal('${escAttr(c.id)}')">${t('courseNewAssign')}</button>
    </div>
    ${assignRows ? `<div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead><tr>
          <th style="width:76px" title="${escAttr(t('courseOrderHint'))}">↕</th>
          <th>${t('courseThTitle')}</th><th>${t('courseThType')}</th><th>${t('courseThCount')}</th>
          <th>${t('courseThDeadline')}</th><th>${t('courseThProgress')}</th><th>${t('courseThAvg')}</th>
          <th>${t('courseThAction')}</th>
        </tr></thead>
        <tbody>${assignRows}</tbody>
      </table></div>` :
      `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">${t('courseNoAssign')}</div>`}
    <p class="form-hint" style="margin-top:8px">↕ ${t('courseOrderHint')}</p>
    <p class="form-hint" style="margin-top:12px">${t('courseAdminHint')}</p>`
}

// ================================================================
// 任务排序：调整「作业 / 测评 / 视频 / 线下课」在班级内的先后顺序
// 学员端「我的学习进度」按 assignments 数组顺序渲染，交换数组即全局生效
// ================================================================
// 行内排序按钮（↕）：首行禁用 ↑、末行禁用 ↓，草稿行同样可排
function courseSortBtns(cid, aid, idx, total) {
  const up = idx > 0
    ? `<button class="btn btn-ghost btn-sm course-sort-btn" title="${escAttr(t('courseMoveUp'))}" onclick="courseMoveAssign('${escAttr(cid)}','${escAttr(aid)}',-1)">↑</button>`
    : `<button class="btn btn-ghost btn-sm course-sort-btn" disabled title="${escAttr(t('courseMoveUp'))}">↑</button>`
  const dn = idx < total - 1
    ? `<button class="btn btn-ghost btn-sm course-sort-btn" title="${escAttr(t('courseMoveDown'))}" onclick="courseMoveAssign('${escAttr(cid)}','${escAttr(aid)}',1)">↓</button>`
    : `<button class="btn btn-ghost btn-sm course-sort-btn" disabled title="${escAttr(t('courseMoveDown'))}">↓</button>`
  return `<div class="course-sort-btns">${up}${dn}</div>`
}

// 上移 / 下移一位（dir=-1 上移，+1 下移）；首尾边界处不动（mutate 返回 false）
async function courseMoveAssign(cid, aid, dir) {
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c || !Array.isArray(c.assignments)) return false
      const i = c.assignments.findIndex(a => a.id === aid)
      const j = i + (dir < 0 ? -1 : 1)
      if (i < 0 || j < 0 || j >= c.assignments.length) return false
      const tmp = c.assignments[i]
      c.assignments[i] = c.assignments[j]
      c.assignments[j] = tmp
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  return courseRenderClass()
}

// ================================================================
// 线下课（type:'offline'）管理端：新增 / 编辑 / 一键全员完成 / 成员标注
// ================================================================
// 班级作业表里的线下课行
function courseOfflineAdminRow(c, a, idx, total) {
  const members = c.members || []
  const isHeld = !!a.held
  const done = members.filter(u => courseTaskDone(a, (a.results || {})[u])).length
  const absent = Array.isArray(a.absent) ? a.absent.filter(u => members.indexOf(u) >= 0) : []
  const mainBtn = isHeld
    ? `<button class="btn btn-ghost btn-sm" onclick="courseUnheldAll('${escAttr(c.id)}','${escAttr(a.id)}')">↩️ ${t('courseOfflineUndo')}</button>`
    : `<button class="btn btn-primary btn-sm" onclick="courseHeldModal('${escAttr(c.id)}','${escAttr(a.id)}')">✅ ${t('courseOfflineHeldAll')}</button>`
  const heldTag = isHeld
    ? (absent.length
      ? `<span class="course-status done">✅ ${t('courseOfflineHeld')}</span><span class="course-off-absent">🚫 ${t('courseOfflineAbsentTag', absent.length)}</span>`
      : `<span class="course-status done">✅ ${t('courseOfflineHeldTag')}</span>`)
    : ''
  return `<tr>
    <td class="course-sort-cell">${courseSortBtns(c.id, a.id, idx, total)}</td>
    <td>📅 ${escHtml(a.title)}</td>
    <td>${t('courseTypeOffline')}</td>
    <td style="text-align:center">—</td>
    <td style="font-size:12px">${courseOfflineWhen(a)}</td>
    <td style="text-align:center">${done}/${members.length}</td>
    <td style="text-align:center">—</td>
    <td>
      <div class="admin-actions" style="flex-wrap:wrap">
        ${mainBtn}
        ${heldTag}
        <button class="btn btn-ghost btn-sm" onclick="courseOfflineMembers('${escAttr(c.id)}','${escAttr(a.id)}')">👥 ${t('courseOfflineMembersBtn')}</button>
        <button class="btn btn-ghost btn-sm" onclick="courseEditOfflineModal('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseEditBtn')}</button>
        <button class="btn btn-danger btn-sm" onclick="courseDeleteAssign('${escAttr(c.id)}','${escAttr(a.id)}','${escAttr(a.title)}')">${t('courseDeleteBtn')}</button>
      </div>
    </td>
  </tr>`
}

// 主题下拉切换（co=新建 ce=编辑）：选择「自定义」时显示自定义输入框
function courseOfflineTopicToggle(prefix) {
  prefix = prefix || 'co'
  const sel = document.getElementById(prefix + 'Topic')
  const g = document.getElementById(prefix + 'TopicCustomGroup')
  if (!sel || !g) return
  g.style.display = sel.value === '__custom' ? '' : 'none'
}

// 读取主题下拉的选中结果：返回 { name, topicId, custom }；无效则提示并返回 null
function courseOfflineReadTopic(prefix) {
  prefix = prefix || 'co'
  const sel = document.getElementById(prefix + 'Topic')
  if (!sel) return null
  const v = sel.value
  if (v === '__custom') {
    const inp = document.getElementById(prefix + 'TopicCustom')
    const name = (inp ? inp.value : '').trim()
    if (!name) { alert(t('courseErrOfflineTopic')); return null }
    return { name, topicId: 0, custom: true }
  }
  if (!v) { alert(t('courseErrOfflineTopic')); return null }
  const opt = sel.selectedOptions && sel.selectedOptions[0]
  return { name: (opt ? opt.text : '').trim(), topicId: Number(v), custom: false }
}

// datetime-local 输入框反向取值（时间戳 → yyyy-MM-ddTHH:mm）
function courseDateLocalInput(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function courseCreateOfflineModal(cid) {
  // v43：线下课主题固定用静态 11 大培训主题（BANK.categories），与派生题库分类解耦
  const cats = (typeof BANK !== 'undefined' && BANK.categories) ? BANK.categories : Store.getCategories()
  courseModalOpen(t('courseNewOffline'), `
    <div class="form-group"><label>${t('courseOfflineTopic')} *</label>
      <select id="coTopic" onchange="courseOfflineTopicToggle('co')">
        <option value="">${t('courseOfflineSelectPh')}</option>
        ${cats.map(x => `<option value="${x.id}">${escHtml(x.name)}</option>`).join('')}
        <option value="__custom">✍️ ${t('courseOfflineCustom')}</option>
      </select></div>
    <div class="form-group" id="coTopicCustomGroup" style="display:none"><label>${t('courseOfflineCustomPh')}</label>
      <input type="text" id="coTopicCustom" placeholder="${t('courseOfflineCustomPh2')}" /></div>
    <div class="form-group"><label>${t('courseOfflineDate')}</label>
      <input type="datetime-local" id="coDate" /></div>
    <div class="form-group"><label>${t('courseClassNote')}</label>
      <input type="text" id="coDesc" placeholder="${t('courseOfflineDescPh')}" /></div>
    <p class="form-hint">${t('courseOfflineCreateHint')}</p>`,
    `<button class="btn btn-primary" onclick="courseCreateOffline('${escAttr(cid)}')">${t('courseCreate')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseCreateOffline(cid) {
  const topic = courseOfflineReadTopic('co')
  if (!topic) return
  const dateRaw = document.getElementById('coDate').value
  const date = dateRaw ? new Date(dateRaw).getTime() : 0
  const desc = (document.getElementById('coDesc').value || '').trim()
  const aid = CourseStore.newId('a')
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      c.assignments = c.assignments || []
      if (c.assignments.some(x => x.id === aid)) return false   // 幂等：重试不重复
      c.assignments.push({
        id: aid, type: 'offline', title: topic.name, topicId: topic.topicId, custom: topic.custom,
        desc, date, createdAt: Date.now(), createdBy: courseUser(),
        held: false, heldAt: 0, results: {}
      })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseOfflineCreateOk'))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

function courseEditOfflineModal(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a) return
  // v43：线下课主题固定用静态 11 大培训主题（BANK.categories），与派生题库分类解耦
  const cats = (typeof BANK !== 'undefined' && BANK.categories) ? BANK.categories : Store.getCategories()
  const isCustom = !!a.custom
  const opts = `<option value="">${t('courseOfflineSelectPh')}</option>` +
    cats.map(x => `<option value="${x.id}"${(!isCustom && a.topicId === x.id) ? ' selected' : ''}>${escHtml(x.name)}</option>`).join('') +
    `<option value="__custom"${isCustom ? ' selected' : ''}>✍️ ${t('courseOfflineCustom')}</option>`
  courseModalOpen(t('courseOfflineEditTitle'), `
    <div class="form-group"><label>${t('courseOfflineTopic')} *</label>
      <select id="ceTopic" onchange="courseOfflineTopicToggle('ce')">${opts}</select></div>
    <div class="form-group" id="ceTopicCustomGroup" style="${isCustom ? '' : 'display:none'}"><label>${t('courseOfflineCustomPh')}</label>
      <input type="text" id="ceTopicCustom" value="${escAttr(isCustom ? a.title : '')}" placeholder="${t('courseOfflineCustomPh2')}" /></div>
    <div class="form-group"><label>${t('courseOfflineDate')}</label>
      <input type="datetime-local" id="ceDate" value="${courseDateLocalInput(a.date)}" /></div>
    <div class="form-group"><label>${t('courseClassNote')}</label>
      <input type="text" id="ceDesc" value="${escAttr(a.desc || '')}" placeholder="${t('courseOfflineDescPh')}" /></div>`,
    `<button class="btn btn-primary" onclick="courseEditOffline('${escAttr(cid)}','${escAttr(aid)}')">${t('saveBtn')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseEditOffline(cid, aid) {
  const topic = courseOfflineReadTopic('ce')
  if (!topic) return
  const dateRaw = document.getElementById('ceDate').value
  const date = dateRaw ? new Date(dateRaw).getTime() : 0
  const desc = (document.getElementById('ceDesc').value || '').trim()
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a || a.type !== 'offline') return false
      a.title = topic.name
      a.topicId = topic.topicId
      a.custom = topic.custom
      a.date = date
      a.desc = desc
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseOfflineEditOk'))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// 真正下课后「标注完成」：先弹窗勾选本次没来的学员，其余成员自动标注完成
// 缺席名单写入 a.absent（数组）；results 只记录出席(done)者 —— 二者互补
function courseHeldModal(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const members = c.members || []
  if (a.held) { alert(t('courseOfflineAlreadyHeld')); return }
  if (!members.length) { alert(t('courseOfflineNoMembers')); return }
  const prevAbsent = Array.isArray(a.absent) ? a.absent.filter(u => members.indexOf(u) >= 0) : []
  const listHtml = members.map(u => {
    const chk = prevAbsent.indexOf(u) >= 0 ? ' checked' : ''
    return `<label class="course-off-member"><input type="checkbox" name="coAbs" value="${escAttr(u)}"${chk} /> ${escHtml(u)}</label>`
  }).join('')
  courseModalOpen(t('courseOfflineHeldAll'), `
    <p style="margin-bottom:8px;font-weight:600">📅 ${escHtml(a.title)}</p>
    <p class="form-hint" style="margin-bottom:10px">${t('courseOfflineHeldModalHint', members.length)}</p>
    <div class="course-chips course-off-members course-off-absent-pick" style="max-height:240px;overflow-y:auto">${listHtml}</div>`,
    `<button class="btn btn-primary" onclick="courseHeldSave('${escAttr(cid)}','${escAttr(aid)}')">✅ ${t('courseOfflineHeldAll')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseHeldSave(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const members = c.members || []
  if (a.held) { alert(t('courseOfflineAlreadyHeld')); return }
  if (!members.length) { alert(t('courseOfflineNoMembers')); return }
  const absent = Array.prototype.slice.call(document.querySelectorAll('.course-off-absent-pick input[name="coAbs"]:checked')).map(el => el.value)
  const absentSet = {}
  absent.forEach(u => { absentSet[u] = true })
  const attend = members.filter(u => !absentSet[u])
  if (!attend.length) { alert(t('courseOfflineNoAttend')); return }   // 全员缺席：不标 held
  const by = courseUser()
  try {
    await CourseStore.mutate(doc => {
      const cc = CourseStore.findClass(doc, cid)
      const aa = CourseStore.findAssign(cc, aid)
      if (!aa || aa.held) return false   // 幂等：已被并发标注则跳过
      const now = Date.now()
      aa.held = true
      aa.heldAt = now
      aa.absent = absent.slice()
      aa.results = aa.results || {}
      ;(cc.members || []).forEach(u => {
        if (absentSet[u]) delete aa.results[u]   // 缺席者移除（防此前误标残留）
        else {
          const prev = aa.results[u]             // 出席者写 done，保留原有标注人/时间
          aa.results[u] = { done: true, at: (prev && prev.at) || now, by: (prev && prev.by) || by }
        }
      })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(absent.length ? t('courseOfflineHeldOk', attend.length) + '，' + t('courseOfflineAbsentTag', absent.length) : t('courseOfflineHeldOk', attend.length))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// 撤销「已下课」标注（清空全员完成记录；缺席名单保留，便于重新标注时预勾选）
async function courseUnheldAll(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a || !a.held) return
  if (!confirm(t('courseOfflineUndoConfirm'))) return
  try {
    await CourseStore.mutate(doc => {
      const cc = CourseStore.findClass(doc, cid)
      const aa = CourseStore.findAssign(cc, aid)
      if (!aa || !aa.held) return false
      aa.held = false
      aa.heldAt = 0
      aa.results = {}   // absent 不清空：撤销后重新标注可记忆上次缺席者
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// 出席成员标注弹窗：逐个勾选（补标缺席 / 取消误标）
function courseOfflineMembers(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const members = c.members || []
  const listHtml = members.length
    ? members.map(u => {
        const done = !!(a.results || {})[u] && (a.results || {})[u].done
        return `<label class="course-off-member"><input type="checkbox" name="coM" value="${escAttr(u)}"${done ? ' checked' : ''} /> ${escHtml(u)}</label>`
      }).join('')
    : `<p style="color:#9ca3af">${t('courseOfflineNoMembers')}</p>`
  courseModalOpen(t('courseOfflineMembersTitle'), `
    ${members.length ? `<p style="margin-bottom:8px;font-weight:600">📅 ${escHtml(a.title)}</p>` : ''}
    <p class="form-hint" style="margin-bottom:10px">${t('courseOfflineMembersHint')}</p>
    <div class="course-chips course-off-members" style="max-height:240px;overflow-y:auto">${listHtml}</div>`,
    `<button class="btn btn-primary" onclick="courseOfflineMembersSave('${escAttr(cid)}','${escAttr(aid)}')">${t('saveBtn')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseOfflineMembersSave(cid, aid) {
  const c = courseFind(cid)
  if (!c) return
  const checked = Array.prototype.slice.call(document.querySelectorAll('.course-off-members input[name="coM"]:checked')).map(el => el.value)
  const want = {}
  checked.forEach(u => { want[u] = true })
  const by = courseUser()
  try {
    await CourseStore.mutate(doc => {
      const cc = CourseStore.findClass(doc, cid)
      const aa = CourseStore.findAssign(cc, aid)
      if (!aa) return false
      const now = Date.now()
      const members = cc.members || []
      aa.results = aa.results || {}
      // 幂等：results / held / absent 均已与目标一致则跳过写入
      const cur = members.filter(u => aa.results[u] && aa.results[u].done).length
      const resultsMatch = members.every(u => !!want[u] === !!(aa.results[u] && aa.results[u].done))
      const absentWant = members.filter(u => !want[u])   // 出席名单 ⇄ 缺席名单互为补集
      const absentSync = Array.isArray(aa.absent) ? aa.absent.filter(u => members.indexOf(u) >= 0) : []
      const absentMatch = absentSync.length === absentWant.length && absentWant.every(u => absentSync.indexOf(u) >= 0)
      if (checked.length === cur && !!(aa.held) === (checked.length > 0) && resultsMatch && absentMatch) return false
      members.forEach(u => {
        if (want[u]) {
          const prev = aa.results[u]
          aa.results[u] = { done: true, at: (prev && prev.at) || now, by: (prev && prev.by) || by }
        } else {
          delete aa.results[u]
        }
      })
      aa.absent = absentWant
      aa.held = checked.length > 0
      aa.heldAt = checked.length > 0 ? (aa.heldAt || now) : 0
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

function courseBackAdmin() { courseState.view = 'list'; renderCoursePage() }

// ---------- 成绩看板 ----------
function courseOpenDashboard() {
  courseState.view = 'dashboard'
  renderCourseDashboard()
}

async function renderCourseDashboard() {
  const el = document.getElementById('page-course')
  const classes = courseState.doc.classes || []
  const infoMap = await courseUserInfoMap()

  // 汇总
  let totalStudents = 0, totalAssigns = 0, totalDone = 0, allScores = []
  const studentSet = new Set()
  classes.forEach(c => {
    (c.members || []).forEach(m => studentSet.add(m))
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')   // 草稿不计入看板
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
  totalStudents = studentSet.size
  const completionRate = totalStudents * totalAssigns > 0 ? Math.round(totalDone / (totalStudents * totalAssigns) * 100) : 0
  const avgScore = allScores.length ? Math.round(allScores.reduce((s, x) => s + x, 0) / allScores.length) : 0

  // 每个班级的成绩矩阵
  const matrices = classes.map(c => {
    const members = c.members || []
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')   // 草稿不入矩阵
    if (!assigns.length) return ''

    const headerCells = assigns.map(a => {
      // 任务列固定宽度：保证看板列宽稳定不挤压，超宽时横向滚动
      return `<th class="dash-th" style="min-width:110px">${courseTaskIcon(a)} ${escHtml(a.title)}</th>`
    }).join('')

    const rows = (members.length ? members : []).map(u => {
      const cells = assigns.map(a => {
        const r = (a.results || {})[u]
        if (!r) return `<td class="dash-cell not-done">${t('courseDashNotDone')}</td>`
        // 线下课：只有完成（✓ 已标注）状态
        if (courseIsOffline(a)) {
          return r.done
            ? `<td class="dash-cell good">✓ ${t('courseDoneTag')}</td>`
            : `<td class="dash-cell not-done">${t('courseDashNotDone')}</td>`
        }
        // 视频任务：配小测且已答完 → 显示课后小测正确率（% + 答对/总题数）；
        // 配了小测但看完未答 → 「待答题」（v44 语义：看完 ≠ 完成）；无小测 → 观看完成率（✓ / %）
        if (a.type === 'video') {
          const q = courseVideoQuizScore(a, r)
          if (q) {
            const cls = q.acc >= 80 ? 'good' : q.acc >= 60 ? 'ok' : 'bad'
            return `<td class="dash-cell ${cls}">${q.acc}%<span style="font-size:10px;color:#9ca3af"> ${q.correct}/${q.total}</span></td>`
          }
          const pct = r.watchedPct != null ? Math.min(100, Math.round(r.watchedPct)) : 100
          if (Array.isArray(a.quiz) && a.quiz.length && pct >= 90) {
            return `<td class="dash-cell ok">📝 ${t('courseVideoQuizTag')}</td>`
          }
          const cls = pct >= 90 ? 'good' : 'ok'
          return `<td class="dash-cell ${cls}">✓ ${pct}%</td>`
        }
        const cls = r.score >= 80 ? 'good' : r.score >= 60 ? 'ok' : 'bad'
        // v56：attempts>1 时不再只显示 ×N，改列每次真实分数（第1次→最近）；旧数据无 history 退回 ×N
        const histArr = (Array.isArray(r.history) && r.history.length > 1) ? r.history : null
        const sub = histArr
          ? `<div class="dash-hist" title="${escAttr(t('courseHistTitle'))}">${histArr.map(h => h.score).join('→')}</div>`
          : (r.attempts > 1 ? ` <span style="font-size:10px;color:#9ca3af">×${r.attempts}</span>` : '')
        return `<td class="dash-cell ${cls}">${r.score}${LANG === 'en' ? '' : '分'}${sub}</td>`
      }).join('')
      return `<tr><td class="dash-student">${courseMemberCell(u, infoMap)}</td>${cells}</tr>`
    }).join('') || `<tr><td colspan="${assigns.length + 1}" style="text-align:center;color:#9ca3af;padding:20px">${t('courseNoMembers')}</td></tr>`

    // v50：表格底部汇总行 —— 每列该任务全班错题率（作业/测评=最终记录 correct/total；视频配小测=已答学员 quiz；
    // 线下课 / 无小测视频 / 无人作答 → —），配色：错题率越低越好 ≤20 绿 / ≤40 黄 / >40 红
    const footCells = assigns.map(a => {
      const wr = courseTaskWrongRate(a)
      if (!wr) return `<td class="dash-cell">—</td>`
      // v51：有逐题明细 → 汇总格文字可点击钻取到每题错题率弹窗
      const d = courseTaskWrongDetail(a)
      const txt = d
        ? `<a class="dash-wr-link" title="${escAttr(t('courseWrongDetailTitle'))}" onclick="courseWrongDetailModal('${escAttr(c.id)}','${escAttr(a.id)}')">✗ ${wr.rate}%</a>`
        : `✗ ${wr.rate}%`
      return `<td class="dash-cell ${courseWrongRateCls(wr.rate)}">${txt}<span style="font-size:10px;color:#9ca3af"> ${wr.wrong}/${wr.total}</span></td>`
    }).join('')

    return `<div class="card" style="margin-bottom:16px;padding:0;overflow-x:auto">
      <div style="padding:12px 16px;border-bottom:1px solid #e5e7eb"><strong>🎓 ${escHtml(c.name)}</strong>
        <span style="color:#6b7280;font-size:13px;margin-left:8px">👥 ${members.length}${t('courseMembersUnit')} · 📋 ${assigns.length}${t('courseAssignUnit')}</span>
      </div>
      <!-- width:auto + min-width:100%：列宽由内容/最小宽度决定不被压缩，超出容器时卡片横向滚动 -->
      <table class="admin-table dash-table" style="width:auto;min-width:100%">
        <thead><tr><th class="dash-student-th" style="min-width:130px">${t('courseMatrixStudent')}</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td class="dash-lbl-cell">✗ ${t('courseDashWrongRate')}</td>${footCells}</tr></tfoot>
      </table>
    </div>`
  }).join('')

  el.innerHTML = `
    <div class="course-back"><a onclick="courseBackAdmin()">← ${t('courseBackAdmin')}</a></div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <h2 style="margin:0">📊 ${t('courseDashboardTitle')}</h2>
      ${classes.length ? `<button class="btn" onclick="courseExportExcel()">📥 ${t('courseExportExcel')}</button>` : ''}
    </div>
    <div class="dashboard-summary">
      <div class="dash-stat"><div class="dash-val">${totalStudents}</div><div class="dash-lbl">${t('courseDashStudents')}</div></div>
      <div class="dash-stat"><div class="dash-val">${totalAssigns}</div><div class="dash-lbl">${t('courseDashTotalAssign')}</div></div>
      <div class="dash-stat"><div class="dash-val">${completionRate}%</div><div class="dash-lbl">${t('courseDashCompletion')}</div></div>
      <div class="dash-stat"><div class="dash-val">${avgScore}${LANG === 'en' ? '' : '分'}</div><div class="dash-lbl">${t('courseDashAvgScore')}</div></div>
    </div>
    <div style="margin-top:20px">${matrices || `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">${t('courseDashNoData')}</div>`}</div>
    <p class="form-hint" style="margin-top:12px">${t('courseAdminHint')}</p>`
}

// ---------- 成绩导出 Excel（纯前端生成 .xlsx：无压缩 zip + 最小 OOXML，兼容 Excel/WPS） ----------
function xlsxXmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}
function xlsxColRef(n) {  // 0 -> A, 25 -> Z, 26 -> AA
  let s = ''
  n += 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}
function xlsxSheetXml(rows) {
  const body = (rows || []).map((row, ri) => {
    const cells = (row || []).map((v, ci) => {
      const ref = xlsxColRef(ci) + (ri + 1)
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`
      const s = v == null ? '' : String(v)
      if (!s) return ''
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xlsxXmlEscape(s)}</t></is></c>`
    }).join('')
    return `<row r="${ri + 1}">${cells}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}
function xlsxCrc32(buf) {
  let t = xlsxCrc32._t
  if (!t) {
    t = xlsxCrc32._t = new Int32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function xlsxBuildZip(files) {
  const enc = new TextEncoder()
  const parts = [], central = []
  let offset = 0
  const DOS_DATE = 0x5D24, DOS_TIME = 0x6000   // 固定 2026-09-04 12:00，保证输出确定性
  files.forEach(f => {
    const nameBuf = enc.encode(f.name)
    const data = enc.encode(f.data)
    const crc = xlsxCrc32(data)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true)
    lh.setUint16(8, 0, true); lh.setUint16(10, DOS_TIME, true); lh.setUint16(12, DOS_DATE, true)
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true)
    lh.setUint16(26, nameBuf.length, true); lh.setUint16(28, 0, true)
    parts.push(new Uint8Array(lh.buffer), nameBuf, data)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true)
    cd.setUint16(8, 0, true); cd.setUint16(10, 0, true); cd.setUint16(12, DOS_TIME, true); cd.setUint16(14, DOS_DATE, true)
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true)
    cd.setUint16(28, nameBuf.length, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), nameBuf)
    offset += 30 + nameBuf.length + data.length
  })
  const cdSize = central.reduce((s, p) => s + p.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true)
  const all = parts.concat(central, [new Uint8Array(eocd.buffer)])
  const total = all.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  all.forEach(p => { out.set(p, pos); pos += p.length })
  return out
}
// 单元格取值：与看板矩阵一致的完成语义
function courseExportCell(a, r) {
  if (!r) return t('courseDashNotDone')
  if (courseIsOffline(a)) return r.done ? t('courseDoneTag') : t('courseDashNotDone')
  if (a.type === 'video') {
    // v48：配小测且已答完 → 显示课后小测正确率（替代观看完成率）；否则显示观看进度
    const q = courseVideoQuizScore(a, r)
    if (q) return q.acc + '% · ' + q.correct + '/' + q.total
    const pct = r.watchedPct != null ? Math.min(100, Math.round(r.watchedPct)) + '%' : t('courseDoneTag')
    return pct
  }
  return (r.score != null ? r.score : t('courseDoneTag'))
}
async function courseExportExcel() {
  const doc = courseState.doc || await CourseStore.getDoc()
  const classes = doc.classes || []
  if (!classes.length) { alert(t('courseDashNoData')); return }
  const infoMap = await courseUserInfoMap()
  const sheets = []
  classes.forEach((c, idx) => {
    const members = c.members || []
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')   // 草稿不导出
    if (!assigns.length) return
    let name = String(c.name || '').replace(/[\\\/\*\?\:\[\]]/g, ' ').replace(/'/g, '').trim().slice(0, 28) || ('Class' + (idx + 1))
    if (sheets.some(s => s.name === name)) name = name.slice(0, 26) + '_' + (idx + 1)
    const rows = [[t('courseMatrixStudent')].concat(assigns.map(a => String(a.title || '')))]
    members.forEach(u => {
      const info = infoMap[u] || {}
      const disp = (info.name ? String(info.name).trim() : '') || u
      rows.push([disp].concat(assigns.map(a => courseExportCell(a, (a.results || {})[u]))))
    })
    // v50：底部追加一行全班错题率（与看板汇总行同口径；无作答任务 → —）
    rows.push([`✗ ${t('courseDashWrongRate')}`].concat(assigns.map(a => courseWrongRateText(a))))
    sheets.push({ name, rows })
  })
  if (!sheets.length) { alert(t('courseDashNoData')); return }
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xlsxXmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` }
  ]
  sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: xlsxSheetXml(s.rows) }))
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const fname = `${t('courseDashboardTitle')}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`
  const blob = new Blob([xlsxBuildZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fname
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function courseAddMember(cid) {
  const input = document.getElementById('courseMemberInput')
  const u = input.value.trim()
  if (!u) return
  try {
    const ok = await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      c.members = c.members || []
      if (c.members.includes(u)) return false
      c.members.push(u)
    })
    if (ok === null) alert(t('courseMemberExists'))
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

async function courseRemoveMember(cid, u) {
  if (!confirm(t('courseRemoveMemberConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      c.members = (c.members || []).filter(x => x !== u)
      ;(c.assignments || []).forEach(a => { if (a.results) delete a.results[u] })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

async function courseLoadCloudUsers(cid) {
  const box = document.getElementById('courseCloudUsers')
  box.innerHTML = `<p style="color:#6b7280;font-size:13px">${t('courseLoading')}</p>`
  let users = []
  try {
    const rows = await CloudSync.getDashboardData()
    users = rows.filter(r => r.role !== 'admin')
  } catch (e) { /* ignore */ }
  const c = courseFind(cid)
  const inClass = new Set((c && c.members) || [])
  const candidates = users.filter(r => !inClass.has(r.username))
  if (!candidates.length) {
    box.innerHTML = `<p style="color:#9ca3af;font-size:13px">${t('courseNoCloudUsers')}</p>`
    return
  }
  box.innerHTML = `
    <div class="course-cloud-list">
      ${candidates.map(r => `
        <label class="course-user-pick">
          <input type="checkbox" value="${escAttr(r.username)}" />
          <span>${escHtml(r.username)}${r.name ? '（' + escHtml(r.name) + '）' : ''}${r.dept ? ' · ' + escHtml(r.dept) : ''}</span>
        </label>`).join('')}
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="courseBatchAddMembers(${escAttr(JSON.stringify(cid))})">${t('courseBatchAdd')}</button>`
}

async function courseBatchAddMembers(cid) {
  const checked = [...document.querySelectorAll('#courseCloudUsers input[type=checkbox]:checked')].map(i => i.value)
  if (!checked.length) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      c.members = c.members || []
      checked.forEach(u => { if (!c.members.includes(u)) c.members.push(u) })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

async function courseDeleteAssign(cid, aid, title) {
  if (!confirm(t('courseDeleteAssignConfirm', title))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      c.assignments = (c.assignments || []).filter(a => a.id !== aid)
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// ================================================================
// 复制作业到其他班级：题目 / 课后小测 / 视频链接等原样复制，成绩不复制
// 已发布 → 复制为已发布（立即在目标班级可见；过期截止时间清空）；
// 草稿   → 复制为草稿（在目标班级继续编辑或发送）；线下课不支持复制
// ================================================================
async function courseCopyAssignModal(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a || a.type === 'offline') return
  // 拉取最新班级列表（其他管理员可能刚建了新班级）
  try { courseState.doc = await CourseStore.getDoc() } catch (e) {}
  const c = courseFind(cid)
  const others = ((courseState.doc && courseState.doc.classes) || []).filter(x => x.id !== cid)
  if (!c || !others.length) { alert(t('courseCopyNoClass')); return }
  const opts = others.map(x =>
    `<option value="${escAttr(x.id)}">${escHtml(x.name)}</option>`).join('')
  const contentNote = a.type === 'video'
    ? ((a.quiz && a.quiz.length)
      ? t('courseCopyQuizN', a.quiz.length)
      : t('courseCopyQuizNone'))
    : t('courseCopyQN', (a.questions || []).length)
  const typeLabel = a.type === 'video' ? t('courseTypeVideo') : (a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework'))
  courseModalOpen(t('courseCopyTitle'), `
    <div style="font-size:14px;color:#1f2937;background:#f3f4f6;border-radius:6px;padding:10px 12px;margin-bottom:14px;line-height:1.7">
      📋 ${typeLabel} · ${escHtml(a.title)}<br>
      <span style="color:#6b7280;font-size:13px">${contentNote}</span></div>
    <div class="form-group"><label>${t('courseCopyTargetLabel')}</label>
      <select id="ccTarget"><option value="">${t('courseCopyPick')}</option>${opts}</select></div>
    <p class="form-hint" style="margin-top:10px">${t('courseCopyHint')}</p>
  `,
    `<button class="btn btn-primary" onclick="courseCopyAssignDo('${escAttr(cid)}','${escAttr(aid)}')">📋 ${t('courseCopyBtn')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseCopyAssignDo(cid, aid) {
  const sel = document.getElementById('ccTarget')
  const tid = sel ? sel.value : ''
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a || a.type === 'offline' || !tid) return
  const tgt = ((courseState.doc && courseState.doc.classes) || []).find(x => x.id === tid)
  if (!tgt) return
  const now = Date.now()
  // 深拷贝任务本体（题目数组 / 选项 / 课后小测 / 视频链接等一并复制），再重置实例字段
  const clone = JSON.parse(JSON.stringify(a))
  clone.results = {}          // 成绩不复制：新班级从零开始
  clone.id = CourseStore.newId('a')
  clone.createdAt = now
  if (clone.status === 'draft') {
    // 草稿 → 保持草稿状态
  } else {
    delete clone.status
    // 已发布 → 复制即发布；原截止时间已过则清空，避免目标班级学员一进来看见「已逾期」
    if (clone.deadline && clone.deadline < now) clone.deadline = 0
    clone.sentAt = now
  }
  try {
    await CourseStore.mutate(doc => {
      const tc = CourseStore.findClass(doc, tid)
      if (!tc) return false
      tc.assignments = tc.assignments || []
      if (tc.assignments.some(x => x.id === clone.id)) return false   // 幂等：重试不重复
      tc.assignments.push(clone)
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseCopyOk', tgt.name, a.title))
  courseState.doc = await CourseStore.getDoc()
  try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
  courseRenderClass()
}

// 发送草稿作业：status draft → open，学员立即可见
async function courseSendAssign(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a || a.status !== 'draft') return
  // 发送前校验：题目/视频链接就绪、截止时间未过
  if (a.type === 'video') {
    if (!(a.videoUrl || '').trim()) { alert(t('courseErrVideoUrl')); return }
  } else if (!(a.questions || []).length) {
    alert(t('courseErrNoQ')); return
  }
  if (a.deadline && a.deadline < Date.now()) { alert(t('courseErrDeadline')); return }
  if (!confirm(t('courseSendConfirm', a.title))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const as = CourseStore.findAssign(c, aid)
      if (!as || as.status !== 'draft') return false   // 幂等：已被并发发送则跳过
      delete as.status
      as.sentAt = Date.now()
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  alert(t('courseSendOk'))
  courseState.doc = await CourseStore.getDoc()
  try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
  courseRenderClass()
}

// ---------- 作业成绩详情 ----------
async function courseAssignDetail(cid, aid) {
  courseState.view = 'assign'
  courseState.classId = cid
  courseState.assignId = aid
  const el = document.getElementById('page-course')
  let c = courseFind(cid)
  if (!c || CourseStore.status !== 'online') {
    try { courseState.doc = await CourseStore.getDoc() } catch (e) {}
    c = courseFind(cid)
  }
  const a = courseFindAssign(cid, aid)
  if (!c || !a) { courseState.view = 'class'; return courseRenderClass() }
  // 线下课没有作答成绩 → 打开出席标注弹窗
  if (courseIsOffline(a)) return courseOfflineMembers(cid, aid)

  const infoMap = await courseUserInfoMap()
  const isVideo = a.type === 'video'
  const hasQuiz = isVideo && Array.isArray(a.quiz) && a.quiz.length   // v44：视频课后小测
  // 视频作业难度汇总
  let diffAvg = null, diffCount = 0, diffSum = 0
  const diffDist = [0,0,0,0,0]  // 1-5分分布
  if (isVideo) {
    Object.values(a.results || {}).forEach(r => {
      if (r && r.difficulty) {
        diffSum += r.difficulty; diffCount++
        const idx = Math.min(4, Math.max(0, r.difficulty - 1))
        diffDist[idx]++
      }
    })
    diffAvg = diffCount > 0 ? Math.round(diffSum / diffCount * 10) / 10 : null
  }
  const distHtml = (dist) => [1,2,3,4,5].map(n => {
    const c = dist[n-1] || 0
    return `${n}★:${c}${n<5?'  ':''}`
  }).join('')
  const diffSummaryHtml = isVideo
    ? `<div class="card" style="margin-bottom:16px;padding:14px 16px">
        <span style="font-size:14px;font-weight:600;color:#374151">⭐ ${t('courseVideoDiffSummary')}</span>
        <span style="margin-left:12px;font-size:15px;color:#b45309">${diffAvg != null ? diffAvg + ' / 5' : '—'}</span>
        <span style="margin-left:8px;font-size:13px;color:#6b7280">(${t('courseVideoDiffCount', diffCount)})</span>
        <div style="margin-top:8px;font-size:13px;color:#6b7280">${distHtml(diffDist)}</div>
      </div>`
    : ''
  const rows = (c.members || []).map(u => {
    const r = (a.results || {})[u]
    const overTag = r && r.overdue ? ` <span class="course-status expired">${t('courseOverdue')}</span>` : ''
    // v56：作业/测评做过多遍 → 状态列下方列出每次真实成绩（第1次 → 最近）
    const histArr = r && !isVideo && Array.isArray(r.history) && r.history.length > 1 ? r.history : null
    const histHtml = histArr
      ? `<div class="course-hist" title="${escAttr(t('courseHistTitle'))}">${histArr.map((h, i) => `<span>${t('courseHistTryFmt', i + 1, h.score)}</span>`).join('<span class="course-hist-sep"> → </span>')}</div>`
      : ''
    const statusHtml = r
      ? (isVideo
          ? `<span class="course-status done">✓ ${t('courseDoneTag')}${r.watchedPct != null ? ' · ' + Math.min(100, Math.round(r.watchedPct)) + '%' : ''}</span>${overTag}`
          : `<span class="course-status done">✓ ${r.score}${LANG === 'en' ? '' : '分'}</span>${overTag}${histHtml}`)
      : `<span class="course-status expired">${t('courseNotSubmitted')}</span>`
    return `<tr>
      <td>${courseMemberCell(u, infoMap)}</td>
      <td>${statusHtml}</td>
      <td style="text-align:center">${isVideo ? (r ? (r.watchedSec || 0) + 's' : '—') : (r ? (r.correct || 0) + '/' + (r.total || 0) : '—')}</td>
      ${isVideo ? `<td style="text-align:center">${r ? (r.difficulty ? '★'.repeat(Math.min(5,Math.max(1,r.difficulty))) : '—') : '—'}</td>` : ''}
      ${hasQuiz ? `<td style="text-align:center">${r && r.quizTotal != null ? r.quizCorrect + '/' + r.quizTotal : '—'}</td>` : ''}
      <td style="text-align:center">${r ? (r.attempts || 1) : '—'}</td>
      <td style="font-size:12px">${r ? courseFmtDate(r.at) : '—'}</td>
      <td>${r ? `<button class="btn btn-ghost btn-sm" onclick="courseResetResult(${escAttr(JSON.stringify(cid))},${escAttr(JSON.stringify(aid))},${escAttr(JSON.stringify(u))})">${t('courseResetResult')}</button>` : ''}</td>
    </tr>`
  }).join('')

  el.innerHTML = `
    <div class="course-back"><a onclick="courseBackClass()">← ${t('courseBackClass')}</a></div>
    <h2 style="margin-bottom:4px">📋 ${escHtml(a.title)}</h2>
    <p style="color:#6b7280;margin-bottom:16px">${isVideo ? t('courseTypeVideo') : (a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework'))} · ${isVideo ? t('courseVideoLabel') : (a.questions || []).length + t('courseQuestions')} · ${t('courseDeadline')}：${a.deadline ? courseFmtDate(a.deadline) : t('courseUnlimited')}</p>
    ${diffSummaryHtml}
    ${rows ? `<div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead><tr>
          <th>${t('courseThMember')}</th><th>${isVideo ? t('courseThWatch') : t('courseThScore')}</th><th>${isVideo ? t('courseThWatchSec') : t('courseThCorrect')}</th>
          ${isVideo ? `<th>${t('courseThDifficulty')}</th>` : ''}
          ${hasQuiz ? `<th>${t('courseThQuiz')}</th>` : ''}
          <th>${t('courseThTries')}</th><th>${t('courseThSubmitAt')}</th><th>${t('courseThAction')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` :
      `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">${t('courseNoMembers')}</div>`}`
}

function courseBackClass() { courseState.view = 'class'; courseRenderClass() }

async function courseResetResult(cid, aid, u) {
  if (!confirm(t('courseResetConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      if (a.results) delete a.results[u]
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}

// ================================================================
// 新建作业 / 测评（题库抽题 或 上传课程文件生成）
// ================================================================
function courseCreateAssignModal(cid) {
  courseDraft = { cid, mode: 'bank', preview: [], file: null, files: [], fileName: '', quiz: [] }
  const cats = Store.getCategories()
  courseModalOpen(t('courseNewAssign'), `
    <div class="form-row2">
      <div class="form-group"><label>${t('courseTypeLabel')} *</label>
        <select id="caType" onchange="courseDraftTypeChange()">
          <option value="homework">${t('courseTypeHomework')}</option>
          <option value="exam">${t('courseTypeExam')}</option>
          <option value="video">${t('courseTypeVideo')}</option>
        </select></div>
      <div class="form-group"><label>${t('courseTitlePh')} *</label>
        <input type="text" id="caTitle" placeholder="${t('courseTitlePh2')}" /></div>
    </div>
    <div class="form-group"><label>${t('courseDescPh')}</label>
      <input type="text" id="caDesc" placeholder="${t('courseDescPh2')}" /></div>
    <div class="form-row2">
      <div class="form-group"><label>${t('courseDeadlineLabel')}</label>
        <input type="datetime-local" id="caDeadline" /></div>
      <div class="form-group" id="caExamOnly"><label>${t('courseDurationLabel')}</label>
        <input type="number" id="caDuration" min="1" max="180" value="20" /></div>
    </div>
    <div class="form-group" id="caPassGroup"><label>${t('coursePassLabel')}</label>
      <input type="number" id="caPass" min="0" max="100" value="60" /></div>
    <div class="form-group" id="caVideoUrlGroup" style="display:none"><label>${t('courseVideoUrlLabel')} *</label>
      <input type="text" id="caVideoUrl" placeholder="${t('courseVideoUrlPh')}" /></div>

    <div id="caQuizBox" style="display:none;padding:12px;border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;margin-bottom:12px">
      <div class="form-group" style="margin-bottom:6px"><label>${t('courseQuizBuilderTitle')}</label>
        <p class="form-hint" style="margin:2px 0 10px">${t('courseQuizBuilderHint')}</p></div>
      <div id="caQuizList"></div>
      <button class="btn btn-ghost btn-sm" onclick="courseQuizAddQ('ca')">${t('courseQuizAddQ')}</button>
    </div>

    <div class="course-source">
      <label class="course-src-opt">
        <input type="radio" name="caSource" value="bank" checked onchange="courseDraftModeChange('bank')" />
        <span>${t('courseSourceBank')}</span>
      </label>
      <label class="course-src-opt">
        <input type="radio" name="caSource" value="file" onchange="courseDraftModeChange('file')" />
        <span>${t('courseSourceFile')}</span>
      </label>
      <label class="course-src-opt">
        <input type="radio" name="caSource" value="imp" onchange="courseDraftModeChange('imp')" />
        <span>${t('courseSourceImport')}</span>
      </label>
    </div>

    <div id="caBankBox">
      <div class="form-row2">
        <div class="form-group"><label>${t('courseCategoryLabel')}</label>
          <select id="caCategory"><option value="0">${t('courseAllCategory')}</option>
            ${cats.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('')}
          </select></div>
        <div class="form-group"><label>${t('courseDiffLabel')}</label>
          <select id="caDifficulty"><option value="0">${t('courseAllDiff')}</option>
            <option value="1">${t('diffLabels')['1'] || ''}</option><option value="2">${t('diffLabels')['2'] || ''}</option><option value="3">${t('diffLabels')['3'] || ''}</option>
          </select></div>
      </div>
      <div class="form-group"><label>${t('courseCountLabel')}</label>
        <input type="number" id="caCount" min="1" max="50" value="10" /></div>
      <button class="btn btn-ghost btn-sm" onclick="courseDraftPickBank()">${t('coursePickBtn')}</button>
    </div>

    <div id="caFileBox" style="display:none">
      <div class="form-group"><label>${t('courseFileLabel')}</label>
        <input type="file" id="caFile" accept=".docx,.pptx,.pdf,.txt,.md" multiple onchange="courseDraftFileChange(this)" />
        <p class="form-hint" style="margin-top:4px">${t('courseMultiFileHint')}</p></div>
      <div class="form-row2">
        <div class="form-group"><label>${t('courseGenTotal')}</label>
          <input type="number" id="caGenTotal" min="1" max="60" value="60" /></div>
        <div class="form-group"><label>${t('courseRatioLabel')}</label>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <span class="ratio-field">${t('courseRatioSingle')}<input type="number" id="caPctSingle" min="0" max="100" placeholder="—" /></span>
            <span class="ratio-field">${t('courseRatioJudge')}<input type="number" id="caPctJudge" min="0" max="100" placeholder="—" /></span>
            <span class="ratio-field">${t('courseRatioListen')}<input type="number" id="caPctListen" min="0" max="100" placeholder="—" /></span>
            <span class="ratio-field">${t('courseRatioVoice')}<input type="number" id="caPctVoicematch" min="0" max="100" placeholder="—" /></span>
          </div></div>
      </div>
      <p class="form-hint">${t('courseRatioHint')}</p>
      <button class="btn btn-ghost btn-sm" onclick="courseDraftGenFile()">${t('courseGenBtn')}</button>
      <p class="form-hint">${t('courseGenHint')}</p>
    </div>

    <div id="caImportBox" style="display:none">
      <div class="form-group"><label>${t('courseImportFileLabel')}</label>
        <input type="file" id="caImportFile" accept=".csv,.tsv,.txt,.json,text/csv,text/plain,application/json" onchange="courseImportReadFile(this)" />
        <p class="form-hint" style="margin-top:4px">${t('courseImportFileHint')}</p></div>
      <div class="form-group"><label>${t('courseImportPaste')}</label>
        <textarea id="caImportData" style="min-height:90px;font-family:monospace;font-size:12px" placeholder="${t('courseImportPastePh')}" oninput="courseImportParse(this.value)"></textarea></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:2px 0 8px">
        <button class="btn btn-ghost btn-sm" onclick="downloadImportTemplate()">⬇️ ${t('dlTemplate')}</button>
        <button class="btn btn-ghost btn-sm" onclick="impToggleAll(true)">${t('impSelAll')}</button>
        <button class="btn btn-primary btn-sm" onclick="courseImportAdd()">${t('courseImportAdd')}</button>
        <span id="caImportStat" class="form-hint" style="margin:0"></span>
      </div>
      <div id="importPreview"></div>
    </div>

    <div id="caPreview"></div>`,
    `<button class="btn btn-primary" onclick="coursePublishAssign()">${t('coursePublish')}</button>
     <button class="btn btn-ghost" onclick="courseSaveDraftAssign()">💾 ${t('courseDraftSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
  courseDraftTypeChange()
}

function courseDraftTypeChange() {
  const type = document.getElementById('caType').value
  const dur = document.getElementById('caExamOnly')
  const pass = document.getElementById('caPassGroup')
  const video = document.getElementById('caVideoUrlGroup')
  const quizBox = document.getElementById('caQuizBox')
  const source = document.querySelector('.course-source')
  const bank = document.getElementById('caBankBox')
  const file = document.getElementById('caFileBox')
  const imp = document.getElementById('caImportBox')
  if (dur) dur.style.display = type === 'exam' ? '' : 'none'
  if (pass) pass.style.display = type === 'exam' ? '' : 'none'
  if (video) video.style.display = type === 'video' ? '' : 'none'
  if (quizBox) quizBox.style.display = type === 'video' ? '' : 'none'
  if (source) source.style.display = type === 'video' ? 'none' : ''
  if (type === 'video') {
    if (bank) bank.style.display = 'none'
    if (file) file.style.display = 'none'
    if (imp) imp.style.display = 'none'
    courseQuizRenderList('ca', courseDraft.quiz)   // v44：视频小测构建器
  } else {
    if (bank) bank.style.display = courseDraft.mode === 'bank' ? '' : 'none'
    if (file) file.style.display = courseDraft.mode === 'file' ? '' : 'none'
    if (imp) imp.style.display = courseDraft.mode === 'imp' ? '' : 'none'
  }
}

function courseDraftModeChange(mode) {
  courseDraft.mode = mode
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none' }
  show('caBankBox', mode === 'bank')
  show('caFileBox', mode === 'file')
  show('caImportBox', mode === 'imp')
  if (mode === 'imp') renderImportPreview()   // 展示空态提示或上次解析结果
}

// ================================================================
// v55：作业/测评「上传现成题目文件」——读取 v52 模板 CSV（写好的选择题），
// 解析预览勾选后直接成为本作业题目（不入题库）。复用 app.js 的 imp* 解析器。
// ================================================================
function courseImportReadFile(input) {
  const f = input && input.files && input.files[0]
  if (!f) return
  importReadFile(f)   // UTF-8/GBK 兜底读取 → 默认回调 impParseAndPreview 渲染 #importPreview
}
function courseImportParse(text) { impParseAndPreview(text) }   // 粘贴框实时解析

// 导入预览条目 → 作业题目：剔除空白选项 + 重映射答案索引；难度 1-4（模板留空走规则预估）
function courseImpQToAssign(r) {
  const q = (r && r.q) || {}
  const keep = []
  const map = []
  ;(q.options || []).forEach((o, i) => {
    const s = String(o == null ? '' : o).trim()
    if (s) { map[i] = keep.length; keep.push(s) }
  })
  const ans = (q.answer || []).map(i => map[i]).filter(i => i != null)
  return {
    type: q.type || 'single',
    difficulty: Math.min(4, Math.max(1, Number(q.difficulty) || Number((r && r.est)) || 1)),
    question: String(q.question || '').trim(),
    options: keep.length ? keep : ((q.options || []).slice()),
    answer: ans.length ? ans : ((q.answer || []).slice()),
    explanation: String(q.explanation || '').trim()
  }
}
function courseImportAdd() {
  const picked = impRowsSelected()
  if (!picked.length) { alert(t('impNoneSelected')); return }
  const qs = picked.map(courseImpQToAssign)
  courseDraft.preview = qs.map(q => ({ checked: true, q }))
  courseRenderPreview()
  const stat = document.getElementById('caImportStat')
  if (stat) stat.innerHTML = t('courseImportAdded', qs.length)
}

function courseDraftFileChange(input) {
  courseDraft.files = coursePickFiles(input)
  courseDraft.fileName = courseDraft.files.map(f => f.name).join('、')
  courseDraft.file = courseDraft.files[0] || null   // 兼容旧逻辑
}

function courseDraftPickBank() {
  const cat = document.getElementById('caCategory').value
  const diff = document.getElementById('caDifficulty').value
  let count = Number(document.getElementById('caCount').value) || 10
  let { list } = Store.queryQuestions({
    category_id: cat !== '0' ? cat : undefined,
    difficulty: diff !== '0' ? diff : undefined
  })
  if (!list.length) { alert(t('noMatchQuestions')); return }
  list = list.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(count, list.length))
  courseDraft.preview = list.map(q => ({ checked: true, q }))
  courseRenderPreview()
}

// 配额模式的四类题型键（顺序 = 输出分组顺序）
const RATIO_KEYS = ['single', 'judge', 'listen', 'voicematch']

// 题型比例 → 每类目标题数；返回 { single, judge, listen, voicematch }，全留空/全 0 返回 null（自动混出）
function courseRatioToTarget(total, pct) {
  const anyFilled = RATIO_KEYS.some(k => pct[k] != null)
  const pctSum = RATIO_KEYS.reduce((s, k) => s + (pct[k] || 0), 0)
  if (!anyFilled || pctSum <= 0) return null
  const target = {}
  RATIO_KEYS.forEach(k => {
    target[k] = pct[k] == null ? 0 : Math.max(0, Math.round(total * pct[k] / pctSum))
  })
  return target
}

// 读取 <input type=file> 选中的全部文件（支持一次多选 2-3 个）
function coursePickFiles(input) { return input && input.files ? Array.prototype.slice.call(input.files) : [] }

// 合并多个课程文件为一段文本（一次选多份文档统一出题）
// 返回 { text, errs: [{name, msg}] }；单个文件解析失败不阻断其余文件
async function courseMergeFileTexts(files) {
  const errs = []
  const parts = []
  for (const f of (files || [])) {
    try {
      const text = await QGen.readText(f)
      if (String(text || '').trim()) parts.push('【' + f.name + '】\n' + text)
    } catch (e) {
      errs.push({ name: f.name, msg: (e && e.message) || String(e) })
    }
  }
  return { text: parts.join('\n\n'), errs }
}

// 读取生成参数：总题数（1-60）+ 四类题型百分比；返回 { total, pct, target, opt }
// 启用手动比例（任一项已填）时强制合计 = 100%，否则 alert 提示并返回 null（调用处需判空返回）
// totalId 例：'caGenTotal' / 'ceAiTotal'；pctPrefix 例：'ca' / 'ceAi' → 拼接 caPctSingle / ceAiPctSingle …
function courseReadGenInputs(totalId, pctPrefix) {
  const totalEl = document.getElementById(totalId)
  const total = Math.min(60, Math.max(1, Math.round(Number(totalEl && totalEl.value))) || 60)
  const pct = {}
  RATIO_KEYS.forEach(k => {
    const el = document.getElementById(pctPrefix + 'Pct' + k.charAt(0).toUpperCase() + k.slice(1))
    const v = el ? String(el.value).trim() : ''
    pct[k] = v === '' ? null : Math.min(100, Math.max(0, Math.round(Number(v) || 0)))
  })
  const anyFilled = RATIO_KEYS.some(k => pct[k] != null)
  const pctSum = RATIO_KEYS.reduce((s, k) => s + (pct[k] || 0), 0)
  if (anyFilled && pctSum !== 100) {
    alert(t('courseRatioSumErr', pctSum))
    return null
  }
  const target = courseRatioToTarget(total, pct)
  return { total, pct, target, opt: target ? { max: total, target } : { max: total } }
}

// 向现有题目数组追加 AI 生成的新题（按题干去重）；返回 { added, skipped }
function courseAppendFresh(existing, fresh) {
  const have = new Set((existing || []).map(q => String(q.question || '').trim()))
  let added = 0, skipped = 0
  ;(fresh || []).forEach(q => {
    const key = String(q.question || '').trim()
    if (!key || have.has(key)) { skipped++; return }
    have.add(key)
    existing.push({ type: q.type, difficulty: q.difficulty || 1, question: q.question, options: (q.options || []).slice(), answer: (q.answer || []).slice(), explanation: q.explanation || '' })
    added++
  })
  return { added, skipped }
}

async function courseDraftGenFile() {
  const files = courseDraft.files || []
  if (!files.length) { alert(t('courseErrNoFile')); return }
  // 先校验比例（合计 100%），不通过直接返回，避免出现「正在生成」假状态
  const inp = courseReadGenInputs('caGenTotal', 'ca')
  if (!inp) return
  const box = document.getElementById('caPreview')
  box.innerHTML = `<p style="color:#6b7280;font-size:13px">${t('courseGenWorking')}</p>`
  try {
    // 多文件合并：一次可上传 2-3 个文档，统一解析出题
    const merged = await courseMergeFileTexts(files)
    if (!String(merged.text || '').trim()) {
      box.innerHTML = `<div class="form-hint" style="color:#b45309">
        <p><strong>${t('courseGenEmpty')}</strong></p>
        ${merged.errs.map(e => `<p style="margin-top:4px;font-size:12px">${escHtml(e.name)}：${escHtml(e.msg)}</p>`).join('')}
      </div>`
      return
    }
    const result = QGen.generate(merged.text, inp.opt)
    const qs = result.questions
    const info = result.info
    if (!qs.length) {
      let reasonHtml = ''
      if (info.reason === 'empty') {
        reasonHtml = `<p style="margin-top:6px;font-size:12px">${t('courseGenErrEmpty')}</p>`
      } else if (info.reason === 'no_pattern') {
        reasonHtml = `<p style="margin-top:6px;font-size:12px">${t('courseGenErrNoPattern', info.lines)}</p>
          <p style="margin-top:4px;font-size:12px;color:#6b7280">${t('courseGenErrPatternHint')}</p>`
      } else {
        reasonHtml = `<p style="margin-top:6px;font-size:12px">${t('courseGenErrFew', info.defs, info.pairs, info.sentPairs || 0)}</p>`
      }
      box.innerHTML = `<div class="form-hint" style="color:#b45309">
        <p><strong>${t('courseGenEmpty')}</strong></p>
        ${reasonHtml}
      </div>`
      return
    }
    courseDraft.preview = qs.map(q => ({ checked: true, q }))
    courseRenderPreview()
    // 在预览区前插入提取诊断 + 题型分布（含文件级失败提示）
    const prevHead = document.querySelector('#caPreview .course-prev-head')
    if (prevHead) {
      const tc = { single: 0, judge: 0, listen: 0 }
      qs.forEach(q => { if (tc[q.type] != null) tc[q.type]++ })
      const distLine = inp.target
        ? (LANG === 'en'
          ? `&nbsp;·&nbsp;📊 Single ${tc.single} / Judge ${tc.judge} / Listen ${tc.listen}`
          : `&nbsp;·&nbsp;📊 单选 ${tc.single} / 判断 ${tc.judge} / 听音 ${tc.listen}`)
        : ''
      const errLine = merged.errs.length
        ? `<div style="color:#b45309;margin:4px 0 0;font-size:12px">${t('courseGenPartial', merged.errs.map(e => e.name).join('、'))}</div>`
        : ''
      prevHead.insertAdjacentHTML('afterend',
        `<div class="form-hint" style="color:#059669;margin:6px 0 8px">${t('courseGenDiag', info.pairs, info.sentPairs || 0, info.defs, info.generated)}${distLine}</div>${errLine}`)
    }
  } catch (e) {
    box.innerHTML = `<p class="form-hint" style="color:#dc2626">${(e && e.message) || t('courseGenFail')}</p>`
  }
}

function courseRenderPreview() {
  const box = document.getElementById('caPreview')
  if (!box) return
  const items = courseDraft.preview.map((item, i) => {
    const q = item.q
    const optText = (q.options || []).slice(0, 4).join(' ｜ ')
    return `<label class="q-prev-item ${item.checked ? '' : 'unchecked'}">
      <input type="checkbox" ${item.checked ? 'checked' : ''} onchange="courseTogglePreview(${i})" />
      <span class="tag tag-type">${TYPE_LABELS[q.type] || q.type}</span>
      <div class="q-prev-text"><div class="q-prev-q">${escHtml(q.question)}</div>
        <div class="q-prev-opts">${escHtml(optText).slice(0, 120)}</div></div>
    </label>`
  }).join('')
  const picked = courseDraft.preview.filter(x => x.checked).length
  box.innerHTML = `
    <div class="course-prev-head">
      <span>${t('coursePreviewLabel')}</span>
      <span class="course-prev-count">${t('courseSelectedCount', picked)}</span>
    </div>
    <div class="q-prev-list">${items}</div>`
}

function courseTogglePreview(i) {
  courseDraft.preview[i].checked = !courseDraft.preview[i].checked
  const label = document.querySelectorAll('.q-prev-item')[i]
  if (label) label.classList.toggle('unchecked', !courseDraft.preview[i].checked)
  const picked = courseDraft.preview.filter(x => x.checked).length
  const cnt = document.querySelector('.course-prev-count')
  if (cnt) cnt.textContent = t('courseSelectedCount', picked)
}

// ================================================================
// v44 视频课后小测构建器（新建弹窗 ca / 编辑弹窗 ceq 共用，最多 10 题）
// ================================================================
const QUIZ_MAX = 10

function courseQuizList(prefix) {
  if (prefix === 'ca') return courseDraft ? courseDraft.quiz : null
  return courseEditQuiz ? courseEditQuiz.quiz : null
}

function courseQuizRenderList(prefix, list) {
  const box = document.getElementById(prefix + 'QuizList')
  if (!box) return
  box.innerHTML = (list || []).map((q, i) => courseQuizCardHtml(q, i, prefix)).join('')
}

function courseQuizCardHtml(q, i, prefix) {
  const opts = q.options || []
  const ans = (q.answer || [])[0]
  return `<div class="card ce-q-card" style="padding:12px;margin-bottom:8px" data-quizidx="${i}">
    <div class="ce-q-head">
      <span class="ce-q-num">${i + 1}</span>
      <select class="ce-q-type" onchange="courseQuizSetType('${prefix}',${i},this.value)">
        <option value="single" ${q.type !== 'listen' ? 'selected' : ''}>${t('courseQuizTypeSingle')}</option>
        <option value="listen" ${q.type === 'listen' ? 'selected' : ''}>${t('courseQuizTypeListen')}</option>
      </select>
      <span style="flex:1"></span>
      <button class="btn btn-danger btn-sm" onclick="courseQuizDelQ('${prefix}',${i})">${t('courseEditDelQ')}</button>
    </div>
    <div class="form-group"><label>${t('courseQuizQText')}</label>
      <textarea rows="1" class="input-answer" oninput="courseQuizQText('${prefix}',${i},this.value)">${escHtml(q.question || '')}</textarea></div>
    <div class="form-group"><label>${t('courseEditQOptions')}</label>
      <div class="ce-opt-list">${[0, 1, 2, 3].map(idx => {
        const isCorrect = ans === idx
        return `<div class="ce-opt-row">
          <label class="ce-correct-pick">
            <input type="radio" name="${prefix}QuizAns${i}" ${isCorrect ? 'checked' : ''} onchange="courseQuizSetAns('${prefix}',${i},${idx})" />
            <span style="font-weight:${isCorrect ? '700;color:#059669' : '#6b7280'}">${LETTERS[idx]}</span>
          </label>
          <input type="text" class="input-answer" value="${escAttr(opts[idx] || '')}"
            oninput="courseQuizOptText('${prefix}',${i},${idx},this.value)" style="flex:1" />
        </div>`
      }).join('')}</div>
    </div>
    <div class="form-group"><label>${t('courseEditQExplain')}</label>
      <textarea rows="1" class="input-answer" oninput="courseQuizExplain('${prefix}',${i},this.value)">${escHtml(q.explanation || '')}</textarea></div>
  </div>`
}

// ---- 输入处理（文本输入不重渲染，避免输入焦点丢失；删除/添加才重建列表）----
function courseQuizQText(prefix, i, v) { const l = courseQuizList(prefix); if (l && l[i]) l[i].question = v }
function courseQuizOptText(prefix, i, idx, v) { const l = courseQuizList(prefix); if (l && l[i] && l[i].options) l[i].options[idx] = v }
function courseQuizExplain(prefix, i, v) { const l = courseQuizList(prefix); if (l && l[i]) l[i].explanation = v }
function courseQuizSetType(prefix, i, v) { const l = courseQuizList(prefix); if (l && l[i]) l[i].type = v }
function courseQuizSetAns(prefix, i, idx) {
  const l = courseQuizList(prefix)
  if (l && l[i]) { l[i].answer = [idx] }
  const card = document.querySelector(`[data-quizidx="${i}"]`)
  if (card && prefix === courseQuizActivePrefix()) {
    card.querySelectorAll('.ce-opt-row').forEach((row, ri) => {
      const span = row.querySelector('.ce-correct-pick span')
      if (span) { span.style.fontWeight = ri === idx ? '700' : ''; span.style.color = ri === idx ? '#059669' : '#6b7280' }
    })
  }
}
function courseQuizActivePrefix() { return courseEditQuiz ? 'ceq' : 'ca' }
function courseQuizDelQ(prefix, i) {
  const l = courseQuizList(prefix)
  if (!l) return
  l.splice(i, 1)
  courseQuizRenderList(prefix, l)
}
function courseQuizAddQ(prefix) {
  const l = courseQuizList(prefix)
  if (!l) return
  if (l.length >= QUIZ_MAX) { alert(t('courseQuizMaxQ')); return }
  l.push({ type: 'single', question: '', options: ['', '', '', ''], answer: [0], explanation: '' })
  courseQuizRenderList(prefix, l)
}

// 收集并校验小测题：strict=true（发布/保存）不完整行报错阻断；
// strict=false（草稿）静默丢弃不完整行。空选项剔除后正确答案索引同步重映射。
// 返回 { ok, quiz }（ok=false 表示已 alert，调用方直接 return）
function courseQuizCollect(prefix, list, strict) {
  const out = []
  const rows = list || []
  for (let i = 0; i < rows.length; i++) {
    const q = rows[i]
    const question = String(q.question || '').trim()
    const rawOpts = q.options || []
    const keep = [], map = []
    rawOpts.forEach((o, idx) => {
      const s = String(o || '').trim()
      if (s) { map[idx] = keep.length; keep.push(s) }
    })
    const ansRaw = (q.answer || [])[0]
    const touched = question || keep.length
    if (!touched) continue   // 整行空白：跳过
    const valid = question && keep.length >= 2 && ansRaw != null && map[ansRaw] != null
    if (!valid) {
      if (strict === false) continue   // 草稿宽松：丢弃未完成的行
      alert(t('courseQuizInvalid', i + 1))
      return { ok: false, quiz: [] }
    }
    out.push({
      type: q.type === 'listen' ? 'listen' : 'single',
      question, options: keep, answer: [map[ansRaw]],
      explanation: String(q.explanation || '').trim()
    })
    if (out.length >= QUIZ_MAX) break
  }
  return { ok: true, quiz: out }
}

// 发布作业（status='open'，学员立即可见）或保存为草稿（status='draft'，学员不可见）
async function coursePublishAssign() { return courseSubmitAssign('open') }
async function courseSaveDraftAssign() { return courseSubmitAssign('draft') }

async function courseSubmitAssign(status) {
  const cid = courseDraft.cid
  const type = document.getElementById('caType').value
  const title = document.getElementById('caTitle').value.trim()
  const desc = document.getElementById('caDesc').value.trim()
  const deadlineRaw = document.getElementById('caDeadline').value
  const deadline = deadlineRaw ? new Date(deadlineRaw).getTime() : 0
  const duration = type === 'exam' ? (Number(document.getElementById('caDuration').value) || 20) : 0
  const passScore = type === 'exam' ? (Number(document.getElementById('caPass').value) || 60) : 60
  if (!title) { alert(t('courseErrTitle')); return }
  // 截止时间校验：仅发布时检查（草稿可先存，发布/发送时再校验）
  if (status !== 'draft' && deadline && deadline < Date.now()) { alert(t('courseErrDeadline')); return }
  const now = Date.now()
  const commit = async (aid, extra) => {
    try {
      await CourseStore.mutate(doc => {
        const c = CourseStore.findClass(doc, cid)
        if (!c) return false
        c.assignments = c.assignments || []
        if (c.assignments.some(a => a.id === aid)) return false   // 幂等：重试不重复
        c.assignments.push(Object.assign({
          id: aid, type, title, desc, deadline, duration, passScore,
          createdAt: now, results: {}
        }, status === 'draft' ? { status: 'draft' } : null, extra || {}))
      })
    } catch (e) { alert(t('courseWriteFail')); throw e }
  }
  try {
    if (type === 'video') {
      // 视频任务：视频链接 + 选填课后小测；草稿保存时链接可为空，发布/发送时必填
      const videoUrl = (document.getElementById('caVideoUrl').value || '').trim()
      if (status !== 'draft' && !videoUrl) { alert(t('courseErrVideoUrl')); return }
      // v44：收集小测题（发布严格校验；草稿宽松，未完成的行静默丢弃）
      const qr = courseQuizCollect('ca', courseDraft.quiz || [], status !== 'draft')
      if (!qr.ok) return
      const extra = { videoUrl }
      if (qr.quiz.length) extra.quiz = qr.quiz
      await commit(CourseStore.newId('a'), extra)
    } else {
      const questions = courseDraft.preview.filter(x => x.checked).map(x => {
        const q = x.q
        return { type: q.type, difficulty: q.difficulty || 1, question: q.question, options: q.options, answer: q.answer, explanation: q.explanation || '' }
      })
      // 草稿允许暂缺题目（稍后编辑补充）；发布时必须有题
      if (status !== 'draft' && !questions.length) { alert(t('courseErrNoQ')); return }
      await commit(CourseStore.newId('a'), { questions })
    }
  } catch (e) { return }
  courseModalClose()
  courseDraft = null
  alert(status === 'draft' ? t('courseDraftOk') : t('coursePublishOk'))
  courseState.doc = await CourseStore.getDoc()
  try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
  courseOpenClass(cid)
}

// ================================================================
// 编辑已发布作业（修改题目、答案、选项等）
// ================================================================
let courseEditAssign = null   // { cid, aid, questions:[], meta:{} }

function courseEditAssignModal(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a) return
  // 深拷贝题目，避免直接修改原数据
  courseEditAssign = {
    cid, aid,
    meta: {
      type: a.type || 'homework',
      title: a.title || '',
      desc: a.desc || '',
      deadline: a.deadline || 0,
      duration: a.duration || 0,
      passScore: a.passScore || 60
    },
    questions: (a.questions || []).map(q => ({
      type: q.type,
      difficulty: q.difficulty || 1,
      question: q.question || '',
      options: (q.options || []).slice(),
      answer: (q.answer || []).slice(),
      explanation: q.explanation || ''
    }))
  }
  courseRenderEditModal()
}

function courseRenderEditModal() {
  const m = courseEditAssign
  if (!m) return
  const typeOpts = ['single', 'multiple', 'judge', 'fill', 'translate', 'pronounce', 'listen', 'voicematch']
    .map(v => `<option value="${v}">${TYPE_LABELS[v] || v}</option>`).join('')

  const deadlineStr = m.meta.deadline
    ? new Date(m.meta.deadline).toISOString().slice(0, 16)
    : ''

  const qCards = m.questions.map((q, i) => courseRenderEditQCard(q, i)).join('')

  courseModalOpen(t('courseEditTitle'), `
    <h4 style="margin:0 0 8px;color:#374151">${t('courseEditMeta')}</h4>
    <div class="form-row2">
      <div class="form-group"><label>${t('courseTypeLabel')} *</label>
        <select id="ceType">${typeOpts}</select></div>
      <div class="form-group"><label>${t('courseTitlePh')} *</label>
        <input type="text" id="ceTitle" value="${escAttr(m.meta.title)}" /></div>
    </div>
    <div class="form-group"><label>${t('courseDescPh')}</label>
      <input type="text" id="ceDesc" value="${escAttr(m.meta.desc)}" /></div>
    <div class="form-row2">
      <div class="form-group"><label>${t('courseDeadlineLabel')}</label>
        <input type="datetime-local" id="ceDeadline" value="${deadlineStr}" /></div>
      <div class="form-group" id="ceExamOnly"><label>${t('courseDurationLabel')}</label>
        <input type="number" id="ceDuration" min="1" max="180" value="${m.meta.duration || 20}" /></div>
    </div>
    <div class="form-group" id="cePassGroup"><label>${t('coursePassLabel')}</label>
      <input type="number" id="cePass" min="0" max="100" value="${m.meta.passScore || 60}" /></div>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />
    <h4 style="margin:0 0 8px;color:#374151">${t('courseEditQuestions')}</h4>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn btn-ghost btn-sm" onclick="courseEditAiToggle()">🧠 ${t('courseEditAiOpen')}</button>
    </div>
    <div id="ceAiBox" style="display:none;margin-bottom:12px;padding:12px;border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc">
      <div class="form-group"><label>${t('courseFileLabel')}</label>
        <input type="file" id="ceAiFile" accept=".docx,.pptx,.pdf,.txt,.md" multiple />
        <p class="form-hint" style="margin-top:4px">${t('courseMultiFileHint')}</p></div>
      <div class="form-row2">
        <div class="form-group"><label>${t('courseGenTotal')}</label>
          <input type="number" id="ceAiTotal" min="1" max="60" value="10" /></div>
        <div class="form-group"><label>${t('courseRatioLabel')}</label>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <span class="ratio-field">${t('courseRatioSingle')}<input type="number" id="ceAiPctSingle" min="0" max="100" placeholder="—" /></span>
            <span class="ratio-field">${t('courseRatioJudge')}<input type="number" id="ceAiPctJudge" min="0" max="100" placeholder="—" /></span>
            <span class="ratio-field">${t('courseRatioListen')}<input type="number" id="ceAiPctListen" min="0" max="100" placeholder="—" /></span>
            <span class="ratio-field">${t('courseRatioVoice')}<input type="number" id="ceAiPctVoicematch" min="0" max="100" placeholder="—" /></span>
          </div></div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="courseEditAiGen()">🧠 ${t('courseEditAiGen')}</button>
      <span id="ceAiStatus" style="font-size:12px;color:#6b7280;margin-left:8px"></span>
    </div>
    <div id="ceQList">${qCards}</div>
    <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="courseEditAddQ()">${t('courseEditAddQ')}</button>
  `,
    `<button class="btn btn-primary" onclick="courseSaveAssignEdit()">${t('courseEditSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)

  // 设置 select 值
  const typeSel = document.getElementById('ceType')
  if (typeSel) {
    typeSel.value = m.meta.type
    typeSel.onchange = () => { courseEditAssign.meta.type = typeSel.value; courseEditToggleExamFields() }
  }
  courseEditToggleExamFields()
}

function courseEditToggleExamFields() {
  const type = courseEditAssign.meta.type
  const dur = document.getElementById('ceExamOnly')
  const pass = document.getElementById('cePassGroup')
  if (dur) dur.style.display = type === 'exam' ? '' : 'none'
  if (pass) pass.style.display = type === 'exam' ? '' : 'none'
}

function courseRenderEditQCard(q, i) {
  const typeOpts = ['single', 'multiple', 'judge', 'fill', 'translate', 'pronounce', 'listen', 'voicematch']
    .map(v => `<option value="${v}" ${v === q.type ? 'selected' : ''}>${TYPE_LABELS[v] || v}</option>`).join('')

  let optsHtml = ''
  if (q.type === 'fill' || q.type === 'translate') {
    // 填空/翻译：正确答案就是 options[0] 的文本
    optsHtml = `<div class="ce-opt-row">
      <span style="font-weight:600;color:#059669">✓ ${t('courseEditCorrect')}</span>
      <input type="text" class="input-answer" value="${escAttr(q.options[0] || '')}"
        oninput="courseEditOptChange(${i},0,this.value)" style="flex:1" />
    </div>`
  } else if (q.type === 'judge') {
    // 判断题：固定 2 选项
    optsHtml = [0, 1].map(idx => {
      const optText = q.options[idx] !== undefined ? q.options[idx] : (idx === 0 ? (LANG === 'en' ? 'True' : '正确') : (LANG === 'en' ? 'False' : '错误'))
      const isCorrect = q.answer.includes(idx)
      return `<div class="ce-opt-row">
        <label class="ce-correct-pick">
          <input type="radio" name="ceAns${i}" ${isCorrect ? 'checked' : ''} onchange="courseEditSetAnswer(${i},[${idx}])" />
          <span style="font-weight:${isCorrect ? '700;color:#059669' : '#6b7280'}">✓</span>
        </label>
        <input type="text" class="input-answer" value="${escAttr(optText)}"
          oninput="courseEditOptChange(${i},${idx},this.value)" style="flex:1" />
      </div>`
    }).join('')
  } else {
    // 单选/多选：列表选项 + 正确标记
    optsHtml = q.options.map((opt, idx) => {
      const isCorrect = q.answer.includes(idx)
      const inputType = q.type === 'multiple' ? 'checkbox' : 'radio'
      const name = `ceAns${i}`
      const changeHandler = q.type === 'multiple'
        ? `courseEditToggleMulti(${i},${idx},this.checked)`
        : `courseEditSetAnswer(${i},[${idx}])`
      return `<div class="ce-opt-row">
        <label class="ce-correct-pick">
          <input type="${inputType}" name="${name}" ${isCorrect ? 'checked' : ''} onchange="${changeHandler}" />
          <span style="font-weight:${isCorrect ? '700;color:#059669' : '#6b7280'}">${isCorrect ? '✓' : LETTERS[idx]}</span>
        </label>
        <input type="text" class="input-answer" value="${escAttr(opt)}"
          oninput="courseEditOptChange(${i},${idx},this.value)" style="flex:1" />
        ${q.options.length > 2 ? `<button class="btn btn-ghost btn-sm" onclick="courseEditDelOpt(${i},${idx})">${t('courseEditDelOpt')}</button>` : ''}
      </div>`
    }).join('')
    optsHtml += `<button class="btn btn-ghost btn-sm" onclick="courseEditAddOpt(${i})">${t('courseEditAddOpt')}</button>`
  }

  return `<div class="card ce-q-card" data-qidx="${i}">
    <div class="ce-q-head">
      <span class="ce-q-num">${i + 1}</span>
      <select class="ce-q-type" onchange="courseEditQTypeChange(${i},this.value)">${typeOpts}</select>
      <span style="flex:1"></span>
      <button class="btn btn-danger btn-sm" onclick="courseEditDelQ(${i})">${t('courseEditDelQ')}</button>
    </div>
    <div class="form-group"><label>${t('courseEditQText')}</label>
      <textarea rows="2" class="input-answer" oninput="courseEditQTextChange(${i},this.value)">${escHtml(q.question)}</textarea>
    </div>
    <div class="form-group"><label>${t('courseEditQOptions')}</label>
      <div class="ce-opt-list">${optsHtml}</div>
    </div>
    <div class="form-group"><label>${t('courseEditQExplain')}</label>
      <textarea rows="1" class="input-answer" oninput="courseEditQExplainChange(${i},this.value)">${escHtml(q.explanation)}</textarea>
    </div>
  </div>`
}

function courseEditReRender() {
  const list = document.getElementById('ceQList')
  if (list) list.innerHTML = courseEditAssign.questions.map((q, i) => courseRenderEditQCard(q, i)).join('')
}

function courseEditQTypeChange(i, type) {
  const q = courseEditAssign.questions[i]
  if (!q) return
  q.type = type
  // 类型切换时调整 options 和 answer
  if (type === 'judge') {
    q.options = [
      q.options[0] !== undefined ? q.options[0] : (LANG === 'en' ? 'True' : '正确'),
      q.options[1] !== undefined ? q.options[1] : (LANG === 'en' ? 'False' : '错误')
    ]
    q.answer = [q.answer[0] !== undefined ? q.answer[0] : 0]
  } else if (type === 'fill' || type === 'translate') {
    if (!q.options.length) q.options = ['']
    q.answer = [0]
  } else {
    // single/multiple: 确保至少 2 个选项
    if (q.options.length < 2) q.options = q.options.concat(['', '']).slice(0, 2)
    q.answer = q.answer.length ? q.answer : [0]
  }
  courseEditReRender()
}

function courseEditQTextChange(i, v) { if (courseEditAssign.questions[i]) courseEditAssign.questions[i].question = v }
function courseEditQExplainChange(i, v) { if (courseEditAssign.questions[i]) courseEditAssign.questions[i].explanation = v }
function courseEditOptChange(i, idx, v) { if (courseEditAssign.questions[i]) courseEditAssign.questions[i].options[idx] = v }

function courseEditSetAnswer(i, arr) {
  if (courseEditAssign.questions[i]) courseEditAssign.questions[i].answer = arr
  courseEditReRender()
}

function courseEditToggleMulti(i, idx, checked) {
  const q = courseEditAssign.questions[i]
  if (!q) return
  if (checked) { if (!q.answer.includes(idx)) q.answer.push(idx) }
  else { q.answer = q.answer.filter(x => x !== idx) }
  // 更新标记样式
  const card = document.querySelector(`.ce-q-card[data-qidx="${i}"]`)
  if (card) {
    card.querySelectorAll('.ce-opt-row').forEach((row, ri) => {
      const span = row.querySelector('.ce-correct-pick span')
      if (span) {
        const isCorrect = q.answer.includes(ri)
        span.style.fontWeight = isCorrect ? '700' : ''
        span.style.color = isCorrect ? '#059669' : '#6b7280'
        span.textContent = isCorrect ? '✓' : (LETTERS[ri] || ri)
      }
    })
  }
}

function courseEditAddOpt(i) {
  const q = courseEditAssign.questions[i]
  if (!q) return
  q.options.push('')
  courseEditReRender()
}

function courseEditDelOpt(i, idx) {
  const q = courseEditAssign.questions[i]
  if (!q) return
  q.options.splice(idx, 1)
  // 修正 answer 索引
  q.answer = q.answer
    .filter(a => a < q.options.length)
    .map(a => a > idx ? a - 1 : a)
  if (!q.answer.length) q.answer = [0]
  courseEditReRender()
}

function courseEditAddQ() {
  courseEditAssign.questions.push({
    type: 'single', difficulty: 1, question: '', options: ['', ''], answer: [0], explanation: ''
  })
  courseEditReRender()
  // 滚动到新题目
  const list = document.getElementById('ceQList')
  if (list) {
    const last = list.lastElementChild
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function courseEditDelQ(i) {
  if (courseEditAssign.questions.length <= 1) { alert(t('courseEditNoQ')); return }
  courseEditAssign.questions.splice(i, 1)
  courseEditReRender()
}

// 编辑弹窗：AI 从文件生成（展开/收起）
function courseEditAiToggle() {
  const box = document.getElementById('ceAiBox')
  if (box) box.style.display = box.style.display === 'none' ? '' : 'none'
}

// 编辑弹窗：从所选文件（可多选）生成题目并追加到当前题目列表（按题干去重）
async function courseEditAiGen() {
  const m = courseEditAssign
  if (!m) return
  const input = document.getElementById('ceAiFile')
  const files = coursePickFiles(input)
  if (!files.length) { alert(t('courseErrNoFile')); return }
  const statusEl = document.getElementById('ceAiStatus')
  if (statusEl) statusEl.textContent = t('courseGenWorking')
  try {
    const merged = await courseMergeFileTexts(files)
    if (!String(merged.text || '').trim()) {
      if (statusEl) statusEl.textContent = merged.errs.length
        ? merged.errs.map(e => escHtml(e.name) + '：' + escHtml(e.msg)).join('；')
        : t('courseGenEmpty')
      return
    }
    const inp = courseReadGenInputs('ceAiTotal', 'ceAi')
    if (!inp) return
    const result = QGen.generate(merged.text, inp.opt)
    const fresh = result.questions
    if (!fresh.length) { if (statusEl) statusEl.textContent = t('courseGenEmpty'); return }
    const r = courseAppendFresh(m.questions, fresh)
    courseEditReRender()
    if (statusEl) {
      const warn = merged.errs.length ? ' ' + t('courseGenPartial', merged.errs.map(e => e.name).join('、')) : ''
      statusEl.textContent = t('courseEditAiOk', r.added, r.skipped) + warn
    }
    const list = document.getElementById('ceQList')
    if (list && list.lastElementChild) list.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } catch (e) {
    if (statusEl) statusEl.textContent = (e && e.message) || t('courseGenFail')
  }
}

async function courseSaveAssignEdit() {
  const m = courseEditAssign
  if (!m) return
  // 读取元信息
  const type = document.getElementById('ceType').value
  const title = document.getElementById('ceTitle').value.trim()
  const desc = document.getElementById('ceDesc').value.trim()
  const deadlineRaw = document.getElementById('ceDeadline').value
  const deadline = deadlineRaw ? new Date(deadlineRaw).getTime() : 0
  const duration = type === 'exam' ? (Number(document.getElementById('ceDuration').value) || 20) : 0
  const passScore = type === 'exam' ? (Number(document.getElementById('cePass').value) || 60) : 60
  if (!title) { alert(t('courseErrTitle')); return }
  // 验证题目：至少 1 道有效题
  const questions = m.questions.map(q => {
    // 清理空选项
    const options = (q.type === 'fill' || q.type === 'translate')
      ? [String(q.options[0] || '').trim()].filter(Boolean)
      : q.options.map(o => String(o || '').trim()).filter(Boolean)
    return {
      type: q.type,
      difficulty: q.difficulty || 1,
      question: String(q.question || '').trim(),
      options,
      answer: (q.answer || []).filter(a => a >= 0 && a < options.length),
      explanation: String(q.explanation || '').trim()
    }
  }).filter(q => q.question && q.options.length >= (q.type === 'judge' ? 2 : 1) && q.answer.length >= 1)
  if (!questions.length) { alert(t('courseEditNoQ')); return }
  if (!confirm(t('courseEditConfirm'))) return

  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, m.cid)
      const a = CourseStore.findAssign(c, m.aid)
      if (!a) return false
      a.type = type
      a.title = title
      a.desc = desc
      a.deadline = deadline
      a.duration = duration
      a.passScore = passScore
      a.questions = questions
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  courseEditAssign = null
  alert(t('courseEditSaveOk'))
  courseState.doc = await CourseStore.getDoc()
  try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
  courseRenderClass()
}

// v44：编辑已发布视频作业的课后小测（读音题/选择题，最多 10 题）
let courseEditQuiz = null   // { cid, aid, quiz:[] }

function courseEditQuizModal(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a || a.type !== 'video') return
  courseEditQuiz = {
    cid, aid,
    quiz: (a.quiz || []).map(q => ({
      type: q.type === 'listen' ? 'listen' : 'single',
      question: q.question || '',
      options: (q.options || []).slice(),
      answer: (q.answer || []).slice(),
      explanation: q.explanation || ''
    }))
  }
  courseModalOpen(t('courseEditQuizTitle'), `
    <p class="form-hint" style="margin:0 0 10px">${t('courseQuizBuilderHint')}</p>
    <div id="ceqQuizList"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:4px" onclick="courseQuizAddQ('ceq')">${t('courseQuizAddQ')}</button>
  `,
    `<button class="btn btn-primary" onclick="courseQuizSaveEdit()">${t('courseEditSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
  courseQuizRenderList('ceq', courseEditQuiz.quiz)
}

async function courseQuizSaveEdit() {
  const m = courseEditQuiz
  if (!m) return
  const qr = courseQuizCollect('ceq', m.quiz, true)
  if (!qr.ok) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, m.cid)
      const a = CourseStore.findAssign(c, m.aid)
      if (!a || a.type !== 'video') return false
      if (qr.quiz.length) a.quiz = qr.quiz
      else delete a.quiz
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  courseEditQuiz = null
  alert(t('courseQuizSaved'))
  courseState.doc = await CourseStore.getDoc()
  try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
  courseRenderClass()
}

// 修改已发布视频作业的播放地址
function courseEditVideoUrlModal(cid, aid) {
  const a = courseFindAssign(cid, aid)
  if (!a || a.type !== 'video') return
  const cur = a.videoUrl || ''
  courseModalOpen(t('courseEditVideoUrlTitle'), `
    <div class="form-group"><label>${t('courseVideoUrlCurrent')}</label>
      <p style="font-size:13px;color:#6b7280;word-break:break-all;background:#f3f4f6;border-radius:6px;padding:8px 10px;margin-bottom:12px">${escHtml(cur) || t('courseVideoNoUrl')}</p></div>
    <div class="form-group"><label>${t('courseVideoUrlLabel')} *</label>
      <input type="text" id="cevVideoUrl" placeholder="${t('courseVideoUrlPh')}" value="${escAttr(cur)}" /></div>
  `,
    `<button class="btn btn-primary" onclick="courseSaveVideoUrl('${escAttr(cid)}','${escAttr(aid)}')">${t('courseEditSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseSaveVideoUrl(cid, aid) {
  const videoUrl = (document.getElementById('cevVideoUrl').value || '').trim()
  if (!videoUrl) { alert(t('courseErrVideoUrl')); return }
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a || a.type !== 'video') return false
      a.videoUrl = videoUrl
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseVideoUrlSaved'))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// ================================================================
// 通用弹窗
// ================================================================
function courseModalOpen(title, bodyHtml, footerHtml) {
  courseModalClose()
  const overlay = document.createElement('div')
  overlay.id = 'courseModal'
  overlay.className = 'modal-overlay'
  overlay.style.display = 'flex'
  overlay.innerHTML = `
    <div class="modal modal-wide">
      <div class="modal-header"><h3>${title}</h3><span class="modal-close" onclick="courseModalClose()">✕</span></div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div>`
  document.body.appendChild(overlay)
}
function courseModalClose() { const m = document.getElementById('courseModal'); if (m) m.remove() }
