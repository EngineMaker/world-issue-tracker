import Link from "next/link";
import type { FetchMyIssuesResult } from "../../lib/issues";
import { IssueCard } from "./IssueList";

/**
 * 自分が起票した Issue の一覧を描画する。
 *
 * 公開一覧（`IssueList`）と分けているのは、失敗の意味が違うため。
 * こちらは「サインインしていない」という、利用者が自分で解消できる失敗が
 * 起こりうる。それを「時間をおいて再度お試しください」と同じ扱いにすると、
 * 何度待っても直らない案内を出し続けることになる。
 *
 * 0 件のときの文言も違う。公開一覧の「まだ Issue がありません」は
 * サービス全体に投稿が無いという意味だが、こちらは「あなたがまだ
 * 起票していない」という意味で、他の人の投稿は存在しうる。
 *
 * 取得そのものは呼び出し側（`page.tsx`）が行う。
 */
export function MyIssueList({ result }: { result: FetchMyIssuesResult }) {
	if (!result.ok) {
		if (result.unauthorized) {
			// ヘッダの「自分の Issue」リンクはサインイン中しか出ないため、
			// ここに来るのはセッションが切れたときか URL を直接開いたとき。
			// どちらもサインインし直せば解決するので、そう案内する。
			return (
				<div className="notice-block">
					<p className="block-message">
						自分が起票した Issue を見るにはサインインが必要です。
					</p>
					<p className="block-detail text-soft">
						画面右上の「Sign In」からサインインすると、ここに表示されます。
					</p>
				</div>
			);
		}

		return (
			<div className="error-block">
				<p className="block-message">
					Issue を取得できませんでした。時間をおいて再度お試しください。
				</p>
				<p className="block-detail">{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		return (
			<p className="text-soft">
				まだ Issue を起票していません。
				<Link href="/issues/new">最初の 1 件を書いてみる</Link>
			</p>
		);
	}

	return (
		<>
			<p className="list-summary">
				{result.total} 件中 {result.issues.length} 件を表示
			</p>
			<ul className="issue-cards">
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} />
				))}
			</ul>
		</>
	);
}
