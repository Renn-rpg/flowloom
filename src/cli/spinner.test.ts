import { describe, it, expect } from 'vitest'
import { toolIcon } from './spinner.js'

describe('toolIcon', () => {
  it('returns read icon for read_file', () => {
    expect(toolIcon('read_file')).toBe('📖')
  })
  it('returns write icon for write_file', () => {
    expect(toolIcon('write_file')).toBe('✏️')
  })
  it('returns edit icon for edit_file', () => {
    expect(toolIcon('edit_file')).toBe('🔧')
  })
  it('returns shell icon for run_shell', () => {
    expect(toolIcon('run_shell')).toBe('⚡')
  })
  it('returns default icon for unknown tools', () => {
    expect(toolIcon('some_new_tool')).toBe('🔨')
  })
})
