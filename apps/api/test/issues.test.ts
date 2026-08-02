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
	PUBLIC_SELECT as PUBLIC_SELECT_FOR_TEST,
	toPublicIssue as toPublicIssueForTest,
} from "../src/routes/issues";
import { setMockUserId } from "./helpers/clerk-mock";

const app = createApp();

/**
 * 書き込み系は Origin 検証を通す必要があるため、許可オリジンを付けて叩く。
 * Origin 検証そのもののテストは `csrf.test.ts` にある。
 */
const ALLOWED_ORIGIN = "http://localhost:3000";

const MIGRATION =
	"CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), title TEXT NOT NULL, description TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('personal', 'community', 'municipality', 'national', 'global')), status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'in_progress', 'review', 'resolved', 'closed')), latitude REAL NOT NULL, longitude REAL NOT NULL, category TEXT, user_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));";

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
		await env.DB.exec(MIGRATION);
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
			expect(body.user_id).toBe("test-user-123");
			expect(body.id).toBeDefined();
			expect(body.created_at).toBeDefined();
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
				await createIssue();

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
			// 秒精度だと同一秒内の連続更新で値が動かず、
			// 「最終更新順に並べる」「キャッシュ無効化」が壊れる。
			// 待ち時間を入れずに連続 PATCH して、毎回進むことを確認する。
			//
			// 1 リクエストが認証・所有者確認・UPDATE を経るため 1ms 以上かかり、
			// ミリ秒精度なら値は必ず進む。ここが稀に落ちるようなら、
			// 経路が速くなって同一ミリ秒に収まった可能性を疑うこと。
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
