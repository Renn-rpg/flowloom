/**
 * FlowLoom 子工作流演示
 * ======================
 * 被 dynamic-workflow-demo.mjs 的 workflow() 调用
 * 展示嵌套工作流能力
 */

export const meta = {
  name: 'sub-demo',
  version: '1.0.0',
  description: '子工作流 — 演示 workflow() 嵌套调用',
  schemaVersion: 1,
}

export async function run(ctx) {
  ctx.phase('🔽 子工作流启动')

  ctx.log(`父工作流传入参数: ${JSON.stringify(ctx.args)}`)

  // 在子工作流中也可以使用 agent
  const result = await ctx.agent(
    '用一句话说明"嵌套工作流"的价值。控制在 15 字内。'
  )

  ctx.log(`子智能体回复: ${result}`)

  // 子工作流的 budget 共享父工作流的预算
  ctx.log(`子工作流当前预算使用: ${ctx.budget.spent}/${ctx.budget.total}`)

  ctx.phase('🔼 子工作流完成')

  return {
    subResult: result,
    subBudgetUsed: ctx.budget.spent,
  }
}
