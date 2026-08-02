import { fileURLToPath } from "node:url";

/**
 * `@world-issue-tracker/shared` を、このチェックアウト内の
 * `packages/shared/src/index.ts` に固定するための vitest エイリアス。
 *
 * なぜ必要か:
 *
 * bun のワークスペースは `apps/api/node_modules/@world-issue-tracker/shared` を
 * `../../../../packages/shared` への相対シンボリックリンクとして張る。
 * git worktree で作業する場合、`node_modules` 自体がメインのチェックアウトへの
 * シンボリックリンクになるため、この相対リンクは worktree の外
 * （＝メイン側の `packages/shared`）に着地する。
 *
 * その結果、worktree で `packages/shared` を編集してもテストは編集前のソースを
 * 読み続ける。スキーマの制約を丸ごと消しても全テストが通る、という形で現れる
 * （制約を守るテストを追加しても、その追加自体が無意味になる）。
 *
 * ここでこの設定ファイルからの相対パスを解決して固定することで、
 * 「テスト対象は常に、いま編集しているチェックアウトのソース」を保証する。
 * メインのチェックアウトで実行した場合は同じ場所を指すため、挙動は変わらない。
 */
export const SHARED_SRC_ALIAS = {
	"@world-issue-tracker/shared": fileURLToPath(
		new URL("../../../../packages/shared/src/index.ts", import.meta.url),
	),
};
