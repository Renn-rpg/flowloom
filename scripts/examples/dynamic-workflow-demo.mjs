/**
 * FlowLoom Dynamic Workflow 综合演示
 * =====================================
 *
 * 这个脚本演示了 Dynamic Workflow 引擎的六大核心能力：
 *   1. agent()    — 单智能体任务
 *   2. parallel() — 并行智能体
 *   3. pipeline() — 流水线处理
 *   4. phase/log  — 阶段化进度输出
 *   5. budget     — 预算追踪
 *   6. workflow() — 嵌套工作流
 *
 * 场景：模拟一个"代码审查 + 质量报告"自动化流程
 */

export const meta = {
  name: 'dynamic-workflow-demo',
  version: '2.0.0',
  description: 'Dynamic Workflow 六大核心能力综合演示',
  schemaVersion: 1,
}

export async function run(ctx) {
  // ============================================================
  // 阶段 1: 初始化 — 显示参数
  // ============================================================
  ctx.phase('⚡ Dynamic Workflow Demo 启动')
  ctx.log(`模式: ${ctx.args.mode ?? 'standard'}`)
  ctx.log(`预算上限: ${ctx.budget.total} tokens`)

  // ============================================================
  // 阶段 2: 演示 agent() — 单智能体调用
  // ============================================================
  ctx.phase('📡 1/6 — agent() 单智能体调用')
  ctx.log('让一个 AI 智能体独立完成任务...')

  const greeting = await ctx.agent(
    '用一句中文介绍你自己，并说出你今天的主要任务是什么。控制在 20 字以内。'
  )
  ctx.log(`→ 智能体回复: ${greeting}`)

  // ============================================================
  // 阶段 3: 演示 parallel() — 并行智能体
  // ============================================================
  ctx.phase('⚡ 2/6 — parallel() 并行智能体')
  ctx.log('同时启动 3 个 AI 智能体，各自独立分析...')

  const tasks = [
    () => ctx.agent('用 10 个字以内描述"前端开发"'),
    () => ctx.agent('用 10 个字以内描述"后端开发"'),
    () => ctx.agent('用 10 个字以内描述"DevOps"'),
  ]

  const parallelResults = await ctx.parallel(tasks)
  parallelResults.forEach((r, i) => {
    ctx.log(`  Agent #${i + 1}: ${r ?? '(失败)'}`)
  })

  // ============================================================
  // 阶段 4: 演示 pipeline() — 流水线处理
  // ============================================================
  ctx.phase('🏭 3/6 — pipeline() 流水线处理')
  ctx.log('数据流经多级处理阶段...')

  const rawItems = ['TypeScript', 'Rust', 'Go', 'Python']

  const pipelineResult = await ctx.pipeline(
    rawItems,
    // 阶段 A: 用 agent 评估每个语言
    async (_, item) => {
      const evalResult = await ctx.agent(
        `用 5 个字以内评价 ${item} 语言的特点`
      )
      return { language: item, eval: evalResult }
    },
    // 阶段 B: 汇总成一句话
    async (prevResults) => {
      const items = Array.isArray(prevResults) ? prevResults : []
      const summary = items
        .filter(Boolean)
        .map((r) => `${r.language}: ${r.eval}`)
        .join(' | ')
      return `【流水线最终输出】${summary}`
    }
  )

  ctx.log(`→ ${pipelineResult}`)

  // ============================================================
  // 阶段 5: 演示 phase/log — 进度追踪
  // ============================================================
  ctx.phase('📊 4/6 — phase() + log() 进度追踪')
  ctx.log('阶段化输出已贯穿整个演示全程')
  ctx.log('每个 phase() 自动生成时间戳标记')
  ctx.log('log() 输出缩进层级的信息')

  // 模拟多步骤进度
  for (let step = 1; step <= 3; step++) {
    ctx.log(`  子步骤 ${step}/3 完成 ✓`)
  }

  // ============================================================
  // 阶段 6: 演示 budget — 预算追踪
  // ============================================================
  ctx.phase('💰 5/6 — budget 预算追踪')
  ctx.log(`已消耗: ${ctx.budget.spent} tokens`)
  ctx.log(`剩余:   ${ctx.budget.remaining()} tokens`)
  ctx.log(`总预算: ${ctx.budget.total} tokens`)

  // 模拟预算检查
  ctx.budget.assertHasBudget(100) // 确认至少有 100 tokens 剩余
  ctx.log('✅ 预算充足，继续执行...')

  // ============================================================
  // 阶段 7: 演示 workflow() — 嵌套工作流
  // ============================================================
  ctx.phase('🔄 6/6 — workflow() 嵌套工作流')
  ctx.log('启动一个子工作流进行专项分析...')

  // 动态构造一个内联子工作流脚本
  const subWorkflowPath = ctx.args._subWorkflowPath
  if (subWorkflowPath) {
    try {
      const subResult = await ctx.workflow(subWorkflowPath, {
        mode: 'sub',
        parentBudget: ctx.budget.spent,
      })
      ctx.log(`子工作流返回: ${JSON.stringify(subResult)}`)
    } catch (e) {
      ctx.log(`子工作流执行: ${e.message}`)
    }
  } else {
    ctx.log('跳过嵌套工作流演示（未指定 _subWorkflowPath 参数）')
    ctx.log('提示: 可指定参数 { "_subWorkflowPath": "./sub-demo.mjs" } 来演示')
  }

  // ============================================================
  // 最终阶段: 汇总报告
  // ============================================================
  ctx.phase('✅ 演示结束 — 汇总报告')

  const finalSummary = await ctx.agent(
    `基于以下信息生成一句总结语：
    - 预算使用: ${ctx.budget.spent}/${ctx.budget.total}
    - 并行任务数: ${tasks.length}
    - 流水线阶段数: 2
    输出格式: 一句 20 字以内的总结。`
  )

  ctx.log(`\n🎯 最终总结: ${finalSummary}`)

  return {
    status: 'completed',
    features: ['agent', 'parallel', 'pipeline', 'phase/log', 'budget', 'workflow'],
    budgetUsed: ctx.budget.spent,
    budgetTotal: ctx.budget.total,
    parallelResults,
    pipelineOutput: pipelineResult,
    finalSummary,
  }
}
