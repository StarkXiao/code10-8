#!/usr/bin/env node
/**
 * 数据库初始化（幂等，可反复执行）：
 *   1) prisma generate —— 生成 Client
 *   2) prisma migrate diff —— 由 schema 生成建表 SQL，并落到 prisma/migrations/0001_init/migration.sql
 *   3) 用 Prisma Client 把这份 SQL 应用到 SQLite（仅在还没有表时执行）
 *
 * 为什么不直接用 `prisma db push`：
 *   当前环境（macOS + Node 24）下 Prisma 的 schema engine 子进程在建库这一步会被系统策略拦截，
 *   只报 "Schema engine error"、没有任何细节，且只在部分目录下复现。
 *   换成"生成 SQL + 用 Query Engine 执行"，行为确定、可复现，还顺手留下了一份可读的表结构快照。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');
const schema = resolve(serverRoot, 'prisma/schema.prisma');

process.env.DATABASE_URL ??= `file:${resolve(serverRoot, 'data/app.db')}`;
const migrationsDir = resolve(serverRoot, 'prisma/migrations/0001_init');

// SQLite 文件所在目录必须先存在
for (const dir of [resolve(serverRoot, 'data'), migrationsDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function prismaCli(args, options = {}) {
  const { capture = false, withSchema = true } = options;
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    withSchema ? ['prisma', ...args, '--schema', schema] : ['prisma', ...args],
    { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', cwd: repoRoot, env: process.env },
  );
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

console.log('[migrate] 1/3 prisma generate');
const generate = prismaCli(['generate']);
if (generate.status !== 0) process.exit(generate.status);

console.log('[migrate] 2/3 生成建表 SQL 快照');
// migrate diff 不接受 --schema，只接受 --to-schema-datamodel
const diff = prismaCli(['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'], {
  capture: true,
  withSchema: false,
});
if (diff.status !== 0 || !diff.stdout.trim()) {
  console.error('[migrate] 生成 SQL 失败：', diff.stderr.slice(0, 2000));
  process.exit(1);
}
const sql = diff.stdout;
writeFileSync(resolve(migrationsDir, 'migration.sql'), sql);
console.log(`[migrate] SQL 已写入 prisma/migrations/0001_init/migration.sql（${sql.split('\n').length} 行）`);

console.log('[migrate] 3/3 应用表结构');
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
try {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'",
  );
  if (Array.isArray(tables) && tables.length > 0) {
    console.log(`[migrate] 数据库已有 ${tables.length} 张表，跳过全量建表`);
  } else {
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
    console.log(`[migrate] 已执行 ${statements.length} 条建表语句`);
  }
  await applyIncrementalPatches(prisma);
  const finalTables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name",
  );
  console.log(`[migrate] 当前表：${(finalTables ?? []).map((t) => t.name).join(', ')}`);
} finally {
  await prisma.$disconnect();
}
console.log('[migrate] done');

/**
 * 增量补丁：老库平滑升级用，每条都必须幂等。
 * 新库由上面的全量建表 SQL 直接建好，这里的语句会全部跳过。
 * 顺序：先加列，再建表，最后建索引/外键。
 */
async function applyIncrementalPatches(prisma) {
  const columns = async (table) => {
    const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
    return new Set((rows ?? []).map((r) => r.name));
  };
  const hasTable = async (name) => {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      name,
    );
    return Array.isArray(rows) && rows.length > 0;
  };
  const hasIndex = async (name) => {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
      name,
    );
    return Array.isArray(rows) && rows.length > 0;
  };
  const run = async (statement) => {
    await prisma.$executeRawUnsafe(statement);
    console.log(`[migrate] 补丁已执行：${statement.slice(0, 80).replace(/\s+/g, ' ')}…`);
  };

  // 0002：只读分享升级为限时协作
  const shareCols = await columns('share_links');
  if (!shareCols.has('mode')) {
    await run('ALTER TABLE "share_links" ADD COLUMN "mode" TEXT NOT NULL DEFAULT \'view\'');
  }
  if (!(await hasTable('repair_submissions'))) {
    await run(`CREATE TABLE "repair_submissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "share_link_id" TEXT NOT NULL,
    "wardrobe_id" TEXT NOT NULL,
    "garment_id" TEXT NOT NULL,
    "damage_event_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "collaborator" TEXT NOT NULL,
    "contact" TEXT,
    "payload" JSONB NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "submitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" TEXT,
    "reviewed_at" DATETIME,
    "review_note" TEXT,
    "repair_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "repair_submissions_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repair_submissions_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "wardrobes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
  }
  if (!(await hasIndex('repair_submissions_wardrobe_id_status_idx'))) {
    await run('CREATE INDEX "repair_submissions_wardrobe_id_status_idx" ON "repair_submissions"("wardrobe_id", "status")');
  }
  if (!(await hasIndex('repair_submissions_share_link_id_idx'))) {
    await run('CREATE INDEX "repair_submissions_share_link_id_idx" ON "repair_submissions"("share_link_id")');
  }
}

/** 把 Prisma 生成的 SQL 拆成可单独执行的语句（去掉注释与事务包裹） */
function splitStatements(script) {
  const withoutComments = script
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !/^(BEGIN|COMMIT|PRAGMA\s+foreign_keys)/iu.test(chunk))
    .map((chunk) => `${chunk};`);
}
