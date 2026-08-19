"use client";

import { useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteIssueError, deleteIssue } from "@/lib/issue-status";

/**
 * 起票者による Issue 自体の削除（#144）。
 *
 * API 側（`DELETE /issues/:id`）は所有者限定の物理削除を写真・サムネイルの
 * 後始末込みで実装済みだったが、そこへ到達する導線が画面に無かった。誤って
 * 作った Issue やテスト投稿、出したくなくなった投稿を、起票者が自分で
 * 取り下げられない状態だった（#124 のプライバシー方針とも噛み合っていない）。
 *
 * この部品は「起票者だと確定しているとき」にしか描画されない。起票者判定は
 * `IssueStatusSection`（`StatusControl.tsx`）が `GET /issues/:id/viewer` で
 * 一度だけ行っており、その結果を土台に呼び出される。ここで判定をやり直さない
 * のは、詳細ページで `/viewer` を二重に叩かないため（#144 の依存メモ）。
 *
 * 押してすぐには消さず、同じ場所で一度確認を挟む（コメント削除 #99 と同じ作法）。
 * 物理削除で元に戻せないため。確認を別画面のダイアログにしないのも #99 と同じで、
 * 何を消そうとしているのかが目の前に残っている方が取り違えにくい。
 *
 * `viewerIsOwner` を props で受けず、描画するかどうかを呼び出し側に委ねているのは
 * `StatusControl` と役割を分けるため。UI を隠すことは保護ではない。実際の権限は
 * API 側の `WHERE id = ? AND user_id = ?` が強制する。
 */
export function DeleteIssueButton({
	issueId,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	locale?: Locale;
}) {
	const { isLoaded, getToken } = useAuth();
	const router = useRouter();
	const messages = getUiMessages(locale);

	const [confirming, setConfirming] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = async () => {
		setError(null);
		setIsDeleting(true);

		try {
			await deleteIssue(issueId, await getToken());
			// 詳細ページはもう存在しない Issue を指しているので、その場に留めない。
			// 一覧へ戻す（Issue の対応案どおり）。`push` の後に `refresh` を挟み、
			// Server Component が持っている一覧のキャッシュから消えた Issue を落とす
			router.push("/issues");
			router.refresh();
		} catch (err) {
			// `DeleteIssueError.message` は開発者向けなので画面には出さない。
			// 401 だけ文言を分けるのは、そこだけ利用者の次の一手が変わるため
			// （時間をおいても直らない。ログインし直す必要がある）
			setError(
				err instanceof DeleteIssueError && err.status === 401
					? messages.issueDetail.deleteSignInRequired
					: messages.issueDetail.deleteFailed,
			);
			// 失敗したら詳細ページはまだ残っている。確認状態のまま、
			// もう一度試すかやめるかを選べるようにする
			setIsDeleting(false);
		}
		// 成功時は遷移するので、この後の状態更新はしない
	};

	return (
		// 視覚的な見出しは置かず、section の名前だけ読み上げに渡す。
		// 見出しを出すと、すぐ下の削除ボタンと同じ文言が二度読まれる
		<section className="issue-delete" aria-label={messages.issueDetail.delete}>
			{confirming ? (
				<div className="issue-delete-actions">
					<span className="issue-delete-confirm">
						{messages.issueDetail.deleteConfirm}
					</span>
					<button
						type="button"
						className="button-danger"
						onClick={handleDelete}
						disabled={isDeleting || !isLoaded}
						// 押した直後に何が起きているかを読み上げにも伝える
						aria-busy={isDeleting}
					>
						{isDeleting
							? messages.issueDetail.deleting
							: messages.issueDetail.deleteConfirmYes}
					</button>
					<button
						type="button"
						className="button-secondary"
						onClick={() => setConfirming(false)}
						disabled={isDeleting}
					>
						{messages.issueDetail.deleteConfirmCancel}
					</button>
					{error && <output className="notice text-danger">{error}</output>}
				</div>
			) : (
				<p className="issue-delete-actions">
					<button
						type="button"
						className="button-danger"
						onClick={() => {
							// 前の失敗の表示を持ち越さない
							setError(null);
							setConfirming(true);
						}}
					>
						{messages.issueDetail.delete}
					</button>
				</p>
			)}
		</section>
	);
}
