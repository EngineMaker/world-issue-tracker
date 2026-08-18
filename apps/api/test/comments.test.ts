import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// issues.test.ts と同じく、`@hono/clerk-auth` ではなく内部の `@clerk/backend` を
// モックして `clerkMiddleware` の本体は実物を通す（理由は helpers/clerk-mock.ts）。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";
import {
	PUBLIC_COMMENT_COLUMNS,
	toPublicComment,
} from "../src/routes/comments";
import { setMockUserId } from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

const app = createApp();

/** 書き込み系は Origin 検証を通す必要があるため、許可オリジンを付けて叩く。 */
const ALLOWED_ORIGIN = "http://localhost:3000";

// biome-ignore lint/suspicious/noExplicitAny: テストからレスポンスを緩く読むための意図的な型
type Body = Record<string, any>;

async function readBody(res: Response): Promise<Body> {
	return (await res.json()) as Body;
}

/** 実装が書き込むタイムスタンプの書式（`YYYY-MM-DD HH:MM:SS.SSS`）。 */
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/**
 * コメントを付ける先の Issue を DB へ直接投入する。
 *
 * API 経由で作ると認証状態の切り替えがテストの本筋と絡むため、
 * 前提データはここで用意する。
 */
async function insertIssue(id: string): Promise<string> {
	await env.DB.prepare(
		`INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			"街灯が切れている",
			"夜道が暗い",
			"community",
			35.68,
			139.76,
			"issue-author",
		)
		.run();
	return id;
}

/** `created_at` を明示指定したコメントを DB へ直接投入する。並び順の検証用。 */
async function insertCommentAt(
	id: string,
	issueId: string,
	body: string,
	createdAt: string,
	userId = "test-user-123",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO comments (id, issue_id, user_id, body, created_at)
     VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(id, issueId, userId, body, createdAt)
		.run();
}

async function postComment(
	issueId: string,
	body: unknown,
	init: RequestInit = {},
): Promise<Response> {
	return app.request(
		`/issues/${issueId}/comments`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ALLOWED_ORIGIN,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
			...init,
		},
		env,
	);
}

/** コメントを削除する。書き込み系なので Origin を付けて叩く。 */
async function deleteComment(
	issueId: string,
	commentId: string,
	init: RequestInit = {},
): Promise<Response> {
	return app.request(
		`/issues/${issueId}/comments/${commentId}`,
		{
			method: "DELETE",
			headers: { Origin: ALLOWED_ORIGIN },
			...init,
		},
		env,
	);
}

/** その ID のコメントが DB に残っているか。物理削除の確認に使う。 */
async function commentExists(id: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT id FROM comments WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	return row !== null;
}

const ISSUE_ID = "issue-0001";

describe("Comments", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM comments");
		await env.DB.exec("DELETE FROM issues");
		setMockUserId("test-user-123");
		await insertIssue(ISSUE_ID);
	});

	// --- POST /issues/:id/comments ---
	describe("POST /issues/:id/comments", () => {
		it("コメントを作成して 201 を返す", async () => {
			const res = await postComment(ISSUE_ID, { body: "私も困っています" });

			expect(res.status).toBe(201);
			const created = await readBody(res);
			expect(created.body).toBe("私も困っています");
			expect(created.issue_id).toBe(ISSUE_ID);
			expect(created.id).toBeDefined();
			expect(created.created_at).toMatch(TIMESTAMP_FORMAT);
		});

		it("投稿者の user_id を保存する（レスポンスには載せない）", async () => {
			setMockUserId("commenter-999");
			const res = await postComment(ISSUE_ID, { body: "手伝えます" });
			const created = await readBody(res);

			// `user_id` は内部フィールド。公開レスポンスに含めないことを固定する
			expect(created).not.toHaveProperty("user_id");

			const stored = await env.DB.prepare("SELECT * FROM comments WHERE id = ?")
				.bind(created.id)
				.first<Body>();
			expect(stored?.user_id).toBe("commenter-999");
		});

		it("未認証なら 401 を返し、コメントを作らない", async () => {
			setMockUserId(null);
			const res = await postComment(ISSUE_ID, { body: "匿名で書く" });

			expect(res.status).toBe(401);
			expect(await readBody(res)).toEqual({ error: "Unauthorized" });

			// 401 を返しながら INSERT だけは走る、という壊れ方を拾う
			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM comments",
			).first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("セッショントークン以外（OAuth トークン）では 401 を返す", async () => {
			// 書き込みはセッショントークンだけを受け入れる（middleware/auth.ts）。
			// Issue 側と同じ制約がコメントにも効いていること。
			setMockUserId("test-user-123", "oauth_token");
			const res = await postComment(ISSUE_ID, { body: "トークンで書く" });

			expect(res.status).toBe(401);
			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM comments",
			).first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("Origin ヘッダが無ければ 403 を返し、コメントを作らない", async () => {
			// Cookie 経由の認証は攻撃者のサイトからでも成立するため、
			// 書き込みには Origin 検証が要る（middleware/origin.ts）
			const res = await app.request(
				`/issues/${ISSUE_ID}/comments`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ body: "CSRF" }),
				},
				env,
			);

			expect(res.status).toBe(403);
			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM comments",
			).first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("存在しない Issue には 404 を返し、コメントを作らない", async () => {
			const res = await postComment("no-such-issue", { body: "宛先が無い" });

			expect(res.status).toBe(404);
			expect(await readBody(res)).toEqual({ error: "Issue not found" });

			// 外部キーが効いていない状況でも、孤児コメントが残らないこと
			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM comments",
			).first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("空の本文を拒否する", async () => {
			const res = await postComment(ISSUE_ID, { body: "" });
			expect(res.status).toBe(400);
			const error = await readBody(res);
			expect(error.error.fieldErrors.body).toBeDefined();
		});

		it("空白だけの本文を拒否する", async () => {
			// `min(1)` は空文字しか弾かない。空白だけのコメントは一覧に
			// 意味のない行を増やすだけなので、trim してから検証する
			const res = await postComment(ISSUE_ID, { body: "   \n\t  " });
			expect(res.status).toBe(400);

			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM comments",
			).first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("本文の前後の空白を落として保存する", async () => {
			const res = await postComment(ISSUE_ID, { body: "  直しましょう  " });
			expect(res.status).toBe(201);
			expect((await readBody(res)).body).toBe("直しましょう");
		});

		it("上限を超える本文を拒否し、DB に書き込まない", async () => {
			// 長さ制限は入力チェックであると同時に D1 への書き込み量の保護でもある。
			// 400 を返していても手前で INSERT が走っていれば意味がない
			const res = await postComment(ISSUE_ID, { body: "あ".repeat(2001) });
			expect(res.status).toBe(400);

			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM comments",
			).first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("上限ちょうどの本文は受け付ける", async () => {
			// 拒否だけを固定すると上限を狭める退行を拾えないため、通る側も押さえる
			const body = "あ".repeat(2000);
			const res = await postComment(ISSUE_ID, { body });
			expect(res.status).toBe(201);
			expect((await readBody(res)).body).toBe(body);
		});

		it("本文が文字列でなければ拒否する", async () => {
			const res = await postComment(ISSUE_ID, { body: 123 });
			expect(res.status).toBe(400);
		});

		it("本文が無ければ拒否する", async () => {
			const res = await postComment(ISSUE_ID, {});
			expect(res.status).toBe(400);
		});

		it("壊れた JSON を 400 で返す", async () => {
			const res = await postComment(ISSUE_ID, "not json");
			expect(res.status).toBe(400);
			expect((await readBody(res)).error).toBe("Invalid JSON");
		});

		it("body 以外のフィールドは無視する（user_id を詐称できない）", async () => {
			const res = await postComment(ISSUE_ID, {
				body: "詐称の試み",
				user_id: "someone-else",
				id: "forged-id",
				created_at: "1999-01-01 00:00:00.000",
			});
			expect(res.status).toBe(201);
			const created = await readBody(res);

			expect(created.id).not.toBe("forged-id");
			const stored = await env.DB.prepare("SELECT * FROM comments WHERE id = ?")
				.bind(created.id)
				.first<Body>();
			expect(stored?.user_id).toBe("test-user-123");
			expect(stored?.created_at).toMatch(TIMESTAMP_FORMAT);
		});
	});

	// --- GET /issues/:id/comments ---
	describe("GET /issues/:id/comments", () => {
		it("未認証でも取得できる", async () => {
			await insertCommentAt(
				"c1",
				ISSUE_ID,
				"最初の一言",
				"2026-01-01 00:00:00.000",
			);

			setMockUserId(null);
			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);

			expect(res.status).toBe(200);
			const list = await readBody(res);
			expect(list.data).toHaveLength(1);
			expect(list.data[0].body).toBe("最初の一言");
			expect(list.total).toBe(1);
		});

		it("古い順に返す（会話として読める順序）", async () => {
			// 対話の場なので、Issue 一覧（新しい順）とは逆に古い順で並べる。
			// 時刻を固定した行を入れて、実行速度に依存させない
			await insertCommentAt("c2", ISSUE_ID, "2番目", "2026-01-02 00:00:00.000");
			await insertCommentAt("c1", ISSUE_ID, "1番目", "2026-01-01 00:00:00.000");
			await insertCommentAt("c3", ISSUE_ID, "3番目", "2026-01-03 00:00:00.000");

			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);

			expect(list.data.map((c: Body) => c.body)).toEqual([
				"1番目",
				"2番目",
				"3番目",
			]);
		});

		it("同一時刻のコメントも id で全順序が決まる", async () => {
			// created_at だけでは順序が不定になり、SQLite の返す順（実装依存）に委ねられる
			const at = "2026-01-01 00:00:00.000";
			await insertCommentAt("cc", ISSUE_ID, "B", at);
			await insertCommentAt("ca", ISSUE_ID, "A", at);
			await insertCommentAt("cb", ISSUE_ID, "C", at);

			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);

			expect(list.data.map((c: Body) => c.id)).toEqual(["ca", "cb", "cc"]);
		});

		it("他の Issue のコメントを混ぜない", async () => {
			await insertIssue("issue-0002");
			await insertCommentAt(
				"c1",
				ISSUE_ID,
				"こちら",
				"2026-01-01 00:00:00.000",
			);
			await insertCommentAt(
				"c2",
				"issue-0002",
				"あちら",
				"2026-01-01 00:00:00.000",
			);

			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);

			expect(list.data).toHaveLength(1);
			expect(list.data[0].body).toBe("こちら");
		});

		it("コメントが無ければ空配列を返す", async () => {
			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);

			expect(res.status).toBe(200);
			const list = await readBody(res);
			expect(list.data).toEqual([]);
			expect(list.total).toBe(0);
		});

		it("存在しない Issue には 404 を返す", async () => {
			// 空配列を返すと「コメントが 0 件の Issue」と区別が付かず、
			// タイプミスした URL がそれらしく表示されてしまう
			const res = await app.request("/issues/no-such-issue/comments", {}, env);

			expect(res.status).toBe(404);
			expect((await readBody(res)).error).toBe("Issue not found");
		});

		it("内部フィールドを公開しない", async () => {
			await insertCommentAt(
				"c1",
				ISSUE_ID,
				"本文",
				"2026-01-01 00:00:00.000",
				"secret-user",
			);

			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);

			expect(list.data[0]).not.toHaveProperty("user_id");
			// テーブルの公開カラムに加えて、行に無い派生フィールドが 3 つ載る。
			// `display_name` は Clerk から引いた投稿者の表示名、`is_anonymous` は
			// 「この投稿者を匿名として扱うか」（#67）、`viewer_is_author` は
			// 「これを書いたのが閲覧者本人か」（#99）。いずれも生の `user_id` を
			// 公開しない形で投稿者を示すためのもの
			expect(Object.keys(list.data[0]).sort()).toEqual(
				[
					...PUBLIC_COMMENT_COLUMNS,
					"is_anonymous",
					"display_name",
					"viewer_is_author",
				].sort(),
			);
		});

		it("Issue が消えるとコメントも辿れなくなる", async () => {
			await insertCommentAt("c1", ISSUE_ID, "本文", "2026-01-01 00:00:00.000");
			await env.DB.prepare("DELETE FROM issues WHERE id = ?")
				.bind(ISSUE_ID)
				.run();

			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			expect(res.status).toBe(404);
		});
	});

	// --- viewer_is_author（#99） ---
	//
	// 削除ボタンを出す条件そのもの。生の `user_id` を公開しない方針（#8）の
	// まま「これは自分のコメントか」を画面へ伝える唯一の手段なので、
	// ここが壊れると自分のコメントを消せない（または他人のコメントに
	// 削除ボタンが出る）。
	describe("viewer_is_author", () => {
		beforeEach(async () => {
			await insertCommentAt(
				"mine",
				ISSUE_ID,
				"自分の一言",
				"2026-01-01 00:00:00.000",
				"test-user-123",
			);
			await insertCommentAt(
				"theirs",
				ISSUE_ID,
				"他人の一言",
				"2026-01-02 00:00:00.000",
				"other-user",
			);
		});

		it("自分のコメントだけ true になる", async () => {
			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);

			const byId = new Map(
				list.data.map((c: Body) => [c.id, c.viewer_is_author]),
			);
			expect(byId.get("mine")).toBe(true);
			expect(byId.get("theirs")).toBe(false);
		});

		it("未認証ならすべて false になる", async () => {
			setMockUserId(null);
			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);

			expect(list.data.map((c: Body) => c.viewer_is_author)).toEqual([
				false,
				false,
			]);
		});

		it("投稿した本人には POST のレスポンスでも true を返す", async () => {
			// 画面は投稿に成功したコメントを手元の一覧へ追記する。ここが false だと
			// 書いた直後の自分のコメントにだけ削除ボタンが出ない
			const res = await postComment(ISSUE_ID, { body: "いま書いた" });
			expect((await readBody(res)).viewer_is_author).toBe(true);
		});
	});

	// --- DELETE /issues/:id/comments/:commentId ---
	describe("DELETE /issues/:id/comments/:commentId", () => {
		beforeEach(async () => {
			await insertCommentAt(
				"mine",
				ISSUE_ID,
				"消したい一言",
				"2026-01-01 00:00:00.000",
				"test-user-123",
			);
		});

		it("自分のコメントを削除し、行が実際に消える", async () => {
			const res = await deleteComment(ISSUE_ID, "mine");

			expect(res.status).toBe(204);
			// 論理削除ではなく物理削除。行が残っていないこと（#99 の決定）
			expect(await commentExists("mine")).toBe(false);
		});

		it("他人のコメントは 403 で、行が残る", async () => {
			await insertCommentAt(
				"theirs",
				ISSUE_ID,
				"他人の一言",
				"2026-01-02 00:00:00.000",
				"other-user",
			);

			const res = await deleteComment(ISSUE_ID, "theirs");

			expect(res.status).toBe(403);
			expect(await readBody(res)).toEqual({ error: "Forbidden" });
			// 403 を返しながら DELETE だけは走る、という壊れ方を拾う
			expect(await commentExists("theirs")).toBe(true);
		});

		it("未認証なら 401 で、行が残る", async () => {
			setMockUserId(null);
			const res = await deleteComment(ISSUE_ID, "mine");

			expect(res.status).toBe(401);
			expect(await readBody(res)).toEqual({ error: "Unauthorized" });
			expect(await commentExists("mine")).toBe(true);
		});

		it("セッショントークン以外（OAuth トークン）では 401 で、行が残る", async () => {
			setMockUserId("test-user-123", "oauth_token");
			const res = await deleteComment(ISSUE_ID, "mine");

			expect(res.status).toBe(401);
			expect(await commentExists("mine")).toBe(true);
		});

		it("Origin ヘッダが無ければ 403 で、行が残る", async () => {
			const res = await app.request(
				`/issues/${ISSUE_ID}/comments/mine`,
				{ method: "DELETE" },
				env,
			);

			expect(res.status).toBe(403);
			expect(await commentExists("mine")).toBe(true);
		});

		it("存在しないコメントには 404 を返す", async () => {
			const res = await deleteComment(ISSUE_ID, "no-such-comment");

			expect(res.status).toBe(404);
			expect(await readBody(res)).toEqual({ error: "Comment not found" });
		});

		it("存在しない Issue には 404 を返し、コメントは残る", async () => {
			const res = await deleteComment("no-such-issue", "mine");

			expect(res.status).toBe(404);
			expect(await commentExists("mine")).toBe(true);
		});

		it("別の Issue の URL からは削除できない", async () => {
			// `:commentId` だけで消せると、親 Issue と無関係な URL でも通ってしまう。
			// 自分のコメントであっても、指定した Issue に属していなければ 404
			await insertIssue("issue-0002");
			const res = await deleteComment("issue-0002", "mine");

			expect(res.status).toBe(404);
			expect(await commentExists("mine")).toBe(true);
		});

		it("削除しても同じ Issue の他のコメントは残る", async () => {
			await insertCommentAt(
				"mine-2",
				ISSUE_ID,
				"こちらは残す",
				"2026-01-03 00:00:00.000",
				"test-user-123",
			);

			expect((await deleteComment(ISSUE_ID, "mine")).status).toBe(204);

			expect(await commentExists("mine-2")).toBe(true);
			const res = await app.request(`/issues/${ISSUE_ID}/comments`, {}, env);
			const list = await readBody(res);
			expect(list.data.map((c: Body) => c.id)).toEqual(["mine-2"]);
			expect(list.total).toBe(1);
		});

		it("二度目の削除は 404 を返す", async () => {
			expect((await deleteComment(ISSUE_ID, "mine")).status).toBe(204);
			expect((await deleteComment(ISSUE_ID, "mine")).status).toBe(404);
		});
	});

	describe("toPublicComment", () => {
		it("公開カラム以外を落とす", () => {
			const row = {
				id: "c1",
				issue_id: ISSUE_ID,
				body: "本文",
				created_at: "2026-01-01 00:00:00.000",
				user_id: "secret-user",
			};

			expect(toPublicComment(row)).toEqual({
				id: "c1",
				issue_id: ISSUE_ID,
				body: "本文",
				created_at: "2026-01-01 00:00:00.000",
			});
		});
	});
});
