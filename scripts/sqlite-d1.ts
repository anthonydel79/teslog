/** A tiny D1-compatible wrapper over node:sqlite, for tests and the demo seeder. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }
  async all() { return { results: this.db.prepare(this.sql).all(...(this.args as any[])) }; }
  async first() { return (this.db.prepare(this.sql).get(...(this.args as any[])) as any) ?? null; }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as any[]));
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  }
}

export class SqliteD1 {
  db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    const schema = fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url).href);
    this.db.exec(readFileSync(schema, "utf8"));
  }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) { return Promise.all(stmts.map((s) => s.run())); }
  /** Cast for code typed against Cloudflare's D1Database. */
  asD1() { return this as unknown as D1Database; }
}
