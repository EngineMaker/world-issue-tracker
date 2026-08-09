import { getUiMessages } from "@world-issue-tracker/shared";
import Link from "next/link";
import {
	fetchIssues,
	hasActiveFilters,
	parseIssueFilters,
	type RawSearchParams,
} from "../../lib/issues";
import { getLocale } from "../../lib/locale";
import { EmptyState } from "../components/EmptyState";
import { IssueFilterForm } from "../components/IssueFilterForm";
import { IssueList } from "../components/IssueList";
import { IssuePagination } from "../components/IssuePagination";

/** 1 ページに表示する件数。API 側の上限は 100 */
const PAGE_SIZE = 20;

/**
 * Issue 一覧ページ。
 *
 * トップページは説明が主なので抜粋を出し、こちらが一覧の本体になる。
 * トップと同じく Server Component として取得する（理由は app/page.tsx）。
 *
 * 絞り込み・並べ替え・ページ位置はすべて `searchParams` に載せている。
 * 状態を URL が持つので、条件付きの一覧をそのまま共有・ブックマークでき、
 * ブラウザの戻るボタンも期待どおりに効く。Client Component の状態管理は要らない。
 */
export default async function IssuesPage({
	searchParams,
}: {
	// Next.js 15 以降 `searchParams` は Promise で渡る
	searchParams: Promise<RawSearchParams>;
}) {
	const locale = await getLocale();
	const messages = getUiMessages(locale);
	const filters = parseIssueFilters(await searchParams);
	const result = await fetchIssues({ limit: PAGE_SIZE, filters });

	return (
		<main>
			<h1>{messages.issuesPage.heading}</h1>

			<IssueFilterForm filters={filters} locale={locale} />

			{/*
			  絞り込みの結果 0 件になったときに「まだ Issue がありません」とだけ
			  出ると、投稿が 1 件も無いのか条件に合わないのかが区別できない。
			  条件が付いているときは、条件のせいであることをここで伝える
			*/}
			{result.ok && result.issues.length === 0 && hasActiveFilters(filters) ? (
				<EmptyState
					message={messages.issuesPage.noMatch}
					action={<Link href="/issues">{messages.filterForm.clear}</Link>}
				/>
			) : (
				<IssueList result={result} locale={locale} />
			)}

			{result.ok ? (
				<IssuePagination
					filters={filters}
					total={result.total}
					limit={result.limit}
					offset={result.offset}
					locale={locale}
				/>
			) : null}

			{/*
			  ページ末尾の導線（#95）。区切りの「/」を CSS の余白に置き換えた。
			  文字で区切ると、狭い画面で区切りだけが行頭に残る
			*/}
			<p className="page-nav">
				<Link href="/issues/new">{messages.issuesPage.writeIssue}</Link>
				<Link href="/">{messages.issuesPage.backToHome}</Link>
			</p>
		</main>
	);
}
