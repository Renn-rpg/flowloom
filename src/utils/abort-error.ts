// 统一的 "已中断" 错误工厂。消弭 loop.ts 与 deepseek-client.ts 的重复定义。
// name=AbortError 便于上层（retry/withRetry）识别并跳过重试。

export function makeAbortError(reason = 'aborted'): Error {
  const e = new Error(reason)
  e.name = 'AbortError'
  return e
}
