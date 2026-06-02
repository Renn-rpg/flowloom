// /onboard 工作流：新项目上手 — 生成 CLAUDE.md + 项目总结

export const meta = {
  name: 'onboard',
  description: 'Project onboarding — generates CLAUDE.md and a project summary',
  schemaVersion: 1,
}

export async function run(ctx) {
  ctx.phase('Map')
  ctx.log('Mapping project structure...')
  const structure = await ctx.agent(
    'Explore this project thoroughly. Use glob to find all source files, read package.json and config files, understand the directory structure. Return: 1. Project type and tech stack, 2. Directory layout, 3. Key dependencies.',
    { label: 'map-structure' }
  )

  ctx.phase('Understand')
  ctx.log('Reading key modules...')
  const keyFiles = await ctx.agent(
    'Based on the project structure, identify the 5-10 most important source files that define the architecture. Read each one and summarize its role, key exports, and dependencies.',
    { label: 'read-key-files' }
  )

  ctx.phase('Generate')
  ctx.log('Generating CLAUDE.md...')
  const claudeMd = await ctx.agent(
    `Generate a CLAUDE.md file for this project. Follow the standard format:
    # Project Name
    Brief description.
    ## Commands (build, test, dev)
    ## Architecture (layers, key modules, data flow)
    ## Conventions (naming, imports, testing)

    Based on:
    ${String(structure).slice(0, 1500)}
    ${String(keyFiles).slice(0, 1500)}`,
    { label: 'write-claude.md' }
  )

  ctx.log('Onboarding complete. CLAUDE.md generated.')
  return { claudeMd: String(claudeMd) }
}
