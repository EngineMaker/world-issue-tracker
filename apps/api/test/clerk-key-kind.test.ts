import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index";
import {
	clerkAuth,
	clerkKeyKindWarning,
	resetClerkKeyWarning,
} from "../src/middleware/clerk";
import { applyMigrations } from "./helpers/migrate";

/**
 * 開発用インスタンスのキーで動いているときの警告（Issue #98）のテスト。
 *
 * #98 は「本番サイトが Clerk の開発用インスタンスで動いていた」という不備で、
 * 気付いたのはブラウザのコンソールに出た Clerk 自身の警告だった。つまり
 * **サーバー側には何の痕跡も残っていなかった**。web は本番ビルドの手前で
 * 落とせる（apps/web/scripts/check-clerk-keys.ts）が、API のキーは
 * Workers Secrets にありビルド時には存在しないので、実行時ログで気付く形にする。
 *
 * 検証の主題は 3 つ:
 *   1. 開発用キーのとき、ログに残ること（残らなければ #98 は再び見えない）
 *   2. **公開 GET でも残ること**。認証を要求するルートにだけ差すと、
 *      閲覧者しか来ていない期間は一度も出ず、一番知りたい状況で沈黙する
 *   3. 認証や可用性の振る舞いを一切変えていないこと。ここで 401/500 に倒すと
 *      「上限に達したら止まる」が「今すぐ止まる」に悪化する
 */
describe("Clerk development key warning", () => {
	beforeEach(() => {
		// Worker インスタンスをまたいだ「もう警告した」状態を持ち越さない。
		resetClerkKeyWarning();
	});

	/** 警告ミドルウェアだけを通す最小のアプリ。 */
	function probeApp() {
		const app = new Hono();
		app.use(clerkKeyKindWarning());
		app.get("/probe", (c) => c.json({ ok: true }));
		return app;
	}

	it("開発用キーのときに警告をログへ残す", async () => {
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		// vitest.config.ts のダミーは pk_test_/sk_test_、つまり開発用。
		// #98 の本番と同じ種別の状態を再現している。
		const res = await probeApp().request("/probe", {}, env);

		expect(res.status).toBe(200);
		expect(consoleWarn).toHaveBeenCalledTimes(1);
		const message = String(consoleWarn.mock.calls[0]?.[0]);
		expect(message).toContain("#98");
		expect(message).toContain("development instance keys");

		consoleWarn.mockRestore();
	});

	it("本番用キーのときは警告を出さない", async () => {
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		// 本番用の接頭辞に差し替える。値は実在しないダミーだが、
		// 警告の判定は接頭辞しか見ないのでここでは十分。
		const productionEnv = {
			...env,
			CLERK_SECRET_KEY: "sk_live_dummy",
			CLERK_PUBLISHABLE_KEY: "pk_live_bW9jay5jbGVyay5hY2NvdW50cy5kZXYk",
		};

		await probeApp().request("/probe", {}, productionEnv);

		expect(consoleWarn).not.toHaveBeenCalled();
		consoleWarn.mockRestore();
	});

	it("片方だけ開発用でも警告を出す", async () => {
		// web と api を片方だけ切り替える事故（#98 の補足）は、
		// api の中でも secret / publishable の間で起こりうる。
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const mixedEnv = {
			...env,
			CLERK_SECRET_KEY: "sk_live_dummy",
			// publishable だけ開発用のまま
			CLERK_PUBLISHABLE_KEY: "pk_test_bW9jay5jbGVyay5hY2NvdW50cy5kZXYk",
		};

		await probeApp().request("/probe", {}, mixedEnv);

		expect(consoleWarn).toHaveBeenCalledTimes(1);
		consoleWarn.mockRestore();
	});

	it("リクエストごとには出さない（ログを埋めない）", async () => {
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const app = probeApp();
		await app.request("/probe", {}, env);
		await app.request("/probe", {}, env);
		await app.request("/probe", {}, env);

		expect(consoleWarn).toHaveBeenCalledTimes(1);
		consoleWarn.mockRestore();
	});

	/**
	 * 実物の `createApp()` を通した検証。
	 *
	 * ミドルウェア単体が正しく動いても、アプリに差さっていなければ
	 * #98 は再発する。しかも「認証を要求するルートにだけ差す」形だと
	 * 単体テストは通るのに本番では沈黙するので、ここが要になる。
	 */
	describe("アプリ全体への接続", () => {
		beforeEach(async () => {
			await applyMigrations();
		});

		// 認証を一切通らない公開エンドポイントを並べる。#98 の本番で
		// 実際に叩かれていたのはこの種の経路（未ログインの閲覧）だった。
		it.each([
			["/", "ルート"],
			["/health", "ヘルスチェック"],
			["/issues", "Issue 一覧"],
		])("%s（%s）でも警告が出る", async (path) => {
			const consoleWarn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			const res = await createApp().request(path, {}, env);

			expect(res.status).toBe(200);
			expect(consoleWarn).toHaveBeenCalledTimes(1);
			expect(String(consoleWarn.mock.calls[0]?.[0])).toContain("#98");

			consoleWarn.mockRestore();
		});
	});

	it("認証の振る舞いを変えない（警告は副作用を持たない）", async () => {
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		// 開発用キーでも、これまでどおり認証は成立してハンドラへ到達する。
		// 警告のために 401/500 へ倒していないこと。
		let reached = false;
		const app = new Hono();
		app.use(clerkKeyKindWarning());
		app.get("/probe", clerkAuth(), (c) => {
			reached = true;
			return c.json({ ok: true });
		});

		const res = await app.request("/probe", {}, env);

		expect(res.status).toBe(200);
		expect(reached).toBe(true);
		consoleWarn.mockRestore();
	});

	it("キーが無い環境でも公開経路を壊さない", async () => {
		const consoleWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		// キー不在は clerkAuth() が握って未認証で続行する既存の振る舞い。
		// 警告ミドルウェアは Clerk に問い合わせないので、ここに影響しないこと。
		const envWithoutKeys = {
			...env,
			CLERK_SECRET_KEY: "",
			CLERK_PUBLISHABLE_KEY: "",
		};

		const res = await probeApp().request("/probe", {}, envWithoutKeys);

		expect(res.status).toBe(200);
		// 未設定は「開発用」ではないので、この警告の対象ではない
		// （設定漏れは既存の console.error が担当する）。
		expect(consoleWarn).not.toHaveBeenCalled();

		consoleWarn.mockRestore();
		consoleError.mockRestore();
	});
});
