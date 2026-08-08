import {
	DEFAULT_LOCALE,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import type { FetchIssuesResult, PublicIssue } from "../../lib/issues";

/**
 * 画面に出すスコープ・ステータスのラベル。
 *
 * `municipality` / `open` のような enum の生の値はユーザー向けの語彙ではない。
 * 対応表はここに写さず `packages/shared` から引く（`page.tsx` と同じ経路）。
 * 写すと二重管理になって片方だけ古くなるうえ、同じ概念が同一画面の中で
 * 違う表記になる（Issue #59）。一覧が生の enum 値、詳細ページが日本語ラベルだと、
 * リンクで繋がった 2 画面で同じ Issue が別物に見える。
 *
 * export しているのはテストのため。ラベルを写した実装でも描画結果は同じになるため、
 * 描画からは二重管理を見分けられない。shared の辞書と同一かをテストが直接見る。
 *
 * ロケール別に引けるようにしたのは Issue #82。既定ロケールの分は
 * これまでの名前のまま残してある（既存のテストと呼び出し側が参照している）。
 */
export const scopeLabels = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
export const statusLabels = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

/**
 * API が返す `created_at` を表示用の文字列にする。
 *
 * 値は SQLite の `strftime('%Y-%m-%d %H:%M:%f', 'now')`（UTC、`apps/api/src/routes/issues.ts`）
 * で、タイムゾーン指定が付いていない。そのまま `new Date()` に渡すと処理系によって
 * ローカル時刻と解釈され 9 時間ずれるため、`T` と `Z` を補って明示的に UTC として読む。
 *
 * 表示は UTC 固定にしている。サーバーとブラウザでタイムゾーンが違うと
 * ハイドレーション時に文言が食い違うため、Server Component 側で決め切る。
 *
 * 日付の書式のロケール対応は Issue #82 の範囲外（別途判断）。
 */
export function formatCreatedAt(createdAt: string): string {
	const date = new Date(`${createdAt.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime())) {
		// 想定外の書式でも「Invalid Date」を出さない
		return createdAt;
	}
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Issue 1 件のカード。
 *
 * 公開一覧と自分の一覧（`MyIssueList`）で同じ見た目を使う。
 * 一覧ごとに書き分けると、表示項目を足したときに片方だけ取り残される。
 */
export function IssueCard({
	issue,
	locale = DEFAULT_LOCALE,
}: {
	issue: PublicIssue;
	locale?: Locale;
}) {
	const scopes = ISSUE_SCOPE_LABELS[locale];
	const statuses = ISSUE_STATUS_LABELS[locale];

	return (
		<li
			style={{
				border: "1px solid #eee",
				borderRadius: "6px",
				padding: "0.75rem 1rem",
				marginBottom: "0.75rem",
				listStyle: "none",
			}}
		>
			{/*
			  タイトルを詳細ページ (`/issues/[id]`) への入口にする。
			  コメント欄はその画面にあるため、ここに導線が無いと
			  一覧から議論に辿り着けない。

			  カード全体ではなくタイトルをリンクにする。カード全体を <a> で
			  包むと、読み上げ時に説明文まで一続きのリンク名として読まれる
			*/}
			<h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem" }}>
				<Link href={`/issues/${issue.id}`}>{issue.title}</Link>
			</h3>
			{/*
			  タイトルと説明は利用者が投稿した文章なので、そのまま出す。
			  投稿本文の翻訳は Issue #66（LLM 翻訳）の担当
			*/}
			<p style={{ margin: "0 0 0.5rem", color: "#444" }}>{issue.description}</p>
			<p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
				<span>{scopes[issue.scope].label}</span>
				{" / "}
				<span>{statuses[issue.status]}</span>
				{issue.category ? (
					<>
						{" / "}
						<span>{issue.category}</span>
					</>
				) : null}
				{" / "}
				<time dateTime={issue.created_at}>
					{formatCreatedAt(issue.created_at)}
				</time>
			</p>
		</li>
	);
}

/**
 * Issue 一覧を描画する。
 *
 * 取得結果を props で受け取り、成功・0 件・失敗の 3 状態をすべて描き分ける。
 * 取得そのものは呼び出し側（`page.tsx`）が行う。
 */
export function IssueList({
	result,
	locale = DEFAULT_LOCALE,
}: {
	result: FetchIssuesResult;
	locale?: Locale;
}) {
	const messages = getUiMessages(locale);

	if (!result.ok) {
		return (
			<div style={{ color: "#b00", padding: "0.5rem 0" }}>
				<p style={{ margin: "0 0 0.25rem" }}>
					{messages.issueList.fetchFailed}
				</p>
				{/*
				  API が返したエラーの文言は翻訳していない（Issue #82 の範囲外）。
				  上の一文で何が起きたかは伝わるので、詳細は原文のまま出す
				*/}
				<p style={{ margin: 0, fontSize: "0.85rem" }}>{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		return <p style={{ color: "#666" }}>{messages.issueList.empty}</p>;
	}

	// 複数ページに分かれているときは「N 件中 M 件」だけではどこを見ているのか
	// 分からないため、範囲（何件目から何件目か）を出す。
	//
	// 判定は `offset > 0` ではなく `total > limit` にしている。前者だと
	// 1 ページ目だけ様式が変わり、ページを送った瞬間に表記が切り替わって見える。
	// ページが 1 つしか無いときは範囲を出しても情報が増えないので、件数だけにする。
	const isPaged = result.total > result.limit;
	const from = result.offset + 1;
	const to = result.offset + result.issues.length;

	return (
		<>
			<p style={{ color: "#666", fontSize: "0.85rem" }}>
				{isPaged
					? messages.issueList.rangeSummary(result.total, from, to)
					: messages.issueList.countSummary(result.total, result.issues.length)}
			</p>
			<ul style={{ padding: 0, margin: 0 }}>
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} locale={locale} />
				))}
			</ul>
		</>
	);
}
