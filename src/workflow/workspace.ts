import { mkdtemp, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

export class Workspace {
  private constructor(public readonly root: string) {}

  resolve(filePath: string): string {
    if (isAbsolute(filePath) || filePath.includes('..')) {
      throw new Error(
        `Path not allowed in workspace: "${filePath}". ` +
          'Use relative paths without ..',
      )
    }
    return join(this.root, filePath)
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  static async create(): Promise<Workspace> {
    const root = await mkdtemp(join(tmpdir(), 'floom-ws-'))
    return new Workspace(root)
  }
}
