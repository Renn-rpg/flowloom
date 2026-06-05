import { describe, it, expect } from 'vitest'
import { DEFAULTS } from './defaults.js'

describe('DEFAULTS', () => {
  it('has bindings for all current actions', () => {
    const actions = new Set(DEFAULTS.map(b => b.action))
    // 验证关键动作存在
    const required = [
      'interrupt', 'exit-eof', 'submit', 'newline', 'expand-one', 'expand-all',
      'history-prev', 'history-next', 'cycle-mode',
      'complete-accept', 'complete-prev', 'complete-next', 'complete-dismiss',
      'select-prev', 'select-next', 'select-confirm', 'select-cancel',
      'wf-prev', 'wf-next', 'wf-stop', 'wf-pause', 'wf-save', 'wf-exit',
      'modal-dismiss', 'modal-confirm', 'modal-next', 'modal-prev',
      'help-dismiss',
    ]
    for (const a of required) {
      expect(actions.has(a)).toBe(true)
    }
  })

  it('every binding has a non-empty action and context', () => {
    for (const b of DEFAULTS) {
      expect(b.action.length).toBeGreaterThan(0)
      expect(b.context.length).toBeGreaterThan(0)
      expect(b.key.length).toBeGreaterThan(0)
    }
  })

  it('reserved keys cannot be unbound in global', () => {
    const globalBindings = DEFAULTS.filter(b => b.context === 'global')
    const reservedKeys = globalBindings.map(b => b.key)
    expect(reservedKeys).toContain('ctrl+c')
    expect(reservedKeys).toContain('ctrl+d')
  })
})
