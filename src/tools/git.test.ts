import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeGitDiffTool, makeGitLogTool, makeGitBranchTool, makeGitCommitTool, makeGitStatusTool, makeGitStashTool, makeGitWorktreeTool, makeGitFetchTool, makeGitPushTool, makeGitPullTool, makeGitMergeTool, makeGitRevertTool, makeGitBlameTool, makeGitTagTool } from './git.js'
import type { ShellPolicy } from './permissions.js'

// Mock node:child_process — 回调式 execFile → promisify 兼容
const mockExecFile = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => {
    const cb = args[args.length - 1]
    const rest = args.slice(0, -1)
    const result = mockExecFile(...rest)
    if (result instanceof Error) cb(result)
    else cb(null, result ?? { stdout: '', stderr: '' })
  },
}))

function mockGit(stdout = '', stderr = '') {
  mockExecFile.mockReturnValue({ stdout, stderr })
}

function mockGitError(msg: string) {
  mockExecFile.mockReturnValue(new Error(msg))
}

const allowShell: ShellPolicy = { authorize: () => true }
const denyShell: ShellPolicy = { authorize: () => false }

describe('git_diff', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('returns diff output', async () => {
    mockGit('diff --git a/x.ts b/x.ts\n+added line')
    const tool = makeGitDiffTool()
    const result = await tool.handler({})
    expect(result).toContain('added line')
  })

  it('passes --staged when staged:true', async () => {
    mockGit('staged diff')
    const tool = makeGitDiffTool()
    await tool.handler({ staged: true })
    expect(mockExecFile).toHaveBeenCalledWith('git', ['diff', '--staged'], expect.any(Object))
  })

  it('limits to path when given', async () => {
    mockGit('')
    const tool = makeGitDiffTool()
    await tool.handler({ path: 'src/a.ts' })
    expect(mockExecFile).toHaveBeenCalledWith('git', ['diff', 'src/a.ts'], expect.any(Object))
  })

  it('returns error when git fails', async () => {
    mockGitError('not a git repository')
    const tool = makeGitDiffTool()
    const result = await tool.handler({})
    expect(result).toContain('ERROR')
    expect(result).toContain('not a git repository')
  })
})

describe('git_log', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('returns log output', async () => {
    mockGit('abc123 feat: add x\ndef456 fix: bug')
    const tool = makeGitLogTool()
    const result = await tool.handler({})
    expect(result).toContain('abc123')
    expect(result).toContain('def456')
  })

  it('passes -n flag', async () => {
    mockGit('')
    const tool = makeGitLogTool()
    await tool.handler({ n: 5 })
    expect(mockExecFile).toHaveBeenCalledWith('git', ['log', '--oneline', '-n5'], expect.any(Object))
  })

  it('defaults to -n10', async () => {
    mockGit('')
    const tool = makeGitLogTool()
    await tool.handler({})
    expect(mockExecFile).toHaveBeenCalledWith('git', ['log', '--oneline', '-n10'], expect.any(Object))
  })
})

describe('git_branch', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('lists branches when no name given', async () => {
    mockGit('* main\n  feature/x')
    const tool = makeGitBranchTool()
    const result = await tool.handler({})
    expect(result).toContain('main')
    expect(result).toContain('feature/x')
  })

  it('creates a branch when name given', async () => {
    mockGit('')
    const tool = makeGitBranchTool()
    const result = await tool.handler({ name: 'feature/y' })
    expect(result).toContain('Created branch feature/y')
    expect(mockExecFile).toHaveBeenCalledWith('git', ['branch', 'feature/y'], expect.any(Object))
  })
})

describe('git_commit', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('commits with message', async () => {
    mockGit('[main abc123] feat: done')
    const tool = makeGitCommitTool(allowShell)
    const result = await tool.handler({ message: 'feat: done' })
    expect(result).toContain('abc123')
  })

  it('stages specific files', async () => {
    mockExecFile.mockReturnValueOnce({ stdout: '', stderr: '' })           // git add
    mockExecFile.mockReturnValueOnce({ stdout: '[main abc123]', stderr: '' }) // git commit
    const tool = makeGitCommitTool(allowShell)
    await tool.handler({ message: 'fix', files: ['a.ts', 'b.ts'] })
    expect(mockExecFile).toHaveBeenCalledWith('git', ['add', 'a.ts', 'b.ts'], expect.any(Object))
  })

  it('returns error when message is missing', async () => {
    const tool = makeGitCommitTool(allowShell)
    const result = await tool.handler({ message: '' })
    expect(result).toContain('ERROR')
  })

  it('denies when shell policy rejects', async () => {
    const tool = makeGitCommitTool(denyShell)
    const result = await tool.handler({ message: 'bad commit' })
    expect(result).toContain('DENIED')
  })
})

describe('git_status', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('shows working tree status', async () => {
    mockGit('## main\n M src/a.ts\n?? new.txt')
    const tool = makeGitStatusTool()
    const result = await tool.handler({})
    expect(result).toContain('main')
    expect(result).toContain('src/a.ts')
  })
})

describe('git_stash', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('stashes changes', async () => {
    mockGit('Saved working directory')
    const tool = makeGitStashTool()
    const result = await tool.handler({ action: 'push' })
    expect(result).toContain('Saved')
  })

  it('lists stashes', async () => {
    mockGit('stash@{0}: On main: wip')
    const tool = makeGitStashTool()
    const result = await tool.handler({ action: 'list' })
    expect(result).toContain('wip')
  })
})

describe('git_worktree', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('lists worktrees', async () => {
    mockGit('/proj  abc123 [main]\n/proj2  def456 [feat]')
    const tool = makeGitWorktreeTool()
    const result = await tool.handler({})
    expect(result).toContain('main')
    expect(result).toContain('feat')
  })
})

describe('git_fetch', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('fetches from origin', async () => {
    mockGit('From github.com:user/repo\n * branch main -> FETCH_HEAD')
    const tool = makeGitFetchTool()
    const result = await tool.handler({})
    expect(result).toContain('FETCH_HEAD')
  })
})

describe('git_push', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('pushes to remote', async () => {
    mockGit('To github.com:user/repo\n   abc..def  main -> main')
    const tool = makeGitPushTool(allowShell)
    const result = await tool.handler({ branch: 'main' })
    expect(result).toContain('main -> main')
  })

  it('denies when shell policy rejects', async () => {
    const tool = makeGitPushTool(denyShell)
    const result = await tool.handler({})
    expect(result).toContain('DENIED')
  })
})

describe('git_pull', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('pulls from origin', async () => {
    mockGit('Updating abc..def\nFast-forward')
    const tool = makeGitPullTool(allowShell)
    const result = await tool.handler({})
    expect(result).toContain('Fast-forward')
  })
})

describe('git_merge', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('merges a branch', async () => {
    mockGit('Merge made by ort strategy')
    const tool = makeGitMergeTool()
    const result = await tool.handler({ branch: 'feature/x' })
    expect(result).toContain('ort strategy')
  })
})

describe('git_revert', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('reverts a commit', async () => {
    mockGit('[main abc123] Revert "bad commit"')
    const tool = makeGitRevertTool()
    const result = await tool.handler({ commit: 'def456' })
    expect(result).toContain('abc123')
  })
})

describe('git_blame', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('shows authorship for a file', async () => {
    mockGit('abc123 (Alice 2026-01-01 1) line 1')
    const tool = makeGitBlameTool()
    const result = await tool.handler({ path: 'src/a.ts' })
    expect(result).toContain('Alice')
  })
})

describe('git_tag', () => {
  beforeEach(() => { mockExecFile.mockReset() })

  it('lists tags', async () => {
    mockGit('v0.1.0\nv0.2.0')
    const tool = makeGitTagTool()
    const result = await tool.handler({})
    expect(result).toContain('v0.1.0')
  })

  it('creates a tag', async () => {
    mockGit('')
    const tool = makeGitTagTool()
    const result = await tool.handler({ name: 'v1.0.0', message: 'release' })
    expect(result).toContain('Created tag v1.0.0')
  })
})
