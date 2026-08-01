import { applyD1Migrations, env } from "cloudflare:test";

/**
 * テスト用 D1 に `migrations/*.sql` を適用する。
 *
 * 以前は各テストファイルが手書きの `CREATE TABLE` 文字列でスキーマを再現していたが、
 * `migrations/` と同期する仕組みが無く、マイグレーションを足しても
 * テスト DB は古いスキーマのまま緑で通り続けていた（インデックス 4 本は
 * そもそも一度も作られていなかった）。
 *
 * ここを唯一の入口にして、テストが見るスキーマを実マイグレーションに一本化する。
 * 副次的に、マイグレーション SQL の構文と適用順序もテスト実行時に検証される。
 *
 * 適用済みのマイグレーションは `d1_migrations` テーブルで管理されるため、
 * 複数回呼んでも二重適用にはならない。
 */
export async function applyMigrations(): Promise<void> {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
