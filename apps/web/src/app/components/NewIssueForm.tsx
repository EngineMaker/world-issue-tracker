"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { useState } from "react";
import { IssueCreated } from "@/app/components/IssueCreated";
import {
	CreateIssueError,
	createIssue,
	type FieldErrors,
	ISSUE_CATEGORY_SUGGESTIONS,
	type IssueFormValues,
	validateIssueForm,
} from "@/lib/api";

// カテゴリの候補は定数から引く（`@/lib/api`）。
// ここに直書きすると、表記ゆれを防ぐという目的そのものが崩れる
const CATEGORY_SUGGESTIONS = ISSUE_CATEGORY_SUGGESTIONS;

const INITIAL_VALUES: IssueFormValues = {
	title: "",
	description: "",
	scope: "personal",
	latitude: "",
	longitude: "",
	category: "",
};

/** 現在地の取得状態。押しても何も起きないように見える時間を作らないため */
type GeolocationState = "idle" | "loading" | "failed";

/**
 * 起票フォームの本体（Issue #82 で `issues/new/page.tsx` から切り出し）。
 *
 * Client Component なので Cookie を直接読めない（`cookies()` は
 * Server Component 側の API）。ロケールはページ（Server Component）から
 * props で受け取る。切り出したのはそのためで、フォームの中身は変えていない。
 */
export function NewIssueForm({ locale = DEFAULT_LOCALE }: { locale?: Locale }) {
	const { isLoaded, isSignedIn, getToken } = useAuth();
	const messages = getUiMessages(locale);
	// スコープの表示ラベルは `packages/shared` に一本化している。
	// ここで独自に定義すると、トップページの説明と選択肢の文言がずれる
	const scopeLabels = ISSUE_SCOPE_LABELS[locale];

	const [values, setValues] = useState<IssueFormValues>(INITIAL_VALUES);
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [createdId, setCreatedId] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [geolocation, setGeolocation] = useState<GeolocationState>("idle");

	const update = (field: keyof IssueFormValues) => (value: string) => {
		setValues((current) => ({ ...current, [field]: value }));
	};

	// 選択中のスコープが何を指すかを、選ぶその場に出す。
	// `values.scope` は select の値なので通常は enum に収まるが、
	// 収まらなかったときに説明のせいで画面全体が落ちては本末転倒なので、
	// 既定のスコープにフォールバックする（送信時は検証で弾かれる）
	const parsedScope = IssueScope.safeParse(values.scope);
	const selectedScope =
		scopeLabels[parsedScope.success ? parsedScope.data : "personal"];

	/**
	 * 端末の位置情報を緯度経度の欄に入れる。
	 *
	 * 地図 UI は未導入なので、手入力の負担を減らす補助として置いている。
	 * 失敗しても手入力できるため、送信を妨げるエラーとしては扱わず、
	 * ボタンの近くに状態として出す。送信エラーの表示を上書きすると、
	 * 直前の失敗理由が読めなくなるため場所を分けている。
	 */
	const fillCurrentPosition = () => {
		if (!navigator.geolocation) {
			setGeolocation("failed");
			return;
		}
		setGeolocation("loading");
		navigator.geolocation.getCurrentPosition(
			(position) => {
				setValues((current) => ({
					...current,
					latitude: String(position.coords.latitude),
					longitude: String(position.coords.longitude),
				}));
				setGeolocation("idle");
			},
			() => {
				setGeolocation("failed");
			},
		);
	};

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSubmitError(null);
		setCreatedId(null);

		const result = validateIssueForm(values);
		if (!result.success) {
			setFieldErrors(result.fieldErrors);
			setSubmitError(
				result.formErrors[0] ?? messages.newIssue.validationFailed,
			);
			return;
		}
		setFieldErrors({});

		setIsSubmitting(true);
		try {
			const created = await createIssue(result.data, await getToken());
			// 自動では遷移させず、この画面で完了を伝えてリンクを出すに留める。
			// 続けてもう 1 件書く人がこの画面に残れることと、
			// 「送ったのに画面が変わらない」と思わせないことの両立を取った。
			// 行き先は詳細画面 (`/issues/[id]`、#58) と自分の Issue 一覧
			// (`/my-issues`、#68) の 2 つで、`IssueCreated` が出し分ける。
			setCreatedId(created.id);
			setValues(INITIAL_VALUES);
		} catch (error) {
			setSubmitError(
				error instanceof CreateIssueError
					? error.message
					: messages.common.unexpectedError,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<main style={{ padding: "1rem", maxWidth: "40rem" }}>
			<h1>{messages.newIssue.heading}</h1>
			<p>{messages.newIssue.lead}</p>

			{/*
			  未ログインでもフォームは見せる。何を書く場所なのか分からないまま
			  ログインを求められるより、書ける内容が分かってから促す方が親切なため。
			  実際の送信は下のボタンでサインインへ誘導する。
			*/}
			{isLoaded && !isSignedIn && (
				<output style={{ display: "block", color: "#b45309" }}>
					{messages.newIssue.signInRequired}
					<SignInButton mode="modal">
						<button type="button" className="button-secondary">
							{messages.common.signIn}
						</button>
					</SignInButton>
				</output>
			)}

			<form className="issue-form" onSubmit={handleSubmit} noValidate>
				<FormField
					id="title"
					label={messages.newIssue.title}
					hint={messages.newIssue.titleHint}
					errors={fieldErrors.title}
				>
					<input
						id="title"
						type="text"
						value={values.title}
						onChange={(event) => update("title")(event.target.value)}
						maxLength={200}
						placeholder={messages.newIssue.titlePlaceholder}
						aria-describedby="title-hint"
					/>
				</FormField>

				<FormField
					id="description"
					label={messages.newIssue.description}
					hint={messages.newIssue.descriptionHint}
					errors={fieldErrors.description}
				>
					<textarea
						id="description"
						value={values.description}
						onChange={(event) => update("description")(event.target.value)}
						rows={6}
						maxLength={5000}
						placeholder={messages.newIssue.descriptionPlaceholder}
						aria-describedby="description-hint"
					/>
				</FormField>

				<FormField
					id="scope"
					label={messages.newIssue.scope}
					hint={messages.newIssue.scopeHint(
						selectedScope.label,
						selectedScope.description,
					)}
					errors={fieldErrors.scope}
				>
					<select
						id="scope"
						value={values.scope}
						onChange={(event) => update("scope")(event.target.value)}
						aria-describedby="scope-hint"
					>
						{IssueScope.options.map((scope) => (
							<option key={scope} value={scope}>
								{scopeLabels[scope].label}
							</option>
						))}
					</select>
				</FormField>

				<FormField
					id="category"
					label={messages.newIssue.category}
					hint={messages.newIssue.categoryHint}
					errors={fieldErrors.category}
				>
					{/*
					  自由入力を残したまま候補を出すため `<select>` ではなく
					  `<datalist>` を使う。候補に無い困りごとを起票できなくする
					  ことの方が、表記ゆれより損失が大きいと判断した。
					  スキーマの enum 化は、集まった値を見てから別途判断する。

					  候補そのものは翻訳していない。保存されるのはここで選んだ
					  文字列で、絞り込みは完全一致。訳した候補で起票すると、
					  日本語で起票された同種の Issue と別カテゴリになる
					*/}
					<input
						id="category"
						type="text"
						value={values.category}
						onChange={(event) => update("category")(event.target.value)}
						maxLength={100}
						list="category-suggestions"
						placeholder={messages.newIssue.categoryPlaceholder}
						aria-describedby="category-hint"
					/>
					<datalist id="category-suggestions">
						{CATEGORY_SUGGESTIONS.map((suggestion) => (
							<option key={suggestion} value={suggestion} />
						))}
					</datalist>
				</FormField>

				<fieldset className="location">
					<legend>{messages.newIssue.locationLegend}</legend>
					<p id="location-hint">{messages.newIssue.locationHint}</p>

					<div className="coordinates">
						<FormField
							id="latitude"
							label={messages.newIssue.latitude}
							hint={messages.newIssue.latitudeHint}
							errors={fieldErrors.latitude}
						>
							<input
								id="latitude"
								type="number"
								step="any"
								inputMode="decimal"
								className="field-narrow"
								value={values.latitude}
								onChange={(event) => update("latitude")(event.target.value)}
								placeholder={messages.newIssue.latitudePlaceholder}
								aria-describedby="latitude-hint location-hint"
							/>
						</FormField>

						<FormField
							id="longitude"
							label={messages.newIssue.longitude}
							hint={messages.newIssue.longitudeHint}
							errors={fieldErrors.longitude}
						>
							<input
								id="longitude"
								type="number"
								step="any"
								inputMode="decimal"
								className="field-narrow"
								value={values.longitude}
								onChange={(event) => update("longitude")(event.target.value)}
								placeholder={messages.newIssue.longitudePlaceholder}
								aria-describedby="longitude-hint location-hint"
							/>
						</FormField>
					</div>

					<p>
						<button
							type="button"
							className="button-secondary"
							onClick={fillCurrentPosition}
							disabled={geolocation === "loading"}
						>
							{geolocation === "loading"
								? messages.newIssue.locating
								: messages.newIssue.useCurrentPosition}
						</button>
					</p>

					{geolocation === "failed" && (
						<output style={{ display: "block", color: "#b45309" }}>
							{messages.newIssue.geolocationFailed}
						</output>
					)}
				</fieldset>

				{submitError && (
					<output style={{ display: "block", color: "#b91c1c" }}>
						{submitError}
						{/*
						  未ログインが原因なら、その場でサインインできるようにする。
						  フォームを埋めきってから押した利用者に、画面上部まで
						  戻らせないため。入力値は保持されるので続きから送信できる。
						*/}
						{!isSignedIn && (
							<SignInButton mode="modal">
								<button type="button" className="button-secondary">
									{messages.common.signIn}
								</button>
							</SignInButton>
						)}
					</output>
				)}

				{createdId && <IssueCreated id={createdId} locale={locale} />}

				<button
					type="submit"
					className="button-primary"
					disabled={isSubmitting}
				>
					{isSubmitting ? messages.common.submitting : messages.newIssue.submit}
				</button>
			</form>

			{/* 書くのをやめたときに行き止まりにしない */}
			<p>
				<Link href="/issues">{messages.newIssue.viewIssues}</Link>
				{" / "}
				<Link href="/my-issues">{messages.newIssue.myIssues}</Link>
				{" / "}
				<Link href="/">{messages.newIssue.backToHome}</Link>
			</p>
		</main>
	);
}

/**
 * ラベル・補助テキスト・入力欄・そのフィールドのエラー表示をまとめる。
 *
 * `id` は呼び出し側が入力欄にも同じ値を渡す前提で、`htmlFor` と対応させる。
 * 補助テキストの id は `${id}-hint` に固定し、呼び出し側は入力欄の
 * `aria-describedby` に同じ値を書く。`placeholder` は入力を始めると
 * 消えてしまうため、書いている最中に読める場所として別に置いている。
 *
 * `hint` は任意ではなく必須にしている。省略や空文字を許すと、
 * 呼び出し側に残った `aria-describedby` が存在しない id を指し、
 * 「説明がある」と支援技術に伝えながら何も読まれない状態になるため。
 * この画面に「補助テキストの要らない入力欄」は無いという判断でもある。
 */
function FormField({
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
			<label htmlFor={id} style={{ display: "block" }}>
				{label}
			</label>
			<span className="field-hint" id={`${id}-hint`}>
				{hint}
			</span>
			{children}
			{errors && errors.length > 0 && (
				<output style={{ display: "block", color: "#b91c1c" }}>
					{errors.join(" / ")}
				</output>
			)}
		</p>
	);
}
