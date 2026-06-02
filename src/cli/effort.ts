// --effort 档位 → 实际模型解析。
// 背景（docs/deepseek-fact-check.md R2/R9，📄官方文档）：deepseek-reasoner 不支持工具调用，
// 「带工具的思考」需 thinking-mode 模型（文档示例 id 为 deepseek-v4-pro，未在本账户实测）。
// 故 high/max 档位映射到的模型 id 一律走 FLOOM_REASONER_MODEL，**不臆造默认 id**；
// 未配置则告警并回退到基础模型（不打断使用）。
export interface EffortResolution {
  model: string
  reasoning: boolean // 是否切到推理/thinking 模型（影响 banner 与渲染提示）
  warning?: string
}

export function resolveEffortModel(
  baseModel: string,
  effort: string | undefined,
  reasonerModel: string,
): EffortResolution {
  const lvl = (effort ?? '').trim().toLowerCase()
  if (lvl === 'high' || lvl === 'max') {
    if (!reasonerModel) {
      return {
        model: baseModel,
        reasoning: false,
        warning:
          '--effort high 需要 thinking+工具模型；请把其 id 设进环境变量 FLOOM_REASONER_MODEL（用真实 key 确认账户已开放，如 deepseek-v4-pro）。当前未设置，已回退到基础模型。',
      }
    }
    return { model: reasonerModel, reasoning: true }
  }
  // 其它（含 undefined / low / medium / auto）：用基础模型
  return { model: baseModel, reasoning: false }
}
