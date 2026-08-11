import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	expectedKindValues,
	findClerkInstanceProblems,
} from "../scripts/verify-clerk-instance";
import { createApp } from "../src/index";

/**
 * デプロイ後に Clerk インスタンスの種別を確かめる仕組みのテスト（#98 の積み残し）。
 *
 * #98 の一次対応（PR #100）は web にだけ関門を置いた。API は
 * `bun wrangler deploy` を直接叩くだけで、Clerk のキーに触れる箇所が
 * 一つも無かった。API のキーは Workers Secrets にあって値を読み出せないので、
 * web と同じ「ビルド前に止める」形は作れない。代わりにデプロイ後の
 * API 自身へ種別を聞く。
 *
 * 検証の主題は 3 つ:
 *   1. 開発用キーで動いていることを本番の外から確かめられること
 *   2. **キーの値を漏らさないこと**。確認のために secret key を晒したら本末転倒
 *   3. 判定できなかったときに「問題なし」へ倒さないこと。取得の失敗と
 *      問題が無かったことを同じ扱いにすると、検証したつもりで何も見なくなる
 */
describe("GET /health/auth", () => {
	it("開発用キーで動いていることを外から確認できる", async () => {
		// vitest.config.ts のダミーは pk_test_/sk_test_、つまり #98 の本番と同じ種別。
		const res = await createApp().request("/health/auth", {}, env);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			clerk: { secretKey: "development", publishableKey: "development" },
		});
	});

	it("本番用キーなら production を返す", async () => {
		const productionEnv = {
			...env,
			CLERK_SECRET_KEY: "sk_live_dummy",
			CLERK_PUBLISHABLE_KEY: "pk_live_dummy",
		};

		const res = await createApp().request("/health/auth", {}, productionEnv);

		expect(await res.json()).toEqual({
			clerk: { secretKey: "production", publishableKey: "production" },
		});
	});

	it("片方だけ本番用の状態を見分けられる", async () => {
		// #98 の補足が名指しで警告している失敗。ここが production に
		// 見えてしまうと、認証が通らない本番を「検証済み」で通してしまう。
		const mixedEnv = {
			...env,
			CLERK_SECRET_KEY: "sk_live_dummy",
			CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
		};

		const res = await createApp().request("/health/auth", {}, mixedEnv);

		expect(await res.json()).toEqual({
			clerk: { secretKey: "production", publishableKey: "development" },
		});
	});

	it("未設定・形式違いを production と答えない", async () => {
		const brokenEnv = {
			...env,
			CLERK_SECRET_KEY: "",
			CLERK_PUBLISHABLE_KEY: "some-other-value",
		};

		const res = await createApp().request("/health/auth", {}, brokenEnv);

		expect(await res.json()).toEqual({
			clerk: { secretKey: "unset", publishableKey: "unset" },
		});
	});

	it("キーの値も断片も返さない", async () => {
		// 種別を知るのに値は要らない（判定は接頭辞しか見ない）。
		// 確認のために secret key を晒したら、#98 を直すために
		// もっと悪い問題を作ることになる。
		const secret = "sk_live_super_secret_value";
		const publishable = "pk_live_publishable_value";

		const res = await createApp().request(
			"/health/auth",
			{},
			{
				...env,
				CLERK_SECRET_KEY: secret,
				CLERK_PUBLISHABLE_KEY: publishable,
			},
		);

		const text = await res.text();
		expect(text).not.toContain(secret);
		expect(text).not.toContain(publishable);
		// 接頭辞より後ろの断片が混ざっていないこと。
		expect(text).not.toContain("super_secret_value");
		expect(text).not.toContain("publishable_value");
	});
});

describe("findClerkInstanceProblems", () => {
	it("両方が本番用なら問題を報告しない", () => {
		const problems = findClerkInstanceProblems({
			clerk: { secretKey: "production", publishableKey: "production" },
		});
		expect(problems).toEqual([]);
	});

	it("#98 の状態（両方が開発用）を 2 件報告する", () => {
		const problems = findClerkInstanceProblems({
			clerk: { secretKey: "development", publishableKey: "development" },
		});
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain("CLERK_SECRET_KEY");
		expect(problems[1]).toContain("CLERK_PUBLISHABLE_KEY");
	});

	it("片方だけ開発用でも報告する", () => {
		const problems = findClerkInstanceProblems({
			clerk: { secretKey: "production", publishableKey: "development" },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("CLERK_PUBLISHABLE_KEY");
	});

	it("unset を問題として扱う", () => {
		const problems = findClerkInstanceProblems({
			clerk: { secretKey: "unset", publishableKey: "unset" },
		});
		expect(problems).toHaveLength(2);
	});

	it("clerk が無い応答を「問題なし」に倒さない", () => {
		// このエンドポイントを持たない古い版が動いている場合。
		// 空配列を返すと、検証したつもりで何も見ていないことになる。
		expect(findClerkInstanceProblems({ status: "healthy" })).toHaveLength(1);
		expect(findClerkInstanceProblems(null)).toHaveLength(1);
		expect(findClerkInstanceProblems("not json")).toHaveLength(1);
	});

	it("知らない種別を production と見なさない", () => {
		const problems = findClerkInstanceProblems({
			clerk: { secretKey: "PRODUCTION", publishableKey: true },
		});
		expect(problems).toHaveLength(2);
	});
});

describe("API とスクリプトの種別の語彙", () => {
	it("API が返しうる値をスクリプトがすべて解釈できる", () => {
		// 片方だけ語彙を変えると、検証が黙って無効になる。たとえば API が
		// "prod" を返すようになったら、スクリプトはそれを「判定不能」として
		// 落とすべきで、素通りさせてはいけない。
		const values = expectedKindValues();
		expect(values).toEqual(["production", "development", "unset"]);

		// production 以外はすべて問題として報告されること。
		for (const value of values) {
			const problems = findClerkInstanceProblems({
				clerk: { secretKey: value, publishableKey: value },
			});
			expect(problems).toHaveLength(value === "production" ? 0 : 2);
		}
	});
});
