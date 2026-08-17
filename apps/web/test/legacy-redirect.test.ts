/**
 * 旧オリジンから新しい入口への転送（Issue #98）のテスト。
 *
 * 独自ドメイン（issues.emaker.dev）へ移したあと、旧 URL
 * （world-issue-tracker-web.mktoho.workers.dev）は 404 になった。Cloudflare は
 * Custom Domain を設定すると workers.dev のサブドメインを既定で無効にするため。
 *
 * `wrangler.jsonc` で `workers_dev` を true に戻し、届いたリクエストを
 * `src/middleware.ts` が新しい入口へ 308 で送る形にした。
 *
 * ここで固定したいのは次の 3 点。どれも壊れても画面上はすぐ分からない。
 *
 *   1. 旧オリジンから来たら転送する（しないと 404 のまま）
 *   2. パスとクエリを維持する（詳細への直リンクが一覧に飛ぶと何を見たかったのか失われる）
 *   3. 新しい入口と localhost では転送しない（自分自身へ送ると無限ループ）
 *
 * 検証するのは判定関数（`legacyRedirectTarget`）で、Clerk には触れない。
 * `middleware.ts` ごと読むと `@clerk/nextjs/server` の解決に失敗する
 * （Next.js のビルド前提のため `bun test` では
 * `Export named 'clerkMiddleware' not found` になる）。モジュールごと
 * モックする手もあるが、`bun:test` の `mock.module` は**ファイル単位で
 * 閉じない**ため無関係なテストまで巻き込む（実際にそれで 1 件落とした）。
 * 転送は Clerk と独立した判断なので `src/lib/legacy-origin.ts` に分けてある。
 */

import { describe, expect, it } from "bun:test";
import {
	LEGACY_WEB_ORIGINS,
	PRODUCTION_WEB_ORIGIN,
} from "@world-issue-tracker/shared";
import { legacyRedirectTarget } from "../src/lib/legacy-origin";

describe("旧オリジンから新しい入口へ転送する", () => {
	for (const origin of LEGACY_WEB_ORIGINS) {
		it(`${origin} から来たら ${PRODUCTION_WEB_ORIGIN} へ送る`, () => {
			expect(legacyRedirectTarget(`${origin}/`)).toBe(
				`${PRODUCTION_WEB_ORIGIN}/`,
			);
		});
	}

	it("パスとクエリをそのまま引き継ぐ", () => {
		const legacy = LEGACY_WEB_ORIGINS[0];
		expect(
			legacyRedirectTarget(`${legacy}/issues/abc123?scope=local&page=2`),
		).toBe(`${PRODUCTION_WEB_ORIGIN}/issues/abc123?scope=local&page=2`);
	});

	it("新しい入口では転送しない", () => {
		// ここで転送すると自分自身へ送り続けて無限ループになる
		expect(legacyRedirectTarget(`${PRODUCTION_WEB_ORIGIN}/issues`)).toBeNull();
	});

	it("開発中の localhost では転送しない", () => {
		expect(legacyRedirectTarget("http://localhost:3000/issues")).toBeNull();
	});
});
