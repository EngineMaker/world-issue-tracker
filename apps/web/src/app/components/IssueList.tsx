import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
} from "@world-issue-tracker/shared";
import type { FetchIssuesResult, PublicIssue } from "../../lib/issues";

/**
 * 画面に出すスコープ・ステータスのラベル。
 *
 * `municipality` / `open` のような enum の生の値はユーザー向けの語彙ではない。
 * 対応表はここに写さず `packages/shared` から引く（`page.tsx` と同じ経路）。
 * 写すと二重管理になって片方だけ古くなるうえ、
 * 同じ概念が同一画面の中で違う表記になる（Issue #59）。
 *
 * export しているのはテストのため。ラベルを写した実装でも描画結果は同じになるため、
 * 描画からは二重管理を見分けられない。shared の辞書と同一かをテストが直接見る。
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
 */
export function formatCreatedAt(createdAt: string): string {
	const date = new Date(`${createdAt.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime())) {
		// 想定外の書式でも「Invalid Date」を出さない
		return createdAt;
	}
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function IssueCard({ issue }: { issue: PublicIssue }) {
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
			<h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem" }}>{issue.title}</h3>
			<p style={{ margin: "0 0 0.5rem", color: "#444" }}>{issue.description}</p>
			<p style={{ margin: 0, fontSize: "0.85rem", color: "#666" }}>
				<span>{scopeLabels[issue.scope].label}</span>
				{" / "}
				<span>{statusLabels[issue.status]}</span>
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
