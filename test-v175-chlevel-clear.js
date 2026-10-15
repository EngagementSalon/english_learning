// test-v175-chlevel-clear.js
// v175：chlevel 事件新增「清除」语义（d.clear === true → delete base[u].chLevel）
//
// 【需求原话】「这个人的成绩那么差怎么评定的L4？」—— 胡佳欣：云端七天挑战记录 0 条，
//   但看板显示 L4。根因 = v166 迁移把旧水平测定级（placementLevel）平移成 chLevel，
//   其中 15 人从未在挑战里练过，等级没有任何挑战数据支撑。
//   拍板：清掉这 15 人的迁移等级，改显「未评定」，等真实挑战数据按 v165/v174 口径重评。
//
// 【本套件锁定的契约】
//   · d.clear === true → delete r.chLevel（幂等：重放多次结果相同）
//   · 清除语义在 lv 守卫**之前**判断（守卫 fail-closed，放后面永远走不到）
//   · 只带 d.clear 的旧格式事件不影响：d.clear 非 true 时仍按 lv 守卫走（v166 行为不变）
//   · 「先设 L4 再清除」重放后 chLevel 不存在（最后写入者胜 + 清除可重放）
//   · 清除后再设等级 → 正常生效（事件链顺序语义）
//   · 清除事件对 map 里不存在的用户 → 自建默认记录（无 chLevel 字段），不崩

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const CS = fs.readFileSync(path.join(__dirname, 'cloud-store.js'), 'utf-8')
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8')

let pass = 0, fail = 0
const fails = []
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')) }
}
function group(t) { console.log('\n' + t) }

function extractMethod(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) throw new Error('method not found: ' + sig)
  let k = src.indexOf('{', i), depth = 0
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(i, k + 1)
}
const codeOnly = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

function makeApplySandbox() {
  const sb = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Set, Map, RegExp, isFinite,
    _roundSlugKey: k => {
      const s = String(k == null ? '' : k).trim()
      return (!s || s === 'r1' || s === '第一期') ? '' : s
    },
  }
  sb.window = sb
  sb.globalThis = sb
  vm.createContext(sb)
  vm.runInContext('const __methods = {\n' + extractMethod(CS, '_apply(map, ev)') + '\n}\n', sb)
  return sb
}
const apply = (sb, map, ev) => vm.runInContext('__methods._apply', sb)(map, ev)
const mkUser = () => ({
  name: '', dept: '', role: 'student', createdAt: 0, lastActive: 0,
  loginCount: 0, loginSec: 0, practiceCount: 0, practiceCorrect: 0, practiceTotal: 0,
  examCount: 0, examScoreSum: 0, examBest: 0, examPassCount: 0,
  placementLevel: 0, perQ: {},
})
const mkEv = (o) => Object.assign({ u: 'u1', n: '甲', ts: 1000, ty: 'chlevel', d: {} }, o)

// ===================== 组一：清除语义核心契约 =====================
group('组一：d.clear === true → delete chLevel')
{
  const sb = makeApplySandbox()
  const map = {}
  map.u1 = mkUser(); map.u1.chLevel = 4   // 模拟迁移遗产：L4
  apply(sb, map, mkEv({ u: 'u1', d: { clear: true } }))
  assert('★★★ L4 被清除（chLevel 不存在）', !('chLevel' in map.u1), map.u1.chLevel)
  // 幂等：重放同一事件多次结果相同
  apply(sb, map, mkEv({ u: 'u1', d: { clear: true } }))
  apply(sb, map, mkEv({ u: 'u1', d: { clear: true } }))
  assert('★★ 清除幂等（重放 3 次仍不存在）', !('chLevel' in map.u1))
  // 清除后再设等级 → 正常生效（事件链顺序语义）
  apply(sb, map, mkEv({ u: 'u1', ts: 2000, d: { lv: 2 } }))
  assert('★ 清除后可再设等级（事件链顺序：clear → lv=2）', map.u1.chLevel === 2, map.u1.chLevel)
  // 再清一次 → 又没了
  apply(sb, map, mkEv({ u: 'u1', ts: 3000, d: { clear: true } }))
  assert('★ 再清一次 → 又不存在（clear 与 lv 可任意交错）', !('chLevel' in map.u1))
}

// ===================== 组二：v166 原行为不被破坏（回归护栏） =====================
group('组二：d.clear 非 true 时 v166 行为逐值不变')
{
  const sb = makeApplySandbox()
  const map = {}
  // 正常设级
  apply(sb, map, mkEv({ u: 'a', d: { lv: 3 } }))
  assert('lv=3 → chLevel=3（v166 行为不变）', map.a.chLevel === 3)
  // 守卫仍 fail-closed：0 / 1.5 / 5 / undefined 不写入
  apply(sb, map, mkEv({ u: 'a', d: { lv: 0 } }))
  assert('lv=0 仍被守卫拒（不写入、不清除）', map.a.chLevel === 3, map.a.chLevel)
  apply(sb, map, mkEv({ u: 'a', d: { lv: 1.5 } }))
  assert('lv=1.5 仍被守卫拒', map.a.chLevel === 3)
  apply(sb, map, mkEv({ u: 'a', d: { lv: 5 } }))
  assert('lv=5 仍被守卫拒', map.a.chLevel === 3)
  apply(sb, map, mkEv({ u: 'a', d: {} }))
  assert('空 d 不影响', map.a.chLevel === 3)
  // d.clear 为假值（false / 0 / '' / undefined）→ 不触发清除
  const map2 = {}
  map2.b = mkUser(); map2.b.chLevel = 2
  apply(sb, map2, mkEv({ u: 'b', d: { clear: false } }))
  apply(sb, map2, mkEv({ u: 'b', d: { clear: 0 } }))
  apply(sb, map2, mkEv({ u: 'b', d: { clear: '' } }))
  assert('★ d.clear 假值不触发清除（false/0/\'\'）', map2.b.chLevel === 2, map2.b.chLevel)
  // d.clear 与 lv 同时存在时：clear 优先（break 在守卫前）—— 防呆：别发这种事件，但语义要确定
  const map3 = {}
  map3.c = mkUser(); map3.c.chLevel = 4
  apply(sb, map3, mkEv({ u: 'c', d: { clear: true, lv: 2 } }))
  assert('★ clear 与 lv 同发 → clear 优先（语义确定不模糊）', !('chLevel' in map3.c))
}

// ===================== 组三：真实迁移场景重放（15 人清除链） =====================
group('组三：迁移场景 —— 设 L4（迁移事件）→ 清除，重放终态必须干净')
{
  const sb = makeApplySandbox()
  const map = {}
  // 完整重放胡佳欣的事件链：迁移设 L4 → v175 清除
  apply(sb, map, mkEv({ u: '胡佳欣', n: '胡佳欣', ts: 1792055386382, d: { lv: 4, rd: '' } }))
  assert('重放迁移事件 → L4（模拟 v166 行为）', map['胡佳欣'].chLevel === 4)
  apply(sb, map, mkEv({ u: '胡佳欣', n: '胡佳欣', ts: 1792130000000, d: { clear: true } }))
  assert('★★ 重放清除事件 → chLevel 不存在（终态 = 未评定）', !('chLevel' in map['胡佳欣']))
  // ★ 从零全量重放（新设备首次拉取的场景）：同样干净
  const map4 = {}
  apply(sb, map4, mkEv({ u: '胡佳欣', n: '胡佳欣', ts: 1792055386382, d: { lv: 4, rd: '' } }))
  apply(sb, map4, mkEv({ u: '胡佳欣', n: '胡佳欣', ts: 1792130000000, d: { clear: true } }))
  assert('★★ 新设备从零全量重放 → 终态同样是「未评定」（清除必须可重放，这是不改 base 的前提）',
    !('chLevel' in map4['胡佳欣']))
  // 清除不影响该用户其他字段（不能把整条记录炸掉）
  assert('★ 清除只删 chLevel，不动其他字段（placementLevel 等）',
    map4['胡佳欣'] && map4['胡佳欣'].placementLevel === 0 && map4['胡佳欣'].role === 'student')
}

// ===================== 组四：边界 =====================
group('组四：边界与形态')
{
  const sb = makeApplySandbox()
  // map 里没有该用户 → 自建默认记录（默认无 chLevel）
  const map = {}
  apply(sb, map, mkEv({ u: 'newbie', d: { clear: true } }))
  assert('★ 对不存在的用户发清除 → 自建默认记录、无 chLevel、不崩',
    map.newbie && !('chLevel' in map.newbie))
  // 形态：清除分支必须在 lv 守卫之前
  const body = extractMethod(CS, '_apply(map, ev)')
  const iClear = body.indexOf("d.clear === true")
  const iGuard = body.indexOf('Number.isInteger(lv)')
  assert('★★ 清除分支在 lv 守卫**之前**（fail-closed 守卫后面 = 永远走不到）',
    iClear > 0 && iGuard > 0 && iClear < iGuard, 'clear@' + iClear + ' guard@' + iGuard)
  // 反证：v166 的 20 人迁移事件 id 后缀 _mig —— 新清除事件必须**不复用**该 id（id 唯一）
  assert('★ 源码不含迁移脚本残留（_clear 事件由外部脚本发，源码只提供语义）',
    !codeOnly(CS).includes('ev_mv9bi9se_mig'))
  // 版本号契约
  const vms = (HTML.match(/\?v=(\d+)/g) || []).map(s => Number(s.slice(3)))
  const uniq = Array.from(new Set(vms))
  assert('★ 版本号 12 处且唯一（' + (uniq[0] || '?') + '）', vms.length === 12 && uniq.length === 1,
    'n=' + vms.length + ' uniq=' + JSON.stringify(uniq))
  assert('★ 版本号 >= 175', uniq.length === 1 && uniq[0] >= 175, uniq[0])
}

// ===================== 汇总 =====================
console.log('\n' + '='.repeat(60))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fail) { console.log('失败项：'); fails.forEach(f => console.log('  ✗ ' + f)) }
else console.log('ALL PASS  ✅ 全部通过')
process.exit(fail ? 1 : 0)
