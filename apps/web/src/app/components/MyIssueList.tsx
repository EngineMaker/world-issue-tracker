import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
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
				<div style={{ padding: "0.5rem 0" }}>
					<p style={{ margin: "0 0 0.25rem" }}>
						{messages.myIssueList.signInRequired}
					</p>
					<p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
						{messages.myIssueList.signInHint}
					</p>
				</div>
			);
		}

		return (
			<div style={{ color: "#b00", padding: "0.5rem 0" }}>
				<p style={{ margin: "0 0 0.25rem" }}>
					{messages.issueList.fetchFailed}
				</p>
				<p style={{ margin: 0, fontSize: "0.85rem" }}>{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		return (
			<p style={{ color: "#666" }}>
				{messages.myIssueList.empty}
				<Link href="/issues/new">{messages.myIssueList.writeFirst}</Link>
			</p>
		);
	}

	return (
		<>
			<p style={{ color: "#666", fontSize: "0.85rem" }}>
				{messages.issueList.countSummary(result.total, result.issues.length)}
			</p>
			<ul style={{ padding: 0, margin: 0 }}>
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} locale={locale} />
				))}
			</ul>
		</>
	);
}
