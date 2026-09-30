// test-v124-home-logo.js — 平台品牌 Logo 位（登录页 / 顶栏 / 首页 hero）
// [v135 反转] 用户要求首页 hero「不要 logo」→ hero-logo 容器已从 renderHome 移除，
//   .hero-logo CSS 一并删除；logoImgHtml 与登录页/顶栏两处 Logo 位保持不变。
//   本套件从「v124：hero 有 Logo 位」反转为「v135：hero 无 Logo 位，其余两处仍在」。
// ① 源码级：renderHome 不再含 hero-logo；logoImgHtml/renderLogo 定义仍在且接线登录页+顶栏
// ② 行为（沙箱真跑 renderHome）：hero 容器有标题副标题、无 hero-logo、无 📚 兜底
// ③ CSS：.hero-logo 样式已删；.auth-logo / .topbar-brand 的 brand-img 样式未破坏
// ④ 版本弹性：唯一 ?v=N ×12 且 ≥124

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
assert('[v135 反转] renderHome 的 hero 模板已无 hero-logo 容器', !homeBody.includes('hero-logo'))
assert('[v135 反转] renderHome 不再调用 logoImgHtml（首页不显示 Logo）',
  !homeBody.includes('logoImgHtml(Store.getLogo())'))
assert('logoImgHtml 函数仍存在（登录页/顶栏共用）', /function logoImgHtml\s*\(/.test(APP))
assert('logoImgHtml 兜底仍为 📚（登录页/顶栏口径不变）', /return url \? `<img class="brand-img" src="\$\{escAttr\(url\)\}" alt="logo">` : '📚'/.test(APP))
assert('renderLogo 仍接线登录页 + 顶栏两处',
  /function renderLogo\s*\(/.test(APP) &&
  APP.includes("document.querySelector('.auth-logo')") &&
  APP.includes("document.querySelector('.topbar-brand .logo')"))

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

// 场景 A：无 Logo → hero 干净（无 logo 位、无兜底字符）
{
  const sb = mkSandbox('')
  vm.runInContext('renderHome()', sb)
  const html = sb._els['page-home'].innerHTML
  assert('场景A：hero 容器存在', html.includes('class="hero"'))
  assert('[v135 反转] 场景A：hero 内无 hero-logo', !html.includes('hero-logo'))
  assert('[v135 反转] 场景A：hero 无 📚 兜底字符', !html.includes('📚'))
  assert('场景A：hero 标题副标题保留', html.includes('T_heroTitle') && html.includes('T_heroSub'))
}

// 场景 B：有 Logo → hero 也不显示（Logo 只出现在登录页/顶栏）
{
  const sb = mkSandbox('data:image/png;base64,AAAABBBB')
  vm.runInContext('renderHome()', sb)
  const html = sb._els['page-home'].innerHTML
  assert('[v135 反转] 场景B：即便已上传 Logo，hero 也不渲染 brand-img',
    !html.includes('brand-img') && !html.includes('hero-logo'))
}

// ---------- ③ CSS ----------
assert('[v135 反转] CSS：.hero-logo 样式已删除', !CSS.includes('.hero-logo'))
assert('CSS：登录页/顶栏品牌图样式未被破坏', CSS.includes('.auth-logo img.brand-img') && CSS.includes('.topbar-brand .logo img.brand-img'))
// [v135/v136] 登录页 Logo 尺寸契约：
//   v126 定为 187×73 → v135「再缩小一半」94×37 → v136「显示完整」改为「只限高、宽自适应」
//   根因：同时给 max-width + max-height 时，图片实际比例比 94:37 更宽 → 按 max-width 定宽后高度被压 → 上下裁切
const authLogoRule = (CSS.match(/\.auth-logo img\.brand-img\s*\{[^}]*\}/) || [''])[0]
assert('[v136 反转] 登录页 Logo 改为只限高（max-height）+ 宽自适应',
  authLogoRule.includes('max-height:38px') && authLogoRule.includes('width:auto') && authLogoRule.includes('height:auto'),
  authLogoRule.slice(0, 140))
assert('[v136 反转] 登录页 Logo 不再用双约束（旧 max-width:94px 已清除）',
  !authLogoRule.includes('max-width:94px') && !authLogoRule.includes('max-height:37px'))
assert('[v136] 登录页 Logo 容器给足高度，避免父级撑不开',
  /\.auth-logo\s*\{[^}]*min-height/.test(CSS))

// ---------- ④ 版本弹性 ----------
const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniq = Array.from(new Set(vms))
assert('版本号统一：唯一值 × 12 处', vms.length === 12 && uniq.length === 1, JSON.stringify(uniq) + ' x' + vms.length)
assert('版本号 >= 124', uniq.length === 1 && uniq[0] >= 124)

console.log(failed ? '✗ ' + failed + ' failed' : '✅ 全部通过')
process.exit(failed ? 1 : 0)
