// ====== test-v158-version-badge：页面显眼处显示前端版本号 ======
// 背景（2026-10-12）：项目反复出现「学员看到的是哪一版 / 是否已更新」的排查需求
//   （v156、v157 都在挨个通知学员 Ctrl+F5），但页面上没有任何地方能直接看到版本号，
//   只能靠 F12 看 script src 或反过来问管理员。
// 本版：登录页 + 顶栏各加一个版本号徽章，未登录 / 已登录都能一眼看到。
//
// ★★ 本套件守护的设计红线：
//   1) 版本号**只有一个数据源** = index.html 的资源声明 `?v=N`（12 处）。
//      徽章由 app.js renderAppVersion() 从 DOM 反读 —— 绝不另立 JS 常量（bump 会漏改），
//      也绝不往 index.html 再塞 `?v=` 字面量（多个套件强约束「恰好 12 处且取值唯一」）。
//   2) 定位 app.js 资源时必须用 /(^|\/)app\.js\?/ ——
//      course-app.js 含 'app.js' 子串，宽松写法 /app\.js/ 会误命中（本项目反复踩的子串坑）。
//   3) JS 未执行（脚本报错）时徽章不得留下空胶囊 → CSS :empty 兜底。
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let testFailed = false
function assert(name, cond, msg) {
  if (cond) { console.log('  ✓', name) }
  else { console.log('  ✗', name, '—', msg || ''); testFailed = true }
}
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf-8')
// 去注释后取代码。★ 本版注释里就写着「绝不能用 /app\.js/ 宽松正则」这类反例文本，
//   凡「源码中不含 X」的断言必须查 codeOnly，否则护栏被自己的注释喂饱 → 假失败/假通过。
function codeOnly(src) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  s = s.split('\n').map(line => {
    let inS = null, out = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inS) { out += ch; if (ch === inS && line[i - 1] !== '\\') inS = null; continue }
      if (ch === '"' || ch === "'" || ch === '`') { inS = ch; out += ch; continue }
      if (ch === '/' && line[i + 1] === '/') break
      out += ch
    }
    return out
  }).join('\n')
  return s
}
function extractFn(src, name) {
  const i = src.indexOf('function ' + name)
  if (i < 0) return ''
  let d = 0, started = false
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1) }
  }
  return ''
}
const count = (s, sub) => s.split(sub).length - 1

const APP_SRC = read('app.js')
const HTML_SRC = read('index.html')
const CSS_SRC = read('style.css')
const APP_CODE = codeOnly(APP_SRC)
const HTML_CODE = codeOnly(HTML_SRC)

// ================================================================
console.log('\n[1] 回归契约：index.html 的 ?v= 仍恰好 12 处且取值唯一')
// ================================================================
const vms = (HTML_SRC.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
const uniqV = Array.from(new Set(vms))
assert('版本参数处数 = 12（新增徽章不得再引入 ?v= 字面量）', vms.length === 12, '实得 ' + vms.length)
assert('版本号取值唯一', uniqV.length === 1, JSON.stringify(uniqV))
assert('版本号 ≥ 158（本版已 bump）', uniqV.length === 1 && uniqV[0] >= 158, JSON.stringify(uniqV))
const APP_VER = uniqV[0]
// 宽松计数：连没有数字的裸 '?v=' 也不许新增到 index.html 里（注释里的说明文字也算风险）
assert('index.html 里 \'?v=\' 裸串出现次数 = 12（含注释）', count(HTML_SRC, '?v=') === 12, '实得 ' + count(HTML_SRC, '?v='))

// ================================================================
console.log('\n[2] 徽章元素：登录页 + 顶栏各一处，位置显眼，且自身不带 ?v=')
// ================================================================
const authBadgeI = HTML_SRC.indexOf('id="authVerBadge"')
const topBadgeI = HTML_SRC.indexOf('id="appVerBadge"')
assert('登录页徽章 #authVerBadge 存在', authBadgeI > 0)
assert('顶栏徽章 #appVerBadge 存在', topBadgeI > 0)
assert('两个徽章 id 各自唯一', count(HTML_SRC, 'id="authVerBadge"') === 1 && count(HTML_SRC, 'id="appVerBadge"') === 1)

// 显眼度：登录页徽章必须在 auth-card 内（跟着卡片走，不是屏幕角落）
const authCardEnd = HTML_SRC.indexOf('</div>', HTML_SRC.indexOf('id="authHint"'))
assert('登录页徽章位于 auth-card 内、authHint 之后',
  authBadgeI > HTML_SRC.indexOf('id="authHint"') && authBadgeI < authCardEnd,
  `badge@${authBadgeI} hint@${HTML_SRC.indexOf('id="authHint"')} cardEnd@${authCardEnd}`)

// 显眼度：顶栏徽章必须在 <nav class="topbar"> 区块内（每页常驻）
const topbarStart = HTML_SRC.indexOf('<nav class="topbar">')
const topbarEnd = HTML_SRC.indexOf('</nav>')
assert('顶栏徽章位于 .topbar 区块内（登录后每一页常驻）',
  topBadgeI > topbarStart && topBadgeI < topbarEnd)
assert('顶栏徽章排在文件尾部脚本区之前（确实在顶栏，非误放到 body 末）',
  topBadgeI < HTML_SRC.indexOf('<script'))

// 徽章自身不得带 ?v=（否则破坏 12 处契约）
const authBadgeTag = HTML_SRC.slice(HTML_SRC.lastIndexOf('<span', authBadgeI), HTML_SRC.indexOf('>', authBadgeI) + 1)
const topBadgeTag = HTML_SRC.slice(HTML_SRC.lastIndexOf('<span', topBadgeI), HTML_SRC.indexOf('>', topBadgeI) + 1)
assert('#authVerBadge 标签内不含 ?v=', authBadgeTag.indexOf('?v=') < 0, authBadgeTag)
assert('#appVerBadge 标签内不含 ?v=', topBadgeTag.indexOf('?v=') < 0, topBadgeTag)
assert('两处徽章均带 class="ver-badge"', authBadgeTag.includes('ver-badge') && topBadgeTag.includes('ver-badge'))
assert('两处徽章均可点击刷新（排查旧版时学员可自助）',
  authBadgeTag.includes('onclick="location.reload()"') && topBadgeTag.includes('onclick="location.reload()"'))
assert('两处徽章均有 title 提示', authBadgeTag.includes('title=') && topBadgeTag.includes('title='))
assert('徽章初始为空（由 JS 反读填入，避免双源不一致）',
  /id="authVerBadge"[^>]*><\/span>/.test(HTML_SRC) && /id="appVerBadge"[^>]*><\/span>/.test(HTML_SRC))

// ================================================================
console.log('\n[3] app.js 接线：反读函数存在 + init 调用 + 不硬编码版本号')
// ================================================================
const fnFromDom = extractFn(APP_SRC, 'appVersionFromDom')
const fnText = extractFn(APP_SRC, 'appVersionText')
const fnRender = extractFn(APP_SRC, 'renderAppVersion')
assert('appVersionFromDom 已定义', !!fnFromDom)
assert('appVersionText 已定义', !!fnText)
assert('renderAppVersion 已定义', !!fnRender)
assert('init() 内已调用 renderAppVersion()', APP_CODE.includes('renderAppVersion()'))
assert('版本号来源 = DOM 反读（代码里出现 querySelectorAll）', APP_CODE.includes('querySelectorAll'))
// 单一数据源：不允许把版本号写成常量
assert('未硬编码版本号常量（无 APP_VER/appVersion = \'vNNN\' 之类赋值）',
  !/(APP_VER|APP_VERSION|appVersion|BUILD_VER)\s*=\s*['"`]v?\d+/.test(APP_CODE))
// ★ 子串坑护栏：定位 app.js 的正则必须带左边界，不得用宽松 /app\.js/
assert('用 /(^|\\/)app\\.js\\?/ 精确定位 app.js 资源（不用宽松 /app\\.js/）',
  fnFromDom.includes('/(^|\\/)app\\.js\\?/'))
assert('源码中不存在宽松 /app\\.js/ 写法（codeOnly 口径）',
  !/\/app\\\.js\//.test(APP_CODE))

// ================================================================
console.log('\n[4] 反读逻辑（vm 执行真实函数体）：端到端还原 index.html')
// ================================================================
function mkEl(tag, attrs) {
  return { tag, attrs, getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k] } }
}
function makeDoc(els, badges) {
  return {
    querySelectorAll(sel) {
      const wantScript = sel.indexOf('script[') >= 0
      const wantLink = sel.indexOf('link[') >= 0
      return els.filter(el => {
        if (wantScript && el.tag === 'script' && /[?&]v=/.test(el.attrs.src || '')) return true
        if (wantLink && el.tag === 'link' && /[?&]v=/.test(el.attrs.href || '')) return true
        return false
      })
    },
    getElementById(id) { return (badges && badges[id]) || null },
  }
}
function evalVersionFns(doc) {
  const src = [fnFromDom, fnText, fnRender].join('\n')
  const sb = { console, document: doc }
  vm.createContext(sb)
  vm.runInContext(src, sb)
  return sb
}
// 从真实 index.html 抽出资源列表（顺序与浏览器一致：link 先，script 后）
const realEls = []
HTML_SRC.replace(/<link[^>]*href="([^"]+)"[^>]*>/g, (m, href) => { realEls.push(mkEl('link', { href })); return m })
HTML_SRC.replace(/<script[^>]*src="([^"]+)"[^>]*>/g, (m, src) => { realEls.push(mkEl('script', { src })); return m })
assert('从 index.html 抽出资源数 = 12', realEls.length === 12, '实得 ' + realEls.length)
const realSb = evalVersionFns(makeDoc(realEls, {}))
const realVer = realSb.appVersionFromDom()
assert('真实 index.html → 反读出 ' + APP_VER, realVer === APP_VER, '实得 ' + realVer)
assert('appVersionText() 形如 v<数字>', /^v\d+$/.test(realSb.appVersionText()), realSb.appVersionText())
assert('appVersionText() === v' + APP_VER, realSb.appVersionText() === 'v' + APP_VER)

// ================================================================
console.log('\n[5] 子串坑：course-app.js 不得被误认为 app.js')
// ================================================================
// 刻意把 course-app.js 放在 app.js 之前且版本号不同 —— 宽松正则会取到 course-app.js
const tricky = [
  mkEl('link', { href: 'style.css?v=' + APP_VER }),
  mkEl('script', { src: 'course-app.js?v=9999' }),
  mkEl('script', { src: 'app.js?v=' + APP_VER }),
]
const trickyVer = evalVersionFns(makeDoc(tricky, {})).appVersionFromDom()
assert('同时存在 course-app.js?v=9999 与 app.js?v=' + APP_VER + ' 时取后者', trickyVer === APP_VER, '实得 ' + trickyVer)
// 反证：用「宽松正则 + 取第一个」的错误实现，会误得到 course-app.js 的版本号 9999
//   （正确实现取的是 app.js 的 158）—— 证明上面那条断言真的在防什么
const looseEl = tricky.find(el => /app\.js/.test(el.getAttribute('src') || ''))
const looseVer = looseEl ? Number((looseEl.getAttribute('src').match(/[?&]v=(\d+)/) || [])[1]) : 0
assert('反证：宽松 /app\\.js/ 取首个匹配会误得 9999，而正确实现得 ' + APP_VER,
  looseVer === 9999 && trickyVer === APP_VER, 'loose=' + looseVer + ' strict=' + trickyVer)

// ================================================================
console.log('\n[6] 兜底：取不到版本号 / 元素缺失 均不得抛错')
// ================================================================
const noElsSb = evalVersionFns(makeDoc([], {}))
assert('无任何带版本参数资源 → appVersionFromDom() 返回 0', noElsSb.appVersionFromDom() === 0)
assert('无任何带版本参数资源 → appVersionText() 返回 v?（不显示 NaN/undefined）',
  noElsSb.appVersionText() === 'v?' && !/NaN|undefined/.test(noElsSb.appVersionText()))
// 只有非 app.js 的资源：允许回落到任意带 v= 的资源（比显示 v? 有用）
const onlyOther = evalVersionFns(makeDoc([mkEl('script', { src: 'challenge.js?v=' + APP_VER })], {}))
assert('无 app.js 资源时回落到其它带版本参数的资源', onlyOther.appVersionFromDom() === APP_VER)
// 元素缺失 / 只有一个元素：不抛错，且已有的那个被写入
const badges = { appVerBadge: { textContent: '' } }
const partialSb = evalVersionFns(makeDoc(realEls, badges))
let partialThrew = false, partialOut = ''
try { partialOut = partialSb.renderAppVersion() } catch (e) { partialThrew = true }
assert('仅顶栏元素存在时不抛错', !partialThrew)
assert('仅顶栏元素存在时仍写入该元素', badges.appVerBadge.textContent === 'v' + APP_VER, badges.appVerBadge.textContent)
assert('renderAppVersion() 返回写入的文本', partialOut === 'v' + APP_VER)
// 两个元素都在：都写入
const both = { appVerBadge: { textContent: '' }, authVerBadge: { textContent: '' } }
evalVersionFns(makeDoc(realEls, both)).renderAppVersion()
assert('登录页与顶栏两处徽章都写入同一版本号',
  both.appVerBadge.textContent === 'v' + APP_VER && both.authVerBadge.textContent === 'v' + APP_VER,
  JSON.stringify([both.appVerBadge.textContent, both.authVerBadge.textContent]))
assert('写入文本形如 v<数字>', /^v\d+$/.test(both.appVerBadge.textContent))

// ================================================================
console.log('\n[7] CSS：徽章样式 + 空态兜底 + 手机端保留可见')
// ================================================================
assert('.ver-badge 基础样式已定义', /\.ver-badge\s*\{/.test(CSS_SRC))
assert('.ver-badge 用等宽字体（版本号易读）', /\.ver-badge\s*\{[^}]*monospace/.test(CSS_SRC))
assert('.ver-badge 有 :empty 兜底（JS 未执行时不显示空胶囊）', /\.ver-badge:empty\s*\{\s*display\s*:\s*none/.test(CSS_SRC))
assert('.ver-badge-row 登录页居中容器已定义', /\.ver-badge-row\s*\{/.test(CSS_SRC))
// 手机端：不得把版本号隐藏掉（它是排查旧版的关键信号）
const m768 = CSS_SRC.slice(CSS_SRC.indexOf('@media (max-width: 768px)'))
const m768Block = m768.slice(0, m768.indexOf('\n@media', 10) > 0 ? m768.indexOf('\n@media', 10) : m768.length)
assert('手机端 .ver-badge-top 有独立规则', m768Block.includes('.ver-badge-top'))
assert('手机端未隐藏顶栏版本号（不出现 display:none 隐藏它）',
  !/\.ver-badge(-top)?[^{]*\{[^}]*display\s*:\s*none/.test(m768Block))

// ================================================================
console.log('\n[8] 与既有顶栏/登录页契约不冲突')
// ================================================================
assert('顶栏站名 brandText 仍在', HTML_SRC.includes('id="brandText"'))
assert('云端状态指示 cloudStatus 仍在（徽章是新增而非替换）', HTML_SRC.includes('id="cloudStatus"'))
assert('登录页 authHint 仍在', HTML_SRC.includes('id="authHint"'))
assert('v130 手机端隐藏顶栏文字标题规则未被破坏',
  CSS_SRC.includes('.topbar-brand .brand-text { display: none; }'))
assert('auth-card 结构未被破坏（徽章之后即闭合 ver-badge-row → auth-card）',
  /<\/span>\s*<\/div>\s*<\/div>/.test(HTML_SRC.slice(authBadgeI, authBadgeI + 300)),
  JSON.stringify(HTML_SRC.slice(authBadgeI, authBadgeI + 220)))

console.log(testFailed ? '\n❌ 有失败' : '\n✅ 全部通过')
process.exit(testFailed ? 1 : 0)
