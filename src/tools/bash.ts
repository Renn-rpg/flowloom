import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from './types.js'
import { type ShellPolicy, allowAllShell } from './permissions.js'
import type { BackgroundShells } from './shell-manager.js'
const exec = promisify(execFile)
// 默认超时（毫秒），可用 FLOOM_SHELL_TIMEOUT_MS 覆盖；防止挂起命令（如启动服务器）永久阻塞 agent
const SHELL_TIMEOUT_MS = Number(process.env.FLOOM_SHELL_TIMEOUT_MS) || 120_000

// manager 存在时支持 background:true（长跑命令后台执行，bash_output 轮询 / kill_shell 终止）。
export function makeBashTool(shell: ShellPolicy = allowAllShell, manager?: BackgroundShells): Tool {
  return {
    spec: {
      name: 'run_shell',
      description:
        'Run a shell command, returns stdout+stderr (truncated 10k). Times out after 120s. ' +
        'Set background:true for long-running commands (dev server, watcher, build) — it returns immediately with a task id; read output with bash_output and stop it with kill_shell.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          background: {
            type: 'boolean',
            description: 'run in the background and return a task id instead of blocking until the command exits',
          },
        },
        required: ['command'],
      },
    },
    handler: async (i) => {
      const cmd = String(i.command)
      // 权限门禁：策略拒绝则不执行（非交互兜底 / 用户拒绝确认）
      if (!(await shell.authorize(cmd))) {
        return `ERROR: shell command not authorized by policy: ${cmd.slice(0, 200)}\n(re-run with --yolo to allow shell, or approve it interactively)`
      }
      // 后台执行：交给进程管理器，立刻返回句柄，不阻塞 agent。
      if (i.background) {
        if (!manager) return 'ERROR: background execution is not available in this context'
        const id = manager.start(cmd)
        return (
          `Started background shell ${id} for: ${cmd.slice(0, 120)}\n` +
          `Use bash_output({ id: "${id}" }) to read its output, kill_shell({ id: "${id}" }) to stop it.`
        )
      }
      const sh = process.platform === 'win32' ? 'pwsh' : 'bash'
      const args = process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd]
      try { const { stdout, stderr } = await exec(sh, args, { maxBuffer: 10 * 1024 * 1024, timeout: SHELL_TIMEOUT_MS, killSignal: 'SIGTERM' }); return (stdout + stderr).slice(0, 10_000) }
      catch (e: any) {
        const timedOut = e.killed && e.signal === 'SIGTERM'
        const prefix = timedOut ? `ERROR: command timed out after ${SHELL_TIMEOUT_MS}ms` : `ERROR: ${e.message}`
        const out = typeof e.stdout === 'string' ? e.stdout : (e.stdout ? String(e.stdout) : '')
        const err = typeof e.stderr === 'string' ? e.stderr : (e.stderr ? String(e.stderr) : '')
        return `${prefix}\n${out}${err}`.slice(0, 10_000)
      }
    },
  }
}
