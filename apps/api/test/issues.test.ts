import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let mockUserId: string | null = "test-user-123";

vi.mock("@hono/clerk-auth", () => ({
	clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
	getAuth: () => ({ userId: mockUserId }),
}));

import { createApp } from "../src/index";
import {
	PUBLIC_SELECT as PUBLIC_SELECT_FOR_TEST,
	toPublicIssue as toPublicIssueForTest,
} from "../src/routes/issues";

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

const validIssue: IssueInput = {
	title: "Broken streetlight",
	description: "The streetlight on Main St is not working",
	scope: "community",
	latitude: 35.68,
	longitude: 139.76,
};

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
		mockUserId = "test-user-123";
	});

	// --- Authentication ---
	describe("Authentication", () => {
		it("returns 401 for unauthenticated POST", async () => {
			mockUserId = null;
			const res = await createIssue();
			expect(res.status).toBe(401);
			const body = await readBody(res);
			expect(body.error).toBe("Unauthorized");
		});

		it("returns 401 for unauthenticated PATCH", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			mockUserId = null;
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
			mockUserId = null;
			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
		});

		it("allows unauthenticated GET by id", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			mockUserId = null;
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
			await createIssue({ ...validIssue, title: "Issue 1" });
			await createIssue({ ...validIssue, title: "Issue 2" });
			await createIssue({ ...validIssue, title: "Issue 3" });

			const res = await app.request("/issues?limit=2&offset=0", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(2);
			expect(body.total).toBe(3);

			const res2 = await app.request("/issues?limit=2&offset=2", {}, env);
			const body2 = await readBody(res2);
			expect(body2.data).toHaveLength(1);
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
			mockUserId = "user_2abcSECRETclerkid";
		});

		it("does not expose user_id in GET list", async () => {
			await createIssue();

			mockUserId = null;
			const res = await app.request("/issues", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(body.data[0]).not.toHaveProperty("user_id");
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("does not expose user_id in GET by id", async () => {
			const createRes = await createIssue();
			const created = await readBody(createRes);

			mockUserId = null;
			const res = await app.request(`/issues/${created.id}`, {}, env);
			const body = await readBody(res);
			expect(body).not.toHaveProperty("user_id");
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys in GET list", async () => {
			await createIssue({ ...validIssue, category: "infrastructure" });

			mockUserId = null;
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

			mockUserId = null;
			const res = await app.request("/issues?scope=community", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys when filtered by status", async () => {
			await createIssue();

			mockUserId = null;
			const res = await app.request("/issues?status=open", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys on a paginated page", async () => {
			await createIssue({ ...validIssue, title: "Issue 1" });
			await createIssue({ ...validIssue, title: "Issue 2" });
			await createIssue({ ...validIssue, title: "Issue 3" });

			mockUserId = null;
			const res = await app.request("/issues?limit=1&offset=1", {}, env);
			const body = await readBody(res);
			expect(body.data).toHaveLength(1);
			expect(Object.keys(body.data[0]).sort()).toEqual([...PUBLIC_KEYS].sort());
			expect(JSON.stringify(body)).not.toContain("user_2abcSECRETclerkid");
		});

		it("returns exactly the public keys in GET by id", async () => {
			const createRes = await createIssue({
				...validIssue,
				category: "infrastructure",
			});
			const created = await readBody(createRes);

			mockUserId = null;
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

			mockUserId = null;
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

			mockUserId = null;
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

				mockUserId = null;
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
			expect(body.updated_at).toBeDefined();
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

			mockUserId = null;
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
			mockUserId = "owner-A";
			const res = await createIssue();
			const created = await readBody(res);
			mockUserId = "attacker-Z";
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
			mockUserId = "owner-A";
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
