// ModelClient 工厂：集中管理客户端构造逻辑，让上层模块（cli、session-factory）只依赖
// ModelClient 接口而非具体实现。这是实现"模型可替换性"的关键——加新模型只需改这里。
import { DeepSeekClient } from './deepseek-client.js'
import { ModelRouter, type RouterClient } from './router.js'
import type { ModelClient } from './client.js'

export interface ModelClientFactory {
  createClient(model: string, opts?: { apiKey?: string; baseURL?: string; timeoutMs?: number }): ModelClient
  createRouter(clients: RouterClient[]): ModelClient
}

export class DefaultModelClientFactory implements ModelClientFactory {
  createClient(model: string, opts?: { apiKey?: string; baseURL?: string; timeoutMs?: number }): ModelClient {
    return new DeepSeekClient({ model, ...opts })
  }

  createRouter(clients: RouterClient[]): ModelClient {
    return new ModelRouter(clients)
  }
}

// 单例工厂实例——避免到处 new DefaultModelClientFactory()
let _factory: ModelClientFactory | undefined

export function getFactory(): ModelClientFactory {
  if (!_factory) _factory = new DefaultModelClientFactory()
  return _factory
}
