import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import type { FetchMyIssuesResult } from "../../lib/issues";
import { EmptyState } from "./EmptyState";
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
export function MyIssueList({
	result,
	locale = DEFAULT_LOCALE,
}: {
	result: FetchMyIssuesResult;
	locale?: Locale;
}) {
	const messages = getUiMessages(locale);

	if (!result.ok) {
		if (result.unauthorized) {
			// ヘッダの「自分の Issue」リンクはサインイン中しか出ないため、
			// ここに来るのはセッションが切れたときか URL を直接開いたとき。
			// どちらもサインインし直せば解決するので、そう案内する。
			return (
				<div className="notice-block">
					<p className="block-message">{messages.myIssueList.signInRequired}</p>
					<p className="block-detail text-soft">
						{messages.myIssueList.signInHint}
					</p>
				</div>
			);
		}

		return (
			<div className="error-block">
				<p className="block-message">{messages.issueList.fetchFailed}</p>
				<p className="block-detail">{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		/*
		 * 0 件（#95）。以前は本文と導線が空白も挟まずに繋がっていて
		 * 「まだ Issue を起票していません。最初の 1 件を書いてみる」が
		 * 1 つの文のように見えていた。まとまりを分けて、次の一歩を
		 * 独立した導線として示す
		 */
		return (
			<EmptyState
				message={messages.myIssueList.empty}
				action={
					<Link href="/issues/new">{messages.myIssueList.writeFirst}</Link>
				}
			/>
		);
	}

	return (
		<>
			<p className="list-summary">
				{messages.issueList.countSummary(result.total, result.issues.length)}
			</p>
			<ul className="issue-cards">
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} locale={locale} />
				))}
			</ul>
		</>
	);
}
