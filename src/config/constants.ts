// 全局共享常量：避免 tools/ ↔ cli/ 双向依赖。
// 所有环境变量默认值集中在此定义。

const rawToolLimit = Number(process.env.FLOOM_TOOL_OUTPUT_LIMIT)
export const TOOL_OUTPUT_LIMIT = Number.isFinite(rawToolLimit) && rawToolLimit > 0 ? rawToolLimit : 10_000
const rawMemLimit = Number(process.env.FLOOM_MEMORY_LIMIT)
export const MEMORY_CONTENT_LIMIT = Number.isFinite(rawMemLimit) && rawMemLimit > 0 ? rawMemLimit : 500
