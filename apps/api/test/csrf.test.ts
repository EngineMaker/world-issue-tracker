import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// モックの層については helpers/clerk-mock.ts を参照。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { ALLOWED_ORIGINS, createApp } from "../src/index";
import { getLastAuthSource, setMockUserId } from "./helpers/clerk-mock";
import { applyMigrations } from "./helpers/migrate";

const app = createApp();

const validIssue = {
	title: "Broken streetlight",
	description: "The streetlight on Main St is not working",
	scope: "community",
	latitude: 35.68,
	longitude: 139.76,
};

/** 許可オリジンから正規に作成した Issue を返す。 */
async function createIssue() {
	const res = await app.request(
		"/issues",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify(validIssue),
		},
		env,
	);
	return (await res.json()) as Record<string, string>;
}

async function countIssues(): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) as total FROM issues",
	).first<{ total: number }>();
	return row?.total ?? 0;
}

/**
 * CSRF 対策のテスト。
 *
 * Clerk は Authorization ヘッダが無ければ Cookie 経路にフォールバックして認証する。
 * その状態で書き込み系エンドポイントに Origin 検証が無いと、悪意あるサイトから
 * ログイン中ユーザーの権限で書き込みが実行されてしまう。
 */
describe("CSRF protection", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM issues");
		setMockUserId("test-user-123");
	});

	// --- Simple request（プリフライトが発生しない Content-Type） ---
	describe("simple request from a cross-site origin", () => {
		it("rejects POST with text/plain from an unknown origin", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "text/plain",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
		});

		it("does not create the issue on a rejected cross-site POST", async () => {
			await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "text/plain",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(await countIssues()).toBe(0);
		});

		it("rejects POST with application/x-www-form-urlencoded from an unknown origin", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});

		it("rejects POST with multipart/form-data from an unknown origin", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "multipart/form-data; boundary=x",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});
	});

	// --- application/json のクロスサイトリクエスト ---
	// 本来はプリフライトで止まるが、CORS はブラウザ側の仕組みでしかない。
	// サーバー側でも Origin を見て弾く。
	describe("json request from a cross-site origin", () => {
		it("rejects POST with application/json from an unknown origin", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});

		it("rejects PATCH from an unknown origin and leaves the issue unchanged", async () => {
			const created = await createIssue();

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify({ title: "Hijacked" }),
				},
				env,
			);
			expect(res.status).toBe(403);

			const check = await app.request(`/issues/${created.id}`, {}, env);
			const body = (await check.json()) as Record<string, string>;
			expect(body.title).toBe(validIssue.title);
		});

		it("rejects DELETE from an unknown origin and leaves the issue in place", async () => {
			const created = await createIssue();

			const res = await app.request(
				`/issues/${created.id}`,
				{
					method: "DELETE",
					headers: { Origin: "https://evil.example.com" },
				},
				env,
			);
			expect(res.status).toBe(403);

			const check = await app.request(`/issues/${created.id}`, {}, env);
			expect(check.status).toBe(200);
		});
	});

	// --- Origin ヘッダが無いリクエスト ---
	// ブラウザ以外（curl 等）からのリクエストは Origin を付けない。
	// 書き込み系は Origin を必須にして、付いていないものは弾く。
	describe("request without an Origin header", () => {
		it("rejects POST without an Origin header", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});
	});

	// --- 許可オリジンからのリクエストは通ること ---
	describe("request from an allowed origin", () => {
		// 許可リストの全要素を回す。オリジンをテストに直書きすると、
		// 実装側のリストが実デプロイ先とズレていてもテストが追認してしまう。
		it.each(ALLOWED_ORIGINS)("allows POST from %s", async (origin) => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: origin,
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(201);
		});

		// 実際にデプロイされている Web のオリジンが許可されていること。
		// ここが抜けると、デプロイした瞬間に本番の書き込みが 403 で全滅する。
		// デプロイ先は README の「デプロイ先」表と対応している。
		it("allows POST from the deployed web origin", async () => {
			expect(ALLOWED_ORIGINS).toContain(
				"https://world-issue-tracker-web.mktoho.workers.dev",
			);

			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://world-issue-tracker-web.mktoho.workers.dev",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(201);
		});

		it("allows PATCH and DELETE from an allowed origin", async () => {
			const created = await createIssue();

			const patchRes = await app.request(
				`/issues/${created.id}`,
				{
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({ title: "Updated" }),
				},
				env,
			);
			expect(patchRes.status).toBe(200);

			const delRes = await app.request(
				`/issues/${created.id}`,
				{
					method: "DELETE",
					headers: { Origin: "http://localhost:3000" },
				},
				env,
			);
			expect(delRes.status).toBe(200);
		});
	});

	// --- 許可オリジンに似せた Origin ---
	// 許可リストの照合が完全一致であることを固定する。前方一致や部分一致に
	// 退行すると、`http://localhost:3000.evil.com` のようなオリジンが通る。
	describe("origin that resembles an allowed one", () => {
		it.each([
			["a suffixed host", "http://localhost:3000.evil.com"],
			["a longer port", "http://localhost:30000"],
			["a trailing slash", "http://localhost:3000/"],
			["a different scheme", "https://localhost:3000"],
			[
				"a subdomain of the allowed host",
				"https://evil.world-issue-tracker.pages.dev",
			],
			// ブラウザが送る Origin はスキームもホストも小文字に正規化される
			// （RFC 6454）。大文字を通す必要は無いので完全一致のままにしている。
			["an upper-cased origin", "HTTP://LOCALHOST:3000"],
			// sandboxed iframe やリダイレクト経由のリクエストは Origin: null になる。
			// 許可リストに "null" が無いので弾かれるが、明示的に固定しておく。
			["the opaque null origin", "null"],
		])("rejects POST from %s", async (_label, origin) => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: origin,
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});
	});

	// --- メソッドの偽装 ---
	describe("method override", () => {
		it("does not let X-HTTP-Method-Override bypass the check", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "text/plain",
						Origin: "https://evil.example.com",
						"X-HTTP-Method-Override": "GET",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});
	});

	// --- プリフライト ---
	describe("CORS preflight", () => {
		it("still answers the preflight for an allowed origin", async () => {
			// Origin 検証が OPTIONS を弾くと、正当なブラウザからの
			// プリフライトが失敗して書き込みが一切できなくなる。
			const res = await app.request(
				"/issues",
				{
					method: "OPTIONS",
					headers: {
						Origin: "http://localhost:3000",
						"Access-Control-Request-Method": "POST",
						"Access-Control-Request-Headers": "content-type",
					},
				},
				env,
			);
			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe(
				"http://localhost:3000",
			);
		});
	});

	// --- Authorization ヘッダ経路 ---
	// Bearer トークンはブラウザが自動送信しないため CSRF の経路にならない。
	// サーバー間通信や API クライアントを塞がないよう、Origin 検証を免除する。
	describe("request with an Authorization header", () => {
		it("allows POST with a Bearer token and no Origin header", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer some-session-token",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(201);
		});

		it("still requires authentication when the token is not accepted", async () => {
			// Origin 検証を免除しても認証は免除されない。Clerk がトークンを
			// 受け付けなければ requireAuth が 401 を返し、書き込みは起きない。
			setMockUserId(null);
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer invalid-token",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(401);
			expect(await countIssues()).toBe(0);
		});

		// Origin 検証の分岐だけでなく、Clerk 側がどの経路の資格情報を読んだかも見る。
		// Bearer と Cookie の違いは CSRF の成否そのもの（Cookie はブラウザが自動送信し、
		// Bearer はしない）なので、両者が区別されずに扱われる退行を捕まえたい。
		it("reads the token from the Authorization header, not the cookie", async () => {
			await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer some-session-token",
						Cookie: "__session=cookie-session-token",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(getLastAuthSource()).toBe("bearer");
		});

		it("falls back to the cookie when there is no Bearer token", async () => {
			await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost:3000",
						Cookie: "__session=cookie-session-token",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(getLastAuthSource()).toBe("cookie");
		});

		it("does not treat a non-Bearer scheme as a token", async () => {
			// Clerk は Basic 等の他スキームを無視して Cookie 経路に落ちる。
			// こちらもトークン無しとみなし、Origin 検証を効かせる。
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Basic dXNlcjpwYXNz",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});

		it("does not treat an empty Authorization header as a token", async () => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});

		// 中身の無い Authorization ヘッダで Origin 検証を免除させないこと。
		// `@clerk/backend` はスキーム無しの裸トークンも受け付けるため、素直に
		// 同じ規則で書くと "Bearer " が「Bearer という名前のトークン」になる。
		it.each([
			["a bare 'Bearer' with a trailing space", "Bearer "],
			["a bare 'Bearer' without a token", "Bearer"],
			["a scheme-less bare token", "some-raw-token"],
		])("does not treat %s as a Bearer token", async (_label, authorization) => {
			const res = await app.request(
				"/issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: authorization,
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify(validIssue),
				},
				env,
			);
			expect(res.status).toBe(403);
			expect(await countIssues()).toBe(0);
		});
	});

	// --- 読み取り系は制限しない ---
	describe("safe methods stay public", () => {
		it("allows GET list without an Origin header", async () => {
			const res = await app.request("/issues", {}, env);
			expect(res.status).toBe(200);
		});

		it("allows GET list from any origin", async () => {
			const res = await app.request(
				"/issues",
				{ headers: { Origin: "https://evil.example.com" } },
				env,
			);
			expect(res.status).toBe(200);
		});
	});
});
