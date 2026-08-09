import { env } from "cloudflare:test";
import {
	ISSUE_SCOPE_VALUES,
	ISSUE_STATUS_VALUES,
} from "@world-issue-tracker/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { PUBLIC_HELP_OFFER_COLUMNS } from "../src/routes/help-offers";
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
			// 0007_add_photo.sql — 写真の置き場（R2）へのキーと、その MIME
			"photo_key",
			"photo_content_type",
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
		const INTERNAL_COLUMNS = [
			"user_id",
			// 写真（#65）は R2 のキーも MIME もレスポンスに載せない。
			// キーを公開すると `GET /issues/:id/photo` を経由しない読み方が
			// 生まれ、将来の非公開化が効かない経路になる。画面が必要とする
			// 「写真があるか」は `has_photo` という派生フィールドで返す
			// （`src/routes/issues.ts` の `INTERNAL_PHOTO_COLUMNS`）。
			"photo_key",
			"photo_content_type",
		];

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

	/**
	 * `issues` テーブルの `CHECK (<column> IN ('a', 'b', ...))` から値の集合を取り出す。
	 *
	 * 読む先は SQL ファイルではなく `sqlite_master.sql`（＝マイグレーションを
	 * すべて適用した後に DB が実際に保持している定義）。ファイルを読むと、
	 * 後続のマイグレーションがテーブルを作り直して制約を変えた場合に
	 * 古い定義を見てしまう。
	 *
	 * 制約が見つからない場合は空配列ではなく null を返す。空集合（＝どの値も
	 * 通らない CHECK）と「CHECK が消された」は意味が違い、後者を
	 * 「たまたま一致しなかった」ではなく明示的な失敗にしたいため。
	 *
	 * SQL コメント（`-- ...`）の誤マッチは考えなくてよい。D1 のマイグレーション
	 * ランナーはコメントを落としてから格納するため、`sqlite_master.sql` には
	 * 残らない（このリポジトリのマイグレーションはコメントが多いので実測で確認した）。
	 *
	 * このパースが対応していない書き方は2種類ある。
	 *
	 * - `null` を返す（＝テストが落ちる、安全側）: テーブル修飾（`issues.scope`）、
	 *   `NOT IN`、識別子のダブルクォート、`COLLATE` の挟み込み
	 * - **誤った値を静かに返す**: 値そのものが `)` を含む場合と、末尾カンマ
	 *   （`IN ('a', 'b',)`）。前者は値の途中で切れ、後者は空文字列が混ざる
	 *
	 * 後者に当たる書き方をするなら、このパースも直すこと。ただし
	 * 「enum の全値が DB に通る」「enum 外の値は DB に弾かれる」の2テストは
	 * パースを介さず DB の振る舞いを直接見ているため、そちらは効き続ける。
	 */
	async function checkConstraintValues(
		column: string,
	): Promise<string[] | null> {
		const row = await env.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'",
		).first<{ sql: string }>();
		if (!row?.sql) return null;

		// `CHECK (scope IN ('personal', 'community', ...))` の括弧内だけを取る。
		// 値に `)` を含むものは現状無く、含めるなら CHECK ではなく別テーブルで
		// 表現すべきなので、ここでは単純な非貪欲マッチで足りる。
		const match = row.sql.match(
			new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i"),
		);
		const inList = match?.[1];
		if (inList === undefined) return null;

		return inList
			.split(",")
			.map((value) => value.trim().replace(/^'(.*)'$/, "$1"));
	}

	// DB の CHECK 制約と shared の enum が同じ値を持つこと。
	//
	// この2つは #29 の時点から手動同期で、片方だけ変えても CI は緑のままだった。
	// 実際に `ISSUE_SCOPE_VALUES` へ1値足してラベルも足すと、
	// 514 件のテストが全て通ったうえで POST /issues が 500 を返す状態になる
	// （Zod が通した値を DB が CHECK で弾く）。
	//
	// 集合ではなく「並びを揃えたうえでの一致」を見ているのは、
	// 集合比較だと重複した値を取りこぼすため。SQL 側に同じ値が2度書かれていても
	// Set にすると消えてしまい、書き間違いに気づけない。
	//
	// 期待値をここでベタ書きせず両者を突き合わせているのは、片方向の生成が
	// できない（既存の生 SQL マイグレーションを温存する方針）ため。
	// 生成の代わりに「ずれたら落ちる」で担保する。
	it("keeps the scope CHECK constraint in sync with the shared enum", async () => {
		const values = await checkConstraintValues("scope");

		expect(values, "scope の CHECK 制約が見つからない").not.toBeNull();
		expect([...(values ?? [])].sort()).toEqual([...ISSUE_SCOPE_VALUES].sort());
		// 重複が Set 化で消えないことの確認も兼ねて、件数も直接見る。
		expect(values).toHaveLength(ISSUE_SCOPE_VALUES.length);
	});

	it("keeps the status CHECK constraint in sync with the shared enum", async () => {
		const values = await checkConstraintValues("status");

		expect(values, "status の CHECK 制約が見つからない").not.toBeNull();
		expect([...(values ?? [])].sort()).toEqual([...ISSUE_STATUS_VALUES].sort());
		expect(values).toHaveLength(ISSUE_STATUS_VALUES.length);
	});

	// パースに頼らず、実際に INSERT して確かめる。
	//
	// 上の2つは `sqlite_master.sql` を正規表現で読んでいるため、
	// パースが壊れて常に同じ値を返すようになると気づけない
	// （両辺が一致し続けて緑のままになる）。ここは DB の振る舞いを直接見るので、
	// パースの正しさに依存しない裏取りになる。
	it("accepts every shared enum value at the database level", async () => {
		for (const scope of ISSUE_SCOPE_VALUES) {
			await expect(
				env.DB.prepare(
					"INSERT INTO issues (title, description, scope, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
				)
					.bind(`sync-${scope}`, "d", scope, 0, 0)
					.run(),
				`scope="${scope}" が CHECK 制約で弾かれた`,
			).resolves.toBeDefined();
		}

		for (const status of ISSUE_STATUS_VALUES) {
			await expect(
				env.DB.prepare(
					"INSERT INTO issues (title, description, scope, status, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)",
				)
					.bind(`sync-${status}`, "d", "personal", status, 0, 0)
					.run(),
				`status="${status}" が CHECK 制約で弾かれた`,
			).resolves.toBeDefined();
		}
	});

	// 上のテストの逆向き。「DB が enum より広くない」ことを見る。
	//
	// 「enum の全値が DB に通る」だけでは、DB 側にだけ値が足された場合
	// （例: SQL の CHECK に 'planetary' を足して shared に足し忘れる）を
	// 検出できない。その状態では Zod が弾くので 500 にはならないが、
	// 別経路（管理用スクリプト、手作業の SQL、将来の別サービス）から
	// 入った行を API が読めなくなる。表示側は enum を前提にラベルを引くため、
	// `ISSUE_SCOPE_LABELS[locale][scope]` が undefined になって画面が壊れる。
	//
	// CHECK 制約が「受け付ける値の一覧」を DB に列挙させる手段は無いので、
	// enum に含まれない値を実際に INSERT して弾かれることを確かめる。
	// 全網羅はできないが、パースを介さない検査なので
	// `checkConstraintValues` が壊れても効き続ける
	// （パースを壊したうえで SQL 側だけ広げる変異体で、ここだけが落ちることを確認した）。
	it("rejects values outside the shared enum at the database level", async () => {
		// 実際に足されそうな値を選ぶ。無意味な文字列（"xxx"）だと
		// 「CHECK が生きている」ことしか見ておらず、上の
		// 「enforces the scope CHECK constraint」と同じ検査になってしまう。
		const SCOPE_NON_MEMBERS = ["planetary", "regional", ""];
		const STATUS_NON_MEMBERS = ["wontfix", "duplicate", ""];

		for (const scope of SCOPE_NON_MEMBERS) {
			// enum に足した結果ここが落ちる場合、消すべきはこの配列ではなく
			// 「SQL の CHECK にも足す」方。両方に足せば上のテストが通る。
			expect(
				[...ISSUE_SCOPE_VALUES] as string[],
				`"${scope}" は enum のメンバーなので非メンバーの例に使えない`,
			).not.toContain(scope);

			await expect(
				env.DB.prepare(
					"INSERT INTO issues (title, description, scope, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
				)
					.bind("non-member", "d", scope, 0, 0)
					.run(),
				`scope="${scope}" が DB に通ってしまう（CHECK 制約が enum より広い）`,
			).rejects.toThrow(/CHECK constraint failed/);
		}

		for (const status of STATUS_NON_MEMBERS) {
			expect(
				[...ISSUE_STATUS_VALUES] as string[],
				`"${status}" は enum のメンバーなので非メンバーの例に使えない`,
			).not.toContain(status);

			await expect(
				env.DB.prepare(
					"INSERT INTO issues (title, description, scope, status, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)",
				)
					.bind("non-member", "d", "personal", status, 0, 0)
					.run(),
				`status="${status}" が DB に通ってしまう（CHECK 制約が enum より広い）`,
			).rejects.toThrow(/CHECK constraint failed/);
		}
	});

	// `help_offers`（0004）にも `issues` と同じ検査を掛ける。
	//
	// 公開判断とインデックスの見張りをテーブルごとに用意しないと、
	// 後から足したテーブルだけが素通りする。`issues` 側で防いだ穴（#8）が
	// 別のテーブルで開く。
	describe("help_offers", () => {
		/** `help_offers` テーブルのカラム名を宣言順に返す。 */
		async function helpOfferColumns(): Promise<string[]> {
			const { results } = await env.DB.prepare(
				"PRAGMA table_info(help_offers)",
			).all<{ name: string }>();
			return results.map((row) => row.name);
		}

		it("has the columns the migration defines, in migration order", async () => {
			expect(await helpOfferColumns()).toEqual([
				"id",
				"issue_id",
				"user_id",
				"created_at",
			]);
		});

		// `issues` 側と同じ理由で期待値はベタ書きする（マイグレーションから
		// 導出すると、インデックスを消す変更で期待値も一緒に消えて検出力が消える）。
		//
		// `UNIQUE (issue_id, user_id)` が張る索引は SQLite が
		// `sqlite_autoindex_help_offers_1` という名前で自動生成するため、
		// `sqlite_%` を除外している他のテーブルと違ってここでは数えられない。
		// UNIQUE 制約そのものは「二重に表明できない」テストで担保している。
		it("has every index the migration defines", async () => {
			const { results } = await env.DB.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'help_offers' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			).all<{ name: string }>();

			expect(results.map((row) => row.name)).toEqual([
				// 0004_create_help_offers.sql — 「自分が表明した Issue」を引く経路用
				"idx_help_offers_user_id",
			]);
		});

		// `issues` 側と違い、`user_id` は公開側に入っている。
		// 本人が自分の意思で名乗り出た記録なので秘匿対象ではない
		// （判断の理由は `routes/help-offers.ts` のコメント）。
		// ここが保証するのは「カラムを足したら公開可否を書かされる」ところまで。
		it("classifies every column as either public or explicitly internal", async () => {
			/** 公開してはいけないカラム。追加したら意図的にここへ足す。 */
			const INTERNAL_COLUMNS = ["issue_id"];

			expect(await helpOfferColumns()).toEqual(
				expect.arrayContaining([...PUBLIC_HELP_OFFER_COLUMNS]),
			);
			expect([...(await helpOfferColumns())].sort()).toEqual(
				[...PUBLIC_HELP_OFFER_COLUMNS, ...INTERNAL_COLUMNS].sort(),
			);
		});

		// 同一ユーザーの二重表明を DB 側で止めていること。
		//
		// アプリ側は `ON CONFLICT` で冪等に倒しているため、制約が消えても
		// 通常の経路では気づけない。ここは制約そのものを直接叩く。
		it("enforces the unique constraint on (issue_id, user_id)", async () => {
			await env.DB.prepare(
				"INSERT INTO issues (id, title, description, scope, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)",
			)
				.bind("schema-test-issue", "t", "d", "community", 0, 0)
				.run();
			await env.DB.prepare(
				"INSERT INTO help_offers (issue_id, user_id) VALUES (?, ?)",
			)
				.bind("schema-test-issue", "user_dup")
				.run();

			await expect(
				env.DB.prepare(
					"INSERT INTO help_offers (issue_id, user_id) VALUES (?, ?)",
				)
					.bind("schema-test-issue", "user_dup")
					.run(),
			).rejects.toThrow(/UNIQUE constraint failed/);
		});
	});
});
