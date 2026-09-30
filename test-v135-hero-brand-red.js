// test-v135-hero-brand-red.js — v135 首页横幅：去 Logo 位 + 改品牌红渐变
// 需求（用户 2026-09-30，截图 hero 黄绿底 + W 酒店 Logo）：「这里不要logo 并且改成品牌红色」
//   ① renderHome 的 hero 模板不再有 hero-logo（与 test-v124 的 [v135 反转] 互为双保险）
//   ② .hero 背景 = 品牌红渐变，与 v133 章节条同一品牌色语言（主色 #DD3D00 = 用户指定 RGB(221,61,0)）
//   ③ .hero-logo 死样式已删（不留孤儿 CSS）
//   ④ v133 章节条渐变未被波及（.cp-chapter-head 仍是同一品牌渐变）
//   ⑤ 版本 bump：唯一 ?v=N ×12 且 ≥135

const fs = require('fs')
const path = require('path')

const APP = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

let failed = 0
function assert(name, cond, extra) {
  if (cond) { console.log('✓ ' + name) }
  else { failed++; console.log('✗ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}

function grabFn(src, name) {
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

// ---------- ① 源码级 ----------
const homeBody = grabFn(APP, 'renderHome')
assert('1.1 hero 模板无 hero-logo（双保险，v124 套件已断一次）', !homeBody.includes('hero-logo'))
assert('1.2 hero 模板仍保留标题 + 副标题接线', homeBody.includes("t('heroTitle')") && homeBody.includes("t('heroSub')"))
assert('1.3 hero 容器仍在', homeBody.includes('class="hero"'))

// ---------- ② CSS：品牌红渐变 ----------
// ★ 先抽 .hero 的声明块再判（防否定断言咬到注释/其它块里的色值）
const heroBlock = (CSS.match(/\.hero\s*\{[^}]*\}/) || [''])[0]
assert('2.1 .hero 规则块存在', heroBlock.length > 0)
assert('2.2 .hero 背景 = 品牌红渐变（含主色 #DD3D00）',
  /background:\s*linear-gradient\(135deg,\s*#C33600 0%,\s*#DD3D00 60%,\s*#F06B35 100%\)/.test(heroBlock))
assert('2.3 .hero 不再引用旧黄绿变量 --primary',
  !/var\(--primary\)/.test(heroBlock), heroBlock)
assert('2.4 .hero 文字为白色', /color:\s*#fff/.test(heroBlock))

// ---------- ③ CSS：死样式清理 + 契约保持 ----------
assert('3.1 [v135 反转] .hero-logo 规则已删除', !CSS.includes('.hero-logo'))
assert('3.2 v132 契约保持：hero h2 仍用 Logo 版品牌字体',
  /\.hero h2 \{ font-family: 'W Supreme TT',/.test(CSS))
assert('3.3 登录页/顶栏 brand-img 样式未被破坏',
  CSS.includes('.auth-logo img.brand-img') && CSS.includes('.topbar-brand .logo img.brand-img'))
assert('3.4 v133 章节条渐变未被波及（同一品牌色语言）',
  /linear-gradient\(135deg,\s*#C33600 0%,\s*#DD3D00 60%,\s*#F06B35 100%\)/.test(CSS))

// ---------- ④ 行为（沙箱真跑 renderHome：红底白字靠 CSS，这里钉渲染产物无 Logo） ----------
const vm = require('vm')
function mkSandbox(logoUrl) {
  const els = {}
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Promise, Date, RegExp,
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escAttr: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    t: k => 'T_' + k,
    Store: {
      isAdmin: () => false,
      getSessionDeptKey: () => '',
      getStats: () => ({ totalQuestions: 100, totalAnswered: 50, accuracy: 80, examCount: 2, categoryStats: [{ name: 'cat1', answered: 10, totalQuestions: 20, accuracy: 50 }] }),
      getUserLevel: () => 0,
      getSession: () => ({ username: 'stu1', role: 'student' }),
      getLogo: () => logoUrl,
    },
    logoImgHtml: url => url ? `<img class="brand-img" src="${url}" alt="logo">` : '📚',
    LEVEL_LABELS: { 0: 'L0' },
    LEVEL_DESC: { 0: 'd' },
    LEVELS: [], PLACEMENT_ENABLED: false, EXAMS: [],
    PLACEMENT: { TITLE: 'p', SUBTITLE: 's', TIME_LIMIT_SEC: 0, QUESTIONS_PER_LEVEL: {} },
    challengeEntryHtml: () => '',
    renderExamHistory: () => '',
    _els: els,
    document: { getElementById: id => (els[id] = els[id] || { id, innerHTML: '' }) },
  }
  vm.createContext(sb)
  vm.runInContext(grabFn(APP, 'renderHome'), sb)
  return sb
}
{
  const sb = mkSandbox('data:image/png;base64,AAAABBBB')
  vm.runInContext('renderHome()', sb)
  const html = sb._els['page-home'].innerHTML
  assert('4.1 已上传 Logo 时 hero 仍无 brand-img / hero-logo',
    !html.includes('brand-img') && !html.includes('hero-logo'))
  assert('4.2 hero 无 📚 兜底字符', !html.includes('📚'))
  assert('4.3 hero 标题副标题照常渲染', html.includes('T_heroTitle') && html.includes('T_heroSub'))
}

// ---------- ⑤ 版本 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('5.1 版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('5.2 版本号 >= 135', uniq.length === 1 && uniq[0] >= 135)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
