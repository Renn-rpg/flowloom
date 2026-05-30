export const meta = { name: 'code-audit', description: 'Audit code for common issues', schemaVersion: 1 }

export async function run(ctx) {
  ctx.phase('Discovery')
  ctx.log('Scanning project structure...')

  const files = await ctx.agent(
    'List ALL source TypeScript files in src/workflow/ directory. Output one file path per line.'
  )

  ctx.phase('Audit')
  ctx.log(`Found files to audit. Starting parallel review...`)

  const fileList = typeof files === 'string'
    ? files.split('\n').filter(Boolean).slice(0, 3)
    : []

  const results = await ctx.parallel(
    fileList.map(f => () =>
      ctx.agent(`Check ${f} for: 1) missing error handling 2) potential null dereference 3) missing .js extension in imports. Reply in one sentence.`)
    )
  )

  ctx.log(`Audit complete. ${results.filter(Boolean).length}/${fileList.length} files reviewed.`)
  return { filesReviewed: fileList.length, results: results.filter(Boolean) }
}
