import { describe, it, expect } from 'vitest'
import { DialogManager } from './manager.js'
import { createContextManager } from '../keybindings/context.js'

function makeManager(cols = 80, rows = 24): DialogManager {
  return new DialogManager({ columns: cols, rows, contextManager: createContextManager() })
}

describe('DialogManager', () => {
  describe('renderSelect', () => {
    it('renders a select dialog with title and options', () => {
      const m = makeManager()
      const lines = m.renderSelect({
        kind: 'select',
        title: 'Pick one',
        options: [
          { value: 'a', label: 'Option A' },
          { value: 'b', label: 'Option B' },
        ],
      }, 0)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some(l => l.includes('Pick one'))).toBe(true)
      expect(lines.some(l => l.includes('Option A'))).toBe(true)
      expect(lines.some(l => l.includes('Option B'))).toBe(true)
    })

    it('renders the selected option with highlight', () => {
      const m = makeManager()
      const lines = m.renderSelect({
        kind: 'select',
        title: 'Pick',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      }, 1)
      // 选中项应有 ❯ 前缀
      expect(lines.some(l => l.includes('❯') && l.includes('B'))).toBe(true)
      // 未选中项不应有 ❯
      expect(lines.some(l => l.includes('❯') && l.includes('A'))).toBe(false)
    })

    it('renders message when provided', () => {
      const m = makeManager()
      const lines = m.renderSelect({
        kind: 'select',
        title: 'Test',
        message: 'Choose wisely',
        options: [{ value: 'x', label: 'X' }],
      }, 0)
      expect(lines.some(l => l.includes('wisely'))).toBe(true)
    })

    it('shows scroll indicator when options exceed maxVisible', () => {
      const m = makeManager(40, 24)
      const opts = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `Item ${i}` }))
      const lines = m.renderSelect({
        kind: 'select',
        title: 'Many',
        options: opts,
        maxVisible: 5,
      }, 0)
      expect(lines.some(l => l.includes('1-5') || l.includes('/ 20'))).toBe(true)
    })
  })

  describe('renderConfirm', () => {
    it('renders a confirm dialog with yes/no', () => {
      const m = makeManager()
      const lines = m.renderConfirm({
        kind: 'confirm',
        title: 'Are you sure?',
        message: 'This cannot be undone.',
      }, false)
      expect(lines.some(l => l.includes('Are you sure'))).toBe(true)
      expect(lines.some(l => l.includes('Yes'))).toBe(true)
      expect(lines.some(l => l.includes('No'))).toBe(true)
    })

    it('highlights confirm when focusConfirm is true', () => {
      const m = makeManager()
      const lines = m.renderConfirm({
        kind: 'confirm',
        title: 'Confirm?',
        message: 'Proceed?',
      }, true)
      // confirm 按钮应有高亮
      expect(lines.some(l => l.includes('[Yes]'))).toBe(true)
    })
  })

  describe('updateSize', () => {
    it('updates dimensions without error', () => {
      const m = makeManager()
      m.updateSize(120, 40)
      // 不应抛异常
    })
  })
})
