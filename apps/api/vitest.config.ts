import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { SHARED_SRC_ALIAS } from "./test/helpers/shared-alias";

export default defineWorkersConfig({
	// `@world-issue-tracker/shared` をこのチェックアウト内のソースへ固定する。理由は helpers/shared-alias.ts
	resolve: {
		alias: SHARED_SRC_ALIAS,
	},
	test: {
		include: ["test/*.test.ts"],
		// `@hono/clerk-auth` をインライン化する。
		//
		// テストは `@clerk/backend` の `createClerkClient` をモックして
		// `clerkMiddleware` の実物を通しているが、外部依存のままだと
		// `@hono/clerk-auth` 内部の import がバンドル外で解決され、
		// `vi.mock` が届かない（実物の Clerk へ通信しに行ってしまう）。
		server: {
			deps: {
				inline: ["@hono/clerk-auth"],
			},
		},
		poolOptions: {
			workers: {
				wrangler: {
					configPath: "./wrangler.jsonc",
				},
				// テスト用の Clerk キー。
				//
				// 実物の `clerkMiddleware` は `createClerkClient` を呼ぶ「前」に
				// キーの存在を検査して throw する。モックしているのはその先なので、
				// キーが無い環境（CI、clone 直後）では認証を通る全リクエストが
				// 500 になり、テストが総崩れになる。
				//
				// `.dev.vars` があればそちらが優先されるため、ローカルの挙動は変わらない。
				// 値は Clerk に実在しないダミーだが、publishable key は形式が
				// 検証される（base64 で "<domain>$"）ため構造だけは妥当にしてある。
				// このキーで外部へ通信することはない（署名検証まで到達せず signed-out で確定する）。
				miniflare: {
					bindings: {
						CLERK_SECRET_KEY: "sk_test_dummy",
						CLERK_PUBLISHABLE_KEY: "pk_test_bW9jay5jbGVyay5hY2NvdW50cy5kZXYk",
					},
				},
			},
		},
	},
});
