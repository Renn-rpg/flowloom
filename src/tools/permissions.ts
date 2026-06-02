import { resolve, isAbsolute, relative, sep } from 'node:path'

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
export function confineToRoot(root: string): PathPolicy {
  const absRoot = resolve(root)
  return {
    check(p: string): string {
      const abs = isAbsolute(p) ? resolve(p) : resolve(absRoot, p)
      const rel = relative(absRoot, abs)
      const escapes = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
      if (escapes) {
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

// 逐条交互确认：把放行决定委托给注入的 confirm 回调（交互式终端用）
export function confirmShell(
  confirm: (command: string) => boolean | Promise<boolean>,
): ShellPolicy {
  return { authorize: (cmd) => confirm(cmd) }
}
