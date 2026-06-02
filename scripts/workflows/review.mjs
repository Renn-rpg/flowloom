// /review 工作流：代码审查（聚焦 diff）

export const meta = {
  name: 'review',
  description: 'Code review — checks recent changes for correctness and quality',
  schemaVersion: 1,
}

export async function run(ctx) {
  ctx.phase('Gather')
  ctx.log('Getting recent changes...')
  const diffResult = await ctx.agent(
    'Run "git diff" to see all uncommitted changes. If no changes, list recently modified files instead.',
    { label: 'gather-diff' }
  )
  ctx.log('Changes gathered.')

  ctx.log('Searching for related patterns...')
  const patternResult = await ctx.agent(
    'Based on the diff output, identify which parts of the codebase are affected. Use grep to find related patterns and glob to find related files.',
    { label: 'find-patterns' }
  )

  ctx.phase('Review')
  ctx.log('Running parallel review dimensions...')
  const results = await ctx.parallel([
    () => ctx.agent(
      'Review the changes for CORRECTNESS BUGS: logic errors, race conditions, null/undefined access, type safety issues, edge cases, error handling gaps. Be thorough — cite file+line.',
      { label: 'correctness' }
    ),
    () => ctx.agent(
      'Review the changes for CODE QUALITY: dead code, duplication, over-complexity, naming, missing tests. Cite file+line for each finding.',
      { label: 'quality' }
    ),
    () => ctx.agent(
      'Review the changes for SECURITY: injection vulnerabilities, path traversal, secrets exposure, improper validation. If safe, say so explicitly.',
      { label: 'security' }
    ),
  ])

  ctx.phase('Report')
  const parts = ['correctness', 'quality', 'security']
  const report = parts.map((p, i) => `## ${p}\n${String(results[i] ?? '(no findings)')}\n`).join('\n')

  ctx.log('Review complete.')
  return { status: 'done', report }
}
