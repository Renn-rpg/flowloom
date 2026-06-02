// /refactor 工作流：explore → plan → execute → verify 四阶段重构

export const meta = {
  name: 'refactor',
  description: 'Guided refactoring — understand, plan, execute, and verify',
  schemaVersion: 1,
}

export async function run(ctx) {
  const task = ctx.args?.task ?? 'refactor the codebase'

  ctx.phase('Explore')
  ctx.log('Understanding current structure...')
  const exploreResult = await ctx.agent(
    `Understand the codebase structure related to: ${task}. Use glob to find files, grep to find patterns, and read_file to study key modules. Produce a summary of current architecture and key interfaces.`,
    { label: 'explore' }
  )

  ctx.phase('Plan')
  ctx.log('Designing refactoring plan...')
  const planResult = await ctx.agent(
    `Based on this understanding:\n${String(exploreResult).slice(0, 2000)}\n\nDesign a refactoring plan for: ${task}. Include: phases, files to modify, risks, verification steps.`,
    { label: 'plan' }
  )

  ctx.phase('Execute')
  ctx.log('Executing refactoring...')
  const execResult = await ctx.agent(
    `Execute the following refactoring plan. Make the changes using edit_file and write_file:\n${String(planResult).slice(0, 2000)}\n\nApply changes one file at a time, verifying each step.`,
    { label: 'execute' }
  )

  ctx.phase('Verify')
  ctx.log('Verifying results...')
  const verifyResult = await ctx.agent(
    `Verify that the refactoring was successful:
    1. Check that no functionality was broken
    2. Run tests if possible (use run_shell)
    3. Verify the code structure matches the plan
    4. Report any issues found`,
    { label: 'verify' }
  )

  return {
    phases: ['explore', 'plan', 'execute', 'verify'],
    results: {
      explore: String(exploreResult).slice(0, 1000),
      plan: String(planResult).slice(0, 1000),
      execute: String(execResult).slice(0, 500),
      verify: String(verifyResult).slice(0, 500),
    },
  }
}
