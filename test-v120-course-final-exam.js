// test-v120-course-final-exam.js —— v120「线下课最终考试」（type:'coursefinal'）逐人启动闸门
//
// 需求（用户原话）：「新功能 增加作业选项 线下课最终考试 需要一个一个人启动的」
// 用户确认的三个设计决策：
//   ① 新增独立作业类型（不复用 exam）
//   ② 放行方式 = 管理员逐人点「放行」（沿用 v115 交互）
//   ③ 放行后只能考一次（交卷即完成，不提供重考）
//
// 覆盖：i18n zh/en 成对 / 类型收口表 courseAssignTypeLabel / 闸门辅助函数语义 /
//       courseStart 闸门拦截与限考一次 / courseGateRecheck 独立名单 /
//       courseFinalGateOpen·Revoke 幂等与隔离 / 管理端放行列 /
//       创建·编辑·复制接线 / 班级列表类型文案 / 看板计数 /
//       与 v115（exam+examGate）互不干扰 / 小程序 take.js 同口径 / 版本号。
const fs = require('fs'), path = require('path'), vm = require('vm')

const APP = fs.readFileSync(path.join(__dirname, 'course-app.js'), 'utf8')
const I18N = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const TAKE = fs.readFileSync(path.join(__dirname, '../english-quiz-miniprogram/pages/take/take.js'), 'utf8')
const HOME = fs.readFileSync(path.join(__dirname, '../english-quiz-miniprogram/pages/home/home.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

let failed = 0
function assert(name, cond) {
  if (cond) { console.log('✓ ' + name) } else { failed++; console.log('✗ ' + name) }
}

// extractFn：词边界 + 花括号配平（兼容 async 前缀）
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

// ---------------- 一、i18n zh/en 成对 ----------------
const NEW_KEYS = ['courseTypeCourseFinal', 'courseFinalGateLabel', 'courseFinalGateHint', 'courseFinalWait',
  'courseFinalWaitTag', 'courseFinalWaitHint', 'courseFinalOnce', 'courseFinalCol', 'courseFinalOk',
  'courseFinalNotYet', 'courseFinalBtn', 'courseFinalConfirm', 'courseFinalRevoke',
  'courseFinalRevokeConfirm', 'courseFinalStartConfirm']
NEW_KEYS.forEach(k => {
  const n = (I18N.match(new RegExp('(^|[\\s{,])' + k + '\\s*:', 'g')) || []).length
  assert('i18n ' + k + ' zh/en 成对（出现 2 次）', n === 2)
})
assert('i18n zh 类型名「线下课最终考试」在', I18N.indexOf("courseTypeCourseFinal: '线下课最终考试'") >= 0)
assert('i18n en 类型名 Offline Final Exam 在', I18N.indexOf("courseTypeCourseFinal: 'Offline Final Exam'") >= 0)
assert('i18n 明确「逐人启动」语义（zh）', I18N.indexOf('需管理员逐人启动（最终考试）') >= 0)
assert('i18n 明确「逐人启动」语义（en）', I18N.indexOf('Per-student activation (final exam)') >= 0)
assert('i18n 明确「只能考一次」（zh）', I18N.indexOf('最终考试放行后仅可作答一次') >= 0)
assert('i18n 明确「只能考一次」（en）', I18N.indexOf('allows only one attempt') >= 0)

// ---------------- 二、类型收口表 ----------------
{
  const b = extractFn(APP, 'courseAssignTypeLabel')
  assert('courseAssignTypeLabel 覆盖 coursefinal', b.indexOf("case 'coursefinal'") >= 0)
  assert('courseAssignTypeLabel 覆盖 video/exam/offline/homework 四型',
    ["case 'video'", "case 'exam'", "case 'offline'"].every(x => b.indexOf(x) >= 0) && b.indexOf('courseTypeHomework') >= 0)
  assert('ASSIGN_TYPE_LABELS 由 courseAssignTypeLabel 派生（单一定义源）',
    /const ASSIGN_TYPE_LABELS = new Proxy\(\{\}, \{ get: \(_, k\) => courseAssignTypeLabel\(k\) \}\)/.test(APP))
}

// ---------------- 三、闸门辅助函数（行为沙箱） ----------------
function mkSandbox(doc, sess) {
  const calls = { alert: [], confirm: [], renderTake: 0, renderDetail: [], mutateRet: [] }
  const sb = {
    console, Date, JSON, Math, Object, Array, String, Number, Promise, Set, Map, RegExp, Error, Boolean,
    parseInt, isNaN, setImmediate,
    alert: (m) => calls.alert.push(String(m)),
    confirm: (m) => { calls.confirm.push(String(m)); return !!sb.__confirmYes },
    t: (k, a) => '[t:' + k + ']',
    LANG: 'zh',
    Store: { getSession: () => sb.__sess },
    courseState: { doc, view: 'assign', classId: 'c1', assignId: 'a1' },
    __sess: sess || { username: 'stu1' },
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
      findClass: (d, cid) => ((d && d.classes) || []).find(c => c.id === cid),
      findAssign: (cls, aid) => cls && (cls.assignments || []).find(a => a.id === aid),
      getDoc: async () => sb.courseState.doc,
      mutate: async (fn) => { const r = fn(sb.courseState.doc); calls.mutateRet.push(r); return r !== false }
    },    // v134：courseStart 新增「章节闸门」依赖 —— 本套件验的是放行闸门，
    //   故注入「全部已开放」桩，让章节闸门恒不拦截（章节开关由 test-v134 专门覆盖）。
    courseChapterOpened: () => true,

    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  }
  sb.window = sb
  vm.createContext(sb)
  ;['courseUser', 'courseFind', 'courseFindAssign', 'courseIsOffline',
    'courseIsFinal', 'courseGateRequired', 'courseGateOpenedFor', 'courseOnceOnly', 'courseGateLocked',
    'courseGateElArgs', 'courseStart', 'courseGateRecheck',
    'courseExamGateOpen', 'courseExamGateRevoke',
    'courseFinalGateOpen', 'courseFinalGateRevoke',
    // v147：courseStart 新增「重考机会已用完」拦截（courseRetryBlocked）→ 依赖链一并注入。
    //   ★ 拦截侧刻意**不** fail-open（缺依赖要响亮地炸），故这里注入真实实现而非桩。
    'courseResetRecOf', 'courseResetUnconsumed', 'courseRetryBlocked'].forEach(n => {
    vm.runInContext(extractFn(APP, n), sb)
  })
  return { sb, calls }
}

const QS = [{ type: 'single', difficulty: 1, question: 'Q1', options: ['A', 'B'], answer: [0], explanation: '' }]

function mkDoc(opts) {
  opts = opts || {}
  const fin = {
    id: 'a1', type: 'coursefinal', title: '最终考试', desc: '', deadline: 0, duration: 30, passScore: 60,
    questions: QS.slice(), results: {}
  }
  if (opts.finOpened) fin.courseFinalOpened = opts.finOpened
  if (opts.finRes) fin.results.stu1 = opts.finRes
  // v115 对照件：普通测评 + examGate
  const ex = {
    id: 'a2', type: 'exam', title: '普通测评', desc: '', deadline: 0, duration: 30, passScore: 60,
    questions: QS.slice(), results: {}, examGate: true
  }
  if (opts.examOpened) ex.examOpened = opts.examOpened
  // 纯作业 + 纯测评（无闸门）对照件
  const hw = { id: 'a3', type: 'homework', title: '作业', deadline: 0, duration: 0, passScore: 60, questions: QS.slice(), results: {} }
  const ex2 = { id: 'a4', type: 'exam', title: '无闸门测评', deadline: 0, duration: 20, passScore: 60, questions: QS.slice(), results: {} }
  return { classes: [{ id: 'c1', name: 'C1', note: '', createdAt: 1, members: ['stu1', 'stu2'], assignments: [fin, ex, hw, ex2] }] }
}

const FIN_WAIT = '[t:courseFinalWait]'
const EX_WAIT = '[t:courseExamGateWait]'
const FIN_CONFIRM = '[t:courseFinalStartConfirm]'
const EX_CONFIRM = '[t:courseExamStartConfirm]'

;(async () => {
  // --- 辅助函数语义（正反双向） ---
  {
    const { sb } = mkSandbox(mkDoc({}))
    assert('courseIsFinal 只认 coursefinal', vm.runInContext("courseIsFinal({type:'coursefinal'})", sb) === true
      && vm.runInContext("courseIsFinal({type:'exam'})", sb) === false)
    assert('courseGateRequired：最终考试恒需闸门（无开关）', vm.runInContext("courseGateRequired({type:'coursefinal'})", sb) === true)
    assert('courseGateRequired：普通测评要看 examGate 开关',
      vm.runInContext("courseGateRequired({type:'exam',examGate:true})", sb) === true
      && vm.runInContext("courseGateRequired({type:'exam'})", sb) === false)
    assert('courseGateRequired：作业/视频永不需要闸门',
      vm.runInContext("courseGateRequired({type:'homework'})", sb) === false
      && vm.runInContext("courseGateRequired({type:'video'})", sb) === false)
    // ★ 名单隔离：两个闸门读各自的名单，绝不互相串
    assert('courseGateOpenedFor：最终考试读 courseFinalOpened',
      vm.runInContext("courseGateOpenedFor({type:'coursefinal',courseFinalOpened:{u1:{at:1}}},'u1')", sb) === true)
    assert('★ 名单隔离：最终考试不读 examOpened（改类型不会白捡放行）',
      vm.runInContext("courseGateOpenedFor({type:'coursefinal',examOpened:{u1:{at:1}}},'u1')", sb) === false)
    assert('★ 名单隔离：普通测评不读 courseFinalOpened',
      vm.runInContext("courseGateOpenedFor({type:'exam',examGate:true,courseFinalOpened:{u1:{at:1}}},'u1')", sb) === false)
    assert('★ 名单隔离：普通测评读 examOpened',
      vm.runInContext("courseGateOpenedFor({type:'exam',examGate:true,examOpened:{u1:{at:1}}},'u1')", sb) === true)
    assert('courseOnceOnly：最终考试恒 true', vm.runInContext("courseOnceOnly({type:'coursefinal'})", sb) === true)
    assert('courseGateLocked：需闸门 + 未放行 + 无成绩 → true',
      vm.runInContext("courseGateLocked({type:'coursefinal'},'u1',null)", sb) === true)
    assert('courseGateLocked：已放行 → false',
      vm.runInContext("courseGateLocked({type:'coursefinal',courseFinalOpened:{u1:{at:1}}},'u1',null)", sb) === false)
    assert('courseGateLocked：已有成绩 → false（成绩优先，不会把已考者打回等待态）',
      vm.runInContext("courseGateLocked({type:'coursefinal'},'u1',{score:80})", sb) === false)
  }

  // --- courseStart：最终考试闸门拦截 ---
  {
    const { sb, calls } = mkSandbox(mkDoc({}))
    let getDocCalls = 0
    const origGet = sb.CourseStore.getDoc
    sb.CourseStore.getDoc = async () => { getDocCalls++; return origGet() }
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('未放行的最终考试：同步阶段不进确认、不渲染答题页', calls.confirm.length === 0 && calls.renderTake === 0)
    await new Promise(r => setImmediate(r))
    assert('未放行 → 复检后弹「最终考试」专属等待提示', calls.alert.indexOf(FIN_WAIT) >= 0)
    assert('未放行 → 提示不是普通测评文案（类型分流正确）', calls.alert.indexOf(EX_WAIT) < 0)
    assert('锁定点击触发一次云端复检（重拉 getDoc）', getDocCalls === 1)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({ finOpened: { stu1: { at: 123, by: 'admin1' } } }))
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('已放行 → 通过闸门进入「最终考试」专属确认框', calls.confirm.indexOf(FIN_CONFIRM) >= 0)
    assert('已放行 → 确认框不是普通测评文案', calls.confirm.indexOf(EX_CONFIRM) < 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({}))
    vm.runInContext("courseStart('c1','a1', true)", sb)
    assert('带 _recheck 复检仍锁定 → 只弹提示、不再递归', calls.alert.indexOf(FIN_WAIT) >= 0 && calls.confirm.length === 0)
  }
  // --- 限考一次 ---
  {
    const { sb, calls } = mkSandbox(mkDoc({ finRes: { score: 88, total: 1, correct: 1 } }))
    vm.runInContext("courseStart('c1','a1')", sb)
    assert('★ 已交卷的最终考试 → 被「不可重复作答」拦截（限考一次）',
      calls.alert.indexOf('[t:courseExamDoneAlert]') >= 0 && calls.renderTake === 0)
  }
  // --- 对照件不受影响 ---
  {
    const { sb, calls } = mkSandbox(mkDoc({}))
    vm.runInContext("courseStart('c1','a3')", sb)
    assert('对照：普通作业行为不变（直接进入答题）', calls.renderTake === 1)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({}))
    vm.runInContext("courseStart('c1','a4')", sb)
    assert('对照：无闸门普通测评行为不变（直接进入确认）', calls.confirm.indexOf(EX_CONFIRM) >= 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({}))
    vm.runInContext("courseStart('c1','a2')", sb)
    // 闸门锁定后走 courseGateRecheck（异步）→ 需等一个 tick 才拿到提示
    await new Promise(r => setImmediate(r))
    assert('对照：v115 普通测评闸门仍在（未放行 → 弹测评专属等待文案）', calls.alert.indexOf(EX_WAIT) >= 0)
    assert('对照：普通测评等待文案不是最终考试文案', calls.alert.indexOf(FIN_WAIT) < 0)
  }

  // --- courseGateRecheck：读各自名单 ---
  {
    const fresh = mkDoc({ finOpened: { stu1: { at: 456, by: 'admin1' } } })
    const { sb, calls } = mkSandbox(mkDoc({}))
    sb.CourseStore.getDoc = async () => fresh   // 管理员刚放行后的新文档
    await vm.runInContext("courseGateRecheck('c1','a1')", sb)
    assert('复检拿到已放行的新文档 → 放行进确认（走 _recheck 通道）',
      calls.confirm.indexOf(FIN_CONFIRM) >= 0 && calls.alert.indexOf(FIN_WAIT) < 0)
  }
  {
    const { sb, calls } = mkSandbox(mkDoc({}))
    await vm.runInContext("courseGateRecheck('c1','a1')", sb)
    assert('复检仍未放行 → 弹等待提示、不进确认', calls.alert.indexOf(FIN_WAIT) >= 0 && calls.confirm.length === 0)
  }

  // --- courseFinalGateOpen / Revoke ---
  {
    const { sb, calls } = mkSandbox(mkDoc({}), { username: 'admin1' })
    sb.__confirmYes = true
    await vm.runInContext("courseFinalGateOpen({dataset:{c:'c1',a:'a1',u:'stu1'}})", sb)
    const a = sb.courseState.doc.classes[0].assignments[0]
    assert('放行写入 courseFinalOpened[stu1]', !!(a.courseFinalOpened && a.courseFinalOpened.stu1))
    assert('放行记录含时间戳与操作管理员',
      typeof a.courseFinalOpened.stu1.at === 'number' && a.courseFinalOpened.stu1.by === 'admin1')
    assert('放行后刷新详情页', calls.renderDetail.some(x => x[0] === 'c1' && x[1] === 'a1'))
    const atBefore = a.courseFinalOpened.stu1.at
    await vm.runInContext("courseFinalGateOpen({dataset:{c:'c1',a:'a1',u:'stu1'}})", sb)
    assert('★ 重复放行幂等（mutate 回调返回 false、时间戳不变）',
      calls.mutateRet[calls.mutateRet.length - 1] === false && a.courseFinalOpened.stu1.at === atBefore)
    await vm.runInContext("courseFinalGateRevoke({dataset:{c:'c1',a:'a1',u:'stu1'}})", sb)
    assert('撤销放行移除 courseFinalOpened[stu1]', !a.courseFinalOpened.stu1)
  }
  {
    // 隔离：放行最终考试不应污染普通测评的 examOpened，反之亦然
    const { sb } = mkSandbox(mkDoc({ examOpened: { stu2: { at: 9, by: 'boss' } } }), { username: 'admin1' })
    sb.__confirmYes = true
    await vm.runInContext("courseFinalGateOpen({dataset:{c:'c1',a:'a1',u:'stu1'}})", sb)
    const [fin, ex] = sb.courseState.doc.classes[0].assignments
    assert('★ 放行最终考试不写 examOpened（不污染普通测评）', !ex.examOpened.stu1)
    assert('★ 放行最终考试不影响普通测评已有名单', !!(ex.examOpened && ex.examOpened.stu2))
    assert('最终考试名单独立', !!(fin.courseFinalOpened && fin.courseFinalOpened.stu1))
    sb.__confirmYes = true
    await vm.runInContext("courseExamGateRevoke({dataset:{c:'c1',a:'a2',u:'stu2'}})", sb)
    assert('★ 撤销普通测评放行不碰最终考试名单', !!(fin.courseFinalOpened && fin.courseFinalOpened.stu1))
  }
  {
    // 已交成绩者不显示按钮 → 通过渲染断言覆盖（此处验函数不会因缺参崩溃）
    const { sb, calls } = mkSandbox(mkDoc({}), { username: 'admin1' })
    await vm.runInContext("courseFinalGateOpen({dataset:{}})", sb)
    assert('放行函数缺参安全返回（不抛错、不写数据）', calls.mutateRet.length === 0)
  }

  // ---------------- 四、源码接线断言 ----------------
  const g = (name) => extractFn(APP, name)
  {
    const b = g('courseStart')
    assert('courseStart 闸门走 courseGateLocked（统一入口）', b.indexOf('courseGateLocked(a, me, res)') >= 0)
    assert('courseStart 复检路径只弹提示不递归', b.indexOf('if (_recheck)') >= 0)
    assert('courseStart 类型分流确认文案（courseFinalStartConfirm）',
      b.indexOf("courseIsFinal(a) ? 'courseFinalStartConfirm' : 'courseExamStartConfirm'") >= 0)
    assert('courseStart 最终考试限时（endAt 含 coursefinal）',
      b.indexOf("(a.type === 'exam' || isFinal) && a.duration") >= 0)
    assert('courseStart 最终考试启用防作弊', b.indexOf('|| isFinal) && typeof AntiCheat') >= 0)
    assert('courseStart 回顾分支含 coursefinal（错题仍需回顾至全对）',
      b.indexOf("a.type === 'homework' || a.type === 'exam' || courseIsFinal(a)") >= 0)
  }
  {
    const b = g('courseGateRecheck')
    assert('courseGateRecheck 走 courseGateOpenedFor（名单隔离收口）', b.indexOf('courseGateOpenedFor(a, courseUser())') >= 0)
    assert('courseGateRecheck 等待文案按类型分流', b.indexOf('courseIsFinal(a) ?') >= 0)
  }
  {
    const b = g('courseFinalGateOpen')
    assert('放行幂等守卫（已放行 return false）', b.indexOf('if (a.courseFinalOpened[u]) return false') >= 0)
    assert('放行写独立名单 courseFinalOpened', b.indexOf('a.courseFinalOpened = a.courseFinalOpened || {}') >= 0)
    assert('放行记录 { at, by: courseUser() }', b.indexOf('at: Date.now()') >= 0 && b.indexOf('by: courseUser()') >= 0)
    assert('放行从 DOM dataset 取参（courseGateElArgs）', b.indexOf('courseGateElArgs(el)') >= 0)
    assert('放行不写 examOpened（隔离）', b.indexOf('a.examOpened') < 0)
    const rb = g('courseFinalGateRevoke')
    assert('撤销只删该学员的 courseFinalOpened', rb.indexOf('delete a.courseFinalOpened[u]') >= 0)
    assert('撤销不写 examOpened（隔离）', rb.indexOf('a.examOpened') < 0)
  }
  {
    // ★ 接线：类型下拉必须真的含 coursefinal 选项（「函数存在 ≠ 功能存在」，v100 教训）
    const b = g('courseCreateAssignModal')
    assert('创建弹窗类型下拉含 coursefinal 选项', b.indexOf('value="coursefinal"') >= 0)
    assert('创建弹窗类型下拉含最终考试文案', b.indexOf('courseTypeCourseFinal') >= 0)
    assert('创建弹窗有最终考试专属闸门说明块 caFinalGateGroup', b.indexOf('id="caFinalGateGroup"') >= 0)
    assert('创建弹窗普通测评闸门控件保留 caGateGroup', b.indexOf('id="caGateGroup"') >= 0)
    const t = g('courseDraftTypeChange')
    assert('创建弹窗类型切换：最终考试显示时长/及格分', t.indexOf("const examLike = type === 'exam' || type === 'coursefinal'") >= 0)
    assert('创建弹窗类型切换：最终考试显隐 caFinalGateGroup', t.indexOf('caFinalGateGroup') >= 0)
    assert('创建弹窗类型切换：测评开关仍只对 exam 显示', t.indexOf("type === 'exam' ? '' : 'none'") >= 0)
  }
  {
    const b = g('courseSubmitAssign')
    assert('创建保存：最终考试读取时长/及格分（examLike）', b.indexOf('const examLike = type === \'exam\' || type === \'coursefinal\'') >= 0)
    assert('创建保存：examGate 仅对 exam 生效（最终考试闸门恒开、不写开关）',
      b.indexOf("type === 'exam' && !!(gateEl && gateEl.checked)") >= 0)
    assert('创建保存使用 ASSIGN_TYPE_LABELS 无关（类型存原始值 type）', b.indexOf('id: aid, type, title') >= 0)
  }
  {
    const b = g('courseRenderEditModal')
    assert('编辑弹窗类型下拉由 assignTypeOpts 渲染（含 coursefinal）', b.indexOf('${assignTypeOpts}') >= 0)
    assert('编辑弹窗有 ceFinalGateGroup 说明块', b.indexOf('id="ceFinalGateGroup"') >= 0)
    const e = g('courseEditToggleExamFields')
    assert('编辑弹窗切换：最终考试显隐时长/及格分', e.indexOf("const examLike = type === 'exam' || type === 'coursefinal'") >= 0)
    assert('编辑弹窗切换：显隐 ceFinalGateGroup', e.indexOf('ceFinalGateGroup') >= 0)
    assert('courseEditTypeChange 存在并同步 meta.type', (() => { const x = g('courseEditTypeChange'); return x.indexOf('courseEditAssign.meta.type = sel.value') >= 0 })())
    assert('编辑弹窗 select 用 onchange 属性接线 courseEditTypeChange', b.indexOf('onchange="courseEditTypeChange()"') >= 0)
  }
  {
    const b = g('courseSaveAssignEdit')
    assert('编辑保存：最终考试读取时长/及格分（examLike）', b.indexOf("const examLike = type === 'exam' || type === 'coursefinal'") >= 0)
    assert('编辑保存：examGate 门控仅 exam（不误写最终考试）', b.indexOf("const examGate = type === 'exam' && !!(gateEl && gateEl.checked)") >= 0)
    assert('编辑保存未触碰 courseFinalOpened 名单（关闸不清名单）', b.indexOf('a.courseFinalOpened') < 0)
  }
  {
    const b = g('courseCopyAssignDo')
    assert('★ 复制作业剥离 courseFinalOpened（放行名单不随复制带走）', b.indexOf('delete clone.courseFinalOpened') >= 0)
    assert('复制作业仍剥离 examOpened（v115 行为保留）', b.indexOf('delete clone.examOpened') >= 0)
    assert('复制保留类型本身（type 随深拷贝带走）', b.indexOf('JSON.parse(JSON.stringify(a))') >= 0)
    const t = g('courseCopyAssignModal')
    assert('复制弹窗类型文案走 courseAssignTypeLabel 收口（coursefinal 可读）',
      APP.indexOf("a.type === 'coursefinal' ? t('courseTypeCourseFinal')") >= 0)
  }
  {
    const b = g('courseAssignDetail')
    assert('详情表闸门列由 courseGateRequired 决定', b.indexOf('const gateExam = courseGateRequired(a)') >= 0)
    assert('详情表表头按类型选列名（courseFinalCol / courseExamGateCol）',
      b.indexOf("t(isFinal ? 'courseFinalCol' : 'courseExamGateCol')") >= 0)
    assert('放行/撤销按钮接线（data-u + (this)，用户名不拼进 onclick）',
      b.indexOf('onclick="${openFn}(this)"') >= 0 && b.indexOf('onclick="${revokeFn}(this)"') >= 0
      && b.indexOf('data-u="${escAttr(u)}"') >= 0)
    assert('★ 用户名不出现在 onclick 字面量里（v85 引号陷阱根本解法）',
      !/onclick="courseFinalGate(Open|Revoke)\([^)]*'\$\{u\}'/.test(b))
    assert('放行名单读取按类型分流 isFinal ? courseFinalOpened : examOpened',
      b.indexOf('(isFinal ? a.courseFinalOpened : a.examOpened)') >= 0)
    assert('已放行显示时间（courseFmtDate(openRec.at)）', b.indexOf('courseFmtDate(openRec.at)') >= 0)
  }
  // v133 反转：原 7 条断言全部钉在「我的班级」卡片列表的渲染分支上
  //   （卡片里的 gateLocked 分支 / 等待态文案分流 / 📕🔒 徽章 / 仅可作答一次提示 / 时长字段 / 无重考按钮）。
  //   卡片列表已随 v133 移除 —— 这些功能契约整体由 courseStart 闸门链路 + i18n 表 + 管理端承载。
  //   逐条落到真实收口处重写如下。
  {
    const cs = g('courseStart')
    // 1. 闸门判定收口 + 分支顺序（闸门必须早于开考确认，否则截止会先拦）
    assert('[v133 反转] courseStart 闸门判定收口为 courseGateLocked',
      cs.indexOf('courseGateLocked(a, me, res)') >= 0)
    const iGate = cs.indexOf('courseGateLocked(a, me, res)')
    const iConfirm = cs.indexOf("courseFinalStartConfirm")
    assert('[v133 反转] 等待态分支先于开考确认（闸门优先于截止/确认）',
      iGate >= 0 && iConfirm >= 0 && iGate < iConfirm, 'gate=' + iGate + ' confirm=' + iConfirm)
    // 2. 等待态文案按类型分流（最终考试 vs 普通测评）
    assert('[v133 反转] 等待态提示按类型分流（isFinal ? courseFinalWait : courseExamGateWait）',
      cs.indexOf("courseIsFinal(a) ? t('courseFinalWait') : t('courseExamGateWait')") >= 0,
      cs.slice(cs.indexOf('_recheck'), cs.indexOf('_recheck') + 200))
    // 3. 限考一次：最终考试有成绩直接拦（无重考入口）
    assert('[v133 反转] 最终考试有成绩不可再进（courseExamDoneAlert，无重考）',
      cs.indexOf("if (courseIsFinal(a) && res) { alert(t('courseExamDoneAlert')); return }") >= 0)
    // 4. 最终考试时长参与计时（endAt 由 duration 推导）
    assert('[v133 反转] 最终考试时长参与计时（endAt 走 duration）',
      cs.indexOf("(a.type === 'exam' || isFinal) && a.duration ? Date.now() + a.duration * 60000 : null") >= 0)
  }
  {
    // 5~6. 徽章 / 「仅可作答一次」文案 / 类型标签 —— 改查 i18n 表 + 管理端类型列
    ;['courseTypeCourseFinal', 'courseFinalOnce', 'courseFinalWait', 'courseFinalWaitTag',
      'courseFinalWaitHint', 'courseFinalGateLabel'].forEach(k => {
      const n = (I18N.match(new RegExp('(^|[\\s{,])' + k + '\\s*:', 'g')) || []).length
      assert('[v133 反转] 最终考试文案键 zh/en 成对（' + k + '）', n === 2)
    })
    const rc = g('courseRenderClass')
    assert('[v133 反转] 管理端班级列表最终考试行带 📕 类型标签',
      rc.indexOf("t('courseTypeCourseFinal')") >= 0, rc.slice(0, 200))
  }
  {
    const b = g('courseRenderClass')
    assert('班级列表类型列含 coursefinal 文案', b.indexOf("a.type === 'coursefinal' ? t('courseTypeCourseFinal')") >= 0)
    assert('班级列表最终考试行带 🔒（courseFinalGateLabel tooltip）', b.indexOf("t('courseFinalGateLabel')") >= 0)
  }
  {
    const b = g('renderCourseAdmin')
    assert('★ 看板「测评数」统计含 coursefinal（否则最终考试不计入）',
      b.indexOf("if (a.type === 'exam' || a.type === 'coursefinal') totalExam++") >= 0)
  }
  {
    const b = g('courseTaskIcon')
    assert('任务图标 coursefinal → 📕', b.indexOf("if (a.type === 'coursefinal') return '📕'") >= 0)
  }
  {
    // 渲染层对 coursefinal 的「测评式」处理
    const t = g('courseRenderTake')
    assert('答题页 isExam 判定含 coursefinal（走测评式无即时反馈）',
      t.indexOf("const isExam = (qz.type === 'exam' || qz.type === 'coursefinal')") >= 0)
    const r = g('courseRenderTakeResult')
    assert('结果页 qzIsExam 收口（icon/标题/及格标签一致）', r.indexOf("const qzIsExam = qz.type === 'exam' || qz.type === 'coursefinal'") >= 0)
    const s = g('coursePerQReport')
    assert('每题正确率上报放行 coursefinal 类型（否则最终考试不进题库统计）',
      s.indexOf("qz.type !== 'homework' && qz.type !== 'exam' && qz.type !== 'coursefinal'") >= 0)
  }

  // ---------------- 五、小程序同口径 ----------------
  {
    const iFinal = TAKE.indexOf('const _final = a.type')
    assert('小程序 take.js 识别 coursefinal 类型', TAKE.indexOf("a.type !== 'coursefinal'") >= 0)
    assert('小程序有最终考试闸门分支（_final / _openMap）', iFinal >= 0 && TAKE.indexOf('const _openMap') >= 0)
    assert('小程序最终考试闸门恒开（_final || exam+examGate）',
      TAKE.indexOf('((_final) || (a.type === \'exam\' && a.examGate))') >= 0)
    assert('小程序最终考试名单走 courseFinalOpened（独立于 examOpened）',
      TAKE.indexOf('_final ? a.courseFinalOpened : a.examOpened') >= 0)
    assert('小程序拦截带 !res 前置', TAKE.slice(iFinal, iFinal + 480).indexOf('!res') >= 0)
    assert('小程序禁重考语义含 coursefinal', TAKE.indexOf("(a.type === 'exam' || a.type === 'coursefinal') && res") >= 0)
    assert('小程序拦截后提示并返回', TAKE.slice(iFinal, iFinal + 480).indexOf('navigateBack()') >= 0)
    // home.js 卡片
    assert('小程序首页卡片 coursefinal 显示「去考试」', HOME.indexOf("a.type === 'coursefinal') ? '去考试'") >= 0)
    assert('小程序首页考完走「成绩」而非「重做」',
      HOME.indexOf("if (a.type === 'exam' || a.type === 'coursefinal') return") >= 0)
  }

  // ---------------- 六、版本号 ----------------
  {
    // 弹性断言：唯一版本号 × 12 处，且 ≥ 120（写死会在下次 bump 时假失败 —— v115/v116/v117 连撞三次）
    const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
    const uniq = Array.from(new Set(vms))
    assert('index.html 版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1)
    assert('index.html 版本号 ≥ 120', uniq.length === 1 && uniq[0] >= 120)
  }

  console.log(failed === 0 ? '✅ v120 course final exam all pass' : '✗ v120 course final exam FAILED ' + failed)
  process.exit(failed === 0 ? 0 : 1)
})()
