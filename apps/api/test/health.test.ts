import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

// モックの層については helpers/clerk-mock.ts を参照。
// /health は認証を要求しないため、未認証のまま使う。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";

const app = createApp();

/** D1 のエラーに含まれ得る内部情報を模した文字列。 */
const SECRET_DETAIL =
	"D1_ERROR: no such table: issues at /internal/build/worker.js:1234 sqlite3_step";

/**
 * D1 のクエリが失敗する env を返す。
 *
 * D1 の障害はテストから再現しづらいので、バインディングだけ差し替えて
 * 「クエリが失敗したときのレスポンス」を観測する。
 *
 * 失敗の形は 2 通りある。実際の D1 は `prepare()` 自体は成功して
 * `.first()` の Promise が reject する形が主なので、そちらも必ず回す。
 * 同期 throw だけで済ませると、`await` の付け忘れ（reject が catch に
 * 入らず healthy が返る）を検出できない。
 */
const FAILURE_MODES = [
	[
		"prepare throws synchronously",
		() => {
			throw new Error(SECRET_DETAIL);
		},
	],
	[
		"the query rejects",
		() => ({ first: () => Promise.reject(new Error(SECRET_DETAIL)) }),
	],
] as const;

function envWithFailingDb(prepare: () => unknown) {
	return {
		...env,
		DB: { prepare } as unknown as D1Database,
	};
}

/**
 * /health のレスポンスに関するテスト。
 *
 * /health は認証もレート制限も無い公開エンドポイントなので、D1 が失敗したときに
 * 生のエラー文字列を返すとテーブル名・カラム名・バンドル後のパスが未認証の
 * 第三者に渡る。ここでは「詳細を返さないこと」を固定する。
 */
describe("Health check", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns healthy when D1 responds", async () => {
		const res = await app.request("/health", {}, env);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "healthy" });
	});

	describe.each(FAILURE_MODES)("when %s", (_label, prepare) => {
		it("responds 500 with only the status", async () => {
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const res = await app.request("/health", {}, envWithFailingDb(prepare));
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body).toEqual({ status: "unhealthy" });

			consoleError.mockRestore();
		});

		// レスポンス全体を文字列として見る。ボディだけでなくヘッダにも
		// 詳細が乗らないことを確認したい（例: 例外がそのまま Hono の
		// エラーハンドラに抜けて別の形で露出する退行）。
		it("does not leak the underlying error anywhere in the response", async () => {
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const res = await app.request("/health", {}, envWithFailingDb(prepare));
			const text = await res.text();
			const headers = JSON.stringify([...res.headers]);

			for (const leak of [
				SECRET_DETAIL,
				"D1_ERROR",
				"no such table",
				"issues",
				"/internal/build/worker.js",
				"sqlite3_step",
			]) {
				expect(text).not.toContain(leak);
				expect(headers).not.toContain(leak);
			}

			consoleError.mockRestore();
		});

		// 詳細を落としたぶん、運用側で原因を追えるようログには残す。
		// ここが抜けると障害時に手がかりがゼロになる。
		it("logs the error server-side", async () => {
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			await app.request("/health", {}, envWithFailingDb(prepare));

			expect(consoleError).toHaveBeenCalled();
			const logged = consoleError.mock.calls.flat().map(String).join(" ");
			expect(logged).toContain(SECRET_DETAIL);

			consoleError.mockRestore();
		});
	});
});
