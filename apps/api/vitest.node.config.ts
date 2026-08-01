import { defineConfig } from "vitest/config";

// リポジトリのファイルを読むテスト。
// Workers ランタイムの node:fs は実ファイルシステムに繋がらないため Node 環境で動かす
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/node/*.test.ts"],
	},
});
