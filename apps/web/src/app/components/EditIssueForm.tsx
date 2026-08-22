"use client";

import { useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	type IssueScope as IssueScopeType,
	type Locale,
	UpdateIssueSchema,
} from "@world-issue-tracker/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ISSUE_CATEGORY_SUGGESTIONS } from "@/lib/api";
import { EditIssueError, updateIssue } from "@/lib/issue-status";

/**
 * 起票者による Issue 本文の編集（#143）。
 *
 * API（`PATCH /issues/:id`）は `title` / `description` / `scope` / `category` の
 * 部分更新を所有者限定で受けていたが、画面から送っていたのは `status` だけで、
 * 投稿後に本文を直す導線がどこにも無かった。誤字・情報の追記・状況の変化、
 * スコープの取り違えに対して、起票者が自分の Issue を直せない状態だった。
 *
 * この部品は「起票者だと確定しているとき」にしか描画されない。起票者判定は
 * `IssueStatusSection`（`StatusControl.tsx`）が `GET /issues/:id/viewer` で
 * 一度だけ行っており、その結果を土台に呼び出される。ここで判定をやり直さない
 * のは、詳細ページで `/viewer` を二重に叩かないため（#143 / #144 の依存メモ）。
 *
 * 押してすぐに欄を開かず、まず「内容を編集」ボタンだけを出す（削除 #144・
 * ステータス変更 #62 と同じく、所有者向け操作を最初から広げて見せない）。開くと
 * 現在の値を入れたフォームが出て、保存すると `PATCH` で送る。
 *
 * `viewerIsOwner` を props で受けず、描画するかどうかを呼び出し側に委ねているのは
 * `DeleteIssueButton` と同じ。UI を隠すことは保護ではない。実際の権限は API 側の
 * `WHERE id = ? AND user_id = ?` が強制する。
 *
 * 写真と位置は扱わない。`PATCH` は現状 JSON で写真非対応で、位置は別の入力補助を
 * 伴うため、この Issue では本文 4 項目に絞る（Issue の対応案どおり）。
 */
export function EditIssueForm({
	issueId,
	initialTitle,
	initialDescription,
	initialScope,
	initialCategory,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	initialTitle: string;
	initialDescription: string;
	initialScope: IssueScopeType;
	/** カテゴリは未設定なら null。空欄として編集させる */
	initialCategory: string | null;
	locale?: Locale;
}) {
	const { isLoaded, getToken } = useAuth();
	const router = useRouter();
	const messages = getUiMessages(locale);
	// スコープの表示ラベルは `packages/shared` に一本化している（起票フォームと同じ）
	const scopeLabels = ISSUE_SCOPE_LABELS[locale];

	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState(initialTitle);
	const [description, setDescription] = useState(initialDescription);
	const [scope, setScope] = useState<IssueScopeType>(initialScope);
	// null（未設定）は空欄で編集させる。空欄のまま保存すると未設定へ戻す
	const [category, setCategory] = useState(initialCategory ?? "");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [updated, setUpdated] = useState(false);

	/**
	 * 編集欄を開く。開くたびに、その時点の最新の値（props）で入力欄を埋め直す。
	 *
	 * 保存に成功すると `router.refresh()` で詳細ページが取り直され、props が
	 * 新しい本文に入れ替わる。この部品は `IssueStatusSection` の key で固定され、
	 * 同じ Issue の間は再マウントされない（内部 state は初回の props のまま残る）。
	 * ここで props から入れ直すことで、2 度目に開いたときも最新から編集できる。
	 */
	const openEdit = () => {
		setTitle(initialTitle);
		setDescription(initialDescription);
		setScope(initialScope);
		setCategory(initialCategory ?? "");
		// 前回の保存結果や失敗の表示を持ち越さない
		setUpdated(false);
		setError(null);
		setEditing(true);
	};

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		// フォームの既定の送信（ページ遷移）を止める。起票フォームと同じ作法
		event.preventDefault();
		setError(null);
		setUpdated(false);

		// 送る本文を組み立てる。カテゴリは空欄なら未設定（null）へ倒す。
		// 空文字のまま送ると `UpdateIssueSchema` の `min(1)` に当たる
		const trimmedCategory = category.trim();
		const changes = {
			title: title.trim(),
			description: description.trim(),
			scope,
			category: trimmedCategory === "" ? null : trimmedCategory,
		};

		// API へ送る前にフォーム側で検証する。タイトル・説明が空だと 400 になるので、
		// 往復せずその場で理由を出す（起票フォームが `validateIssueForm` で
		// 送信前に止めるのと同じ考え方）
		const parsed = UpdateIssueSchema.safeParse(changes);
		if (!parsed.success) {
			setError(messages.issueDetail.editInvalid);
			return;
		}

		setIsSubmitting(true);
		try {
			await updateIssue(issueId, parsed.data, await getToken());
			// 保存できたら欄を閉じて、詳細ページを取り直す。表示中の本文
			// （Server Component が持つ値）を新しい内容へ入れ替えるため
			setEditing(false);
			setUpdated(true);
			router.refresh();
		} catch (err) {
			// `EditIssueError.message` は開発者向けなので画面には出さない。
			// 401 だけ文言を分けるのは、そこだけ利用者の次の一手が変わるため
			// （時間をおいても直らない。ログインし直す必要がある）
			setError(
				err instanceof EditIssueError && err.status === 401
					? messages.issueDetail.editSignInRequired
					: messages.issueDetail.editFailed,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section className="issue-edit" aria-labelledby="issue-edit-heading">
			<h2 id="issue-edit-heading">{messages.issueDetail.editHeading}</h2>

			{editing ? (
				/*
				  入力欄のスタイル（枠線・余白・:focus-visible）は `.issue-form` の
				  子孫にしか当たらない（globals.css の入力欄の節。素の要素セレクタは
				  Clerk のモーダルにも当たるため絞ってある）。起票フォームと同じ
				  `.issue-form` を名乗って、同じ見た目の入力欄にする
				*/
				<form className="issue-form" onSubmit={handleSubmit} noValidate>
					<p className="form-field">
						<label htmlFor="edit-title" className="field-label">
							{messages.newIssue.title}
						</label>
						<input
							id="edit-title"
							type="text"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							maxLength={200}
							disabled={isSubmitting}
						/>
					</p>

					<p className="form-field">
						<label htmlFor="edit-description" className="field-label">
							{messages.newIssue.description}
						</label>
						<textarea
							id="edit-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							rows={6}
							maxLength={5000}
							disabled={isSubmitting}
						/>
					</p>

					<p className="form-field">
						<label htmlFor="edit-scope" className="field-label">
							{messages.newIssue.scope}
						</label>
						<select
							id="edit-scope"
							value={scope}
							onChange={(event) =>
								setScope(event.target.value as IssueScopeType)
							}
							disabled={isSubmitting}
						>
							{IssueScope.options.map((option) => (
								<option key={option} value={option}>
									{scopeLabels[option].label}
								</option>
							))}
						</select>
					</p>

					<p className="form-field">
						<label htmlFor="edit-category" className="field-label">
							{messages.newIssue.category}
						</label>
						{/*
						  起票フォームと同じく自由入力＋候補（`datalist`）。候補は
						  `ISSUE_CATEGORY_SUGGESTIONS` から引き、表記ゆれを抑える。
						  id は起票フォームの `category-suggestions` と分ける
						  （同一ページに両方が出ることは無いが、素性を分けておく）
						*/}
						<input
							id="edit-category"
							type="text"
							value={category}
							onChange={(event) => setCategory(event.target.value)}
							maxLength={100}
							list="edit-category-suggestions"
							disabled={isSubmitting}
						/>
						<datalist id="edit-category-suggestions">
							{ISSUE_CATEGORY_SUGGESTIONS.map((suggestion) => (
								<option key={suggestion} value={suggestion} />
							))}
						</datalist>
					</p>

					<p className="issue-edit-actions">
						<button
							type="submit"
							className="button-primary"
							disabled={isSubmitting || !isLoaded}
							// 押した直後に何が起きているかを読み上げにも伝える（#95）
							aria-busy={isSubmitting}
						>
							{isSubmitting
								? messages.issueDetail.editSaving
								: messages.issueDetail.editSave}
						</button>
						<button
							type="button"
							className="button-secondary"
							onClick={() => setEditing(false)}
							disabled={isSubmitting}
						>
							{messages.issueDetail.editCancel}
						</button>
					</p>

					{error && <output className="notice text-danger">{error}</output>}
				</form>
			) : (
				<p className="issue-edit-actions">
					<button type="button" className="button-secondary" onClick={openEdit}>
						{messages.issueDetail.edit}
					</button>
					{/* 直前の保存が成功したことを、欄を閉じた後も一度伝える */}
					{updated && (
						<output className="notice text-success">
							{messages.issueDetail.editUpdated}
						</output>
					)}
				</p>
			)}
		</section>
	);
}
