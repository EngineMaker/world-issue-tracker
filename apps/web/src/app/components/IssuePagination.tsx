import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { buildIssuesHref, type IssueFilters } from "../../lib/issues";

/**
 * 一覧のページ送り。
 *
 * offset ベースのリンクにしている。API はカーソルページングも持つが、
 * カーソルは「前のページ」へ戻れず、`?offset=` のように URL 単体で
 * 位置を表せない（＝ページを直接ブックマークできない）。一覧の UI としては
 * 前後に行き来できることの方が要るので、こちらを使う。
 * 深いページで読み取り行数が増える点は、件数が実際に増えてから見直す。
 *
 * `Link` にしているのは Server Component のままページ送りを成立させるため。
 * JS が無効でも通常のリンクとして機能する。
 */
export function IssuePagination({
	filters,
	total,
	limit,
	offset,
	locale = DEFAULT_LOCALE,
}: {
	filters: IssueFilters;
	total: number;
	limit: number;
	offset: number;
	locale?: Locale;
}) {
	const messages = getUiMessages(locale);

	// 1 ページに収まるなら何も出さない。押せないボタンだけが並ぶより、
	// ページ送りという概念自体を見せない方が読みやすい
	if (total <= limit) {
		return null;
	}

	// 表示中のページ番号は 1 始まり。offset が limit の倍数でない
	// （URL を手で編集した）場合でも、切り上げて「何ページ目相当か」を出す
	const currentPage = Math.floor(offset / limit) + 1;
	const totalPages = Math.max(1, Math.ceil(total / limit));

	const previousOffset = Math.max(0, offset - limit);
	const nextOffset = offset + limit;

	const hasPrevious = offset > 0;
	const hasNext = nextOffset < total;

	return (
		<nav aria-label={messages.pagination.label} className="issue-pagination">
			{/*
			  区切りの「/」は CSS の余白（.issue-pagination-inner の gap）に
			  置き換えた（Issue #95）。文字で区切ると、狭い画面で区切り文字だけが
			  行頭に取り残される。読み上げでも「スラッシュ」が読まれて邪魔になる
			*/}
			<p className="issue-pagination-inner">
				{hasPrevious ? (
					<Link href={buildIssuesHref({ ...filters, offset: previousOffset })}>
						{messages.pagination.previous}
					</Link>
				) : (
					// リンクにしないことで「これ以上戻れない」ことを見せる
					<span className="text-faint">{messages.pagination.previous}</span>
				)}
				<span className="issue-pagination-position">
					{messages.pagination.position(currentPage, totalPages)}
				</span>
				{hasNext ? (
					<Link href={buildIssuesHref({ ...filters, offset: nextOffset })}>
						{messages.pagination.next}
					</Link>
				) : (
					<span className="text-faint">{messages.pagination.next}</span>
				)}
			</p>
		</nav>
	);
}
