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
        try {
          await runGit(['add', ...files], process.cwd())
        } catch (e: any) {
          return `ERROR: git add failed: ${e.message}`
        }
        const { stdout, stderr } = await runGit(['commit', '-m', msg], process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git commit failed: ${e.message}`
      }
    },
  }
}

export function makeGitStatusTool(): Tool {
  return {
    spec: {
      name: 'git_status',
      description: 'Show the working tree status. Wraps "git status --short".',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => {
      try {
        const { stdout, stderr } = await runGit(['status', '--short', '--branch'], process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git status failed: ${e.message}`
      }
    },
  }
}

export function makeGitStashTool(): Tool {
  return {
    spec: {
      name: 'git_stash',
      description: 'Stash changes (push), list stashes, or pop the latest stash. Wraps "git stash".',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"push" (default), "list", or "pop"' },
          message: { type: 'string', description: 'stash message (push only)' },
        },
      },
    },
    handler: async (i) => {
      const action = String(i.action ?? 'push')
      const args = ['stash']
      try {
        if (action === 'list') {
          const { stdout, stderr } = await runGit([...args, 'list'], process.cwd())
          return fmtOut(stdout, stderr) || '(no stashes)'
        }
        if (action === 'pop') {
          const { stdout, stderr } = await runGit([...args, 'pop'], process.cwd())
          return fmtOut(stdout, stderr)
        }
        // push
        if (i.message) args.push('push', '-m', String(i.message))
        else args.push('push')
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr) || 'stashed'
      } catch (e: any) {
        return `ERROR: git stash failed: ${e.message}`
      }
    },
  }
}

export function makeGitWorktreeTool(): Tool {
  return {
    spec: {
      name: 'git_worktree',
      description: 'List, add, or remove git worktrees. Wraps "git worktree".',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list" (default), "add", or "remove"' },
          path: { type: 'string', description: 'path for worktree (add) or worktree to remove' },
          branch: { type: 'string', description: 'branch name (add only)' },
        },
      },
    },
    handler: async (i) => {
      const action = String(i.action ?? 'list')
      try {
        if (action === 'list') {
          const { stdout, stderr } = await runGit(['worktree', 'list'], process.cwd())
          return fmtOut(stdout, stderr)
        }
        if (action === 'add' && i.path) {
          const args = ['worktree', 'add', String(i.path)]
          if (i.branch) args.push('-b', String(i.branch))
          const { stdout, stderr } = await runGit(args, process.cwd())
          return fmtOut(stdout, stderr) || `worktree added at ${i.path}`
        }
        if (action === 'remove' && i.path) {
          const { stdout, stderr } = await runGit(['worktree', 'remove', String(i.path)], process.cwd())
          return fmtOut(stdout, stderr) || `worktree removed: ${i.path}`
        }
        return `ERROR: git worktree ${action} requires a path`
      } catch (e: any) {
        return `ERROR: git worktree failed: ${e.message}`
      }
    },
  }
}

export function makeGitFetchTool(): Tool {
  return {
    spec: {
      name: 'git_fetch',
      description: 'Fetch from a remote repository. Wraps "git fetch".',
      inputSchema: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'remote name (default: origin)' },
        },
      },
    },
    handler: async (i) => {
      const remote = String(i.remote ?? 'origin')
      try {
        const { stdout, stderr } = await runGit(['fetch', remote], process.cwd())
        const out = fmtOut(stdout, stderr)
        return out === '(no output)' ? `fetched from ${remote} (up to date)` : out
      } catch (e: any) {
        return `ERROR: git fetch failed: ${e.message}`
      }
    },
  }
}

// ── 需要安全确认的 Git 工具（push/pull/reset/rebase）──

export function makeGitPushTool(shell: ShellPolicy): Tool {
  return {
    spec: {
      name: 'git_push',
      description: 'Push commits to a remote. Requires confirmation. Wraps "git push".',
      inputSchema: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'remote name (default: origin)' },
          branch: { type: 'string', description: 'branch to push (default: current branch)' },
          force: { type: 'boolean', description: 'force push (requires extra confirmation)' },
        },
      },
    },
    handler: async (i) => {
      const remote = String(i.remote ?? 'origin')
      const branch = i.branch ? String(i.branch) : ''
      const force = Boolean(i.force)
      if (!(await shell.authorize(`git push${force ? ' --force' : ''} ${remote} ${branch}`.trim()))) {
        return 'DENIED: git push not authorized by policy'
      }
      try {
        const args = ['push', remote]
        if (force) args.push('--force')
        if (branch) args.push(branch)
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr) || `pushed to ${remote}`
      } catch (e: any) {
        return `ERROR: git push failed: ${e.message}`
      }
    },
  }
}

export function makeGitPullTool(shell: ShellPolicy): Tool {
  return {
    spec: {
      name: 'git_pull',
      description: 'Pull from a remote. Requires confirmation. Wraps "git pull".',
      inputSchema: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'remote name (default: origin)' },
          branch: { type: 'string', description: 'branch to pull (default: current tracking branch)' },
          rebase: { type: 'boolean', description: 'use --rebase instead of merge' },
        },
      },
    },
    handler: async (i) => {
      const remote = String(i.remote ?? 'origin')
      if (!(await shell.authorize(`git pull ${remote}`))) {
        return 'DENIED: git pull not authorized by policy'
      }
      try {
        const args = ['pull', remote]
        if (i.rebase) args.push('--rebase')
        if (i.branch) args.push(String(i.branch))
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr) || `pulled from ${remote}`
      } catch (e: any) {
        return `ERROR: git pull failed: ${e.message}`
      }
    },
  }
}

export function makeGitMergeTool(): Tool {
  return {
    spec: {
      name: 'git_merge',
      description: 'Merge a branch into the current branch. Wraps "git merge".',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'branch to merge into current branch' },
        },
        required: ['branch'],
      },
    },
    handler: async (i) => {
      const branch = String(i.branch)
      try {
        const { stdout, stderr } = await runGit(['merge', branch], process.cwd())
        return fmtOut(stdout, stderr) || `merged ${branch}`
      } catch (e: any) {
        return `ERROR: git merge failed: ${e.message}`
      }
    },
  }
}

export function makeGitRebaseTool(shell: ShellPolicy): Tool {
  return {
    spec: {
      name: 'git_rebase',
      description: 'Rebase current branch onto another. Requires confirmation. Wraps "git rebase".',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'branch to rebase onto' },
          interactive: { type: 'boolean', description: 'interactive rebase (not supported — blocked)' },
        },
        required: ['branch'],
      },
    },
    handler: async (i) => {
      if (i.interactive) return 'ERROR: interactive rebase is not supported via this tool'
      const branch = String(i.branch)
      if (!(await shell.authorize(`git rebase ${branch}`))) {
        return 'DENIED: git rebase not authorized by policy'
      }
      try {
        const { stdout, stderr } = await runGit(['rebase', branch], process.cwd())
        return fmtOut(stdout, stderr) || `rebased onto ${branch}`
      } catch (e: any) {
        return `ERROR: git rebase failed: ${e.message}`
      }
    },
  }
}

export function makeGitResetTool(shell: ShellPolicy): Tool {
  return {
    spec: {
      name: 'git_reset',
      description: 'Reset HEAD to a specified state. Wraps "git reset". Hard reset requires extra confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          commit: { type: 'string', description: 'commit-ish to reset to (default: HEAD)' },
          mode: { type: 'string', description: '"soft", "mixed" (default), or "hard"' },
          path: { type: 'string', description: 'limit to this file/directory (cannot combine with --hard)' },
        },
      },
    },
    handler: async (i) => {
      const mode = String(i.mode ?? 'mixed')
      const commit = i.commit ? String(i.commit) : 'HEAD'
      if (mode === 'hard' && i.path) return 'ERROR: --hard mode cannot be combined with a path'
      if (mode === 'hard' && !(await shell.authorize(`git reset --hard ${commit}`))) {
        return 'DENIED: git reset --hard not authorized by policy'
      }
      try {
        const args = ['reset']
        if (mode !== 'mixed') args.push(`--${mode}`)
        if (i.path) args.push('--', String(i.path))
        else args.push(commit)
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr) || `reset ${mode} to ${commit}`
      } catch (e: any) {
        return `ERROR: git reset failed: ${e.message}`
      }
    },
  }
}

export function makeGitRevertTool(): Tool {
  return {
    spec: {
      name: 'git_revert',
      description: 'Revert a commit by creating a new inverse commit. Wraps "git revert".',
      inputSchema: {
        type: 'object',
        properties: {
          commit: { type: 'string', description: 'commit to revert' },
          noCommit: { type: 'boolean', description: 'do not auto-commit (--no-commit)' },
        },
        required: ['commit'],
      },
    },
    handler: async (i) => {
      const args = ['revert', String(i.commit)]
      if (i.noCommit) args.push('--no-commit')
      try {
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr) || `reverted ${i.commit}`
      } catch (e: any) {
        return `ERROR: git revert failed: ${e.message}`
      }
    },
  }
}

export function makeGitBlameTool(): Tool {
  return {
    spec: {
      name: 'git_blame',
      description: 'Show line-by-line authorship for a file. Wraps "git blame".',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file to blame' },
          startLine: { type: 'number', description: 'start line (1-indexed)' },
          endLine: { type: 'number', description: 'end line (1-indexed)' },
        },
        required: ['path'],
      },
    },
    handler: async (i) => {
      const args = ['blame']
      if (i.startLine && i.endLine) args.push('-L', `${i.startLine},${i.endLine}`)
      args.push(String(i.path))
      try {
        const { stdout, stderr } = await runGit(args, process.cwd())
        return fmtOut(stdout, stderr)
      } catch (e: any) {
        return `ERROR: git blame failed: ${e.message}`
      }
    },
  }
}

export function makeGitTagTool(): Tool {
  return {
    spec: {
      name: 'git_tag',
      description: 'List or create git tags. Wraps "git tag".',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'tag name to create (omit to list all tags)' },
          message: { type: 'string', description: 'annotated tag message (-m)' },
        },
      },
    },
    handler: async (i) => {
      try {
        if (i.name) {
          const args = ['tag', String(i.name)]
          if (i.message) args.push('-m', String(i.message))
          const { stdout, stderr } = await runGit(args, process.cwd())
          return fmtOut(`Created tag ${i.name}\n${stdout}`, stderr)
        }
        const { stdout, stderr } = await runGit(['tag', '-l'], process.cwd())
        return fmtOut(stdout, stderr) || '(no tags)'
      } catch (e: any) {
        return `ERROR: git tag failed: ${e.message}`
      }
    },
  }
}
