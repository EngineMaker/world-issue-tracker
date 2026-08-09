/**
 * 本番デプロイの直前に Clerk のキー種別を検査する（#98）。
 *
 * 開発用インスタンスのキー（`pk_test_` / `sk_test_`）で本番ビルドを作っても、
 * ビルドもテストも型検査も全部通る。認証も一見動く。壊れているのは
 * 「利用者数が Clerk の開発用上限に達したらサインインできなくなる」ことと
 * 「サインイン画面に Development mode が出る」ことだけで、どちらも
 * 出してからでないと分からない。実際 #98 はそうやって見つかっている。
 *
 * そこで、本番の成果物を作る経路にだけ関門を置く。開発用キーなら
 * 非ゼロで終了し、`bun run deploy` がビルドまで到達しない。
 *
 * `next build` 側ではなくここに置いた理由:
 * ローカルの `bun run build` や CI の型検査は開発用キー（あるいはキー無し）で
 * 回すのが正しい。そこを落とすと、キーを持たない環境で誰もビルドできなくなる。
 * 止めるべきなのは「本番へ出る一本」だけなので、`deploy` スクリプトに繋ぐ。
 *
 * NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY と CLERK_SECRET_KEY の両方を見る。
 * 片方だけ本番用に切り替えると、トークンを発行した先と検証する先が
 * 食い違って認証が通らなくなる（#98 の補足に書かれている失敗）。
 * どちらか一方でも本番用でなければ止める。
 */

import {
	clerkKeyKind,
	isUnsafeForProduction,
} from "@world-issue-tracker/shared";

/** 検査対象。名前は実際の環境変数名と揃える（エラーメッセージにそのまま出す）。 */
const REQUIRED_KEYS = [
	"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
	"CLERK_SECRET_KEY",
] as const;

/**
 * 検査結果。問題があった環境変数名とその理由を並べる。
 *
 * 最初の 1 件で打ち切らないのは、片方だけ直して再実行 → もう片方で落ちる、
 * を繰り返させないため。両方まとめて出す。
 */
export function findUnsafeClerkKeys(
	env: Record<string, string | undefined>,
): string[] {
	const problems: string[] = [];

	for (const name of REQUIRED_KEYS) {
		const value = env[name];
		if (!isUnsafeForProduction(value)) {
			continue;
		}

		if (!value) {
			problems.push(`${name} が設定されていません`);
			continue;
		}

		const kind = clerkKeyKind(value);
		if (kind === "development") {
			problems.push(
				`${name} が開発用インスタンスのキーです（${value.slice(0, 8)}...）`,
			);
			continue;
		}

		// 接頭辞が pk_/sk_ の test/live どちらでもない。Clerk の仕様変更か
		// 設定ミス。判定できない以上、本番に出してよいとは言えない。
		problems.push(
			`${name} が Clerk のキーの形式（pk_live_ / sk_live_）と一致しません`,
		);
	}

	return problems;
}

function main(): void {
	const problems = findUnsafeClerkKeys(process.env);
	if (problems.length === 0) {
		return;
	}

	console.error(
		[
			"本番デプロイを中止しました: Clerk のキーが本番用インスタンスのものではありません（#98）。",
			"",
			...problems.map((problem) => `  - ${problem}`),
			"",
			"開発用インスタンスには Clerk 側の利用者数上限があり、上限に達すると",
			"サインインできなくなります。またサインイン画面に「Development mode」が表示されます。",
			"",
			"Clerk ダッシュボードで本番インスタンスを作成し、pk_live_ / sk_live_ のキーを",
			"GitHub のリポジトリ Secrets に設定してください",
			"（NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY）。",
			"web と api の両方を同時に切り替えること。片方だけだとトークンを発行した先と",
			"検証する先が食い違い、認証が通らなくなります。",
		].join("\n"),
	);
	process.exit(1);
}

// テストから import したときに実行されないよう、直接起動されたときだけ動かす。
if (import.meta.main) {
	main();
}
