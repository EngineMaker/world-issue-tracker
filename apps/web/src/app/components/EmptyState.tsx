import type { ReactNode } from "react";

/**
 * 何も無いことを伝えるまとまり（Issue #95、見本は #94）。
 *
 * これまで 0 件の表示は本文と同じ `<p className="text-soft">` が 1 行
 * あるだけで、しかも出す場所ごとに書き方が割れていた
 * （`IssueList` / `MyIssueList` / `CommentSection` / 一覧ページの絞り込み結果で
 * 4 通り。「手伝います」は `text-soft` すら付いていなかった）。
 *
 * 読み込みに失敗したのか本当に無いのかが見分けにくいのが問題で、
 * 面を持たせて「これが答えだ」と示す。暖色（--sun-soft）を使うのは
 * ヒーローとここだけで、0 件が悪いことではないと色で伝える。
 *
 * `action` は空のときにこそ示す次の一歩（起票する、条件を解除する）。
 * 何も無い画面で行き止まりにしないための場所で、省略もできる
 * （コメント欄のように、すぐ下に入力欄がある場合は要らない）。
 */
export function EmptyState({
	message,
	action,
}: {
	message: string;
	action?: ReactNode;
}) {
	return (
		<div className="empty-state">
			<p className="empty-state-message">{message}</p>
			{action ? <p className="empty-state-action">{action}</p> : null}
		</div>
	);
}
