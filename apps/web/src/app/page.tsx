import Link from "next/link";
import { fetchIssues } from "../lib/issues";
import { IssueList } from "./components/IssueList";

/**
 * トップページ。
 *
 * Server Component として API を呼んでいる。Client Component にしなかった理由:
 * - サーバー間通信になるためブラウザの CORS 設定に依存しない
 * - JS が無効でも、読み込み前でも Issue が見える（初回表示にローディングが挟まらない）
 * - App Router の素直な形。将来のフィルタも `searchParams` で実現できる
 */
export default async function Home() {
	const result = await fetchIssues();

	return (
		<main style={{ padding: "1rem", maxWidth: "48rem", margin: "0 auto" }}>
			<h1>World Issue Tracker</h1>
			<p>地球のバグを、みんなで可視化して、みんなで直す</p>
			<p style={{ color: "#666" }}>
				個人の困りごとから国際問題まで、あらゆるスコープの課題を Issue
				として起票し、みんなで解決に導くサービスです。
			</p>

			<p>
				<Link href="/issues/new">Issue を起票する</Link>
			</p>

			<section>
				<h2>Issues</h2>
				<IssueList result={result} />
			</section>
		</main>
	);
}
