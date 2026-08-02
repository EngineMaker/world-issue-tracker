import { defineConfig } from "vitest/config";
import { SHARED_SRC_ALIAS } from "./test/helpers/shared-alias";

// Workers ランタイムを必要としないテスト。
//
// リポジトリのファイルを読むテスト（Workers ランタイムの node:fs は実ファイル
// システムに繋がらない）と、`packages/shared` のスキーマを直接叩く単体テストを置く。
// 後者は `packages/shared` にテストランナーが無いためここに同居させている。
export default defineConfig({
	// `@world-issue-tracker/shared` をこのチェックアウト内のソースへ固定する。理由は helpers/shared-alias.ts
	resolve: {
		alias: SHARED_SRC_ALIAS,
	},
	test: {
		environment: "node",
		include: ["test/node/*.test.ts"],
	},
});
