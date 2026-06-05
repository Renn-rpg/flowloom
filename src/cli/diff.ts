import chalk from 'chalk'

type DiffTag = 'eq' | 'del' | 'add'
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
const MAX_LINES = process.stderr.columns ? Math.max(20, Math.floor(process.stderr.columns / 2)) : 80

// —— Word-level diff：对修改行对做词级高亮 ——
function wordDiff(delLine: string, addLine: string): { del: string; add: string } {
  // 分词（保留空白分隔）
  const delWords = delLine.split(/(\s+)/)
  const addWords = addLine.split(/(\s+)/)

  // LCS at word level
  const n = delWords.length, m = addWords.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = delWords[i] === addWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])

  // 回溯标记每个 word 的归属
  const delOut: string[] = [], addOut: string[] = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && delWords[i] === addWords[j]) {
      delOut.push(delWords[i]); addOut.push(addWords[j]); i++; j++
    } else if (j < m && (i >= n || dp[i + 1][j] < dp[i][j + 1])) {
      addOut.push(chalk.bgGreen.black(addWords[j])); j++
    } else if (i < n) {
      delOut.push(chalk.bgRed.black(delWords[i])); i++
    } else {
      addOut.push(chalk.bgGreen.black(addWords[j])); j++
    }
  }
  return { del: delOut.join(''), add: addOut.join('') }
}

// 把 diff 渲染成标准 unified diff 格式。
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

  // 标准 unified diff 头部
  const out: string[] = [
    chalk.bold(`--- a/${path}`),
    chalk.bold(`+++ b/${path}`),
  ]

  // 将 ops 按连续改动分组为 hunks，每组带 3 行上下文。O(n) 单遍扫描
  const hunks: { start: number; end: number }[] = []
  let inHunk = false, eqRun = 0
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].tag !== 'eq') {
      if (!inHunk) {
        hunks.push({ start: Math.max(0, i - CONTEXT), end: 0 })
        inHunk = true
      }
      eqRun = 0
    } else if (inHunk) {
      eqRun++
      if (eqRun > CONTEXT * 2) {
        hunks[hunks.length - 1].end = Math.min(ops.length - 1, i - CONTEXT)
        inHunk = false
      }
    }
  }
  if (inHunk) hunks[hunks.length - 1].end = ops.length - 1

  let emitted = 0, done = false

  for (const hunk of hunks) {
    if (done) break
    // 计算 hunk 的行号范围
    let oldStart = 0, newStart = 0, oldCount = 0, newCount = 0
    for (let i = 0; i <= hunk.end; i++) {
      if (i < hunk.start) {
        if (ops[i].tag === 'del' || ops[i].tag === 'eq') oldStart++
        if (ops[i].tag === 'add' || ops[i].tag === 'eq') newStart++
      } else {
        if (ops[i].tag === 'del' || ops[i].tag === 'eq') oldCount++
        if (ops[i].tag === 'add' || ops[i].tag === 'eq') newCount++
      }
    }
    out.push(chalk.cyan(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`))

    for (let i = hunk.start; i <= hunk.end; i++) {
      if (emitted >= MAX_LINES) { out.push(chalk.dim('   … (diff truncated)')); done = true; break }
      const op = ops[i]
      if (op.tag === 'eq') {
        out.push(chalk.dim(` ${op.line}`))
        emitted++
      } else if (op.tag === 'del') {
        // 检查下一个是否为 add → word-level diff
        if (i + 1 < ops.length && ops[i + 1].tag === 'add') {
          const wd = wordDiff(op.line, ops[i + 1].line)
          out.push(chalk.red(`-${wd.del}`))
          out.push(chalk.green(`+${wd.add}`))
          i++ // 跳过已处理的 add 行
          emitted += 2
        } else {
          out.push(chalk.red(`-${op.line}`))
          emitted++
        }
      } else {
        out.push(chalk.green(`+${op.line}`))
        emitted++
      }
    }
  }

  return out.join('\n')
}
