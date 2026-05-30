export const meta = { name: 'hello', description: 'Simple workflow example', schemaVersion: 1 }

export async function run(ctx) {
  ctx.phase('Greeting')
  ctx.log('Starting hello workflow...')

  const result = await ctx.agent('Say "Hello from FlowLoom workflow!" in one short sentence.')

  ctx.log(`Done! Budget used: ${ctx.budget.spent}/${ctx.budget.total}`)

  return result
}
