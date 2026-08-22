"use client";

import { useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_STATUS_LABELS,
	type IssueScope as IssueScopeType,
	IssueStatus,
	type IssueStatus as IssueStatusType,
	type Locale,
} from "@world-issue-tracker/shared";
import { useEffect, useRef, useState } from "react";
import {
	fetchViewerRelation,
	IssueStatusError,
	updateIssueStatus,
} from "../../lib/issue-status";
import { DeleteIssueButton } from "./DeleteIssueButton";
import { EditIssueForm } from "./EditIssueForm";
import { StatusPill } from "./StatusPill";

/**
 * 起票者向けの操作欄。起票者かどうかを自分で確かめてから、ステータス変更
 * （`StatusControl`）と Issue 自体の削除（`DeleteIssueButton`、#144）を出す。
 *
 * 詳細ページ（Server Component）は Clerk のトークンを API へ渡していないため、
 * サーバー側の描画では「誰として見ているか」が分からない。`HelpOfferButton` が
 * `viewer_offered` をブラウザ側で取り直しているのと同じ事情で、判定はここで行う。
 *
 * 起票者判定（`GET /issues/:id/viewer`）はここ 1 箇所に集約する。ステータス変更・
 * 削除・本文編集（#143）で別々に `/viewer` を叩くと、詳細ページで判定が重複する
 * （#143 / #144 の依存メモ）。所有者向け操作はこの判定を土台に共有する。
 *
 * 判定が付くまでは現在のステータスだけを出す。まだ分からない段階で操作 UI を
 * 出すと、起票者以外の画面に一瞬だけ出て消えることになり、押せたように見えて
 * 403 になる（実際には API が弾くので変更はされないが、混乱させる）。
 *
 * 判定に失敗したときも操作 UI は出さない。「取得に失敗した」を
 * 「あなたが起票者だ」に倒すと、変えられない人にボタンを見せることになる。
 * 起票者本人から見ると操作できないので、その旨を出して再読み込みを促す。
 */
export function IssueStatusSection({
	issueId,
	status,
	title,
	description,
	scope,
	category,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	status: IssueStatusType;
	/** 本文編集（#143）の初期値。起票者に編集フォームを出すために受け取る */
	title: string;
	description: string;
	scope: IssueScopeType;
	category: string | null;
	locale?: Locale;
}) {
	const { isLoaded, isSignedIn, getToken } = useAuth();
	const [relation, setRelation] = useState<
		| { state: "loading" }
		| { state: "ready"; isOwner: boolean }
		| { state: "failed" }
	>({ state: "loading" });

	// `getToken` は effect の依存に入れず、ref 経由で最新のものを読む。
	//
	// Clerk が返す `getToken` の参照が描画ごとに変わる場合、依存に入れると
	// 「取得 → setState → 再描画 → 新しい参照 → 取得」が止まらなくなる
	// （API を叩き続ける）。参照の安定性はライブラリの実装詳細で、
	// バージョンで変わりうるため、そこに依存しない形にしておく。
	//
	// 取得したいのは「今この Issue の起票者か」だけで、`getToken` が
	// 差し替わったこと自体は取り直す理由にならない。
	const getTokenRef = useRef(getToken);
	getTokenRef.current = getToken;

	useEffect(() => {
		// Clerk の読み込みが終わるまではトークンを取れない
		if (!isLoaded) return;

		// 未ログインなら答えは false で確定している。API を叩かない
		if (!isSignedIn) {
			setRelation({ state: "ready", isOwner: false });
			return;
		}

		// 取得中に別の Issue へ遷移したら、古い応答で上書きしない
		let cancelled = false;

		(async () => {
			const result = await fetchViewerRelation(issueId, {
				token: await getTokenRef.current(),
			});
			if (cancelled) return;
			setRelation(
				result.ok
					? { state: "ready", isOwner: result.viewerIsOwner }
					: { state: "failed" },
			);
		})();

		return () => {
			cancelled = true;
		};
	}, [issueId, isLoaded, isSignedIn]);

	if (relation.state === "failed") {
		return <StatusUnavailable status={status} locale={locale} />;
	}

	// 判定が付いていて、かつ起票者のときだけ操作 UI を出す。
	// `loading` を owner 扱いに倒すと、起票者以外の画面にもボタンが一瞬出て消える
	const isOwner = relation.state === "ready" && relation.isOwner;

	return (
		<>
			{/*
			  起票者にだけ、本文（タイトル・説明・スコープ・カテゴリ）の編集を出す
			  （#143）。ステータス変更より前に置くのは、本文の訂正が「状態を進める」
			  より基本的な操作で、Issue を読んだ直後に直したくなる流れになるため。
			  判定は上で 1 度だけ済ませており、編集側で `/viewer` を叩き直さない
			*/}
			{isOwner && (
				<EditIssueForm
					issueId={issueId}
					initialTitle={title}
					initialDescription={description}
					initialScope={scope}
					initialCategory={category}
					locale={locale}
				/>
			)}
			<StatusControl
				issueId={issueId}
				initialStatus={status}
				viewerIsOwner={isOwner}
				locale={locale}
			/>
			{/*
			  起票者にだけ、Issue 自体の削除を出す（#144）。ステータス変更が
			  「状態を進める」操作なのに対し、これは投稿そのものの取り下げなので、
			  ステータス欄とは別の section に分ける。判定は上で 1 度だけ済ませており、
			  削除側で `/viewer` を叩き直さない
			*/}
			{isOwner && <DeleteIssueButton issueId={issueId} locale={locale} />}
		</>
	);
}

/**
 * 起票者かどうかを確かめられなかったときの表示。
 *
 * 操作 UI は出さない。「取得に失敗した」を「あなたが起票者だ」に倒すと、
 * 変えられない人にボタンを見せることになる。起票者本人にとっては
 * 操作できない状態なので、黙って隠さず理由を出して再読み込みを促す。
 *
 * `IssueStatusSection` から切り出しているのは、この分岐が
 * `useEffect` の結果でしか到達できず、そのままでは描画して確かめられないため。
 */
export function StatusUnavailable({
	status,
	locale = DEFAULT_LOCALE,
}: {
	status: IssueStatusType;
	locale?: Locale;
}) {
	const messages = getUiMessages(locale);

	return (
		<section className="status-control" aria-labelledby="issue-status-heading">
			<h2 id="issue-status-heading">{messages.statusControl.heading}</h2>
			{/* 変えられなくても現在の状態は読める。一覧・詳細と同じピルで出す（#95） */}
			<p className="status-control-current">
				<StatusPill status={status} locale={locale} />
			</p>
			<p className="text-warning">{messages.statusControl.unavailable}</p>
		</section>
	);
}

/**
 * ステータスの表示と、起票者による変更（Issue #62）。
 *
 * `Open → Triaged → In Progress → Review → Resolved → Closed` の 6 状態は
 * トップページで説明され、DB の CHECK 制約にも定義され、`PATCH /issues/:id` も
 * あったが、画面から変える手段が無かった。すべての Issue が永久に `open` に
 * 留まり、「解決した」を記録できない状態だったのをここで繋ぐ。
 *
 * 変更できるのは起票者だけ（Issue #62 のコメントで決めた方針）。
 * 「手伝います」を表明した人には広げていない。他人の困りごとを勝手に
 * 「解決済み」にできると、起票者から見て状態が信用できなくなるため。
 *
 * `viewerIsOwner` は表示の出し分けにだけ使う。**UI を隠すことは保護ではない。**
 * 実際の権限は API 側の `WHERE id = ? AND user_id = ?` が強制していて、
 * この値を偽っても他人の Issue は変えられない。
 *
 * 未ログインの場合は起票者以外と同じ扱いで、現在のステータスだけを表示する。
 * 「手伝います」（`HelpOfferButton`）はサインインを促すが、こちらは促さない。
 * サインインしても、自分が起票した Issue でなければ結局変えられないため、
 * 誘導した先に何も無い。
 */
export function StatusControl({
	issueId,
	initialStatus,
	viewerIsOwner,
	locale = DEFAULT_LOCALE,
}: {
	issueId: string;
	initialStatus: IssueStatusType;
	viewerIsOwner: boolean;
	locale?: Locale;
}) {
	const { isLoaded, getToken } = useAuth();
	const messages = getUiMessages(locale);
	const statusLabels = ISSUE_STATUS_LABELS[locale];

	const [status, setStatus] = useState(initialStatus);
	const [selected, setSelected] = useState(initialStatus);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [updated, setUpdated] = useState(false);

	// 起票者以外には操作 UI を出さない。現在の状態は読めるようにしておく
	// （何が起きているかは、変えられない人にとっても Issue の情報の一部）
	if (!viewerIsOwner) {
		return (
			<section
				className="status-control"
				aria-labelledby="issue-status-heading"
			>
				<h2 id="issue-status-heading">{messages.statusControl.heading}</h2>
				<p className="status-control-current">
					<StatusPill status={status} locale={locale} />
				</p>
			</section>
		);
	}

	const handleSubmit = async () => {
		setError(null);
		setUpdated(false);
		setIsSubmitting(true);

		try {
			const issue = await updateIssueStatus(
				issueId,
				selected,
				await getToken(),
			);
			// 送った値ではなく API が返した値を採る。何らかの理由で
			// 別の値になっていたときに、画面だけが正しいふりをしないため
			setStatus(issue.status);
			setSelected(issue.status);
			setUpdated(true);
		} catch (err) {
			setError(
				err instanceof IssueStatusError
					? err.message
					: messages.common.unexpectedError,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		/*
		 * `status-control` は入力欄のスタイルを届かせるためのスコープでもある
		 * （#95）。ここは `.issue-form` の外にあり、select に枠線も
		 * `:focus-visible` のアウトラインも当たっていなかった。
		 * キーボードで辿るとフォーカス位置が見えない状態だった
		 */
		<section className="status-control" aria-labelledby="issue-status-heading">
			<h2 id="issue-status-heading">{messages.statusControl.heading}</h2>

			<p className="status-control-current">
				{messages.statusControl.current}{" "}
				{/* 一覧・詳細と同じピルで出して、同じ Issue が同じ見た目で続くようにする */}
				<StatusPill status={status} locale={locale} />
			</p>

			<p className="status-control-form">
				<label htmlFor="issue-status-select" className="field-label">
					{messages.statusControl.changeTo}
				</label>
				<select
					id="issue-status-select"
					value={selected}
					onChange={(e) => setSelected(e.target.value as IssueStatusType)}
					disabled={isSubmitting || !isLoaded}
				>
					{/*
					  6 状態すべてを候補に出す。順序を飛ばす遷移
					  （`open → closed` など）も API が許しているため制限しない。
					  順序の強制は別の判断を含むので、この Issue の範囲外
					  （#62 のコメントで整理済み）
					*/}
					{IssueStatus.options.map((option) => (
						<option key={option} value={option}>
							{statusLabels[option]}
						</option>
					))}
				</select>
				<button
					type="button"
					className="button-primary"
					onClick={handleSubmit}
					// 同じ値への更新は `updated_at` だけが動く無意味な往復になる
					disabled={isSubmitting || !isLoaded || selected === status}
					// 押した直後に何が起きているかを読み上げにも伝える（#95）
					aria-busy={isSubmitting}
				>
					{isSubmitting
						? messages.statusControl.submitting
						: messages.statusControl.submit}
				</button>
			</p>

			{updated && (
				<output className="notice text-success">
					{messages.statusControl.updated(statusLabels[status])}
				</output>
			)}

			{error && <output className="notice text-danger">{error}</output>}
		</section>
	);
}
