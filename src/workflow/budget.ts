export class BudgetExhaustedError extends Error {
  constructor(
    public readonly limit: number,
    public readonly spent: number,
  ) {
    super(`Budget exhausted: ${spent}/${limit} tokens used`)
    this.name = 'BudgetExhaustedError'
  }
}

export class BudgetTracker {
  constructor(
    public readonly total: number,
    public spent: number = 0,
  ) {}

  remaining(): number {
    return Math.max(0, this.total - this.spent)
  }

  charge(n: number): void {
    this.spent += n
    if (this.spent > this.total) {
      throw new BudgetExhaustedError(this.total, this.spent)
    }
  }

  assertHasBudget(estimate: number = 1): void {
    if (this.remaining() < estimate) {
      throw new BudgetExhaustedError(this.total, this.spent)
    }
  }
}
