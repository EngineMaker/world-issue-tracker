"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	type Locale,
	roundIssueCoordinate,
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
import { createThumbnailFile, resizeImageFile } from "@/lib/photo";

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
	// 既定は「名前を出さない」＝匿名（#88）。
	// 困りごとの投稿は生活圏を晒す側面があるため、安全側を既定にする。
	// ここを true に変えると、名乗るつもりのなかった人が既定のまま
	// 名乗ってしまう。一度表示したものは後から取り消せない。
	showName: false,
};

/** 現在地の取得状態。押しても何も起きないように見える時間を作らないため */
type GeolocationState = "idle" | "loading" | "failed";

/**
 * 座標を入力欄に入れられる文字列へ直す（#124）。
 *
 * 丸めてから入れるので、欄に出る値・送る値・保存される値が揃う。
 * 座標にならない値（NaN）は空欄に倒す。`String(null)` の `"null"` が
 * 欄に残ると、消すまで送信できない状態になる。
 */
function coordinateFieldValue(value: number): string {
	const rounded = roundIssueCoordinate(value);
	return rounded === null ? "" : String(rounded);
}

/**
 * 選ばれた写真の状態（#65）。
 *
 * 縮小はブラウザ側で行うため、選んでから送れる状態になるまでに間がある。
 * 「選んだのに何も起きない」時間を作らないよう、処理中も状態として持つ。
 */
type PhotoState =
	| { status: "empty" }
	| { status: "processing" }
	/**
	 * `thumbnail` は一覧のカード用に作る小さい派生物（#125）。
	 * 作れなかったときは null になるが、送信は止めない
	 * （API 側が原寸に倒して配信する）。
	 */
	| {
			status: "ready";
			file: File;
			thumbnail: File | null;
			previewUrl: string;
	  }
	| { status: "failed"; message: string };

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
	const [photo, setPhoto] = useState<PhotoState>({ status: "empty" });

	// 文字列の入力欄用。チェックボックス（`showName`）は値が真偽値なので
	// `updateShowName` を使う。1 つの関数で両方を受けると、
	// フィールド名と値の型の対応が緩くなって取り違えに気づけない。
	const update =
		(field: Exclude<keyof IssueFormValues, "showName">) => (value: string) => {
			setValues((current) => ({ ...current, [field]: value }));
		};

	const updateShowName = (checked: boolean) => {
		setValues((current) => ({ ...current, showName: checked }));
	};

	// 選択中のスコープが何を指すかを、選ぶその場に出す。
	// `values.scope` は select の値なので通常は enum に収まるが、
	// 収まらなかったときに説明のせいで画面全体が落ちては本末転倒なので、
	// 既定のスコープにフォールバックする（送信時は検証で弾かれる）
	const parsedScope = IssueScope.safeParse(values.scope);
	const selectedScope =
		scopeLabels[parsedScope.success ? parsedScope.data : "personal"];

	/**
	 * 緯度経度の欄を空にする（#124）。
	 *
	 * 位置は任意なので空欄のままでも起票できるが、「現在地から入力」を
	 * 押した後で気が変わった人には、値を消す手立てが要る。手で 2 つの欄を
	 * 選択して消させると、片方だけ消して 400 になる経路が生まれる。
	 *
	 * 取得の状態も `idle` へ戻す。失敗の表示が残ったままだと、
	 * 位置を出さないと決めた後も警告が出ているように見える。
	 */
	const clearLocation = () => {
		setValues((current) => ({ ...current, latitude: "", longitude: "" }));
		setGeolocation("idle");
	};

	/**
	 * 端末の位置情報を緯度経度の欄に入れる。
	 *
	 * 地図 UI は未導入なので、手入力の負担を減らす補助として置いている。
	 * 失敗しても手入力できるため、送信を妨げるエラーとしては扱わず、
	 * ボタンの近くに状態として出す。送信エラーの表示を上書きすると、
	 * 直前の失敗理由が読めなくなるため場所を分けている。
	 *
	 * **欄に入れる前に丸める（#124）。** ブラウザが返す座標は小数点以下が
	 * 十数桁あり、そのまま欄へ入れると生の値がネットワークにもリクエストの
	 * ログにも乗る。保存されるのはどのみち 3 桁なので、ここで落としても
	 * 失われる情報は無い。欄に出る値・送る値・保存される値が揃うので、
	 * 「入力したのと違う場所が出ている」という食い違いも起きない。
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
					// `roundIssueCoordinate` は座標にならない値（NaN など）に
					// null を返す。`String(null)` は `"null"` になり、欄に
					// その 4 文字が残るので、空欄（＝位置なし）に倒す
					latitude: coordinateFieldValue(position.coords.latitude),
					longitude: coordinateFieldValue(position.coords.longitude),
				}));
				setGeolocation("idle");
			},
			() => {
				setGeolocation("failed");
			},
		);
	};

	/**
	 * 選ばれた写真を縮小して、送れる状態にする（#65）。
	 *
	 * 縮小してから送るのは負荷対策ではなく、利用者の失敗を防ぐため。
	 * スマホの写真は 1 枚 3〜8MB あり、そのままだと 5MB の上限に
	 * 引っかかる。詳細は `lib/photo.ts`。
	 *
	 * プレビュー用の URL は、差し替え時と選択解除時に必ず解放する。
	 * 解放しないと、選び直すたびに前の画像がメモリに残る。
	 */
	const handlePhotoChange = async (file: File | null) => {
		// 直前のプレビューを解放してから次に進む
		setPhoto((current) => {
			if (current.status === "ready") {
				URL.revokeObjectURL(current.previewUrl);
			}
			return file ? { status: "processing" } : { status: "empty" };
		});

		if (!file) {
			return;
		}

		const result = await resizeImageFile(file);
		if (!result.ok) {
			setPhoto({
				status: "failed",
				message:
					result.reason === "too-large"
						? messages.newIssue.photoTooLarge
						: messages.newIssue.photoUnreadable,
			});
			return;
		}

		/*
		 * 一覧用のサムネイル（#125）。縮小済みのファイルから作る。
		 * 失敗しても null になるだけで、投稿は止めない。
		 *
		 * 行コメントで書くと、Issue 番号が 3 桁以上のときに
		 * `#rgb` の直書きと見分けが付かず design-tokens.test.tsx が落ちる
		 * （あちらはブロックコメントだけを剥がす）
		 */
		const thumbnail = await createThumbnailFile(result.file);

		setPhoto({
			status: "ready",
			file: result.file,
			thumbnail,
			previewUrl: URL.createObjectURL(result.file),
		});
	};

	/** 選択した写真を取り消す。プレビューの URL も解放する。 */
	const clearPhoto = () => {
		setPhoto((current) => {
			if (current.status === "ready") {
				URL.revokeObjectURL(current.previewUrl);
			}
			return { status: "empty" };
		});
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

		// 写真の処理が終わる前に送ると、写真の付いていない Issue が
		// 黙って作られる。処理中は送信を止めて理由を出す
		if (photo.status === "processing") {
			setSubmitError(messages.newIssue.photoNotReady);
			return;
		}

		setIsSubmitting(true);
		try {
			const created = await createIssue(
				result.data,
				await getToken(),
				photo.status === "ready" ? photo.file : null,
				photo.status === "ready" ? photo.thumbnail : null,
			);
			// 自動では遷移させず、この画面で完了を伝えてリンクを出すに留める。
			// 続けてもう 1 件書く人がこの画面に残れることと、
			// 「送ったのに画面が変わらない」と思わせないことの両立を取った。
			// 行き先は詳細画面 (`/issues/[id]`、#58) と自分の Issue 一覧
			// (`/my-issues`、#68) の 2 つで、`IssueCreated` が出し分ける。
			setCreatedId(created.id);
			setValues(INITIAL_VALUES);
			// 続けてもう 1 件書く人のために、写真も外しておく。
			// 残したままだと、次の Issue に前の写真が付く
			clearPhoto();
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
		<main className="narrow-page">
			<h1>{messages.newIssue.heading}</h1>
			<p>{messages.newIssue.lead}</p>

			{/*
			  未ログインでもフォームは見せる。何を書く場所なのか分からないまま
			  ログインを求められるより、書ける内容が分かってから促す方が親切なため。
			  実際の送信は下のボタンでサインインへ誘導する。
			*/}
			{isLoaded && !isSignedIn && (
				<output className="notice text-warning">
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

				{/*
				  写真（#65）。必須にはしない — その場で撮れないこともあるため。
				  写真が無いときは詳細ページが地図（#63）を代わりに出す。

				  `capture` は付けていない。付けるとスマホでカメラが直接開き、
				  「後から撮った写真を選ぶ」経路が塞がれる。困りごとを
				  その場で起票できるとは限らないので、選択肢を残す
				*/}
				<FormField
					id="photo"
					label={messages.newIssue.photo}
					hint={messages.newIssue.photoHint}
					errors={photo.status === "failed" ? [photo.message] : undefined}
				>
					{/*
					  `accept` はワイルドカード（image のスラッシュ＋アスタリスク）
					  ではなく、受け付ける形式を並べて書く。理由は 2 つ:

					  - API が保存を許すのは JPEG / PNG / WebP の 3 つだけ
					    （`ISSUE_PHOTO_CONTENT_TYPES`）。ワイルドカードだと HEIC や
					    SVG も選べてしまい、選んだ後で弾かれる
					  - ワイルドカードの綴りはブロックコメントの開始と同じ並びで、
					    JSX のソースを文字列として読むテスト
					    （`apps/api/test/node/web-issue-form-guidance.test.ts`）が
					    そこをコメントの始まりと解釈し、以降の本文を丸ごと
					    読み落とす。緯度経度の入力例が消えて 8 件落ちた

					  なお `accept` は選択ダイアログの初期絞り込みでしかなく、
					  利用者は「すべてのファイル」を選べる。実際の検査は
					  縮小処理（`lib/photo.ts`）とサーバー側が行う
					*/}
					<input
						id="photo"
						type="file"
						accept="image/jpeg,image/png,image/webp"
						onChange={(event) => {
							void handlePhotoChange(event.target.files?.[0] ?? null);
						}}
						aria-describedby="photo-hint"
					/>
					{photo.status === "processing" && (
						<output className="notice">
							{messages.newIssue.photoProcessing}
						</output>
					)}
					{photo.status === "ready" && (
						<span className="notice">
							{/* biome-ignore lint/performance/noImgElement: プレビュー対象は blob: URL で、next/image では扱えない（配信元が無く最適化のしようがない）。理由は IssueMap の同種のコメントと同じ */}
							<img
								className="photo-preview"
								src={photo.previewUrl}
								alt={messages.newIssue.photoPreviewAlt}
							/>
							<button
								type="button"
								className="button-secondary"
								onClick={clearPhoto}
							>
								{messages.newIssue.photoRemove}
							</button>
						</span>
					)}
				</FormField>

				{/*
				  場所（#124 で任意になった）。

				  必須だった頃は、位置を出したくない人に「起票しない」以外の
				  選択肢が無かった。空欄のまま送れば位置なしの Issue として
				  作られる（`validateIssueForm` が空文字を undefined に倒す）。
				  入力した場合も、保存・公開されるのは約 100m へ丸めた値になる。
				*/}
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
						{/*
						  入力した位置を取り消す（#124）。何も入っていないときは
						  押しても意味が無いので出さない。先頭の空白は 2 つの
						  ボタンが地の文で繋がって見えないようにするためで、
						  ボタンごと消えるときは空白も一緒に消す
						*/}
						{(values.latitude !== "" || values.longitude !== "") && (
							<>
								{" "}
								<button
									type="button"
									className="button-secondary"
									onClick={clearLocation}
								>
									{messages.newIssue.clearLocation}
								</button>
							</>
						)}
					</p>

					{geolocation === "failed" && (
						<output className="notice text-warning">
							{messages.newIssue.geolocationFailed}
						</output>
					)}
				</fieldset>

				{/*
				  名乗るかどうか（#88）。既定は未チェック＝匿名。

				  `FormField` を使わずに書いているのは、あちらが
				  「ラベル → 補助テキスト → 入力欄」の縦並びを前提にしていて、
				  チェックボックスの「四角 → ラベル」という横並びに合わないため。
				  補助テキストの id と `aria-describedby` の対応はここでも同じ形にする。

				  未ログインでも操作できるようにしている。送信時に
				  サインインへ誘導する作りなので、ここだけ先に無効化すると
				  「書けたのに選べない」という食い違いになる。
				*/}
				<p className="form-field">
					<label htmlFor="show-name">
						<input
							id="show-name"
							type="checkbox"
							checked={values.showName}
							onChange={(event) => updateShowName(event.target.checked)}
							aria-describedby="show-name-hint"
						/>{" "}
						{messages.newIssue.showName}
					</label>
					<span className="field-hint" id="show-name-hint">
						{messages.newIssue.showNameHint}
					</span>
				</p>

				{submitError && (
					<output className="notice text-danger">
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
					// 押した直後に何が起きているかを読み上げにも伝える（#95）
					aria-busy={isSubmitting}
				>
					{isSubmitting ? messages.common.submitting : messages.newIssue.submit}
				</button>
			</form>

			{/* 書くのをやめたときに行き止まりにしない */}
			<p className="page-nav">
				<Link href="/issues">{messages.newIssue.viewIssues}</Link>
				<Link href="/my-issues">{messages.newIssue.myIssues}</Link>
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
