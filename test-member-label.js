// 成员显示中文名+部门 —— 功能测试（mock 环境跑断言）
const fs = require('fs')
const vm = require('vm')

const sandbox = {
  console, Date, Math, JSON, Set, Map, Promise, Array, Object, String, Number, RegExp, Error,
  setTimeout, clearTimeout, alert: () => {}, confirm: () => true,
  LANG: 'zh',
  // app.js 中的全局工具（测试环境 mock）
  escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  escAttr: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  t: k => k,
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null }, setItem(k, v) { this._s[k] = String(v) }, removeItem(k) { delete this._s[k] } },
  document: { getElementById: () => null },
  // mock Store：本机账号表
  Store: {
    isAdmin: () => true,
    getSession: () => ({ id: 1, username: 'admin', name: '管理员' }),
    getUsers: () => [
      { id: 1, username: 'admin', name: '管理员', dept: '', role: 'admin' },
      { id: 2, username: 'zhangsan', name: '张三', dept: '房务部·前厅', role: 'student' }
    ]
  },
  // mock CloudSync：云端看板数据（含其他设备注册的用户）
  CloudSync: {
    getDashboardData: async () => ([
      { username: 'admin', name: '管理员', dept: '', role: 'admin' },
      { username: 'zhangsan', name: '张三', dept: '房务部·前厅', role: 'student' },
      { username: 'lisi', name: '李四', dept: '餐饮部·宴会', role: 'student' },
      { username: 'nosuchname', name: '', dept: '', role: 'student' }
    ])
  }
}
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync('course-app.js', 'utf8'), sandbox)

let pass = 0, fail = 0
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + '\n    期望: ' + expected + '\n    实际: ' + actual) }
}
function includes(name, html, sub) {
  if (html.includes(sub)) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + '（未包含 ' + sub + '）\n    实际: ' + html) }
}

;(async () => {
  console.log('== courseUserInfoMap ==')
  const map = await vm.runInContext('courseUserInfoMap()', sandbox)
  eq('云端用户李四入表', map['lisi'] && map['lisi'].name, '李四')
  eq('本机用户张三入表', map['zhangsan'] && map['zhangsan'].name, '张三')
  eq('张三部门', map['zhangsan'] && map['zhangsan'].dept, '房务部·前厅')
  eq('空姓名用户', map['nosuchname'] && map['nosuchname'].name, '')

  console.log('== courseMemberCell ==')
  const cell1 = vm.runInContext('courseMemberCell("zhangsan", courseUserInfoMap.__map || null)', sandbox)
  // 直接用刚得到的 map 再调一次（同步场景）
  const cell = vm.runInContext('courseMemberCell("zhangsan", ' + JSON.stringify(map) + ')', sandbox)
  includes('张三：显示中文名加粗', cell, '<strong>张三</strong>')
  includes('张三：显示用户名小字', cell, 'zhangsan')
  includes('张三：显示部门', cell, '房务部·前厅')
  const cell2 = vm.runInContext('courseMemberCell("lisi", ' + JSON.stringify(map) + ')', sandbox)
  includes('李四：显示中文名', cell2, '<strong>李四</strong>')
  includes('李四：显示部门', cell2, '餐饮部·宴会')
  // 无资料用户回退用户名
  const cell3 = vm.runInContext('courseMemberCell("stranger", {})', sandbox)
  eq('无资料用户回退用户名', cell3, '<strong>stranger</strong>')
  // 有名无部门
  const cell4 = vm.runInContext('courseMemberCell("nosuchname", ' + JSON.stringify(map) + ')', sandbox)
  eq('无名无部门回退用户名', cell4, '<strong>nosuchname</strong>')

  console.log('== 缓存 60s ==')
  const t1 = vm.runInContext('courseUserInfoMap()', sandbox)
  eq('第二次调用返回缓存（同一引用）', await t1 === map, true)

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
