"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getAuthorLabel,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import { useEffect, useRef, useState } from "react";
import {
	applyViewerFlags,
	COMMENT_MAX_LENGTH,
	DeleteCommentError,
	deleteComment,
	type FetchCommentsResult,
	PostCommentError,
	type PublicComment,
	postComment,
	validateCommentBody,
} from "@/lib/comments";
import {
	formatCreatedAt,
	toDateTimeTooltip,
	toIsoDateTime,
} from "@/lib/datetime";
import { fetchComments } from "@/lib/issues";
import { EmptyState } from "./EmptyState";

/**
 * コメント欄の節に付ける id（#114）。
 *
 * 「手伝います」を押した人が、そのまま話し始められるようにするための
 * アンカー先。`HelpOfferButton` の導線がここを指す。
 * 文字列を両方に直書きすると片方だけ変えたときに黙って壊れるので、
 * 行き先を持っている側で定数として公開する。
 */
export const COMMENTS_SECTION_ID = "comments";

/**
 * Issue 詳細ページのコメント欄。
 *
 * 初期表示ぶんのコメントは Server Component 側（`fetchComments`）で取得して
 * props で受け取る。投稿はブラウザから直接 API を叩く必要がある
 * （Clerk のセッショントークンを `Authorization: Bearer` で渡すため）ので、
 * この部分だけ Client Component にしている。
 *
 * 投稿に成功したら、ページ全体を再取得せずに手元の一覧へ追記する。
 * 書いた直後に自分の言葉が並ぶことが「みんなで直す」の入口なので、
 * 反映までに再読み込みを挟まない。
 */
export function CommentSection({
	issueId,
	initialResult,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	initialResult: FetchCommentsResult;
	locale?: Locale;
}) {
	const { isLoaded, isSignedIn, getToken } = useAuth();
	const messages = getUiMessages(locale);

	// 取得に失敗していたときは空から始める。失敗の表示は別に出す
	const [comments, setComments] = useState<PublicComment[]>(
		initialResult.ok ? initialResult.comments : [],
	);
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// 削除の確認中・送信中のコメント（#99）。同時に 1 件しか扱わないので
	// ID を 1 つ持てば足りる
	const [confirmingId, setConfirmingId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	// `getToken` は effect の依存に入れず ref 経由で読む
	// （理由は `StatusControl` の同じ書き方のコメントを参照）
	const getTokenRef = useRef(getToken);
	getTokenRef.current = getToken;

	/**
	 * どれが自分のコメントかをブラウザ側で確かめ直す（#99）。
	 *
	 * 詳細ページ（Server Component）は API へトークンを渡していないため、
	 * サーバー側で描画された一覧は `viewer_is_author` が全件 false になる。
	 * そのままだと自分のコメントにも削除ボタンが出ない。
	 * `HelpOfferButton` の `viewer_offered` と同じ事情で、判定はここで行う。
	 *
	 * 失敗しても何も出さない。削除できないだけで会話は読めており、
	 * 「削除ボタンを出すための問い合わせに失敗しました」と伝えても
	 * 利用者にできることが無い（再読み込みで再試行される）。
	 */
	useEffect(() => {
		// Clerk の読み込みが終わるまではトークンを取れない
		if (!isLoaded) return;
		// 未ログインなら自分のコメントは存在しない。API を叩かない
		if (!isSignedIn) return;

		// 取得中に別の Issue へ遷移したら、古い応答で上書きしない
		let cancelled = false;

		(async () => {
			const result = await fetchComments(issueId, {
				token: await getTokenRef.current(),
			});
			if (cancelled || !result.ok) return;
			setComments((current) => applyViewerFlags(current, result.comments));
		})();

		return () => {
			cancelled = true;
		};
	}, [issueId, isLoaded, isSignedIn]);

	/**
	 * 自分のコメントを削除する。
	 *
	 * 消えたことは一覧からカードが減ることで分かるので、完了の表示は出さない
	 * （成功したことを伝える表示は #99 の論点 A として見送られている）。
	 */
	const handleDelete = async (commentId: string) => {
		setDeleteError(null);
		setDeletingId(commentId);

		try {
			await deleteComment(issueId, commentId, await getToken());
			setComments((current) =>
				current.filter((comment) => comment.id !== commentId),
			);
			setConfirmingId(null);
		} catch (err) {
			// `DeleteCommentError.message` は開発者向けなので画面には出さない。
			// 401 だけ文言を分けるのは、そこだけ利用者の次の一手が変わるため
			// （時間をおいても直らない。ログインし直す必要がある）
			setDeleteError(
				err instanceof DeleteCommentError && err.status === 401
					? messages.comments.deleteSignInRequired
					: messages.comments.deleteFailed,
			);
		} finally {
			setDeletingId(null);
		}
	};

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);

		// 送信前に手元で検証する。制約は `packages/shared` のスキーマ一本
		const validated = validateCommentBody(body);
		if (!validated.success) {
			setError(validated.error);
			return;
		}

		setIsSubmitting(true);
		try {
			const created = await postComment(
				issueId,
				validated.body,
				await getToken(),
			);
			// 古い順に並べているので末尾に足す
			setComments((current) => [...current, created]);
			setBody("");
		} catch (err) {
			setError(
				err instanceof PostCommentError
					? err.message
					: messages.common.unexpectedError,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		// 見出しではなく節に id を付ける。飛んだときに見出しから読み始められる
		<section id={COMMENTS_SECTION_ID}>
			<h2>{messages.comments.heading(comments.length)}</h2>
			<p className="section-lead">{messages.comments.guide}</p>

			{!initialResult.ok && (
				<div className="error-block">
					<p className="block-message">{messages.comments.fetchFailed}</p>
					<p className="block-detail">{initialResult.error}</p>
				</div>
			)}

			{/*
			  コメント 0 件（#95）。次の一歩（`action`）は渡していない。
			  すぐ下に入力欄があるので、導線を重ねると同じことを 2 回言うことになる
			*/}
			{initialResult.ok && comments.length === 0 && (
				<EmptyState message={messages.comments.empty} />
			)}

			{comments.length > 0 && (
				<ul className="comment-cards">
					{comments.map((comment) => (
						<li key={comment.id} className="comment-card">
							{/*
							  誰が書いたか（#67）。本文と日時だけだと、起票者本人の
							  追記なのか第三者の助言なのかが分からず、読み手の
							  受け取り方が変わる。

							  匿名で立てられた Issue の起票者本人には名前を出さない
							  （API が `is_anonymous` を真で返す）。出し分けの規則は
							  一覧・詳細の起票者と同じ `getAuthorLabel` に寄せてある
							*/}
							<p className="comment-author">
								{getAuthorLabel(
									{
										isAnonymous: comment.is_anonymous,
										displayName: comment.display_name,
									},
									locale,
								)}
							</p>
							{/* 改行を含む本文をそのまま読めるようにする */}
							<p className="comment-body">{comment.body}</p>
							<p className="comment-date">
								<time
									dateTime={toIsoDateTime(comment.created_at)}
									title={toDateTimeTooltip(comment.created_at, locale)}
								>
									{formatCreatedAt(comment.created_at, locale)}
								</time>
							</p>

							{/*
							  自分のコメントの削除（#99）。誤投稿や書き間違いを
							  取り消せないことが、書くこと自体のハードルを上げていた。

							  出るのは自分のコメントだけ。`viewer_is_author` は API が
							  返す真偽値で、生の `user_id` は公開されない（#8 の方針）。
							  他人の分に出ないのは見た目の話ではなく、API 側も
							  投稿者以外の削除を 403 で弾く。

							  押してすぐには消さず、同じカードの中で一度確認する。
							  物理削除で元に戻せないため。確認を別画面のダイアログに
							  しないのは、どれを消そうとしているのかが目の前に
							  残っている方が取り違えにくいから
							*/}
							{comment.viewer_is_author &&
								(confirmingId === comment.id ? (
									<div className="comment-actions">
										<span className="comment-delete-confirm">
											{messages.comments.deleteConfirm}
										</span>
										<button
											type="button"
											className="button-danger"
											onClick={() => handleDelete(comment.id)}
											disabled={deletingId === comment.id}
											// 押した直後に何が起きているかを読み上げにも伝える
											aria-busy={deletingId === comment.id}
										>
											{deletingId === comment.id
												? messages.comments.deleting
												: messages.comments.deleteConfirmYes}
										</button>
										<button
											type="button"
											className="button-secondary"
											onClick={() => setConfirmingId(null)}
											disabled={deletingId === comment.id}
										>
											{messages.comments.deleteConfirmCancel}
										</button>
										{deleteError && (
											<output className="notice text-danger">
												{deleteError}
											</output>
										)}
									</div>
								) : (
									<p className="comment-actions">
										<button
											type="button"
											className="button-secondary"
											onClick={() => {
												// 前の失敗の表示を次のコメントへ持ち越さない
												setDeleteError(null);
												setConfirmingId(comment.id);
											}}
										>
											{messages.comments.delete}
										</button>
									</p>
								))}
						</li>
					))}
				</ul>
			)}

			{/*
			  未ログインでも入力欄は見せる。何を書く場所か分からないまま
			  ログインを求められるより、書ける内容が分かってから促す方が親切
			  （起票フォームと同じ方針）。
			*/}
			{isLoaded && !isSignedIn && (
				<output className="notice text-warning">
					{messages.comments.signInRequired}
					<SignInButton mode="modal">
						<button type="button" className="button-secondary">
							{messages.common.signIn}
						</button>
					</SignInButton>
				</output>
			)}

			{/*
			  `.issue-form` は起票フォーム専用の見た目ではなく、入力要素の
			  スタイルを閉じ込めるためのスコープ（globals.css のコメント参照）。
			  これが無いと textarea に幅の指定がまったく当たらず、
			  2000 文字書ける入力欄がブラウザ既定の `cols` 幅（約 3 行分）で
			  表示されていた（Issue #93）
			*/}
			<form className="issue-form" onSubmit={handleSubmit} noValidate>
				<p className="form-field">
					<label htmlFor="comment-body" className="field-label">
						{messages.comments.label}
					</label>
					<span className="field-hint" id="comment-body-hint">
						{messages.comments.lengthHint(COMMENT_MAX_LENGTH)}
					</span>
					<textarea
						id="comment-body"
						value={body}
						onChange={(event) => setBody(event.target.value)}
						rows={4}
						maxLength={COMMENT_MAX_LENGTH}
						placeholder={messages.comments.placeholder}
						aria-describedby="comment-body-hint"
					/>
				</p>

				{error && (
					<output className="notice text-danger">
						{error}
						{/* 未ログインが原因なら、その場でサインインできるようにする */}
						{!isSignedIn && (
							<SignInButton mode="modal">
								<button type="button" className="button-secondary">
									{messages.common.signIn}
								</button>
							</SignInButton>
						)}
					</output>
				)}

				{/*
				  送信中は `aria-busy` を立てる（#95）。文言（「送信中…」）は
				  目で見れば分かるが、読み上げでは押した直後に何が起きているかが
				  伝わらない。#94 が挙げた「押した手応えが無い」への対応
				*/}
				<button
					type="submit"
					className="button-primary"
					disabled={isSubmitting}
					aria-busy={isSubmitting}
				>
					{isSubmitting ? messages.common.submitting : messages.comments.submit}
				</button>
			</form>
		</section>
	);
}
