import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * すでに保存されている座標が、マイグレーションで丸められること（#124）。
 *
 * **なぜ専用のファイルなのか。** 他のテストは `helpers/migrate.ts` が
 * マイグレーションを全部適用したところから始まる。それだと
 * 「0010 より前に入った行」を作れず、移行そのものを検査できない。
 * ここでは 0009 までを適用して細かい座標の行を入れ、そのうえで
 * 0010 を適用して値の変化を見る。
 *
 * 検査する意味はここにある。保存時に丸める方式（`src/routes/issues.ts`）は
 * **これから入る行にしか効かない**。要望を出した本人の投稿を含む既存行は、
 * 移行しなければ細かいまま残り続ける。Issue の受け入れ条件が
 * 「既存データの扱いについて結論が出ていること」を求めているのはそこ。
 *
 * `applyD1Migrations` は適用済みを `d1_migrations` テーブルで管理するので、
 * 2 回目の呼び出しでは未適用のものだけが走る。
 */
describe("Existing coordinates are coarsened by the migration", () => {
	/** 0010 より前のマイグレーション。番号で切る */
	const BEFORE_COARSENING = env.TEST_MIGRATIONS.filter(
		(migration) => Number.parseInt(migration.name, 10) < 10,
	);

	/**
	 * Issue #124 に載っていた実際の値。小数点以下 13 桁で、
	 * 緯度の 1e-13 度はミリメートル未満の分解能にあたる。
	 */
	const RAW_LATITUDE = 35.8140866596896;
	const RAW_LONGITUDE = 140.4131622629284;

	beforeAll(async () => {
		// 番号で切った部分集合が空だと、以降の検査が「何も無い DB を
		// 移行した」ことしか見なくなる。切り出しが効いていることを先に押さえる
		expect(BEFORE_COARSENING.length).toBeGreaterThan(0);
		expect(BEFORE_COARSENING.length).toBeLessThan(env.TEST_MIGRATIONS.length);

		await applyD1Migrations(env.DB, BEFORE_COARSENING);

		// 丸める前のスキーマで、丸める前の精度の行を入れる。
		// 匿名（`is_anonymous` の既定は 1）とそうでない行の両方を置く
		await env.DB.prepare(
			`INSERT INTO issues (id, title, description, scope, latitude, longitude, is_anonymous)
			 VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"legacy-anonymous",
				"匿名の投稿",
				"位置情報が丸められていない既存行",
				"personal",
				RAW_LATITUDE,
				RAW_LONGITUDE,
				1,
				"legacy-named",
				"記名の投稿",
				"位置情報が丸められていない既存行",
				"personal",
				RAW_LATITUDE,
				RAW_LONGITUDE,
				0,
			)
			.run();

		// 入った時点では細かいままであること。ここが最初から丸まっていると、
		// このあとの検査は何も証明しない
		const before = await env.DB.prepare(
			"SELECT latitude FROM issues WHERE id = ?",
		)
			.bind("legacy-anonymous")
			.first<{ latitude: number }>();
		expect(before?.latitude).toBe(RAW_LATITUDE);

		// ここで 0010 が走る
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	});

	async function readIssue(id: string) {
		return env.DB.prepare(
			"SELECT title, latitude, longitude, is_anonymous, created_at, updated_at FROM issues WHERE id = ?",
		)
			.bind(id)
			.first<{
				title: string;
				latitude: number | null;
				longitude: number | null;
				is_anonymous: number;
				created_at: string;
				updated_at: string;
			}>();
	}

	it("rounds the coordinates of rows that already existed", async () => {
		const row = await readIssue("legacy-anonymous");

		expect(row?.latitude).toBe(35.814);
		expect(row?.longitude).toBe(140.413);
	});

	// 匿名の行だけを丸めると、匿名と記名を後から切り替える機能が入った
	// 瞬間に穴が空く（記名で保存した細かい座標が、匿名へ変えても残る）
	it("rounds named rows too", async () => {
		const row = await readIssue("legacy-named");

		expect(row?.latitude).toBe(35.814);
		expect(row?.is_anonymous).toBe(0);
	});

	// 座標以外は写すだけ。作り直しで値が落ちたり既定値に化けたりしないこと
	it("keeps every other column of the migrated rows", async () => {
		const row = await readIssue("legacy-anonymous");

		expect(row?.title).toBe("匿名の投稿");
		expect(row?.is_anonymous).toBe(1);
		expect(row?.created_at).toBeTruthy();
		// 精度を落としたのはこちらの都合であって利用者の更新ではない。
		// `updated_at` が移行の時刻に揃うと、一覧の並びが意味を失う
		expect(row?.updated_at).toBe(row?.created_at);
	});

	// 移行後のテーブルが、位置なしの起票を受けられること。
	// NOT NULL を外し損ねると、丸めだけが効いて #124 の半分しか解けない
	it("accepts rows without a location after the migration", async () => {
		await env.DB.prepare(
			"INSERT INTO issues (id, title, description, scope) VALUES (?, ?, ?, ?)",
		)
			.bind("no-location", "位置なし", "位置を出さない起票", "personal")
			.run();

		const row = await readIssue("no-location");
		expect(row?.latitude).toBeNull();
		expect(row?.longitude).toBeNull();
	});

	// 作り直したテーブルを、他のテーブルの外部キーが正しく参照できること。
	//
	// `DROP TABLE issues` → `RENAME` の間、`comments` などの
	// `REFERENCES issues(id)` は参照先を失う。参照が壊れたままだと、
	// **存在しない Issue へのコメントが入る**（外部キーが効かない）か、
	// 逆に正しいコメントが入らなくなる。どちらも移行の副作用として起きうる
	it("keeps the foreign keys of the child tables pointing at the new table", async () => {
		await expect(
			env.DB.prepare(
				"INSERT INTO comments (id, issue_id, user_id, body) VALUES (?, ?, ?, ?)",
			)
				.bind("comment-on-migrated", "legacy-anonymous", "user_1", "本文")
				.run(),
		).resolves.toBeDefined();

		await expect(
			env.DB.prepare(
				"INSERT INTO comments (id, issue_id, user_id, body) VALUES (?, ?, ?, ?)",
			)
				.bind("comment-on-ghost", "does-not-exist", "user_1", "本文")
				.run(),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
	});

	// 削除の連鎖（ON DELETE CASCADE）も生きていること。
	// 参照先だけ繋がっていて CASCADE が失われると、Issue を消した後に
	// 迷子のコメントが残る
	it("still cascades deletes to the child tables", async () => {
		await env.DB.prepare(
			"INSERT INTO comments (id, issue_id, user_id, body) VALUES (?, ?, ?, ?)",
		)
			.bind("comment-to-cascade", "legacy-named", "user_1", "本文")
			.run();

		await env.DB.prepare("DELETE FROM issues WHERE id = ?")
			.bind("legacy-named")
			.run();

		const orphan = await env.DB.prepare("SELECT id FROM comments WHERE id = ?")
			.bind("comment-to-cascade")
			.first();
		expect(orphan).toBeNull();
	});
});
