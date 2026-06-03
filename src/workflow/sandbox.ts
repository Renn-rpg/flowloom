import vm from 'node:vm'
import type { Runtime, RuntimeContext } from './types.js'

let runCounter = 0

// 确定性 Date 包装：拦截 Date.now() / 无参构造 / 无 new 调用
function wrapDate(): DateConstructor {
  const Orig = Date
  const handler: ProxyHandler<typeof Date> = {
    construct(target, args, newTarget) {
      if (args.length === 0) {
        throw new Error(
          'new Date() is non-deterministic; use new Date(ms) or new Date(isoString)',
        )
      }
      return Reflect.construct(target, args, newTarget)
    },
    apply(_target, _thisArg, _args) {
      throw new Error('Date() called without new is non-deterministic')
    },
    get(target, prop, _receiver) {
      if (prop === 'now') {
        return () => {
          throw new Error('Date.now() is non-deterministic')
        }
      }
      const val = Reflect.get(target, prop)
      if (typeof val === 'function') return val.bind(target)
      return val
    },
  }
  return new Proxy(Orig, handler)
}

// 确定性 Math 包装：拦截 Math.random()
function wrapMath(): Math {
  const copy = Object.create(Math) as Math
  ;(copy as any).random = () => {
    throw new Error('Math.random() is non-deterministic')
  }
  return Object.freeze(copy)
}

const sandboxBase = Object.freeze({
  Date: wrapDate(),
  Math: wrapMath(),
  console: undefined,
  // 阻断 constructor 逃逸路径：Function 和 eval 在 sandbox 内不可用。
  // 注意：node:vm 不是安全沙箱，宿主函数引用仍可访问外部作用域。
  // 对完全隔离需求应使用 isolated-vm。
  Function: undefined,
  eval: undefined,
})

// 封装宿主函数引用：阻止沙箱代码通过 fn.constructor 拿到宿主 Function 构造器。
// ⚠️ node:vm 不是安全沙箱——此措施仅提高攻击门槛，不能防止所有逃逸。
// 完全隔离需使用 isolated-vm。
function sealHostFn(fn: (...args: any[]) => any): (...args: any[]) => any {
  const proxy = new Proxy(fn, {
    get(target, prop) {
      if (prop === 'constructor') {
        throw new Error('Function constructor is not available in the sandbox')
      }
      // 放行 Function.prototype 的必要方法（.apply/.call/.bind 等），否则沙箱无法调用该函数。
      // 只阻断 constructor，其余属性通过 Reflect.get 正常返回。
      const val = Reflect.get(target, prop)
      if (typeof val === 'function') return val.bind(target)
      return val
    },
  }) as (...args: any[]) => any
  return proxy
}

// 递归封装对象中所有函数值，阻断宿主函数引用进入沙箱。
function sealApi(api: Record<string, unknown>): Record<string, unknown> {
  const sealed: Record<string, unknown> = {}
  for (const key of Object.keys(api)) {
    const val = api[key]
    sealed[key] = typeof val === 'function' ? sealHostFn(val as (...args: any[]) => any) : val
  }
  return sealed
}

export class NodeVmRuntime implements Runtime {
  constructor(private syncTimeoutMs = 30_000) {}

  createContext(api: Record<string, unknown>): RuntimeContext {
    const sandboxObj = { ...sandboxBase }
    // 所有宿主函数引用先经 sealApi 封装，阻断 constructor 逃逸路径。
    const sealed = sealApi(api)
    for (const key of Object.keys(sealed)) {
      ;(sandboxObj as any)[key] = sealed[key]
    }
    const sandboxCtx = vm.createContext(sandboxObj, {
      codeGeneration: { strings: false, wasm: false },
    })
    const timeoutMs = this.syncTimeoutMs
    return {
      // 注入宿主函数引用到 sandbox 并调用。宿主函数的 globalThis 仍是宿主上下文，
      // 适用于需要访问复杂宿主对象（如 WorkflowCtx）的场景。workflow-runtime 走此路径。
      // ⚠️ 安全警告：注入宿主函数到沙箱存在 constructor 逃逸风险。
      // sealHostFn 提高了攻击门槛，但 node:vm 不是安全沙箱。完全隔离需使用 isolated-vm。
      async run(
        fn: (...args: any[]) => any,
        ...args: any[]
      ): Promise<unknown> {
        const fnKey = `__injected_fn_${runCounter++}`
        const argKeys = args.map((_, i) => `__injected_arg_${runCounter}_${i}`)
        ;(sandboxCtx as any)[fnKey] = sealHostFn(fn)
        argKeys.forEach((k, i) => {
          const v = args[i]
          ;(sandboxCtx as any)[k] = typeof v === 'function' ? sealHostFn(v as (...args: any[]) => any) : v
        })
        try {
          const code = `${fnKey}.apply(null, [${argKeys.join(',')}])`
          const result = vm.runInContext(code, sandboxCtx, { timeout: timeoutMs })
          if (result != null && typeof (result as any).then === 'function') {
            return await result
          }
          return result
        } finally {
          delete (sandboxCtx as any)[fnKey]
          argKeys.forEach((k) => delete (sandboxCtx as any)[k])
        }
      },

      // 在 sandbox 内执行函数体（序列化后 eval 到 sandbox 上下文），
      // 函数内的 Date/Math 等指向 sandbox 的包装版本。用于测试沙箱确定性行为。
      async runInSandbox(
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ): Promise<unknown> {
        const fnBody = fn.toString()
        const argsJson = JSON.stringify(args)
        const code = `
          (function() {
            const __fn = (${fnBody});
            return __fn.apply(null, ${argsJson});
          })()
        `
        const result = vm.runInContext(code, sandboxCtx, {
          timeout: timeoutMs,
        })
        if (result != null && typeof (result as any).then === 'function') {
          return await result
        }
        return result
      },
    }
  }
}

// —— IsolatedVmRuntime：真正的内存隔离沙箱（需 isolated-vm 可选依赖）——

let _isolatedVmAvailable: boolean | null = null

async function isIsolatedVmAvailable(): Promise<boolean> {
  if (_isolatedVmAvailable !== null) return _isolatedVmAvailable
  try { await import('isolated-vm'); _isolatedVmAvailable = true }
  catch { _isolatedVmAvailable = false }
  return _isolatedVmAvailable
}

export class IsolatedVmRuntime implements Runtime {
  private pool: any[] = []
  private memoryLimit: number
  private cpuTimeout: number

  constructor(opts?: { memoryLimit?: number; cpuTimeout?: number; poolSize?: number }) {
    this.memoryLimit = opts?.memoryLimit ?? 128
    this.cpuTimeout = opts?.cpuTimeout ?? 30_000
  }

  static async create(opts?: { memoryLimit?: number; cpuTimeout?: number; poolSize?: number }): Promise<IsolatedVmRuntime> {
    if (!(await isIsolatedVmAvailable())) {
      throw new Error(
        'isolated-vm is not installed. Install it with: npm install isolated-vm\n' +
        'To use node:vm (NOT a security sandbox) as a fallback, pass --unsafe-sandbox.',
      )
    }
    return new IsolatedVmRuntime(opts)
  }

  async createContext(api: Record<string, unknown>): Promise<RuntimeContext> {
    const ivm = await import('isolated-vm')
    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimit })
    try {
    const context = await isolate.createContext()
    const jail = context.global

    const setJail = async (key: string, val: unknown) => {
      if (typeof val === 'function') {
        await jail.set(key, new ivm.Reference(val))
      } else if (val && typeof val === 'object') {
        // 逐属性 set 避免 ExternalCopy 混入 Reference 崩溃
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          if (typeof v === 'function') await jail.set(`${key}_${k}`, new ivm.Reference(v))
          else await jail.set(`${key}_${k}`, new ivm.ExternalCopy(v).copyInto())
        }
      } else {
        await jail.set(key, new ivm.ExternalCopy(val).copyInto())
      }
    }
    for (const [key, val] of Object.entries(api)) await setJail(key, val)

    let disposed = false
    const cpuTimeout = this.cpuTimeout

    return {
      async run(fn: (...args: any[]) => any, ...args: any[]): Promise<unknown> {
        if (disposed) throw new Error('RuntimeContext disposed')
        for (let i = 0; i < args.length; i++) await setJail(`_a${i}`, args[i])
        try {
          const fnBody = fn.toString()
          const argList = args.map((_, i) => `_a${i}`).join(',')
          const script = await isolate.compileScript(
            `(function(){const __fn=(${fnBody});return __fn(${argList});})()`,
            { filename: 'workflow-agent.js' },
          )
          const result = await script.run(context, { timeout: cpuTimeout })
          if (result && typeof result === 'object' && typeof result.copy === 'function') return result.copy()
          return result
        } finally {
          for (let i = 0; i < args.length; i++) { try { await jail.delete(`_a${i}`) } catch {} }
        }
      },
      async runInSandbox(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
        if (disposed) throw new Error('RuntimeContext disposed')
        const fnBody = fn.toString()
        const script = await isolate.compileScript(
          `(function(){const __fn=(${fnBody});return __fn.apply(null,${JSON.stringify(args)});})()`,
          { filename: 'sandbox-eval.js' },
        )
        const result = await script.run(context, { timeout: cpuTimeout })
        if (result && typeof result === 'object' && typeof result.copy === 'function') return result.copy()
        return result
      },
      dispose: async () => {
        if (!disposed) { disposed = true; try { isolate.dispose() } catch {} }
      },
    }
    } catch { try { isolate.dispose() } catch {}; throw new Error('Failed to create isolated-vm context') }
  }
}
