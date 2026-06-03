import { describe, it, expect } from 'vitest'
import { resolve, join, sep } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  allowAllPaths,
  confineToRoot,
  denySecrets,
  isSensitivePath,
  allowAllShell,
  denyAllShell,
} from './permissions.js'

describe('confineToRoot', () => {
  const root = resolve(sep === '\\' ? 'C:\\proj\\root' : '/proj/root')
  const policy = confineToRoot(root)

  it('allows a relative path inside root and returns its absolute form', () => {
    expect(policy.check('src/index.ts')).toBe(join(root, 'src', 'index.ts'))
  })

  it('allows nested subdirectories', () => {
    expect(policy.check('a/b/c.txt')).toBe(join(root, 'a', 'b', 'c.txt'))
  })

  it('allows an absolute path that is inside root', () => {
    const inside = join(root, 'pkg', 'file.ts')
    expect(policy.check(inside)).toBe(inside)
  })

  it('rejects a relative ".." escape', () => {
    expect(() => policy.check('../outside')).toThrow(/outside the project root/)
    expect(() => policy.check('a/../../b')).toThrow(/outside the project root/)
  })

  it('rejects a bare ".."', () => {
    expect(() => policy.check('..')).toThrow(/outside the project root/)
  })

  it('rejects an absolute path outside root', () => {
    const outside = sep === '\\' ? 'C:\\Windows\\system32' : '/etc/passwd'
    expect(() => policy.check(outside)).toThrow(/outside the project root/)
  })

  it('does not false-reject filenames that merely contain dots', () => {
    expect(policy.check('foo..bar/baz..qux.txt')).toBe(
      join(root, 'foo..bar', 'baz..qux.txt'),
    )
  })
})

describe('confineToRoot symlink escape', () => {
  it('blocks a symlink inside root that points outside root, but allows normal in-root paths', () => {
    const base = mkdtempSync(join(tmpdir(), 'floom-perm-'))
    try {
      const root = join(base, 'project')
      mkdirSync(root)
      const outside = join(base, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'x')
      const linkPath = join(root, 'link')
      try {
        // Windows 上目录用 junction 不需要管理员权限；其它平台用普通 dir 软链
        symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        return // 无权限创建软链（如 Windows 非开发者模式）→ 跳过该用例
      }
      const policy = confineToRoot(root)
      // 经项目内软链访问项目外文件 → 拦截
      expect(() => policy.check('link/secret.txt')).toThrow(/outside the project root/)
      // 普通项目内路径（即便尚不存在）→ 放行
      expect(() => policy.check('src/a.ts')).not.toThrow()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('allowAllPaths', () => {
  it('returns the path unchanged (backward-compatible)', () => {
    expect(allowAllPaths.check('../anything/../weird')).toBe('../anything/../weird')
    expect(allowAllPaths.check('/etc/passwd')).toBe('/etc/passwd')
  })
})

describe('isSensitivePath', () => {
  it('blocks .env and its environment variants', () => {
    expect(isSensitivePath('/proj/.env')).toBe(true)
    expect(isSensitivePath('/proj/.env.local')).toBe(true)
    expect(isSensitivePath('/proj/.env.production')).toBe(true)
    expect(isSensitivePath('C:\\proj\\.env')).toBe(true)
  })

  it('allows committed .env templates', () => {
    expect(isSensitivePath('/proj/.env.example')).toBe(false)
    expect(isSensitivePath('/proj/.env.sample')).toBe(false)
    expect(isSensitivePath('/proj/.env.template')).toBe(false)
  })

  it('blocks private keys and credential files', () => {
    expect(isSensitivePath('/proj/server.pem')).toBe(true)
    expect(isSensitivePath('/proj/private.key')).toBe(true)
    expect(isSensitivePath('/home/u/id_rsa')).toBe(true)
    expect(isSensitivePath('/home/u/id_ed25519')).toBe(true)
    expect(isSensitivePath('/home/u/.aws/credentials')).toBe(true)
    expect(isSensitivePath('/proj/.npmrc')).toBe(true)
    expect(isSensitivePath('/proj/secrets.json')).toBe(true)
  })

  it('does not false-positive on normal source files', () => {
    expect(isSensitivePath('/proj/src/index.ts')).toBe(false)
    expect(isSensitivePath('/proj/package.json')).toBe(false)
    expect(isSensitivePath('/proj/environment.ts')).toBe(false)
    expect(isSensitivePath('/proj/keyboard.ts')).toBe(false)
  })
})

describe('denySecrets', () => {
  const root = resolve(sep === '\\' ? 'C:\\proj' : '/proj')
  const policy = denySecrets(confineToRoot(root))

  it('allows a normal in-root file (returns absolute path)', () => {
    expect(policy.check('src/index.ts')).toBe(join(root, 'src', 'index.ts'))
  })

  it('rejects reading a secret file inside root', () => {
    expect(() => policy.check('.env')).toThrow(/secret\/credential/)
    expect(() => policy.check('config/server.pem')).toThrow(/secret\/credential/)
  })

  it('still enforces the inner confinement', () => {
    expect(() => policy.check('../escape')).toThrow(/outside the project root/)
  })
})

describe('shell policies', () => {
  it('allowAllShell authorizes everything', async () => {
    expect(await allowAllShell.authorize('rm -rf /')).toBe(true)
  })

  it('denyAllShell authorizes nothing', async () => {
    expect(await denyAllShell.authorize('echo hi')).toBe(false)
  })

  it('custom shell policy delegates to the authorize callback', async () => {
    const seen: string[] = []
    const policy = {
      authorize: (cmd: string) => {
        seen.push(cmd)
        return cmd.startsWith('echo')
      },
    }
    expect(await policy.authorize('echo ok')).toBe(true)
    expect(await policy.authorize('curl evil')).toBe(false)
    expect(seen).toEqual(['echo ok', 'curl evil'])
  })
})
