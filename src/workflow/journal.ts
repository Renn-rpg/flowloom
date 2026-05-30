import { createRequire } from 'node:module'
import type { Journal, RunRecord, CallRecord } from './types.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

export class SqliteJournal implements Journal {
  private db: InstanceType<typeof DatabaseSync>

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        script_hash TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_hit_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS agent_calls (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        call_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_hash
        ON runs(script_hash, args_hash, schema_version);
    `)
  }

  openRun(run: RunRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO runs(
        run_id, script_hash, args_hash, schema_version, status,
        started_at, total_input_tokens, total_output_tokens, total_cache_hit_tokens
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    stmt.run(
      run.runId, run.scriptHash, run.argsHash, run.schemaVersion, run.status,
      run.startedAt, run.totalInputTokens, run.totalOutputTokens, run.totalCacheHitTokens,
    )
  }

  recordCall(call: CallRecord): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO agent_calls(
        run_id, seq, call_hash, status, result,
        input_tokens, output_tokens, cache_hit_tokens, completed_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    stmt.run(
      call.runId, call.seq, call.callHash, call.status, call.result,
      call.inputTokens, call.outputTokens, call.cacheHitTokens,
      call.completedAt ?? null,
    )
  }

  lookupPrefix(
    scriptHash: string,
    argsHash: string,
    schemaVersion: number,
  ): { run: RunRecord; calls: CallRecord[] } | null {
    const s = this.db.prepare(
      `SELECT * FROM runs
       WHERE script_hash=? AND args_hash=? AND schema_version=? AND status=?
       ORDER BY started_at DESC LIMIT 1`,
    )
    const row = s.get(scriptHash, argsHash, schemaVersion, 'done') as any
    if (!row) return null

    const calls = this.db
      .prepare('SELECT * FROM agent_calls WHERE run_id=? ORDER BY seq')
      .all(row.run_id) as any[]

    return {
      run: {
        runId: row.run_id,
        scriptHash: row.script_hash,
        argsHash: row.args_hash,
        schemaVersion: row.schema_version,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        totalInputTokens: row.total_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        totalCacheHitTokens: row.total_cache_hit_tokens,
      },
      calls: calls.map((c: any) => ({
        runId: c.run_id,
        seq: c.seq,
        callHash: c.call_hash,
        status: c.status,
        result: c.result,
        inputTokens: c.input_tokens,
        outputTokens: c.output_tokens,
        cacheHitTokens: c.cache_hit_tokens,
        completedAt: c.completed_at,
      })),
    }
  }

  closeRun(runId: string, status: 'done' | 'failed'): void {
    this.db
      .prepare('UPDATE runs SET status=?, finished_at=? WHERE run_id=?')
      .run(status, new Date().toISOString(), runId)
  }

  close(): void {
    this.db.close()
  }
}
