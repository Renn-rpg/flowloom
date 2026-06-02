// isolated-vm 沙箱实现（骨架）。
// isolated-vm 是可选依赖——安装失败时降级回 node:vm sandbox。
// 使用动态 import 避免 TypeScript 对缺失模块报错。

import type { Runtime, RuntimeContext } from './types.js'

// 检测 isolated-vm 是否可用（运行时动态加载）
let _ivmAvailable: boolean | null = null

async function loadIvm(): Promise<any> {
  try {
    // 动态 import 避免 tsc 检查
    const m = await (Function('return import("isolated-vm")')() as Promise<any>)
    return m.default ?? m
  } catch {
    return null
  }
}

export async function isIsolatedVmAvailable(): Promise<boolean> {
  if (_ivmAvailable === null) {
    _ivmAvailable = (await loadIvm()) !== null
  }
  return _ivmAvailable
}

export class IsolatedVmRuntime implements Runtime {
  private ivm: any = null
  private memoryLimit: number
  private timeoutMs: number

  constructor(ivmModule: any, opts?: { memoryLimit?: number; timeoutMs?: number }) {
    this.ivm = ivmModule
    this.memoryLimit = opts?.memoryLimit ?? 128
    this.timeoutMs = opts?.timeoutMs ?? 30_000
  }

  static async create(opts?: { memoryLimit?: number; timeoutMs?: number }): Promise<IsolatedVmRuntime> {
    const ivm = await loadIvm()
    if (!ivm) {
      throw new Error(
        'isolated-vm is not installed. Run: npm install isolated-vm\n' +
        'Falling back to NodeVmRuntime (node:vm) — less isolation, but functional.'
      )
    }
    return new IsolatedVmRuntime(ivm, opts)
  }

  createContext(_api: Record<string, unknown>): RuntimeContext {
    const isolate = new this.ivm.Isolate({ memoryLimit: this.memoryLimit })
    const context = isolate.createContextSync()
    const timeout = this.timeoutMs

    return {
      async run(fn: (...args: any[]) => any, ..._args: any[]): Promise<unknown> {
        const script = await isolate.compileScript(
          `(${fn.toString()}).apply(null, ${JSON.stringify(_args)})`,
        )
        return script.run(context, { timeout })
      },
      async runInSandbox(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
        const fnBody = fn.toString()
        const script = await isolate.compileScript(
          `(function() { return (${fnBody}).apply(null, ${JSON.stringify(args)}); })()`,
        )
        return script.run(context, { timeout })
      },
    }
  }
}
