/**
 * Minimal SQL statement splitter for SQLite migration files.
 *
 * Handles: single/double/backtick quoted strings (incl. `''` escapes),
 * `--` line comments, `/* ... *\/` block comments. Semicolons inside strings
 * or comments do not split. Skips comment-only statements.
 *
 * Trigger-aware: `CREATE TRIGGER ... BEGIN ...; ... END;` bodies contain
 * semicolons that must not split. The splitter tracks the outermost
 * BEGIN/END depth after a CREATE TRIGGER header and only splits on the
 * terminating semicolon after the final END.
 */

declare const __INTEGRATION_MIGRATIONS__: Record<string, string>;

function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;
  // CREATE TRIGGER body tracking (see header comment). Keywords are scanned
  // outside strings/comments only, matched as whole words case-insensitively.
  let inTrigger = false;
  let triggerDepth = 0;
  let word = '';
  const recentKeywords: string[] = [];
  const flushWord = (): void => {
    if (word.length === 0) return;
    const upper = word.toUpperCase();
    word = '';
    recentKeywords.push(upper);
    if (recentKeywords.length > 6) recentKeywords.shift();
    // `CREATE [TEMP|TEMPORARY] TRIGGER` opens a body; a table merely named
    // "trigger" (`CREATE TABLE trigger`) must not. The word before TRIGGER
    // disambiguates.
    if (upper === 'TRIGGER' && ['CREATE', 'TEMP', 'TEMPORARY'].includes(recentKeywords.at(-2) ?? '')) {
      inTrigger = true;
      triggerDepth = 0;
    } else if (inTrigger && upper === 'BEGIN') {
      triggerDepth += 1;
    } else if (inTrigger && upper === 'END') {
      triggerDepth -= 1;
      if (triggerDepth <= 0) {
        inTrigger = false;
        triggerDepth = 0;
      }
    }
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    const next = sql[i + 1] ?? '';
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === stringChar) {
        // SQL escapes a quote by doubling it ('it''s'); do not end the string.
        if (sql[i + 1] === stringChar) {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i - 1] !== '\\') inString = false;
      }
      i++;
      continue;
    }
    // Buffer word characters for CREATE TRIGGER / BEGIN / END tracking.
    // Any other character ends the current word.
    if (/[\w$]/.test(ch)) {
      word += ch;
      current += ch;
      i++;
      continue;
    }
    flushWord();
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      i++;
      continue;
    }
    if (["'", '"', '`'].includes(ch)) {
      inString = true;
      stringChar = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === ';') {
      // Semicolons inside a trigger body do not terminate the statement.
      if (inTrigger) {
        current += ch;
        i++;
        continue;
      }
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);
  return statements;
}

/**
Executable statements for one migration file, comments stripped.
*/
function statementsFor(file: string): string[] {
  return splitSql(__INTEGRATION_MIGRATIONS__[file] ?? '').filter(
    (stmt) =>
      stmt
        .replaceAll(/--[^\n]*/g, '')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .trim().length > 0,
  );
}

async function runStatements(db: D1Database, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

// The D1 test database is shared across the tests in a file, and migrations
// are not re-runnable (`ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS`).
// Track what has been applied so a second call is a no-op instead of an error.
const applied = new Set<string>();

async function applyFile(db: D1Database, file: string): Promise<void> {
  if (applied.has(file)) return;
  await runStatements(db, statementsFor(file));
  applied.add(file);
}

/**
Migration filenames in lexical (apply) order.
*/
export function migrationFiles(): string[] {
  return Object.keys(__INTEGRATION_MIGRATIONS__).sort();
}

/**
Forget which migrations have run (test-isolation helper).
*/
export function resetAppliedMigrations(): void {
  applied.clear();
}

/**
 * Apply every migration.
 *
 * D1 wraps a whole migration file in one implicit transaction, so each file is
 * applied statement-by-statement here to match that granularity closely enough
 * for assertion purposes. See `applyMigrationsUpTo` for partial application.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const file of migrationFiles()) {
    await applyFile(db, file);
  }
}

/**
 * Apply migrations up to and including `lastFile`, so a test can seed rows in
 * the schema state that a later migration must not destroy.
 */
export async function applyMigrationsUpTo(db: D1Database, lastFile: string): Promise<void> {
  const all = migrationFiles();
  const cut = all.indexOf(lastFile);
  if (cut === -1) throw new Error(`Unknown migration file: ${lastFile}`);
  const upto = all.slice(0, cut + 1);
  for (const file of upto) {
    await applyFile(db, file);
  }
}

/**
Apply the migrations that follow `afterFile`.
*/
export async function applyMigrationsAfter(db: D1Database, afterFile: string): Promise<void> {
  const all = migrationFiles();
  const cut = all.indexOf(afterFile);
  if (cut === -1) throw new Error(`Unknown migration file: ${afterFile}`);
  const after = all.slice(cut + 1);
  for (const file of after) {
    await applyFile(db, file);
  }
}

export { splitSql, statementsFor };
