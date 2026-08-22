/**
 * 詳細ページ（`IssueDetailPage`）を描画するテスト用の `fetch` スタブ応答。
 *
 * 詳細ページは Issue 本体・コメント（#60）・反応（#112）・表明（#61）の
 * 4 本を投げる。ここが返す既定の応答は **実 API のレスポンス契約に沿う**
 * ことを保証する場所で、複数のテストが同じ形を参照できるように切り出している。
 *
 * 契約からずれた応答（例: help-offers の `viewer_user_id` 欠落、reactions の
 * 未スタブ）を返すと、web 側パーサに弾かれてボタンが「取得に失敗しました」の
 * まま描画される。それに気付かず写真などを assert すると、成功状態を一度も
 * 通らないままモックが本物と乖離する（#139）。
 */

/**
 * 実 API 契約に沿った、コメント一覧の既定応答（空）。
 * `GET /issues/:id/comments`
 */
export function defaultCommentsResponse(): Response {
	return jsonResponse({ data: [], total: 0 });
}

/**
 * 実 API 契約に沿った、反応の既定応答（0 件・未反応）。
 * `GET /issues/:id/reactions` は常に `total` / `viewer_reacted` を返す。
 */
export function defaultReactionsResponse(): Response {
	return jsonResponse({ total: 0, viewer_reacted: false });
}

/**
 * 実 API 契約に沿った、表明の既定応答（0 件・未表明・未ログイン）。
 * `GET /issues/:id/help-offers` は常に `viewer_user_id` を返す
 * （未ログインなら null）。ここを欠くと `parseHelpOffersResponse` が null を返す。
 */
export function defaultHelpOffersResponse(): Response {
	return jsonResponse({
		data: [],
		total: 0,
		viewer_offered: false,
		viewer_user_id: null,
	});
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
