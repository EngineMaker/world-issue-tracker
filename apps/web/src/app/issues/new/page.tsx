import Link from "next/link";

// 起票フォームは #31 で実装する。
// トップページから遷移した先が 404 にならないよう、入口だけ先に用意している。
export default function NewIssuePage() {
	return (
		<main>
			<h1>Issue を書く</h1>
			<p>
				困っていることを投稿する画面です。現在準備中で、まだ投稿できません。
			</p>
			<p>
				<Link href="/issues">Issue 一覧を見る</Link>
				{" / "}
				<Link href="/">トップへ戻る</Link>
			</p>
		</main>
	);
}
