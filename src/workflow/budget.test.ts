import { describe, it, expect } from 'vitest'
import { BudgetTracker, BudgetExhaustedError } from './budget.js'

describe('BudgetTracker', () => {
  it('starts with 0 spent', () => {
    const b = new BudgetTracker(1000)
    expect(b.spent).toBe(0)
    expect(b.total).toBe(1000)
    expect(b.remaining()).toBe(1000)
  })

  it('charge accumulates spent', () => {
    const b = new BudgetTracker(1000)
    b.charge(300)
    b.charge(200)
    expect(b.spent).toBe(500)
    expect(b.remaining()).toBe(500)
  })

  it('throws BudgetExhaustedError when charge exceeds total', () => {
    const b = new BudgetTracker(100)
    expect(() => b.charge(150)).toThrow(BudgetExhaustedError)
  })

  it('assertHasBudget passes when enough budget', () => {
    const b = new BudgetTracker(1000)
    expect(() => b.assertHasBudget(500)).not.toThrow()
    b.charge(600)
    expect(() => b.assertHasBudget(400)).not.toThrow()
  })

  it('assertHasBudget throws when insufficient', () => {
    const b = new BudgetTracker(100)
    b.charge(90)
    expect(() => b.assertHasBudget(20)).toThrow(BudgetExhaustedError)
    expect(b.spent).toBe(90) // 不改变 spent
  })

  it('BudgetExhaustedError contains limit and spent', () => {
    const b = new BudgetTracker(100)
    b.charge(80)
    try {
      b.assertHasBudget(50)
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhaustedError)
      expect((e as BudgetExhaustedError).message).toContain('100')
      expect((e as BudgetExhaustedError).message).toContain('80')
    }
  })
})
