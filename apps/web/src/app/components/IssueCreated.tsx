import Link from "next/link";

/**
 * 起票が完了したことを伝える表示（Issue #68）。
 *
 * 以前は ID を文字列で出すだけだった。ID を控えるか全件一覧から探すしか
 * 追跡の手段が無く、起票者が再訪する理由を失っていた。ここから
 * 自分の Issue 一覧 (`/my-issues`) へ繋いで、投稿した困りごとの進展を
 * 後から確認できるようにする。
 *
 * ID の表示は残している。詳細画面 (`/issues/[id]`、#58) がまだ無いため、
 * API から直接引くときの手掛かりが他に無いため。
 *
 * `page.tsx`（Client Component）から切り出しているのは、Clerk の hooks に
 * 依存しない純粋な描画にして、導線をテストから直接確認できるようにするため。
 */
export function IssueCreated({ id }: { id: string }) {
	return (
		<output style={{ display: "block", color: "#15803d" }}>
			起票しました（ID: {id}）。{" "}
			<Link href="/my-issues">自分が起票した Issue を見る</Link>
		</output>
	);
}
