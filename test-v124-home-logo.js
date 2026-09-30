// test-v124-home-logo.js — v124 学员首页 hero 区加公司 Logo 位
// ① 源码级：renderHome 的 hero 模板含 hero-logo 容器 + logoImgHtml(Store.getLogo()) 真调用（接线断言）
// ② 行为（沙箱真跑 renderHome）：
//    - 无 Logo → hero-logo 内显示 📚 兜底（与登录页/顶栏同口径）
//    - 有 Logo → 输出 <img class="brand-img" src=dataURL>
// ③ CSS：.hero-logo 居中 + 图片约束样式就位
// ④ 版本弹性：唯一 ?v=N ×12 且 ≥124（v123 套件的 ≥123 弹性断言不被破坏）

const fs = require('fs')
const path = require('path')
const vm = require('vm')

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
assert('renderHome 的 hero 模板含 hero-logo 容器', homeBody.includes('class="hero-logo"'))
assert('renderHome 真调用 logoImgHtml(Store.getLogo())（接线断言：函数存在且被模板调用）',
  homeBody.includes('logoImgHtml(Store.getLogo())') && /function logoImgHtml\s*\(/.test(APP))
assert('logoImgHtml 兜底仍为 📚（三处口径一致）', /return url \? `<img class="brand-img" src="\$\{escAttr\(url\)\}" alt="logo">` : '📚'/.test(APP))

// ---------- ② 行为 ----------
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

// 场景 A：无 Logo → 📚 兜底
{
  const sb = mkSandbox('')
  vm.runInContext('renderHome()', sb)
  const html = sb._els['page-home'].innerHTML
  assert('场景A：hero 容器存在且含 hero-logo', html.includes('class="hero"') && html.includes('class="hero-logo"'))
  assert('场景A：无 Logo → hero-logo 内是 📚 兜底', /class="hero-logo">📚</.test(html))
  assert('场景A：hero 标题副标题保留', html.includes('T_heroTitle') && html.includes('T_heroSub'))
}

// 场景 B：有 Logo → img 输出
{
  const sb = mkSandbox('data:image/png;base64,AAAABBBB')
  vm.runInContext('renderHome()', sb)
  const html = sb._els['page-home'].innerHTML
  assert('场景B：有 Logo → hero-logo 内输出 brand-img', /class="hero-logo"><img class="brand-img" src="data:image\/png;base64,AAAABBBB"/.test(html))
}

// ---------- ③ CSS ----------
assert('CSS：.hero-logo 居中样式', CSS.includes('.hero-logo { display:flex; justify-content:center'))
assert('CSS：.hero-logo 图片约束（max-width + object-fit:contain）', /\.hero-logo img\.brand-img \{[^}]*max-width:130px[^}]*object-fit:contain/.test(CSS))
assert('CSS：登录页/顶栏品牌图样式未被破坏', CSS.includes('.auth-logo img.brand-img') && CSS.includes('.topbar-brand .logo img.brand-img'))

// ---------- ④ 版本弹性 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('版本号 >= 124', uniq.length === 1 && uniq[0] >= 124)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
