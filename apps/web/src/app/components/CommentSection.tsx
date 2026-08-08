"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { useState } from "react";
import {
	COMMENT_MAX_LENGTH,
	type FetchCommentsResult,
	PostCommentError,
	type PublicComment,
	postComment,
	validateCommentBody,
} from "@/lib/comments";
import { formatCreatedAt } from "./IssueList";

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
}: {
	issueId: string;
	initialResult: FetchCommentsResult;
}) {
	const { isLoaded, isSignedIn, getToken } = useAuth();

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
					: "予期しないエラーが発生しました。時間をおいて再度お試しください。",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section>
			<h2>コメント（{comments.length}）</h2>
			<p className="section-lead">
				誰かを責めるためではなく、直すために書く場所です。似た経験、現地の状況、
				使えそうな制度や連絡先など、解決に近づく情報を歓迎します。
			</p>

			{!initialResult.ok && (
				<div className="error-block">
					<p className="block-message">
						コメントを取得できませんでした。時間をおいて再度お試しください。
					</p>
					<p className="block-detail">{initialResult.error}</p>
				</div>
			)}

			{initialResult.ok && comments.length === 0 && (
				<p className="text-soft">
					まだコメントがありません。最初の一言を書いてみてください。
				</p>
			)}

			{comments.length > 0 && (
				<ul className="comment-cards">
					{comments.map((comment) => (
						<li key={comment.id} className="comment-card">
							{/* 改行を含む本文をそのまま読めるようにする */}
							<p className="comment-body">{comment.body}</p>
							<p className="comment-date">
								<time dateTime={comment.created_at}>
									{formatCreatedAt(comment.created_at)}
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
					コメントの投稿にはサインインが必要です。
					<SignInButton mode="modal">
						<button type="button" className="button-secondary">
							サインイン
						</button>
					</SignInButton>
				</output>
			)}

			<form onSubmit={handleSubmit} noValidate>
				<p className="form-field">
					<label htmlFor="comment-body" className="field-label">
						コメント
					</label>
					<span className="field-hint" id="comment-body-hint">
						{COMMENT_MAX_LENGTH} 文字以内。
					</span>
					<textarea
						id="comment-body"
						value={body}
						onChange={(event) => setBody(event.target.value)}
						rows={4}
						maxLength={COMMENT_MAX_LENGTH}
						placeholder="例: 同じ場所で先週も転びそうになりました。市の窓口には〇〇という制度があるようです。"
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
									サインイン
								</button>
							</SignInButton>
						)}
					</output>
				)}

				<button
					type="submit"
					className="button-primary"
					disabled={isSubmitting}
				>
					{isSubmitting ? "送信中…" : "コメントする"}
				</button>
			</form>
		</section>
	);
}
