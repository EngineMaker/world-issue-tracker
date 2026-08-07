import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import type { FetchIssuesResult, PublicIssue } from "../../lib/issues";

// 表示ラベルは packages/shared に一本化している。
// 一覧が生の enum 値（`community` / `open`）、詳細ページが日本語ラベルだと、
// リンクで繋がった 2 画面で同じ Issue が別物に見える
const SCOPE_LABELS = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
const STATUS_LABELS = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

/**
 * API が返す `created_at` を表示用の文字列にする。
 *
 * 値は SQLite の `strftime('%Y-%m-%d %H:%M:%f', 'now')`（UTC、`apps/api/src/routes/issues.ts`）
 * で、タイムゾーン指定が付いていない。そのまま `new Date()` に渡すと処理系によって
 * ローカル時刻と解釈され 9 時間ずれるため、`T` と `Z` を補って明示的に UTC として読む。
 *
 * 表示は UTC 固定にしている。サーバーとブラウザでタイムゾーンが違うと
 * ハイドレーション時に文言が食い違うため、Server Component 側で決め切る。
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
export function IssueCard({ issue }: { issue: PublicIssue }) {
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
			  カード全体ではなくタイトルをリンクにする。カード全体を <a> で
			  包むと、読み上げ時に説明文まで一続きのリンク名として読まれる
			*/}
			<h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem" }}>
				<Link href={`/issues/${issue.id}`}>{issue.title}</Link>
			</h3>
			<p style={{ margin: "0 0 0.5rem", color: "#444" }}>{issue.description}</p>
			<p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
				<span>{SCOPE_LABELS[issue.scope].label}</span>
				{" / "}
				<span>{STATUS_LABELS[issue.status]}</span>
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
export function IssueList({ result }: { result: FetchIssuesResult }) {
	if (!result.ok) {
		return (
			<div style={{ color: "#b00", padding: "0.5rem 0" }}>
				<p style={{ margin: "0 0 0.25rem" }}>
					Issue を取得できませんでした。時間をおいて再度お試しください。
				</p>
				<p style={{ margin: 0, fontSize: "0.85rem" }}>{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		return (
			<p style={{ color: "#666" }}>
				まだ Issue がありません。最初の 1 件を起票してみてください。
			</p>
		);
	}

	return (
		<>
			<p style={{ color: "#666", fontSize: "0.85rem" }}>
				{result.total} 件中 {result.issues.length} 件を表示
			</p>
			<ul style={{ padding: 0, margin: 0 }}>
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} />
				))}
			</ul>
		</>
	);
}
