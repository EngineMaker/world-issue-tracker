import Link from "next/link";

// 一覧の中身は #30（API 連携）で実装する。
// トップページから遷移した先が 404 にならないよう、入口だけ先に用意している。
export default function IssuesPage() {
	return (
		<main>
			<h1>Issue 一覧</h1>
			<p>
				投稿された Issue
				を一覧で表示する画面です。現在準備中で、まだ中身がありません。
			</p>
			<p>
				<Link href="/issues/new">Issue を書く</Link>
				{" / "}
				<Link href="/">トップへ戻る</Link>
			</p>
		</main>
	);
}
