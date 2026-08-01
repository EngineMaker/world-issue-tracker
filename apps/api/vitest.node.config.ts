import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// リポジトリのファイルを読むテスト。
// Workers ランタイムの node:fs は実ファイルシステムに繋がらないため Node 環境で動かす
export default defineConfig({
	resolve: {
		alias: {
			// shared はワークスペースの実ソースを直接見る。
			// git worktree で作業すると node_modules がメイン作業ディレクトリへの
			// シンボリックリンクになり、node_modules 経由では worktree 外の
			// 古い shared に解決されてしまうため
			"@world-issue-tracker/shared": path.resolve(
				here,
				"../../packages/shared/src/index.ts",
			),
		},
	},
	test: {
		environment: "node",
		include: ["test/node/*.test.ts"],
	},
});
