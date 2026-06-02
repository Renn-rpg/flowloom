// Git 工具集：让 agent 自主进行 git 操作。
// 安全性：默认不执行 force push / hard reset（需显式 allowDangerous: true）。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from './types.js'
import type { ShellPolicy } from './permissions.js'

const exec = promisify(execFile)
const MAX_OUT = 10_000
const GIT_TIMEOUT = 30_000

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await exec('git', args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 2 * 1024 * 1024 })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

function fmtOut(stdout: string, stderr: string): string {
  const out = (stdout + (stderr ? '\n' + stderr : '')).trim()
  return out.slice(0, MAX_OUT) || '(no output)'
}

export function makeGitDiffTool(): Tool {
  return {
    spec: {
      name: 'git_diff',
      description: 'Show git diff: unstaged changes (default), staged (--staged), or between commits. Wraps "git diff".',
      inputSchema: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'show staged changes (git diff --staged)' },
          path: { type: 'string', description: 'limit diff to this file or directory' },
        },
      },
    },
    handler: async (i) => {
      const args = ['diff']
      if (i.staged) args.push('--staged')
      if (i.path) args.push(String(i.path))
      try {
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git diff failed: ${e.message}`
      }
    },
  }
}

export function makeGitLogTool(): Tool {
  return {
    spec: {
      name: 'git_log',
      description: 'Show git commit history. Wraps "git log --oneline".',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'number of commits (default 10)' },
          path: { type: 'string', description: 'limit to commits touching this file' },
        },
      },
    },
    handler: async (i) => {
      const args = ['log', '--oneline', `-n${i.n ?? 10}`]
      if (i.path) args.push('--', String(i.path))
      try {
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git log failed: ${e.message}`
      }
    },
  }
}

export function makeGitBranchTool(): Tool {
  return {
    spec: {
      name: 'git_branch',
      description: 'List or create git branches. Wraps "git branch".',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'create a new branch with this name (omit to list branches)' },
        },
      },
    },
    handler: async (i) => {
      try {
        if (i.name) {
          const { stdout, stderr } = await runGit(['branch', String(i.name)], process.cwd())
          return fmtOut(`Created branch ${i.name}\n${stdout}`, stderr)
        }
        const { stdout, stderr } = await runGit(['branch'], process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git branch failed: ${e.message}`
      }
    },
  }
}

export function makeGitCommitTool(shell: ShellPolicy): Tool {
  return {
    spec: {
      name: 'git_commit',
      description: 'Stage files and create a git commit. Requires confirmation for safety.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'commit message' },
          files: { type: 'array', items: { type: 'string' }, description: 'files to stage (default: all modified)' },
        },
        required: ['message'],
      },
    },
    handler: async (i) => {
      const msg = String(i.message ?? '').trim()
      if (!msg) return 'ERROR: commit message is required'

      // 安全确认
      if (!(await shell.authorize(`git commit -m "${msg.slice(0, 80)}"`))) {
        return 'DENIED: git commit not authorized by policy'
      }

      try {
        const files = Array.isArray(i.files) && i.files.length > 0
          ? i.files.map(String)
          : ['.']
        await runGit(['add', ...files], process.cwd())
        const { stdout, stderr } = await runGit(['commit', '-m', msg], process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git commit failed: ${e.message}`
      }
    },
  }
}
