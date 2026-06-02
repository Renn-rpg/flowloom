import chalk from 'chalk'

export type DiffTag = 'eq' | 'del' | 'add'
export interface DiffOp {
  tag: DiffTag
  line: string
}

// 在已裁掉公共前后缀的中间段上跑 LCS，复杂度被改动区域大小限制（局部编辑极快）。
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS(a[i:], b[j:]) 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: 'eq', line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ tag: 'del', line: a[i] })
      i++
    } else {
      ops.push({ tag: 'add', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ tag: 'del', line: a[i++] })
  while (j < m) ops.push({ tag: 'add', line: b[j++] })
  return ops
}

// 行级 diff：先裁公共前后缀（O(n)），只对中间差异段跑 LCS；中间段过大则退化为全删全增。
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let sa = a.length
  let sb = b.length
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) {
    sa--
    sb--
  }
  const midA = a.slice(p, sa)
  const midB = b.slice(p, sb)
  let midOps: DiffOp[]
  if (midA.length * midB.length > 1_000_000) {
    midOps = [
      ...midA.map((line) => ({ tag: 'del' as const, line })),
      ...midB.map((line) => ({ tag: 'add' as const, line })),
    ]
  } else {
    midOps = lcsDiff(midA, midB)
  }
  const ops: DiffOp[] = [
    ...a.slice(0, p).map((line) => ({ tag: 'eq' as const, line })),
    ...midOps,
    ...a.slice(sa).map((line) => ({ tag: 'eq' as const, line })),
  ]
  // 丢掉 split('\n') 在末尾换行处产生的空 eq 行，避免渲染一行空编号
  if (ops.length > 0 && ops[ops.length - 1].tag === 'eq' && ops[ops.length - 1].line === '') {
    ops.pop()
  }
  return ops
}

const CONTEXT = 3
const MAX_LINES = 80

// 把 diff 渲染成彩色块：仅显示改动行 + 周围 CONTEXT 行，大段未改动折叠为 "…"。
// 无改动返回 ''（调用方据此跳过）。
export function renderDiff(before: string, after: string, path: string): string {
  if (before === after) return ''
  const ops = diffLines(before, after)
  let adds = 0
  let dels = 0
  for (const o of ops) {
    if (o.tag === 'add') adds++
    else if (o.tag === 'del') dels++
  }
  if (adds === 0 && dels === 0) return ''

  // 标记要保留的行：改动行及其前后 CONTEXT 行
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].tag !== 'eq') {
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) {
        keep[j] = true
      }
    }
  }

  const out: string[] = [`  ${chalk.bold(path)}  ${chalk.green('+' + adds)} ${chalk.red('-' + dels)}`]
  let oldNo = 0
  let newNo = 0
  let gap = false
  let emitted = 0
  let truncated = false
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.tag === 'eq') {
      oldNo++
      newNo++
    } else if (op.tag === 'del') {
      oldNo++
    } else {
      newNo++
    }
    if (!keep[i]) {
      gap = true
      continue
    }
    if (gap) {
      out.push(chalk.dim('   …'))
      gap = false
    }
    if (emitted >= MAX_LINES) {
      truncated = true
      break
    }
    if (op.tag === 'eq') out.push(chalk.dim(`  ${String(newNo).padStart(4)}   ${op.line}`))
    else if (op.tag === 'del') out.push(chalk.red(`  ${String(oldNo).padStart(4)} - ${op.line}`))
    else out.push(chalk.green(`  ${String(newNo).padStart(4)} + ${op.line}`))
    emitted++
  }
  if (truncated) out.push(chalk.dim('   … (diff truncated)'))
  return out.join('\n')
}
