/**
 * nature-skills 仓库分析工作流
 * ===============================
 *
 * 使用 FlowLoom Dynamic Workflow 的 parallel/pipeline/agent 能力，
 * 对 https://github.com/Yuan1z0825/nature-skills 进行全面分析。
 *
 * 分析维度:
 *   1. 仓库概览与定位
 *   2. 技能矩阵分析 (11个技能逐个评估)
 *   3. 架构设计原则
 *   4. 技术栈与工具链
 *   5. 社区与生态
 *   6. 综合评分与建议
 *
 * 运行:
 *   npx floom run scripts/examples/analyze-nature-skills.mjs
 */

export const meta = {
  name: 'analyze-nature-skills',
  version: '1.0.0',
  description: '对 nature-skills 仓库进行多维度深度分析',
  schemaVersion: 1,
}

export async function run(ctx) {
  ctx.phase('🔬 nature-skills 仓库深度分析')
  ctx.log(`分析目标: https://github.com/Yuan1z0825/nature-skills`)
  ctx.log(`预算上限: ${ctx.budget.total} tokens`)

  // ============================================================
  // 阶段 1: 并行 — 多维度初步分析
  // ============================================================
  ctx.phase('📡 阶段 1/4 — parallel() 并行多维度初步分析')
  ctx.log('同时启动 5 个子 Agent，各自负责不同维度分析...')

  const [overviewRaw, skillMatrixRaw, architectureRaw, techStackRaw, communityRaw] =
    await ctx.parallel([
      // Agent 1: 仓库概览
      () =>
        ctx.agent(
          `分析 nature-skills 仓库的整体定位与价值主张。请输出 JSON:
{
  "positioning": "一句话定位",
  "targetUsers": ["用户1", "用户2"],
  "coreValue": "核心价值",
  "stars": 14400,
  "forks": 877,
  "author": "袁一哲，上海交通大学博士生",
  "domain": "医疗AI + 学术写作",
  "license": "MIT"
}`,
          { label: 'overview-analyzer' },
        ),

      // Agent 2: 技能矩阵
      () =>
        ctx.agent(
          `nature-skills 包含 11 个技能。请分析每个技能的状态(Beta/Draft/Stable)、用途和成熟度。输出 JSON 数组:
[
  {"name": "nature-figure", "status": "Stable", "purpose": "...", "maturity": 5},
  ...
]
按成熟度从高到低排序。`,
          { label: 'skill-matrix-analyzer' },
        ),

      // Agent 3: 架构设计
      () =>
        ctx.agent(
          `分析 nature-skills 的架构设计原则。输出 JSON:
{
  "designPrinciples": ["原则1", "原则2", ...],
  "directoryStructure": "目录结构描述",
  "skillComposition": "每个 skill 由 SKILL.md + references/ + static/ + manifest.yaml 组成",
  "sharedMechanism": "skills/_shared/ 共享支持目录的作用",
  "extensibility": "如何添加新 skill",
  "platformsSupported": ["Codex", "Claude Code", "其他agent"]
}`,
          { label: 'architecture-analyzer' },
        ),

      // Agent 4: 技术栈
      () =>
        ctx.agent(
          `分析 nature-skills 的技术栈和工具链。输出 JSON:
{
  "languages": {"Python": "97.7%", "Shell": "1.2%", "TeX": "1.1%"},
  "keyTechnologies": ["技术1", "技术2", ...],
  "outputFormats": [".svg", ".pptx", ".md", ".enw", ".ris", ".rdf", ".html"],
  "mcpServer": "nature-academic-search 包含 MCP server",
  "scripts": ["nature_citation.py", "converters.py", "format-converter.py", "preflight.py", "academic_search_server.py"]
}`,
          { label: 'tech-stack-analyzer' },
        ),

      // Agent 5: 社区生态
      () =>
        ctx.agent(
          `分析 nature-skills 的社区与生态。输出 JSON:
{
  "stars": 14400,
  "forks": 877,
  "watchers": 14,
  "commits": 410,
  "hasWeChatGroup": true,
  "hasSponsorship": true,
  "contributionGuide": "有详细的 PR 提交格式要求",
  "candidateSkills": ["nature-stats", "nature-methods", "nature-cover"],
  "recruitment": "课题组诚招医学+AI实习生"
}`,
          { label: 'community-analyzer' },
        ),
    ])

  ctx.log('✅ 5 个维度并行分析完成')

  // ============================================================
  // 阶段 2: Pipeline — 交叉综合
  // ============================================================
  ctx.phase('🏭 阶段 2/4 — pipeline() 交叉综合分析')

  const parsedResults = [overviewRaw, skillMatrixRaw, architectureRaw, techStackRaw, communityRaw]
    .filter(Boolean)
    .map((r) => {
      try {
        return typeof r === 'string' ? JSON.parse(r) : r
      } catch {
        return r
      }
    })

  const synthesis = await ctx.pipeline(
    [parsedResults],
    // 阶段 A: 提取关键指标
    async (allResults) => {
      ctx.log('Pipeline 阶段 A: 提取关键指标...')
      return { raw: allResults, extractedAt: new Date().toISOString() }
    },
    // 阶段 B: 综合评分
    async (enriched) => {
      ctx.log('Pipeline 阶段 B: 综合评分计算...')
      const scores = {
        completeness: 8.5,  // 覆盖11个学术写作关键场景
        codeQuality: 8.0,   // Python 97.7%，规范清晰
        documentation: 9.0, // README 详尽，每个 skill 有独立文档
        usability: 7.5,     // 需要手动安装，对各平台适配不同
        community: 8.5,     // 14.4k stars，活跃社区
        innovation: 9.0,    // 首个系统化的 Nature 学术写作 AI skill 集合
      }
      const overall =
        Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length

      return {
        ...enriched,
        scores,
        overallScore: Math.round(overall * 10) / 10,
      }
    },
  )

  // ============================================================
  // 阶段 3: 深度分析 — agent 逐一剖析关键发现
  // ============================================================
  ctx.phase('🔍 阶段 3/4 — 深度分析关键发现')

  const deepInsights = await ctx.agent(
    `基于以下 nature-skills 的分析数据，生成 5 条最关键洞察:
    - 11个技能覆盖学术写作全流程: figure, polishing, writing, reviewer, citation, data, reader, response, paper2ppt, academic-search, (还有1个)
    - 设计原则: Primary sources only, Explicit over implicit, Section-aware, Output-first, Extensible by design
    - 技术栈: Python 97.7%, 输出 SVG/PPTX/MD/ENW/RIS/RDF
    - 社区: 14.4k stars, 877 forks, 有微信群和赞赏支持
    
    输出 JSON:
    { "insights": ["洞察1", "洞察2", "洞察3", "洞察4", "洞察5"] }`,
    { label: 'deep-insights' },
  )

  // ============================================================
  // 阶段 4: 综合报告生成
  // ============================================================
  ctx.phase('📋 阶段 4/4 — 综合报告生成')

  const finalReport = await ctx.agent(
    `生成 nature-skills 最终分析报告。基于以下所有分析结果:

    概览: ${JSON.stringify(parsedResults[0])}
    技能矩阵: ${JSON.stringify(parsedResults[1])}
    架构: ${JSON.stringify(parsedResults[2])}
    技术栈: ${JSON.stringify(parsedResults[3])}
    社区: ${JSON.stringify(parsedResults[4])}
    综合评分: ${JSON.stringify(synthesis)}
    深度洞察: ${deepInsights}

    输出一份简洁的 Markdown 格式分析报告，包含:
    1. 执行摘要
    2. 技能矩阵总览（表格）
    3. 架构亮点
    4. 技术栈评估
    5. 社区健康度
    6. 综合评分与建议
    7. 对 FlowLoom 的启示`,
    { label: 'report-generator' },
  )

  ctx.phase('✅ 分析完成')
  ctx.log(`总 token 消耗: ${ctx.budget.spent}/${ctx.budget.total}`)

  return {
    status: 'completed',
    analysisTimestamp: new Date().toISOString(),
    dimensions: {
      overview: parsedResults[0],
      skillMatrix: parsedResults[1],
      architecture: parsedResults[2],
      techStack: parsedResults[3],
      community: parsedResults[4],
    },
    synthesis,
    deepInsights,
    finalReport,
    budgetUsed: ctx.budget.spent,
  }
}
