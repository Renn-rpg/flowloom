import { mkdtemp, rm } from 'node:fs/promises'
import { join, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'

export class Workspace {
  private constructor(public readonly root: string) {}

  resolve(filePath: string): string {
    if (isAbsolute(filePath)) {
      throw new Error(
        `Path not allowed in workspace: "${filePath}". Use relative paths.`,
      )
    }
    // join 会归一化 ".." 段；随后做边界校验，确保结果仍落在 root 内部。
    // 比 includes('..') 黑名单稳健：不误杀 "foo..bar"，也挡住归一化后逃逸的路径。
    const joined = join(this.root, filePath)
    const base = this.root.endsWith(sep) ? this.root : this.root + sep
    if (joined !== this.root && !joined.startsWith(base)) {
      throw new Error(
        `Path escapes workspace: "${filePath}" resolves outside ${this.root}`,
      )
    }
    return joined
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  static async create(): Promise<Workspace> {
    const root = await mkdtemp(join(tmpdir(), 'floom-ws-'))
    return new Workspace(root)
  }
}
