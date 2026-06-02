import { cpus } from 'node:os'

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2))
}

export class Semaphore {
  private running = 0
  private queue: Array<() => void> = []

  constructor(private max: number = defaultConcurrency()) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++
      let released = false
      return () => {
        if (released) return
        released = true
        this.running--
        this.dequeue()
      }
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.running--
          this.dequeue()
        })
      })
    })
  }

  private dequeue(): void {
    this.queue.shift()?.()
  }
}
