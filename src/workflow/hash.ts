import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const pairs = keys
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    return '{' + pairs.join(',') + '}'
  }
  return JSON.stringify(value)
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
