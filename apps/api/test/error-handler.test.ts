import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

// モックの層については helpers/clerk-mock.ts を参照。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";
import { setMockUserId } from "./helpers/clerk-mock";

const app = createApp();

const ALLOWED_ORIGIN = "http://localhost:3000";

/**
 * D1 の例外を再現する。
 *
 * 実際に起きたのは `?offset=1e30` による `SQLITE_MISMATCH` だが、
 * テーブルが存在しない・D1 が落ちている、といった場合も同じ経路を通る。
 * 特定の SQL に依存させず、DB が投げること自体を条件にする。
 */
function breakDatabase() {
	return vi.spyOn(env.DB, "prepare").mockImplementation(() => {
		throw new Error("D1_ERROR: datatype mismatch: SQLITE_MISMATCH");
	});
}

describe("Unhandled exceptions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setMockUserId(null);
	});

	// 想定外の例外が素通りすると、Hono の既定ハンドラが text/plain の
	// "Internal Server Error" を返す。他のエラーはすべて JSON なので、
	// クライアントが「エラーは常に {"error": ...}」を前提にできなくなる。
	it("returns a JSON 500 when the database throws on a public GET", async () => {
		breakDatabase();

		const res = await app.request("/issues", {}, env);
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ error: "Internal Server Error" });
	});

	it("returns a JSON 500 when the database throws on a write", async () => {
		setMockUserId("user_error_handler");
		breakDatabase();

		const res = await app.request(
			"/issues",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: ALLOWED_ORIGIN,
				},
				body: JSON.stringify({
					title: "Broken streetlight",
					description: "The streetlight on Main St is not working",
					scope: "community",
					latitude: 35.68,
					longitude: 139.76,
				}),
			},
			env,
		);
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ error: "Internal Server Error" });
	});

	// 本文に原因を載せない代わりに、ログには必ず残すこと。
	// 500 の本文だけを見ていると「握り潰して固定文言を返す」実装でも通ってしまい、
	// 本番で原因を追う手段が無くなる。
	it("logs the exception so the cause stays traceable", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		breakDatabase();

		const res = await app.request("/issues", {}, env);
		expect(res.status).toBe(500);
		expect(errorSpy).toHaveBeenCalled();
		// ログには本文に出せない詳細が乗っていること
		expect(
			errorSpy.mock.calls.some((call) =>
				call.some((arg) => String(arg).includes("SQLITE_MISMATCH")),
			),
		).toBe(true);
	});

	// 例外メッセージ・スタックトレースをそのまま返すような「親切な」実装に
	// しないこと。500 の本文から内部情報が漏れてはならない。
	it("does not leak internal details in the 500 body", async () => {
		breakDatabase();

		const res = await app.request("/issues", {}, env);
		const text = await res.text();
		expect(text).not.toContain("SQLITE_MISMATCH");
		expect(text).not.toContain("D1_ERROR");
		expect(text).not.toContain("prepare");
	});

	// 未定義ルートの 404 も JSON であること。
	// 500 だけ直しても、404 が text/plain のままなら
	// 「エラーは常に {"error": ...}」という前提はやはり成り立たない。
	it("returns a JSON 404 for an unknown route", async () => {
		const res = await app.request("/no-such-route", {}, env);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ error: "Not Found" });
	});

	// アプリ全体のハンドラを足したことで、ルート単位の `issues.onError` が
	// 効かなくなっていないこと（不正な JSON は 500 ではなく 400 のまま）。
	it("still returns 400 for invalid JSON on POST", async () => {
		setMockUserId("user_error_handler");

		const res = await app.request(
			"/issues",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: ALLOWED_ORIGIN,
				},
				body: "{ not json",
			},
			env,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid JSON" });
	});
});
