/**
 * ページ遷移中に「読み込んでいる」ことを伝えるまとまり（Issue #146）。
 *
 * App Router のクライアント遷移（`<Link>`）では、遷移先の Server Component が
 * 届くまで画面が前のまま据え置かれ、押した手応えがゼロになる。各ルートの
 * `loading.tsx`（Suspense フォールバック）からこれを出すと、押した瞬間に
 * 反応が返る。ボタン操作の「送信中…」（`common.submitting`）と同じ発想で、
 * 「押しても何も起きないように見える時間」を作らないための部品。
 *
 * `EmptyState` と同じく、出す場所ごとに書き方が割れるのを防ぐために 1 つに
 * まとめている。`aria-busy` で処理中であることを、`aria-live="polite"` で
 * 文言の出現を、支援技術にも伝える（送信中の各ボタンが `aria-busy` を
 * 付けているのと揃える）。
 */
export function LoadingState({ message }: { message: string }) {
	return (
		<div className="loading-state" aria-busy="true" aria-live="polite">
			<p className="loading-state-message">{message}</p>
		</div>
	);
}
