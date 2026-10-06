// test-v129-admin-round-edit-video-chapter.js — v129 三项管理端能力
// ① 需求1 营次日期可手动编辑：建了就能改（原来是「只能删了重建」）
//    - app.js 操作列接线 dashEditRoundBtnHtml（含 data-rid + onclick 到 this 形式）
//    - 弹窗 dashOpenEditRound / 保存 dashSaveRoundEdit → CloudSync.setChallengeRound(id, patch)
//    - 时间戳 ↔ datetime-local 互逆（dashTsToLocalDT vs dashParseLocalDT）
//    - 编辑表单的部门勾选取值只作用于编辑容器（dashPickedEditDepts，避免与新建表单串味）
// ② 需求2 视频作业可改名（完整编辑入口）
//    - 视频作业行新增通用「编辑」按钮（courseEditAssignModal）
//    - ★ 关键保护：保存时 video 走独立分支，只写 title/desc/deadline/chapter，
//      绝不写 a.questions（视频判分走 quiz[]，写 questions 会把作业掏空）
//    - 编辑弹窗对 video 隐藏题目区（ceQSection + ceVideoHint 同步显隐）
// ③ 需求3 章节分块（一级、连续区间语义）
//    - assignment.chapter 可选字段；空 = 不归章节
//    - 学员端 courseStudentPathHtml 按章节名变化插分节头 + 分块容器
//    - ★ 严禁在分块相关产物里出现 'cp-side' 子串（保护 test-v53 sliceBetween）
//    - 管理端 courseRenderClass 插 tr.chapter-sep，且 data-drag-idx 仍为真实下标
//    - 章节改名批量处理 courseChapterRenameDo
// ④ i18n：21 个新键 zh/en 成对
// ⑤ CSS：分块样式 + 分块后首节点补间距 + 章节分隔行样式
// ⑥ 版本弹性：唯一 ?v=N ×12 且 ≥129

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
const CA = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')

let failed = 0
function assert(name, cond, extra) {
  if (cond) { console.log('✓ ' + name) }
  else { failed++; console.log('✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}

function extractFn(src, name) {
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) throw new Error('fn not found: ' + name)
  const start = m.index + m[1].length
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// ========== ① 营次日期编辑（需求1） ==========
console.log('\n[1] 营次日期可手动编辑')

const editBtn = extractFn(APP, 'dashEditRoundBtnHtml')
assert('1.1 编辑按钮有 data-rid 与 onclick(this)（不把值拼进 JS 字面量）',
  editBtn.includes('data-rid=') && editBtn.includes('onclick="dashOpenEditRound(this)"'))
assert('1.2 编辑按钮走 i18n 键 dashRoundEdit', editBtn.includes("t('dashRoundEdit')"))

const panel = extractFn(APP, 'dashRoundsPanelHtml')
assert('1.3 编辑按钮已接进营次表操作列（接线断言，不只是函数存在）',
  panel.includes('${dashEditRoundBtnHtml(r)}'))
assert('1.4 操作列顺序：查看 → 编辑 → 设为当前 → 删除',
  panel.indexOf('dashViewRound(this)') < panel.indexOf('dashEditRoundBtnHtml(r)') &&
  panel.indexOf('dashEditRoundBtnHtml(r)') < panel.indexOf('dashSetRoundCur(this)') &&
  panel.indexOf('dashSetRoundCur(this)') < panel.indexOf('dashDelRound(this)'))

const openEdit = extractFn(APP, 'dashOpenEditRound')
assert('1.5 编辑弹窗回填名称 + 起止时间（dashTsToLocalDT）',
  openEdit.includes('dashEditRoundName') && openEdit.includes('dashEditRoundStart') &&
  openEdit.includes('dashEditRoundEnd') && openEdit.includes('dashTsToLocalDT(rec.startAt)') &&
  openEdit.includes('dashTsToLocalDT(rec.endAt)'))
assert('1.6 编辑弹窗回填部门（dashDeptOptionsHtml(rec.depts || [])）',
  openEdit.includes('dashDeptOptionsHtml(rec.depts || [])'))
assert('1.7 编辑表单的部门候选放在独立容器（供 dashPickedEditDepts 精确取值）',
  openEdit.includes('dashEditRoundDeptBox'))

const saveEdit = extractFn(APP, 'dashSaveRoundEdit')
assert('1.8 保存调用 CloudSync.setChallengeRound(rid, patch)', saveEdit.includes('CloudSync.setChallengeRound(rid, { name, startAt, endAt, depts })'))
assert('1.9 保存前校验「结束晚于开始」（与新建同口径）', saveEdit.includes('endAt <= startAt') && saveEdit.includes("t('dashRoundCreateFail')"))
assert('1.10 保存成功后清空编辑态并整块重绘看板',
  saveEdit.includes("_dashEditRoundId = ''") && saveEdit.includes('renderDashboard()'))
assert('1.11 保存失败给出提示且按钮复位（不静默失败）',
  saveEdit.includes("t('dashRoundEditFail')") && saveEdit.includes('btn.disabled = false'))

const pickEdit = extractFn(APP, 'dashPickedEditDepts')
assert('1.12 编辑态部门取值限定在编辑容器内（不误取新建表单的勾选）',
  pickEdit.includes("querySelector('.dashEditRoundDeptBox')") && pickEdit.includes('input[type=checkbox]'))
assert('1.13 新建态的 dashPickedDepts 仍是全局 .dashRoundDept（未被改动）',
  extractFn(APP, 'dashPickedDepts').includes("querySelectorAll('.dashRoundDept')"))

// 时间戳互逆：真跑
{
  const APP2 = APP
  const sb = { console, Date, String, Number, Math, isNaN }
  vm.createContext(sb)
  vm.runInContext(extractFn(APP2, 'dashTsToLocalDT'), sb)
  vm.runInContext(extractFn(APP2, 'dashParseLocalDT'), sb)
  sb.tsToLocal = vm.runInContext('(ts) => dashTsToLocalDT(ts)', sb)
  sb.parseLocal = vm.runInContext('(v) => dashParseLocalDT(v)', sb)
  assert('1.14 dashTsToLocalDT(0) = 空串（未设时间显示为空，不显示 1970）', sb.tsToLocal(0) === '')
  assert('1.15 dashParseLocalDT(空) = 0', sb.parseLocal('') === 0)
  const t0 = new Date(2026, 8, 30, 14, 5).getTime()
  const round = sb.parseLocal(sb.tsToLocal(t0))
  assert('1.16 时间戳 → datetime-local → 时间戳 往返一致（同一分钟）',
    Math.abs(round - t0) < 60 * 1000, sb.tsToLocal(t0) + ' vs ' + t0)
  assert('1.17 datetime-local 输出格式为 yyyy-MM-ddTHH:mm', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sb.tsToLocal(t0)), sb.tsToLocal(t0))
  assert('1.18 非法输入返回 0 而非 NaN（防写入脏时间戳）', sb.parseLocal('not-a-date') === 0 && Number.isNaN(sb.parseLocal('xyz')) === false)
}

// ========== ② 视频作业改名（需求2） ==========
console.log('\n[2] 视频作业可改名（完整编辑入口）')

assert('2.1 视频作业行新增通用编辑按钮（courseEditAssignModal）',
  /isVideo[\s\S]{0,700}courseEditAssignModal\('\$\{escAttr\(c\.id\)\}','\$\{escAttr\(a\.id\)\}'\)/.test(CA))
assert('2.2 视频作业原有的两个专用入口未被删除（改视频地址 + 改课后小测）',
  CA.includes('courseEditVideoUrlModal(') && CA.includes('courseEditQuizModal('))

const saveAssign = extractFn(CA, 'courseSaveAssignEdit')
assert('2.3 ★ video 走独立分支（在通用 questions 校验之前 return）',
  /if \(type === 'video'\)[\s\S]{0,2200}?return\s*\n\s*\}/.test(saveAssign) ||
  (saveAssign.indexOf("if (type === 'video')") > 0 && saveAssign.indexOf("if (type === 'video')") < saveAssign.indexOf('if (!questions.length)')),
  'video 分支应在「无有效题目」拦截之前')
assert('2.4 ★ video 分支绝不写 a.questions（防掏空作业）',
  (() => {
    const i = saveAssign.indexOf("if (type === 'video')")
    const j = saveAssign.indexOf('// 验证题目：至少 1 道有效题')
    if (i < 0 || j < 0 || j < i) return false
    return saveAssign.slice(i, j).indexOf('a.questions') < 0
  })(), 'video 分支内不应出现 a.questions')
assert('2.5 ★ video 分支明确保留 quiz / videoUrl（注释声明 + 无赋值语句）',
  (() => {
    const i = saveAssign.indexOf("if (type === 'video')")
    const j = saveAssign.indexOf('// 验证题目：至少 1 道有效题')
    const seg = saveAssign.slice(i, j)
    return seg.includes('a.quiz') && seg.includes('a.videoUrl') && !/a\.quiz\s*=/.test(seg) && !/a\.videoUrl\s*=/.test(seg)
  })())
assert('2.6 video 分支仍原子化写 title/desc/deadline/chapter',
  (() => {
    const i = saveAssign.indexOf("if (type === 'video')")
    const j = saveAssign.indexOf('// 验证题目：至少 1 道有效题')
    const seg = saveAssign.slice(i, j)
    return seg.includes('a.title = title') && seg.includes('a.desc = desc') && seg.includes('a.deadline = deadline') && seg.includes("a.chapter = chapter")
  })())
assert('2.7 video 分支强制 type 为 video（防被类型下拉改成别的型）', saveAssign.includes("a.type = 'video'"))
assert('2.8 video 分支有确认弹窗与写失败提示', saveAssign.includes("t('courseEditConfirm')") && saveAssign.includes("t('courseWriteFail')"))

const toggle = extractFn(CA, 'courseEditToggleExamFields')
assert('2.9 编辑弹窗对 video 隐藏题目区（ceQSection）', toggle.includes("qSection.style.display = type === 'video' ? 'none' : ''"))
assert('2.10 同时对 video 显示「无题目」说明（ceVideoHint）', toggle.includes("vHint.style.display = type === 'video' ? 'block' : 'none'"))
assert('2.11 弹窗模板里 ceQSection 包裹了题目编辑块（自题目区起、到「添加题目」按钮后闭合）',
  (() => {
    const open = CA.indexOf('id="ceQSection"')
    if (open < 0) return false
    const aiBox = CA.indexOf('id="ceAiBox"', open)
    const qList = CA.indexOf('id="ceQList"', open)
    const addBtn = CA.indexOf('courseEditAddQ()', open)
    if (aiBox < 0 || qList < 0 || addBtn < 0) return false
    // 顺序：ceQSection 开 → ceAiBox → ceQList → 添加题目按钮
    if (!(open < aiBox && aiBox < qList && qList < addBtn)) return false
    // 闭合形态（已核对真实字节）：…</button>\n    </div>\n  `,\n    `<button …courseSaveAssignEdit
    const after = CA.slice(addBtn, addBtn + 200)
    return after.indexOf('</button>') > 0 && after.indexOf('</div>') > after.indexOf('</button>') &&
      after.indexOf('courseSaveAssignEdit') > after.indexOf('</div>')
  })(), 'ceQSection 应包住 AI 出题 + 题目列表，并在「添加题目」按钮后闭合')

// ========== ③ 章节分块（需求3） ==========
console.log('\n[3] 章节分块（一级、连续区间）')

assert('3.1 学员端章节分节头使用 cp-chapter-head（与 cp-node/cp-list 契约不冲突）',
  extractFn(CA, 'courseStudentPathHtml').includes('cp-chapter-head'))
assert('3.2 学员端分块容器使用 cp-chapter-body', extractFn(CA, 'courseStudentPathHtml').includes('cp-chapter-body'))
assert('3.3 ★ 章节相关产物里不含 cp-side 子串（保护 test-v53 的 sliceBetween 切片）',
  (() => {
    const body = extractFn(CA, 'courseStudentPathHtml')
    // 允许出现的唯一 cp-side 是右侧详情栏 itself（cp-side / cp-side-count 等），
    // 但章节分节头/分块容器的类名不得含该前缀
    return body.indexOf('cp-chapter-side') < 0 && body.indexOf('cp-side-chapter') < 0 && body.indexOf('chapter-cp-side') < 0
  })())
assert('3.4 学员端章节头含名称与完成度（courseChapterDoneOf）',
  extractFn(CA, 'courseStudentPathHtml').includes('cp-chapter-name') &&
  extractFn(CA, 'courseStudentPathHtml').includes('cp-chapter-count') &&
  extractFn(CA, 'courseStudentPathHtml').includes("t('courseChapterDoneOf'"))
assert('3.5 章节名走 escHtml（防注入）',
  /cp-chapter-name">📚 \$\{escHtml\(chName\)\}/.test(extractFn(CA, 'courseStudentPathHtml')))
assert('3.6 ★ cp-node 类名模板保留 done/next 条件类（v148 追加 ${gCls} 等待放行态）',
  /class="cp-node\$\{d \? ' done' : ''\}\$\{isNext \? ' next' : ''\}\$\{gCls\}"/.test(extractFn(CA, 'courseStudentPathHtml')))

const stat = extractFn(CA, 'courseChapterStat')
assert('3.7 courseChapterStat 按 chapter 精确匹配统计（trim 归一）',
  stat.includes('String(a.chapter == null') && stat.includes('.trim() !== chName') && stat.includes('courseTaskDone'))

// 沙箱真跑：分组逻辑
function mkSandbox() {
  const sb = {
    // v134：本函数新增「章节开关」依赖 —— 这些用例验的是其它行为，故注入「全部已开放」桩，
    //   保持所有章节展开渲染（章节关闭态由 test-v134-chapter-switch.js 专门覆盖）。
    courseChapterOpened: () => true,
    console, JSON, Object, Array, String, Number, Math, Promise, Date, LANG: 'zh',
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escAttr: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    t: (k, ...a) => a.length ? k + ':' + a.join(',') : k,
    courseTaskDone: (a, res) => !!(res && res.done),
    courseTaskIcon: a => ({ video: '🎬', exam: '🧪', coursefinal: '📕', offline: '📅' }[a && a.type] || '📝'),
    courseIsOffline: a => !!(a && a.type === 'offline'),
    courseIsFinal: a => !!(a && a.type === 'coursefinal'),
    courseOfflineWhen: a => (a && a.date ? 'WHEN' : 'courseUnlimited'),
  }
  vm.createContext(sb)
  vm.runInContext(extractFn(CA, 'courseTaskKindLabel'), sb)
  vm.runInContext(extractFn(CA, 'courseTaskMetaText'), sb)
  vm.runInContext(extractFn(CA, 'courseChapterStat'), sb)
  vm.runInContext(extractFn(CA, 'courseResetRecSafe'), sb)       // v147：渲染侧台账读取（自包含）
  vm.runInContext(extractFn(CA, 'courseRetryUsedSafe'), sb)      // v147：同上
  vm.runInContext(extractFn(CA, 'courseGateWaitFor'), sb)        // v148：等待放行判定（渲染链新增调用）
  vm.runInContext(extractFn(CA, 'courseStudentPathHtml'), sb)
  return sb
}
function mkAssign(id, title, done, extra) {
  return Object.assign({ id, type: 'homework', title, questions: [1], results: done ? { stu1: { done: true, score: 90 } } : {} }, extra || {})
}

// 场景A：三章（2 + 1 + 2），中间夹一个无章节项
{
  const sb = mkSandbox()
  const asg = [
    mkAssign('a1', '第一课', true, { chapter: '第一章' }),
    mkAssign('a2', '第二课', true, { chapter: '第一章' }),
    mkAssign('a3', '散项一', false),
    mkAssign('a4', '第三课', false, { chapter: '第二章' }),
    mkAssign('a5', '第四课', false, { chapter: '第二章' }),
  ]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")',
    Object.assign(sb, { myClasses: [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: asg }] }))
  assert('3.8 场景A：两个章节头（第一章 / 第二章）', out.split('cp-chapter-head').length - 1 === 2, out.split('cp-chapter-head').length - 1)
  assert('3.9 场景A：章节名正确渲染', out.includes('第一章') && out.includes('第二章'))
  assert('3.10 场景A：v123/v128 契约仍成立（done 2 处 / next 1 处）',
    out.split('class="cp-node done"').length - 1 === 2 && out.split('class="cp-node next"').length - 1 === 1,
    (out.split('class="cp-node done"').length - 1) + '/' + (out.split('class="cp-node next"').length - 1))
  assert('3.11 场景A：v128 角标仍在（ok 2 / doing 1）',
    out.split('class="cp-flag ok"').length - 1 === 2 && out.split('class="cp-flag doing"').length - 1 === 1)
  assert('3.12 场景A：cp-meta 每行一条（5 行）', out.split('class="cp-meta"').length - 1 === 5, out.split('class="cp-meta"').length - 1)
  assert('3.13 ★ 场景A：首个 cp-side 仍在所有行之后（v53 切片不被截断）',
    out.indexOf('cp-side') > out.lastIndexOf('cp-meta'))
  assert('3.14 场景A：分块容器数量 = 章节数 + 散项段（3 段）', out.split('cp-chapter-body').length - 1 === 3, out.split('cp-chapter-body').length - 1)
  assert('3.15 场景A：章节头出现顺序为「第一章 → 第二章」', out.indexOf('第一章') < out.indexOf('第二章'))
}

// 场景B：完全无章节 → 不出现章节头（向后兼容：老数据不受影响）
{
  const sb = mkSandbox()
  const asg = [mkAssign('a1', '一', true), mkAssign('a2', '二', false)]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")',
    Object.assign(sb, { myClasses: [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: asg }] }))
  assert('3.16 ★ 场景B：无章节数据不渲染任何章节头（老班级零视觉变化）',
    out.indexOf('cp-chapter-head') < 0, out.split('cp-chapter-head').length - 1)
  assert('3.17 场景B：仍包一层散项容器（结构统一）', out.split('cp-chapter-plain').length - 1 === 1)
  assert('3.18 场景B：两个节点仍在', out.split('class="cp-node').length - 1 === 2)
}

// 场景C：同名章节不相邻 → 渲染为两个独立分块（连续区间语义）
{
  const sb = mkSandbox()
  const asg = [
    mkAssign('a1', '一', true, { chapter: '甲' }),
    mkAssign('a2', '二', false, { chapter: '乙' }),
    mkAssign('a3', '三', false, { chapter: '甲' }),
  ]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")',
    Object.assign(sb, { myClasses: [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: asg }] }))
  assert('3.19 ★ 场景C：同名但不相邻 = 各自成块（连续区间语义；甲→乙→甲 共 3 块，不跨越合并）',
    out.split('cp-chapter-head').length - 1 === 3, out.split('cp-chapter-head').length - 1)
}

// 场景D：章节完成度统计（第一章 2 项里 1 项完成）
{
  const sb = mkSandbox()
  const asg = [
    mkAssign('a1', '一', true, { chapter: '第一章' }),
    mkAssign('a2', '二', false, { chapter: '第一章' }),
  ]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")',
    Object.assign(sb, { myClasses: [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: asg }] }))
  assert('3.20 场景D：章节头完成度 = courseChapterDoneOf:1,2',
    out.includes('courseChapterDoneOf:1,2'), (out.match(/courseChapterDoneOf:[^<]*/g) || []).join(' | '))
}

// 场景E：chapter 存在空白/大小写差异 → trim 后可归并
{
  const sb = mkSandbox()
  const asg = [
    mkAssign('a1', '一', true, { chapter: '第一章' }),
    mkAssign('a2', '二', false, { chapter: '  第一章  ' }),
  ]
  const out = vm.runInContext('courseStudentPathHtml(myClasses, "stu1")',
    Object.assign(sb, { myClasses: [{ id: 'c1', name: 'A班', members: ['stu1'], assignments: asg }] }))
  assert('3.21 场景E：章节名首尾空白被 trim → 归为同一章（1 个章节头）',
    out.split('cp-chapter-head').length - 1 === 1, out.split('cp-chapter-head').length - 1)
}

// 管理端：分节行 + data-drag-idx 真实下标
console.log('\n[3b] 管理端章节分块与拖拽共存')
const renderClass = extractFn(CA, 'courseRenderClass')
// [v134 反转] v134 给分节行加了「开放/关闭」态 class（chapter-sep 后拼 chapter-sep-locked），
//   故这里不再能匹配 `class="chapter-sep"` 这个精确字面量；改为匹配类名模板的开头，
//   并新增一条反向断言：分节行仍然存在（不是整块被删）。
assert('3.22 [v134 反转] 管理端渲染章节分隔行 tr.chapter-sep',
  /class="chapter-sep\$\{/.test(renderClass) && renderClass.includes('chapter-sep-plain'),
  '分节行类名模板已改为带动态态（chapter-sep${...}）+ 散项行保留')
assert('3.23 ★ 分节行与作业行分开累加（assignRows += 而非 return 覆盖）',
  renderClass.includes('assignRows += `<tr${isDraft'), '作业行必须累加，否则会覆盖掉章节行')
assert('3.24 ★ 作业行 data-drag-idx 仍是 assignments 的真实下标 idx',
  renderClass.includes('data-drag-idx="${idx}"'))
assert('3.25 分节行本身不带拖拽属性（不参与排序）',
  !/class="chapter-sep"[^>]*data-drag-idx/.test(CA))
assert('3.26 分节行提供章节改名入口（courseChapterRenameModal）',
  renderClass.includes('courseChapterRenameModal('))
assert('3.27 无章节时管理端也提示「未归入章节」', renderClass.includes('chapter-sep-plain'))
assert('3.28 分节行 colspan=8 覆盖全表列数', /class="chapter-sep"[^>]*>\s*<td colspan="8"/.test(CA) || renderClass.includes('<td colspan="8">'))

const rename = extractFn(CA, 'courseChapterRenameDo')
assert('3.29 章节改名批量作用于同章全部作业', rename.includes('forEach') && rename.includes("!== oldName") && rename.includes('a.chapter = next'))
assert('3.30 章节改名留空 = 清除归属（delete a.chapter）', rename.includes('delete a.chapter'))
assert('3.31 章节改名有二次确认（带参数调用，故断言键名出现而非完整字面量）',
  rename.includes("t('courseChapterRenameConfirm'"))

// 编辑弹窗章节字段
assert('3.32 编辑弹窗有章节输入框 ceChapter + 候选 datalist',
  CA.includes('id="ceChapter"') && CA.includes('id="ceChapterList"') && CA.includes('courseChapterOptionsHtml('))
assert('3.33 courseChapterOptionsHtml 从该班级已有作业收集候选（去重）',
  extractFn(CA, 'courseChapterOptionsHtml').includes('seen.indexOf(ch) < 0'))
assert('3.34 编辑保存写入 a.chapter（有则写、无则删）',
  saveAssign.includes('if (chapter) a.chapter = chapter') && saveAssign.includes('delete a.chapter'))
assert('3.35 弹窗 meta 深拷贝含 chapter', CA.includes("chapter: a.chapter || ''"))

// ========== ④ i18n ==========
console.log('\n[4] i18n 键成对')
const NEW_KEYS = ['dashRoundEdit', 'dashRoundEditTitle', 'dashRoundEditSave', 'dashRoundEditSaved',
  'dashRoundEditFail', 'dashRoundEditScheduleHint', 'courseEditVideoHint', 'courseChapterLabel',
  'courseChapterPh', 'courseChapterHint', 'courseChapterDoneOf', 'courseChapterItemCount',
  'courseChapterRename', 'courseChapterRenameTitle', 'courseChapterCurrent', 'courseChapterNewName',
  'courseChapterRenameHint', 'courseChapterRenameConfirm', 'courseChapterRenamed',
  'courseChapterNone', 'courseChapterNoneShort']
let unpaired = []
NEW_KEYS.forEach(k => {
  const n = (I18N.match(new RegExp('(^|[\\s{,])' + k + '\\s*:', 'g')) || []).length
  if (n !== 2) unpaired.push(k + '(' + n + ')')
})
assert('4.1 全部 21 个新键 zh/en 成对', unpaired.length === 0, unpaired.join(', '))
assert('4.2 新键全部有实际调用方（不只是定义了没人用）',
  APP.includes("t('dashRoundEdit')") && APP.includes("t('dashRoundEditSaved'") &&
  CA.includes("t('courseChapterDoneOf'") && CA.includes("t('courseChapterRename'") &&
  CA.includes("t('courseEditVideoHint')") && CA.includes("t('courseChapterItemCount'"))

// ========== ⑤ CSS ==========
console.log('\n[5] CSS 契约')
assert('5.1 学员端章节头样式 cp-chapter-head 就位', CSS.includes('.cp-chapter-head {'))
// ★ 契约已被 v133 显式推翻并重写（原断言：品牌软底 + 品牌深色左条 —— 用户反馈「Episode 部分不显眼」，
//   v133 改为「容器分组卡 + 吸顶章节条」：深色渐变横幅 + 内嵌白底进度条 + position:sticky。
//   反转原因：浅色小字横幅在白卡列表里对比度不足；且旧结构头体平级，sticky 活动范围是整个列表 → 头钉死不动。
//   新契约（此处只断「显著度与吸顶」这一层，结构配平由 test-v133 负责）：
//   ① 章节头必须是 sticky（跟随滚动）② 必须是深色渐变（对比度）③ 名字必须浅色（深底可读）。
assert('5.2 [v133 反转] 章节头 = 吸顶深色渐横幅（旧「品牌软底 + 左条」契约作废）',
  /\.cp-chapter-head\s*\{[^}]*position:sticky/.test(CSS) &&
  /\.cp-chapter-head\s*\{[^}]*linear-gradient/.test(CSS) &&
  /\.cp-chapter-name\s*\{[^}]*color:#fff/.test(CSS))
assert('5.2a [v133] 吸顶偏移随顶栏两档（60px / 56px）',
  /\.cp-chapter-head\s*\{[^}]*top:60px/.test(CSS) &&
  /@media \(max-width:768px\)\s*\{[\s\S]*?\.cp-chapter-head[^}]*top:56px/.test(CSS))
// 旧形态必须已消失（否则等于没换）
assert('5.2b [v133] 旧「品牌软底 90deg 渐变」形态已移除',
  !/\.cp-chapter-head\s*\{[^}]*background:linear-gradient\(90deg, var\(--brand-soft\)/.test(CSS))
assert('5.3 章节名/计数样式就位', CSS.includes('.cp-chapter-name {') && CSS.includes('.cp-chapter-count {'))
assert('5.4 分块容器 cp-chapter-body 就位', CSS.includes('.cp-chapter-body {'))
assert('5.5 ★ 分块后首节点补回间距（.cp-chapter-body > .cp-node:first-child）',
  CSS.includes('.cp-chapter-body > .cp-node:first-child { margin-top:0; }'))
assert('5.6 管理端分隔行样式 tr.chapter-sep 就位', CSS.includes('tr.chapter-sep > td {'))
assert('5.7 无章节提示行样式就位', CSS.includes('tr.chapter-sep-plain > td {'))
// v123/v128 契约保留
assert('5.8 v123 契约保留：cp-grid margin-top:12px + cp-side display:none',
  CSS.includes('.cp-grid { margin-top:12px; }') && /\.cp-side\s*\{\s*display:none;\s*\}/.test(CSS))
assert('5.9 v128 契约保留：分格卡片 + 三态角标',
  CSS.includes('.cp-node + .cp-node { margin-top:8px; }') && CSS.includes('.cp-flag.doing {') && CSS.includes('.cp-flag.ok {'))
assert('5.10 v127 契约保留：拖拽手柄 touch-action:none', CSS.includes('touch-action:none'))

// ========== ⑥ 版本弹性 ==========
console.log('\n[6] 版本弹性')
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('6.1 版本号唯一 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('6.2 版本号 >= 129', uniq.length === 1 && uniq[0] >= 129)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
