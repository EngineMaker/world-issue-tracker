import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/index";
import { applyMigrations } from "./helpers/migrate";

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
		await applyMigrations();
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
	// 「認証なしで素通りする」のではなく 500 で止まる（フェイルクローズ）ことを固定する。
	// 設定漏れのままデプロイしても、無防備に開くのではなく壊れて気づける。
	describe("without Clerk keys", () => {
		/** `CLERK_SECRET_KEY` を空にした env。他のバインディングはそのまま使う。 */
		const envWithoutKeys = { ...env, CLERK_SECRET_KEY: "" };

		it("fails closed on a write instead of allowing it", async () => {
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
			expect(res.status).toBe(500);

			// 500 を返すだけでなく、実際に書き込まれていないこと
			const row = await env.DB.prepare(
				"SELECT COUNT(*) as total FROM issues WHERE title = ?",
			)
				.bind("No clerk key")
				.first<{ total: number }>();
			expect(row?.total).toBe(0);
		});
	});
});
