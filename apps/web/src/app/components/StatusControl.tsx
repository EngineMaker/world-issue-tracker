"use client";

import { useAuth } from "@clerk/nextjs";
import {
	DEFAULT_LOCALE,
	ISSUE_STATUS_LABELS,
	IssueStatus,
	type IssueStatus as IssueStatusType,
} from "@world-issue-tracker/shared";
import { useEffect, useRef, useState } from "react";
import {
	fetchViewerRelation,
	IssueStatusError,
	updateIssueStatus,
} from "../../lib/issue-status";

const STATUS_LABELS = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

/**
 * ステータス欄。起票者かどうかを自分で確かめてから `StatusControl` を出す。
 *
 * 詳細ページ（Server Component）は Clerk のトークンを API へ渡していないため、
 * サーバー側の描画では「誰として見ているか」が分からない。`HelpOfferButton` が
 * `viewer_offered` をブラウザ側で取り直しているのと同じ事情で、判定はここで行う。
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
}: {
	issueId: string;
	status: IssueStatusType;
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
		return <StatusUnavailable status={status} />;
	}

	return (
		<StatusControl
			issueId={issueId}
			initialStatus={status}
			// 判定が付いていて、かつ起票者のときだけ操作 UI を出す。
			// `loading` を owner 扱いに倒すと、起票者以外の画面にも
			// ボタンが一瞬出て消える
			viewerIsOwner={relation.state === "ready" && relation.isOwner}
		/>
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
export function StatusUnavailable({ status }: { status: IssueStatusType }) {
	return (
		<section aria-labelledby="issue-status-heading">
			<h2 id="issue-status-heading">ステータス</h2>
			<p>{STATUS_LABELS[status]}</p>
			<p className="text-warning">
				ステータスを変更できるかどうかを確認できませんでした。 この Issue
				を起票した方は、ページを再読み込みしてください。
			</p>
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
}: {
	issueId: string;
	initialStatus: IssueStatusType;
	viewerIsOwner: boolean;
}) {
	const { isLoaded, getToken } = useAuth();

	const [status, setStatus] = useState(initialStatus);
	const [selected, setSelected] = useState(initialStatus);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [updated, setUpdated] = useState(false);

	// 起票者以外には操作 UI を出さない。現在の状態は読めるようにしておく
	// （何が起きているかは、変えられない人にとっても Issue の情報の一部）
	if (!viewerIsOwner) {
		return (
			<section aria-labelledby="issue-status-heading">
				<h2 id="issue-status-heading">ステータス</h2>
				<p>{STATUS_LABELS[status]}</p>
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
					: "予期しないエラーが発生しました。時間をおいて再度お試しください。",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section aria-labelledby="issue-status-heading">
			<h2 id="issue-status-heading">ステータス</h2>

			<p>
				現在: <strong>{STATUS_LABELS[status]}</strong>
			</p>

			<p>
				<label htmlFor="issue-status-select">変更先</label>{" "}
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
							{STATUS_LABELS[option]}
						</option>
					))}
				</select>{" "}
				<button
					type="button"
					className="button-primary"
					onClick={handleSubmit}
					// 同じ値への更新は `updated_at` だけが動く無意味な往復になる
					disabled={isSubmitting || !isLoaded || selected === status}
				>
					{isSubmitting ? "更新中…" : "ステータスを更新"}
				</button>
			</p>

			{updated && (
				<output className="notice text-success">
					ステータスを「{STATUS_LABELS[status]}」に更新しました。
				</output>
			)}

			{error && <output className="notice text-danger">{error}</output>}
		</section>
	);
}
