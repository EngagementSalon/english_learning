// test-v133-chapter-group-sticky.js
// v133：学员端「我的学习进度」章节显示方案 = B「容器分组卡」+ C「吸顶章节条」组合。
//   背景：v129 的章节头是「浅色小字横幅」，用户反馈 Episode 部分不显眼；且头/体是平级兄弟，
//         滚到下面时章节头无法跟随（sticky 活动范围 = 最近父容器，头与体同级就等于活动范围是整个列表）。
//   修法：① 用 .cp-chapter 把「头 + 体」包进同一个容器 —— 头随本章滚进滚出，离开本章即被带走；
//         ② 章节头改成深色渐变横幅 + 内嵌白底进度条（chStat 驱动），显著度大幅提升。
//   ★★ 最关键的一条：开块层数与收尾层数必须配平 —— 真章节块开两层（容器 + 体），
//      散项块只开一层。若收尾恒写一层，真章节组少关一个 </div>，浏览器把后续兄弟吞进容器，
//      下一章的章节头就失去独立活动范围（吸顶失效）。本套件用真实解析做配平断言。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname);
let PASS = 0, FAIL = 0;
function assert(cond, name) {
  if (cond) { PASS++; console.log('  ok   ' + name); }
  else { FAIL++; console.log('  ✗    ' + name); }
}
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
// 按函数名切出一段源码（到下一个顶层 function/let/const 声明或文件末尾）
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const rest = src.slice(i + 10);
  const m = rest.match(/\n(?:function |let |const |var |\/\/ ======)/);
  return m ? rest.slice(0, m.index) : rest.slice(0, 6000);
}
// v147：取完整函数声明（配平扫描），用于「沙箱执行」而非「断源码形态」。
//   与上面 fnBody 的区别：fnBody 故意去掉 'function ' 前缀（方便断源码里写 name(args)），
//   执行时必须带前缀；且 fnBody 靠「下一个顶层声明」截断，对含嵌套块的新函数不可靠。
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

const idx = read('index.html');
const css = read('style.css');
const cou = read('course-app.js');

const pathFn = fnBody(cou, 'courseStudentPathHtml');

console.log('--- ① 源码形态：分组容器 + 双层收尾配平 ---');
assert(pathFn.length > 800, '1.0 courseStudentPathHtml 切片非空（锚点存在）');
assert(pathFn.includes("let lastPlain = false"), '1.1 新增 lastPlain 状态（区分真章节块 / 散项块）');
assert(pathFn.includes('rows += lastPlain ? \'</div>\' : \'</div></div>\''),
  '1.2 开新块时按上一块形态收尾（散项关一层 / 真章节关两层）');
// ★ 收尾那一处也必须同款三元 —— 这是 v133 最容易漏的一行
const tailMatches = pathFn.match(/lastChapter !== null\) rows \+= lastPlain \? '<\/div>' : '<\/div><\/div>'/g) || [];
assert(tailMatches.length === 2,
  `1.3 收尾与开块用的是同一条三元（应恰好 2 处，实得 ${tailMatches.length}）`);
assert(!/lastChapter !== null\) rows \+= '<\/div>'\n/.test(pathFn),
  '1.4 不存在「恒关一层」的旧收尾残留');

console.log('--- ② 真实解析：把生成的 HTML 跑一遍，标签必须配平 ---');
// 用沙箱跑真实函数（注入最小依赖），再统计 div 开闭是否配平。
// 这是唯一能抓住「少关一层」的硬断言 —— 纯 grep 抓不到配平。
(function structureCheck() {
  const vm = require('vm');
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
    // v134：本函数新增对章节开关的依赖。v133 这套用例的意图是「分块结构配平」，
    // 因此这里注入一个「全部视为已开放」的桩 —— 保持所有章节都展开渲染，
    // 配平与计数断言才继续验的是结构本身（章节关闭态由 test-v134 专门覆盖）。
    // ★ 注意：v134 起学员端不再直连 CourseStore.chOpen，而是走 courseChapterOpened
    //   收口函数（防御式访问），所以必须注入这个名字 —— 只注入 CourseStore 不够。
    CourseStore: { chKey: s => String(s == null ? '' : s).trim(), chOpen: () => true },
    courseChapterOpened: () => true,
  };
  // ★ fnBody 为了断源码形态，故意从 'function ' 之后 10 个字符开始切（去掉 'function ' 前缀）；
  //   但沙箱执行需要完整的函数声明 —— 这里单独从下标 'function ' 处切，别复用 fnBody。
  const fi = cou.indexOf('function courseStudentPathHtml(');
  const rest = cou.slice(fi);
  const stop = rest.slice(1).search(/\n(?:function |let |const |var |\/\/ ======)/);
  // v147：渲染侧台账读取（courseResetRecSafe / courseRetryUsedSafe，自包含）随被测函数一起注入。
  //   这两个函数是「切出 courseStudentPathHtml 之后」新增的依赖，按名字切片的沙箱不会自动带上。
  const src = grabFn(cou, 'courseResetRecSafe') + '\n' + grabFn(cou, 'courseRetryUsedSafe') + '\n' +
    (stop < 0 ? rest : rest.slice(0, stop + 1));
  const ctx = vm.createContext(sandbox);
  let html = '';
  try {
    vm.runInContext('"use strict";\n' + src + '\nglobalThis.__cp = courseStudentPathHtml;', ctx);
    const fn = sandbox.__cp;
    const myClasses = [{
      id: 'c1', name: 'CE Class',
      members: ['u1'],
      assignments: [
        { id: 'a1', title: 'A1', chapter: '第一章', results: { u1: true } },
        { id: 'a2', title: 'A2', chapter: '第一章', results: {} },
        { id: 'a3', title: 'A3', results: {} },                 // 散项
        { id: 'a4', title: 'A4', chapter: '第二章', results: {} },
        { id: 'a5', title: 'A5', chapter: '第二章', results: {} },
      ],
    }];
    html = fn(myClasses, 'u1') || '';
  } catch (e) {
    html = '';
    console.log('      (沙箱执行异常: ' + e.message + ')');
  }
  assert(html.length > 500, '2.0 真实函数可执行并产出 HTML（沙箱正常）');

  const openDiv = (html.match(/<div\b/g) || []).length;
  const closeDiv = (html.match(/<\/div>/g) || []).length;
  assert(openDiv > 0 && openDiv === closeDiv,
    `2.1 div 开闭配平（开 ${openDiv} / 闭 ${closeDiv}）`);

  const openSpan = (html.match(/<span\b/g) || []).length;
  const closeSpan = (html.match(/<\/span>/g) || []).length;
  assert(openSpan > 0 && openSpan === closeSpan,
    `2.2 span 开闭配平（开 ${openSpan} / 闭 ${closeSpan}）`);

  // 用标签栈做一次真解析：不允许出现「跨块串层」（即某块内还有未闭合的 div 时又开了新块）
  const stack = [];
  const tagRe = /<(\/?)(div|span)\b[^>]*>/g;
  let m, balanceOk = true, firstBad = '';
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2];
    if (!closing) stack.push(tag);
    else {
      if (!stack.length || stack[stack.length - 1] !== tag) { balanceOk = false; firstBad = m[0]; break; }
      stack.pop();
    }
  }
  assert(balanceOk, `2.3 标签栈严格嵌套（无交叉闭合${firstBad ? '，首个异常 ' + firstBad : ''}）`);
  assert(stack.length === 0, `2.4 遍历结束时栈已清空（残留 ${stack.length} 项）`);

  // 章节数与容器数一致：2 个真章节 → 2 个 .cp-chapter；散项 → 1 个 .cp-chapter-plain
  const chapCnt = (html.match(/class="cp-chapter"/g) || []).length;
  const bodyCnt = (html.match(/class="cp-chapter-body"/g) || []).length;
  const plainCnt = (html.match(/cp-chapter-plain/g) || []).length;
  assert(chapCnt === 2, `2.5 两个真章节 → 两个 .cp-chapter 容器（实得 ${chapCnt}）`);
  // ★ 计数口径：真章节是 `class="cp-chapter-body">`（含引号收尾），散项是
  //   `class="cp-chapter-body cp-chapter-plain"`（class 属性里还有第二个类）→ 字面量不同，
  //   所以分开数：恰好 2 + 1 = 3 块体。
  assert(bodyCnt === 2, `2.6 两个真章节 → 两个独立 .cp-chapter-body（实得 ${bodyCnt}）`);
  assert(plainCnt === 1, `2.7 散项恰好一块 .cp-chapter-plain（实得 ${plainCnt}）`);
  assert(bodyCnt + plainCnt === 3, `2.7a 体块总数 = 3（2 真章节 + 1 散项，实得 ${bodyCnt + plainCnt}）`);
  const headCnt = (html.match(/class="cp-chapter-head"/g) || []).length;
  assert(headCnt === 2, `2.8 章节头只给真章节（散项无头，实得 ${headCnt}）`);
  // 散项块绝不能带 head —— 否则散项也会吸顶
  const plainBlock = html.slice(html.indexOf('cp-chapter-plain'));
  assert(!/cp-chapter-head/.test(plainBlock.slice(0, plainBlock.indexOf('cp-chapter', 40) < 0 ? plainBlock.length : plainBlock.indexOf('cp-chapter', 40))),
    '2.9 散项块内不含章节头（散项不吸顶）');

  // 进度条由 chStat 驱动：第一章 1/2 → 50%
  assert(/class="cp-chapter-bar-in" style="width:50%"/.test(html),
    '2.10 第一章进度条宽度 = chStat 计算值（1/2 → 50%）');
  assert(/class="cp-chapter-bar-in" style="width:0%"/.test(html),
    '2.11 第二章进度条宽度 0%（0/2 未完成）');
  assert(html.includes('courseChapterDoneOf:1/2'), '2.12 计数文案由 courseChapterDoneOf 带参产出（1/2）');
  assert(html.includes('courseChapterDoneOf:0/2'), '2.13 计数文案由 courseChapterDoneOf 带参产出（0/2）');
})();

console.log('--- ③ 章节头模板：结构件齐全 ---');
assert(pathFn.includes('class="cp-chapter-head"'), '3.1 章节头 class 契约保持 cp-chapter-head');
assert(pathFn.includes('class="cp-chapter-name"'), '3.2 章节名 class 契约保持 cp-chapter-name');
assert(pathFn.includes('class="cp-chapter-count"'), '3.3 完成计数 class 契约保持 cp-chapter-count');
assert(pathFn.includes('class="cp-chapter-bar"'), '3.4 新增进度条外轨 cp-chapter-bar');
assert(pathFn.includes('class="cp-chapter-bar-in"'), '3.5 新增进度条填充 cp-chapter-bar-in');
assert(pathFn.includes("t('courseChapterDoneOf', chStat.done, chStat.total)"),
  '3.6 计数按带参形态调用（不写完整字面量）');
assert(/const pctCh = chStat\.total \? Math\.round\(chStat\.done \/ chStat\.total \* 100\) : 0/.test(pathFn),
  '3.7 pctCh 有除零保护（total=0 → 0）');

console.log('--- ④ 类名契约：不得引入 cp-side 子串 ---');
// test-v53-review 用 sliceBetween(card,'cp-list','cp-side') 切左侧大纲区间，
// 章节产物里出现该子串会让切片提前收尾、断言静默变空（假绿）。
// ★ 两处坑叠在一起，必须都避开：
//   ① 「否定断言咬到注释自己」—— 本章节注释里写着 'cp-side' 说明原因（第三次撞这个坑了）；
//   ② 「切片范围搞错」—— cp-side 是右侧详情面板（sideHtml）的正常类名，本来就在本函数里。
//      要断的是「章节产物（rows / 左侧大纲）」不含 cp-side，不是整个函数。
//   做法：抽出 rows 的写入语句（rows += ... 直到分块结束），排除注释行后再判。
const rowsRegion = pathFn.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))          // 去掉注释行（坑 ①）
  .filter(l => !/sideHtml|cp-side-count|cp-side-go|cp-side-meta/.test(l)) // 去掉右侧详情面板（坑 ②）
  .join('\n');
assert(!/cp-side/.test(rowsRegion), '4.1 章节产物（rows 区，排除注释与右侧详情）不含 cp-side 子串');
assert(/cp-side/.test(pathFn), '4.1a 保护断言有效性：本函数注释确实提到了 cp-side（断的正是要排除的东西）');
// 保护断言本身：确认 cp-side 在文件里确实存在（说明这条断不是空转）
assert(cou.includes('cp-side'), '4.2 保护断言有效性：course-app.js 别处确实有 cp-side');
// 4.3 之外再钉一条：左侧大纲列表区（cp-list 到 cp-side 之间）也不得出现 cp-side
assert(/<div class="cp-list">\$\{rows\}<\/div>/.test(pathFn),
  '4.2a 左侧大纲仍是 <div class="cp-list">${rows}</div>（v53 切片左锚点未变）');
// cp-node 类名模板保持 v123/v128 原样（既有套件钉住）
assert(pathFn.includes("class=\"cp-node${d ? ' done' : ''}${isNext ? ' next' : ''}\""),
  '4.3 cp-node 类名模板未改动');

console.log('--- ⑤ CSS：分组容器 + 吸顶两档 + 散项排除 ---');
assert(css.includes('.cp-chapter {'), '5.1 新增分组容器 .cp-chapter');
assert(/\.cp-chapter\s*\{[^}]*display:flex/.test(css), '5.2 .cp-chapter 是 flex 列（头体同容器）');
const headRule = (css.match(/\.cp-chapter-head\s*\{[^}]*\}/) || [''])[0];
assert(headRule.includes('position:sticky'), '5.3 .cp-chapter-head 为 sticky');
assert(/top:60px/.test(headRule), '5.4 电脑端吸顶偏移 top:60px（顶栏 60px）');
assert(/z-index:2\d/.test(headRule), '5.5 吸顶层级 z-index 低于顶栏(100)');
assert(/linear-gradient/.test(headRule), '5.6 章节头用渐变横幅（提升显著度）');
// v133 用户指定：章节条用品牌橙 RGB(221,61,0) = #DD3D00（≈ --brand-text）
assert(/#DD3D00/.test(headRule), '5.6a 章节头主色 = 用户指定 #DD3D00（RGB 221,61,0）');
// 手机端偏移档
const mqRules = css.match(/@media \(max-width:768px\)\s*\{[\s\S]*?\n\}/g) || [];
const hasMobileOffset = mqRules.some(r => /\.cp-chapter-head[^}]*top:56px/.test(r));
assert(hasMobileOffset, '5.7 手机端吸顶偏移 top:56px（顶栏 56px），且写在 max-width:768px 同档');
// 顶栏高度契约（吸顶偏移的依赖前提）
assert(/\.topbar\s*\{[\s\S]{0,200}?height:\s*60px/.test(css), '5.8 .topbar 高 60px（吸顶偏移的依据仍在）');
assert(/\.topbar\s*\{\s*height:\s*56px/.test(css), '5.9 手机端 .topbar 高 56px（吸顶偏移的依据仍在）');
// 散项排除在分组卡与吸顶之外
assert(/\.cp-chapter-plain\s*\{[^}]*padding:0/.test(css), '5.10 .cp-chapter-plain 独立规则（散项保持低调）');
assert(!/\.cp-chapter-plain[^{]*\{[^}]*position:sticky/.test(css), '5.11 散项无 sticky');
// 进度条样式
assert(/\.cp-chapter-bar\s*\{[^}]*overflow:hidden/.test(css), '5.12 .cp-chapter-bar 外轨裁剪');
assert(/\.cp-chapter-bar-in\s*\{[^}]*background:var\(--primary\)/.test(css), '5.13 进度条填充用品牌色');
assert(/\.cp-chapter-name\s*\{[^}]*color:#fff/.test(css), '5.14 章节名白字（深底可读）');
// 旧契约（v129 的浅色小字横幅）已被推翻 —— 不应再有「品牌浅底 + 左描边」形态挂在章节头
const oldHead = /\.cp-chapter-head\s*\{[^}]*background:linear-gradient\(90deg, var\(--brand-soft\)/.test(css);
assert(!oldHead, '5.15 v129 的浅色小字横幅形态已移除（契约被 v133 显式推翻）');

console.log('--- ⑥ 版本号与回归口径 ---');
const vAll = idx.match(/\?v=(\d+)/g) || [];
const vNums = [...new Set(vAll.map(s => Number(s.slice(3))))];
assert(vAll.length === 12, `6.1 index.html 缓存参数 ×12（实得 ${vAll.length}）`);
assert(vNums.length === 1 && vNums[0] >= 133, `6.2 版本唯一且 ≥133（实得 ${vNums.join(',')}）`);

console.log('--- ⑦ 反向：未重复定义 / 未破坏既有链路 ---');
assert((cou.match(/function courseStudentPathHtml\(/g) || []).length === 1,
  '7.1 courseStudentPathHtml 只定义一次');
assert((cou.match(/function courseChapterStat\(/g) || []).length === 1,
  '7.2 courseChapterStat 只定义一次（v133 复用它算进度条）');
assert((pathFn.match(/let lastChapter = null/g) || []).length === 1, '7.3 lastChapter 只声明一次');
assert((pathFn.match(/let lastPlain = false/g) || []).length === 1, '7.4 lastPlain 只声明一次');
// 每块只开一次 body：确认没有在循环里重复开 body
// ★ 注意计数口径：散项块写的是 `class="cp-chapter-body cp-chapter-plain"`（class 属性里
//   还有第二个类），所以下面 `class="cp-chapter-body"`（带收尾引号）**不会**命中它。
// ★ [v134 反转] v134 给「真章节」和「散项组」各加了关闭态分支，各自多一处 body 开标签：
//   真章节 开放 1 + 关闭 1 = 2，散项组 关闭 1（开放态走的是 cp-chapter-plain 那条）= 1，
//   合计 3。这仍然满足 v133 要保护的东西 —— 每次进新章节只开一个 body（不是循环里重复开）。
assert((pathFn.match(/class="cp-chapter-body">`/g) || []).length === 3,
  '7.5 [v134 反转] 真章节 body 开标签 = 3（真章节开放/关闭 2 + 散项组关闭态 1）');
assert((pathFn.match(/class="cp-chapter-body"/g) || []).length === 3,
  '7.5a [v134 反转] body 开标签总数 = 3（散项开放态那条带额外 class，不计入此口径）');
// 散项两块形态各一处：开放态 `cp-chapter-body cp-chapter-plain` 与关闭态 `cp-chapter-body`
assert((pathFn.match(/class="cp-chapter-body cp-chapter-plain"/g) || []).length === 1,
  '7.6 散项开放态 body 写法恰好一次');

console.log('--- ⑧ 首页简化：移除「我的班级」卡片列表（v133 第二项） ---');
// ★ 契约反转：卡片列表与「我的学习进度」大纲重复展示同一批作业，用户拍板移除。
//   前提（删除不丢功能的依据，一并钉住）：
//   ① courseTaskDone 已覆盖 待回顾/待答题/低完成度 → 大纲行状态正确；
//   ② courseStart 已内置 线下课→视频→回顾→闸门 完整路由 → 大纲行点击入口等价于卡片按钮。
assert(!cou.includes("t('courseMyTitle')"), '8.1 模板已移除「我的班级」标题（courseMyTitle 不再被调用）');
assert(!cou.includes('myCardsHtml'), '8.2 卡片列表变量及整段生成逻辑已删（无死代码）');
assert(!cou.includes('courseStudentOfflineCard'), '8.3 线下课学员卡函数已删（唯一调用方就是卡片列表）');
// 注意：course-card / course-card-actions 类名被「可加入的班级」卡片合法共用，不能全否定。
// 可加入的班级区块必须保留（新学员的唯一加入入口）
assert(cou.includes('${availHtml}'), '8.4 可加入的班级区块保留');
assert(cou.includes("t('courseAvailTitle')"), '8.5 可加入的班级标题仍在');
// 删除不丢功能的三个前提
const taskDoneFn = fnBody(cou, 'courseTaskDone');
assert(taskDoneFn.includes('courseReviewPending(a, res)'), '8.6 courseTaskDone 仍覆盖待回顾（v53）');
assert(taskDoneFn.includes('courseVideoQuizPending(a, res)'), '8.7 courseTaskDone 仍覆盖视频待答题（v44）');
const startFn = fnBody(cou, 'courseStart');
assert(startFn.includes('courseOfflineInfoModal(cid, aid)'), '8.8 courseStart 仍路由线下课信息页');
assert(startFn.includes('courseStartVideo(cid, aid)'), '8.9 courseStart 仍路由视频播放页');
assert(startFn.includes('courseReviewStart(cid, aid)'), '8.10 courseStart 仍路由待回顾（v53）');
assert(startFn.includes('courseGateLocked(a, me, res)'), '8.11 courseStart 仍含放行闸门（v115/v120）');

console.log('');
console.log(`PASS ${PASS} / FAIL ${FAIL}`);
console.log(FAIL === 0 ? 'ALL PASS' : 'HAS FAILURES');
process.exit(FAIL === 0 ? 0 : 1);
