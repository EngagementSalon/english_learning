// 测试定级逻辑（逐级递进 + 60% 阈值）
// 模拟 finishPlacement 中的核心定级算法
let pass = 0, fail = 0
function ok(name, cond) { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }

const THRESHOLD = 0.6

function calcLevel(perLevel) {
  // 复制 finishPlacement 的新逻辑
  let level = 1
  for (let l = 1; l <= 4; l++) {
    const s = perLevel[l]
    const acc = s && s.total > 0 ? s.correct / s.total : 0
    if (acc >= THRESHOLD) {
      level = l
    } else {
      break
    }
  }
  return level
}

// === 场景1：低分高级（旧 bug 场景）===
// L1: 1/6=17%, L2: 1/6=17%, L3: 3/6=50%, L4: 3/6=50%
// 旧逻辑 → L4（错误！）；新逻辑 → L1（L1 未达标，直接停）
const s1 = {
  1: { correct: 1, total: 6 },
  2: { correct: 1, total: 6 },
  3: { correct: 3, total: 6 },
  4: { correct: 3, total: 6 },
}
ok('场景1 低分高级 → L1（不再跳级）', calcLevel(s1) === 1)

// === 场景2：只有 L4 达标，低级全挂 ===
// 旧逻辑 → L4；新逻辑 → L1
const s2 = {
  1: { correct: 2, total: 6 },
  2: { correct: 2, total: 6 },
  3: { correct: 2, total: 6 },
  4: { correct: 4, total: 6 },
}
ok('场景2 只高级达标 → L1', calcLevel(s2) === 1)

// === 场景3：L1/L2 达标，L3 差一点，L4 达标 ===
// 旧逻辑 → L4（跳过 L3）；新逻辑 → L2（L3 卡住，L4 不算）
const s3 = {
  1: { correct: 5, total: 6 },
  2: { correct: 4, total: 6 },
  3: { correct: 3, total: 6 },  // 50% < 60%
  4: { correct: 5, total: 6 },  // 83% 但不算
}
ok('场景3 L3 卡住 → L2（L4 不算）', calcLevel(s3) === 2)

// === 场景4：逐级递进正常 ===
// L1: 5/6=83%, L2: 4/6=67%, L3: 4/6=67%, L4: 3/6=50%
// 新逻辑 → L3（L4 50% < 60% 不达标）
const s4 = {
  1: { correct: 5, total: 6 },
  2: { correct: 4, total: 6 },
  3: { correct: 4, total: 6 },
  4: { correct: 3, total: 6 },
}
ok('场景4 逐级到 L3', calcLevel(s4) === 3)

// === 场景5：全部达标 ===
const s5 = {
  1: { correct: 6, total: 6 },
  2: { correct: 5, total: 6 },
  3: { correct: 4, total: 6 },
  4: { correct: 4, total: 6 },
}
ok('场景5 全部达标 → L4', calcLevel(s5) === 4)

// === 场景6：全部不达标 ===
const s6 = {
  1: { correct: 2, total: 6 },
  2: { correct: 1, total: 6 },
  3: { correct: 1, total: 6 },
  4: { correct: 0, total: 6 },
}
ok('场景6 全部不达标 → L1', calcLevel(s6) === 1)

// === 场景7：恰好 60% 边界 ===
// L1: 4/6=67%≥60% ✓, L2: 3/6=50%<60% ✗
const s7 = {
  1: { correct: 4, total: 6 },  // 67%
  2: { correct: 3, total: 6 },  // 50% < 60%
  3: { correct: 4, total: 6 },
  4: { correct: 4, total: 6 },
}
ok('场景7 L2 恰好 50% 不达标 → L1', calcLevel(s7) === 1)

// === 场景8：L1 恰好 60%（3.6/6 不可能，用 5 题 3/5=60%）===
const s8 = {
  1: { correct: 3, total: 5 },  // 60% 恰好达标
  2: { correct: 2, total: 6 },  // 33%
  3: { correct: 0, total: 6 },
  4: { correct: 0, total: 6 },
}
ok('场景8 L1 恰好 60% → L1', calcLevel(s8) === 1)

// === 场景9：旧 bug 的极端情况 — 全靠猜 ===
// 4 选 1 蒙对概率 25%，6 题蒙对 1-2 题。但假设运气爆棚 L4 蒙对 4 题(67%)
const s9 = {
  1: { correct: 0, total: 6 },
  2: { correct: 0, total: 6 },
  3: { correct: 0, total: 6 },
  4: { correct: 4, total: 6 },  // 67% ≥ 60%，但 L1 没过
}
ok('场景9 纯猜高级通过 → L1', calcLevel(s9) === 1)

console.log('\n结果: ' + pass + ' 通过 ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
