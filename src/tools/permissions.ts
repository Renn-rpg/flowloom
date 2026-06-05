import { resolve, isAbsolute, relative, sep, dirname, basename } from 'node:path'
import { realpathSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// ── 路径策略 ──────────────────────────────────────────────────────────────
// 决定文件类工具（read/write/edit）能访问哪些路径。校验通过返回归一化后的
// 绝对路径，越界则 throw（registry.run 会把异常转成 "ERROR:" 字符串回给模型）。
export interface PathPolicy {
  check(path: string): string
}

// 不限制（向后兼容默认值：保持裸路径行为，原样返回）
export const allowAllPaths: PathPolicy = {
  check: (p) => p,
}

// 把文件操作限定在 root（含其子目录）内。
// 用 resolve + relative 做归一化边界校验，比黑名单稳健：
//   - 归一化后逃逸的相对路径（../x、a/../../b）被挡住
//   - 绝对路径若落在 root 外被挡住；落在 root 内则放行
//   - Windows 跨盘符（relative 返回绝对路径）也被 isAbsolute(rel) 兜住
//   - Windows 盘符大小写不敏感：统一 lowercase 后再比较
// 解析路径中「最近的已存在祖先」的真实路径（跟随软链/Windows junction），再拼回尚不存在的尾部。
// 仅用 resolve 不会跟随软链——这是为了识破「项目内软链指向项目外」的逃逸（如 root/link -> /etc）。
function realpathOfExistingPrefix(abs: string): string {
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail.length ? resolve(real, ...tail) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs // 一路到根都解析不了（异常环境）→ 退回逻辑路径
      tail.unshift(basename(cur))
      cur = parent
    }
  }
}

export function confineToRoot(root: string): PathPolicy {
  const absRoot = resolve(root)
  // 真实根：root 通常存在（= cwd）；解析失败（如单测里的虚构 root）则退回字符串路径，保持原行为。
  let realRoot: string
  try { realRoot = realpathSync.native(absRoot) } catch { realRoot = absRoot }
  return {
    check(p: string): string {
      const abs = isAbsolute(p) ? resolve(p) : resolve(absRoot, p)
      const rel = relative(absRoot, abs)
      // 归一化逃逸检测：relative 返回 .. 或以 ..\ 开头 = 逃逸；返回绝对路径 = 跨盘符（Windows）
      const escapes = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
      // Windows 额外：盘符大小写不敏感——若 lowercased 路径相同但 startsWith 失败说明大小写欺骗
      const win32Spoof = process.platform === 'win32' && abs.toLowerCase() === absRoot.toLowerCase() && !abs.startsWith(absRoot)
      // 软链逃逸：对「最近已存在祖先」取真实路径再判一次，挡住项目内软链/junction 指向项目外的情形。
      const real = realpathOfExistingPrefix(abs)
      const realRel = relative(realRoot, real)
      const realEscapes = realRel === '..' || realRel.startsWith('..' + sep) || isAbsolute(realRel)
      if (escapes || win32Spoof || realEscapes) {
        throw new Error(
          `Path "${p}" is outside the project root (${absRoot}); ` +
            `only files within the project are allowed (re-run with --yolo to bypass).`,
        )
      }
      return abs
    },
  }
}

// ── 敏感文件防护 ──────────────────────────────────────────────────────────
// 默认拒绝「读取/编辑」会泄漏凭据的文件：读到的内容会进入模型上下文 → 可能被
// 发往 API、写进 transcript/日志。这是高置信度的小型黑名单，刻意保守以免误伤。
// .env.example / .env.sample / .env.template 等模板是可读的（不匹配）。
export const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  // .env / .env.local / .env.production …（但放行 .example/.sample/.template/.dist）
  /(^|[\\/])\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i,
  /\.pem$/i, // 私钥/证书
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i, // SSH 私钥
  /(^|[\\/])\.npmrc$/i, // 可能含 _authToken
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.aws[\\/]credentials$/i,
  /(^|[\\/])credentials\.json$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|toml|env)$/i,
]

export function isSensitivePath(
  absPath: string,
  patterns: RegExp[] = DEFAULT_SECRET_PATTERNS,
): boolean {
  return patterns.some((re) => re.test(absPath))
}

// 装饰器：先过内层策略（确认/归一化），再拦截敏感文件。用于 read/edit（暴露内容的工具）。
export function denySecrets(
  inner: PathPolicy,
  patterns: RegExp[] = DEFAULT_SECRET_PATTERNS,
): PathPolicy {
  return {
    check(p: string): string {
      const abs = inner.check(p)
      if (isSensitivePath(abs, patterns)) {
        throw new Error(
          `Refusing to access "${p}": looks like a secret/credential file ` +
            `(re-run with --yolo to override).`,
        )
      }
      return abs
    },
  }
}

// ── Shell 策略 ────────────────────────────────────────────────────────────
// 决定 run_shell 是否放行一条命令。authorize 返回 false 时 run_shell 不执行，
// 直接回 "ERROR: ..."，避免模型在无人监督下运行任意命令。
export interface ShellPolicy {
  authorize(command: string): boolean | Promise<boolean>
}

// 全部放行（--yolo / 向后兼容默认值）
export const allowAllShell: ShellPolicy = {
  authorize: () => true,
}

// 全部拒绝（非交互管道/CI 下无法逐条确认时的安全兜底）
export const denyAllShell: ShellPolicy = {
  authorize: () => false,
}

// ── 权限审计日志 ────────────────────────────────────────────────────────────
// 记录每次 deny/ask 决策到 .floom/permissions.log（JSONL 格式）。
// 日志轮转：保留最近 1000 行。

// dirname/resolve 已在文件顶部从 'node:path' 导入

const MAX_LOG_LINES = 1000

function logPath(): string {
  return resolve(process.cwd(), '.floom', 'permissions.log')
}

export function auditLog(entry: {
  decision: 'allow' | 'deny' | 'ask'
  tool: string
  input: string  // 摘要（最多 200 字符）
  userChoice?: string
}): void {
  try {
    const path = logPath()
    mkdirSync(dirname(path), { recursive: true })
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n'

    // 追加
    appendFileSync(path, line, 'utf8')

    // 轮转：超过上限时裁剪
    try {
      const content = readFileSync(path, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      if (lines.length > MAX_LOG_LINES) {
        writeFileSync(path, lines.slice(-MAX_LOG_LINES).join('\n') + '\n', 'utf8')
      }
    } catch { /* 轮转失败不影响主流程 */ }
  } catch { /* 审计日志写入失败不影响主流程 */ }
}
