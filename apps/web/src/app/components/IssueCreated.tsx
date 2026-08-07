import Link from "next/link";

/**
 * 起票が完了したことを伝える表示（Issue #68）。
 *
 * 以前は ID を文字列で出すだけだった。ID を控えるか全件一覧から探すしか
 * 追跡の手段が無く、起票者が再訪する理由を失っていた。ここから
 * 自分の Issue 一覧 (`/my-issues`) へ繋いで、投稿した困りごとの進展を
 * 後から確認できるようにする。
 *
 * 詳細画面 (`/issues/[id]`、#58) ができたので、投稿した 1 件へ直接向かう導線も
 * 併せて出す。「今書いたものを確かめたい」と「後から追跡したい」は別の欲求で、
 * 前者を一覧経由で探させると、直前に自分が書いたものを見失う。
 *
 * ID の表示は残している。URL を共有する / API から直接引くときの手掛かりになり、
 * リンクから辿れることとは用途が違うため。
 *
 * `page.tsx`（Client Component）から切り出しているのは、Clerk の hooks に
 * 依存しない純粋な描画にして、導線をテストから直接確認できるようにするため。
 */
export function IssueCreated({ id }: { id: string }) {
	return (
		<output style={{ display: "block", color: "#15803d" }}>
			起票しました（ID: {id}）。{" "}
			<Link href={`/issues/${id}`}>投稿した Issue を見る</Link>
			{" / "}
			<Link href="/my-issues">自分が起票した Issue</Link>
		</output>
	);
}
