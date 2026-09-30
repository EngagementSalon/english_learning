// test-v131-offline-chapter-bulk.js
// v131 两项改动：
//   ① 修复「线下课加不上章节」——线下课（type:'offline'）走独立链路：
//      courseCreateOfflineModal/courseCreateOffline + courseEditOfflineModal/courseEditOffline，
//      v129 的章节体系原先只落在 homework/exam/video 的通用弹窗上，线下课完全没有 chapter 字段。
//   ② 新增「批量设置章节」——勾选若干作业一把归入同一章节（或清空归属）。
//      ★ 铁律：批量只写 a.chapter，绝不碰其它字段（video 的 quiz、exam 的 examGate / examOpened）。
// 本文件自身可能提到这些名字（注释/断言字面量），反向断言只针对源码形态，不把本测试文件纳入扫描。
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
  return m ? rest.slice(0, m.index) : rest.slice(0, 4000);
}

const idx = read('index.html');
const i18n = read('i18n.js');
const css = read('style.css');
const cou = read('course-app.js');
const cstore = read('course-store.js');

console.log('--- ① 线下课新建：弹窗含章节输入 ---');
const createModal = fnBody(cou, 'courseCreateOfflineModal');
assert(createModal.length > 200, '1.0 courseCreateOfflineModal 切片非空（锚点存在）');
assert(createModal.includes('id="coChapter"'), '1.1 新建线下课弹窗含 #coChapter 输入框');
assert(createModal.includes('id="coChapterList"'), '1.2 含 datalist#coChapterList 候选');
assert(createModal.includes('courseChapterOptionsHtml(cid)'), '1.3 datalist 候选复用 courseChapterOptionsHtml(cid)');
assert(createModal.includes("t('courseChapterLabel')"), '1.4 标签用 courseChapterLabel');
assert(createModal.includes("t('courseChapterHint')"), '1.5 含章节提示（courseChapterHint）');

console.log('--- ② 线下课新建：写入 chapter ---');
const createFn = fnBody(cou, 'courseCreateOffline');
assert(createFn.length > 200, '2.0 courseCreateOffline 切片非空');
assert(createFn.includes("document.getElementById('coChapter')"), '2.1 从 #coChapter 取值');
assert(/const chapter = \(chEl \? chEl\.value : ''\)\.trim\(\)/.test(createFn), '2.2 chapter 取值 + trim');
assert(createFn.includes("if (chapter) rec.chapter = chapter"), '2.3 非空才写 rec.chapter（空 = 不留字段）');
assert(/type: 'offline'/.test(createFn), '2.4 仍标记 type:offline');
assert(createFn.includes('c.assignments.push(rec)'), '2.5 rec 仍 push 进 assignments');

console.log('--- ③ 线下课编辑：弹窗含章节输入（独立 id） ---');
const editModal = fnBody(cou, 'courseEditOfflineModal');
assert(editModal.length > 200, '3.0 courseEditOfflineModal 切片非空');
assert(editModal.includes('id="ceOffChapter"'), '3.1 编辑线下课弹窗含 #ceOffChapter');
assert(editModal.includes('id="ceOffChapterList"'), '3.2 含 datalist#ceOffChapterList');
assert(editModal.includes("value=\"${escAttr(a.chapter || '')}\""), '3.3 回填当前章节（空值安全）');
assert(!/id="ceChapter"/.test(editModal), '3.4 用的是独立 id，未与通用弹窗的 ceChapter 撞名');

console.log('--- ④ 线下课编辑：写入 / 清除 chapter ---');
const editFn = fnBody(cou, 'courseEditOffline');
assert(editFn.length > 200, '4.0 courseEditOffline 切片非空');
assert(editFn.includes("document.getElementById('ceOffChapter')"), '4.1 从 #ceOffChapter 取值');
assert(editFn.includes('if (chapter) a.chapter = chapter'), '4.2 非空写入 a.chapter');
assert(editFn.includes('else delete a.chapter'), '4.3 留空 = 清除章节归属');
// 线下课编辑绝不能误写作业题目字段
assert(!/a\.questions\s*=/.test(editFn), '4.4 courseEditOffline 不写 a.questions');
assert(!/a\.quiz\s*=/.test(editFn), '4.5 courseEditOffline 不写 a.quiz');
assert(!/a\.videoUrl\s*=/.test(editFn), '4.6 courseEditOffline 不写 a.videoUrl');

console.log('--- ⑤ 批量分章：入口与弹窗 ---');
assert(cou.includes("onclick=\"courseBulkChapterModal('${escAttr(c.id)}')\""), '5.1 班级工具栏有「批量分章」按钮接线');
assert(cou.includes("${t('courseChapterBulkBtn')}"), '5.2 按钮文案用 courseChapterBulkBtn');
assert(cou.includes('let courseBulkChapterSel = null'), '5.3 选择集状态变量在场');
const bulkModalFn = fnBody(cou, 'courseBulkChapterModal');
assert(bulkModalFn.includes("t('courseChapterBulkEmpty')"), '5.4 空班级给提示（courseChapterBulkEmpty）');
assert(bulkModalFn.includes('list.map(a => a.id)'), '5.5 打开时默认全选');
assert(bulkModalFn.includes('courseRenderBulkChapterModal(cid)'), '5.6 委托给渲染函数');

const bulkRender = fnBody(cou, 'courseRenderBulkChapterModal');
assert(bulkRender.length > 300, '5.7 courseRenderBulkChapterModal 切片非空');
assert(bulkRender.includes('class="cbc-chk"'), '5.8 每行复选框 class=cbc-chk');
assert(bulkRender.includes('data-aid="${escAttr(a.id)}"'), '5.9 复选框带 data-aid（不把 id 拼进 onclick）');
assert(bulkRender.includes("onchange=\"courseBulkChapterToggle(this)\""), '5.10 onchange 传 this（接线）');
assert(bulkRender.includes('id="cbcCount"'), '5.11 计数元素 #cbcCount');
assert(bulkRender.includes('id="cbcName"'), '5.12 目标章节输入 #cbcName');
assert(bulkRender.includes('id="cbcChapterList"'), '5.13 datalist#cbcChapterList');
assert(bulkRender.includes('courseModalOpen('), '5.14 走 courseModalOpen 打开');
assert(bulkRender.includes('courseModalClose()'), '5.15 取消按钮接 courseModalClose');

console.log('--- ⑥ 批量分章：全选 / 取消全选 ---');
const bulkAll = fnBody(cou, 'courseBulkChapterAll');
assert(bulkAll.includes("document.querySelectorAll('#courseModal .cbc-chk')"), '6.1 全选选择器挂在 #courseModal（.modal-body 没有 id）');
// 注：「未误用 #modalBody」这条已删 —— 源码里只用「.modal-body 没有 id」这句注释解释原因，
//     对全文 grep '#modalBody' 会命中注释本身（自己咬自己）。改断源码里没有真正拼出 '#modalBody' 选择器。
assert(!/'#modalBody/.test(cou) && !/"#modalBody/.test(cou), '6.2 源码未把 #modalBody 当选择器用（只出现在注释里）');
assert(bulkAll.includes('courseBulkChapterSel = sel'), '6.3 全选后回写选择集');
assert(bulkRender.includes('onclick="courseBulkChapterAll(true)"'), '6.4 「全选」接线');
assert(bulkRender.includes('onclick="courseBulkChapterAll(false)"'), '6.5 「全不选」接线');

console.log('--- ⑦ 批量分章：只写 chapter ---');
const bulkDo = fnBody(cou, 'courseBulkChapterDo');
assert(bulkDo.length > 300, '7.0 courseBulkChapterDo 切片非空');
assert(bulkDo.includes("t('courseChapterBulkNoPick')"), '7.1 未勾选时拦截');
assert(bulkDo.includes("confirm(t('courseChapterBulkConfirm'"), '7.2 提交前 confirm');
assert(bulkDo.includes('CourseStore.mutate('), '7.3 写操作走 CourseStore.mutate');
assert(bulkDo.includes('if (name) a.chapter = name'), '7.4 非空写 a.chapter');
assert(bulkDo.includes('else delete a.chapter'), '7.5 留空清除 a.chapter');
assert(bulkDo.includes('hit++'), '7.6 有 hit 计数');
assert(bulkDo.includes("t('courseChapterBulkDone'"), '7.7 完成后回执');
assert(bulkDo.includes("t('courseChapterBulkFail')") || bulkDo.includes("t('courseWriteFail')"), '7.8 失败有兜底提示');
// 批量分章不得触碰其它字段
assert(!/a\.questions\s*=/.test(bulkDo), '7.9 不写 a.questions');
assert(!/a\.quiz\s*=/.test(bulkDo), '7.10 不写 a.quiz');
assert(!/a\.videoUrl\s*=/.test(bulkDo), '7.11 不写 a.videoUrl');
assert(!/examGate/.test(bulkDo), '7.12 不碰 examGate');
assert(!/examOpened/.test(bulkDo), '7.13 不碰 examOpened 放行名单');
assert(!/a\.held\s*=/.test(bulkDo), '7.14 不碰线下课 held');

console.log('--- ⑧ 候选复用与既有章节链路未被破坏 ---');
assert(cou.includes('function courseChapterOptionsHtml(cid)'), '8.1 courseChapterOptionsHtml 仍在');
const optsFn = fnBody(cou, 'courseChapterOptionsHtml');
assert(optsFn.includes('c.assignments') && optsFn.includes('a.chapter'), '8.2 候选从现有作业的 chapter 去重收集');
// 通用弹窗（homework/exam/video）的章节输入仍在
const saveEdit = fnBody(cou, 'courseSaveAssignEdit');
assert(saveEdit.includes("document.getElementById('ceChapter')"), '8.3 通用编辑弹窗章节写入仍在（v129 链路完好）');
assert(saveEdit.includes("if (type === 'video')"), '8.4 视频作业独立分支仍在');
assert(saveEdit.includes('// 刻意不动：a.quiz / a.videoUrl / a.results'), '8.5 视频分支的「不碰 quiz/videoUrl/results」注释契约仍在');
assert(!/a\.questions = questions/.test(saveEdit.slice(0, saveEdit.indexOf("if (type === 'video')"))), '8.6 视频分支在通用 questions 赋值之前 return（不会被掏空）');

console.log('--- ⑨ i18n 新键 zh/en 成对 ---');
const NEW_KEYS = ['courseChapterBulkBtn', 'courseChapterBulkTitle', 'courseChapterBulkHint',
  'courseChapterBulkAll', 'courseChapterBulkNone', 'courseChapterBulkPicked',
  'courseChapterBulkTarget', 'courseChapterBulkTargetHint', 'courseChapterBulkConfirm',
  'courseChapterBulkDone', 'courseChapterBulkEmpty', 'courseChapterBulkNoPick', 'courseChapterBulkFail'];
let missing = []
// ★ 不能断 "^key:" —— 本项目 i18n 有「一行放多个键」的写法（如 BulkBtn 与 BulkTitle 同一行），
//   行首锚定会漏。用「键名 + 冒号」计数即可（键名唯一，不会误命中别的键）。
NEW_KEYS.forEach(k => { if ((i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length !== 2) missing.push(k) })
assert(missing.length === 0, `9.1 13 个批量分章键 zh+en 各一次（缺: ${missing.join(',') || '无'}）`)
assert(i18n.includes('courseChapterBulkPicked: (n) =>'), '9.2 BulkPicked 是带参函数');
assert(i18n.includes('courseChapterBulkDone: (n, name) =>'), '9.3 BulkDone 是带参函数');
assert(i18n.includes('courseChapterBulkConfirm: (n, name) =>'), '9.4 BulkConfirm 是带参函数');
// 带参键在源码里必须按调用形态断言（不能写完整字面量）
assert(cou.includes("t('courseChapterBulkPicked', sel.length)"), '9.5 源码按带参形态调用 BulkPicked');
assert(cou.includes("t('courseChapterBulkDone', hit, "), '9.6 源码按带参形态调用 BulkDone');
assert(cou.includes("t('courseChapterBulkConfirm', sel.length, "), '9.7 源码按带参形态调用 BulkConfirm');
// 既有章节键未被误删
assert(i18n.includes("courseChapterLabel: '所属章节'"), '9.8 既有 zh courseChapterLabel 未被破坏');
assert(i18n.includes("courseChapterLabel: 'Chapter'"), '9.9 既有 en courseChapterLabel 未被破坏');

console.log('--- ⑩ CSS 与版本号 ---');
['.cbc-toolbar', '.cbc-list', '.cbc-row', '.cbc-count', '.cbc-chk'].slice(0, 4).forEach((cls, i) => {
  assert(css.includes(cls), `10.${i + 1} style.css 含 ${cls}`);
})
assert(/\.cbc-row input\[type="checkbox"\]/.test(css), '10.5 复选框样式在场');
assert(css.indexOf('.cbc-toolbar') > css.indexOf('tr.chapter-sep-plain'), '10.6 v131 样式位于章节分隔样式之后（append 位置正确）');
const vCount = (idx.match(/\?v=131/g) || []).length;
assert(vCount === 12, `10.7 index.html ?v=131 ×12（实得 ${vCount}）`);
assert(!idx.includes('?v=130'), '10.8 无旧版本号 130 残留');

console.log('--- ⑪ 反向：未引入重复定义 ---');
assert((cou.match(/function courseBulkChapterModal\(/g) || []).length === 1, '11.1 courseBulkChapterModal 只定义一次');
assert((cou.match(/function courseBulkChapterDo\(/g) || []).length === 1, '11.2 courseBulkChapterDo 只定义一次');
assert((cou.match(/let courseBulkChapterSel/g) || []).length === 1, '11.3 courseBulkChapterSel 只声明一次');
assert((i18n.match(/courseChapterBulkBtn:/g) || []).length === 2, '11.4 courseChapterBulkBtn 恰好 zh+en 两处');

console.log('');
console.log(`PASS ${PASS} / FAIL ${FAIL}`);
console.log(FAIL === 0 ? 'ALL PASS' : 'HAS FAILURES');
process.exit(FAIL === 0 ? 0 : 1);
