// test-v115-course-exam-gate.js —— v115 期末考试「逐人放行」闸门
// 覆盖：courseStart 闸门拦截（含 _recheck 单次重拉）、courseGateRecheck、
//       courseExamGateOpen/Revoke（幂等 / by 管理员 / 撤销）、创建/编辑/复制持久化接线、
//       管理端详情表放行列、学员卡等待态、草稿类型切换联动、i18n zh/en 成对、
//       小程序 take.js 同口径拦截、index.html 版本号。
const fs = require('fs'), path = require('path'), vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const TAKE = fs.readFileSync(path.join(__dirname, '../english-quiz-miniprogram/pages/take/take.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

let failed = 0
function assert(name, cond) {
  if (cond) { console.log('✓ ' + name) } else { failed++; console.log('✗ ' + name) }
}

// extractFn：词边界 + 花括号配平（技能标准实现；兼容 async function 前缀）
function extractFn(src, name) {
  const re = new RegExp('(^|\\n)(async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) throw new Error('fn not found: ' + name)
  const start = m.index + m[1].length   // 保留 'async ' 前缀
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// ---------------- 一、i18n zh/en 成对 ----------------
const GATE_KEYS = ['courseExamGateLabel', 'courseExamGateHint', 'courseExamGateWait', 'courseExamGateWaitTag',
  'courseExamGateWaitHint', 'courseExamGateCol', 'courseExamGateOk', 'courseExamGateNotYet',
  'courseExamGateBtn', 'courseExamGateConfirm', 'courseExamGateRevoke', 'courseExamGateRevokeConfirm']
GATE_KEYS.forEach(k => {
  const n = (I18N.match(new RegExp('(^|[\\s{,])' + k + '\\s*:', 'g')) || []).length
  assert('i18n ' + k + ' zh/en 成对（出现 2 次）', n === 2)
})
assert('i18n zh 标签在', I18N.indexOf('需管理员逐人放行（期末考试）') >= 0)
assert('i18n en 标签在', I18N.indexOf('Per-student admin approval (final exam)') >= 0)

// ---------------- 二、行为沙箱 ----------------
function mkDoc(opts) {
  opts = opts || {}
  const a1 = {
    id: 'a1', type: 'exam', title: '期末考试', desc: '', deadline: 0, duration: 30, passScore: 60,
    questions: [{ type: 'single', difficulty: 1, question: 'Q1', options: ['A', 'B'], answer: [0], explanation: '' }],
    results: {}
  }
  if (opts.examGate) a1.examGate = true
  if (opts.examOpened) a1.examOpened = opts.examOpened
  if (opts.res) a1.results.stu1 = opts.res
  const hw = { id: 'a2', type: 'homework', title: '作业', deadline: 0, duration: 0, passScore: 60,
    questions: a1.questions.slice(), results: {} }
  if (opts.hwGate) hw.examGate = true
  return { classes: [{ id: 'c1', name: 'C1', note: '', createdAt: 1, members: ['stu1', 'stu2'], assignments: [a1, hw] }] }
}

function mkSandbox(doc) {
  const calls = { alert: [], confirm: [], recheck: [], renderTake: 0, renderDetail: [], mutateRet: [] }
  const sb = {
    console, Date, JSON, Math, Object, Array, String, Number, Promise, Set, Map, RegExp, Error, Boolean,
    parseInt, isNaN, setImmediate,
    alert: (m) => calls.alert.push(String(m)),
    confirm: (m) => { calls.confirm.push(String(m)); return !!sb.__confirmYes },
    t: (k) => '[t:' + k + ']',
    LANG: 'zh',
    Store: { getSession: () => sb.__sess },
    courseState: { doc, view: 'assign', classId: 'c1', assignId: 'a1' },
    __sess: { username: 'stu1' },
    __confirmYes: false,
    courseReviewPending: () => false,
    courseStartVideo: () => {},
    courseOfflineInfoModal: () => {},
    courseReviewStart: () => {},
    shuffleOptions: (q) => q,
    courseStartTimer: () => {},
    courseRenderTake: () => { calls.renderTake++ },
    courseAssignDetail: async (cid, aid) => { calls.renderDetail.push([cid, aid]) },
    CourseStore: {
      // course-store.js 的 findClass/findAssign 为单行方法，此处内联等价实现（纯访问器）
      findClass: (d, cid) => ((d && d.classes) || []).find(c => c.id === cid),
      findAssign: (cls, aid) => cls && (cls.assignments || []).find(a => a.id === aid),
      getDoc: async () => sb.courseState.doc,
      mutate: async (fn) => { const r = fn(sb.courseState.doc); calls.mutateRet.push(r); return r !== false }
    },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  }
  sb.window = sb
  vm.createContext(sb)
  // 注入真实函数（course-app.js）
  ;['courseUser', 'courseFind', 'courseFindAssign', 'courseIsOffline', 'courseStart', 'courseGateRecheck',
    'courseExamGateOpen', 'courseExamGateRevoke'].forEach(n => {
    vm.runInContext(extractFn(APP, n), sb)
  })
  return { sb, calls }
}

const WAIT = '[t:courseExamGateWait]'
const CONFIRM_KEY = '[t:courseExamStartConfirm]'

;(async () => {
  // --- courseStart：闸门拦截 ---
  {
    const { sb, calls } = mkSandbox(mkDoc({ examGate: true }))
    let getDocCalls = 0
    const origGet = sb.CourseStore.getDoc
    sb.CourseStore.getDoc = async () => { getDocCalls++; return origGet() }
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('闸门锁定 → 同步阶段不进确认、不渲染答题页', calls.confirm.length === 0 && calls.renderTake === 0)
    // 未带 _recheck → 自动走 courseGateRecheck（异步：先重拉云端再判一次）
    await new Promise(r => setImmediate(r))
    assert('闸门锁定 → 复检后弹等待提示', calls.alert.indexOf(WAIT) >= 0)
    assert('锁定点击触发一次云端复检（重拉 getDoc）', getDocCalls === 1)
    assert('复检仍未放行 → 不进入确认', calls.confirm.length === 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({ examGate: true }))
    vm.runInContext("courseStart('c1','a1', true)", sb)
    assert('带 _recheck 复检仍锁定 → 只弹提示、不再递归复检', calls.alert.indexOf(WAIT) >= 0 && calls.confirm.length === 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({ examGate: true, examOpened: { stu1: { at: 123, by: 'admin1' } } }))
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('已放行学员 → 通过闸门进入确认', calls.confirm.indexOf(CONFIRM_KEY) >= 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({}))   // exam 无闸门
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('未开闸门的普通测评行为不变（直接进入确认）', calls.confirm.indexOf(CONFIRM_KEY) >= 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({ hwGate: true }))
    vm.runInContext("courseStart('c1','a2')", sb)
    assert('闸门只作用于测评：作业即使带 examGate 也照常可作答', calls.renderTake === 1)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({ res: { score: 90, total: 10, correct: 9 } }))
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('已有成绩的测评仍被「仅可作答一次」拦截（原语义不变）', calls.alert.indexOf('[t:courseExamDoneAlert]') >= 0)
  }

  // --- courseGateRecheck：重拉后放行/仍锁定 ---
  {
    const fresh = mkDoc({ examGate: true, examOpened: { stu1: { at: 456, by: 'admin1' } } })
    const { sb, calls } = mkSandbox(mkDoc({ examGate: true }))
    sb.CourseStore.getDoc = async () => fresh   // 管理员刚放行后的新文档
    await vm.runInContext("courseGateRecheck('c1','a1')", sb)
    assert('复检拿到已放行的新文档 → 放行进入确认', calls.confirm.indexOf(CONFIRM_KEY) >= 0)
    assert('复检放行走的是 _recheck 通道（不再递归）', calls.alert.indexOf(WAIT) < 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({ examGate: true }))
    await vm.runInContext("courseGateRecheck('c1','a1')", sb)
    assert('复检仍未放行 → 弹等待提示、不进确认', calls.alert.indexOf(WAIT) >= 0 && calls.confirm.length === 0)
  }

  // --- courseExamGateOpen / courseExamGateRevoke ---
  {
    // 预置 stu1 已放行，验证撤销 stu2 不影响他人
    const { sb, calls } = mkSandbox(mkDoc({ examGate: true, examOpened: { stu1: { at: 1, by: 'boss' } } }))
    sb.__sess.username = 'admin1'
    sb.__confirmYes = true
    await vm.runInContext("courseExamGateOpen('c1','a1','stu2')", sb)
    const a = sb.courseState.doc.classes[0].assignments[0]
    assert('放行写入 examOpened[stu2]', !!(a.examOpened && a.examOpened.stu2))
    assert('放行记录含时间戳与操作管理员', typeof a.examOpened.stu2.at === 'number' && a.examOpened.stu2.by === 'admin1')
    assert('放行后刷新详情页', calls.renderDetail.some(x => x[0] === 'c1' && x[1] === 'a1'))
    const atBefore = a.examOpened.stu2.at
    await vm.runInContext("courseExamGateOpen('c1','a1','stu2')", sb)
    assert('重复放行幂等（mutate 回调返回 false、时间戳不变）',
      calls.mutateRet[calls.mutateRet.length - 1] === false && a.examOpened.stu2.at === atBefore)
    await vm.runInContext("courseExamGateRevoke('c1','a1','stu2')", sb)
    assert('撤销放行移除 examOpened[stu2]', !a.examOpened.stu2)
    assert('撤销放行不清理其他学员', !!(a.examOpened && a.examOpened.stu1))
  }

  // ---------------- 三、源码接线断言 ----------------
  const g = (name) => extractFn(APP, name)
  {
    const b = g('courseStart')
    assert('courseStart 签名带 _recheck', b.indexOf('function courseStart(cid, aid, _recheck)') === 0)
    assert('courseStart 判 examGate + examOpened[me]', b.indexOf("a.examGate && !((a.examOpened || {})[me])") >= 0)
    assert('courseStart 锁定时走 courseGateRecheck', b.indexOf('courseGateRecheck(cid, aid)') >= 0)
    assert('courseStart 复检路径只弹提示不递归', b.indexOf('if (_recheck)') >= 0)
    const rb = g('courseGateRecheck')
    assert('courseGateRecheck 先重拉云端再判定', rb.indexOf('getDoc') >= 0 && rb.indexOf('courseStart(cid, aid, true)') >= 0)
  }
  {
    const b = g('courseExamGateOpen')
    assert('放行函数幂等守卫（已放行 return false）', b.indexOf('if (a.examOpened[u]) return false') >= 0)
    assert('放行记录 { at, by: courseUser() }', b.indexOf('at: Date.now()') >= 0 && b.indexOf('by: courseUser()') >= 0)
    const rb = g('courseExamGateRevoke')
    assert('撤销只删该学员的 examOpened', rb.indexOf('delete a.examOpened[u]') >= 0)
  }
  {
    const b = g('courseSubmitAssign')
    assert('创建弹窗读取 caExamGate 勾选', b.indexOf("getElementById('caExamGate')") >= 0)
    assert('创建持久化 examGate: true（仅勾选时）', b.indexOf('examGate ? { examGate: true } : null') >= 0)
    assert('examGate 仅 exam 类型生效', b.indexOf("type === 'exam' &&") >= 0)
    const eb = g('courseSaveAssignEdit')
    assert('编辑弹窗读取 ceExamGate 勾选', eb.indexOf("getElementById('ceExamGate')") >= 0)
    assert('编辑保存 set/delete examGate（不洗 examOpened）',
      eb.indexOf('if (examGate) a.examGate = true') >= 0 && eb.indexOf('else delete a.examGate') >= 0)
    assert('编辑保存未触碰 examOpened 名单', eb.indexOf('a.examOpened') < 0)
    const mb = g('courseEditAssignModal')
    assert('编辑弹窗回显 examGate', mb.indexOf('examGate: !!a.examGate') >= 0)
    const cb = g('courseCopyAssignDo')
    assert('复制作业剥离 examOpened（放行名单不随复制）', cb.indexOf('delete clone.examOpened') >= 0)
  }
  {
    const b = g('courseAssignDetail')
    const iCol = b.indexOf('courseExamGateCol'), iAct = b.indexOf('courseThAction')
    assert('详情表新增「考试放行」列且位于操作列之前', iCol >= 0 && iAct >= 0 && iCol < iAct)
    assert('放行/撤销按钮接线（含 escAttr(JSON.stringify(u)) 防引号陷阱）',
      b.indexOf('courseExamGateOpen(') >= 0 && b.indexOf('courseExamGateRevoke(') >= 0
      && b.indexOf('escAttr(JSON.stringify(u))') >= 0)
    assert('已放行显示时间（courseFmtDate）', b.indexOf('openRec.at') >= 0)
  }
  {
    const b = g('renderCourseStudent')
    assert('学员卡 gateLocked 判定（examGate + 未放行 + 未作答）',
      b.indexOf("!!a.examGate && !res && !((a.examOpened || {})[me])") >= 0)
    const iGate = b.indexOf('gateLocked'), iExp = b.indexOf('} else if (expired)')
    assert('等待态分支先于过期分支（闸门优先于截止时间）', iGate >= 0 && iExp >= 0 && iGate < iExp)
    assert('等待态文案键在（WaitTag + WaitHint）',
      b.indexOf('courseExamGateWaitTag') >= 0 && b.indexOf('courseExamGateWaitHint') >= 0)
    assert('测评类型徽章带 🔒（gated exam）', b.indexOf("a.examGate ? ' 🔒' : ''") >= 0)
  }
  {
    const b = g('courseDraftTypeChange')
    assert('创建弹窗类型切换联动 caGateGroup 显隐', b.indexOf('caGateGroup') >= 0)
    const e = g('courseEditToggleExamFields')
    assert('编辑弹窗类型切换联动 ceGateGroup 显隐', e.indexOf('ceGateGroup') >= 0)
    const cr = g('courseCreateAssignModal')
    assert('创建弹窗含 caGateGroup + caExamGate 控件', cr.indexOf('id="caGateGroup"') >= 0 && cr.indexOf('id="caExamGate"') >= 0)
    const rm = g('courseRenderEditModal')
    assert('编辑弹窗含 ceGateGroup + ceExamGate 控件并回显勾选',
      rm.indexOf('id="ceExamGate"') >= 0 && rm.indexOf("m.meta.examGate ? 'checked' : ''") >= 0)
    const cls = g('courseRenderClass')
    assert('班级作业表测评行带 🔒 提示', cls.indexOf("a.examGate ? ` <span title=") >= 0)
  }

  // ---------------- 四、小程序 take.js 同口径拦截 ----------------
  {
    const iGate = TAKE.indexOf("a.type === 'exam' && a.examGate")
    const iDraft = TAKE.indexOf("a.status === 'draft'")
    assert('小程序 take.js 有放行闸门拦截', iGate >= 0)
    assert('小程序拦截先于草稿检查（同一 course 分支内）', iGate >= 0 && iDraft >= 0 && iGate < iDraft)
    assert('小程序按 me.username 判定放行名单', TAKE.slice(iGate, iGate + 160).indexOf('me.username') >= 0)
    assert('小程序拦截后提示并返回', TAKE.slice(iGate, iGate + 260).indexOf('navigateBack()') >= 0)
    assert('小程序拦截带 !res 前置（已作答走原单次语义）', TAKE.slice(iGate - 60, iGate + 60).indexOf('!res') >= 0)
  }

  // ---------------- 五、index.html 版本号 ----------------
  {
    const n115 = (HTML.match(/\?v=115/g) || []).length
    const n114 = (HTML.match(/\?v=114/g) || []).length
    assert('index.html 全部 ?v=115（12 处）', n115 === 12)
    assert('index.html 无 ?v=114 残留', n114 === 0)
  }

  console.log(failed ? '✗ v115 gate FAILED ' + failed : '✅ v115 course exam gate all pass')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1) })
