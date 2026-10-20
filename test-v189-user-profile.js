// test-v189-user-profile.js —— v189：学员档案（点姓名 → 七天挑战 / 线下课 / 定级走势）
//
// 用户诉求（2026-10-20）：「我可以点击每个人的名字，然后看到这个人具体七天挑战和线下课
//   以及定级的走势，要有每次七天挑战的折线图分数走势」。
//
// 本版契约（不可回退）：
//   [A] dashUserRoundSeries：逐营次独立取数，**绝不跨期回落**；前测 = Day1 test、
//       期末 = 该营次最大 day 的 test；cleared 不计；重考取最晚一条
//   [B] dashUserLevelSeries：只认 chlevel 事件的变化点（不从 chy 的 lv 快照反推）
//   [C] dashUserCourseSeries：草稿不计、offline 无分、video 取小测分
//   [D] _upLineChartSvg：缺值必须断线（不跨缺口连直线）
//   [E] 接线：看板里五处姓名可点、i18n 中英齐备、cloud-store 挂 _lastEvents
//
// ★ 判据一律用进程退出码（§B：绝不用 grep 判回归成败）
const fs = require('fs'), path = require('path'), vm = require('vm')
const D = __dirname
const APP = fs.readFileSync(path.join(D, 'app.js'), 'utf-8')
const I18N = fs.readFileSync(path.join(D, 'i18n.js'), 'utf-8')
const CLOUD = fs.readFileSync(path.join(D, 'cloud-store.js'), 'utf-8')

let pass = 0, fail = 0
function ck(ok, label, extra) {
  if (ok) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')) }
}
// ★ 剥注释：计数类断言必须走 codeOnly（本项目九次复发的坑）
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const APP_CODE = codeOnly(APP)

// 按函数名抽源码（花括号配平）。★ 抽来的函数在沙箱里引用的模块常量必须一并注入，
//   否则 try/catch 会静默返回兜底值（v165/v166/v180/v182 同款假绿）。
function extractFn(src, name) {
  const key = 'function ' + name + '('
  const i = src.indexOf(key)
  if (i < 0) return ''
  const j = src.indexOf('{', i + key.length)
  if (j < 0) return ''
  let depth = 0
  for (let k = j; k < src.length; k++) {
    const ch = src[k]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  return ''
}

// ── 沙箱：营次表 + 依赖桩
const RD = [
  { id: 'r2', name: '第一期', depts: ['dining/yan'] },
  { id: 'r6', name: '第二期', depts: ['dining/yan'] },
]
const sandbox = {
  console: { log() { } },
  LANG: 'zh',
  rdList: RD,
  dashRoundList: () => sandbox.rdList,
  dashRoundSlug: s => { s = String(s || ''); return (!s || s === 'r1' || s === '第一期') ? '第一期' : s },
  t: k => k,
  escHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  escAttr: s => String(s == null ? '' : s).replace(/"/g, '&quot;'),
  _courseCellDone: (a, r) => {
    if (!r) return false
    if (a.type === 'offline') return !!r.done
    if (a.type === 'video') { const p = r.watchedPct != null ? Math.min(100, Math.round(r.watchedPct)) : 100; return p >= 90 }
    return true
  },
  courseAssignTypeLabel: ty => ty,
}
vm.createContext(sandbox)
const funs = ['dashUserRoundSeries', 'dashUserLevelSeries', 'dashUserCourseSeries', '_upLineChartSvg', '_upProfileHtml', 'upNameLink']
let bundle = ''
funs.forEach(n => {
  const src = extractFn(APP, n)
  if (!src) { console.log('  ! 抽不到函数：' + n); fail++ }
  bundle += src + '\n'
})
vm.runInContext(bundle, sandbox)
const { dashUserRoundSeries, dashUserLevelSeries, dashUserCourseSeries, _upLineChartSvg, _upProfileHtml } = sandbox

// ─────────────────────────── [A] 挑战序列
console.log('\n=== [A] dashUserRoundSeries：逐营次独立取数 ===')
const R = {
  username: 'hyx', name: '何旭艳', dept: '饮食部/艳中餐厅', chLevel: 3,
  chy: [
    { rd: 'r2', day: 1, si: 0, kind: 'practice', total: 10, correct: 8, at: 1000 },
    { rd: 'r2', day: 1, si: 1, kind: 'test', total: 20, correct: 18, at: 1100 },
    { rd: 'r2', day: 7, si: 0, kind: 'practice', total: 10, correct: 9, at: 2000 },
    { rd: 'r2', day: 7, si: 1, kind: 'test', total: 20, correct: 19, at: 2100 },
    { rd: 'r6', day: 1, si: 0, kind: 'test', total: 20, correct: 15, at: 5000 },
    { rd: 'r6', day: 2, si: 0, kind: 'practice', total: 30, correct: 27, at: 6000, cleared: true },
  ],
}
const RS = dashUserRoundSeries(R)
ck(RS.length === 2, 'A1 只出两个营次（不回落、不凭空造期）', '(' + RS.map(x => x.name).join(',') + ')')
ck(RS[0].name === '第一期' && RS[1].name === '第二期', 'A2 时间升序：先第一期后第二期')
ck(RS[0].pre === 90, 'A3 前测 = Day1 的 test（18/20=90）', '(' + RS[0].pre + ')')
ck(RS[0].final === 95, 'A4 期末 = 最大 day 的 test（19/20=95）', '(' + RS[0].final + ')')
ck(RS[0].q === 60, 'A5 答题数含全部记录（10+20+10+20）', '(' + RS[0].q + ')')
ck(RS[0].firstAcc === 90, 'A6 首答准确率按 day|si 去重（54/60=90）', '(' + RS[0].firstAcc + ')')
ck(RS[0].days === 2, 'A7 参与天数 = 有记录的天数（D1/D7=2）', '(' + RS[0].days + ')')
ck(RS[1].pre === 75, 'A8 第二期前测 15/20=75（绝不用第一期顶替）', '(' + RS[1].pre + ')')
ck(RS[1].final === null, 'A9 第二期没有期末考试 → final 为 null（不拿前测冒充）', '(' + RS[1].final + ')')
ck(RS[1].q === 50, 'A10 答题数仍含 cleared 记录（20+30=50）', '(' + RS[1].q + ')')
ck(RS[1].firstQ === 20, 'A11 首答只算未清除的记录（20）', '(' + RS[1].firstQ + ')')
ck(RS[1].days === 1, 'A12 清除记录的天不算参与（只剩 D1）', '(' + RS[1].days + ')')

// 单日营次：只做了 Day1 → 期末必须为空
const R2 = { username: 'x', chy: [{ rd: 'r2', day: 1, si: 1, kind: 'test', total: 20, correct: 10, at: 100 }] }
const RS2 = dashUserRoundSeries(R2)
ck(RS2.length === 1 && RS2[0].pre === 50 && RS2[0].final === null, 'A13 只做过 Day1 → 只有前测、期末为空')

// 重考取最晚一条（管理员重置后重考）
const R3 = { username: 'y', chy: [
  { rd: 'r2', day: 7, si: 1, kind: 'test', total: 20, correct: 10, at: 100, cleared: true },
  { rd: 'r2', day: 7, si: 1, kind: 'test', total: 20, correct: 18, at: 900 },
] }
const RS3 = dashUserRoundSeries(R3)
ck(RS3[0].final === 90, 'A14 同一场重考取最晚一条（18/20=90）', '(' + RS3[0].final + ')')
ck(RS3[0].q === 40, 'A15 答题数含被清除的旧记录（20+20）', '(' + RS3[0].q + ')')

ck(!/dashUserRoundSeries[\s\S]{0,2400}chyPrevOf/.test(APP_CODE.slice(APP_CODE.indexOf('function dashUserRoundSeries'), APP_CODE.indexOf('function dashUserLevelSeries'))),
  'A16 红线：dashUserRoundSeries 内不出现 chyPrevOf（无跨期回落）')

// ─────────────────────────── [B] 等级序列
console.log('\n=== [B] dashUserLevelSeries：只认 chlevel 事件变化点 ===')
const EV = [
  { u: 'hyx', ty: 'chlevel', ts: 100, d: { lv: 2 } },
  { u: 'hyx', ty: 'chlevel', ts: 200, d: { lv: 2 } },
  { u: 'hyx', ty: 'chlevel', ts: 300, d: { lv: 3 } },
  { u: 'other', ty: 'chlevel', ts: 310, d: { lv: 4 } },
  { u: 'hyx', ty: 'chlevel', ts: 400, d: { lv: '9' } },
  { u: 'hyx', ty: 'achievement', ts: 450, d: {} },
]
const LS = dashUserLevelSeries('hyx', EV, 3)
ck(LS.length === 2, 'B1 相邻同值合并 + 过滤他人事件（2 个变化点）', '(' + LS.length + ')')
ck(LS[0].lv === 2 && LS[1].lv === 3, 'B2 变化点 L2 → L3')
ck(LS.every(p => p.lv !== 4), 'B3 别人的 L4 绝不混进来')
ck(LS.every(p => p.lv !== 9), 'B4 非法等级（9）被忽略')
const LS2 = dashUserLevelSeries('hyx', EV, 4)
ck(LS2.length === 3 && LS2[2].lv === 4 && LS2[2].at === 0, 'B5 当前等级比事件末值高 → 末尾补当前值')
const LS3 = dashUserLevelSeries('hyx', EV.concat([{ u: 'hyx', ty: 'chlevel', ts: 500, d: { clear: true } }]), 0)
ck(LS3.length === 3 && LS3[2].lv === 0, 'B6 clear:true → 回到 0（未评定）')
ck(dashUserLevelSeries('nobody', EV, 0).length === 0, 'B7 无事件且无当前等级 → 空（不编造历史）')
const LS4 = dashUserLevelSeries('nobody', [], 2)
ck(LS4.length === 1 && LS4[0].lv === 2, 'B8 事件拉不到时至少有当前等级一个点')

// ─────────────────────────── [C] 线下课序列
console.log('\n=== [C] dashUserCourseSeries：草稿不计 / offline 无分 / video 取小测分 ===')
const DOC = { classes: [{ id: 'c1', name: '202609 班', members: ['hyx'], assignments: [
  { id: 'a1', title: '口语作业1', type: 'homework', status: 'published', results: { hyx: { score: 85, at: 1000, attempts: 1 } } },
  { id: 'a2', title: '期中测评', type: 'exam', results: { hyx: { score: 70, at: 2000 } } },
  { id: 'a3', title: '草稿任务', type: 'homework', status: 'draft', results: { hyx: { score: 99, at: 500 } } },
  { id: 'a4', title: '线下出席', type: 'offline', results: { hyx: { done: true, at: 1500 } } },
  { id: 'a5', title: '视频课', type: 'video', results: { hyx: { quizScore: 60, watchedPct: 100, at: 1200 } } },
  { id: 'a6', title: '别人的作业', type: 'homework', results: { other: { score: 50, at: 800 } } },
] }] }
const CS = dashUserCourseSeries(DOC, 'hyx')
ck(CS.length === 4, 'C1 只取本人 4 条（草稿 + 他人记录都排除）', '(' + CS.length + ')')
ck(CS.map(x => x.title).join('|') === '口语作业1|视频课|线下出席|期中测评', 'C2 按作答时间升序', '(' + CS.map(x => x.title).join('|') + ')')
ck(CS.filter(x => x.title === '线下出席')[0].score === null, 'C3 offline 无分数')
ck(CS.filter(x => x.title === '视频课')[0].score === 60, 'C4 video 取 quizScore=60')
ck(CS.filter(x => x.title === '口语作业1')[0].score === 85, 'C5 homework 取 score=85')
ck(CS.filter(x => x.title === '线下出席')[0].done === true, 'C6 offline 出席 → done=true')
ck(dashUserCourseSeries({ classes: [] }, 'hyx').length === 0, 'C7 空文档不报错')
ck(dashUserCourseSeries(null, 'hyx').length === 0, 'C8 doc 为 null 不报错（离线）')

// ─────────────────────────── [D] 折线图
console.log('\n=== [D] _upLineChartSvg：缺值断线 ===')
const svg1 = _upLineChartSvg({ labels: ['第一期', '第二期', '第三期'], series: [{ name: '期末', color: '#059669', values: [80, null, 90] }] })
const pathD = (svg1.match(/<path d="([^"]*)"/g) || []).join(' ')
ck((pathD.match(/M/g) || []).length === 2, 'D1 中间缺值 → 断成两段（两个 M，绝不跨缺口连直线）', '(' + (pathD.match(/M/g) || []).length + ')')
ck(!/NaN|undefined/.test(svg1), 'D2 SVG 里没有 NaN/undefined')
ck(/width="460"/.test(svg1), 'D3 点数少时宽度取最小 460（横向可滚）')
const svg2 = _upLineChartSvg({ labels: new Array(12).fill('艳中餐厅第二期'), series: [{ name: '分数', color: '#2563eb', values: new Array(12).fill(70) }] })
ck(/width="944"/.test(svg2), 'D4 点数多时按点数加宽（76*(12-1)+108=944）')
ck(svg2.indexOf('…餐厅第二期') > 0, 'D5 X 轴长标签保留尾部（两期才分得清）')
const svg3 = _upLineChartSvg({ labels: ['a', 'b'], series: [{ name: 'L', color: '#7c3aed', values: [1, 3] }], yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], tickText: v => (v === 0 ? '未评定' : 'L' + v) })
ck(svg3.indexOf('L4') > 0 && svg3.indexOf('未评定') > 0, 'D6 等级图用自定义 Y 轴刻度文案')
ck(_upLineChartSvg({ labels: [], series: [] }) === '' || _upLineChartSvg({ labels: [], series: [] }).indexOf('<svg') >= 0, 'D7 空数据不抛错')

// ─────────────────────────── [E] 接线
console.log('\n=== [E] 接线：五处姓名可点 / i18n / 云端事件 ===')
ck(/function upNameLink\(username, text\)/.test(APP_CODE), 'E1 存在 upNameLink 入口')
const linkUses = (APP_CODE.match(/_nameLink\([pu]\.username, [pu]\.name \|\| '—'\)/g) || []).length
ck(linkUses >= 5, 'E2 五处姓名单元格接入（线上/线下明细、挑战明细、排名、累计总览）', '(' + linkUses + ')')
// ★ 三处渲染函数必须各自在函数体内做 typeof 守卫：既有套件按源码切片只注入单个函数，
//   沙箱里没有 upNameLink，直接引用 = ReferenceError 整片假红（v139/v160/v162 实撞）。
const guards = (APP_CODE.match(/const _nameLink = \(typeof upNameLink === 'function'\)/g) || []).length
ck(guards === 3, 'E2b 三个渲染函数各自做 typeof 守卫（不破切片沙箱）', '(' + guards + ')')
ck(/data-u="\$\{escAttr\(u\)\}"/.test(APP_CODE), 'E3 用户名走 data-u 转义（不拼进内联 onclick）')
ck(/function openUserProfileFromEl\(el\)/.test(APP_CODE) && /function openUserProfile\(username\)/.test(APP_CODE), 'E4 弹窗入口齐备')
ck(/getElementById\('upProfileModal'\)/.test(APP_CODE), 'E5 弹窗可关闭（同 id 单例）')
ck(APP.indexOf('upProfileModal') > 0 && fs.readFileSync(path.join(D, 'style.css'), 'utf-8').indexOf('.up-link') > 0, 'E6 样式里有 .up-link')
const zh = I18N.slice(I18N.indexOf('zh: {'), I18N.indexOf('en: {') >= 0 ? I18N.indexOf('en: {') : I18N.length)
const en = I18N.slice(I18N.indexOf('en: {'))
const keys = ['upOpenHint', 'upClose', 'upLevelNow', 'upRoundCount', 'upChTitle', 'upChHint', 'upSeriesPre', 'upSeriesFinal',
  'upLvTitle', 'upLvHint', 'upLvNoHistory', 'upLvSingle', 'upLvNone', 'upCourseTitle', 'upCourseHint', 'upNoCourse', 'upNoChallenge',
  'upNoCloudRow', 'upThRound', 'upThDays', 'upThClass', 'upThTask', 'upThScore', 'upSeriesLevel', 'upSeriesCourse', 'upNow']
const missZh = keys.filter(k => zh.indexOf(k + ':') < 0)
const missEn = keys.filter(k => en.indexOf(k + ':') < 0)
ck(missZh.length === 0, 'E7 中文键齐备', missZh.length ? ('缺 ' + missZh.join(',')) : '')
ck(missEn.length === 0, 'E8 英文键齐备', missEn.length ? ('缺 ' + missEn.join(',')) : '')
ck(/upRoundCount: \(n\) => /.test(I18N), 'E9 带参文案写成箭头函数（t() 只对函数值插值）')
ck(/this\._lastEvents = events/.test(CLOUD), 'E10 cloud-store 把本次重放的事件流挂到 _lastEvents')
ck(/_lastEvents/.test(APP_CODE), 'E11 档案读取 _lastEvents 画等级走势')

// 整体渲染冒烟：真实结构喂进去，必须出现三大区块
console.log('\n=== [F] _upProfileHtml 冒烟 ===')
const html = _upProfileHtml(R, DOC, EV)
ck(html.indexOf('upChTitle') > 0, 'F1 出现七天挑战区块')
ck(html.indexOf('upLvTitle') > 0, 'F2 出现定级区块')
ck(html.indexOf('upCourseTitle') > 0, 'F3 出现线下课区块')
ck(html.indexOf('何旭艳') > 0, 'F4 显示姓名')
ck((html.match(/<svg/g) || []).length >= 2, 'F5 至少两张折线图（挑战分数 + 定级）', '(' + (html.match(/<svg/g) || []).length + ')')
ck(!/NaN|undefined/.test(html), 'F6 整片 HTML 无 NaN/undefined')
const htmlEmpty = _upProfileHtml({ username: 'z', name: '无记录' }, null, [])
ck(htmlEmpty.indexOf('upNoChallenge') > 0 && htmlEmpty.indexOf('upNoCourse') > 0, 'F7 空数据走空态文案')

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' v189 学员档案：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
