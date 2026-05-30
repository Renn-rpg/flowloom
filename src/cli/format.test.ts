import { describe, it, expect } from 'vitest'
import { fmt } from './format.js'

describe('fmt', () => {
  it('summary includes tools, tokens, time', () => {
    const s = fmt.summary(100, 3, 2500)
    expect(s).toContain('3')
    expect(s).toContain('100')
    expect(s).toContain('2.5s')
  })

  it('toolDone includes checkmark and name', () => {
    const s = fmt.toolDone('read_file', 300)
    expect(s).toContain('✓')
    expect(s).toContain('read_file')
    expect(s).toContain('0.3s')
  })

  it('toolError includes cross and name', () => {
    const s = fmt.toolError('run_shell', 1200)
    expect(s).toContain('✗')
    expect(s).toContain('run_shell')
    expect(s).toContain('1.2s')
  })

  it('thinking shows time', () => {
    const s = fmt.thinking(4700)
    expect(s).toContain('Thinking')
    expect(s).toContain('4.7s')
  })

  it('colors return non-empty strings', () => {
    expect(fmt.green('test').length).toBeGreaterThan(0)
    expect(fmt.red('test').length).toBeGreaterThan(0)
    expect(fmt.dim('test').length).toBeGreaterThan(0)
  })
})
