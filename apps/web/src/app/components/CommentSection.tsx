"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import { useState } from "react";
import {
	COMMENT_MAX_LENGTH,
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
