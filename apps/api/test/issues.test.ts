import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `@hono/clerk-auth` ではなく、その内部が使う `@clerk/backend` をモックする。
// `clerkMiddleware` の本体は実物が動くため、ミドルウェアの適用漏れや
// `getAuth` の戻り値の形の変化がテストに現れる。詳細は helpers/clerk-mock.ts。
//
// `vi.mock` はファイル先頭に巻き上げられ、import した束縛をまだ参照できない。
// そのためファクトリはここで動的 import して呼ぶ。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";
import {
	PUBLIC_ISSUE_COLUMNS as PUBLIC_ISSUE_COLUMNS_FOR_TEST,
	PUBLIC_SELECT as PUBLIC_SELECT_FOR_TEST,
	toPublicIssue as toPublicIssueForTest,
} from "../src/routes/issues";
import { setMockUserId } from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

const app = createApp();

/**
 * 書き込み系は Origin 検証を通す必要があるため、許可オリジンを付けて叩く。
 * Origin 検証そのもののテストは `csrf.test.ts` にある。
 */
const ALLOWED_ORIGIN = "http://localhost:3000";

type IssueInput = {
	title: string;
	description: string;
	scope: string;
	latitude: number;
	longitude: number;
	category?: string;
};

/**
 * API のレスポンス JSON。単体の Issue と一覧レスポンスの両方を受ける。
 * テストからの読み取り専用なので、キーは緩く引けるようにしてある。
 */
// biome-ignore lint/suspicious/noExplicitAny: テストからレスポンスを緩く読むための意図的な型
type IssueBody = Record<string, any>;

/** `res.json()` は `unknown` を返すため、テスト用に型を与える薄いラッパー。 */
async function readBody(res: Response): Promise<IssueBody> {
	return (await res.json()) as IssueBody;
}

/**
 * SQLite が返すタイムスタンプ文字列をミリ秒に直す。
 *
 * 書式は `YYYY-MM-DD HH:MM:SS[.SSS]`（UTC、末尾のオフセット表記なし）。
 * そのまま `new Date()` に渡すとローカルタイム扱いになるため、
 * 区切りを ISO 形式に直して UTC であることを明示する。
 * パースできない値は NaN になり、比較の assertion がそのまま落ちる。
 */
function toMillis(timestamp: string): number {
	return new Date(`${timestamp.replace(" ", "T")}Z`).getTime();
}

/**
 * 実装が書き込むタイムスタンプの書式（`YYYY-MM-DD HH:MM:SS.SSS`）。
 *
 * テーブルの DEFAULT は秒精度なので、この書式であること自体が
 * 「アプリが明示的に書いた」証拠になる。DEFAULT 任せに退行すると
 * ミリ秒部が消えてマッチしなくなる。
 */
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/**
 * DB に保存されている行を直接読む。
 *
 * PATCH のレスポンス JSON だけを見ていると、DB に書かずにレスポンスを
 * 組み立てるだけの実装でも通ってしまう。永続化されたかを見るために使う。
 */
async function readStoredIssue(id: string): Promise<IssueBody> {
	const row = await env.DB.prepare("SELECT * FROM issues WHERE id = ?")
		.bind(id)
		.first<IssueBody>();
	if (!row) {
		throw new Error(`Issue ${id} not found in DB`);
	}
	return row;
}

/** 一覧レスポンスの `data` からタイトルを並び順のまま取り出す。 */
function titlesOf(body: IssueBody): string[] {
	return (body.data as IssueBody[]).map((issue) => issue.title as string);
}

const validIssue: IssueInput = {
	title: "Broken streetlight",
	description: "The streetlight on Main St is not working",
	scope: "community",
	latitude: 35.68,
	longitude: 139.76,
};

/**
 * `created_at` を明示指定した Issue を DB へ直接投入する。
 *
 * 並び順の検証を API 経由の連続作成だけで行うと、実行が速い環境では
 * 同一ミリ秒に収まって時刻差が消え、テストが非決定的になる。
 * 時刻を固定した行を入れることで、DESC を検証する意図を実行環境に依存させない。
 */
async function insertIssueAt(
	id: string,
	title: string,
	createdAt: string,
	userId = "test-user-123",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			title,
			validIssue.description,
			validIssue.scope,
			validIssue.latitude,
			validIssue.longitude,
			userId,
			createdAt,
			createdAt,
		)
		.run();
}

async function createIssue(data: IssueInput = validIssue) {
	return app.request(
		"/issues",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ALLOWED_ORIGIN,
			},
			body: JSON.stringify(data),
		},
		env,
	);
}

describe("Issues CRUD", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM issues");
		setMockUserId("test-user-123");
	});

	// --- Authentication ---
	describe("Authentication", () => {
		it("returns 401 for unauthenticated POST", async () => {
			setMockUserId(null);
			const res = await createIssue();
			expect(res.status).toBe(401);
			const body = await readBody(res);
			expect(body.error).toBe("Unauthorized");
		});

		it("returns 401 for unauthenticated PATCH", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "Updated" }),
				},
				env,
			);
			expect(res.status).toBe(401);
		});

		it("allows unauthenticated GET list", async () => {
			setMockUserId(null);
			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
		});

		it("allows unauthenticated GET by id", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(`/issues/${created.id}`, {}, env);
			expect(res.status).toBe(200);
		});
	});

	// --- POST /issues ---
	describe("POST /issues", () => {
		it("creates an issue with user_id and returns 201", async () => {
			const res = await createIssue();
			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.title).toBe(validIssue.title);
			expect(body.scope).toBe(validIssue.scope);
			expect(body.status).toBe("open");
			expect(body.id).toBeDefined();
			expect(body.created_at).toBeDefined();

			// `user_id` は内部フィールドなのでレスポンスには載せない。
			// 保存されたことは DB を直接読んで確認する（レスポンスに出すことで
			// 確認すると、公開してはいけない値を仕様として固定してしまう）。
			expect(body).not.toHaveProperty("user_id");
			const stored = await readStoredIssue(body.id);
			expect(stored.user_id).toBe("test-user-123");
		});

		it("stamps created_at and updated_at with millisecond precision", async () => {
			// テーブルの DEFAULT（秒精度）任せに戻ると、作成直後の PATCH で
			// created_at が最大 999ms 先行し、updated_at < created_at の逆転が起きる。
			// アプリが明示的にミリ秒精度で書いていることを、書式で確認する。
			const res = await createIssue();
			const body = await readBody(res);

			expect(body.created_at).toMatch(TIMESTAMP_FORMAT);
			expect(body.updated_at).toMatch(TIMESTAMP_FORMAT);
			// 作成時点では両者が同じ瞬間を指す
			expect(body.updated_at).toBe(body.created_at);

			const stored = await readStoredIssue(body.id);
			expect(stored.created_at).toMatch(TIMESTAMP_FORMAT);
			expect(stored.updated_at).toMatch(TIMESTAMP_FORMAT);
		});

		// Issue #46。`'now'` の解像度（ミリ秒）より速く連続作成すると
		// `created_at` が同値になり、一覧の並びが `id`（ランダム値）で
		// 決まって「新しい順」にならなかった。
		//
		// 2 件だけだと同一ミリ秒に収まらず偶然通ることがあるため、
		// まとめて作って全件の値が異なることを見る。
		it("assigns a distinct created_at to every issue, even in the same millisecond", async () => {
			const created: string[] = [];
			for (let i = 0; i < 10; i++) {
				const res = await createIssue({ ...validIssue, title: `Issue ${i}` });
				created.push((await readBody(res)).created_at);
			}

			expect(new Set(created).size).toBe(created.length);
			// 作成した順に単調増加していること（同値が無いだけでは、
			// 後から作った行が古い側に来る可能性を排除できない）。
			// 昇順に整列したものと元の順序が一致するかで見る
			expect(created).toEqual([...created].sort());
		});

		// 並び順そのものを API のレスポンスで見る。上のテストは値の性質を
		// 見ているだけなので、`ORDER BY` が壊れても気付けない。
		//
		// 件数を多めに取っているのは、同一ミリ秒の衝突が起きなければ
		// 壊れた実装でも偶然通ってしまうため。10 件連続で作れば、
		// ミリ秒解像度に対して確実にどこかが衝突する。
		it("returns issues in creation order, newest first", async () => {
			const titles = Array.from({ length: 10 }, (_, i) => `Issue ${i}`);
			for (const title of titles) {
				await createIssue({ ...validIssue, title });
			}

			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);

			expect(titlesOf(body)).toEqual([...titles].reverse());
		});

		it("creates an issue with optional category", async () => {
			const res = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body.category).toBe("infrastructure");
		});

		it("rejects missing required fields", async () => {
			const res = await createIssue({ title: "Only title" } as never);
			expect(res.status).toBe(400);
			const body = await readBody(res);
			expect(body.error).toBeDefined();
		});

		it("rejects invalid scope", async () => {
			const res = await createIssue({ ...validIssue, scope: "invalid" });
			expect(res.status).toBe(400);
		});

		it("rejects out-of-range latitude", async () => {
			const res = await createIssue({ ...validIssue, latitude: 91 });
			expect(res.status).toBe(400);
		});

		it("rejects out-of-range longitude", async () => {
			const res = await createIssue({ ...validIssue, longitude: -181 });
			expect(res.status).toBe(400);
		});

		it("rejects invalid JSON body", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: "not json",
				},
				env,
			);
			expect(res.status).toBe(400);
			const body = await readBody(res);
			expect(body.error).toBe("Invalid JSON");
		});

		// 文字列フィールドの長さ制限は、入力チェックであると同時にリソース保護でもある。
		// `description` の max(5000) が失われると、1 リクエストで任意サイズの文字列を
		// D1 に書き込める（D1 は書き込み量で課金される）。POST は認証必須だが、
		// Clerk の無料枠で誰でもアカウントを作れるため、実質的に第三者が到達できる経路。
		// `min(1)` が失われると、一覧・地図 UI に表示できない空タイトルの行が混入する
		// （テーブルの NOT NULL は空文字列を弾かないので DB でも止まらない）。
		describe("body string length validation", () => {
			it("rejects an empty title", async () => {
				const res = await createIssue({ ...validIssue, title: "" });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.title).toBeDefined();
			});

			it("rejects a title above the maximum length", async () => {
				const res = await createIssue({
					...validIssue,
					title: "a".repeat(201),
				});
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.title).toBeDefined();
			});

			// 拒否だけを固定すると max(200) を max(100) に狭めるような退行を拾えないため、
			// 境界の「通る側」も押さえておく（GET のクエリ検証と同じ理由）。
			it("accepts a title at the maximum length", async () => {
				const title = "a".repeat(200);
				const res = await createIssue({ ...validIssue, title });
				expect(res.status).toBe(201);
				const body = await readBody(res);
				expect(body.title).toBe(title);
			});

			it("rejects an empty description", async () => {
				const res = await createIssue({ ...validIssue, description: "" });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.description).toBeDefined();
			});

			it("rejects a description above the maximum length", async () => {
				const res = await createIssue({
					...validIssue,
					description: "d".repeat(5001),
				});
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.description).toBeDefined();
			});

			it("accepts a description at the maximum length", async () => {
				const description = "d".repeat(5000);
				const res = await createIssue({ ...validIssue, description });
				expect(res.status).toBe(201);
				const body = await readBody(res);
				expect(body.description).toBe(description);
			});

			it("rejects an empty category", async () => {
				const res = await createIssue({ ...validIssue, category: "" });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.category).toBeDefined();
			});

			it("rejects a category above the maximum length", async () => {
				const res = await createIssue({
					...validIssue,
					category: "c".repeat(101),
				});
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.category).toBeDefined();
			});

			it("accepts a category at the maximum length", async () => {
				const category = "c".repeat(100);
				const res = await createIssue({ ...validIssue, category });
				expect(res.status).toBe(201);
				const body = await readBody(res);
				expect(body.category).toBe(category);
			});

			// 400 を返すだけでなく、そもそも DB に書いていないこと。
			//
			// 長さ制限は「レスポンスの形」ではなく D1 への書き込み量を守るための
			// 制限なので、400 を返していても手前で INSERT が走っていれば意味がない。
			// レスポンスの検査だけでは「検証は落とすが INSERT はする」退行を拾えない。
			it("does not insert a row when the length check fails", async () => {
				const res = await createIssue({
					...validIssue,
					description: "d".repeat(5001),
				});
				expect(res.status).toBe(400);

				const row = await env.DB.prepare(
					"SELECT COUNT(*) as total FROM issues",
				).first<{ total: number }>();
				expect(row?.total).toBe(0);
			});
		});

		// 型を取り違えた値が、暗黙の変換で通ってしまわないこと。
		// zod は文字列フィールドに数値を渡しても coerce しないが、
		// `z.coerce.string()` への変更などで静かに緩む余地がある。
		describe("body type validation", () => {
			it("rejects a numeric title", async () => {
				const res = await createIssue({ ...validIssue, title: 123 } as never);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.title).toBeDefined();
			});

			it("rejects a string latitude", async () => {
				const res = await createIssue({
					...validIssue,
					latitude: "35.68",
				} as never);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.latitude).toBeDefined();
			});

			it("rejects a null body", async () => {
				const res = await createIssue(null as never);
				expect(res.status).toBe(400);
			});

			it("rejects an array body", async () => {
				const res = await createIssue([] as never);
				expect(res.status).toBe(400);
			});
		});
	});

	// --- GET /issues ---
	describe("GET /issues", () => {
		it("returns empty list initially", async () => {
			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data).toEqual([]);
			expect(body.total).toBe(0);
		});

		it("returns created issues", async () => {
			await createIssue();
			await createIssue({ ...validIssue, title: "Second issue" });

			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.data).toHaveLength(2);
			expect(body.total).toBe(2);
			expect(body.limit).toBe(20);
			expect(body.offset).toBe(0);
			// 件数だけでは「何を返したか」を見ていないので、中身も確認する
			expect(titlesOf(body)).toEqual(["Second issue", validIssue.title]);
		});

		it("filters by scope", async () => {
			await createIssue();
			await createIssue({ ...validIssue, scope: "national" });

			const res = await app.request("/issues?scope=community", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(body.total).toBe(1);
			expect(body.data[0].scope).toBe("community");
		});

		it("filters by status", async () => {
			await createIssue();

			const res = await app.request("/issues?status=open", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);

			const res2 = await app.request("/issues?status=closed", {}, env);
			const body2 = await readBody(res2);
			expect(body2.data).toHaveLength(0);
		});

		it("supports limit and offset", async () => {
			// 件数だけを見ていると offset を無視する実装（毎回同じ 2 件を返す）でも
			// 通ってしまうため、各ページの中身まで固定する。
			await insertIssueAt("order-1", "Issue 1", "2026-01-01 00:00:01.000");
			await insertIssueAt("order-2", "Issue 2", "2026-01-01 00:00:02.000");
			await insertIssueAt("order-3", "Issue 3", "2026-01-01 00:00:03.000");

			const res = await app.request("/issues?limit=2&offset=0", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(2);
			expect(body.total).toBe(3);
			expect(titlesOf(body)).toEqual(["Issue 3", "Issue 2"]);

			const res2 = await app.request("/issues?limit=2&offset=2", {}, env);
			const body2 = await readBody(res2);
			expect(body2.data).toHaveLength(1);
			expect(body2.total).toBe(3);
			expect(titlesOf(body2)).toEqual(["Issue 1"]);

			// ページを跨いで重複せず、全件を覆うこと
			const paged = [...titlesOf(body), ...titlesOf(body2)];
			expect(new Set(paged).size).toBe(paged.length);
			expect([...paged].sort()).toEqual(["Issue 1", "Issue 2", "Issue 3"]);
		});

		// 一覧の並び順（新しい順）は API のユーザー可視な仕様そのもので、
		// フロントの一覧・地図はこれに依存している。件数しか見ないテストでは
		// `ORDER BY` を反転しても削っても通ってしまうため、明示的に固定する。
		describe("ordering", () => {
			it("returns issues newest first", async () => {
				// 投入順と返却順が逆になることを見る（投入順のまま返す実装で落ちる）
				await insertIssueAt("order-old", "Oldest", "2026-01-01 00:00:01.000");
				await insertIssueAt("order-mid", "Middle", "2026-01-01 00:00:02.000");
				await insertIssueAt("order-new", "Newest", "2026-01-01 00:00:03.000");

				const res = await app.request("/issues", {}, env);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["Newest", "Middle", "Oldest"]);
			});

			it("keeps the newest-first order when filtered by scope", async () => {
				// フィルタ有りは WHERE 句の組み立てが変わる別経路なので、
				// そこでも並び順が保たれることを確認する。
				await insertIssueAt(
					"scoped-old",
					"Old community",
					"2026-01-01 00:00:01.000",
				);
				await insertIssueAt(
					"scoped-new",
					"New community",
					"2026-01-01 00:00:03.000",
				);
				await createIssue({ ...validIssue, scope: "national" });

				const res = await app.request("/issues?scope=community", {}, env);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["New community", "Old community"]);
			});

			it("keeps the newest-first order when filtered by status", async () => {
				// scope と status は別々の条件として組み立てられるため、
				// 片方の経路だけ並び順が壊れる退行があり得る。両方を押さえる。
				await insertIssueAt(
					"status-old",
					"Old open",
					"2026-01-01 00:00:01.000",
				);
				await insertIssueAt(
					"status-new",
					"New open",
					"2026-01-01 00:00:03.000",
				);
				await env.DB.prepare(
					"UPDATE issues SET status = 'closed' WHERE id = 'status-old'",
				).run();
				await insertIssueAt(
					"status-mid",
					"Mid open",
					"2026-01-01 00:00:02.000",
				);

				const res = await app.request("/issues?status=open", {}, env);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["New open", "Mid open"]);
			});

			it("orders by id when created_at ties", async () => {
				// `created_at` がミリ秒精度でも、同一ミリ秒に複数件作られると
				// それだけでは順序が決まらず、SQLite が返す順（実測では rowid 順、
				// つまり挿入順）に委ねられる。第二キー `id DESC` が効いていることを、
				// 挿入順とも rowid 順とも一致しない並びで確認する。
				//
				// 本番の `id` はランダム値なので、この並びは時系列を意味しない。
				// ここで見ているのは「順序が id で一意に決まること」であり、
				// テスト用の id を辞書順に振ることでその結果を予測可能にしている。
				// 挿入順（b → a → c）と id の降順（c → b → a）が一致しないよう仕込む。
				// これにより「rowid 順を返しているだけ」でも「その逆順」でも落ちる。
				const sameMoment = "2026-01-01 00:00:00.000";
				await insertIssueAt("tie-b", "Tie B", sameMoment);
				await insertIssueAt("tie-a", "Tie A", sameMoment);
				await insertIssueAt("tie-c", "Tie C", sameMoment);

				const res = await app.request("/issues", {}, env);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["Tie C", "Tie B", "Tie A"]);
			});

			it("does not drop or duplicate rows when paging through ties", async () => {
				// 順序が不定だとページ境界で行が欠落・重複する。
				// 同一時刻の 4 件を 1 件ずつ辿り、全件がちょうど 1 度ずつ現れること。
				const sameMoment = "2026-01-01 00:00:00.000";
				const titles = ["Tie A", "Tie B", "Tie C", "Tie D"];
				for (const [index, title] of titles.entries()) {
					await insertIssueAt(`tie-${index}`, title, sameMoment);
				}

				const seen: string[] = [];
				for (let offset = 0; offset < titles.length; offset++) {
					const res = await app.request(
						`/issues?limit=1&offset=${offset}`,
						{},
						env,
					);
					const body = await readBody(res);
					expect(body.data).toHaveLength(1);
					seen.push(...titlesOf(body));
				}

				expect(new Set(seen).size).toBe(titles.length);
				expect([...seen].sort()).toEqual([...titles].sort());
			});
		});

		// --- カーソルページング（ページ跨ぎの挿入に強い） ---
		//
		// offset ページングは「先頭から数えて N 件目」で位置を決めるため、
		// ページを跨いで閲覧している間に新しい Issue が先頭に入ると全体が
		// 1 つずつ後ろにずれ、まだ見ていない行が飛ばされて同じ行が二重に出る。
		// Issue Tracker は新規投稿が絶えず先頭に入るデータなので、この欠陥は
		// 「投稿されたのに誰にも表示されない Issue」として直接現れる。
		//
		// カーソル（最後に見た行の created_at + id）で位置を決めれば、
		// 前に何件挿入されても「その行より古いもの」の集合は変わらないので
		// 欠落・重複が原理的に起きない。
		describe("cursor pagination", () => {
			/**
			 * created_at を明示的にずらした Issue を直接 INSERT する。
			 *
			 * API 経由の POST だと同一ミリ秒に固まりうるため、順序が主題の
			 * テストでは DB に直接入れて時刻を確定させる。
			 */
			async function seedIssue(title: string, createdAt: string) {
				const row = await env.DB.prepare(
					`INSERT INTO issues (title, description, scope, latitude, longitude, created_at, updated_at)
				   VALUES (?, ?, 'community', 35.68, 139.76, ?, ?)
				   RETURNING id`,
				)
					.bind(title, `desc of ${title}`, createdAt, createdAt)
					.first<{ id: string }>();
				if (!row) {
					throw new Error(`failed to seed ${title}`);
				}
				return row.id;
			}

			const titlesOf = (body: IssueBody): string[] =>
				body.data.map((row: IssueBody) => row.title);

			it("returns a next_cursor when more rows remain", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");
				await seedIssue("t-1", "2026-01-01 00:00:01.000");
				await seedIssue("t-2", "2026-01-01 00:00:02.000");

				const res = await app.request("/issues?limit=2", {}, env);
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["t-2", "t-1"]);
				expect(typeof body.next_cursor).toBe("string");
			});

			it("returns a null next_cursor on the last page", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");
				await seedIssue("t-1", "2026-01-01 00:00:01.000");

				const res = await app.request("/issues?limit=2", {}, env);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["t-1", "t-0"]);
				expect(body.next_cursor).toBeNull();
			});

			it("continues from the cursor", async () => {
				for (let i = 0; i < 6; i++) {
					await seedIssue(`t-${i}`, `2026-01-01 00:00:0${i}.000`);
				}

				const page1 = await readBody(
					await app.request("/issues?limit=3", {}, env),
				);
				expect(titlesOf(page1)).toEqual(["t-5", "t-4", "t-3"]);

				const page2 = await readBody(
					await app.request(
						`/issues?limit=3&cursor=${encodeURIComponent(page1.next_cursor)}`,
						{},
						env,
					),
				);
				expect(titlesOf(page2)).toEqual(["t-2", "t-1", "t-0"]);
				expect(page2.next_cursor).toBeNull();
			});

			// Issue #16 の本題。ページ 1 とページ 2 の間に新規投稿が入っても、
			// 既存の行が飛ばされたり二重に出たりしないこと。
			it("does not skip or duplicate rows when a new issue is inserted mid-pagination", async () => {
				for (let i = 0; i < 6; i++) {
					await seedIssue(`t-${i}`, `2026-01-01 00:00:0${i}.000`);
				}

				const seen: string[] = [];
				const page1 = await readBody(
					await app.request("/issues?limit=3", {}, env),
				);
				seen.push(...titlesOf(page1));

				// ページを跨いでいる最中に誰かが新しい Issue を投稿する
				await seedIssue("t-NEW", "2026-01-01 00:00:09.000");

				let cursor: string | null = page1.next_cursor;
				while (cursor) {
					const next: IssueBody = await readBody(
						await app.request(
							`/issues?limit=3&cursor=${encodeURIComponent(cursor)}`,
							{},
							env,
						),
					);
					seen.push(...titlesOf(next));
					cursor = next.next_cursor;
				}

				// 最初のページより古い行は、1 件残らず 1 回ずつ見えている
				expect(seen).toEqual(["t-5", "t-4", "t-3", "t-2", "t-1", "t-0"]);
				expect(new Set(seen).size).toBe(seen.length);
			});

			// created_at が同一秒に固まっても順序が確定すること。
			// ORDER BY のタイブレークが無いと、同値行の並びが実装依存になり
			// カーソル比較の前提（全順序）が崩れる。
			it("paginates rows sharing the same created_at without loss", async () => {
				const sameTime = "2026-01-01 00:00:00.000";
				for (let i = 0; i < 10; i++) {
					await seedIssue(`s-${i}`, sameTime);
				}

				const seen: string[] = [];
				let cursor: string | null = null;
				for (let page = 0; page < 10; page++) {
					const url: string = cursor
						? `/issues?limit=3&cursor=${encodeURIComponent(cursor)}`
						: "/issues?limit=3";
					const body: IssueBody = await readBody(
						await app.request(url, {}, env),
					);
					seen.push(...titlesOf(body));
					cursor = body.next_cursor;
					if (!cursor) {
						break;
					}
				}

				expect(cursor).toBeNull();
				expect(seen).toHaveLength(10);
				expect(new Set(seen).size).toBe(10);
			});

			it("keeps filters applied across cursor pages", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");
				await seedIssue("t-1", "2026-01-01 00:00:01.000");
				await env.DB.prepare(
					`INSERT INTO issues (title, description, scope, latitude, longitude, created_at, updated_at)
				   VALUES ('n-0', 'desc', 'national', 35.68, 139.76, '2026-01-01 00:00:02.000', '2026-01-01 00:00:02.000')`,
				).run();

				const page1 = await readBody(
					await app.request("/issues?scope=community&limit=1", {}, env),
				);
				expect(titlesOf(page1)).toEqual(["t-1"]);
				expect(page1.total).toBe(2);

				const page2 = await readBody(
					await app.request(
						`/issues?scope=community&limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`,
						{},
						env,
					),
				);
				expect(titlesOf(page2)).toEqual(["t-0"]);
				expect(page2.total).toBe(2);
			});

			it("rejects a malformed cursor", async () => {
				const res = await app.request("/issues?cursor=not-a-cursor", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.cursor).toBeDefined();
			});

			// カーソルの長さの上限もリソース保護。GET /issues は認証不要なので、
			// 任意長の文字列を WHERE 句のバインド値として投げ込ませない。
			// 200 + 空ページで受け流すと、上限が無いことに気付けない。
			it("rejects an excessively long cursor", async () => {
				const cursor = `2026-01-01 00:00:00.000|${"a".repeat(1000)}`;
				const res = await app.request(
					`/issues?cursor=${encodeURIComponent(cursor)}`,
					{},
					env,
				);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.cursor).toBeDefined();
			});

			// 不正なカーソルが「空の結果」として素通りしないこと。
			it("does not query the database for a malformed cursor", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");

				const prepareSpy = vi.spyOn(env.DB, "prepare");
				try {
					const res = await app.request("/issues?cursor=%20", {}, env);
					expect(res.status).toBe(400);
					expect(prepareSpy).not.toHaveBeenCalled();
				} finally {
					prepareSpy.mockRestore();
				}
			});

			// カーソルは「WHERE 句にそのまま入る値」なので、SQL 断片を仕込まれても
			// バインド値として扱われる（= 構文エラーにも条件の改竄にもならない）こと。
			it("treats a cursor containing SQL syntax as a literal value", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");

				const res = await app.request(
					`/issues?cursor=${encodeURIComponent("2026-01-01 00:00:05.000|' OR '1'='1")}`,
					{},
					env,
				);
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(titlesOf(body)).toEqual(["t-0"]);
			});

			// cursor と offset は位置の決め方が違うため併用できない。
			//
			// 片方を黙って無視すると、offset ページングから移行途中のクライアント
			// （新しい cursor を送りつつ古い offset も送り続ける）が、正しい行の
			// 代わりに空ページを受け取り、残り全件を失ったまま打ち切ってしまう。
			// 200 + 空配列では区別が付かないので 400 で弾く。
			it("rejects cursor combined with a non-zero offset", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");
				await seedIssue("t-1", "2026-01-01 00:00:01.000");

				const cursor = "2026-01-01 00:00:01.000|whatever";
				const res = await app.request(
					`/issues?limit=1&offset=1&cursor=${encodeURIComponent(cursor)}`,
					{},
					env,
				);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.cursor).toBeDefined();
			});

			// 併用の検証も「400 は返すが SQL は投げる」退行を拾えるようにしておく。
			it("does not query the database when cursor and offset are combined", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");

				const prepareSpy = vi.spyOn(env.DB, "prepare");
				try {
					const cursor = "2026-01-01 00:00:01.000|whatever";
					const res = await app.request(
						`/issues?offset=5&cursor=${encodeURIComponent(cursor)}`,
						{},
						env,
					);
					expect(res.status).toBe(400);
					expect(prepareSpy).not.toHaveBeenCalled();
				} finally {
					prepareSpy.mockRestore();
				}
			});

			// offset=0 は既定値と区別が付かないため、明示されていても通す。
			it("accepts cursor with an explicit offset of zero", async () => {
				await seedIssue("t-0", "2026-01-01 00:00:00.000");
				await seedIssue("t-1", "2026-01-01 00:00:01.000");

				const page1 = await readBody(
					await app.request("/issues?limit=1", {}, env),
				);
				const res = await app.request(
					`/issues?limit=1&offset=0&cursor=${encodeURIComponent(page1.next_cursor)}`,
					{},
					env,
				);
				expect(res.status).toBe(200);
				expect(titlesOf(await readBody(res))).toEqual(["t-0"]);
			});

			// サーバが発行したカーソルは、サーバ自身が必ず受け付けられること。
			//
			// id は TEXT PRIMARY KEY で書式の制約が無く、区切り文字 `|` を含みうる。
			// カーソルの組み立てと分解が非対称だと、そういう行がページ境界に来た
			// 瞬間に自分の発行値を 400 で拒否し、それより古い Issue が全件
			// 到達不能になる。往復できることを実際の行で確かめる。
			it("accepts a cursor it issued for an id containing the separator", async () => {
				await env.DB.prepare(
					`INSERT INTO issues (id, title, description, scope, latitude, longitude, created_at, updated_at)
				   VALUES ('we|ird|id', 'p-1', 'desc', 'community', 35.68, 139.76, '2026-01-01 00:00:01.000', '2026-01-01 00:00:01.000')`,
				).run();
				await seedIssue("p-0", "2026-01-01 00:00:00.000");

				const page1 = await readBody(
					await app.request("/issues?limit=1", {}, env),
				);
				expect(titlesOf(page1)).toEqual(["p-1"]);
				expect(page1.next_cursor).toBe("2026-01-01 00:00:01.000|we|ird|id");

				const res = await app.request(
					`/issues?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`,
					{},
					env,
				);
				expect(res.status).toBe(200);
				expect(titlesOf(await readBody(res))).toEqual(["p-0"]);
			});

			// 並び順にインデックスが効いていること。
			//
			// カーソルページングの利点は「OFFSET のスキャンを避けて深いページでも
			// 一定コスト」だが、毎ページ全表スキャン + TEMP B-TREE ソートが走ると
			// その利点が消える。GET /issues は認証不要の公開エンドポイントで、
			// D1 は読み取り行数で課金されるため、これはコストに直結する。
			// migrations/0003 のインデックスが落ちるとプランが SCAN に戻る。
			it("uses the created_at index instead of sorting the whole table", async () => {
				const plan = await env.DB.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM issues WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
				)
					.bind("2026-01-01 00:00:05.000", "2026-01-01 00:00:05.000", "x", 4)
					.all<{ detail: string }>();

				const detail = plan.results.map((row) => row.detail).join("\n");
				expect(detail).toContain("idx_issues_created_at");
				expect(detail).not.toContain("TEMP B-TREE");
			});
		});

		// クエリ検証は入力チェックであると同時にリソース保護でもある。
		// GET /issues は認証不要の公開エンドポイントなので、limit の上限が失われると
		// 誰でも 1 リクエストで大量の行を読ませられる（D1 は読み取り行数で課金される）。
		// scope / status の enum 検証も WHERE 句を組み立てる前提として効いている。
		describe("query validation", () => {
			it("rejects limit below the minimum", async () => {
				const res = await app.request("/issues?limit=0", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.limit).toBeDefined();
			});

			it("rejects limit above the maximum", async () => {
				const res = await app.request("/issues?limit=101", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.limit).toBeDefined();
			});

			it("rejects a non-numeric limit", async () => {
				const res = await app.request("/issues?limit=abc", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.limit).toBeDefined();
			});

			// 非数値は z.coerce.number() の NaN 判定で落ちるため、.int() の経路は
			// 踏まれない。小数を別途置いて .int() を外す退行も検出できるようにする。
			it("rejects a fractional limit", async () => {
				const res = await app.request("/issues?limit=1.5", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.limit).toBeDefined();
			});

			it("rejects a negative offset", async () => {
				const res = await app.request("/issues?offset=-1", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.offset).toBeDefined();
			});

			it("rejects a non-numeric offset", async () => {
				const res = await app.request("/issues?offset=abc", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.offset).toBeDefined();
			});

			it("rejects a fractional offset", async () => {
				const res = await app.request("/issues?offset=1.5", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.offset).toBeDefined();
			});

			// 上限が無いと INT64 の範囲を超えた値がそのまま .bind() に渡り、
			// D1 が SQLITE_MISMATCH を投げて 500（しかもプレーンテキスト）になる。
			// 認証不要の公開エンドポイントなので、誰でもクエリ文字列だけで落とせてしまう。
			it("rejects offset above the maximum", async () => {
				const res = await app.request("/issues?offset=1000001", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.offset).toBeDefined();
			});

			// 実際に D1 を壊す値。指数表記もクエリ文字列としては通る経路なので個別に置く。
			it.each([
				"9223372036854775807",
				"9223372036854775808",
				"1e20",
				"1e30",
			])("rejects an offset that overflows the database column (%s)", async (offset) => {
				const res = await app.request(`/issues?offset=${offset}`, {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.offset).toBeDefined();
			});

			it("rejects an unknown scope", async () => {
				const res = await app.request("/issues?scope=bogus", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.scope).toBeDefined();
			});

			it("rejects an unknown status", async () => {
				const res = await app.request("/issues?status=bogus", {}, env);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.status).toBeDefined();
			});

			// 拒否だけを固定すると max(100) を max(99) に狭めるような退行を拾えないため、
			// 境界の「通る側」も押さえておく。
			it("accepts limit at the maximum", async () => {
				const res = await app.request("/issues?limit=100", {}, env);
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.limit).toBe(100);
			});

			it("accepts limit at the minimum", async () => {
				await createIssue({ ...validIssue, title: "Issue 1" });
				await createIssue({ ...validIssue, title: "Issue 2" });

				const res = await app.request("/issues?limit=1", {}, env);
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.limit).toBe(1);
				expect(body.data).toHaveLength(1);
				expect(body.total).toBe(2);
			});

			it("accepts offset at the minimum", async () => {
				const res = await app.request("/issues?offset=0", {}, env);
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.offset).toBe(0);
			});

			it("accepts offset at the maximum", async () => {
				const res = await app.request("/issues?offset=1000000", {}, env);
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.offset).toBe(1000000);
			});

			// 400 を返すだけでなく、そもそも DB にクエリを投げていないこと。
			//
			// limit の上限は「レスポンスの形」ではなく D1 の読み取り行数を守るための
			// 制限なので、400 を返していても手前で SELECT が走っていれば意味がない。
			// レスポンスの検査だけでは「検証は落とすが SQL は投げる」退行を拾えないため、
			// prepare の呼び出し回数そのものを見る。
			it("does not query the database when validation fails", async () => {
				await createIssue();

				const prepareSpy = vi.spyOn(env.DB, "prepare");
				try {
					const res = await app.request("/issues?limit=999999", {}, env);
					expect(res.status).toBe(400);
					expect(prepareSpy).not.toHaveBeenCalled();
				} finally {
					prepareSpy.mockRestore();
				}
			});

			// 不正な検索条件が「空の結果」として素通りしないこと。
			// enum 検証を外すと、bogus は WHERE に入って 200 + 空配列になる。
			it("does not query the database for an unknown scope", async () => {
				await createIssue();

				const prepareSpy = vi.spyOn(env.DB, "prepare");
				try {
					const res = await app.request("/issues?scope=bogus", {}, env);
					expect(res.status).toBe(400);
					expect(prepareSpy).not.toHaveBeenCalled();
				} finally {
					prepareSpy.mockRestore();
				}
			});

			// limit / offset が受け付けるのは「10進の整数表記」だけ。
			//
			// z.coerce.number() は内部で Number() を呼ぶため、16進・2進・8進・
			// 指数表記・空文字・空白付き・符号付きがそのまま数値になっていた。
			// バリデーションのつもりのコードが、意図より広い入力を通していた。
			describe("rejects non-decimal numeric notations", () => {
				const REJECTED_NOTATIONS = [
					"", // 空文字（Number("") === 0）
					" 5", // 前後の空白
					"5 ",
					"0x10", // 16 進
					"0b101", // 2 進
					"0o17", // 8 進
					"1e1", // 指数表記
					"+5", // 符号付き
					"5.0", // 小数点付き（整数値だが 10 進整数表記ではない）
					"Infinity",
				];

				for (const value of REJECTED_NOTATIONS) {
					it(`rejects limit=${JSON.stringify(value)}`, async () => {
						const res = await app.request(
							`/issues?limit=${encodeURIComponent(value)}`,
							{},
							env,
						);
						expect(res.status).toBe(400);
						const body = await readBody(res);
						expect(body.error.fieldErrors.limit).toBeDefined();
					});

					it(`rejects offset=${JSON.stringify(value)}`, async () => {
						const res = await app.request(
							`/issues?offset=${encodeURIComponent(value)}`,
							{},
							env,
						);
						expect(res.status).toBe(400);
						const body = await readBody(res);
						expect(body.error.fieldErrors.offset).toBeDefined();
					});
				}
			});

			// 重複したクエリパラメータは 400 で弾く。
			//
			// Object.fromEntries(searchParams) は同名キーを後勝ちで潰すため、
			// ?limit=5&limit=abc は 400、?limit=abc&limit=5 は 200 という
			// 並び順に依存した挙動になっていた。どちらの値を採用するかを
			// 暗黙に決めるより、曖昧な入力として明示的に拒否する。
			describe("rejects duplicated query parameters", () => {
				const DUPLICATES = [
					"limit=5&limit=1",
					"limit=1&limit=5",
					"limit=abc&limit=5",
					"offset=0&offset=7",
					"scope=community&scope=global",
					"status=open&status=closed",
				];

				for (const queryString of DUPLICATES) {
					it(`rejects ?${queryString}`, async () => {
						await createIssue();

						const prepareSpy = vi.spyOn(env.DB, "prepare");
						try {
							const res = await app.request(`/issues?${queryString}`, {}, env);
							expect(res.status).toBe(400);
							// 曖昧な入力は DB に到達させない
							expect(prepareSpy).not.toHaveBeenCalled();
						} finally {
							prepareSpy.mockRestore();
						}
					});
				}

				// 同名でも値が同一なら、実質的な曖昧さは無いが
				// 「複数回指定された」という事実は変わらないため一律で弾く。
				it("rejects duplicates even when the values are identical", async () => {
					const res = await app.request("/issues?limit=5&limit=5", {}, env);
					expect(res.status).toBe(400);
				});

				// 重複判定の蓄積先に `Object.prototype` を継いだオブジェクトを使うと、
				// `toString` のようなプロパティ名が「既にある」と見えてしまい、
				// 1 回しか指定していないパラメータを重複と誤判定する。
				// 未知のパラメータが 1 つ付いただけで一覧 API が 400 になるため、
				// 単発指定が通ることを明示的に固定しておく。
				const PROTOTYPE_KEYS = [
					"toString",
					"constructor",
					"hasOwnProperty",
					"valueOf",
					"isPrototypeOf",
					"__proto__",
				];

				for (const key of PROTOTYPE_KEYS) {
					it(`does not treat a single ?${key}= as a duplicate`, async () => {
						await createIssue();

						const res = await app.request(
							`/issues?${encodeURIComponent(key)}=x&limit=5`,
							{},
							env,
						);
						expect(res.status).toBe(200);
						const body = await readBody(res);
						expect(body.limit).toBe(5);
						expect(body.data).toHaveLength(1);
					});

					// 誤検出を直した結果として、本当の重複まで見逃していないこと。
					it(`still rejects a duplicated ?${key}=`, async () => {
						const encoded = encodeURIComponent(key);
						const res = await app.request(
							`/issues?${encoded}=a&${encoded}=b`,
							{},
							env,
						);
						expect(res.status).toBe(400);
						const body = await readBody(res);
						expect(body.error.fieldErrors[key]).toBeDefined();
					});
				}

				// 重複していない限り、複数のパラメータの併用は従来どおり通る。
				it("accepts distinct parameters used together", async () => {
					await createIssue();

					const res = await app.request(
						"/issues?scope=community&status=open&limit=5&offset=0",
						{},
						env,
					);
					expect(res.status).toBe(200);
					const body = await readBody(res);
					expect(body.limit).toBe(5);
					expect(body.offset).toBe(0);
					expect(body.data).toHaveLength(1);
				});
			});
		});
	});

	// --- GET /issues/:id ---
	describe("GET /issues/:id", () => {
		it("returns an issue by id", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(`/issues/${created.id}`, {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.id).toBe(created.id);
			expect(body.title).toBe(validIssue.title);
		});

		it("returns 404 for non-existent id", async () => {
			const res = await app.request("/issues/nonexistent", {}, env);
			expect(res.status).toBe(404);
			const body = await readBody(res);
			expect(body.error).toBe("Issue not found");
		});
	});

	// --- GET /issues/mine ---
	//
	// 自分が起票した Issue だけを返す（Issue #68）。公開一覧と違って認証必須で、
	// 絞り込みの条件は Clerk の userId ひとつ。クエリで他人を指定する余地は無い。
	describe("GET /issues/mine", () => {
		const OWNER = "test-user-123";
		const OTHER = "other-user-456";

		it("returns 401 when unauthenticated", async () => {
			await createIssue();

			setMockUserId(null);
			const res = await app.request("/issues/mine", {}, env);
			expect(res.status).toBe(401);
			const body = await readBody(res);
			expect(body.error).toBe("Unauthorized");
		});

		// 401 を返しながら結果も組み立てている実装だと、レスポンスの検査だけでは
		// 気付けない。未認証では DB に一切触れないことを prepare の回数で見る。
		it("does not query the database when unauthenticated", async () => {
			await createIssue();

			setMockUserId(null);
			const prepareSpy = vi.spyOn(env.DB, "prepare");
			try {
				const res = await app.request("/issues/mine", {}, env);
				expect(res.status).toBe(401);
				expect(prepareSpy).not.toHaveBeenCalled();
			} finally {
				prepareSpy.mockRestore();
			}
		});

		// `/issues/mine` が `/issues/:id` にマッチしてしまうと、
		// 「mine という id の Issue は無い」で 404 になる。登録順の退行を拾う。
		it("is not swallowed by the /issues/:id route", async () => {
			const res = await app.request("/issues/mine", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(Array.isArray(body.data)).toBe(true);
		});

		it("returns only the issues created by the caller", async () => {
			await insertIssueAt(
				"mine-1",
				"My issue",
				"2026-01-01 00:00:01.000",
				OWNER,
			);
			await insertIssueAt(
				"theirs-1",
				"Someone else's issue",
				"2026-01-01 00:00:02.000",
				OTHER,
			);

			const res = await app.request("/issues/mine", {}, env);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(titlesOf(body)).toEqual(["My issue"]);
		});

		// 他人の Issue が本文のどこにも混ざらないこと。`data` だけを見ていると
		// total が全件のままという退行を見逃す。
		it("counts only the caller's issues in total", async () => {
			await insertIssueAt(
				"mine-1",
				"My issue",
				"2026-01-01 00:00:01.000",
				OWNER,
			);
			await insertIssueAt(
				"theirs-1",
				"Theirs",
				"2026-01-01 00:00:02.000",
				OTHER,
			);
			await insertIssueAt(
				"theirs-2",
				"Theirs 2",
				"2026-01-01 00:00:03.000",
				OTHER,
			);

			const res = await app.request("/issues/mine", {}, env);
			const body = await readBody(res);
			expect(body.total).toBe(1);
		});

		// 起票直後に自分の一覧へ導線を繋ぐのが Issue #68 の目的なので、
		// POST で作った Issue がそのまま出てくることを経路として確認する。
		it("includes an issue just created through POST /issues", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request("/issues/mine", {}, env);
			const body = await readBody(res);
			expect(body.data.map((row: IssueBody) => row.id)).toEqual([created.id]);
		});

		// 起票していないユーザーには空を返す。他人の分が漏れていれば落ちる。
		it("returns an empty list for a user with no issues", async () => {
			await insertIssueAt(
				"theirs-1",
				"Theirs",
				"2026-01-01 00:00:01.000",
				OTHER,
			);

			const res = await app.request("/issues/mine", {}, env);
			const body = await readBody(res);
			expect(body.data).toEqual([]);
			expect(body.total).toBe(0);
		});

		// 所有者が NULL の行（user_id カラム追加前の既存行）を
		// 誰かの一覧に混ぜない。`user_id = ?` が消えると NULL 行まで出る。
		it("does not include ownerless legacy rows", async () => {
			await env.DB.prepare(
				`INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id)
         VALUES ('legacy-1', 'Legacy', 'No owner', 'community', 0, 0, NULL)`,
			).run();

			const res = await app.request("/issues/mine", {}, env);
			const body = await readBody(res);
			expect(body.data).toEqual([]);
			expect(body.total).toBe(0);
		});

		it("returns issues newest first", async () => {
			await insertIssueAt("mine-1", "Oldest", "2026-01-01 00:00:01.000", OWNER);
			await insertIssueAt("mine-2", "Middle", "2026-01-01 00:00:02.000", OWNER);
			await insertIssueAt("mine-3", "Newest", "2026-01-01 00:00:03.000", OWNER);

			const res = await app.request("/issues/mine", {}, env);
			const body = await readBody(res);
			expect(titlesOf(body)).toEqual(["Newest", "Middle", "Oldest"]);
		});

		it("filters by status", async () => {
			await insertIssueAt(
				"mine-1",
				"Open one",
				"2026-01-01 00:00:01.000",
				OWNER,
			);
			await insertIssueAt(
				"mine-2",
				"Closed one",
				"2026-01-01 00:00:02.000",
				OWNER,
			);
			await env.DB.prepare(
				"UPDATE issues SET status = 'closed' WHERE id = 'mine-2'",
			).run();

			const res = await app.request("/issues/mine?status=closed", {}, env);
			const body = await readBody(res);
			expect(titlesOf(body)).toEqual(["Closed one"]);
			expect(body.total).toBe(1);
		});

		it("filters by scope", async () => {
			await insertIssueAt(
				"mine-1",
				"Community",
				"2026-01-01 00:00:01.000",
				OWNER,
			);
			await insertIssueAt(
				"mine-2",
				"National",
				"2026-01-01 00:00:02.000",
				OWNER,
			);
			await env.DB.prepare(
				"UPDATE issues SET scope = 'national' WHERE id = 'mine-2'",
			).run();

			const res = await app.request("/issues/mine?scope=national", {}, env);
			const body = await readBody(res);
			expect(titlesOf(body)).toEqual(["National"]);
		});

		// 公開一覧と同じクエリ検証を通っていること。
		// 別実装を書き起こすと、こちらだけ上限が抜ける。
		it("rejects limit above the maximum", async () => {
			const res = await app.request("/issues/mine?limit=101", {}, env);
			expect(res.status).toBe(400);
			const body = await readBody(res);
			expect(body.error.fieldErrors.limit).toBeDefined();
		});

		it("rejects duplicated query parameters", async () => {
			const res = await app.request("/issues/mine?limit=5&limit=1", {}, env);
			expect(res.status).toBe(400);
		});

		it("supports limit and offset", async () => {
			for (let i = 1; i <= 3; i++) {
				await insertIssueAt(
					`mine-${i}`,
					`Issue ${i}`,
					`2026-01-01 00:00:0${i}.000`,
					OWNER,
				);
			}

			const res = await app.request("/issues/mine?limit=1&offset=1", {}, env);
			const body = await readBody(res);
			expect(titlesOf(body)).toEqual(["Issue 2"]);
			expect(body.total).toBe(3);
		});

		// カーソルページングも公開一覧と同じ仕様。
		// 他人の Issue はページを跨いでも混ざらない。
		it("paginates with a cursor without leaking other users' issues", async () => {
			for (let i = 1; i <= 3; i++) {
				await insertIssueAt(
					`mine-${i}`,
					`Mine ${i}`,
					`2026-01-01 00:00:0${i}.000`,
					OWNER,
				);
				await insertIssueAt(
					`theirs-${i}`,
					`Theirs ${i}`,
					`2026-01-01 00:00:0${i}.500`,
					OTHER,
				);
			}

			const page1 = await readBody(
				await app.request("/issues/mine?limit=2", {}, env),
			);
			expect(titlesOf(page1)).toEqual(["Mine 3", "Mine 2"]);
			expect(typeof page1.next_cursor).toBe("string");

			const page2 = await readBody(
				await app.request(
					`/issues/mine?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
					{},
					env,
				),
			);
			expect(titlesOf(page2)).toEqual(["Mine 1"]);
			expect(page2.next_cursor).toBeNull();
		});

		// 自分の Issue でも内部フィールドは返さない。
		// 「自分のものだから user_id を出してよい」と広げると、
		// 公開一覧と形が変わってクライアント側の型が分岐する。
		it("returns exactly the public keys", async () => {
			await createIssue({ ...validIssue, category: "infrastructure" });

			const res = await app.request("/issues/mine", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(Object.keys(body.data[0]).sort()).toEqual(
				[...PUBLIC_ISSUE_COLUMNS_FOR_TEST].sort(),
			);
		});

		// 所有者で絞る並びにもインデックスが効いていること。
		//
		// `idx_issues_user_id`（user_id 単独、0002）だけだと絞り込みは効くが
		// 並べ替えが残り、20 件出すのに自分の Issue を全部読んでソートする。
		// D1 は読み取り行数で課金されるため、投稿数が増えるほどコストが線形に増える。
		// 公開一覧に対する同名のテストと対になっており、
		// migrations/0004 のインデックスが落ちるとプランに TEMP B-TREE が戻る。
		it("uses an index instead of sorting the caller's whole history", async () => {
			const plan = await env.DB.prepare(
				`EXPLAIN QUERY PLAN SELECT id FROM issues WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
				.bind(OWNER, 4)
				.all<{ detail: string }>();

			const detail = plan.results.map((row) => row.detail).join("\n");
			expect(detail).toContain("idx_issues_user_id_created_at");
			expect(detail).not.toContain("TEMP B-TREE");
		});

		// セッショントークン以外（OAuth トークン / API キー）では通さない。
		// 書き込み系と同じ理由で、スコープを見ない以上ここも session_token に絞る。
		it("rejects a non-session token", async () => {
			await createIssue();

			setMockUserId(OWNER, "oauth_token");
			const res = await app.request("/issues/mine", {}, env);
			expect(res.status).toBe(401);
		});
	});

	// --- 公開レスポンスに内部フィールドを載せない ---
	describe("Public response fields", () => {
		/** 公開 GET が返してよいキー。ここに無いものはレスポンスに出てはならない。 */
		const PUBLIC_KEYS = [
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
		];

		beforeEach(async () => {
			setMockUserId("user_2abcSECRETclerkid");
		});

		/** 所有者として PATCH を叩く。書き込み系のレスポンス検査で使う。 */
		async function patchIssue(id: string, data: Record<string, unknown>) {
			return app.request(
				`/issues/${id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify(data),
				},
				env,
			);
		}

		/** 所有者として DELETE を叩く。書き込み系のレスポンス検査で使う。 */
		async function deleteIssue(id: string) {
			return app.request(
				`/issues/${id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
		}

		it("does not expose user_id in GET list", async () => {
			await createIssue();

			setMockUserId(null);
			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(body.data[0]).not.toHaveProperty("user_id");
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("does not expose user_id in GET by id", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(`/issues/${created.id}`, {}, env);
			const body = await readBody(res);
			expect(body).not.toHaveProperty("user_id");
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys in GET list", async () => {
			await createIssue({ ...validIssue, category: "infrastructure" });

			setMockUserId(null);
			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
		});

		// 一覧はフィルタ・ページングでクエリの組み立てが変わるため、
		// 絞り込み無しの経路だけでなく、条件付きの経路でも公開キーだけが
		// 返ることを確認する（特定条件でのみ漏れる退行を検出するため）。
		it("returns exactly the public keys when filtered by scope", async () => {
			await createIssue();
			await createIssue({ ...validIssue, scope: "national" });

			setMockUserId(null);
			const res = await app.request("/issues?scope=community", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys when filtered by status", async () => {
			await createIssue();

			setMockUserId(null);
			const res = await app.request("/issues?status=open", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys on a paginated page", async () => {
			// どの行が返るかまで固定したいので、時刻を明示した行を直接入れる。
			// user_id は漏洩検証の対象なので、この describe が使う値に合わせる。
			const owner = "user_2abcSECRETclerkid";
			await insertIssueAt(
				"page-1",
				"Issue 1",
				"2026-01-01 00:00:01.000",
				owner,
			);
			await insertIssueAt(
				"page-2",
				"Issue 2",
				"2026-01-01 00:00:02.000",
				owner,
			);
			await insertIssueAt(
				"page-3",
				"Issue 3",
				"2026-01-01 00:00:03.000",
				owner,
			);

			setMockUserId(null);
			const res = await app.request("/issues?limit=1&offset=1", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			// 2 ページ目が「新しい順で 2 番目」の行であること。
			// キーの集合だけを見ていると、どの行を返しても通ってしまう。
			expect(titlesOf(body)).toEqual(["Issue 2"]);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys in GET by id", async () => {
			const createRes = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(`/issues/${created.id}`, {}, env);
			const body = await readBody(res);
			expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
		});

		// 書き込み系（POST / PATCH / DELETE）は認証必須だが、返しているのは
		// GET と同じテーブルの行である以上、公開してよいキーの集合は同じ。
		// 経路ごとにレスポンスの形が違うと、フロントが内部フィールドに依存する
		// コードを書いてしまい、後から消せなくなる。
		it("returns exactly the public keys in POST", async () => {
			const res = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			expect(res.status).toBe(201);
			const body = await readBody(res);
			expect(body).not.toHaveProperty("user_id");
			expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys in PATCH", async () => {
			const createRes = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			const created = await readBody(createRes);

			const res = await patchIssue(created.id, { title: "Updated title" });
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body).not.toHaveProperty("user_id");
			expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys in DELETE", async () => {
			const createRes = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			const created = await readBody(createRes);

			const res = await deleteIssue(created.id);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body).not.toHaveProperty("user_id");
			expect(Object.keys(body).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		// キーを落とすだけの実装（例: 全カラムを undefined で返す）に退行しても
		// キー集合の検査は通ってしまうため、値がそのまま返っていることも見る。
		it("keeps the public field values intact in write responses", async () => {
			const createRes = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			const created = await readBody(createRes);

			expect(created.title).toBe(validIssue.title);
			expect(created.description).toBe(validIssue.description);
			expect(created.scope).toBe(validIssue.scope);
			expect(created.status).toBe("open");
			expect(created.latitude).toBe(validIssue.latitude);
			expect(created.longitude).toBe(validIssue.longitude);
			expect(created.category).toBe("infrastructure");
			expect(created.id).toBeDefined();
			expect(created.created_at).toBeDefined();
			expect(created.updated_at).toBeDefined();

			const patchRes = await patchIssue(created.id, { title: "Updated title" });
			const patched = await readBody(patchRes);
			expect(patched.id).toBe(created.id);
			expect(patched.title).toBe("Updated title");
			expect(patched.description).toBe(validIssue.description);
			expect(patched.category).toBe("infrastructure");

			const delRes = await deleteIssue(created.id);
			const deleted = await readBody(delRes);
			expect(deleted.id).toBe(created.id);
			expect(deleted.title).toBe("Updated title");
			expect(deleted.category).toBe("infrastructure");
		});

		it("keeps the public field values intact", async () => {
			const createRes = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(`/issues/${created.id}`, {}, env);
			const body = await readBody(res);
			expect(body.id).toBe(created.id);
			expect(body.title).toBe(validIssue.title);
			expect(body.description).toBe(validIssue.description);
			expect(body.scope).toBe(validIssue.scope);
			expect(body.status).toBe("open");
			expect(body.latitude).toBe(validIssue.latitude);
			expect(body.longitude).toBe(validIssue.longitude);
			expect(body.category).toBe("infrastructure");
			expect(body.created_at).toBeDefined();
			expect(body.updated_at).toBeDefined();
		});

		it("returns category as null when it was not set", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(`/issues/${created.id}`, {}, env);
			const body = await readBody(res);
			expect(body.category).toBeNull();
		});

		it("does not expose future internal columns added to the table", async () => {
			// カラム追加で自動的に公開されてしまう構造を防ぐための回帰テスト。
			// 一時テーブルではなく実テーブルに足すと後続テストへ影響するため、
			// このテスト内で追加して最後に元へ戻す。
			await env.DB.exec(
				"ALTER TABLE issues ADD COLUMN internal_note TEXT DEFAULT 'secret-internal-note'",
			);
			try {
				// POST（書き込み系も同じ防御が効いていること）
				const createRes = await createIssue();
				const created = await readBody(createRes);
				expect(JSON.stringify(created)).not.toContain("secret-internal-note");
				expect(created).not.toHaveProperty("internal_note");

				// PATCH
				const patchRes = await patchIssue(created.id, { title: "Updated" });
				const patched = await readBody(patchRes);
				expect(JSON.stringify(patched)).not.toContain("secret-internal-note");
				expect(patched).not.toHaveProperty("internal_note");

				setMockUserId(null);
				const listRes = await app.request("/issues", {}, env);
				const listBody = await readBody(listRes);
				expect(JSON.stringify(listBody)).not.toContain("secret-internal-note");
				expect(listBody.data[0]).not.toHaveProperty("internal_note");

				const id = listBody.data[0].id;
				const byIdRes = await app.request(`/issues/${id}`, {}, env);
				const byIdBody = await readBody(byIdRes);
				expect(JSON.stringify(byIdBody)).not.toContain("secret-internal-note");
				expect(byIdBody).not.toHaveProperty("internal_note");

				// DELETE（レコードを消すので最後に叩く）
				setMockUserId("user_2abcSECRETclerkid");
				const delRes = await deleteIssue(created.id);
				const deleted = await readBody(delRes);
				expect(JSON.stringify(deleted)).not.toContain("secret-internal-note");
				expect(deleted).not.toHaveProperty("internal_note");
			} finally {
				await env.DB.exec("ALTER TABLE issues DROP COLUMN internal_note");
			}
		});

		// SELECT でカラムを絞る層と、返す直前に絞る層の二段構えにしているため、
		// HTTP 経由のテストだけでは片方を外しても結果が変わらず、退行に気づけない。
		// ここでは各層の部品を直接呼んで、それぞれが単独で効いていることを確認する。
		describe("Defence layers", () => {
			it("keeps the SELECT clause free of internal columns", async () => {
				// SELECT 層: クエリ自体が user_id を取ってこないこと。
				// DTO 層を外しても user_id が漏れない、という形で確認する。
				await createIssue();

				const row = await env.DB.prepare(
					`SELECT ${PUBLIC_SELECT_FOR_TEST} FROM issues LIMIT 1`,
				).first<Record<string, unknown>>();

				expect(row).not.toBeNull();
				expect(row).not.toHaveProperty("user_id");
				expect(Object.keys(row ?? {}).sort()).toEqual([...PUBLIC_KEYS].sort());
			});

			// 書き込み系も SELECT 層（= RETURNING 句）で絞っていること。
			//
			// 二段構えの片方だけを外しても、もう片方が防いでしまうため
			// レスポンスの検査では退行に気づけない（例: POST だけ
			// `RETURNING *` に戻しても toPublicIssue が落としてしまう）。
			// 発行された SQL そのものを見て、各経路が公開カラムだけを
			// 返すよう書かれていることを確かめる。
			it("returns only public columns from write queries", async () => {
				const prepareSpy = vi.spyOn(env.DB, "prepare");
				try {
					const createRes = await createIssue();
					const created = await readBody(createRes);
					await patchIssue(created.id, { title: "Updated" });
					await deleteIssue(created.id);

					const returningQueries = prepareSpy.mock.calls
						.map(([sql]) => sql)
						.filter((sql) => sql.includes("RETURNING"));

					// POST / PATCH / DELETE の 3 本が拾えていること
					// （経路が RETURNING を使わなくなったらここで気づく）
					expect(returningQueries).toHaveLength(3);
					for (const sql of returningQueries) {
						expect(sql).not.toMatch(/RETURNING\s+\*/);
						expect(sql).toContain(`RETURNING ${PUBLIC_SELECT_FOR_TEST}`);
					}
				} finally {
					prepareSpy.mockRestore();
				}
			});

			it("strips internal fields even when the row carries them", async () => {
				// DTO 層: SELECT * に退行した場合でも、返す直前に落ちること。
				// 実際に SELECT * で取った行を GET と同じ整形にかけて確かめる。
				await createIssue();

				const rawQuery = env.DB.prepare("SELECT * FROM issues LIMIT 1");
				const raw = await rawQuery.first<Record<string, unknown>>();

				// 前提: 生の行には user_id が含まれている
				expect(raw).toHaveProperty("user_id", "user_2abcSECRETclerkid");

				const shaped = toPublicIssueForTest(raw ?? {});
				expect(shaped).not.toHaveProperty("user_id");
				expect(Object.keys(shaped).sort()).toEqual([...PUBLIC_KEYS].sort());
			});
		});
	});

	// --- PATCH /issues/:id ---
	describe("PATCH /issues/:id", () => {
		it("updates title", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "Updated title" }),
				},
				env,
			);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.title).toBe("Updated title");
			expect(body.description).toBe(validIssue.description);
		});

		it("updates status", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ status: "triaged" }),
				},
				env,
			);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.status).toBe("triaged");
		});

		it("updates updated_at timestamp", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "New title" }),
				},
				env,
			);
			const body = await readBody(res);

			// 値が「存在する」だけでは PATCH の挙動を検証したことにならない。
			// `updated_at` は NOT NULL DEFAULT なので INSERT 時点で必ず入っており、
			// 更新処理を消しても toBeDefined() は通ってしまう。
			// 作成時の値から実際に進んだことを見る。
			expect(body.updated_at).not.toBe(created.updated_at);
			expect(toMillis(body.updated_at)).toBeGreaterThan(
				toMillis(created.updated_at),
			);

			// レスポンスだけを見ていると「DB には書かず、返す JSON の
			// updated_at だけ差し替える」実装でも通ってしまう。
			// 読み直して、進んだ値が永続化されていることまで確認する。
			const stored = await readStoredIssue(created.id);
			expect(stored.updated_at).toBe(body.updated_at);
		});

		it("leaves created_at untouched while advancing updated_at", async () => {
			// `updated_at` を進める実装が、ついでに `created_at` まで
			// 書き換えていないこと（例: 両方に NOW を入れる退行）を見る。
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "New title" }),
				},
				env,
			);
			const body = await readBody(res);

			expect(body.created_at).toBe(created.created_at);
			expect(toMillis(body.updated_at)).toBeGreaterThan(
				toMillis(body.created_at),
			);

			const stored = await readStoredIssue(created.id);
			expect(stored.created_at).toBe(created.created_at);
			expect(toMillis(stored.updated_at)).toBeGreaterThan(
				toMillis(stored.created_at),
			);
		});

		it("advances updated_at on every consecutive update", async () => {
			// 同一ミリ秒内の連続更新で値が動かないと、
			// 「最終更新順に並べる」「キャッシュ無効化」が壊れる。
			// 待ち時間を入れずに連続 PATCH して、毎回進むことを確認する。
			//
			// 値が進むことは時計の解像度ではなく UPDATE 文が保証している
			// （`NEXT_UPDATED_AT_SQL`: 現在時刻と「前の値 +1ms」の遅い方を採る）。
			// 以前はミリ秒精度の `'now'` をそのまま入れており、
			// 経路が速いと同一ミリ秒に収まって稀に落ちていた（Issue #46）。
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const timestamps: string[] = [created.updated_at];
			for (const title of ["First", "Second", "Third"]) {
				const res = await app.request(
					`/issues/${created.id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Origin: ALLOWED_ORIGIN,
						},
						body: JSON.stringify({ title }),
					},
					env,
				);
				const body = await readBody(res);

				// レスポンスと DB の値が一致していること（＝実際に書かれたこと）を
				// 各回で確かめたうえで、DB 側の値を並びの検証に使う
				const stored = await readStoredIssue(created.id);
				expect(body.updated_at).toBe(stored.updated_at);
				timestamps.push(stored.updated_at);
			}

			// 同じ値が一度でも並べば、その更新は時刻を進められていない
			expect(new Set(timestamps).size).toBe(timestamps.length);
			// 隣り合う 2 つを取り出して、常に後ろの方が新しいことを見る
			const pairs = timestamps
				.slice(1)
				.map((current, index) => [timestamps[index], current] as const);
			for (const [previous, current] of pairs) {
				expect(toMillis(current)).toBeGreaterThan(toMillis(previous ?? ""));
			}
		});

		it("stores timestamps in a format that sorts chronologically as text", async () => {
			// `ORDER BY updated_at` は文字列比較で効くため、書式が崩れると
			// 並び順が壊れる。秒精度の既存行と混在しても順序が保たれることを見る。
			const createRes = await createIssue();
			const created = await readBody(createRes);

			// DEFAULT（秒精度）で入った古い行を模した値を直接仕込む
			await env.DB.prepare(
				"UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?",
			)
				.bind("2000-01-01 00:00:00", "2000-01-01 00:00:00", created.id)
				.run();

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "New title" }),
				},
				env,
			);
			const body = await readBody(res);

			// 実装が書く書式は `YYYY-MM-DD HH:MM:SS.SSS`
			expect(body.updated_at).toMatch(TIMESTAMP_FORMAT);
			// 秒精度の古い値との比較が、文字列としても時系列順になる
			expect(body.updated_at > "2000-01-01 00:00:00").toBe(true);
		});

		it("returns 404 for non-existent id", async () => {
			const res = await app.request(
				"/issues/nonexistent",
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "Updated" }),
				},
				env,
			);
			expect(res.status).toBe(404);
		});

		it("rejects empty body", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({}),
				},
				env,
			);
			expect(res.status).toBe(400);
		});

		// `UpdateIssueSchema` は `CreateIssueSchema` とは別定義なので、
		// POST 側の境界を固めても PATCH 側は守られない。同じ制限を独立に押さえる。
		describe("body string length validation", () => {
			/** 作成済みの Issue に対して PATCH を投げる。 */
			async function patchIssue(id: string, data: unknown) {
				return app.request(
					`/issues/${id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Origin: ALLOWED_ORIGIN,
						},
						body: JSON.stringify(data),
					},
					env,
				);
			}

			it("rejects an empty title", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, { title: "" });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.title).toBeDefined();
			});

			it("rejects a title above the maximum length", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, { title: "a".repeat(201) });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.title).toBeDefined();
			});

			it("accepts a title at the maximum length", async () => {
				const created = await readBody(await createIssue());
				const title = "a".repeat(200);

				const res = await patchIssue(created.id, { title });
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.title).toBe(title);
			});

			it("rejects an empty description", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, { description: "" });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.description).toBeDefined();
			});

			it("rejects a description above the maximum length", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, {
					description: "d".repeat(5001),
				});
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.description).toBeDefined();
			});

			it("accepts a description at the maximum length", async () => {
				const created = await readBody(await createIssue());
				const description = "d".repeat(5000);

				const res = await patchIssue(created.id, { description });
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.description).toBe(description);
			});

			it("rejects an empty category", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, { category: "" });
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.category).toBeDefined();
			});

			it("rejects a category above the maximum length", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, {
					category: "c".repeat(101),
				});
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.category).toBeDefined();
			});

			it("accepts a category at the maximum length", async () => {
				const created = await readBody(await createIssue());
				const category = "c".repeat(100);

				const res = await patchIssue(created.id, { category });
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.category).toBe(category);
			});

			// `category` は nullable なので、null は長さ検証の対象外として通る。
			// 「空文字列は弾くが null は通す」の区別が失われていないことを見る。
			it("accepts a null category", async () => {
				const created = await readBody(
					await createIssue({ ...validIssue, category: "infrastructure" }),
				);

				const res = await patchIssue(created.id, { category: null });
				expect(res.status).toBe(200);
				const body = await readBody(res);
				expect(body.category).toBeNull();
			});

			// 400 を返すだけでなく、行が書き換わっていないこと。
			// 「検証は落とすが UPDATE はする」退行はレスポンスの検査では拾えない。
			it("does not update the row when the length check fails", async () => {
				const created = await readBody(await createIssue());

				const res = await patchIssue(created.id, {
					description: "d".repeat(5001),
				});
				expect(res.status).toBe(400);

				const stored = await readStoredIssue(created.id);
				expect(stored.description).toBe(validIssue.description);
				expect(stored.updated_at).toBe(created.updated_at);
			});
		});

		describe("body type validation", () => {
			it("rejects a numeric title", async () => {
				const created = await readBody(await createIssue());

				const res = await app.request(
					`/issues/${created.id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Origin: ALLOWED_ORIGIN,
						},
						body: JSON.stringify({ title: 123 }),
					},
					env,
				);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.title).toBeDefined();
			});

			it("rejects an unknown status", async () => {
				const created = await readBody(await createIssue());

				const res = await app.request(
					`/issues/${created.id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Origin: ALLOWED_ORIGIN,
						},
						body: JSON.stringify({ status: "bogus" }),
					},
					env,
				);
				expect(res.status).toBe(400);
				const body = await readBody(res);
				expect(body.error.fieldErrors.status).toBeDefined();
			});
		});
	});

	// --- DELETE /issues/:id ---
	describe("DELETE /issues/:id", () => {
		it("deletes an issue and returns the deleted issue", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const res = await app.request(
				`/issues/${created.id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(200);
			const body = await readBody(res);
			expect(body.id).toBe(created.id);
			expect(body.title).toBe(validIssue.title);
		});

		it("makes the issue unreachable via GET afterwards", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const delRes = await app.request(
				`/issues/${created.id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(delRes.status).toBe(200);

			const res = await app.request(`/issues/${created.id}`, {}, env);
			expect(res.status).toBe(404);
		});

		it("returns 404 for non-existent id", async () => {
			const res = await app.request(
				"/issues/nonexistent",
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(404);
			const body = await readBody(res);
			expect(body.error).toBe("Issue not found");
		});

		it("returns 401 and does not delete when unauthenticated", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			setMockUserId(null);
			const res = await app.request(
				`/issues/${created.id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(401);
			const body = await readBody(res);
			expect(body.error).toBe("Unauthorized");

			// 401 を返すだけでなく、実際にレコードが残っていること
			const check = await app.request(`/issues/${created.id}`, {}, env);
			expect(check.status).toBe(200);
		});
	});

	// --- Ownership ---
	describe("Ownership", () => {
		/** owner-A が作成した Issue を返す。以降 attacker-Z として操作するテスト用。 */
		async function createIssueAsOwner() {
			setMockUserId("owner-A");
			const res = await createIssue();
			const created = await readBody(res);
			setMockUserId("attacker-Z");
			return created;
		}

		it("returns 403 for PATCH by a non-owner", async () => {
			const created = await createIssueAsOwner();

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "Hijacked" }),
				},
				env,
			);
			expect(res.status).toBe(403);
			const body = await readBody(res);
			expect(body.error).toBe("Forbidden");
		});

		it("does not modify the issue on PATCH by a non-owner", async () => {
			const created = await createIssueAsOwner();

			await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "Hijacked" }),
				},
				env,
			);

			const res = await app.request(`/issues/${created.id}`, {}, env);
			const body = await readBody(res);
			expect(body.title).toBe(validIssue.title);
		});

		it("returns 403 for DELETE by a non-owner", async () => {
			const created = await createIssueAsOwner();

			const res = await app.request(
				`/issues/${created.id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(403);
			const body = await readBody(res);
			expect(body.error).toBe("Forbidden");
		});

		it("does not delete the issue on DELETE by a non-owner", async () => {
			const created = await createIssueAsOwner();

			await app.request(
				`/issues/${created.id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);

			const res = await app.request(`/issues/${created.id}`, {}, env);
			expect(res.status).toBe(200);
		});

		it("allows the owner to PATCH and DELETE", async () => {
			setMockUserId("owner-A");
			const createRes = await createIssue();
			const created = await readBody(createRes);

			const patchRes = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ title: "Updated by owner" }),
				},
				env,
			);
			expect(patchRes.status).toBe(200);

			const delRes = await app.request(
				`/issues/${created.id}`,
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(delRes.status).toBe(200);
		});

		it("returns 403 before validation errors for a non-owner", async () => {
			const created = await createIssueAsOwner();

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: ALLOWED_ORIGIN,
					},
					body: JSON.stringify({ scope: "not-a-scope" }),
				},
				env,
			);
			expect(res.status).toBe(403);
		});

		it("returns 403 for an issue with no owner (legacy rows)", async () => {
			await env.DB.prepare(
				`INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id)
         VALUES ('legacy-1', 'Legacy', 'No owner', 'community', 0, 0, NULL)`,
			).run();

			const res = await app.request(
				"/issues/legacy-1",
				{ method: "DELETE", headers: { Origin: ALLOWED_ORIGIN } },
				env,
			);
			expect(res.status).toBe(403);
		});
	});
});
