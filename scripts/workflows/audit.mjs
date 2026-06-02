// /audit 工作流：安全审查 + 代码质量审查

export const meta = {
  name: 'audit',
  description: 'Security + quality audit — reviews all source files for vulnerabilities and bugs',
  schemaVersion: 1,
}

export async function run(ctx) {
  ctx.phase('Discovery')
  ctx.log('Scanning project structure...')
  const files = await ctx.agent(
    'List all TypeScript source files in src/ (exclude *.test.ts and node_modules). Return one file path per line.',
    { label: 'discover-files' }
  )

  const fileList = String(files ?? '').split('\n').filter(Boolean).slice(0, 10)
  ctx.log(`Found ${fileList.length} files to audit.`)

  ctx.phase('Audit')
  const results = await ctx.parallel(
    fileList.map(f => () =>
      ctx.agent(
        `Audit ${f} for:
        1. Security issues: injection, path traversal, auth bypass, secrets leak
        2. Correctness bugs: logic errors, race conditions, type safety
        3. Robustness: error handling, resource cleanup, timeout handling
        For each finding, cite the file and line. Rate severity: critical/high/medium/low.`,
        { label: `audit:${f}` }
      )
    )
  )

  ctx.phase('Report')
  const findings = results.filter(Boolean)
  const summary = findings.map((r, i) => `### ${fileList[i]}\n${String(r)}`).join('\n\n---\n\n')

  ctx.log(`Audit complete: ${findings.length}/${fileList.length} files reviewed.`)
  return { filesReviewed: findings.length, report: summary }
}
