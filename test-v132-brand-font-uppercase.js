// test-v132-brand-font-uppercase.js
// v132 两项改动：
//   ① 站名一律全大写「ENGAGEMENT SALON」（`<title>` / #authTitle / #brandText / i18n appTitle zh+en）。
//      原首字母大写形态被用户显式推翻 —— 契约更新，非回归。
//   ② 品牌字体 W Supreme TT（Logo 版）+ W Supreme（Medium 版）woff2 接入。
//      ★ 关键契约：Logo 版只有大写 + 小写 a~d（264 字形），**绝不能进 body 字体栈**，
//        只允许挂在全大写品牌字样的专用规则上；body 用完整字族的 Medium 版。
//        若把 Logo 版放进 body，含小写英文的文案会逐字母掉回退字体 → 同句两种字形破相。
// 本文件自身可能提及这些名字（注释/断言字面量），反向断言只针对源码形态。
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

const idx = read('index.html');
const i18n = read('i18n.js');
const css = read('style.css');
const app = read('app.js');
const cou = read('course-app.js');

console.log('--- ① 站名全大写 ---');
assert((i18n.match(/appTitle: 'ENGAGEMENT SALON'/g) || []).length === 2, '1.1 i18n appTitle zh+en 全大写（×2）');
assert(idx.includes('<title>ENGAGEMENT SALON</title>'), '1.2 <title> 全大写');
assert(idx.includes('id="authTitle">ENGAGEMENT SALON<'), '1.3 登录页 authTitle 全大写');
assert(idx.includes('id="brandText">ENGAGEMENT SALON<'), '1.4 顶栏 brandText 全大写');
assert((i18n.match(/heroTitle: 'WELCOME TO ENGAGEMENT SALON 👋'/g) || []).length === 2, '1.5 heroTitle 全大写（v131 契约保持）');
// 反向：不允许首字母大写形态残留
assert(!i18n.includes("appTitle: 'Engagement Salon'"), '1.6 i18n 无首字母大写 appTitle 残留');
assert(!idx.includes('>Engagement Salon<'), '1.7 index.html 无首字母大写站名（元素内容）');
assert(!idx.includes('<title>Engagement Salon'), '1.8 index.html 无首字母大写站名（title）');

console.log('--- ② 字体文件在场且为 woff2 ---');
const fLogo = path.join(ROOT, 'fonts', 'WSupremeTT-Logo.woff2');
const fMed = path.join(ROOT, 'fonts', 'WSupreme-Medium.woff2');
assert(fs.existsSync(fLogo), '2.1 fonts/WSupremeTT-Logo.woff2 存在');
assert(fs.existsSync(fMed), '2.2 fonts/WSupreme-Medium.woff2 存在');
if (fs.existsSync(fLogo)) {
  const b = fs.readFileSync(fLogo);
  assert(b.slice(0, 4).toString('ascii') === 'wOF2', '2.3 Logo 版是真 woff2（魔数 wOF2）');
  assert(b.length > 15000 && b.length < 60000, `2.4 Logo 版体积合理（实得 ${b.length}B）`);
}
if (fs.existsSync(fMed)) {
  const b = fs.readFileSync(fMed);
  assert(b.slice(0, 4).toString('ascii') === 'wOF2', '2.5 Medium 版是真 woff2（魔数 wOF2）');
  assert(b.length > 30000 && b.length < 120000, `2.6 Medium 版体积合理（实得 ${b.length}B）`);
}
// 不应保留未压缩的原文件（避免仓库里双份）
assert(!fs.existsSync(path.join(ROOT, 'fonts', 'WSupremeTT-Logo.ttf')), '2.7 未保留冗余 .ttf');
assert(!fs.existsSync(path.join(ROOT, 'fonts', 'WSupreme-Medium.otf')), '2.8 未保留冗余 .otf');

console.log('--- ③ @font-face 声明 ---');
assert(css.includes("@font-face {\n  font-family: 'W Supreme TT';"), '3.1 有 W Supreme TT 的 @font-face');
assert(css.includes("@font-face {\n  font-family: 'W Supreme';"), '3.2 有 W Supreme 的 @font-face');
assert(css.includes("url('fonts/WSupremeTT-Logo.woff2?v="), '3.3 Logo 版 URL 带缓存参数');
assert(css.includes("url('fonts/WSupreme-Medium.woff2?v="), '3.4 Medium 版 URL 带缓存参数');
assert((css.match(/format\('woff2'\)/g) || []).length === 2, '3.5 两处均声明 format(woff2)');
assert((css.match(/font-display: swap/g) || []).length >= 2, '3.6 均带 font-display:swap（避免首屏白字）');

console.log('--- ④ ★ body 字体栈只放 Medium（Logo 版绝不能进）---');
const bodyRule = (() => {
  const i = css.indexOf('\nbody {');
  if (i < 0) return '';
  const e = css.indexOf('}', i);
  return e > i ? css.slice(i, e + 1) : css.slice(i, i + 600);
})();
// ★ 只在「声明行」上判定，别让注释里「刻意不放 'W Supreme TT'」的说明咬到自己。
//   正确形态 = 取 body 规则里的 font-family 声明值，而非整段裸 includes。
const bodyFF = (bodyRule.match(/font-family:\s*([^;]+);/) || [])[1] || '';
assert(bodyFF.length > 0, '4.1a 能取到 body 的 font-family 声明值');
assert(/^\s*'W Supreme'\s*,/.test(bodyFF), '4.1 body 字体栈首位是 W Supreme（Medium 完整字族）');
assert(bodyFF.indexOf("'W Supreme TT'") < 0, '4.2 ★ body 字体栈未混入 Logo 版（否则小写英文字母掉字形）');
assert(!/\bTT\b/.test(bodyFF), '4.2a body 声明值里完全不含 TT 字样');
assert(bodyRule.includes('-apple-system') && bodyRule.includes('sans-serif'), '4.3 系统字体回退链保留');

console.log('--- ⑤ 品牌字样专用规则用 Logo 版 ---');
// 三处全大写品牌字样：顶栏 #brandText / 登录页 #authTitle / 首页 hero h2
assert(/#authTitle \{ font-family: 'W Supreme TT',/.test(css), '5.1 登录页站名用 Logo 版');
assert(/\.topbar-brand \.brand-text \{ font-family: 'W Supreme TT',/.test(css), '5.2 顶栏站名用 Logo 版');
assert(/\.hero h2 \{ font-family: 'W Supreme TT',/.test(css), '5.3 首页横幅标题用 Logo 版');
// 每处都要有回退（万一 woff2 加载失败）。
// ★ 计数前先剔除 @font-face 里那句裸声明 `font-family: 'W Supreme TT';`（它不是挂载点）。
const logoDecls = css.match(/font-family: 'W Supreme TT'[^;]*;/g) || [];
const logoUses = logoDecls.filter(r => r.includes(','));
assert(logoUses.length === 3, `5.4 Logo 版恰好挂 3 处品牌字样（实得 ${logoUses.length}）`);
assert(logoUses.every(r => r.includes('W Supreme') && r.includes('sans-serif')), '5.5 三处均带回退字体栈');
// 字距：全大写品牌字样略放开
assert((css.match(/letter-spacing: \.0[34]em/g) || []).length >= 3, '5.6 三处品牌字样均设了字距');

console.log('--- ⑥ 站名到字体的接线（改名/改字体后仍能生效）---');
assert(i18n.includes("setTitle('authTitle', 'appTitle')"), '6.1 authTitle ← appTitle 接线在场');
assert(i18n.includes("setTitle('brandText', 'appTitle')"), '6.2 brandText ← appTitle 接线在场');
assert(i18n.includes("document.title = t('appTitle')"), '6.3 document.title ← appTitle 接线在场');
assert(app.includes('heroTitle'), '6.4 heroTitle 仍被首页渲染消费');
// 文案与实际字形匹配：Logo 版只覆盖大写 → 挂它的三个位置文案必须全大写（无小写拉丁字母）
const WORDMARKS = [
  ["i18n appTitle", (i18n.match(/appTitle: '([^']*)'/) || [])[1] || ''],
  ["index authTitle", (idx.match(/id="authTitle">([^<]*)</) || [])[1] || ''],
  ["index brandText", (idx.match(/id="brandText">([^<]*)</) || [])[1] || ''],
  ["i18n heroTitle", (i18n.match(/heroTitle: '([^']*)'/) || [])[1] || ''],
];
let lowerBad = []
WORDMARKS.forEach(([n, v]) => { if (/[a-z]/.test(v)) lowerBad.push(`${n}="${v}"`) })
assert(lowerBad.length === 0, `6.5 ★ 挂 Logo 版字体的文案均无小写字母（违规: ${lowerBad.join('; ') || '无'}）`);

console.log('--- ⑦ 版本号 ---');
const vAll = idx.match(/\?v=(\d+)/g) || [];
const vNums = [...new Set(vAll.map(s => Number(s.slice(3))))];
assert(vAll.length === 12, `7.1 缓存参数 ×12（实得 ${vAll.length}）`);
assert(vNums.length === 1 && vNums[0] >= 132, `7.2 版本唯一且 ≥132（实得 ${vNums.join(',')}）`);
assert(!idx.includes('?v=131'), '7.3 无 ?v=131 残留');

console.log('--- ⑧ 反噬检查：旧样式未被误伤 ---');
assert(css.includes('.cp-chapter-head'), '8.1 v129 章节样式仍在');
assert(css.includes('.cbc-toolbar'), '8.2 v131 批量分章样式仍在');
assert(/\.topbar-brand \.brand-text \{ font-size:18px; font-weight:700;/.test(css), '8.3 v130 桌面 brand-text 基础样式仍在');
assert(css.includes('.topbar-brand .brand-text { display: none; }'), '8.4 v130 手机端隐藏站名规则仍在');
assert(!css.includes('fonts.googleapis') && !css.includes('fonts.gstatic'), '8.5 未引入外部字体源（自托管）');

console.log('');
console.log(`PASS ${PASS} / FAIL ${FAIL}`);
console.log(FAIL === 0 ? 'ALL PASS' : 'HAS FAILURES');
process.exit(FAIL === 0 ? 0 : 1);
