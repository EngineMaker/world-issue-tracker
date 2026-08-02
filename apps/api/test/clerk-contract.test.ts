import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/index";

const MIGRATION =
	"CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), title TEXT NOT NULL, description TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('personal', 'community', 'municipality', 'national', 'global')), status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'in_progress', 'review', 'resolved', 'closed')), latitude REAL NOT NULL, longitude REAL NOT NULL, category TEXT, user_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));";

/**
 * 実物の `clerkMiddleware` に対する契約テスト。
 *
 * 他のテストは `@clerk/backend` の `createClerkClient` をモックして
 * ネットワークを切っている（helpers/clerk-mock.ts）。そのモックが実物から
 * 乖離しても気づけるように、ここだけはモックを一切かけずに
 * `createApp()` をそのまま叩き、実物のミドルウェアが満たすべき性質を固定する。
 *
 * このファイルで `vi.mock` を使ってはいけない。モックすると
 * 「実物を通す経路」という存在理由が失われる。
 *
 * 到達範囲について: ここで通るのは Clerk がローカルで完結させる判定までで、
 * JWKS の取得や署名検証には届かない（資格情報が無い・トークンが壊れている
 * 時点で signed-out が確定し、リモートに問い合わせる前に打ち切られる）。
 * そのためネットワークには出ず、キーも実在しないダミーで足りる。
 * 逆に言うと、署名検証そのものの正しさはここでは担保していない。
 */
describe("Clerk middleware contract (no mocks)", () => {
	const app = createApp();

	beforeAll(async () => {
		await env.DB.exec(MIGRATION);
	});

	// キーは `vitest.config.ts` のダミー（`.dev.vars` があればそちら）から渡る。
	// キーが揃っている状態で、資格情報を持たないリクエストがどう扱われるかを固定する。
	describe("with Clerk keys configured", () => {
		it("rejects a write without any credentials", async () => {
			// トークンも Cookie も無いので Clerk は signed-out と判定する。
			// `requireAuth` がそれを 401 に変換する。
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({
						title: "No credentials",
						description: "should not be created",
						scope: "community",
						latitude: 0,
						longitude: 0,
					}),
				},
				env,
			);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toBe("Unauthorized");
		});

		it("rejects a write with a bogus Bearer token", async () => {
			// 署名を検証できないトークンが通ってしまわないこと。
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
						Authorization: "Bearer not-a-real-jwt",
					},
					body: JSON.stringify({
						title: "Bogus token",
						description: "should not be created",
						scope: "community",
						latitude: 0,
						longitude: 0,
					}),
				},
				env,
			);
			expect(res.status).toBe(401);
		});

		it("still serves public GET without credentials", async () => {
			// 認証を通していないだけで公開エンドポイントまで落ちないこと。
			// （ミドルウェアが全リクエストを巻き込んで 500 にする退行の検出）
			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
		});
	});

	// キーが無い環境では実物のミドルウェアが例外を投げる。
	// 書き込みは「認証なしで素通りする」のではなく 500 で止まる（フェイルクローズ）。
	// 一方で公開読み取りは Clerk と無関係なので、設定不備に巻き込まれてはいけない。
	describe("without Clerk keys", () => {
		/** `CLERK_SECRET_KEY` を空にした env。他のバインディングはそのまま使う。 */
		const envWithoutKeys = { ...env, CLERK_SECRET_KEY: "" };

		// 公開エンドポイントは Clerk の設定状態に依存しない。
		// シークレットの設定漏れ・ローテーション失敗で読み取りまで落ちないこと。
		it.each([
			["/", "root"],
			["/health", "health check"],
			["/issues", "issue list"],
		])("still serves %s (%s) without Clerk keys", async (path) => {
			const res = await app.request(path, {}, envWithoutKeys);
			expect(res.status).toBe(200);
		});

		it("still serves a public GET by id without Clerk keys", async () => {
			await env.DB.prepare(
				"INSERT INTO issues (id, title, description, scope, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)",
			)
				.bind(
					"public-get-without-keys",
					"Readable",
					"should be readable without Clerk",
					"community",
					0,
					0,
				)
				.run();

			const res = await app.request(
				"/issues/public-get-without-keys",
				{},
				envWithoutKeys,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { title?: string };
			expect(body.title).toBe("Readable");
		});

		// 書き込みはキーが無くても開かない。Clerk の初期化に失敗した場合は
		// 「認証情報を取得できなかった」＝未認証として扱われ、`requireAuth` が閉じる。
		// ステータスだけでなく、副作用が起きていないことまで確認する。
		it("fails closed on a create instead of allowing it", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({
						title: "No clerk key",
						description: "should not be created",
						scope: "community",
						latitude: 0,
						longitude: 0,
					}),
				},
				envWithoutKeys,
			);
			expect(res.status).toBe(401);

			// 401 を返すだけでなく、実際に書き込まれていないこと
			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM issues WHERE title = ?",
			)
				.bind("No clerk key")
				.first<{ total: number }>();
			expect(row?.total).toBe(0);
		});

		it("fails closed on an update instead of applying it", async () => {
			await env.DB.prepare(
				"INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
				.bind(
					"no-keys-update",
					"Original title",
					"should not be updated",
					"community",
					0,
					0,
					"user_owner",
				)
				.run();

			const res = await app.request(
				"/issues/no-keys-update",
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({ title: "Hijacked title" }),
				},
				envWithoutKeys,
			);
			expect(res.status).toBe(401);

			const row = await env.DB.prepare("SELECT title FROM issues WHERE id = ?")
				.bind("no-keys-update")
				.first<{ title: string }>();
			expect(row?.title).toBe("Original title");
		});

		it("fails closed on a delete instead of performing it", async () => {
			await env.DB.prepare(
				"INSERT INTO issues (id, title, description, scope, latitude, longitude, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
				.bind(
					"no-keys-delete",
					"Survivor",
					"should not be deleted",
					"community",
					0,
					0,
					"user_owner",
				)
				.run();

			const res = await app.request(
				"/issues/no-keys-delete",
				{
					method: "DELETE",
					headers: { Origin: "http://localhost:3000" },
				},
				envWithoutKeys,
			);
			expect(res.status).toBe(401);

			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM issues WHERE id = ?",
			)
				.bind("no-keys-delete")
				.first<{ total: number }>();
			expect(row?.total).toBe(1);
		});
	});
});
