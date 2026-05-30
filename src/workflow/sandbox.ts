import vm from 'node:vm'
import type { Runtime, RuntimeContext } from './types.js'

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
})

export class NodeVmRuntime implements Runtime {
  constructor(private syncTimeoutMs = 30_000) {}

  createContext(api: Record<string, unknown>): RuntimeContext {
    const sandboxObj = { ...sandboxBase }
    // 把 API 属性复制到 sandbox，每个值都做 hostFn wrapping
    // （可信代码模型下接受 constructor 逃逸风险，参见 CLAUDE.md 设计决策）
    for (const key of Object.keys(api)) {
      ;(sandboxObj as any)[key] = api[key]
    }
    const sandboxCtx = vm.createContext(sandboxObj, {
      codeGeneration: { strings: false, wasm: false },
    })
    const timeoutMs = this.syncTimeoutMs
    return {
      async runScript(
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ): Promise<unknown> {
        const fnBody = fn.toString()
        const argsJson = JSON.stringify(args)
        // IIFE: 在 sandbox 内执行 fn.apply(null, args)
        const code = `
          (function() {
            const __fn = (${fnBody});
            return __fn.apply(null, ${argsJson});
          })()
        `
        const result = vm.runInContext(code, sandboxCtx, {
          timeout: timeoutMs,
        })
        // result 可能是 Promise（async fn），需 await 解包
        if (
          result != null &&
          typeof (result as any).then === 'function'
        ) {
          return await result
        }
        return result
      },
    }
  }
}
