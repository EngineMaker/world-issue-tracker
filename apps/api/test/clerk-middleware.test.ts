import { env } from "cloudflare:test";
import { getAuth } from "@hono/clerk-auth";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { clerkAuth } from "../src/middleware/clerk";

/**
 * `clerkAuth()`（Clerk の初期化失敗を未認証として扱うラッパー）の単体テスト。
 *
 * ここも実物の `clerkMiddleware` を通す。モックすると「キーが無いと throw する」
 * という、このラッパーの存在理由そのものが消えてしまう。
 *
 * `clerk-contract.test.ts` が API 全体としての振る舞いを固定するのに対し、
 * こちらはラッパー単体の境界 —「何を握り潰し、何を素通しするか」— を固定する。
 */
describe("clerkAuth middleware", () => {
	/** キーが揃っている env。`vitest.config.ts` のダミーが入る。 */
	const envWithKeys = env;
	/** `CLERK_SECRET_KEY` を空にした env。 */
	const envWithoutKeys = { ...env, CLERK_SECRET_KEY: "" };

	it("makes auth available when Clerk is configured", async () => {
		const app = new Hono();
		app.get("/probe", clerkAuth(), (c) => {
			// 初期化に成功していれば `getAuth` は AuthObject を返す。
			// 資格情報が無いので signed-out（userId は null）になる。
			const auth = getAuth(c);
			return c.json({ resolved: auth !== undefined, userId: auth?.userId });
		});

		const res = await app.request("/probe", {}, envWithKeys);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ resolved: true, userId: null });
	});

	it("continues unauthenticated when Clerk keys are missing", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const app = new Hono();
		let reached = false;
		app.get("/probe", clerkAuth(), (c) => {
			reached = true;
			// 認証情報は入っていない。ハンドラ側が `getAuth` を呼ぶと落ちるため、
			// 未認証で通す経路では `requireAuth` が手前で閉じる前提になっている。
			return c.json({ hasClerkAuth: c.get("clerkAuth") !== undefined });
		});

		const res = await app.request("/probe", {}, envWithoutKeys);
		expect(res.status).toBe(200);
		expect(reached).toBe(true);
		expect(await res.json()).toEqual({ hasClerkAuth: false });

		// 設定不備を 401 として隠す形になるため、ログには必ず残ること
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	// 握り潰してよいのは Clerk 側の失敗だけ。後段で起きた例外まで飲み込むと、
	// 障害が 200 として隠れてしまう。
	//
	// ルートハンドラの例外は Hono の compose が先に捕まえて `onError` に回すため、
	// `clerkAuth` の catch には届かない。それでもここで固定しておくのは、
	// 実装の分岐ではなく「後段の例外が外から見て消えない」という性質だから。
	it("does not swallow errors thrown by downstream handlers", async () => {
		const app = new Hono();
		let seenByOnError: unknown;
		app.get("/boom", clerkAuth(), () => {
			throw new Error("handler exploded");
		});
		app.onError((err, c) => {
			seenByOnError = err;
			return c.json({ error: "Internal Server Error" }, 500);
		});

		const res = await app.request("/boom", {}, envWithKeys);
		expect(res.status).toBe(500);
		expect((seenByOnError as Error | undefined)?.message).toBe(
			"handler exploded",
		);
	});

	// 後段がミドルウェアの場合も同じ性質を固定する。
	// ハンドラ版と同様、現在の Hono では compose が先に捕まえるため
	// `clerkAuth` の catch には届かないが、固定したいのは実装の分岐ではなく
	// 「Clerk と無関係な障害が 200 に化けない」という外形の性質。
	it("does not swallow errors thrown by downstream middleware", async () => {
		const app = new Hono();
		let handlerRan = false;
		let seenByOnError: unknown;
		app.get(
			"/boom",
			clerkAuth(),
			async () => {
				throw new Error("middleware exploded");
			},
			(c) => {
				handlerRan = true;
				return c.json({ ok: true });
			},
		);
		app.onError((err, c) => {
			seenByOnError = err;
			return c.json({ error: "Internal Server Error" }, 500);
		});

		const res = await app.request("/boom", {}, envWithKeys);
		expect(res.status).toBe(500);
		expect((seenByOnError as Error | undefined)?.message).toBe(
			"middleware exploded",
		);
		// 握り潰して続行してしまうと、止めたはずのハンドラが動く
		expect(handlerRan).toBe(false);
	});

	// 例外を握った経路でも `next()` が二重に呼ばれないこと。
	// 二重呼び出しは「ハンドラが 2 回実行される」＝書き込みの重複を意味する。
	it("runs the downstream handler exactly once without Clerk keys", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const app = new Hono();
		let calls = 0;
		app.post("/count", clerkAuth(), (c) => {
			calls += 1;
			return c.json({ calls });
		});

		const res = await app.request("/count", { method: "POST" }, envWithoutKeys);
		expect(res.status).toBe(200);
		expect(calls).toBe(1);

		consoleError.mockRestore();
	});
});
