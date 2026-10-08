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
// v123：任务类型的中文/英文短标签（大纲行第二行小字）
function courseTaskKindLabel(a) {
  if (!a) return ''
  if (a.type === 'offline') return t('courseTypeOffline')
  if (a.type === 'video') return t('courseTypeVideo')
  if (a.type === 'coursefinal') return t('courseTypeCourseFinal')
  if (a.type === 'exam') return t('courseTypeExam')
  return t('courseTypeHomework')
}

// v123：大纲行副标题 = 「类型 · 题数 / 上课时间 / 时长」按类型取值
function courseTaskMetaText(a) {
  const kind = courseTaskKindLabel(a)
  if (courseIsOffline(a)) return `${kind} · ${courseOfflineWhen(a)}`
  if (a.type === 'video') {
    const qn = (a.quiz && a.quiz.length) ? ` · ${t('courseQuizCount', a.quiz.length)}` : ''
    return `${kind} · ${t('courseVideoLabel')}${qn}`
  }
  const qn = (a.questions || []).length
  const dur = (a.type === 'exam' || courseIsFinal(a)) && a.duration ? ` · ${a.duration}${LANG === 'en' ? ' min' : ' 分钟'}` : ''
  return `${kind} · ${t('courseProgressQN', qn)}${dur}`
}

// v129：章节整体改名 —— 一章可能包含多个作业，逐个改太麻烦，故支持按章节名批量改。
//   语义：把所有 chapter === oldName 的作业统一改成 newName（空 = 清除章节归属）。
function courseChapterRenameModal(cid, oldName) {
  const c = courseFind(cid)
  if (!c) return
  const st = courseChapterStat(c.assignments, null, oldName)
  courseModalOpen(t('courseChapterRenameTitle'), `
    <div class="form-group"><label>${t('courseChapterCurrent')}</label>
      <p style="font-size:13px;color:#374151;background:#f3f4f6;border-radius:6px;padding:8px 10px;margin-bottom:12px">📚 ${escHtml(oldName)} <span style="color:#6b7280">· ${t('courseChapterItemCount', st.total)}</span></p></div>
    <div class="form-group"><label>${t('courseChapterNewName')}</label>
      <input type="text" id="ccrNewName" value="${escAttr(oldName)}" /></div>
    <p class="form-hint" style="margin:4px 0 0">${t('courseChapterRenameHint')}</p>
  `,
    `<button class="btn btn-primary" onclick="courseChapterRenameDo('${escAttr(cid)}','${escAttr(oldName)}')">${t('courseEditSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseChapterRenameDo(cid, oldName) {
  const el = document.getElementById('ccrNewName')
  const next = (el ? el.value : '').trim()
  if (next === oldName) { courseModalClose(); return }
  if (!confirm(t('courseChapterRenameConfirm', oldName, next || t('courseChapterNoneShort')))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      ;(c.assignments || []).forEach(a => {
        if (String(a.chapter == null ? '' : a.chapter).trim() !== oldName) return
        if (next) a.chapter = next
        else delete a.chapter
      })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseChapterRenamed'))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// v129：统计某章节内（同名连续区间）某学员的完成度 —— 只用于分节头的「x / y」小字
function courseChapterStat(assigns, me, chName) {
  let done = 0, total = 0
  ;(assigns || []).forEach(a => {
    if (String(a.chapter == null ? '' : a.chapter).trim() !== chName) return
    total++
    if (courseTaskDone(a, (a.results || {})[me])) done++
  })
  return { done, total }
}

// ================================================================
// v134：章节开关（管理端）
// ================================================================
// 分节行右侧的「开放 / 关闭」切换按钮。
// ★ 不把章节名拼进 onclick 的 JS 字面量 —— 章节名是用户自由输入，含引号/反斜杠就会
//   截断 inline 属性（v85 老坑）。改用 data-ch 传值 + onclick="...(this)" 读 dataset。
// ★ 「未分章」组用空串键，data-ch="" 依然可读（dataset 拿到空串，不会被当成 undefined：
//   value 为空串时 dataset 返回 ''，与「属性不存在」的 undefined 可区分，但为稳妥
//   这里统一按 '' 处理，见 courseChapterToggleDo）。
function courseChapterToggleBtn(cid, chName) {
  const open = courseChapterOpened(courseFind(cid), chName)
  return `<button class="btn btn-sm chapter-sep-btn chapter-sep-toggle${open ? ' open' : ' locked'}"
    data-cid="${escAttr(cid)}" data-ch="${escAttr(chName)}"
    onclick="courseChapterToggle(this)"
    title="${escAttr(open ? t('courseChapterCloseHint') : t('courseChapterOpenHint'))}">${open ? t('courseChapterOpenTag') : t('courseChapterLockedTag')}</button>`
}

function courseChapterToggle(btn) {
  if (!btn) return
  const cid = btn.getAttribute('data-cid') || ''
  const chName = btn.getAttribute('data-ch') || ''
  courseChapterToggleDo(cid, chName)
}

// 幂等切换：读最新文档 → 取反 → 读改写 + 写后校验（CourseStore.mutate 自带）。
// ★ 切换必须写明确的 true/false，**不能删键** —— 删键会让该章在下次存量迁移时
//   被当成「存量章节」重新开放（关了又自己开）。
async function courseChapterToggleDo(cid, chName) {
  const key = CourseStore.chKey(chName)
  const c0 = courseFind(cid)
  if (!c0) return
  const nextOpen = !courseChapterOpened(c0, key)
  const label = key || t('courseChapterNone')
  if (!confirm(t(nextOpen ? 'courseChapterOpenConfirm' : 'courseChapterCloseConfirm',
    label, (c0.name || '')))) return
  try {
    const r = await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      // 幂等保护：并发下另一个人已经切成同一个值 → 直接判为「无需写入」
      const cur = courseChapterOpened(c, key)
      c.chInit = true            // 兜底：这次操作本身就完成了初始化
      c.chOpen = c.chOpen || {}
      if (cur === nextOpen) return false
      c.chOpen[key] = nextOpen
    })
    if (r === null) { /* 幂等短路：值已一致，按成功处理 */ }
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  alert(t(nextOpen ? 'courseChapterOpened' : 'courseChapterClosed', label))
  courseRenderClass()
}

// v134：章节开放态读取的**唯一收口**（学员端与管理端共用）。
// ★ 用「防御式访问」而不是在调用点直接 CourseStore.chOpen(...)：
//   ① 历史测试套件大量注入**精简版 CourseStore 桩**（只有 mutate/findClass 等），
//      直接调用会让整个页面渲染抛错（一条缺失方法炸掉整页，而不是优雅降级）；
//   ② 生产环境里若 course-store.js 因缓存未更新而落后一版，同样会白屏。
//   故这里按「拿不到判定能力 → 视为已开放（fail-open）」处理：
//   宁可多显示一点内容（管理员仍能在管理端看到真实状态），也不要让学员端白屏。
//   ★ 注意 fail-open 与业务口径「默认关闭」不矛盾：业务默认关闭由数据层落地
//     （无 chInit 的存量班回填为开放、新建班打 chInit 后新章节本就不在 map 里），
//     这里只兜「判定函数本身不存在」这种异常态。
function courseChapterOpened(cls, chName) {
  try {
    if (typeof CourseStore === 'undefined' || !CourseStore ||
        typeof CourseStore.chOpen !== 'function') return true
    return CourseStore.chOpen(cls, chName) === true
  } catch (e) { return true }
}

// 学员「我的学习进度」：v123 参照课程平台分栏布局 ——
// 电脑端（≥900px）左侧大纲（任务序列行）+ 右侧详情（进度环 + 下一步 + 去完成）；
// 手机端隐藏右侧详情，仅保留左侧大纲（信息由各行的 cp-meta 小字承载）。
function courseStudentPathHtml(myClasses, me) {
  if (!myClasses || !myClasses.length) return ''
  const blocks = []
  myClasses.forEach(c => {
    const assigns = (c.assignments || []).filter(a => a.status !== 'draft')
    if (!assigns.length) return
    const total = assigns.length
    const doneCount = assigns.reduce((s, a) => s + (courseTaskDone(a, (a.results || {})[me]) ? 1 : 0), 0)
    const pct = Math.round(doneCount / total * 100)
    // v134：进度环与总完成度仍按**全量**计算（章节开关只控制「能不能做」，不改变已完成的事实，
    //   否则管理员一关章学员的百分比就会跳水）。
    const nextIdx = assigns.findIndex(a => !courseTaskDone(a, (a.results || {})[me]))
    // v134：「下一步」必须落在**当前可见**的作业上 —— 否则全关态会提示
    //   「下一步：B1」，而 B1 明明被锁着（学员看到就点，点了被 alert 拦，体验自相矛盾）。
    //   这里独立算一个「可见的下一步」：跳过所有关闭章节内的作业。
    // v148：同理跳过「需放行但尚未放行」的作业 —— 否则未放行的最终考试会被推成
    //   「下一步：终极大考 + 去完成」，学员点下去才弹「需管理员放行」，
    //   主观上就是「不用放行也能参加」（用户实际报的就是这个观感）。
    let visNextIdx = -1
    for (let i = 0; i < total; i++) {
      if (courseTaskDone(assigns[i], (assigns[i].results || {})[me])) continue
      if (!courseChapterOpened(c, assigns[i].chapter) && !courseFinalReleasedBypass(assigns[i], me)) continue
      if (courseGateWaitFor(assigns[i], me, (assigns[i].results || {})[me])) continue
      visNextIdx = i
      break
    }
    let rows = ''
    let lastChapter = null
    let lastPlain = false // v133：当前打开的块是否为「散项」块（决定收尾关一层还是两层）
    let chOpenCur = false // v134：当前所在章节的开放态（跨行沿用，见下方 ★★ 注释）
    for (let i = 0; i < total; i++) {
      const a = assigns[i]
      const d = courseTaskDone(a, (a.results || {})[me])
      // ★ 行内「▶ 进行中」角标只在可见作业上标：被收起的行根本不渲染，nextIdx 落到它身上时
      //   这一章里就不会有任何行被标成下一步（正确 —— 那一步学员此刻做不到）。
      const isNext = i === nextIdx && i === visNextIdx
      const dotTxt = d ? '✓' : (isNext ? '▶' : String(i + 1))
      // v129：章节分块 —— 章节是「一段连续区间」语义（相邻同章的作业自动归为一个分块）。
      //   在章节名发生变化处插入分节头 + 开启一个新的分块容器。
      //   ★ 注意：分块容器与分节头一律不得使用含 'cp-side' 的类名/文案 ——
      //     历史套件 test-v53-review 用 sliceBetween(card,'cp-list','cp-side') 切「左侧大纲行区间」，
      //     若这里出现 'cp-side' 会让切片右边界提前命中，导致该断言静默变空（假绿）。
      const chName = String(a.chapter == null ? '' : a.chapter).trim()
      // v134：章节开关 —— 整章收起 + 锁定态。
      //   ★ 关闭的章节「整章」不渲染作业行（连标题都不给），只留一条锁定章节条，
      //     否则学员能从前排作业的题面反推被锁内容（且「收起」在视觉上也不成立）。
      //   ★ 但**不能整块跳过**：作业行虽不渲染，行序号 i 与「下一步」判定 nextIdx 都必须
      //     仍然把它们算进去（下一章一旦被管理员开放，学员立刻回到正确的那一步）。
      //   ★★ 关键：开放态必须**每行都算一次**并存在变量里跨行沿用，绝不能用
      //      「chName !== lastChapter ? chOpen : undefined」——那样同一章节里第 2 行起
      //      会拿到 undefined，而 `undefined === false` 为假 → 关闭章节的第 2 行起全部漏渲染
      //      （实测：关闭章节里有 2 个作业时只有第 1 个被收起，第 2 个照常显示）。
      const isNewChapter = chName !== lastChapter
      // v150：章节开放态 = 「整章开放」或「本章里有已被放行的最终考试」。
      //   ★ 放行键是最高权限 → 放行后该章节条必须按「已开放」形态渲染（否则章节条写着
      //     「🔒 未开放」而底下的考试行却能点，自相矛盾）。故这里把 chOpenCur 一并放宽。
      //   ★ 注意仍按**章节**粒度算（chOpenCur 在章节内跨行沿用），不逐行抖动 ——
      //     同一章内不同作业的可见性一致，不会出现「第1行显示、第2行被收起」的错位。
      if (isNewChapter) chOpenCur = courseChapterOpened(c, chName) || courseChapterHasReleasedFinal(assigns, me, chName)
      if (isNewChapter) {
        // v133：分组容器（B+C 组合）。收尾时真章节要关两层（body + 容器），散项只关一层。
        if (lastChapter !== null) rows += lastPlain ? '</div>' : '</div></div>'
        if (chName) {
          const chStat = courseChapterStat(assigns, me, chName)
          const pctCh = chStat.total ? Math.round(chStat.done / chStat.total * 100) : 0
          // ★ 容器 .cp-chapter 是吸顶成立的前提：sticky 的活动范围 = 最近父容器，
          //   旧的「头/体平级兄弟」结构会让头钉死在整个列表上不下来。
          //   头部内嵌白底进度条（chStat 驱动，纯展示）。
          // v134：未开放的章节 → 章节条灰化锁定（🔒 + 「未开放」），进度条隐藏
          //   （进度本身属于「被收起的内容」，露出来等于泄露完成度）。
          rows += chOpenCur
            ? `<div class="cp-chapter">
          <div class="cp-chapter-head">
            <span class="cp-chapter-name">📚 ${escHtml(chName)}</span>
            <span class="cp-chapter-bar"><span class="cp-chapter-bar-in" style="width:${pctCh}%"></span></span>
            <span class="cp-chapter-count">${t('courseChapterDoneOf', chStat.done, chStat.total)}</span>
          </div>
          <div class="cp-chapter-body">`
            : `<div class="cp-chapter cp-chapter-closed">
          <div class="cp-chapter-head cp-chapter-head-locked">
            <span class="cp-chapter-name">🔒 ${escHtml(chName)}</span>
            <span class="cp-chapter-count">${t('courseChapterLocked')}</span>
          </div>
          <div class="cp-chapter-body">`
          lastPlain = false
        } else {
          // v134：散项（未分章）组 —— 与真章节同样受开关控，也同样需要一条「章节条」，
          //   否则「未分章」组被关闭时学员完全看不到任何提示（只会觉得作业凭空少了）。
          //   开放态：保持 v133 的低调形态（无头、无吸顶，仅一个体块）。
          //   关闭态：渲染一条锁定条（🔒 未归入章节 · 未开放），体块留空。
          rows += chOpenCur
            ? `<div class="cp-chapter-body cp-chapter-plain">`
            : `<div class="cp-chapter cp-chapter-closed">
          <div class="cp-chapter-head cp-chapter-head-locked">
            <span class="cp-chapter-name">🔒 ${t('courseChapterNone')}</span>
            <span class="cp-chapter-count">${t('courseChapterLocked')}</span>
          </div>
          <div class="cp-chapter-body">`
          lastPlain = chOpenCur
        }
        lastChapter = chName
      }
      // v134：关闭章节内的作业行不渲染（整体收起）。散项组同理受 '' 键控制。
      if (chOpenCur === false) continue
      // v123：行式大纲卡片（左圆点 + 右标题/副标题）。v122 的「相邻双完成连线」随横纵链一起取消——
      // 行式列表用「已完成样式（绿点/绿字）+ 当前项高亮」表达进度，无需连线。
      // v128：每节课升级为独立分格卡片（白底描边 + 左侧状态色条），右侧加状态角标
      // （已完成 / 待完成 / 未开始），对齐 NovoEd 参考版式。外层 cp-node 类名模板保持 v123 原样不破坏。
      const flagCls = d ? ' ok' : (isNext ? ' doing' : '')
      const flagTxt = d ? t('courseDoneTag') : (isNext ? t('coursePending') : t('courseNodeTodo'))
      // v147：重置后待重考 → 角标换成「待重考」（蓝色），与「未开始」区分开。
      //   名额已用完（courseRetryBlocked）→ 显示「重考机会已用完」，让学员知道该找管理员，
      //   而不是一遍遍点进去看同一句 alert。
      const retryRec = courseResetRecSafe(a, me)
      const retryUsed = courseRetryUsedSafe(a, me, (a.results || {})[me])
      const retryCls = (!d && retryRec) ? (retryUsed ? ' flag-stale' : ' flag-reset') : ''
      const retryTxt = (!d && retryRec) ? (retryUsed ? `⚠ ${t('courseRetryUsedShort')}` : `↺ ${t('courseResetPendingTag')}`) : ''
      // v148：需放行但尚未放行 → 显示「🔒 等待管理员放行」，并**去掉点击**。
      //   优先级最高：它既不是「待完成」也不是「重考」（两者都要学员自己去点），
      //   而这一步学员此刻做什么都没用 —— 只能等管理员。
      const gWait = courseGateWaitFor(a, me, (a.results || {})[me])
      const gDot = gWait ? '🔒' : dotTxt
      const gCls = gWait ? ' gated' : ''
      const gFlagCls = gWait ? ' flag-gate' : (retryTxt ? retryCls : flagCls)
      const gFlagTxt = gWait ? t('courseFinalWaitTag') : (retryTxt || flagTxt)
      const gOnclick = gWait ? '' : ` onclick="courseStart('${escAttr(c.id)}','${escAttr(a.id)}')"`
      rows += `<div class="cp-node${d ? ' done' : ''}${isNext ? ' next' : ''}${gCls}"${gOnclick} title="${escAttr(a.title)}">
          <span class="cp-dot">${gDot}</span>
          <span class="cp-info">
            <span class="cp-lbl">${courseTaskIcon(a)} ${escHtml(a.title)}</span>
            <span class="cp-meta">${escHtml(gWait ? t('courseFinalWaitHint') : courseTaskMetaText(a))}</span>
          </span>
          <span class="cp-flag${gFlagCls}">${escHtml(gFlagTxt)}</span>
        </div>`
    }
    // v133：收尾层数与开块逻辑严格配平 —— 真章节块开的是两层（.cp-chapter 容器 + .cp-chapter-body），
    //   散项块只开一层（.cp-chapter-plain）。若这里恒写一层，真章节组会少关一个 </div>，
    //   浏览器会把后续兄弟节点吞进容器里，导致下一章节的吸顶头失去独立活动范围（吸顶失效）。
    if (lastChapter !== null) rows += lastPlain ? '</div>' : '</div></div>'
    // 右侧详情：进度环（SVG）+ 完成数 + 下一步任务与「去完成」入口
    const R = 34, CIRC = 2 * Math.PI * R
    const ringHtml = `<div class="cp-ring">
        <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
          <circle cx="40" cy="40" r="${R}" fill="none" stroke="#e5e7eb" stroke-width="8"></circle>
          <circle cx="40" cy="40" r="${R}" fill="none" stroke="var(--primary)" stroke-width="8" stroke-linecap="round"
            stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${(CIRC * (1 - pct / 100)).toFixed(1)}"
            transform="rotate(-90 40 40)"></circle>
        </svg>
        <span class="cp-ring-txt">${pct}%</span>
      </div>`
    let sideHtml
    if (visNextIdx === -1) {
      // v134：无「可见的下一步」有三种成因，文案必须分开 ——
      //   ① 全部做完了 → 🎉 恭喜
      //   ② 还有未完成的，但都在未开放章节里 → 「等待老师开放」，否则学员会以为自己做完了
      //   ③ v148：只剩「需放行但尚未放行」的考试 → 「等待管理员放行」，
      //      否则会走 ② 的文案说「等待开放章节」，与真相不符（章节明明是开的）。
      const allDone = nextIdx === -1
      const gateWaiting = !allDone && assigns.some(a =>
        !courseTaskDone(a, (a.results || {})[me]) &&
        courseChapterOpened(c, a.chapter) &&
        courseGateWaitFor(a, me, (a.results || {})[me]))
      const tipTxt = allDone ? '🎉 ' + t('courseProgressAllDone')
        : (gateWaiting ? '🔒 ' + t('courseFinalWaitHint') : '🔒 ' + t('courseChapterWaitOpen'))
      sideHtml = `<div class="cp-side">
          ${ringHtml}
          <div class="cp-side-count">${t('courseProgressOf', doneCount, total)}</div>
          <div class="cp-tip${allDone ? ' ok' : ''}">${tipTxt}</div>
        </div>`
    } else {
      const na = assigns[visNextIdx]
      const goBtn = courseIsOffline(na)
        ? `<button class="btn btn-ghost btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(na.id)}')">${t('courseOfflineView')}</button>`
        : `<button class="btn btn-primary btn-sm" onclick="courseStart('${escAttr(c.id)}','${escAttr(na.id)}')">${courseTaskIcon(na)} ${t('courseProgressGo')}</button>`
      sideHtml = `<div class="cp-side">
          ${ringHtml}
          <div class="cp-side-count">${t('courseProgressOf', doneCount, total)}</div>
          <div class="cp-tip">${t('courseProgressNext')}：<strong>${escHtml(na.title)}</strong></div>
          <div class="cp-side-go">${goBtn}</div>
          <div class="cp-side-meta">${escHtml(courseTaskMetaText(na))}</div>
        </div>`
    }
    blocks.push(`
      <div class="card course-path-card">
        <div class="cp-head">
          <span class="course-class-tag">🎓 ${escHtml(c.name)}</span>
          <span class="cp-count">${t('courseProgressOf', doneCount, total)} · ${pct}%</span>
        </div>
        <div class="cp-bar"><div class="cp-bar-in" style="width:${pct}%"></div></div>
        <div class="cp-grid">
          <div class="cp-list">${rows}</div>
          ${sideHtml}
        </div>
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
  // v133 第二项：移除「我的班级」卡片列表 —— 它与上方「我的学习进度」重复展示同一批作业
  //   （卡片有的入口大纲行全都有：courseTaskDone 已覆盖 待回顾/待答题/低完成度，
  //     courseStart 已内置 回顾→视频→线下课→闸门 的完整路由）。
  //   学员首页现在 = 学习进度大纲（唯一作业导航）+ 可加入的班级。
  el.innerHTML = `
    ${Store.isAdmin() ? `<div class="card" style="padding:12px 16px;border-left:4px solid #CDCF2C;margin-bottom:16px;font-size:13px;color:#5F6121;background:#F2F3CE;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="flex:1">${t('courseAdminPreviewBanner')}</span>
      <button class="btn btn-ghost btn-sm" onclick="courseToggleAdminView()">🛠️ ${t('courseSwitchAdminMode')}</button>
    </div>` : ''}
    ${pathHtml}
    ${pendHtml}
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
function courseStart(cid, aid, _recheck) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  if (a.status === 'draft') { alert(t('courseDraftNotOpen')); return }   // 草稿（未发送）不可作答
  const me0 = courseUser()
  // v150：线下课最终考试的「放行键」= 最高权限，压过章节锁。
  //   ★ 用户原话：「我的解锁键作为最高权限 无视是否完成所有章节」。
  //   起因（2026-10-08 实撞）：管理员给 yang 放行了「B+F班的终极大考」，学员端仍点不开 ——
  //     真凶不是放行闸门（放行记录一切正常），而是这场考试挂了 chapter:'Final Episode'，
  //     该章节名是后来新建作业时才第一次出现 → 不在建班时的 chOpen 快照里 → 按 v134
  //     「默认关闭」语义被判锁定。**放行键在章节闸门之前就被拦掉了，管理员无论怎么点都无效。**
  //   ★ 为什么是「闸门之前」而不是「闸门里面加条件」：放行的语义就是「这个人现在可以考」，
  //     它是管理员对个人的直接授权，比「整章开放」（面向全体的批量状态）更具体、更晚生效，
  //     必须优先。放行 + 章节锁同时存在时，若听章节的，管理员就没有任何手段能救这一场。
  //   ★ 只豁免 coursefinal：普通测评的章节锁是老师排课节奏的一部分，不该被放行键绕过。
  //   ★ 「已放行但还没考」才豁免；已考完的人在上面就被 courseExamDoneAlert 接走了。
  const alreadyReleased = courseIsFinal(a) && courseGateOpenedFor(a, me0)
  // v134：章节闸门。学员端大纲行被整章收起后本就点不到，但还有两条路子能摸进来：
  //   ① 作业的直达链接（老师直接把链接发到群里）；
  //   ② 学员本机页面还是「开放」的旧缓存，管理员刚关了章。
  //   故这里必须独立拦一道，且拦在「回顾/视频/线下课/放行闸门」所有分支之前 ——
  //   章节没开放，这一章里的任何入口都不该有反应。
  //   v150 例外：已被逐人放行的最终考试见上（放行键 = 最高权限）。
  if (!courseChapterOpened(c, a.chapter) && !alreadyReleased) {
    alert(t('courseChapterNotOpen', String(a.chapter == null ? '' : a.chapter).trim() || t('courseChapterNone')))
    return
  }
  const me = courseUser()
  const res = (a.results || {})[me]
  // 线下课：线下授课，无作答 → 展示课程信息
  if (courseIsOffline(a)) { return courseOfflineInfoModal(cid, aid) }
  // 视频任务：走视频播放页
  if (a.type === 'video') { return courseStartVideo(cid, aid) }
  // v53：作业/测评有错题待回顾 → 直接进回顾（直到全对才算完成；成绩保留首次）
  if (res && (a.type === 'homework' || a.type === 'exam' || courseIsFinal(a)) && courseReviewPending(a, res)) {
    return courseReviewStart(cid, aid)
  }
  // 限考一次：最终考试沿用「已作答不可再进」；普通测评文案不同
  if (courseIsFinal(a) && res) { alert(t('courseExamDoneAlert')); return }
  if (a.type === 'exam' && res) { alert(t('courseExamDoneAlert')); return }
  // v147：重置后只允许重考一次 —— 台账里的重置已被上一轮交卷消耗掉，且当前又没有成绩
  //   → 视为「已用掉重考机会」，不再开放作答。
  //   ★ 必须排在下面 courseGateLocked 之前：否则会被闸门拦下并提示「等待老师放行」，
  //     而真相是「重考机会已用完」，两句话对不上的话管理员会一直去点放行（无效操作）。
  if (courseRetryBlocked(a, me, res)) { alert(t('courseRetryUsed')); return }
  // v115 期末考试放行闸门 / v120 线下课最终考试放行闸门：
  // 闸门开启（最终考试恒开）时，学员须被管理员逐人放行后才能作答。
  // 走到此处 res 必为空（有成绩的已在上方被「仅可作答一次」/回顾分支接走）。
  if (courseGateLocked(a, me, res)) {
    if (_recheck) { alert(courseIsFinal(a) ? t('courseFinalWait') : t('courseExamGateWait')); return }
    courseGateRecheck(cid, aid)   // 先重拉一次云端：管理员可能刚放行，本机还是旧缓存
    return
  }
  const startConfirmKey = courseIsFinal(a) ? 'courseFinalStartConfirm' : 'courseExamStartConfirm'
  if ((a.type === 'exam' || courseIsFinal(a)) && !confirm(t(startConfirmKey, a.title))) return
  const isFinal = courseIsFinal(a)
  // v51：给每题标 _oi（assignment 内原下标），逐题错题明细按原题序记录
  const questions = (a.questions || []).map((q, i) => ({ ...q, _oi: i }))
    .sort(() => Math.random() - 0.5)
    .map(q => { const s = shuffleOptions(q); return { ...s, _cat: q.category_id, _oi: q._oi } })
  courseQuiz = {
    phase: 'quiz', cid, aid, type: a.type, title: a.title,
    questions, index: 0, answers: [], submitted: false, correct: 0,
    startAt: Date.now(),
    endAt: (a.type === 'exam' || isFinal) && a.duration ? Date.now() + a.duration * 60000 : null,
    passScore: a.passScore || 60
  }
  if (courseQuiz.endAt) courseStartTimer()
  // 防作弊（v39 起作业+测评均启用）：禁止切屏，v59 起超 2 次强制结束本次作答
  // 强制结束 → courseForceTerminate：不计成绩、不计作答次数（不写 results/attempts/history），
  // 学员可重新开始作答（切屏计数重新累计）
  if ((a.type === 'exam' || a.type === 'homework' || isFinal) && typeof AntiCheat !== 'undefined') {
    AntiCheat.start({
      maxViolations: 2,
      finalKey: 'anticheatTerminate',
      onSubmit: function () { courseForceTerminate() },
    })
  }
  courseRenderTake()
}

// v115/v120：闸门拦截后先重拉云端文档再判定一次（单次重试）——
// 防「管理员刚放行、学员本机 courseState.doc 还是旧缓存」的误拦
async function courseGateRecheck(cid, aid) {
  try { courseState.doc = await CourseStore.getDoc() } catch (e) {}
  const a = courseFindAssign(cid, aid)
  if (a && courseGateOpenedFor(a, courseUser())) {
    return courseStart(cid, aid, true)
  }
  alert(courseIsFinal(a) ? t('courseFinalWait') : t('courseExamGateWait'))
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

// v120：作业类型（assignment type）的显示文案。与 TYPE_LABELS（题型 label）区分开，
// 之前各处的「类型文案」是散落的三元表达式，新增类型要改 8 处；此处收口一张表。
function courseAssignTypeLabel(type) {
  switch (type) {
    case 'video': return t('courseTypeVideo')
    case 'coursefinal': return t('courseTypeCourseFinal')
    case 'exam': return t('courseTypeExam')
    case 'offline': return t('courseTypeOffline')
    default: return t('courseTypeHomework')
  }
}
// 兼容「编辑弹窗的类型下拉」用法：ASSIGN_TYPE_LABELS[v]
const ASSIGN_TYPE_LABELS = new Proxy({}, { get: (_, k) => courseAssignTypeLabel(k) })

// v120：线下课最终考试（type:'coursefinal'）—— 与普通测评（exam）的区别：
//   ① 闸门强制：放行名单 courseFinalOpened（沿用 v115 examOpened 同型），未放行不得作答；
//   ② 只能考一次：放行后交卷即完成，不提供重考入口（看板/卡片均不显示「重新作答」）。
// 本题型不需要 examGate 开关（闸门是它的定义性特征），故直接内置，不给管理员关掉的机会。
function courseIsFinal(a) { return !!(a && a.type === 'coursefinal') }
// 是否「需要逐人放行」：普通测评看 examGate 开关；最终考试恒需放行
function courseGateRequired(a) {
  if (!a) return false
  return courseIsFinal(a) || (a.type === 'exam' && !!a.examGate)
}
// 是否「已被放行」（读各自独立的放行名单，互不干扰）
function courseGateOpenedFor(a, u) {
  if (!a) return false
  const map = courseIsFinal(a) ? a.courseFinalOpened : a.examOpened
  return !!(map && map[u])
}
// 是否「限考一次」：最终考试恒是；普通测评本就是一次（v53 的「仅可作答一次」）
function courseOnceOnly(a) { return courseIsFinal(a) || (!!a && a.type === 'exam') }
// 闸门开启后但尚未放行
function courseGateLocked(a, u, res) {
  return courseGateRequired(a) && !res && !courseGateOpenedFor(a, u)
}

// v148：学员端「等待放行」判定（渲染专用，自包含失败方向 —— 读不到就当没闸门）。
//   ⚠️ 与 courseGateLocked 的区别：这是**展示**口径，必须能在渲染链里安全调用。
//   历史套件的沙箱按名字逐个注入函数，新建函数不在其列表里 → 故此处不调用
//   courseGateRequired / courseGateOpenedFor 之外的任何东西，且整体 try/catch。
//   失效方向：取不到 → 返回 false（= 不显示锁条、按旧样式渲染），绝不因判定异常
//   把学员的整个学习进度页判成「全锁」。
function courseGateWaitFor(a, u, res) {
  try {
    if (!a || res) return false                        // 有成绩 = 已考完，不是「等待放行」
    const needGate = courseIsFinal(a) || (a.type === 'exam' && !!a.examGate)
    if (!needGate) return false
    const map = courseIsFinal(a) ? a.courseFinalOpened : a.examOpened
    return !(map && map[u])
  } catch (e) { return false }
}

// v150：放行键 = 最高权限 —— 已被逐人放行的线下课最终考试，无视章节锁。
// ================================================================
// 起因（2026-10-08 实撞）：管理员给 yang 放行了「B+F班的终极大考」，学员端仍点不开。
//   真凶不是放行闸门（courseFinalOpened 记录一切正常），而是这场考试挂了
//   chapter:'Final Episode'，而这个章节名是**后来新建作业时才第一次出现**的 →
//   不在建班时 initChOpenForNewClass 写下的 chOpen 快照里 → 按 v134「默认关闭」语义
//   被判锁定 → 放行键在章节闸门之前就被拦掉，管理员怎么点都无效。
//
// ★★★ 契约（改前读完）：**放行键压过章节锁**。
//   理由：放行是管理员对「某一个具体的人」的直接授权，章节开放是面向全体的批量状态。
//   前者更具体、更晚生效，且是管理员在考试现场唯一的救场手段 —— 若放行后仍可能被
//   章节锁拦住，就等于管理员对这场考试完全失去了控制权（本次故障的本质）。
//   用户原话：「我的解锁键作为最高权限 无视是否完成所有章节」。
//
// ★ 只豁免 coursefinal，不豁免普通 exam：普通测评的章节锁属于老师排课节奏的一部分，
//   不该被放行键绕过（放行键的存在意义仅限于最终考试这一场景）。
//
// ★ 失效方向（与 courseGateWaitFor 同族）：**自包含 + try/catch + fail-open 失效**
//   —— 取不到放行名单就当「没放行」。理由：这是个**放宽可见性**的判定，
//   判错方向若相反（异常时返回 true）会让未放行的考试在关闭章节里露出可点入口，
//   违背 v148 的可见性约定；返回 false 只是回到 v149 的行为（那一章仍锁着），
//   管理员仍可用「开放章节」这条老路解决。**宁可保守，不可误开。**
//
// ★ 不调用本文件其它新函数（只依赖 a.courseFinalOpened 字段本身），
//   以适配「历史套件按名字逐个注入函数」的沙箱 —— v147/v148 已两次踩这个坑。
function courseFinalReleasedBypass(a, u) {
  try {
    if (!a || a.type !== 'coursefinal') return false
    const map = a.courseFinalOpened
    return !!(map && u != null && map[u])
  } catch (e) { return false }
}

// 本章内是否存在「已被放行且尚未完成的最终考试」（渲染章节条用，同上口径）。
//   ★ 只有未完成的才有意义 —— 考完的人不再需要这一章保持可见。
function courseChapterHasReleasedFinal(assigns, u, chName) {
  try {
    if (!Array.isArray(assigns)) return false
    const key = String(chName == null ? '' : chName).trim()
    return assigns.some(a =>
      String(a && a.chapter == null ? '' : a.chapter).trim() === key &&
      courseFinalReleasedBypass(a, u) &&
      !(a.results || {})[u])
  } catch (e) { return false }
}

// ================================================================
// v147：重置成绩台账 + 「重置后只能重考一次」
//
// 背景（真实事故）：管理员点「重置」的语义是「作废这次成绩，让他再考一次」。
// 但 v146 之前 courseResetResult 只做 delete a.results[u]，而 courseStart 判「能不能作答」
// 只看 !res —— 重置既删了成绩、又保留了放行名单，于是学员立刻变回「未作答」态，
// 想重置几次就重置几次，等于开了无限重考（且毫无痕迹）。
//
// 本版把「重置」从**删除动作**升级为**台账事件**：
//   a.resultResets = { [username]: { n: 重置次数, tries: [被作废的成绩快照…] } }
//   · n         → 看板显示「已重置 ×2」，重置不再静默消失（Bug2）
//   · tries[]   → 被作废那次的 score/correct/total/attempts，供管理员追溯
//   · consumed  → 本次重置是否已被「重新交卷」消耗掉（决定还能不能再考）
//
// ★★★ 判定口径（改前务必读完）：
//   学员此刻能否作答 = 无成绩 且 未被闸门拦 且 ( 从未被重置 或 最近一次重置尚未被消耗 )
//   重置在**重新交卷那一刻**才被消耗（courseSaveResult），不是在点重置那一刻 ——
//   否则「重置完立刻锁死」就与用户明确要求的「重置后续能重考一次」直接矛盾。
// ================================================================

// 读取某学员的重置台账（幂等，不产生写操作）
function courseResetRecOf(a, u) {
  const m = (a && a.resultResets) || null
  const rec = m && u != null ? m[u] : null
  return rec && typeof rec === 'object' ? rec : null
}

// ---- v147：渲染链专用的**自包含**台账读取 ----
// ⚠️ 为什么不复用 courseResetRecOf（v147 实撞，与 v134 同族）：
//   渲染链（courseStudentPathHtml / courseAssignDetail / courseExportCell）会读重置台账，
//   而历史套件（v115/v120/v123/v128/v129/v133/v134 共 7 个）的沙箱是**按名字逐个注入函数**的，
//   新建函数不在其列表里 → 抽出的渲染函数在沙箱里一执行就 ReferenceError → 整页渲染抛错、断言全灭。
//
//   ★ 修法选型：把「渲染侧读取」做成**自包含**（不调用任何本文件其它新函数），
//     而不是去 7 个套件里逐个补注 14 处（脆弱：以后再加函数还要改）。
//     代价 = 台账结构判定逻辑出现两份，故用一条测试锁死两者口径一致（见 test-v147 组六）。
//
//   ★ 失效方向：读不到/取不出 → 视为「无重置记录」（= 旧行为：不锁学员、不误重考、不误标），
//     绝不因为一个可选台账丢了就把人锁死。
function courseResetRecSafe(a, u) {
  try {
    const m = (a && a.resultResets) || null
    const rec = m && u != null ? m[u] : null
    return rec && typeof rec === 'object' ? rec : null
  } catch (e) { return null }
}
// 同上：学员端「重考机会已用完」判定（自包含，不调用 courseRetryBlocked）
function courseRetryUsedSafe(a, u, res) {
  try {
    if (!a || res) return false
    const rec = courseResetRecSafe(a, u)
    if (!rec || !(rec.n > 0)) return false
    return !!rec.consumed
  } catch (e) { return false }
}

// 是否「重置后还能再考」（有重置台账且最近一次还没被交卷消耗）
function courseResetUnconsumed(a, u) {
  const rec = courseResetRecOf(a, u)
  return !!(rec && rec.n > 0 && !rec.consumed)
}

// v147：重置后重考次数用尽 → 学员端不得再作答。
// 只在「当前没有成绩」时成立：一旦重新交卷（台账被消耗 / 成绩重新存在）就自然解除。
function courseRetryBlocked(a, u, res) {
  if (!a || res) return false
  const rec = courseResetRecOf(a, u)
  if (!rec || !(rec.n > 0)) return false
  return !!rec.consumed
}

// 构造一条「被作废成绩」的快照（管理员重置时写入台账 tries）
function courseResetTryOf(prev, now) {
  if (!prev) return null
  return {
    at: Number(prev.at) || now, score: Number(prev.score) || 0,
    correct: Number(prev.correct) || 0, total: Number(prev.total) || 0,
    attempts: Number(prev.attempts) || 1, resetAt: now,
  }
}

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
  if (a.type === 'coursefinal') return '📕'   // v120 线下课最终考试
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

// v87：判分口径与渲染口径统一走 safeQType（选项不足 2 个的畸形选择题按填空判分）+ answer 容错
function courseCheckAnswer(q, ans) {
  const qt = safeQType(q)
  const ansArr = Array.isArray(q.answer) ? q.answer : [q.answer]
  if (qt === 'single' || qt === 'judge' || qt === 'pronounce' || qt === 'listen' || qt === 'voicematch') return ansArr.includes(ans)
  if (qt === 'multiple') {
    const sel = Array.isArray(ans) ? ans : []
    return sel.length === ansArr.length && ansArr.every(i => sel.includes(i))
  }
  if (qt === 'fill' || qt === 'translate') {
    const target = (q.options && q.options[0] != null) ? q.options[0] : ''
    return String(ans == null ? '' : ans).trim().toLowerCase() === String(target).trim().toLowerCase()
  }
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
  // v87：题型走 safeQType —— 选项不足 2 个的畸形选择题按填空渲染，避免出现「没有可点选项」的题
  const qt = safeQType(q)
  const ans = qz.answers[qz.index] !== undefined ? qz.answers[qz.index] : (qt === 'multiple' ? [] : (qt === 'fill' || qt === 'translate') ? '' : -1)
  // v53：回顾模式逐题即时反馈（即使源任务是测评，也走作业式逐题流程）
  const isExam = (qz.type === 'exam' || qz.type === 'coursefinal') && !qz.reviewing
  const answered = a => a !== undefined && a !== -1 && !(Array.isArray(a) && !a.length) && !(typeof a === 'string' && !a.trim())
  const showFeedback = !isExam && qz.submitted

  // v66：测评（exam）模式下题目同样必须可选/可填 —— 禁用只由「本题已提交」决定。
  // 原先 (isExam || qz.submitted) 会让测评卷所有选项不绑 onclick、填空框 disabled，导致整卷无法作答。
  const locked = !!qz.submitted
  let optionsHtml = ''
  if (qt === 'voicematch') {
    const dis = locked ? '' : 'coursePick'
    optionsHtml = vmOptionsHtml(q, ans, showFeedback ? 'review' : 'live', dis)
  } else if (qt === 'single' || qt === 'judge' || qt === 'pronounce' || qt === 'listen') {
    // v107：只渲染有效选项（丢掉尾部空槽）
    optionsHtml = visibleOptionIndexes(q.options).map(i => {
      const opt = q.options[i]
      let cls = 'option-item'
      if (showFeedback) { if (q.answer.includes(i)) cls += ' correct'; else if (ans === i) cls += ' wrong' }
      else if (ans === i) cls += ' selected'
      const badge = showFeedback && q.answer.includes(i) ? '✓' : LETTERS[i]
      const dis = locked ? '' : `coursePick(${i})`
      return `<div class="${cls}" ${dis ? `onclick="${dis}"` : ''}>
        <div class="option-badge">${badge}</div><div class="option-text">${opt}</div></div>`
    }).join('')
  } else if (qt === 'multiple') {
    optionsHtml = visibleOptionIndexes(q.options).map(i => {
      const opt = q.options[i]
      let cls = 'option-item'
      const sel = Array.isArray(ans) && ans.includes(i)
      if (showFeedback) { if (q.answer.includes(i)) cls += ' correct'; else if (sel) cls += ' wrong' }
      else if (sel) cls += ' selected'
      const badge = showFeedback && q.answer.includes(i) ? '✓' : LETTERS[i]
      const dis = locked ? '' : `courseTogglePick(${i})`
      return `<div class="${cls}" ${dis ? `onclick="${dis}"` : ''}>
        <div class="option-badge">${badge}</div><div class="option-text">${opt}</div></div>`
    }).join('')
  } else {
    let cls = 'input-answer'
    if (showFeedback) cls += courseCheckAnswer(q, ans) ? ' correct' : ' wrong'
    optionsHtml = `<input type="text" class="${cls}" placeholder="${t('answerPlaceholder')}" value="${escAttr(ans)}"
      oninput="courseType(this.value)" ${locked ? 'disabled' : ''} />`
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
  const qzIsExam = qz.type === 'exam' || qz.type === 'coursefinal'
  const icon = needReview ? '🔁' : (qzIsExam ? (passed ? '🎉' : '💪') : (score >= 80 ? '🎉' : '👍'))
  const title = needReview
    ? (qzIsExam ? t('courseReviewFirstExamTitle') : t('courseReviewFirstTitle'))
    : (qz.type === 'coursefinal' ? t('courseExamDoneTitle') : (qzIsExam ? t('courseExamDoneTitle') : (qz.type === 'videoquiz' ? t('courseVideoQuizDoneTitle') : t('courseHwDoneTitle'))))
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
      <div class="course-score ${qzIsExam ? (passed ? 'pass' : 'fail') : ''}">
        ${t('courseYourScore')}：${score}${LANG === 'en' ? '' : '分'}
        ${qzIsExam ? `<span class="course-pass-tag ${passed ? 'ok' : 'no'}">${passed ? t('coursePassed') : t('courseFailed')}</span>` : ''}
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
    if (!qz || qz.reviewing || (qz.type !== 'homework' && qz.type !== 'exam' && qz.type !== 'coursefinal')) return
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
      // v147：本轮回填用的是管理员重置换来的那次机会 → 立刻标记已消耗。
      //   消耗掉之后若再被重置，会重新给一次机会（正是「重置一次、能考一次」的口径）。
      const rec = courseResetRecOf(a, me)
      if (rec && !rec.consumed) rec.consumed = true
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
  courseDragBindGlobal()
  const el = document.getElementById('page-course')
  const classes = courseState.doc.classes || []
  let totalAssign = 0, totalExam = 0, totalSubmit = 0
  classes.forEach(c => (c.assignments || []).forEach(a => {
    if (a.status === 'draft') return   // 草稿不计入统计
    totalAssign++
    if (a.type === 'exam' || a.type === 'coursefinal') totalExam++
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
      const cls = { id, name, note, createdAt: Date.now(), createdBy: courseUser(), members: [], assignments: [] }
      // v134：新建班打 chInit（阻断存量回填），此前无章节 → chOpen 为空 map。
      //   此后新加进来的章节不在 map 里 → 学员端判为「关闭」，需管理员逐章开放。
      CourseStore.initChOpenForNewClass(cls)
      doc.classes.push(cls)
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
  // v129：章节分块（管理端）。在章节名变化处插入一行分节标题行。
  //   ★ data-drag-idx 必须仍等于 assignments 的真实下标（下面用 idx 传入），否则 v127 拖拽落位会错。
  //   ★ 分节行不带 data-drag-aid/data-drag-idx，故它天然不参与拖拽排序。
  let assignRows = ''
  let lastAdminChapter = null
  ;(c.assignments || []).forEach((a, idx) => {
    const chName = String(a.chapter == null ? '' : a.chapter).trim()
    if (chName !== lastAdminChapter) {
      if (chName) {
        const st = courseChapterStat(c.assignments, null, chName)
        assignRows += `<tr class="chapter-sep${courseChapterOpened(c, chName) ? '' : ' chapter-sep-locked'}" data-chapter="${escAttr(chName)}">
          <td colspan="8"><span class="chapter-sep-name">📚 ${escHtml(chName)}</span>
            <span class="chapter-sep-count">${t('courseChapterItemCount', st.total)}</span>
            <button class="btn btn-ghost btn-sm chapter-sep-btn" onclick="courseChapterRenameModal('${escAttr(c.id)}','${escAttr(chName)}')">${t('courseChapterRename')}</button>
            ${courseChapterToggleBtn(c.id, chName)}
          </td></tr>`
      } else {
        // v134：散项也归为「未分章」组，同样受章节开关控（默认关闭，可在这里单独开放）
        assignRows += `<tr class="chapter-sep chapter-sep-plain${courseChapterOpened(c, '') ? '' : ' chapter-sep-locked'}"><td colspan="8"><span class="chapter-sep-plain-txt">${t('courseChapterNone')}</span>${courseChapterToggleBtn(c.id, '')}</td></tr>`
      }
      lastAdminChapter = chName
    }
    if (a.type === 'offline') { assignRows += courseOfflineAdminRow(c, a, idx, assignTotal); return }
    const members = c.members || []
    const isDraft = a.status === 'draft'
    const isVideo = a.type === 'video'
    const done = Object.keys(a.results || {}).filter(u => members.includes(u)).length
    const scores = Object.values(a.results || {}).map(r => r.score || 0)
    const avg = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0
    const draftTag = isDraft ? `<span class="course-draft-tag">⏳ ${t('courseDraftTag')}</span> ` : ''
    assignRows += `<tr${isDraft ? ' class="row-draft"' : ''} data-drag-aid="${escAttr(a.id)}" data-drag-idx="${idx}">
      <td class="course-sort-cell">${courseSortBtns(c.id, a.id, idx, assignTotal)}</td>
      <td>${draftTag}${escHtml(a.title)}</td>
      <td>${isVideo ? t('courseTypeVideo') : (a.type === 'coursefinal' ? t('courseTypeCourseFinal') : (a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework')))}${a.type === 'coursefinal' ? ` <span title="${escAttr(t('courseFinalGateLabel'))}">🔒</span>` : (a.type === 'exam' && a.examGate ? ` <span title="${escAttr(t('courseExamGateLabel'))}">🔒</span>` : '')}</td>
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
            ? `<button class="btn btn-ghost btn-sm" onclick="courseEditAssignModal('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseEditBtn')}</button>
               <button class="btn btn-ghost btn-sm" onclick="courseEditVideoUrlModal('${escAttr(c.id)}','${escAttr(a.id)}')">${t('courseEditVideoUrl')}</button>
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
  })

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
      <button class="btn btn-ghost" onclick="courseBulkChapterModal('${escAttr(c.id)}')">📚 ${t('courseChapterBulkBtn')}</button>
      <button class="btn btn-ghost" onclick="courseCopyAllAssignmentsModal('${escAttr(c.id)}')">📋 ${t('courseCopyAllBtn')}</button>
      <button class="btn btn-primary" onclick="courseCreateAssignModal('${escAttr(c.id)}')">${t('courseNewAssign')}</button>
    </div>
    ${assignRows ? `<div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead><tr>
          <th style="width:56px" title="${escAttr(t('courseOrderHint'))}">⠿</th>
          <th>${t('courseThTitle')}</th><th>${t('courseThType')}</th><th>${t('courseThCount')}</th>
          <th>${t('courseThDeadline')}</th><th>${t('courseThProgress')}</th><th>${t('courseThAvg')}</th>
          <th>${t('courseThAction')}</th>
        </tr></thead>
        <tbody>${assignRows}</tbody>
      </table></div>` :
      `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">${t('courseNoAssign')}</div>`}
    <p class="form-hint" style="margin-top:8px">⠿ ${t('courseOrderHint')}</p>
    <p class="form-hint" style="margin-top:12px">${t('courseAdminHint')}</p>`
}

// ================================================================
// 任务排序：调整「作业 / 测评 / 视频 / 线下课」在班级内的先后顺序
// 学员端「我的学习进度」按 assignments 数组顺序渲染，交换数组即全局生效
//
// v127：整列为「拖拽手柄」，把原来「点一下挪一位」的 ↑↓ 按钮换成直接拖到位。
//       同时保留 courseMoveAssign（键盘/无拖拽环境回落，见 §无拖拽能力兜底）。
// ================================================================

// 行首拖拽手柄。draggable 只挂在手柄上（不挂 <tr>），否则整行文字都无法选中。
function courseSortBtns(cid, aid, idx, total) {
  return `<div class="course-drag-handle"
      draggable="true"
      title="${escAttr(t('courseDragHint'))}"
      data-cid="${escAttr(cid)}" data-aid="${escAttr(aid)}" data-idx="${idx}"
      ondragstart="courseDragStart(event,this)"
      ondragover="courseDragOver(event,this)"
      ondragleave="courseDragLeave(event,this)"
      ondrop="courseDragDrop(event,this)"
      ondragend="courseDragEnd(event,this)"
      ontouchstart="courseTouchStart(event,this)"
    >⠿</div>`
}

// 把 arr 里 from 位置的元素移到 to 位置（纯函数，便于测试；越界返回 null 不动数据）
function courseReorderList(arr, from, to) {
  if (!Array.isArray(arr)) return null
  if (from < 0 || to < 0 || from >= arr.length || to >= arr.length) return null
  if (from === to) return null
  const next = arr.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

// 拖拽状态（模块级，同一时刻只会有一个手势）
let _courseDrag = { cid: '', aid: '', from: -1 }

function courseDragStart(e, el) {
  _courseDrag = {
    cid: el.dataset.cid || '',
    aid: el.dataset.aid || '',
    from: parseInt(el.dataset.idx, 10)
  }
  const tr = el.closest('tr')
  if (tr) tr.classList.add('course-dragging')
  if (e && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 要求设置数据，否则不触发 drop
    try { e.dataTransfer.setData('text/plain', el.dataset.aid || '') } catch (err) {}
  }
}

// 悬停时给目标行加「插入到上方 / 下方」的视觉提示，松手即按此落位
function courseDragOver(e, el) {
  if (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move' }
  const tr = el.closest('tr')
  if (!tr) return
  const r = tr.getBoundingClientRect()
  const after = (e && typeof e.clientY === 'number') ? (e.clientY > r.top + r.height / 2) : false
  // 先清掉全表标记，避免同时高亮多行
  document.querySelectorAll('tr.course-drop-above, tr.course-drop-below').forEach(x => {
    x.classList.remove('course-drop-above', 'course-drop-below')
  })
  if (tr.dataset && tr.dataset.dragAid === _courseDrag.aid) return
  tr.classList.add(after ? 'course-drop-below' : 'course-drop-above')
}

function courseDragLeave(e, el) {
  const tr = el.closest('tr')
  if (tr) tr.classList.remove('course-drop-above', 'course-drop-below')
}

function courseDragEnd(e, el) {
  const tr = el && el.closest ? el.closest('tr') : null
  if (tr) tr.classList.remove('course-dragging')
  document.querySelectorAll('tr.course-drop-above, tr.course-drop-below').forEach(x => {
    x.classList.remove('course-drop-above', 'course-drop-below')
  })
  _courseDrag = { cid: '', aid: '', from: -1 }
}

// 松手落位：目标行 + 「上半/下半」→ 目标下标；交给 courseMoveAssignTo 写云端
async function courseDragDrop(e, el) {
  if (e) e.preventDefault()
  const tr = el.closest('tr')
  const cid = _courseDrag.cid
  const from = _courseDrag.from
  if (!tr || from < 0) { courseDragEnd(e, el); return }
  const toIdx = parseInt(tr.dataset.dragIdx, 10)
  if (isNaN(toIdx)) { courseDragEnd(e, el); return }
  const after = tr.classList.contains('course-drop-below')
  courseDragEnd(e, el)
  // 往下拖时：插到目标行之后 = 目标下标；插到之前 = 目标下标 - 1（元素自身被摘走后下标会左移）
  let to = after ? toIdx : toIdx - 1
  if (to < 0) to = 0
  if (to === from) return
  return courseMoveAssignTo(cid, from, to)
}

// ★ 无拖拽能力兜底：手机端部分浏览器（尤其旧版 Safari / 微信内置）不派发 HTML5 drag 事件，
//   故额外接一套 touch 手势。手指数值与阈值见下，只在纵向位移超阈值后才进入拖拽态，
//   以免把「想滚动列表」误判成拖拽。
//
// 注意：touchmove / touchend 必须挂在 document 上——触摸事件的 target 始终是「手指按下的
// 那个元素」，手指滑出该元素后仍在它身上派发，挂在内联手柄上会漏掉后续事件。
// 挂载点用 renderCourseAdmin（进管理页必过），带幂等标记，避免多次渲染重复挂。
function courseDragBindGlobal() {
  if (courseDragBindGlobal._done) return
  courseDragBindGlobal._done = true
  document.addEventListener('touchmove', courseTouchMove, { passive: false })
  document.addEventListener('touchend', courseTouchEnd)
  document.addEventListener('touchcancel', courseTouchEnd)
}

let _courseTouch = null

function courseTouchStart(e, el) {
  if (!e || !e.touches || e.touches.length !== 1) return
  const t = e.touches[0]
  _courseTouch = {
    el: el,
    cid: el.dataset.cid || '',
    aid: el.dataset.aid || '',
    from: parseInt(el.dataset.idx, 10),
    startY: t.clientY,
    active: false
  }
}

function courseTouchMove(e) {
  if (!_courseTouch || !e || !e.touches || e.touches.length !== 1) return
  const t = e.touches[0]
  const dy = t.clientY - _courseTouch.startY
  if (!_courseTouch.active) {
    // 10px 阈值内视为「用户想滚页面」，不抢事件
    if (Math.abs(dy) < 10) return
    _courseTouch.active = true
    const tr = _courseTouch.el.closest('tr')
    if (tr) tr.classList.add('course-dragging')
  }
  // 已进入拖拽态：阻止页面滚动，改由我们处理落位
  if (e.cancelable) e.preventDefault()
  const rows = Array.prototype.slice.call(document.querySelectorAll('tr[data-drag-idx]'))
  let hit = null, after = false
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect()
    if (t.clientY >= r.top && t.clientY <= r.bottom) {
      hit = rows[i]
      after = t.clientY > r.top + r.height / 2
      break
    }
  }
  rows.forEach(x => x.classList.remove('course-drop-above', 'course-drop-below'))
  if (hit) hit.classList.add(after ? 'course-drop-below' : 'course-drop-above')
  _courseTouch.hitAfter = after
  _courseTouch.hitIdx = hit ? parseInt(hit.dataset.dragIdx, 10) : -1
}

function courseTouchEnd(e) {
  if (!_courseTouch) return
  const st = _courseTouch
  _courseTouch = null
  const tr = st.el && st.el.closest ? st.el.closest('tr') : null
  if (tr) tr.classList.remove('course-dragging')
  document.querySelectorAll('tr.course-drop-above, tr.course-drop-below').forEach(x => {
    x.classList.remove('course-drop-above', 'course-drop-below')
  })
  if (!st.active) return            // 没越过阈值 = 只是点了一下，什么都不做
  const toIdx = (typeof st.hitIdx === 'number') ? st.hitIdx : -1
  if (toIdx < 0 || isNaN(st.from)) return
  let to = st.hitAfter ? toIdx : toIdx - 1
  if (to < 0) to = 0
  if (to === st.from) return
  return courseMoveAssignTo(st.cid, st.from, to)
}

// 把第 from 个任务移到第 to 个位置并持久化（拖拽落位唯一入口）
async function courseMoveAssignTo(cid, from, to) {
  let ok = false
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c || !Array.isArray(c.assignments)) return false
      const next = courseReorderList(c.assignments, from, to)
      if (!next) return false
      c.assignments = next
      ok = true
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  if (!ok) return                       // 越界 / 原位，无需重渲染
  courseState.doc = await CourseStore.getDoc()
  return courseRenderClass()
}

// 上移 / 下移一位（dir=-1 上移，+1 下移）；首尾边界处不动（mutate 返回 false）
// v127 起作为「无拖拽环境 / 键盘操作」的回落通道保留
async function courseMoveAssign(cid, aid, dir) {
  const c = courseFind(cid)
  if (!c || !Array.isArray(c.assignments)) return
  const i = c.assignments.findIndex(a => a.id === aid)
  if (i < 0) return
  return courseMoveAssignTo(cid, i, i + (dir < 0 ? -1 : 1))
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
  return `<tr data-drag-aid="${escAttr(a.id)}" data-drag-idx="${idx}">
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
    <div class="form-group"><label>🏷️ ${t('courseChapterLabel')}</label>
      <input type="text" id="coChapter" placeholder="${escAttr(t('courseChapterPh'))}" list="coChapterList" />
      <datalist id="coChapterList">${courseChapterOptionsHtml(cid)}</datalist>
      <p class="form-hint" style="margin:4px 0 0">${t('courseChapterHint')}</p></div>
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
  // v131：线下课也要能归入章节（v129 的章节体系原先只覆盖 homework/exam/video）
  const chEl = document.getElementById('coChapter')
  const chapter = (chEl ? chEl.value : '').trim()
  const aid = CourseStore.newId('a')
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      c.assignments = c.assignments || []
      if (c.assignments.some(x => x.id === aid)) return false   // 幂等：重试不重复
      const rec = {
        id: aid, type: 'offline', title: topic.name, topicId: topic.topicId, custom: topic.custom,
        desc, date, createdAt: Date.now(), createdBy: courseUser(),
        held: false, heldAt: 0, results: {}
      }
      if (chapter) rec.chapter = chapter
      c.assignments.push(rec)
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
      <input type="text" id="ceDesc" value="${escAttr(a.desc || '')}" placeholder="${t('courseOfflineDescPh')}" /></div>
    <div class="form-group"><label>🏷️ ${t('courseChapterLabel')}</label>
      <input type="text" id="ceOffChapter" value="${escAttr(a.chapter || '')}" placeholder="${escAttr(t('courseChapterPh'))}" list="ceOffChapterList" />
      <datalist id="ceOffChapterList">${courseChapterOptionsHtml(cid)}</datalist>
      <p class="form-hint" style="margin:4px 0 0">${t('courseChapterHint')}</p></div>`,
    `<button class="btn btn-primary" onclick="courseEditOffline('${escAttr(cid)}','${escAttr(aid)}')">${t('saveBtn')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseEditOffline(cid, aid) {
  const topic = courseOfflineReadTopic('ce')
  if (!topic) return
  const dateRaw = document.getElementById('ceDate').value
  const date = dateRaw ? new Date(dateRaw).getTime() : 0
  const desc = (document.getElementById('ceDesc').value || '').trim()
  // v131：线下课章节（空 = 清除归属）。用独立 id 避免与通用编辑弹窗的 ceChapter 冲突。
  const chEl = document.getElementById('ceOffChapter')
  const chapter = (chEl ? chEl.value : '').trim()
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
      if (chapter) a.chapter = chapter
      else delete a.chapter
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseOfflineEditOk'))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
}

// 真正下课后「标注完成」：弹窗勾选**来了的人**（v119 反转，原先勾的是没来的人）
// 默认全员勾选（= 全来了），老师只需取消没到的那几个 → 正向操作更顺手、不易误标。
// 存储结构不变：仍写 a.absent（缺席数组）；results 只记录出席(done)者 —— 二者互补
// 名单标签用 courseMemberCell（中文名加粗 + 用户名小字），老师看名字点人而不是看账号
async function courseHeldModal(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const members = c.members || []
  if (a.held) { alert(t('courseOfflineAlreadyHeld')); return }
  if (!members.length) { alert(t('courseOfflineNoMembers')); return }
  const infoMap = await courseUserInfoMap()
  const prevAbsent = Array.isArray(a.absent) ? a.absent.filter(u => members.indexOf(u) >= 0) : []
  // v119：无历史记录时默认全勾（假设都来了）；有历史则按上次缺席名单反推
  const listHtml = members.map(u => {
    const present = prevAbsent.length ? prevAbsent.indexOf(u) < 0 : true
    return `<label class="course-off-member"><input type="checkbox" name="coAbs" value="${escAttr(u)}"${present ? ' checked' : ''} /> <span>${courseMemberCell(u, infoMap)}</span></label>`
  }).join('')
  courseModalOpen(t('courseOfflineHeldAll'), `
    <p style="margin-bottom:8px;font-weight:600">📅 ${escHtml(a.title)}</p>
    <p class="form-hint" style="margin-bottom:10px">${t('courseOfflineHeldModalHint', members.length)}</p>
    <div style="margin-bottom:8px;display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" type="button" onclick="courseHeldPickAll(true)">${t('courseOfflinePickAll')}</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="courseHeldPickAll(false)">${t('courseOfflinePickNone')}</button>
    </div>
    <div class="course-chips course-off-members course-off-absent-pick" style="max-height:240px;overflow-y:auto">${listHtml}</div>`,
    `<button class="btn btn-primary" onclick="courseHeldSave('${escAttr(cid)}','${escAttr(aid)}')">✅ ${t('courseOfflineHeldAll')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}
// v119：一键全选 / 全不选（长名单时省事）
function courseHeldPickAll(on) {
  document.querySelectorAll('.course-off-absent-pick input[name="coAbs"]').forEach(el => { el.checked = !!on })
}

async function courseHeldSave(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const members = c.members || []
  if (a.held) { alert(t('courseOfflineAlreadyHeld')); return }
  if (!members.length) { alert(t('courseOfflineNoMembers')); return }
  // v119：勾选框现在代表「来了」（反转 v35 的「没来」口径），故缺席 = 未勾选者
  const present = Array.prototype.slice.call(document.querySelectorAll('.course-off-absent-pick input[name="coAbs"]:checked')).map(el => el.value)
  const presentSet = {}
  present.forEach(u => { presentSet[u] = true })
  const absent = members.filter(u => !presentSet[u])
  const attend = members.filter(u => presentSet[u])
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
        if (!presentSet[u]) delete aa.results[u]   // 缺席者移除（防此前误标残留）
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
// 本弹窗一直是「勾选=出席」的正向口径（与 v119 后的 courseHeldModal 一致）；
// v119 起名单同样改用中文名显示（原先只显示用户名）
async function courseOfflineMembers(cid, aid) {
  const c = courseFind(cid)
  const a = courseFindAssign(cid, aid)
  if (!c || !a) return
  const members = c.members || []
  const infoMap = await courseUserInfoMap()
  const listHtml = members.length
    ? members.map(u => {
        const done = !!(a.results || {})[u] && (a.results || {})[u].done
        return `<label class="course-off-member"><input type="checkbox" name="coM" value="${escAttr(u)}"${done ? ' checked' : ''} /> <span>${courseMemberCell(u, infoMap)}</span></label>`
      }).join('')
    : `<p style="color:#9ca3af">${t('courseOfflineNoMembers')}</p>`
  courseModalOpen(t('courseOfflineMembersTitle'), `
    ${members.length ? `<p style="margin-bottom:8px;font-weight:600">📅 ${escHtml(a.title)}</p>` : ''}
    <p class="form-hint" style="margin-bottom:10px">${t('courseOfflineMembersHint')}</p>
    <div style="margin-bottom:8px;display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" type="button" onclick="courseOfflinePickAll(true)">${t('courseOfflinePickAll')}</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="courseOfflinePickAll(false)">${t('courseOfflinePickNone')}</button>
    </div>
    <div class="course-chips course-off-members" style="max-height:240px;overflow-y:auto">${listHtml}</div>`,
    `<button class="btn btn-primary" onclick="courseOfflineMembersSave('${escAttr(cid)}','${escAttr(aid)}')">${t('saveBtn')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}
// v119：出席标注弹窗的一键全选 / 全不选
function courseOfflinePickAll(on) {
  document.querySelectorAll('.course-off-members input[name="coM"]').forEach(el => { el.checked = !!on })
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

// ---------- v139：可选的「样式 / 合并单元格 / 列宽 / 公式」支持 ----------
// 约束：老调用 xlsxSheetXml(rows) 与 impXlsxFromSheets([{name,rows}]) 的输出必须**逐字节不变**
//（无样式单元格绝不写 s 属性——已有测试断言 `<c r="B2"><v>85</v></c>` 这一字面形态）。
// 因此样式只在 sheet 声明了 merges/cols 或单元格写成对象时才启用，见 impXlsxFromSheets 的 rich 判定。
// 样式按需收集（只写真正用到的组合），避免为几十种边框组合写死一张表。
function xlsxStyleBook() {
  const bk = {
    fonts: ['<font><sz val="11"/><name val="Calibri"/></font>'],
    fills: ['<fill><patternFill patternType="none"/></fill>',
            '<fill><patternFill patternType="gray125"/></fill>'],
    borders: ['<border><left/><right/><top/><bottom/><diagonal/></border>'],
    numFmts: [],
    xfs: ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'],
    // 预置「默认」键 → 全部落到内置的 0 号，避免默认单元格又注册一份重复字体
    _k: {
      'f\u00a7\u00a70': 0,
      'p\u00a7': 0,
      'b\u00a7\u00a7\u00a7\u00a7': 0,
      'n\u00a7': 0,
      'x\u00a70\u00a70\u00a70\u00a70\u00a7\u00a7\u00a70': 0,
    },
  }
  const key = (...a) => a.join('\u00a7')
  // 内置数字格式（ECMA-376 保留 id），其余按 164 起自定义
  const BUILTIN_FMT = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.0': null }
  bk.fontId = (color, bold) => {
    const k = key('f', color || '', bold ? 1 : 0)
    if (bk._k[k] != null) return bk._k[k]
    const id = bk.fonts.length
    bk.fonts.push('<font>' + (bold ? '<b/>' : '') + '<sz val="11"/>'
      + (color ? '<color rgb="FF' + String(color).toUpperCase() + '"/>' : '')
      + '<name val="Calibri"/></font>')
    bk._k[k] = id
    return id
  }
  bk.fillId = color => {
    const c = color ? String(color).toUpperCase() : ''
    const k = key('p', c)
    if (bk._k[k] != null) return bk._k[k]
    const id = bk.fills.length   // 0/1 已被 none + gray125 占位
    bk.fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FF' + c + '"/><bgColor indexed="64"/></patternFill></fill>')
    bk._k[k] = id
    return id
  }
  bk.borderId = (l, r, t, b) => {
    const k = key('b', l || '', r || '', t || '', b || '')
    if (bk._k[k] != null) return bk._k[k]
    const side = (tag, w) => (w ? '<' + tag + ' style="' + w + '"/>' : '<' + tag + '/>')
    const id = bk.borders.length
    bk.borders.push('<border>' + side('left', l) + side('right', r) + side('top', t) + side('bottom', b) + '<diagonal/></border>')
    bk._k[k] = id
    return id
  }
  bk.numFmtId = code => {
    const c = code ? String(code) : ''
    const k = key('n', c)
    if (bk._k[k] != null) return bk._k[k]
    const builtin = BUILTIN_FMT[c]
    if (builtin) { bk._k[k] = builtin; return builtin }
    const id = 164 + bk.numFmts.length
    bk.numFmts.push({ id, code: c })
    bk._k[k] = id
    return id
  }
  // st = { color, bold, fill, fmt, align, valign, wrap, bl,br,bt,bb }（bl 等为边框线型 '' | 'thin' | 'medium'）
  bk.xfId = st => {
    const f = bk.fontId(st.color, st.bold)
    const fl = bk.fillId(st.fill)
    const bd = bk.borderId(st.bl, st.br, st.bt, st.bb)
    const nf = bk.numFmtId(st.fmt)
    const align = st.align || '', valign = st.valign || '', wrap = st.wrap ? 1 : 0
    const k = key('x', f, fl, bd, nf, align, valign, wrap)
    if (bk._k[k] != null) return bk._k[k]
    const id = bk.xfs.length
    const al = (align || valign || wrap)
      ? '<alignment' + (align ? ' horizontal="' + align + '"' : '') + (valign ? ' vertical="' + valign + '"' : '')
        + (wrap ? ' wrapText="1"' : '') + '/>'
      : ''
    bk.xfs.push('<xf numFmtId="' + nf + '" fontId="' + f + '" fillId="' + fl + '" borderId="' + bd + '" xfId="0"'
      + ' applyFont="1" applyFill="1" applyBorder="1"' + (nf ? ' applyNumberFormat="1"' : '')
      + (al ? ' applyAlignment="1">' + al + '</xf>' : '/>'))
    bk._k[k] = id
    return id
  }
  bk.xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + (bk.numFmts.length
      ? '<numFmts count="' + bk.numFmts.length + '">'
        + bk.numFmts.map(n => '<numFmt numFmtId="' + n.id + '" formatCode="' + xlsxXmlEscape(n.code) + '"/>').join('') + '</numFmts>'
      : '')
    + '<fonts count="' + bk.fonts.length + '">' + bk.fonts.join('') + '</fonts>'
    + '<fills count="' + bk.fills.length + '">' + bk.fills.join('') + '</fills>'
    + '<borders count="' + bk.borders.length + '">' + bk.borders.join('') + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="' + bk.xfs.length + '">' + bk.xfs.join('') + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>'
  return bk
}
// 单元格：原始值 | { v, f(公式文本), s(样式对象) }
function xlsxCellXml(ref, cell, bk) {
  let v = cell, f = '', st = null
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) { v = cell.v; f = cell.f || ''; st = cell.s || null }
  const sid = (st && bk) ? bk.xfId(st) : 0
  const sA = sid ? ' s="' + sid + '"' : ''
  const num = (typeof v === 'number' && isFinite(v)) ? String(v) : null
  if (f) return '<c r="' + ref + '"' + sA + '><f>' + xlsxXmlEscape(f) + '</f>' + (num != null ? '<v>' + num + '</v>' : '') + '</c>'
  if (num != null) return '<c r="' + ref + '"' + sA + '><v>' + num + '</v></c>'
  const s = v == null ? '' : String(v)
  if (!s) return sA ? '<c r="' + ref + '"' + sA + '/>' : ''
  return '<c r="' + ref + '"' + sA + ' t="inlineStr"><is><t xml:space="preserve">' + xlsxXmlEscape(s) + '</t></is></c>'
}
// 富版式 sheet：{ name, rows, cols?:[px...], merges?:['A1:N1'] }
// px → Excel 列宽字符数（Calibri 11 的经验换算），下限 1 避免 0 宽
function xlsxPxToWidth(px) {
  const n = Number(px) || 0
  return Math.max(1, Math.round(((n - 5) / 7) * 100) / 100)
}
function xlsxSheetXmlRich(sheet, bk) {
  const rows = (sheet && sheet.rows) || []
  const cols = (sheet && sheet.cols) || null
  const merges = (sheet && sheet.merges) || null
  const colsXml = (cols && cols.length)
    ? '<cols>' + cols.map((px, i) => px
      ? '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + xlsxPxToWidth(px) + '" customWidth="1"/>'
      : '').join('') + '</cols>'
    : ''
  const body = rows.map((row, ri) => {
    const cells = (row || []).map((v, ci) => xlsxCellXml(xlsxColRef(ci) + (ri + 1), v, bk)).join('')
    return '<row r="' + (ri + 1) + '">' + cells + '</row>'
  }).join('')
  const mgXml = (merges && merges.length)
    ? '<mergeCells count="' + merges.length + '">' + merges.map(r => '<mergeCell ref="' + r + '"/>').join('') + '</mergeCells>'
    : ''
  // OOXML 元素次序固定：cols 必须在 sheetData 之前，mergeCells 之后
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + colsXml + '<sheetData>' + body + '</sheetData>' + mgXml + '</worksheet>'
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
function courseExportCell(a, r, u) {
  // v147：无成绩但有重置台账 → 区分「已重置·待重考」（考过、被作废、名额还在）与「从未作答」。
  //   导出的表是给管理层看的，两者混为一谈会让「按期完成率」的解读完全走偏。
  if (!r) {
    const recU = courseResetRecSafe(a, u)
    if (recU && recU.n > 0) return recU.consumed ? t('courseRetryUsedShort') : t('courseResetPendingTag')
    return t('courseDashNotDone')
  }
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
      rows.push([disp].concat(assigns.map(a => courseExportCell(a, (a.results || {})[u], u))))
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
  const typeLabel = a.type === 'video' ? t('courseTypeVideo') : (a.type === 'coursefinal' ? t('courseTypeCourseFinal') : (a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework')))
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
  delete clone.examOpened     // v115：放行名单属于原任务，不随复制带走（examGate 开关本身照常复制）
  delete clone.courseFinalOpened   // v120：最终考试放行名单同理不复制（类型/时长/及格分照常复制）
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

// ================================================================
// 一键复制全部作业到其他班级（v121）：与单条复制的三点差异——
// ① 线下课也复制（单条复制不支持）；② 一次复制该班全部任务；
// ③ 线下课复制后上课时间清空、回到「未上过课」（考勤名单不带走）。
// 共同口径：成绩不复制、放行名单（examOpened / courseFinalOpened）不带走、
// 目标班级成员不变、草稿保持草稿、已发布 → 复制即发布（过期截止时间清空）
// ================================================================
async function courseCopyAllAssignmentsModal(cid) {
  // 拉取最新班级列表（其他管理员可能刚建了新班级）
  try { courseState.doc = await CourseStore.getDoc() } catch (e) {}
  const c = courseFind(cid)
  const items = (c && c.assignments) || []
  const others = ((courseState.doc && courseState.doc.classes) || []).filter(x => x.id !== cid)
  if (!c || !items.length) { alert(t('courseCopyAllNone')); return }
  if (!others.length) { alert(t('courseCopyNoClass')); return }
  const nOffline = items.filter(a => a.type === 'offline').length
  const opts = others.map(x =>
    `<option value="${escAttr(x.id)}">${escHtml(x.name)}</option>`).join('')
  courseModalOpen(t('courseCopyAllTitle'), `
    <div style="font-size:14px;color:#1f2937;background:#f3f4f6;border-radius:6px;padding:10px 12px;margin-bottom:14px;line-height:1.7">
      📋 ${escHtml(c.name)}<br>
      <span style="color:#6b7280;font-size:13px">${t('courseCopyAllSummary', items.length, nOffline)}</span></div>
    <div class="form-group"><label>${t('courseCopyTargetLabel')}</label>
      <select id="ccAllTarget"><option value="">${t('courseCopyPick')}</option>${opts}</select></div>
    <p class="form-hint" style="margin-top:10px">${t('courseCopyAllHint')}</p>
  `,
    `<button class="btn btn-primary" onclick="courseCopyAllAssignmentsDo('${escAttr(cid)}')">📋 ${t('courseCopyAllBtn')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

async function courseCopyAllAssignmentsDo(cid) {
  const sel = document.getElementById('ccAllTarget')
  const tid = sel ? sel.value : ''
  const c = courseFind(cid)
  const items = (c && c.assignments) || []
  if (!c || !items.length || !tid) return
  const tgt = ((courseState.doc && courseState.doc.classes) || []).find(x => x.id === tid)
  if (!tgt) return
  const now = Date.now()
  // 逐条深拷贝任务本体（题目 / 选项 / 课后小测 / 线下课主题等一并复制），再重置实例字段
  const clones = items.map(a => {
    const clone = JSON.parse(JSON.stringify(a))
    clone.results = {}               // 成绩不复制：新班级从零开始
    delete clone.examOpened          // v115：测评放行名单属于原任务，不随复制带走（examGate 开关本身照常复制）
    delete clone.courseFinalOpened   // v120：最终考试放行名单同理（类型/时长/及格分照常复制）
    clone.id = CourseStore.newId('a')
    clone.createdAt = now
    if (a.type === 'offline') {
      // v121：线下课复制后上课时间清空、回到「未上过课」，考勤名单不带走
      clone.date = 0
      clone.held = false
      clone.heldAt = 0
      delete clone.absent
    } else if (clone.status === 'draft') {
      // 草稿 → 保持草稿状态
    } else {
      delete clone.status
      // 已发布 → 复制即发布；原截止时间已过则清空，避免目标班级学员一进来看见「已逾期」
      if (clone.deadline && clone.deadline < now) clone.deadline = 0
      clone.sentAt = now
    }
    return clone
  })
  try {
    await CourseStore.mutate(doc => {
      const tc = CourseStore.findClass(doc, tid)
      if (!tc) return false
      tc.assignments = tc.assignments || []
      if (clones.some(x => tc.assignments.some(y => y.id === x.id))) return false   // 幂等：重试不重复
      tc.assignments.push(...clones)
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseModalClose()
  alert(t('courseCopyAllOk', clones.length, tgt.name))
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
  // v115 期末考试放行闸门 / v120 线下课最终考试放行闸门：
  // 管理端逐成员「放行 / 撤销」列。普通测评需 examGate 开启才显示；最终考试恒显示。
  const isFinal = courseIsFinal(a)
  const gateExam = courseGateRequired(a)
  const gateCell = (u, r) => {
    const openRec = ((isFinal ? a.courseFinalOpened : a.examOpened) || {})[u] || null
    const okKey = isFinal ? 'courseFinalOk' : 'courseExamGateOk'
    const noKey = isFinal ? 'courseFinalNotYet' : 'courseExamGateNotYet'
    const btnKey = isFinal ? 'courseFinalBtn' : 'courseExamGateBtn'
    const revokeKey = isFinal ? 'courseFinalRevoke' : 'courseExamGateRevoke'
    const openFn = isFinal ? 'courseFinalGateOpen' : 'courseExamGateOpen'
    const revokeFn = isFinal ? 'courseFinalGateRevoke' : 'courseExamGateRevoke'
    const tag = openRec
      ? `<span class="course-status done" style="font-size:11px">🔓 ${t(okKey)}${openRec.at ? ' · ' + courseFmtDate(openRec.at) : ''}</span>`
      : `<span class="course-status expired" style="font-size:11px">🔒 ${t(noKey)}</span>`
    // 内联 onclick 一律用 data-u + (this) 取参，绝不把用户名拼进 onclick（v85 引号陷阱）
    const btn = (!r && !openRec)
      ? `<div style="margin-top:4px"><button class="btn btn-primary btn-sm" data-c="${escAttr(cid)}" data-a="${escAttr(aid)}" data-u="${escAttr(u)}" onclick="${openFn}(this)">🔓 ${t(btnKey)}</button></div>`
      : (!r && openRec
        ? `<div style="margin-top:4px"><button class="btn btn-ghost btn-sm" data-c="${escAttr(cid)}" data-a="${escAttr(aid)}" data-u="${escAttr(u)}" onclick="${revokeFn}(this)">${t(revokeKey)}</button></div>`
        : '')
    return tag + btn
  }
  const rows = (c.members || []).map(u => {
    const r = (a.results || {})[u]
    const overTag = r && r.overdue ? ` <span class="course-status expired">${t('courseOverdue')}</span>` : ''
    // v56：作业/测评做过多遍 → 状态列下方列出每次真实成绩（第1次 → 最近）
    const histArr = r && !isVideo && Array.isArray(r.history) && r.history.length > 1 ? r.history : null
    // v147：重置台账 —— 有记录就展示，并把被作废的历次成绩列出来（重置不再静默消失）
    const resetRec = (!isVideo && courseResetRecSafe(a, u)) || null
    const resetHtml = resetRec
      ? `<div class="course-hist" title="${escAttr(t('courseResetHistTitle'))}">${t('courseResetTimesFmt', resetRec.n)}${(resetRec.tries || []).length ? '<span class="course-hist-sep"> · </span>' + resetRec.tries.map(h => `<span>${h.score}${LANG === 'en' ? '' : '分'}</span>`).join('<span class="course-hist-sep"> → </span>') : ''}</div>`
      : ''
    const histHtml = histArr
      ? `<div class="course-hist" title="${escAttr(t('courseHistTitle'))}">${histArr.map((h, i) => `<span>${t('courseHistTryFmt', i + 1, h.score)}</span>`).join('<span class="course-hist-sep"> → </span>')}</div>`
      : ''
    // v147：重置后还没回填 → 明确标「待重考」，而不是混在「未提交」里
    // （「未提交」= 从没考过；「已重置·待重考」= 考过、成绩被作废、名额还留着 —— 两者处理方式完全不同）
    const resetPending = !r && resetRec && !resetRec.consumed
    const statusHtml = r
      ? (isVideo
          ? `<span class="course-status done">✓ ${t('courseDoneTag')}${r.watchedPct != null ? ' · ' + Math.min(100, Math.round(r.watchedPct)) + '%' : ''}</span>${overTag}`
          : `<span class="course-status done">✓ ${r.score}${LANG === 'en' ? '' : '分'}</span>${overTag}${histHtml}${resetHtml}`)
      : resetPending
        ? `<span class="course-status reset">↺ ${t('courseResetPendingTag')}</span>${resetHtml}`
        : `<span class="course-status expired">${t('courseNotSubmitted')}</span>${resetHtml}`
    // v147 Bug3：成绩记录的题数 ≠ 当前题数 → 这次成绩基于旧版题目，分数不可比。
    //   只对成绩/题数类任务提示（视频无 questions，offline 不在此表）。
    const qnMismatch = !!(r && !isVideo && r.total != null && r.total > 0 &&
      Array.isArray(a.questions) && a.questions.length && Number(r.total) !== a.questions.length)
    const staleTag = qnMismatch
      ? ` <span class="course-status stale" title="${escAttr(t('courseStaleTitle', r.total, a.questions.length))}">⚠ ${t('courseStaleTag')}</span>`
      : ''
    return `<tr>
      <td>${courseMemberCell(u, infoMap)}</td>
      <td>${statusHtml}${staleTag}</td>
      <td style="text-align:center">${isVideo ? (r ? (r.watchedSec || 0) + 's' : '—') : (r ? (r.correct || 0) + '/' + (r.total || 0) : '—')}</td>
      ${isVideo ? `<td style="text-align:center">${r ? (r.difficulty ? '★'.repeat(Math.min(5,Math.max(1,r.difficulty))) : '—') : '—'}</td>` : ''}
      ${hasQuiz ? `<td style="text-align:center">${r && r.quizTotal != null ? r.quizCorrect + '/' + r.quizTotal : '—'}</td>` : ''}
      <td style="text-align:center">${r ? (r.attempts || 1) : '—'}</td>
      <td style="font-size:12px">${r ? courseFmtDate(r.at) : '—'}</td>
      ${gateExam ? `<td style="text-align:center">${gateCell(u, r)}</td>` : ''}
      <td>${r
        ? `<button class="btn btn-ghost btn-sm" onclick="courseResetResult(${escAttr(JSON.stringify(cid))},${escAttr(JSON.stringify(aid))},${escAttr(JSON.stringify(u))})">${t('courseResetResult')}</button>`
        : (resetPending
          ? `<button class="btn btn-ghost btn-sm" title="${escAttr(t('courseResetUndoHint'))}" data-c="${escAttr(cid)}" data-a="${escAttr(aid)}" data-u="${escAttr(u)}" onclick="courseResetUndo(this)">${t('courseResetUndo')}</button>`
          : '')}</td>
    </tr>`
  }).join('')

  el.innerHTML = `
    <div class="course-back"><a onclick="courseBackClass()">← ${t('courseBackClass')}</a></div>
    <h2 style="margin-bottom:4px">📋 ${escHtml(a.title)}</h2>
    <p style="color:#6b7280;margin-bottom:16px">${isVideo ? t('courseTypeVideo') : (a.type === 'coursefinal' ? t('courseTypeCourseFinal') : (a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework')))} · ${isVideo ? t('courseVideoLabel') : (a.questions || []).length + t('courseQuestions')} · ${t('courseDeadline')}：${a.deadline ? courseFmtDate(a.deadline) : t('courseUnlimited')}</p>
    ${diffSummaryHtml}
    ${rows ? `<div class="card" style="padding:0;overflow-x:auto">
      <table class="admin-table dash-table">
        <thead><tr>
          <th>${t('courseThMember')}</th><th>${isVideo ? t('courseThWatch') : t('courseThScore')}</th><th>${isVideo ? t('courseThWatchSec') : t('courseThCorrect')}</th>
          ${isVideo ? `<th>${t('courseThDifficulty')}</th>` : ''}
          ${hasQuiz ? `<th>${t('courseThQuiz')}</th>` : ''}
          <th>${t('courseThTries')}</th><th>${t('courseThSubmitAt')}</th>${gateExam ? `<th>${t(isFinal ? 'courseFinalCol' : 'courseExamGateCol')}</th>` : ''}<th>${t('courseThAction')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` :
      `<div class="card" style="text-align:center;padding:30px;color:#9ca3af">${t('courseNoMembers')}</div>`}`
}

function courseBackClass() { courseState.view = 'class'; courseRenderClass() }

// v147：重置成绩 —— 从「裸删」升级为「写台账 + 删成绩」。
//   ① 被作废的成绩快照进 a.resultResets[u].tries（管理员可追溯，Bug2）；
//   ② n 累加 → 看板显示「已重置 ×n」；
//   ③ consumed=false → 学员获得**一次**重考机会，交卷时由 courseSaveResult 消耗掉；
//   ④ 放行名单（courseFinalOpened / examOpened）刻意保留 —— 重置的是成绩不是资格，
//      否则管理员重置完还得再点一次放行，多一步且容易漏。
async function courseResetResult(cid, aid, u) {
  if (!confirm(t('courseResetConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      const prev = (a.results || {})[u] || null
      // 无成绩可重置：不新增台账条目（否则连点几次就凭空多出几次「重置记录」）
      if (!prev) return false
      const now = Date.now()
      a.resultResets = a.resultResets || {}
      // 取台账口径与 courseResetRecOf 同源（脏数据判定只有一处），但这里**用真函数不做守卫** ——
      // 写入动作缺依赖必须响亮地炸，静默降级会变成「重置无效」。
      const rec = courseResetRecOf(a, u) || { n: 0, tries: [] }
      rec.n = (Number(rec.n) || 0) + 1
      rec.at = now
      rec.by = courseUser()
      rec.consumed = false            // 重置即授予一次重考机会
      rec.tries = Array.isArray(rec.tries) ? rec.tries : []
      const snap = courseResetTryOf(prev, now)
      if (snap) rec.tries.push(snap)
      if (rec.tries.length > 10) rec.tries = rec.tries.slice(rec.tries.length - 10)   // 防 1MB 容量膨胀
      a.resultResets[u] = rec
      if (a.results) delete a.results[u]
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}

// v147：撤销重置（误点救援）。语义 = 「收回那次重考机会，把被作废的成绩还回来」：
//   · 还原最近一条 tries 快照为成绩（分数/明细/尝试次数都按原样恢复，不留半截状态）；
//   · 台账 n 减 1；n 归零则整条记录删除（该学员回到「从未被重置」的干净态）。
//   ★ 只在「已重置且还没重考」时可用：已经重新交卷的成绩不能被这次撤销覆盖回去，
//     否则会成为「凭空抹掉一次真实作答」的后门（按钮在那种情形下根本不渲染）。
async function courseResetUndo(el) {
  const { cid, aid, u } = courseGateElArgs(el)
  if (!cid || !aid || !u) return
  if (!confirm(t('courseResetUndoConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      const rec = courseResetRecOf(a, u)
      if (!rec || !(rec.n > 0) || rec.consumed) return false   // 已被重考消耗 → 不许撤销
      const tries = Array.isArray(rec.tries) ? rec.tries : []
      const last = tries.length ? tries[tries.length - 1] : null
      if (last) {
        a.results = a.results || {}
        a.results[u] = {
          at: last.at, score: last.score, correct: last.correct, total: last.total,
          usedSec: 0, attempts: last.attempts != null ? last.attempts : 1,
        }
        rec.tries = tries.slice(0, -1)
      }
      rec.n = (Number(rec.n) || 0) - 1
      if (rec.n <= 0) delete a.resultResets[u]
      if (a.resultResets && !Object.keys(a.resultResets).length) delete a.resultResets
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}
// v120：改为接收 DOM 元素（el.dataset 取参），避免用户名拼进内联 onclick 的引号陷阱
function courseGateElArgs(el) {
  const d = (el && el.dataset) || {}
  return { cid: d.c || '', aid: d.a || '', u: d.u || '' }
}

async function courseExamGateOpen(el) {
  const { cid, aid, u } = courseGateElArgs(el)
  if (!cid || !aid || !u) return
  if (!confirm(t('courseExamGateConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      a.examOpened = a.examOpened || {}
      if (a.examOpened[u]) return false   // 幂等：已放行不重复
      a.examOpened[u] = { at: Date.now(), by: courseUser() }
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}

// v115：撤销放行（仅未作答时出现按钮；已交成绩不受影响，examOpened 名单移除该学员）
async function courseExamGateRevoke(el) {
  const { cid, aid, u } = courseGateElArgs(el)
  if (!cid || !aid || !u) return
  if (!confirm(t('courseExamGateRevokeConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      if (a.examOpened) delete a.examOpened[u]
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}

// v120：线下课最终考试逐人放行 / 撤销。
// 与 examGate 完全同型，只是写独立名单 courseFinalOpened —— 两个闸门互不干扰：
// 同一份作业从 exam 改成 coursefinal 时，旧 examOpened 名单不会被复用（避免「改类型后莫名已放行」）。
async function courseFinalGateOpen(el) {
  const { cid, aid, u } = courseGateElArgs(el)
  if (!cid || !aid || !u) return
  if (!confirm(t('courseFinalConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      a.courseFinalOpened = a.courseFinalOpened || {}
      if (a.courseFinalOpened[u]) return false   // 幂等
      a.courseFinalOpened[u] = { at: Date.now(), by: courseUser() }
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}

async function courseFinalGateRevoke(el) {
  const { cid, aid, u } = courseGateElArgs(el)
  if (!cid || !aid || !u) return
  if (!confirm(t('courseFinalRevokeConfirm', u))) return
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      const a = CourseStore.findAssign(c, aid)
      if (!a) return false
      if (a.courseFinalOpened) delete a.courseFinalOpened[u]
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  courseState.doc = await CourseStore.getDoc()
  courseAssignDetail(cid, aid)
}

// ================================================================
// 新建作业 / 测评（题库抽题 或 上传课程文件生成）
// ================================================================
function courseCreateAssignModal(cid) {
  courseDraft = { cid, mode: 'bank', preview: [], file: null, files: [], fileName: '', quiz: [], chapter: '' }
  const cats = Store.getCategories()
  courseModalOpen(t('courseNewAssign'), `
    <div class="form-row2">
      <div class="form-group"><label>${t('courseTypeLabel')} *</label>
        <select id="caType" onchange="courseDraftTypeChange()">
          <option value="homework">${t('courseTypeHomework')}</option>
          <option value="exam">${t('courseTypeExam')}</option>
          <option value="coursefinal">📕 ${t('courseTypeCourseFinal')}</option>
          <option value="video">${t('courseTypeVideo')}</option>
        </select></div>
      <div class="form-group"><label>${t('courseTitlePh')} *</label>
        <input type="text" id="caTitle" placeholder="${t('courseTitlePh2')}" /></div>
    </div>
    <div class="form-group"><label>${t('courseDescPh')}</label>
      <input type="text" id="caDesc" placeholder="${t('courseDescPh2')}" /></div>
    <div class="form-group"><label>🏷️ ${t('courseChapterLabel')}</label>
      <input type="text" id="caChapter" placeholder="${escAttr(t('courseChapterPh'))}" list="caChapterList" />
      <datalist id="caChapterList">${courseChapterOptionsHtml(cid)}</datalist>
      <p class="form-hint" style="margin:4px 0 0">${t('courseChapterHint')}</p></div>
    <div class="form-row2">
      <div class="form-group"><label>${t('courseDeadlineLabel')}</label>
        <input type="datetime-local" id="caDeadline" /></div>
      <div class="form-group" id="caExamOnly"><label>${t('courseDurationLabel')}</label>
        <input type="number" id="caDuration" min="1" max="180" value="20" /></div>
    </div>
    <div class="form-group" id="caPassGroup"><label>${t('coursePassLabel')}</label>
      <input type="number" id="caPass" min="0" max="100" value="60" /></div>
    <div class="form-group" id="caGateGroup" style="display:none">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500">
        <input type="checkbox" id="caExamGate" /> <span>🔒 ${t('courseExamGateLabel')}</span></label>
      <p class="form-hint" style="margin:4px 0 0">${t('courseExamGateHint')}</p>
    </div>
    <div class="form-group" id="caFinalGateGroup" style="display:none">
      <p class="form-hint" style="margin:4px 0 0;padding:10px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;color:#92400e">
        🔒 ${t('courseFinalGateHint')}</p>
    </div>
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
        <input type="file" id="caImportFile" accept=".csv,.tsv,.txt,.json,.xlsx,text/csv,text/plain,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange="courseImportReadFile(this)" />
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
  const gate = document.getElementById('caGateGroup')
  const finalGate = document.getElementById('caFinalGateGroup')
  // v120：线下课最终考试（coursefinal）与测评（exam）共享「时长 / 及格分」字段；
  // 闸门控件不同：exam 用可勾选开关，coursefinal 恒开（只显示说明）。
  const examLike = type === 'exam' || type === 'coursefinal'
  if (dur) dur.style.display = examLike ? '' : 'none'
  if (pass) pass.style.display = examLike ? '' : 'none'
  if (gate) gate.style.display = type === 'exam' ? '' : 'none'
  if (finalGate) finalGate.style.display = type === 'coursefinal' ? '' : 'none'
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
// v125：新增 .xlsx 直传 —— 管理员用 Excel 填完模板常见是「另存为 xlsx」，
// 此前只按文本读会因 ZIP 二进制变成乱码而解析失败。现在先解包取首个工作表成
// 二维数组 → 转回 CSV 文本 → 走同一条 impParseAndPreview 预览勾选链路。
// ================================================================
// 二维数组 → CSV 文本（按 IMPORT_COLS 列宽补齐；引号/逗号/换行按 RFC4180 转义）
function courseRowsToCsv(rows) {
  const width = Math.max(IMPORT_COLS.length, ...rows.map(r => (r || []).length))
  return rows.map(r => {
    const cells = []
    for (let i = 0; i < width; i++) cells.push(i < r.length ? r[i] : '')
    return impCsvRow(cells)
  }).join('\n')
}
function courseImportReadFile(input) {
  const f = input && input.files && input.files[0]
  if (!f) return
  // v125：xlsx 分支统一收口在 importReadFile（importFileChange 同款判据），
  // 这里只负责把文件交给它，避免两处各写一份 ZIP 解包判据。
  importReadFile(f)
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
  // v120：最终考试与测评同型（限时 + 及格分），故共用时长/及格分读取
  const examLike = type === 'exam' || type === 'coursefinal'
  const duration = examLike ? (Number(document.getElementById('caDuration').value) || 20) : 0
  const passScore = examLike ? (Number(document.getElementById('caPass').value) || 60) : 60
  // v115 期末考试放行闸门：勾选后学员须被管理员逐人放行才能作答
  // v120 线下课最终考试：闸门是定义性特征，恒开，无需勾选
  const gateEl = document.getElementById('caExamGate')
  const examGate = type === 'exam' && !!(gateEl && gateEl.checked)
  // v145：新建作业/测评时即可直接归入章节（此前只能发布后再到编辑弹窗 / 批量分章补填）。
  //   与「新增线下课」弹窗（v131 的 #coChapter）同一语义：留空 = 不归章节（不写字段，保持数据干净）。
  const chEl = document.getElementById('caChapter')
  const chapter = (chEl && chEl.value ? String(chEl.value) : '').trim()
  const withChapter = obj => (chapter ? Object.assign({}, obj, { chapter }) : obj)
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
        }, status === 'draft' ? { status: 'draft' } : null, examGate ? { examGate: true } : null, extra || {}))
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
      await commit(CourseStore.newId('a'), withChapter(extra))
    } else {
      const questions = courseDraft.preview.filter(x => x.checked).map(x => {
        const q = x.q
        return { type: q.type, difficulty: q.difficulty || 1, question: q.question, options: q.options, answer: q.answer, explanation: q.explanation || '' }
      })
      // 草稿允许暂缺题目（稍后编辑补充）；发布时必须有题
      if (status !== 'draft' && !questions.length) { alert(t('courseErrNoQ')); return }
      await commit(CourseStore.newId('a'), withChapter({ questions }))
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
      passScore: a.passScore || 60,
      examGate: !!a.examGate,
      // v129：章节名（一级，连续区间语义）。空串 = 不归属任何章节（散项）。
      chapter: a.chapter || ''
    },
    // v129：视频作业没有 questions（用的是 quiz[]），此处刻意保持空数组，
    //   由 courseSaveAssignEdit 的 video 分支跳过题目写入 —— 否则会把 quiz 作业的
    //   questions 写成 []，而 video 的判分走 quiz，等于把该作业掏空。
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
  // v120：作业类型下拉（题型下拉在题目卡片内单独渲染，勿与上面混用）
  const assignTypeOpts = ['homework', 'exam', 'coursefinal', 'video']
    .map(v => `<option value="${v}">${v === 'coursefinal' ? '📕 ' : ''}${ASSIGN_TYPE_LABELS[v] || v}</option>`).join('')

  const deadlineStr = m.meta.deadline
    ? new Date(m.meta.deadline).toISOString().slice(0, 16)
    : ''

  const qCards = m.questions.map((q, i) => courseRenderEditQCard(q, i)).join('')

  courseModalOpen(t('courseEditTitle'), `
    <h4 style="margin:0 0 8px;color:#374151">${t('courseEditMeta')}</h4>
    <div class="form-row2">
      <div class="form-group"><label>${t('courseTypeLabel')} *</label>
        <select id="ceType" onchange="courseEditTypeChange()">${assignTypeOpts}</select></div>
      <div class="form-group"><label>${t('courseTitlePh')} *</label>
        <input type="text" id="ceTitle" value="${escAttr(m.meta.title)}" /></div>
    </div>
    <div class="form-group"><label>${t('courseDescPh')}</label>
      <input type="text" id="ceDesc" value="${escAttr(m.meta.desc)}" /></div>
    <div class="form-group"><label>🏷️ ${t('courseChapterLabel')}</label>
      <input type="text" id="ceChapter" value="${escAttr(m.meta.chapter)}" placeholder="${escAttr(t('courseChapterPh'))}" list="ceChapterList" />
      <datalist id="ceChapterList">${courseChapterOptionsHtml(m.cid)}</datalist>
      <p class="form-hint" style="margin:4px 0 0">${t('courseChapterHint')}</p></div>
    <div class="form-row2">
      <div class="form-group"><label>${t('courseDeadlineLabel')}</label>
        <input type="datetime-local" id="ceDeadline" value="${deadlineStr}" /></div>
      <div class="form-group" id="ceExamOnly"><label>${t('courseDurationLabel')}</label>
        <input type="number" id="ceDuration" min="1" max="180" value="${m.meta.duration || 20}" /></div>
    </div>
    <div class="form-group" id="cePassGroup"><label>${t('coursePassLabel')}</label>
      <input type="number" id="cePass" min="0" max="100" value="${m.meta.passScore || 60}" /></div>
    <div class="form-group" id="ceGateGroup" style="display:none">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500">
        <input type="checkbox" id="ceExamGate" ${m.meta.examGate ? 'checked' : ''} /> <span>🔒 ${t('courseExamGateLabel')}</span></label>
      <p class="form-hint" style="margin:4px 0 0">${t('courseExamGateHint')}</p>
    </div>
    <div class="form-group" id="ceFinalGateGroup" style="display:none">
      <p class="form-hint" style="margin:4px 0 0;padding:10px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;color:#92400e">
        🔒 ${t('courseFinalGateHint')}</p>
    </div>

    <div id="ceQSection" style="${m.meta.type === 'video' ? 'display:none' : ''}">
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />
    <h4 style="margin:0 0 8px;color:#374151">${t('courseEditQuestions')}</h4>
    <p class="form-hint" id="ceVideoHint" style="margin:0 0 10px;display:${m.meta.type === 'video' ? 'block' : 'none'};padding:10px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;color:#1d4ed8">🎬 ${t('courseEditVideoHint')}</p>
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
    </div>
  `,
    `<button class="btn btn-primary" onclick="courseSaveAssignEdit()">${t('courseEditSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)

  // 设置 select 值
  const typeSel = document.getElementById('ceType')
  if (typeSel) {
    typeSel.value = m.meta.type
    typeSel.onchange = null   // 改用 onchange 属性 courseEditTypeChange（见模板），避免双绑定
  }
  courseEditToggleExamFields()
}

// v120：编辑弹窗切换作业类型时同步 meta（供保存时读取）并刷新字段显隐
function courseEditTypeChange() {
  const sel = document.getElementById('ceType')
  if (sel && courseEditAssign) courseEditAssign.meta.type = sel.value
  courseEditToggleExamFields()
}

function courseEditToggleExamFields() {
  const type = courseEditAssign.meta.type
  const dur = document.getElementById('ceExamOnly')
  const pass = document.getElementById('cePassGroup')
  const gate = document.getElementById('ceGateGroup')
  const finalGate = document.getElementById('ceFinalGateGroup')
  const examLike = type === 'exam' || type === 'coursefinal'
  if (dur) dur.style.display = examLike ? '' : 'none'
  if (pass) pass.style.display = examLike ? '' : 'none'
  if (gate) gate.style.display = type === 'exam' ? '' : 'none'
  if (finalGate) finalGate.style.display = type === 'coursefinal' ? '' : 'none'
  // v129：视频作业无 questions（判分走 quiz[]）→ 题目编辑区整块隐藏，改由「改课后小测」入口维护。
  //   不隐藏的话管理员会以为「题目没了」，而且误操作保存会把 quiz 作业的 questions 写成空。
  const qSection = document.getElementById('ceQSection')
  if (qSection) qSection.style.display = type === 'video' ? 'none' : ''
  const vHint = document.getElementById('ceVideoHint')
  if (vHint) vHint.style.display = type === 'video' ? 'block' : 'none'
}

// v129：章节名候选（datalist）——列出该班级已用过的章节，方便复用同名而不是打错字
//   （同一个章节名只要拼写不同就是两个章节，故用候选列表降低出错概率）
function courseChapterOptionsHtml(cid) {
  try {
    const c = courseFind(cid)
    if (!c) return ''
    const seen = []
    ;(c.assignments || []).forEach(a => {
      const ch = String(a.chapter == null ? '' : a.chapter).trim()
      if (ch && seen.indexOf(ch) < 0) seen.push(ch)
    })
    return seen.map(ch => `<option value="${escAttr(ch)}"></option>`).join('')
  } catch (e) { return '' }
}

// ====== v131：批量设置章节 ======
// 场景：一个班往往十几个作业，逐个开编辑弹窗填章节太慢。
// 语义：勾选若干作业 → 一键设为同一章节（或清空归属）。
//   ★ 只写 a.chapter，绝不碰其它字段（尤其不碰 video 的 quiz / exam 的 examGate 与放行名单）。
//   ★ 幂等：重复提交同一章节名结果一致。
let courseBulkChapterSel = null   // Set<assignmentId>（用数组存，便于 JSON 序列化到 data-*）

function courseBulkChapterModal(cid) {
  const c = courseFind(cid)
  if (!c) return
  const list = c.assignments || []
  if (!list.length) { alert(t('courseChapterBulkEmpty')); return }
  courseBulkChapterSel = list.map(a => a.id)   // 默认全选（多数场景是「把这批都归到一章」）
  courseRenderBulkChapterModal(cid)
}

function courseRenderBulkChapterModal(cid) {
  const c = courseFind(cid)
  if (!c) return
  const list = c.assignments || []
  const sel = courseBulkChapterSel || []
  const isAllSel = sel.length === list.length && list.length > 0
  const rows = list.map((a, i) => {
    const ch = String(a.chapter == null ? '' : a.chapter).trim()
    const kind = a.type === 'offline' ? t('courseTypeOffline')
      : a.type === 'video' ? t('courseTypeVideo')
        : a.type === 'coursefinal' ? t('courseTypeCourseFinal')
          : a.type === 'exam' ? t('courseTypeExam') : t('courseTypeHomework')
    return `<label class="cbc-row">
      <input type="checkbox" class="cbc-chk" data-aid="${escAttr(a.id)}"${sel.indexOf(a.id) >= 0 ? ' checked' : ''}
        onchange="courseBulkChapterToggle(this)" />
      <span class="cbc-ord">${i + 1}</span>
      <span class="cbc-title">${escHtml(a.title)}</span>
      <span class="cbc-kind">${escHtml(kind)}</span>
      <span class="cbc-ch">${ch ? '📚 ' + escHtml(ch) : '<i>' + t('courseChapterNoneShort') + '</i>'}</span>
    </label>`
  }).join('')

  courseModalOpen(t('courseChapterBulkTitle'), `
    <p class="form-hint" style="margin:0 0 10px">${t('courseChapterBulkHint')}</p>
    <div class="cbc-toolbar">
      <button class="btn btn-ghost btn-sm" onclick="courseBulkChapterAll(true)">${t('courseChapterBulkAll')}</button>
      <button class="btn btn-ghost btn-sm" onclick="courseBulkChapterAll(false)">${t('courseChapterBulkNone')}</button>
      <span class="cbc-count" id="cbcCount">${t('courseChapterBulkPicked', sel.length)}</span>
    </div>
    <div class="cbc-list">${rows}</div>
    <div class="form-group" style="margin-top:14px"><label>🏷️ ${t('courseChapterBulkTarget')}</label>
      <input type="text" id="cbcName" placeholder="${escAttr(t('courseChapterPh'))}" list="cbcChapterList"
        onkeydown="if(event.key==='Enter')courseBulkChapterDo('${escAttr(cid)}')" />
      <datalist id="cbcChapterList">${courseChapterOptionsHtml(cid)}</datalist>
      <p class="form-hint" style="margin:4px 0 0">${t('courseChapterBulkTargetHint')}</p></div>
  `,
    `<button class="btn btn-primary" onclick="courseBulkChapterDo('${escAttr(cid)}')">${t('courseEditSave')}</button>
     <button class="btn btn-ghost" onclick="courseModalClose()">${t('cancelBtn')}</button>`)
}

function courseBulkChapterToggle(el) {
  const aid = el && el.dataset ? el.dataset.aid : ''
  if (!aid) return
  const sel = courseBulkChapterSel || []
  const i = sel.indexOf(aid)
  if (el.checked) { if (i < 0) sel.push(aid) }
  else if (i >= 0) sel.splice(i, 1)
  courseBulkChapterSel = sel
  const cnt = document.getElementById('cbcCount')
  if (cnt) cnt.textContent = t('courseChapterBulkPicked', sel.length)
}

function courseBulkChapterAll(on) {
  // ★ 选择器挂在 #courseModal 上（courseModalOpen 里 .modal-body 没有 id，用 #modalBody 会静默查不到）
  const boxes = document.querySelectorAll('#courseModal .cbc-chk')
  const sel = []
  ;(boxes || []).forEach(b => {
    b.checked = !!on
    if (on && b.dataset && b.dataset.aid) sel.push(b.dataset.aid)
  })
  courseBulkChapterSel = sel
  const cnt = document.getElementById('cbcCount')
  if (cnt) cnt.textContent = t('courseChapterBulkPicked', sel.length)
}

async function courseBulkChapterDo(cid) {
  const sel = courseBulkChapterSel || []
  if (!sel.length) { alert(t('courseChapterBulkNoPick')); return }
  const el = document.getElementById('cbcName')
  const name = (el ? el.value : '').trim()
  if (!confirm(t('courseChapterBulkConfirm', sel.length, name || t('courseChapterNoneShort')))) return
  let hit = 0
  try {
    await CourseStore.mutate(doc => {
      const c = CourseStore.findClass(doc, cid)
      if (!c) return false
      ;(c.assignments || []).forEach(a => {
        if (sel.indexOf(a.id) < 0) return
        if (name) a.chapter = name
        else delete a.chapter
        hit++
      })
    })
  } catch (e) { alert(t('courseWriteFail')); return }
  if (!hit) { alert(t('courseChapterBulkFail')); return }
  courseModalClose()
  courseBulkChapterSel = null
  alert(t('courseChapterBulkDone', hit, name || t('courseChapterNoneShort')))
  courseState.doc = await CourseStore.getDoc()
  courseRenderClass()
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
  const chapterEl = document.getElementById('ceChapter')
  const chapter = (chapterEl ? chapterEl.value : '').trim()
  const deadlineRaw = document.getElementById('ceDeadline').value
  const deadline = deadlineRaw ? new Date(deadlineRaw).getTime() : 0
  // v120：最终考试与测评同型（限时 + 及格分），共用读取
  const examLike = type === 'exam' || type === 'coursefinal'
  const duration = examLike ? (Number(document.getElementById('ceDuration').value) || 20) : 0
  const passScore = examLike ? (Number(document.getElementById('cePass').value) || 60) : 60
  // v115 期末考试放行闸门开关（仅 exam）；v120 最终考试的闸门恒开，不写 examGate
  const gateEl = document.getElementById('ceExamGate')
  const examGate = type === 'exam' && !!(gateEl && gateEl.checked)
  if (!title) { alert(t('courseErrTitle')); return }

  // v129：视频作业走「只改元信息」分支 —— 它没有 questions，判分靠 quiz[]。
  //   若照下面通用流程走，questions 会被算成空数组而触发「无有效题目」拦截，
  //   即便放行也会把 a.questions 写成 []，等于掏空该作业（video 的作答/判分全在 quiz）。
  //   故这里只写 title/desc/deadline/chapter，quiz / videoUrl / results 一概不碰。
  if (type === 'video') {
    if (!confirm(t('courseEditConfirm'))) return
    try {
      await CourseStore.mutate(doc => {
        const c = CourseStore.findClass(doc, m.cid)
        const a = CourseStore.findAssign(c, m.aid)
        if (!a) return false
        a.type = 'video'
        a.title = title
        a.desc = desc
        a.deadline = deadline
        if (chapter) a.chapter = chapter
        else delete a.chapter
        // 刻意不动：a.quiz / a.videoUrl / a.results
      })
    } catch (e) { alert(t('courseWriteFail')); return }
    courseModalClose()
    courseEditAssign = null
    alert(t('courseEditSaveOk'))
    courseState.doc = await CourseStore.getDoc()
    try { if (courseState.doc && courseState.doc.classes && typeof Store !== 'undefined' && Store.rebuildBankFromCourse) Store.rebuildBankFromCourse(courseState.doc.classes) } catch (e) { /* ignore */ }
    courseRenderClass()
    return
  }

  // 验证题目：至少 1 道有效题
  const questions = m.questions.map(q => {
    // v107：清理空选项，并按「保留的原始下标」重映射 answer —— 原先只 filter 掉空串却让 answer
    // 沿用旧下标，一旦中间有空槽就会把答案指到别的选项上（判分错位）。
    let options, answer
    if (q.type === 'fill' || q.type === 'translate') {
      options = [String(q.options[0] || '').trim()].filter(Boolean)
      answer = [0]
    } else {
      const keep = visibleOptionIndexes(q.options)
      options = keep.map(i => String(q.options[i] == null ? '' : q.options[i]).trim())
      const map = new Map(keep.map((oi, ni) => [oi, ni]))
      answer = (Array.isArray(q.answer) ? q.answer : [])
        .map(a => map.get(a))
        .filter(ni => ni !== undefined)
    }
    return {
      type: q.type,
      difficulty: q.difficulty || 1,
      question: String(q.question || '').trim(),
      options,
      answer,
      explanation: String(q.explanation || '').trim()
    }
  }).filter(q => q.question && q.options.length >= (q.type === 'judge' ? 2 : 1) && q.answer.length >= 1)
  if (!questions.length) { alert(t('courseEditNoQ')); return }
  // v147 Bug3：改题影响预警。已有成绩的记录带着「当时考了几题」（r.total）与错题下标（r.qn），
  //   题数一变，这些成绩就再也无法与当前题目对齐 —— 分数不可比、错题回顾直接失效
  //   （courseReviewPending 遇 qn 不一致会静默按「视为完成」处理，管理员完全无感）。
  //   这里在**保存前**把影响面摆出来，让管理员自己决定是「接受失真」还是「先重置那批成绩」。
  {
    const oldA = courseFindAssign(m.cid, m.aid)
    const oldN = oldA && Array.isArray(oldA.questions) ? oldA.questions.length : 0
    const newN = questions.length
    const oldSet = JSON.stringify((oldA && oldA.questions || []).map(q => String(q.question || '').trim() + '|' + String(q.type || 'single')))
    const newSet = JSON.stringify(questions.map(q => String(q.question || '').trim() + '|' + String(q.type || 'single')))
    const affected = Object.keys((oldA && oldA.results) || {}).filter(u => {
      const r = oldA.results[u]
      return r && (Number(r.total) !== newN || (r.qn != null && Number(r.qn) !== newN))
    }).length
    if (affected > 0 && (oldN !== newN || oldSet !== newSet)) {
      if (!confirm(t('courseEditStaleWarn', affected, oldN, newN))) return
    }
  }
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
      // v115：期末考试放行闸门开关。examOpened（已放行名单）刻意保留不清 ——
      // 关闭再重开闸门时旧放行仍有效（破坏性操作宁可不清）。
      if (examGate) a.examGate = true
      else delete a.examGate
      a.questions = questions
      // v129：章节归属（空 = 清除归属，回落到「散项」）
      if (chapter) a.chapter = chapter
      else delete a.chapter
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
