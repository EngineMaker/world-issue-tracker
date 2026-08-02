/**
 * 型チェックが `@world-issue-tracker/shared` をこのチェックアウト内で解決するかの検査。
 *
 * bun のワークスペースは各アプリの
 * `node_modules/@world-issue-tracker/shared` を
 * `packages/shared` への相対シンボリックリンクとして張る。git worktree では
 * `node_modules` 自体がメインのチェックアウトへのシンボリックリンクになるため、
 * このリンクは worktree の外に着地する。
 *
 * その状態で `tsc --noEmit` を走らせると、worktree で `packages/shared` を
 * 編集しても型チェックは編集前のソースを見続ける。`packages/shared` から
 * エクスポートを丸ごと消しても、それを import している `apps/api` の型チェックが
 * exit 0 で通る、という形で現れる（#50）。
 *
 * vitest 側には同じ根の問題への対策（`test/helpers/shared-alias.ts` の
 * `SHARED_SRC_ALIAS`）が既に入っている。ここは型チェック側の対策
 * （各 tsconfig の `paths`）が消えていないことを固定する。
 *
 * なぜユニットテストとして書くか: この事故は「型チェックが通ってしまう」形で
 * 現れるため、型チェック自身では捕まえられない。メインのチェックアウトでは
 * そもそも再現しない（リンク先と自分が同じ場所を指す）ため、CI でも表に出ない。
 * 設定ファイルの記述そのものを検査するのが唯一の経路になる。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../helpers/jsonc";
import { SHARED_SRC_ALIAS } from "../helpers/shared-alias";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** `paths` を持つワークスペース。両方に同じ対策が要る（片方だけだともう片方から再発する） */
const WORKSPACES = ["apps/api", "apps/web"] as const;

const SHARED_SPECIFIER = "@world-issue-tracker/shared";

/**
 * tsconfig の `compilerOptions.paths` から shared のエントリを取り出し、
 * tsc と同じ規則で絶対パスへ解決する。
 *
 * 基準は `baseUrl` があればそこ、無ければ tsconfig 自身の場所（TS 4.1 以降）。
 * ここを tsc と揃えておかないと、`baseUrl` を足しただけで解決先が実際には
 * worktree の外へずれるのに、このテストは通り続ける（＝退行を見逃す）。
 */
function readSharedPaths(workspace: string): string[] {
	const workspaceDir = join(repoRoot, workspace);
	const config = parseJsonc(
		readFileSync(join(workspaceDir, "tsconfig.json"), "utf8"),
	);
	if (typeof config !== "object" || config === null) {
		throw new Error(`${workspace}/tsconfig.json がオブジェクトではない`);
	}
	const compilerOptions = (config as { compilerOptions?: unknown })
		.compilerOptions;
	if (typeof compilerOptions !== "object" || compilerOptions === null)
		return [];
	const { baseUrl, paths } = compilerOptions as {
		baseUrl?: unknown;
		paths?: unknown;
	};
	if (typeof paths !== "object" || paths === null) return [];
	const entry = (paths as Record<string, unknown>)[SHARED_SPECIFIER];
	if (!Array.isArray(entry)) return [];

	const base =
		typeof baseUrl === "string" ? resolve(workspaceDir, baseUrl) : workspaceDir;
	return entry
		.filter((value): value is string => typeof value === "string")
		.map((value) => resolve(base, value));
}

describe.each(WORKSPACES)("%s の tsconfig", (workspace) => {
	it(`paths で ${SHARED_SPECIFIER} を固定している`, () => {
		// これが無いと worktree で shared を編集しても型エラーが出ない（#50）
		expect(
			readSharedPaths(workspace),
			`${workspace}/tsconfig.json の compilerOptions.paths に ${SHARED_SPECIFIER} が無い`,
		).not.toHaveLength(0);
	});

	/**
	 * 検査対象のパスを取り出す。空なら「固定していない」ので、
	 * 後続の for ループが 0 周で素通りしないようここで落とす。
	 */
	const sharedPaths = () => {
		const paths = readSharedPaths(workspace);
		expect(
			paths,
			`${workspace} が ${SHARED_SPECIFIER} を固定していない`,
		).not.toHaveLength(0);
		return paths;
	};

	it("paths の指す先が実在する", () => {
		// パスを書き間違えても tsc は黙って node_modules 経由の解決に戻る。
		// 「設定はあるが効いていない」状態を捕まえる
		for (const target of sharedPaths()) {
			expect(existsSync(target), `${target} が存在しない`).toBe(true);
		}
	});

	it("paths の指す先がこのチェックアウト内にある", () => {
		// 本題。worktree の外（メインのチェックアウト）を指していたら意味が無い。
		// realpath で比較するのは、シンボリックリンク経由で外へ出る書き方
		// （node_modules を通る相対パス等）を弾くため
		const expected = realpathSync(
			join(repoRoot, "packages/shared/src/index.ts"),
		);
		for (const target of sharedPaths()) {
			expect(
				realpathSync(target),
				`${workspace} の paths がこのチェックアウトの外を指している`,
			).toBe(expected);
		}
	});

	it("vitest 側のエイリアスと同じソースを指している", () => {
		// 型チェックとテストで別のソースを見ていたら、片方だけ通る状態が生まれる。
		// #50 の対応方針（両者を揃える）が崩れていないことを固定する
		const expected = realpathSync(SHARED_SRC_ALIAS[SHARED_SPECIFIER]);
		for (const target of sharedPaths()) {
			expect(realpathSync(target)).toBe(expected);
		}
	});
});
