import Link from "next/link";
import { fetchIssues } from "../../lib/issues";
import { IssueList } from "../components/IssueList";

/**
 * Issue 一覧ページ。
 *
 * トップページは説明が主なので抜粋を出し、こちらが一覧の本体になる。
 * トップと同じく Server Component として取得する（理由は app/page.tsx）。
 */
export default async function IssuesPage() {
	const result = await fetchIssues();

	return (
		<main>
			<h1>Issue 一覧</h1>
			<IssueList result={result} />
			<p>
				<Link href="/issues/new">Issue を書く</Link>
				{" / "}
				<Link href="/">トップへ戻る</Link>
			</p>
		</main>
	);
}
