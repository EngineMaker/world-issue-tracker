"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import { IssueScope } from "@world-issue-tracker/shared";
import { useState } from "react";
import {
	CreateIssueError,
	createIssue,
	type FieldErrors,
	type IssueFormValues,
	validateIssueForm,
} from "@/lib/api";

/** スコープの選択肢。ラベルは `IssueScope` の値に対応させる。 */
const SCOPE_LABELS: Record<IssueScope, string> = {
	personal: "個人",
	community: "近隣・コミュニティ",
	municipality: "自治体",
	national: "国",
	global: "世界",
};

const INITIAL_VALUES: IssueFormValues = {
	title: "",
	description: "",
	scope: "personal",
	latitude: "",
	longitude: "",
	category: "",
};

export default function NewIssuePage() {
	const { isLoaded, isSignedIn, getToken } = useAuth();

	const [values, setValues] = useState<IssueFormValues>(INITIAL_VALUES);
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [createdId, setCreatedId] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const update = (field: keyof IssueFormValues) => (value: string) => {
		setValues((current) => ({ ...current, [field]: value }));
	};

	/**
	 * 端末の位置情報を緯度経度の欄に入れる。
	 *
	 * 地図 UI は未導入なので、手入力の負担を減らす補助として置いている。
	 * 失敗しても手入力できるため、エラーは送信エラーとは別に扱わず
	 * フォーム全体のエラー表示に流す。
	 */
	const fillCurrentPosition = () => {
		if (!navigator.geolocation) {
			setSubmitError("この環境では位置情報を取得できません。");
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(position) => {
				setValues((current) => ({
					...current,
					latitude: String(position.coords.latitude),
					longitude: String(position.coords.longitude),
				}));
			},
			() => {
				setSubmitError(
					"位置情報を取得できませんでした。緯度経度を直接入力してください。",
				);
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
			setSubmitError(result.formErrors[0] ?? "入力内容を確認してください。");
			return;
		}
		setFieldErrors({});

		setIsSubmitting(true);
		try {
			const created = await createIssue(result.data, await getToken());
			// 詳細画面 (`/issues/[id]`) はまだ無いので、遷移せずにこの画面で
			// 完了を伝える。作った Issue の ID を出しておけば、
			// API から直接引くことはできる。
			setCreatedId(created.id);
			setValues(INITIAL_VALUES);
		} catch (error) {
			setSubmitError(
				error instanceof CreateIssueError
					? error.message
					: "予期しないエラーが発生しました。時間をおいて再度お試しください。",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<main style={{ padding: "1rem", maxWidth: "40rem" }}>
			<h1>Issue を起票する</h1>
			<p>気づいた「地球のバグ」を登録します。</p>

			{/*
			  未ログインでもフォームは見せる。何を書く場所なのか分からないまま
			  ログインを求められるより、書ける内容が分かってから促す方が親切なため。
			  実際の送信は下のボタンでサインインへ誘導する。
			*/}
			{isLoaded && !isSignedIn && (
				<output style={{ display: "block", color: "#b45309" }}>
					投稿にはサインインが必要です。
					<SignInButton mode="modal">
						<button type="button">サインイン</button>
					</SignInButton>
				</output>
			)}

			<form onSubmit={handleSubmit} noValidate>
				<FormField id="title" label="タイトル" errors={fieldErrors.title}>
					<input
						id="title"
						type="text"
						value={values.title}
						onChange={(event) => update("title")(event.target.value)}
						maxLength={200}
					/>
				</FormField>

				<FormField
					id="description"
					label="説明"
					errors={fieldErrors.description}
				>
					<textarea
						id="description"
						value={values.description}
						onChange={(event) => update("description")(event.target.value)}
						rows={6}
						maxLength={5000}
					/>
				</FormField>

				<FormField id="scope" label="スコープ" errors={fieldErrors.scope}>
					<select
						id="scope"
						value={values.scope}
						onChange={(event) => update("scope")(event.target.value)}
					>
						{IssueScope.options.map((scope) => (
							<option key={scope} value={scope}>
								{SCOPE_LABELS[scope]}
							</option>
						))}
					</select>
				</FormField>

				<FormField
					id="category"
					label="カテゴリ（任意）"
					errors={fieldErrors.category}
				>
					<input
						id="category"
						type="text"
						value={values.category}
						onChange={(event) => update("category")(event.target.value)}
						maxLength={100}
					/>
				</FormField>

				<FormField id="latitude" label="緯度" errors={fieldErrors.latitude}>
					<input
						id="latitude"
						type="number"
						step="any"
						value={values.latitude}
						onChange={(event) => update("latitude")(event.target.value)}
					/>
				</FormField>

				<FormField id="longitude" label="経度" errors={fieldErrors.longitude}>
					<input
						id="longitude"
						type="number"
						step="any"
						value={values.longitude}
						onChange={(event) => update("longitude")(event.target.value)}
					/>
				</FormField>

				<p>
					<button type="button" onClick={fillCurrentPosition}>
						現在地から入力
					</button>
				</p>

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
								<button type="button">サインイン</button>
							</SignInButton>
						)}
					</output>
				)}

				{createdId && (
					<output style={{ display: "block", color: "#15803d" }}>
						起票しました（ID: {createdId}）
					</output>
				)}

				<button type="submit" disabled={isSubmitting}>
					{isSubmitting ? "送信中…" : "起票する"}
				</button>
			</form>
		</main>
	);
}

/**
 * ラベル・入力欄・そのフィールドのエラー表示をまとめる。
 *
 * `id` は呼び出し側が入力欄にも同じ値を渡す前提で、`htmlFor` と対応させる。
 */
function FormField({
	id,
	label,
	errors,
	children,
}: {
	id: string;
	label: string;
	errors?: string[];
	children: React.ReactNode;
}) {
	return (
		<p>
			<label htmlFor={id} style={{ display: "block" }}>
				{label}
			</label>
			{children}
			{errors && errors.length > 0 && (
				<output style={{ display: "block", color: "#b91c1c" }}>
					{errors.join(" / ")}
				</output>
			)}
		</p>
	);
}
