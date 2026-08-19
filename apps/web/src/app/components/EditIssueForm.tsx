"use client";

import { useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	type Locale,
} from "@world-issue-tracker/shared";
import { useState } from "react";
import {
	ISSUE_CATEGORY_SUGGESTIONS,
	type IssueEditFieldErrors,
	type IssueEditFormValues,
	validateIssueEdit,
} from "@/lib/api";
import { IssueEditError, updateIssueContent } from "@/lib/issue-edit";

/**
 * 起票者が本文（タイトル・説明・スコープ・カテゴリ）を後から直すフォーム（#143）。
 *
 * API（`PATCH /issues/:id`）は所有者限定の部分更新に対応していたが、Web からは
 * ステータスしか送っておらず、内容を直す導線がどの画面にも無かった。この
 * コンポーネントがその 4 項目を編集して送る導線になる。
 *
 * `viewerIsOwner` は表示の出し分けにだけ使う。**UI を隠すことは保護ではない。**
 * 実際の権限は API 側の `WHERE id = ? AND user_id = ?` が強制していて、この値を
 * 偽っても他人の Issue は変えられない（`StatusControl` と同じ整理）。
 *
 * 起票者かどうかの判定は `IssueStatusSection` が `GET /issues/:id/viewer` で
 * 一度だけ行い、その結果を props で受け取る。編集と削除・ステータスで別々に
 * 判定を作らないための共有点（Issue #143 / #144 の「依存・土台の共有」）。
 */
export function EditIssueForm({
	issueId,
	viewerIsOwner,
	initial,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	viewerIsOwner: boolean;
	initial: IssueEditFormValues;
	locale?: Locale;
}) {
	const { isLoaded, getToken } = useAuth();
	const messages = getUiMessages(locale);
	const scopeLabels = ISSUE_SCOPE_LABELS[locale];

	// フォームを開いているか。既定は閉じておき、起票者が「内容を編集する」を
	// 押したときだけ開く。常に開いていると、本文をもう一度読みたいだけの
	// 起票者に編集欄が被さって読みづらい
	const [isEditing, setIsEditing] = useState(false);
	const [values, setValues] = useState<IssueEditFormValues>(initial);
	const [fieldErrors, setFieldErrors] = useState<IssueEditFieldErrors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [updated, setUpdated] = useState(false);

	// 起票者以外には編集 UI を出さない。本文そのものは詳細ページが既に
	// 表示しているので、ここで現在値を重ねて出す必要は無い（ステータスとは違い、
	// 「変えられない人にも見せる現在値」を別に持たない）
	if (!viewerIsOwner) {
		return null;
	}

	const update =
		(field: keyof IssueEditFormValues) =>
		(event: { target: { value: string } }) => {
			setValues((current) => ({ ...current, [field]: event.target.value }));
		};

	// 選択中のスコープが何を指すかを、選ぶその場に出す（起票フォームと同じ）。
	// enum に収まらない値でも説明のせいで画面が落ちないよう、既定へフォールバック
	const parsedScope = IssueScope.safeParse(values.scope);
	const selectedScope =
		scopeLabels[parsedScope.success ? parsedScope.data : "personal"];

	const openForm = () => {
		// 開くたびに現在値へ戻す。前回キャンセルした編集途中の値を持ち越すと、
		// 「直したはずなのに戻っている」と取り違える
		setValues(initial);
		setFieldErrors({});
		setSubmitError(null);
		setUpdated(false);
		setIsEditing(true);
	};

	const cancel = () => {
		setIsEditing(false);
		setFieldErrors({});
		setSubmitError(null);
	};

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSubmitError(null);
		setUpdated(false);

		const result = validateIssueEdit(values);
		if (!result.success) {
			setFieldErrors(result.fieldErrors);
			setSubmitError(
				result.formErrors[0] ?? messages.issueEdit.validationFailed,
			);
			return;
		}
		setFieldErrors({});

		setIsSubmitting(true);
		try {
			const issue = await updateIssueContent(
				issueId,
				result.data,
				await getToken(),
			);
			// 送った値ではなく API が返した値を採る。何らかの理由で別の値に
			// なっていたときに、画面だけが正しいふりをしないため
			// （`StatusControl` と同じ）。カテゴリ未設定は null で返るので空文字へ
			setValues({
				title: issue.title,
				description: issue.description,
				scope: issue.scope,
				category: issue.category ?? "",
			});
			setUpdated(true);
			// フォームは閉じる。ページ上部の見出しなどは Server Component が
			// 描いた静的表示なので即時には変わらない。閉じたうえで通知に
			// 「再読み込みで全体に反映」と添える
			setIsEditing(false);
		} catch (err) {
			setSubmitError(
				err instanceof IssueEditError
					? err.message
					: messages.common.unexpectedError,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	if (!isEditing) {
		return (
			<section aria-labelledby="issue-edit-heading">
				<h2 id="issue-edit-heading">{messages.issueEdit.heading}</h2>
				<p className="field-hint">{messages.issueEdit.lead}</p>
				{updated && (
					<output className="notice text-success">
						{messages.issueEdit.updated}
					</output>
				)}
				<button type="button" className="button-secondary" onClick={openForm}>
					{messages.issueEdit.edit}
				</button>
			</section>
		);
	}

	return (
		<section aria-labelledby="issue-edit-heading">
			<h2 id="issue-edit-heading">{messages.issueEdit.heading}</h2>

			{/* 入力欄のラベル・補助テキストは起票フォームと同じ語彙を使う（#143）。
			    別々の文言にすると、同じ項目が起票時と編集時で違う説明になる */}
			<form className="issue-form" onSubmit={handleSubmit} noValidate>
				<EditField
					id="edit-title"
					label={messages.newIssue.title}
					hint={messages.newIssue.titleHint}
					errors={fieldErrors.title}
				>
					<input
						id="edit-title"
						type="text"
						value={values.title}
						onChange={update("title")}
						maxLength={200}
						aria-describedby="edit-title-hint"
					/>
				</EditField>

				<EditField
					id="edit-description"
					label={messages.newIssue.description}
					hint={messages.newIssue.descriptionHint}
					errors={fieldErrors.description}
				>
					<textarea
						id="edit-description"
						value={values.description}
						onChange={update("description")}
						rows={6}
						maxLength={5000}
						aria-describedby="edit-description-hint"
					/>
				</EditField>

				<EditField
					id="edit-scope"
					label={messages.newIssue.scope}
					hint={messages.newIssue.scopeHint(
						selectedScope.label,
						selectedScope.description,
					)}
					errors={fieldErrors.scope}
				>
					<select
						id="edit-scope"
						value={values.scope}
						onChange={update("scope")}
						aria-describedby="edit-scope-hint"
					>
						{IssueScope.options.map((scope) => (
							<option key={scope} value={scope}>
								{scopeLabels[scope].label}
							</option>
						))}
					</select>
				</EditField>

				<EditField
					id="edit-category"
					label={messages.newIssue.category}
					hint={messages.newIssue.categoryHint}
					errors={fieldErrors.category}
				>
					{/* 起票フォームと同じく、自由入力を残したまま候補を出す
					    （`<datalist>`）。空にして保存するとカテゴリを外せる */}
					<input
						id="edit-category"
						type="text"
						value={values.category}
						onChange={update("category")}
						maxLength={100}
						list="edit-category-suggestions"
						aria-describedby="edit-category-hint"
					/>
					<datalist id="edit-category-suggestions">
						{ISSUE_CATEGORY_SUGGESTIONS.map((suggestion) => (
							<option key={suggestion} value={suggestion} />
						))}
					</datalist>
				</EditField>

				{submitError && (
					<output className="notice text-danger">{submitError}</output>
				)}

				<p className="issue-edit-actions">
					<button
						type="submit"
						className="button-primary"
						disabled={isSubmitting || !isLoaded}
						// 押した直後に何が起きているかを読み上げにも伝える（#95）
						aria-busy={isSubmitting}
					>
						{isSubmitting
							? messages.issueEdit.submitting
							: messages.issueEdit.submit}
					</button>
					<button
						type="button"
						className="button-secondary"
						onClick={cancel}
						disabled={isSubmitting}
					>
						{messages.issueEdit.cancel}
					</button>
				</p>
			</form>
		</section>
	);
}

/**
 * ラベル・補助テキスト・入力欄・そのフィールドのエラー表示をまとめる。
 *
 * 起票フォーム（`NewIssueForm` の `FormField`）と同じ構造。あちらは同ファイル内の
 * 非公開関数で、`aria-describedby` の対応（`${id}-hint`）を含めて共有したいが、
 * export されていないため、ここでは同じ形を最小限で持つ。
 */
function EditField({
	id,
	label,
	hint,
	errors,
	children,
}: {
	id: string;
	label: string;
	hint: string;
	errors?: string[];
	children: React.ReactNode;
}) {
	return (
		<p className="form-field">
			<label htmlFor={id} className="field-label">
				{label}
			</label>
			<span className="field-hint" id={`${id}-hint`}>
				{hint}
			</span>
			{children}
			{errors && errors.length > 0 && (
				<output className="notice text-danger">{errors.join(" / ")}</output>
			)}
		</p>
	);
}
