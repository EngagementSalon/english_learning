// test-v130-rebrand-mobile-topbar.js
// v130 两项改动：
//   ① 站点更名「英语刷题平台 / English Quiz Platform」→「Engagement Salon」
//      （i18n zh/en appTitle + heroTitle、index.html title/authTitle/brandText；
//       renderStaticText 既有接线 setTitle('brandText','appTitle') 等保持不变）
//   ② 手机端顶栏局促修复：隐藏文字标题的断点从 400px 上移到 768px（含 Logo 缩小）
// 本文件自身可能提及旧名（注释），反向断言只对 quiz-unified 五个源文件生效，绝不含本测试文件。
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
const cstore = read('course-store.js');
const store = read('store.js');
const cloud = read('cloud-store.js');
const challenge = read('challenge.js');
const qgen = read('qgen.js');
// 源码全集（不含测试文件自身 —— 旧名只允许出现在本测试注释里）
const SRC_ALL = [idx, i18n, css, app, cou, cstore, store, cloud, challenge, qgen].join('\n');

console.log('--- ① 更名：i18n ---');
assert((i18n.match(/appTitle: 'Engagement Salon'/g) || []).length === 2, '1.1 i18n appTitle zh+en 均为 Engagement Salon（×2）');
assert(!i18n.includes("appTitle: '英语刷题平台'"), '1.2 i18n 无旧 zh appTitle');
assert(!i18n.includes("appTitle: 'English Quiz Platform'"), '1.3 i18n 无旧 en appTitle');
// v131 追加：首页横幅标题改全大写「WELCOME TO ENGAGEMENT SALON 👋」（zh/en 同文案，
// 用户要求全大写；原「欢迎来到 / Welcome to」前缀被推翻 —— 契约更新，非回归）。
assert(i18n.includes("heroTitle: 'WELCOME TO ENGAGEMENT SALON 👋'"), '1.4 zh heroTitle = 全大写 WELCOME TO ENGAGEMENT SALON');
assert((i18n.match(/heroTitle: 'WELCOME TO ENGAGEMENT SALON 👋'/g) || []).length === 2, '1.5 en heroTitle 同文案（zh/en 各一次）');
assert(!i18n.includes('欢迎来到 Engagement Salon'), '1.5a 无旧 zh heroTitle（欢迎来到…）');
assert(!i18n.includes("heroTitle: 'Welcome to Engagement Salon"), '1.5b 无旧首字母大写形态（说明：全大写字母串包含子串 Welcome 不成立，此处断言的是带引号的完整键值前缀）');
assert(!i18n.includes('Welcome to English Quiz Platform'), '1.6 en 无旧 heroTitle');

console.log('--- ② 更名：index.html ---');
assert(idx.includes('<title>Engagement Salon</title>'), '2.1 <title> = Engagement Salon');
assert(idx.includes('id="authTitle">Engagement Salon<'), '2.2 登录页 authTitle 初始值更名');
assert(idx.includes('id="brandText">Engagement Salon<'), '2.3 顶栏 brandText 初始值更名');

console.log('--- ③ 更名：全源码无旧名残留 ---');
assert(!SRC_ALL.includes('英语刷题平台'), '3.1 十个源文件均无「英语刷题平台」');
assert(!SRC_ALL.includes('English Quiz Platform'), '3.2 十个源文件均无「English Quiz Platform」');

console.log('--- ④ renderStaticText 既有接线保持（改名只动文案、不动接线） ---');
assert(i18n.includes("setTitle('authTitle', 'appTitle')"), '4.1 authTitle ← appTitle 接线在场');
assert(i18n.includes("setTitle('brandText', 'appTitle')"), '4.2 brandText ← appTitle 接线在场');
assert(i18n.includes("document.title = t('appTitle')"), '4.3 document.title ← appTitle 接线在场');
// appSubtitle 未被要求改名，应保持
assert(i18n.includes("appSubtitle: '多题型练习 · 模拟考试 · 分类进度'"), '4.4 zh appSubtitle 保持不变');
assert(i18n.includes("appSubtitle: 'Multi-type Practice · Mock Exams · Progress Tracking'"), '4.5 en appSubtitle 保持不变');

console.log('--- ⑤ 手机端顶栏：768px 断点 ---');
// 切出 768px 断点区块（从 @media (max-width: 768px) 到下一个 @media）
const m768 = (() => {
  const s = css.indexOf('@media (max-width: 768px)');
  if (s < 0) return '';
  const e = css.indexOf('@media', s + 10);
  return e > s ? css.slice(s, e) : css.slice(s);
})();
assert(m768.length > 200, '5.0 768px 断点区块非空（切片锚点存在）');
assert(m768.includes('.topbar-brand .brand-text { display: none; }'), '5.1 ≤768px 隐藏顶栏文字标题');
assert(m768.includes('.topbar-brand .logo img.brand-img { max-height: 30px; max-width: 104px; }'), '5.2 ≤768px 缩小顶栏 Logo（30×104）');
assert(m768.includes('.topbar-brand { gap: 6px; }'), '5.3 ≤768px 品牌区 gap 收紧为 6px');
assert(m768.includes('.nav-toggle { display: flex; }'), '5.4 汉堡菜单规则仍在（断点区块完整性）');

console.log('--- ⑥ 400px 断点不再重复旧规则 ---');
const m400 = (() => {
  const s = css.indexOf('@media (max-width: 400px)');
  if (s < 0) return '';
  const e = css.indexOf('@media', s + 10);
  return e > s ? css.slice(s, e) : css.slice(s, s + 600);
})();
assert(m400.length > 30, '6.0 400px 断点区块非空');
assert(!m400.includes('.topbar-brand .brand-text'), '6.1 400px 断点已移除隐藏标题规则（上移至 768）');
assert(m400.includes('.dashboard-summary'), '6.2 400px 断点其余规则保留（dashboard-summary）');

console.log('--- ⑦ 桌面端标题样式不受影响 ---');
assert(/\.topbar-brand \.brand-text \{ font-size:18px; font-weight:700;/.test(css), '7.1 桌面 brand-text 基础样式仍在');
assert(/\.topbar-brand \.logo img\.brand-img \{/.test(css), '7.2 桌面 Logo 基础样式仍在（v126 顶栏 36px 口径不动）');

console.log('--- ⑧ 版本号 ---');
// ★ v131 起改为「弹性断言」：本套件只锁「缓存参数唯一且 ≥130」（v130 是被推翻的旧契约：
//   版本号必须随每版递增，写死 130 会在 v131 上线瞬间变红，属实现细节而非契约）。
const vAll = idx.match(/\?v=(\d+)/g) || [];
const vNums = [...new Set(vAll.map(s => Number(s.slice(3))))];
assert(vAll.length === 12, `8.1 index.html 缓存参数 ×12（实得 ${vAll.length}）`);
assert(vNums.length === 1, `8.2 缓存参数版本唯一（实得 ${vNums.join(',')}）`);
assert(vNums.length === 1 && vNums[0] >= 130, `8.3 版本号 ≥130（实得 ${vNums[0]}）`);

console.log('--- ⑨ 更名不误伤：旧文案的其它消费者 ---');
// hero 区渲染在 app.js renderHome，断言其消费 heroTitle 的接线仍在
assert(app.includes('heroTitle') || cou.includes('heroTitle'), '9.1 heroTitle 仍被页面渲染消费');
// i18n 键成对性抽查：appTitle 在 zh 与 en 两段各一次（1.1 已断 ×2，这里断 en 段内位置在 zh 段之后）
const zhPos = i18n.indexOf("appTitle: 'Engagement Salon'");
const enPos = i18n.indexOf("appTitle: 'Engagement Salon'", zhPos + 10);
assert(zhPos >= 0 && enPos > zhPos, '9.2 zh 段在前、en 段在后（成对）');

console.log('');
console.log(`PASS ${PASS} / FAIL ${FAIL}`);
console.log(FAIL === 0 ? 'ALL PASS' : 'HAS FAILURES');
process.exit(FAIL === 0 ? 0 : 1);
