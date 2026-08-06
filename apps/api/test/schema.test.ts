import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { PUBLIC_ISSUE_COLUMNS } from "../src/routes/issues";
import { applyMigrations } from "./helpers/migrate";

/**
 * テスト DB が実マイグレーション（`migrations/*.sql`）そのものであることを固定する。
 *
 * 以前はテストが手書きの `CREATE TABLE` 文字列でスキーマを再現しており、
 * `migrations/` を足してもテストは古いスキーマのまま緑で通り続けていた。
 * ここは「テスト DB のスキーマが本番と別物になっていないか」を見る唯一の場所なので、
 * 手書き定数へ戻す変更があれば必ずここが落ちる。
 */
describe("Test database schema", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	/** `issues` テーブルのカラム名を宣言順に返す。 */
	async function issueColumns(): Promise<string[]> {
		const { results } = await env.DB.prepare("PRAGMA table_info(issues)").all<{
			name: string;
		}>();
		return results.map((row) => row.name);
	}

	// マイグレーションの適用そのものが検証されていること。
	// SQL の構文エラーや適用順序の誤りは、ここで初めて実行されて露見する。
	//
	// 並び順は `d1_migrations.id`（適用順の AUTOINCREMENT）で取る。
	// `ORDER BY name` にすると辞書順になり、`readD1Migrations` が使う
	// 「先頭の数値」順とは `9_` と `10_` のようなゼロ埋め漏れでずれる。
	it("records every migration file as applied", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM d1_migrations ORDER BY id",
		).all<{ name: string }>();

		expect(results.map((row) => row.name)).toEqual(
			env.TEST_MIGRATIONS.map((migration) => migration.name),
		);
		// 空配列同士でも一致してしまうため、実ファイルを読めていることも押さえる。
		expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0);
	});

	// `0002_add_user_id.sql` の ALTER TABLE が実際に適用されたことの確認も兼ねる。
	// user_id が末尾に来るのは ALTER TABLE で後から足したためで、
	// 手書き定数（category と created_at の間に置いていた）とは並びが異なる。
	it("has the columns the migrations define, in migration order", async () => {
		expect(await issueColumns()).toEqual([
			"id",
			"title",
			"description",
			"scope",
			"status",
			"latitude",
			"longitude",
			"category",
			"created_at",
			"updated_at",
			"user_id",
		]);
	});

	// 手書き定数はインデックスを一本も作っていなかった。
	// 実マイグレーションに乗せ替えた効果が最も分かりやすく出る箇所。
	//
	// 期待値はあえてここにベタ書きする。マイグレーションの SQL から導出すると
	// 両辺が同じ源から来るため、インデックスを削除する変更に対して期待値も
	// 一緒に消え、常に一致して検出力がゼロになる（実際に変異体で確認した）。
	// インデックスを増減させたらこの一覧も手で更新すること。
	it("has every index the migrations define", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'issues' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		).all<{ name: string }>();

		expect(results.map((row) => row.name)).toEqual([
			// 0003_add_created_at_index.sql — 一覧の並び順とカーソルページング用
			"idx_issues_created_at",
			"idx_issues_location",
			"idx_issues_scope",
			"idx_issues_status",
			"idx_issues_user_id",
			// 0004_add_user_id_created_at_index.sql — 自分の Issue 一覧の並び順用
			"idx_issues_user_id_created_at",
		]);
	});

	// 公開カラムの許可リストと実スキーマの対応を固定する。
	//
	// #8（公開 GET からの Clerk User ID 露出）の再発防止は
	// `issues.test.ts` の「内部カラムを公開しない」テストが担うが、
	// あちらはテスト内で `ALTER TABLE` したカラムしか見ていない。
	// マイグレーションで足したカラムが素通りしないよう、
	// 実スキーマ側から「許可リストのどちらにも無いカラム」を見張る。
	//
	// このテストが保証するのは「カラムを足したら公開可否を書かされる」ところまでで、
	// どちら側に書くかが妥当かまでは機械的に判定できない（`PUBLIC_ISSUE_COLUMNS`
	// 側に入れれば緑になる）。狙いは、公開判断が必ず diff に現れてレビューに乗ること。
	it("classifies every column as either public or explicitly internal", async () => {
		/** 公開してはいけないカラム。追加したら意図的にここへ足す。 */
		const INTERNAL_COLUMNS = ["user_id"];

		expect(await issueColumns()).toEqual(
			expect.arrayContaining([...PUBLIC_ISSUE_COLUMNS]),
		);
		expect([...(await issueColumns())].sort()).toEqual(
			[...PUBLIC_ISSUE_COLUMNS, ...INTERNAL_COLUMNS].sort(),
		);
	});

	// CHECK 制約が生きていること。手書き定数と実マイグレーションで
	// 制約の中身がずれても、値を弾く挙動が変わらなければ気づけない。
	it("enforces the scope CHECK constraint from the migration", async () => {
		await expect(
			env.DB.prepare(
				"INSERT INTO issues (title, description, scope, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
			)
				.bind("t", "d", "bogus-scope", 0, 0)
				.run(),
		).rejects.toThrow(/CHECK constraint failed/);
	});
});
