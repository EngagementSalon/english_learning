// test-v134-chapter-switch.js
// v134：章节开关 —— 默认所有内容都是关闭状态，管理员逐章手动开启。
//
// 需求原文：「第三 默认所有内容都是关闭状态 管理员需要手动开启每个章节」
//
// ★★★ 本功能最容易错的地方是「默认关闭」与「线上存量班级」的语义冲突：
//   线上已有一批学员正在用的班级，若无记录就直接判为关闭，上线瞬间全员被锁死 ——
//   那是事故不是需求。故本套件的第一组断言全部围绕这条口径：
//     运行时判据 = chOpen[键] === true 才算开放（缺 map / 缺键 / 非 true 一律关闭）；
//     「默认关闭」通过「新建班时打 chInit + 当时已有章节显式记 true」落地；
//     存量班级首次读到时由 _migrateChOpenDoc 就地回填 → 老学员体验零变化。
//
// 分组：
//   ① 数据口径：判据 / 迁移 / 幂等 / 已关章节不被迁移重开 / 未分章保留键
//   ② 管理端：分节行带开关按钮（含散项组）+ 就地切换 + 写明确 true/false
//   ③ 学员端：关闭章节整章收起（作业行不渲染）+ 章节条锁定态 + 进度条不泄露
//   ④ 入口拦截：courseStart 章节闸门置顶于所有分支之前
//   ⑤ i18n 双语成对 + CSS 锁定态 + 版本号
//   ⑥ 真实结构配平（沙箱跑 courseStudentPathHtml，混合开放/关闭章节）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let PASS = 0, FAIL = 0;
function assert(cond, name) {
  if (cond) { PASS++; console.log('  ok   ' + name); }
  else { FAIL++; console.log('  ✗    ' + name); }
}
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
// 切出一个函数体（到下一个顶层声明为止）
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const rest = src.slice(i + 10);
  const m = rest.match(/\n(?:function |let |const |var |\/\/ ======)/);
  return m ? rest.slice(0, m.index) : rest.slice(0, 6000);
}
// v147：取完整函数声明（配平扫描）—— 供「沙箱执行」用。
//   fnBody 故意去掉 'function ' 前缀（方便断源码里写 name(args)），且靠「下一个顶层声明」截断，
//   对含嵌套块的新函数不可靠；执行必须用带前缀 + 配平扫描的版本。
function grabFn(src, name) {
  const re = new RegExp('(^|\\n)function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('grabFn not found: ' + name);
  const start = m.index + m[1].length;
  let i = src.indexOf('{', start), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(start, i + 1);
}

const CS = require('./course-store.js');
const CA = read('course-app.js');
const CSS = read('style.css');
const I18N = read('i18n.js');
const HTML = read('index.html');

// ========== ① 数据口径 ==========
console.log('\n[1] 数据口径：默认关闭 / 存量回填 / 幂等');
{
  // —— 存量班级（无 chInit）：回填后旧章节全开放 ——
  const legacy = {
    id: 'c1', name: '存量班', members: ['u1'],
    assignments: [
      { id: 'a1', title: 'A1', chapter: '第一章' },
      { id: 'a2', title: 'A2', chapter: '第一章' },
      { id: 'a3', title: 'A3' },                    // 散项
      { id: 'a4', title: 'A4', chapter: '第二章' },
    ],
  };
  assert(CS.chOpen(legacy, '第一章') === false, '1.1 迁移前：无记录 → 关闭（这就是「默认关闭」判据）');
  const touched = CS._migrateChOpen(legacy);
  assert(touched === true && legacy.chInit === true, '1.2 存量班级被回填并打 chInit 标记');
  assert(CS.chOpen(legacy, '第一章') === true && CS.chOpen(legacy, '第二章') === true,
    '1.3 存量班级的历史章节回填为已开放（老学员体验不变）');
  assert(CS.chOpen(legacy, '') === true, '1.4 存量散项组（未分章键）同样回填为已开放');
  assert(CS._migrateChOpen(legacy) === false, '1.5 回填幂等：第二次不再写入');

  // —— 回填后新增的章节 → 关闭 ——
  legacy.assignments.push({ id: 'a5', title: 'A5', chapter: '第三章' });
  assert(CS.chOpen(legacy, '第三章') === false, '1.6 回填后新加章节 → 关闭（默认关闭真正生效）');
  assert(CS._migrateChOpen(legacy) === false && CS.chOpen(legacy, '第三章') === false,
    '1.7 再次回填不会把新章节自动开放（chInit 一次性）');

  // —— 管理员关过的章节不被迁移重开 ——
  const closed = { id: 'c2', name: '班', chInit: true, chOpen: { '第一章': false },
    assignments: [{ id: 'a1', title: 'A1', chapter: '第一章' }] };
  CS._migrateChOpen(closed);
  assert(CS.chOpen(closed, '第一章') === false, '1.8 已关闭的章节在回填时保持关闭（不被重新打开）');

  // —— 新建班：打 chInit 阻断回填 ——
  const fresh = { id: 'c3', name: '新班', members: [], assignments: [] };
  CS.initChOpenForNewClass(fresh);
  assert(fresh.chInit === true, '1.9 新建班打 chInit（阻断存量回填路径）');
  assert(CS._migrateChOpen(fresh) === false, '1.10 新建班不会被回填');
  fresh.assignments.push({ id: 'a1', title: 'A1', chapter: '第一章' });
  assert(CS.chOpen(fresh, '第一章') === false, '1.11 新建班加章节 → 默认关闭');

  // —— 判据的严格性 ——
  assert(CS.chOpen(null, 'x') === false, '1.12 chOpen(null) 不抛且为 false');
  assert(CS.chOpen({}, 'x') === false, '1.13 班级无 chOpen 字段 → false');
  assert(CS.chOpen({ chOpen: { A: 'yes' } }, 'A') === false, '1.14 非布尔 true 一律关闭');
  assert(CS.chKey('  第一章  ') === '第一章', '1.15 chKey 去首尾空格（键口径统一）');

  // —— 未分章保留键用空串，与真实章节名不串味 ——
  const trick = { id: 'c4', chInit: true, chOpen: { '': true, '__none__': false }, assignments: [] };
  assert(CS.chOpen(trick, '') === true && CS.chOpen(trick, '__none__') === false,
    '1.16 未分章键（空串）可独立开放，且不与同名真实章节混用');

  // —— 键保序去重 ——
  assert(JSON.stringify(CS.chNames(legacy)) === JSON.stringify(['第一章', '', '第二章', '第三章']),
    '1.17 chNames 按作业顺序去重、含散项键');
}

// ========== ② 管理端 ==========
console.log('\n[2] 管理端：分节行开关 + 就地切换');
{
  const toggleBtn = fnBody(CA, 'courseChapterToggleBtn');
  assert(toggleBtn.length > 100, '2.0 courseChapterToggleBtn 存在');
  assert(toggleBtn.includes('data-cid=') && toggleBtn.includes('data-ch='),
    '2.1 按钮用 data-cid / data-ch 传值（章节名不拼进 onclick 字面量 → 防 v85 引号截断）');
  assert(toggleBtn.includes('onclick="courseChapterToggle(this)"'),
    '2.2 onclick 走 this 形式读取（不内联拼接值）');
  assert(toggleBtn.includes("t('courseChapterOpenTag')") && toggleBtn.includes("t('courseChapterLockedTag')"),
    '2.3 开放 / 关闭两态文案都走 i18n');
  assert(toggleBtn.includes('courseChapterOpened('),
    '2.4 按钮状态取自 courseChapterOpened 收口函数（防御式访问，不直连 CourseStore）');

  // 接线断言：分节行必须真的调用它（「函数存在」≠「功能存在」，v100 教训）
  const renderFn = CA.slice(CA.indexOf('async function courseRenderClass('));
  const sepRegion = renderFn.slice(0, renderFn.indexOf('if (a.type === \'offline\')'));
  assert((sepRegion.match(/\$\{courseChapterToggleBtn\(/g) || []).length === 2,
    '2.5 分节行两条分支（真章节 + 散项组）都接线了开关按钮');
  assert(sepRegion.includes("courseChapterToggleBtn(c.id, chName)"),
    '2.6 真章节分支传章节名');
  assert(sepRegion.includes("courseChapterToggleBtn(c.id, '')"),
    '2.7 散项分支传空串键（未分章组也可开关）');
  assert(/class="chapter-sep\$\{courseChapterOpened/.test(sepRegion),
    '2.8 分节行按开放态加 class（供 CSS 灰化）');
  assert(sepRegion.includes('chapter-sep-locked'), '2.9 关闭态有专属 class chapter-sep-locked');

  // 切换落库
  const doFn = fnBody(CA, 'courseChapterToggleDo');
  assert(doFn.length > 300, '2.10 courseChapterToggleDo 存在');
  assert(doFn.includes('CourseStore.mutate'), '2.11 切换走 CourseStore.mutate（读改写 + 写后校验）');
  assert(/c\.chOpen\[key\] = nextOpen/.test(doFn),
    '2.12 切换写明确的 true/false');
  assert(!/delete c\.chOpen\[/.test(doFn),
    '2.13 切换不删键（删键会被下次回填当成存量章节重新开放）');
  assert(doFn.includes('if (cur === nextOpen) return false'),
    '2.14 幂等保护：值已一致则短路不写');
  assert(doFn.includes('c.chInit = true'), '2.15 切换兜底置 chInit（防该班仍处未初始化态）');
  assert(doFn.includes('confirm('), '2.16 切换前二次确认（误点不会静默锁住一整章）');
  assert(doFn.includes('t(nextOpen ?') || /\? 'courseChapterOpen/.test(doFn),
    '2.17 确认文案按方向取键');

  // 点开入口转发
  const togFn = fnBody(CA, 'courseChapterToggle');
  assert(togFn.includes('getAttribute(\'data-cid\')') && togFn.includes('getAttribute(\'data-ch\')'),
    '2.18 courseChapterToggle 从 dataset 取值后转发');
  assert(togFn.includes('courseChapterToggleDo(cid, chName)'), '2.19 转发到 Do（接线完整）');

  // 新建班初始化
  const createFn = fnBody(CA, 'courseCreateClass');
  assert(createFn.includes('CourseStore.initChOpenForNewClass(cls)'),
    '2.20 新建班调用初始化（打 chInit → 后续新增章节默认关闭）');
  assert(createFn.includes('const cls = {'), '2.21 新建班改为先构造对象再初始化（不再是内联 push 字面量）');
}

// ========== ③ 学员端 ==========
console.log('\n[3] 学员端：关闭章节整章收起 + 锁定章节条');
{
  const pathFn = fnBody(CA, 'courseStudentPathHtml');
  assert(pathFn.includes('const isNewChapter = chName !== lastChapter'),
    '3.1 在「进入新章节」处判定一次（isNewChapter 收口）');
  assert(pathFn.includes('if (isNewChapter) chOpenCur = courseChapterOpened(c, chName)'),
    '3.1a 开放态在章节边界处取一次并写入 chOpenCur');
  // ★★ 这是本版最隐蔽的一个坑，必须钉住：绝不能用「chName !== lastChapter ? chOpen : undefined」
  //    这种三元写法 —— 同一章节里第 2 行起会拿到 undefined，而 `undefined === false` 为假，
  //    于是关闭章节里只有第 1 个作业被收起、第 2 个照常显示（实测漏渲染）。
  assert(!/chName !== lastChapter \? CourseStore\.chOpen/.test(pathFn),
    '3.1b [防线] 不得用三元内联判定开放态（第 2 行起会拿到 undefined 而漏渲染）');
  assert(/let chOpenCur = false/.test(pathFn) && /if \(chOpenCur === false\) continue/.test(pathFn),
    '3.2 关闭章节内的作业行不渲染（判定用跨行沿用的 chOpenCur）');
  assert(/rows \+= chOpenCur\s*\n?\s*\? `<div class="cp-chapter">/.test(pathFn),
    '3.3 章节条按开放态二选一渲染');
  assert(pathFn.includes('cp-chapter cp-chapter-closed'), '3.4 关闭态容器加 cp-chapter-closed');
  assert(pathFn.includes('cp-chapter-head cp-chapter-head-locked'), '3.5 关闭态章节条加 cp-chapter-head-locked');
  assert(pathFn.includes('🔒 ${escHtml(chName)}'), '3.6 关闭章节条显 🔒');
  assert(pathFn.includes("t('courseChapterLocked')"), '3.7 关闭章节条显「未开放」文案（走 i18n）');
  // 关闭分支绝不能带进度条 —— 进度属于被收起的内容
  const closedBranch = pathFn.slice(pathFn.indexOf('cp-chapter cp-chapter-closed'), pathFn.indexOf('lastPlain = false'));
  assert(!closedBranch.includes('cp-chapter-bar'),
    '3.8 关闭章节条不渲染进度条（不泄露被收起章节的完成度）');
  assert(!closedBranch.includes('cp-chapter-doneof') && !closedBranch.includes('courseChapterDoneOf'),
    '3.9 关闭章节条不渲染 x/y 完成计数');
  // 开放分支保持 v133 原样
  const openBranch = pathFn.slice(pathFn.indexOf('? `<div class="cp-chapter">'), pathFn.indexOf('cp-chapter cp-chapter-closed'));
  assert(openBranch.includes('📚 ${escHtml(chName)}'), '3.10 开放章节条保持 📚 前缀（v133 契约）');
  assert(openBranch.includes('cp-chapter-bar-in'), '3.11 开放章节条保留进度条（v133 契约）');
  assert(openBranch.includes("t('courseChapterDoneOf', chStat.done, chStat.total)"),
    '3.12 开放章节条保留 x/y 计数（v133 契约）');
  // 行序号 / 下一步判定必须仍然把被收起的作业算进去
  assert(/const nextIdx = assigns\.findIndex/.test(pathFn),
    '3.13 nextIdx 仍在全量 assigns 上计算（进度环不受开关影响）');
  assert(/const isNext = i === nextIdx && i === visNextIdx/.test(pathFn),
    '3.14 ▶ 角标只在「可见的下一步」上标（被锁的那一步不标）');
  assert(/const dotTxt = d \? '✓' : \(isNext \? '▶' : String\(i \+ 1\)\)/.test(pathFn),
    '3.14a 行序号仍用全量下标 i（开放后立刻回到正确的那一步）');
  // v150 契约反转：visNextIdx 的章节跳过条件多了「放行豁免」这一支 ——
  //   已被逐人放行的最终考试即使所在章节关闭，也仍在「可见的下一步」候选里。
  //   ★ 用户原话：「我的解锁键作为最高权限 无视是否完成所有章节」。
  assert(/let visNextIdx = -1/.test(pathFn) &&
    /if \(!courseChapterOpened\(c, assigns\[i\]\.chapter\) && !courseFinalReleasedBypass\(assigns\[i\], me\)\) continue/.test(pathFn),
    '3.14b 新增 visNextIdx：跳过关闭章节内的作业，但已放行的最终考试豁免（v150）');
  assert(pathFn.includes("t('courseChapterWaitOpen')"),
    '3.14c 「还有作业在未开放章节」有独立文案（不让学员误以为全部做完）');
  assert(/const allDone = nextIdx === -1/.test(pathFn) && /allDone \? '🎉 ' \+ t\('courseProgressAllDone'\)/.test(pathFn),
    '3.14d 真做完（🎉）与「等开放」（🔒）文案分流');
  // v134：散项组关闭态也要有锁定条（否则「未分章」组被关时学员毫无提示）
  assert(/lastPlain = chOpenCur/.test(pathFn),
    '3.16 散项组的块形态随开放态切换（开放=低调体块 / 关闭=锁定条+体块）');
  assert(/<span class="cp-chapter-name">🔒 \$\{t\('courseChapterNone'\)\}<\/span>/.test(pathFn),
    '3.17 散项组关闭态渲染「🔒 未归入章节」锁定条');
  assert(pathFn.includes("? `<div class=\"cp-chapter-body cp-chapter-plain\">`"),
    '3.18 散项组开放态保持 v133 的低调体块写法（无头无吸顶）');
  assert((pathFn.match(/lastChapter !== null\) rows \+= lastPlain \? '<\/div>' : '<\/div><\/div>'/g) || []).length === 2,
    '3.18a 两处收尾仍与开块形态严格配平（2 处三元）');
  // 层数配平那条三元必须原样保留（v133 的核心保护）
  const tail = pathFn.match(/lastChapter !== null\) rows \+= lastPlain \? '<\/div>' : '<\/div><\/div>'/g) || [];
  assert(tail.length === 2, `3.15 v133 双层收尾配平仍在（应 2 处，实得 ${tail.length}）`);
}

// ========== ④ 入口拦截 ==========
console.log('\n[4] courseStart 章节闸门');
{
  const startFn = fnBody(CA, 'courseStart');
  // v150 契约反转：章节闸门条件带上了 `&& !alreadyReleased` 豁免支 ——
  //   放行键 = 最高权限，已被逐人放行的最终考试无视章节锁（用户明确要求）。
  assert(startFn.includes('if (!courseChapterOpened(c, a.chapter) && !alreadyReleased)'),
    '4.1 courseStart 有章节闸门（直达链接 / 旧缓存两条路子都能摸进来）');
  const iGate = startFn.indexOf('if (!courseChapterOpened(c, a.chapter) && !alreadyReleased)');
  const iDraft = startFn.indexOf("a.status === 'draft'");
  const iOffline = startFn.indexOf('courseOfflineInfoModal(cid, aid)');
  const iVideo = startFn.indexOf('courseStartVideo(cid, aid)');
  const iReview = startFn.indexOf('courseReviewStart(cid, aid)');
  const iExamGate = startFn.indexOf('courseGateLocked(a, me, res)');
  assert(iGate > 0, '4.2 闸门存在');
  assert(iGate > iDraft, '4.3 闸门在草稿拦截之后（草稿提示优先）');
  assert(iGate < iOffline && iGate < iVideo && iGate < iReview && iGate < iExamGate,
    '4.4 闸门置于 线下课/视频/回顾/放行闸门 所有分支之前（章没开放就不该有任何反应）');
  // v150：豁免支必须在闸门之前算出来，且只认 coursefinal + 已放行。
  const iBypass = startFn.indexOf('const alreadyReleased =');
  assert(iBypass > 0 && iBypass < iGate,
    '4.4a 豁免判定 alreadyReleased 在章节闸门之前计算（v150）');
  assert(/const alreadyReleased = courseIsFinal\(a\) && courseGateOpenedFor\(a, me0\)/.test(startFn),
    '4.4b 豁免条件 = 最终考试 且 已被逐人放行（普通测评不豁免）');
  assert(startFn.includes("alert(t('courseChapterNotOpen'") , '4.5 拦截文案走 i18n 键 courseChapterNotOpen');
  assert(/String\(a\.chapter == null \? '' : a\.chapter\)\.trim\(\) \|\| t\('courseChapterNone'\)/.test(startFn),
    '4.6 未分章作业被拦时显示「未归入章节」而非空串');
}

// ========== ⑤ i18n / CSS / 版本 ==========
console.log('\n[5] i18n 双语成对 + CSS 锁定态 + 版本号');
{
  const keys = ['courseChapterOpenTag', 'courseChapterLockedTag', 'courseChapterOpenHint',
    'courseChapterCloseHint', 'courseChapterOpenConfirm', 'courseChapterCloseConfirm',
    'courseChapterOpened', 'courseChapterClosed', 'courseChapterLocked', 'courseChapterNotOpen',
    'courseChapterWaitOpen'];
  let allPaired = true, badKey = '';
  keys.forEach(k => {
    const n = (I18N.match(new RegExp('\\b' + k + ':', 'g')) || []).length;
    if (n !== 2) { allPaired = false; badKey = k + ' ×' + n; }
  });
  assert(allPaired, `5.1 v134 新增 ${keys.length} 个 i18n 键 zh/en 全部成对` + (badKey ? ' → ' + badKey : ''));
  // zh 侧不得残留英文占位（粗检：确认 zh 区块里出现中文）
  const zhRegion = I18N.slice(0, I18N.indexOf("en: {"));
  assert(/courseChapterOpenTag: '🔓 已开放'/.test(zhRegion), '5.2 zh 侧文案为中文');
  const enRegion = I18N.slice(I18N.indexOf("en: {"));
  assert(/courseChapterOpenTag: '🔓 Open'/.test(enRegion), '5.3 en 侧文案为英文');

  // CSS
  assert(/\.cp-chapter-head-locked\s*\{[^}]*linear-gradient/.test(CSS),
    '5.4 锁定章节条用灰色渐变（与品牌橙开放态形成对比）');
  assert(/\.cp-chapter-closed\s+\.cp-chapter-body\s*\{[^}]*padding:0/.test(CSS),
    '5.5 关闭章节的体区无内边距（无内容时不占空白）');
  assert(/tr\.chapter-sep-locked\s*>\s*td\s*\{[^}]*background:#f3f4f6/.test(CSS),
    '5.6 管理端关闭章节的分节行灰化');
  assert(/\.chapter-sep-toggle\.open\s*\{/.test(CSS) && /\.chapter-sep-toggle\.locked\s*\{/.test(CSS),
    '5.7 开关按钮两态各有样式');
  // 反向：不得让锁定章节条也吸顶成品牌橙（两类视觉必须可区分）
  const lockedRule = (CSS.match(/\.cp-chapter-head-locked\s*\{[^}]*\}/) || [''])[0];
  assert(!/#DD3D00/.test(lockedRule), '5.8 锁定章节条不使用品牌橙 #DD3D00（与开放态区分）');

  // 版本
  const vAll = HTML.match(/\?v=(\d+)/g) || [];
  const vNums = [...new Set(vAll.map(s => Number(s.slice(3))))];
  assert(vAll.length === 12, `5.9 index.html 缓存参数 ×12（实得 ${vAll.length}）`);
  assert(vNums.length === 1 && vNums[0] >= 134, `5.10 版本唯一且 ≥134（实得 ${vNums.join(',')}）`);
}

// ========== ⑥ 真实结构配平 ==========
console.log('\n[6] 真实渲染：混合开放/关闭章节的结构配平');
{
  const sandbox = {
    escHtml: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escAttr: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (k, a, b) => (a === undefined ? k : `${k}:${a}/${b}`),
    courseTaskDone: (a, r) => !!r,
    courseTaskIcon: () => '[i]',
    courseTaskMetaText: () => 'meta',
    courseIsOffline: () => false,
    courseChapterStat: (assigns, me, chName) => {
      let done = 0, total = 0;
      (assigns || []).forEach(a => {
        if (String(a.chapter == null ? '' : a.chapter).trim() !== chName) return;
        total++; if (me && (a.results || {})[me]) done++;
      });
      return { done, total };
    },
    // 真实 CourseStore 的判定逻辑（与 sh 侧同口径，避免桩与实现漂移）。
    // ★ v134 后学员端不再直连 CourseStore.chOpen，而是走 courseChapterOpened 收口函数，
    //   所以沙箱里也必须注入这个名字（提取源码时它会一并被 eval）。
    CourseStore: { chKey: CS.chKey, chOpen: CS.chOpen },
    courseChapterOpened: (cls, chName) => CS.chOpen(cls, chName) === true,
  };
  const fi = CA.indexOf('function courseStudentPathHtml(');
  const rest = CA.slice(fi);
  const stop = rest.slice(1).search(/\n(?:function |let |const |var |\/\/ ======)/);
  // v147：渲染侧台账读取（courseResetRecSafe / courseRetryUsedSafe，自包含）随被测函数一起注入。
  //   它们是「切出 courseStudentPathHtml 之后」新增的依赖，按名切片的沙箱不会自动带上。
  // v148：再加 courseGateWaitFor（同为渲染链新增依赖，同上）。
  // v150：再加 courseFinalReleasedBypass / courseChapterHasReleasedFinal
  //   （放行键压过章节锁，渲染链新增依赖，同上）。
  const src = grabFn(CA, 'courseResetRecSafe') + '\n' + grabFn(CA, 'courseRetryUsedSafe') + '\n' +
    grabFn(CA, 'courseGateWaitFor') + '\n' +
    grabFn(CA, 'courseFinalReleasedBypass') + '\n' + grabFn(CA, 'courseChapterHasReleasedFinal') + '\n' +
    (stop < 0 ? rest : rest.slice(0, stop + 1));
  const ctx = vm.createContext(sandbox);
  let html = '';
  const myClasses = [{
    id: 'c1', name: 'CE Class', members: ['u1'],
    chInit: true,
    chOpen: { '第一章': true, '第二章': false, '': true },   // 二章关闭、未分章组开放
    assignments: [
      { id: 'a1', title: 'A1', chapter: '第一章', results: { u1: true } },
      { id: 'a2', title: 'A2', chapter: '第一章', results: {} },
      { id: 'a3', title: 'A3', chapter: '第二章', results: {} },   // 关闭 → 整章收起
      { id: 'a4', title: 'A4', chapter: '第二章', results: {} },   // 关闭 → 整章收起
      { id: 'a5', title: 'A5', results: {} },                      // 散项（开放组）
    ],
  }];
  try {
    vm.runInContext('"use strict";\n' + src + '\nglobalThis.__cp = courseStudentPathHtml;', ctx);
    html = sandbox.__cp(myClasses, 'u1') || '';
  } catch (e) {
    html = '';
    console.log('      (沙箱执行异常: ' + e.message + ')');
  }
  assert(html.length > 400, '6.0 真实函数可执行（沙箱正常）');

  const openDiv = (html.match(/<div\b/g) || []).length;
  const closeDiv = (html.match(/<\/div>/g) || []).length;
  assert(openDiv > 0 && openDiv === closeDiv,
    `6.1 div 开闭配平（开 ${openDiv} / 闭 ${closeDiv}）`);
  const openSpan = (html.match(/<span\b/g) || []).length;
  const closeSpan = (html.match(/<\/span>/g) || []).length;
  assert(openSpan > 0 && openSpan === closeSpan,
    `6.2 span 开闭配平（开 ${openSpan} / 闭 ${closeSpan}）`);

  // 标签栈严格嵌套（唯一能抓「少关一层」的硬断言）
  const stack = [];
  const tagRe = /<(\/?)(div|span)\b[^>]*>/g;
  let m, balanceOk = true, firstBad = '';
  while ((m = tagRe.exec(html))) {
    if (m[1] !== '/') stack.push(m[2]);
    else {
      if (!stack.length || stack[stack.length - 1] !== m[2]) { balanceOk = false; firstBad = m[0]; break; }
      stack.pop();
    }
  }
  assert(balanceOk, `6.3 标签栈严格嵌套（无交叉闭合${firstBad ? '，首个异常 ' + firstBad : ''}）`);
  assert(stack.length === 0, `6.4 遍历结束栈已清空（残留 ${stack.length} 项）`);

  // 关闭章节：容器与章节条都在，但作业行不渲染
  assert((html.match(/class="cp-chapter cp-chapter-closed"/g) || []).length === 1,
    '6.5 恰好一个关闭章节容器');
  assert((html.match(/cp-chapter-head-locked/g) || []).length === 1, '6.6 关闭章节有锁定章节条');
  // ★ 同样必须限定在左侧大纲区：右侧「下一步」提示会合法地带一个作业标题。
  const listStart = html.indexOf('<div class="cp-list">');
  const listEnd = html.indexOf('<div class="cp-side"');
  const leftRegion = listStart < 0 ? '' : html.slice(listStart, listEnd < 0 ? html.length : listEnd);
  assert(leftRegion.length > 50, '6.6a 左侧大纲区切片非空');
  assert(!leftRegion.includes('A3') && !leftRegion.includes('A4'),
    '6.7 关闭章节内的作业行整章收起（A3/A4 标题在左侧大纲里一律不出现）');
  // 开放章节的作业行照常
  assert(leftRegion.includes('A1') && leftRegion.includes('A2'), '6.8 开放章节的作业行照常渲染');
  assert(leftRegion.includes('A5'), '6.9 散项（开放组）的作业行照常渲染');
  // 章节条数量：第一/第二章有头，散项无头
  assert((html.match(/class="cp-chapter-head"/g) || []).length === 1,
    '6.10 仅开放章节有普通章节头（关闭那条走 locked class）');
  assert((html.match(/class="cp-chapter-head cp-chapter-head-locked"/g) || []).length === 1,
    '6.11 关闭章节头形态唯一');
  // 进度条只在开放章节出现
  assert((html.match(/cp-chapter-bar-in/g) || []).length === 1,
    '6.12 进度条只在开放章节出现（关闭章节不泄露完成度）');
  assert(/class="cp-chapter-bar-in" style="width:50%"/.test(html),
    '6.13 开放章节进度条按 chStat 计算（1/2 → 50%）');
  // ★ 切片纪律：按「容器起点」切片，不拿章节名当锚点。
  //   ★★ 左锚点必须用完整开标签 `<div class="cp-chapter cp-chapter-closed">`（含收尾 >）。
  //      若只用 `cp-chapter-closed`（class 名子串），会命中 CSS 类名本身/更早的同名位置；
  //      而若用 `indexOf('<div class="cp-chapter ')` 这种松锚点又容易被 open 分支先命中。
  const CLOSED_OPEN = '<div class="cp-chapter cp-chapter-closed">';
  const closedStart = html.indexOf(CLOSED_OPEN);
  assert(closedStart >= 0, '6.15a 关闭块锚点命中（完整开标签切片）');
  // 关闭块的结束 = 下一个兄弟块的起点。候选：下一个 .cp-chapter / 散项体块 / 右侧面板。
  const afterClosed = html.slice(closedStart + CLOSED_OPEN.length)
    .search(/<div class="cp-chapter |<div class="cp-chapter-body cp-chapter-plain"|<div class="cp-side"/);
  const closedRegion = html.slice(closedStart,
    afterClosed < 0 ? html.length : closedStart + CLOSED_OPEN.length + afterClosed);
  assert(closedRegion.length > 100, '6.15b 关闭块切片非空（锚点有效）');
  assert(!closedRegion.includes('courseChapterDoneOf'),
    '6.14 关闭章节区不含完成度计数文案');
  assert(closedRegion.includes('courseChapterLocked'),
    '6.15 关闭章节区含「未开放」文案');
  assert(!closedRegion.includes('cp-node'), '6.15c 关闭章节区内不含任何作业行（整章收起）');
  // cp-node 类名模板未被破坏
  assert(html.includes('class="cp-node done"') || html.includes('class="cp-node'),
    '6.16 cp-node 行仍正常产出');
  // 反向：整章收起后不能只剩空壳 —— 体区仍在（保证收尾配平），但无作业行
  assert((html.match(/class="cp-chapter-body"/g) || []).length === 2,
    '6.17 两个真章节体区都保留（关闭只收起内容，不改块结构）');

  // ---- 第二组：全部关闭（用户要求的「默认全关」极端态）----
  const allClosed = [{
    id: 'c2', name: '全新班', members: ['u1'], chInit: true, chOpen: {},
    assignments: [
      { id: 'b1', title: 'B1', chapter: '第一章', results: {} },
      { id: 'b2', title: 'B2', results: {} },
    ],
  }];
  let html2 = '';
  try { html2 = sandbox.__cp(allClosed, 'u1') || ''; } catch (e) { html2 = ''; }
  assert(html2.length > 200, '6.18 全关闭态可渲染');
  // ★ 左栏（cp-list 区）内不得出现任何作业行标题 —— 但右侧「下一步」提示会带标题，
  //   所以切片范围必须限定在左侧大纲区（leftRegion），不能对整个 html 做否定断言
  //   （这正是「切片范围纪律」：断「A 区不含 X」前先问 X 在其它区段是否合法内容）。
  const listStart2 = html2.indexOf('<div class="cp-list">');
  const listEnd2 = html2.indexOf('<div class="cp-side"');
  const leftRegion2 = listStart2 < 0 ? '' : html2.slice(listStart2, listEnd2 < 0 ? html2.length : listEnd2);
  assert(leftRegion2.length > 50, '6.18a 左侧大纲区切片非空');
  assert(!leftRegion2.includes('B1') && !leftRegion2.includes('B2'),
    '6.19 全关闭时左侧大纲里所有作业行都不渲染（B1/B2 均不出现）');
  assert(!leftRegion2.includes('cp-node'), '6.19a 左侧大纲内零个作业行元素');
  // 章节条：真章节「第一章」+ 散项「未分章」组 → 两条都锁定
  assert((leftRegion2.match(/cp-chapter-head-locked/g) || []).length === 2,
    `6.20 全关闭时两条章节条均锁定（真章节 + 未分章组），实得 ${(leftRegion2.match(/cp-chapter-head-locked/g) || []).length}`);
  assert(!leftRegion2.includes('cp-chapter-plain'),
    '6.20a 惰性开块生效：散项组全被收起时不留空壳 .cp-chapter-plain');
  const o2 = (html2.match(/<div\b/g) || []).length, c2 = (html2.match(/<\/div>/g) || []).length;
  assert(o2 === c2, `6.21 全关闭态 div 仍配平（开 ${o2} / 闭 ${c2}）`);
  // 标签栈严格嵌套（全关闭是「开块最少」的极端态，最容易暴露收尾不配平）
  const stack2 = [];
  const tagRe2 = /<(\/?)(div|span)\b[^>]*>/g;
  let m2, ok2 = true, bad2 = '';
  while ((m2 = tagRe2.exec(html2))) {
    if (m2[1] !== '/') stack2.push(m2[2]);
    else {
      if (!stack2.length || stack2[stack2.length - 1] !== m2[2]) { ok2 = false; bad2 = m2[0]; break; }
      stack2.pop();
    }
  }
  assert(ok2 && stack2.length === 0, `6.22 全关闭态标签栈严格嵌套且清空${bad2 ? '（异常 ' + bad2 + '）' : ''}`);
  // 右侧面板不得提示一个被锁的作业 ——「等开放」文案就位
  assert(html2.includes('courseChapterWaitOpen'),
    '6.23 全关闭时右侧提示「等老师开放」而非「下一步：B1」');
  assert(!/cp-tip[^>]*>courseProgressNext/.test(html2),
    '6.24 全关闭时不出现「下一步」提示（避免引导学员点被锁的作业）');
}

// ========== ⑦ 反向：未破坏既有链路 ==========
console.log('\n[7] 反向：未破坏既有链路');
{
  assert((CA.match(/function courseStudentPathHtml\(/g) || []).length === 1,
    '7.1 courseStudentPathHtml 只定义一次');
  assert((CA.match(/function courseChapterToggleBtn\(/g) || []).length === 1, '7.2 开关按钮函数只定义一次');
  assert((CA.match(/function courseChapterToggleDo\(/g) || []).length === 1, '7.3 切换函数只定义一次');
  assert((CA.match(/function courseChapterRenameModal\(/g) || []).length === 1, '7.4 章节改名仍只定义一次（v129 未受影响）');
  // 章节改名 / 批量分章的既有行为不受开关影响
  const renameFn = fnBody(CA, 'courseChapterRenameDo');
  assert(!renameFn.includes('chOpen'), '7.5 章节改名不改动开关状态（改名≠开放）');
  // CourseStore 既有能力仍在
  assert(typeof CS.mutate === 'function' && typeof CS.renameUser === 'function',
    '7.6 CourseStore 既有能力未受影响');
  assert(typeof CS._applyResultOp === 'function', '7.7 成绩补传链路未受影响');
  // 迁移只改内存副本，不做额外网络往返
  assert(/_migrateChOpenDoc\(doc\)/.test(CS._fetchDoc.toString()),
    '7.8 存量回填挂在 _fetchDoc（学员端 getDoc 也走这条路 → 才不会先被锁）');
  // ★ v134：判定读写的「唯一收口」函数存在且是防御式的
  const acc = fnBody(CA, 'courseChapterOpened');
  assert(acc.length > 100, '7.9 courseChapterOpened 收口函数存在');
  assert(acc.includes("typeof CourseStore.chOpen !== 'function'"), '7.10 缺方法时优雅降级（不炸整页渲染）');
  assert(/return true/.test(acc), '7.11 降级方向 = fail-open（宁可多显示，不白屏）');
  assert(acc.includes('return CourseStore.chOpen(cls, chName) === true'),
    '7.12 正常路径仍走严格 === true（不回退到 truthy 判定）');
  assert(!/!!courseChapterOpened\(/.test(CA), '7.13 [防线] 收口函数体内不得自我递归（改名批量替换易踩）');
}

console.log('');
console.log(`PASS ${PASS} / FAIL ${FAIL}`);
console.log(FAIL ? 'HAS FAILURES' : 'ALL PASS');
process.exit(FAIL ? 1 : 0);
