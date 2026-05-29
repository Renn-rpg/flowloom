import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from './types.js'
const exec = promisify(execFile)
export const bashTool: Tool = {
  spec: { name: 'run_shell', description: 'Run a shell command, returns stdout+stderr (truncated 10k)', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  handler: async (i) => {
    const cmd = String(i.command)
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd]
    try { const { stdout, stderr } = await exec(shell, args, { maxBuffer: 10 * 1024 * 1024 }); return (stdout + stderr).slice(0, 10_000) }
    catch (e: any) { return `ERROR: ${e.message}\n${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 10_000) }
  },
}
