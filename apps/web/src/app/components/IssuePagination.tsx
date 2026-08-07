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
}: {
	filters: IssueFilters;
	total: number;
	limit: number;
	offset: number;
}) {
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
		<nav aria-label="ページ送り" className="issue-pagination">
			<p>
				{hasPrevious ? (
					<Link href={buildIssuesHref({ ...filters, offset: previousOffset })}>
						前のページ
					</Link>
				) : (
					// リンクにしないことで「これ以上戻れない」ことを見せる
					<span style={{ color: "#999" }}>前のページ</span>
				)}
				{" / "}
				<span>
					{currentPage} / {totalPages} ページ
				</span>
				{" / "}
				{hasNext ? (
					<Link href={buildIssuesHref({ ...filters, offset: nextOffset })}>
						次のページ
					</Link>
				) : (
					<span style={{ color: "#999" }}>次のページ</span>
				)}
			</p>
		</nav>
	);
}
