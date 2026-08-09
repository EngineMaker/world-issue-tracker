import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
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

/**
 * Issue 1 件のカード。
 *
 * 公開一覧と自分の一覧（`MyIssueList`）で同じ見た目を使う。
 * 一覧ごとに書き分けると、表示項目を足したときに片方だけ取り残される。
 */
export function IssueCard({ issue }: { issue: PublicIssue }) {
	return (
		<li className="issue-card">
			{/*
			  タイトルを詳細ページ (`/issues/[id]`) への入口にする。
			  コメント欄はその画面にあるため、ここに導線が無いと
			  一覧から議論に辿り着けない。

			  カード全体ではなくタイトルをリンクにする。カード全体を <a> で
			  包むと、読み上げ時に説明文まで一続きのリンク名として読まれる
			*/}
			<h3 className="issue-card-title">
				<Link href={`/issues/${issue.id}`}>{issue.title}</Link>
			</h3>
			<p className="issue-card-description">{issue.description}</p>
			<p className="issue-meta">
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
			<div className="error-block">
				<p className="block-message">
					Issue を取得できませんでした。時間をおいて再度お試しください。
				</p>
				<p className="block-detail">{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		return (
			<p className="text-soft">
				まだ Issue がありません。最初の 1 件を起票してみてください。
			</p>
		);
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
			<p className="list-summary">
				{isPaged
					? `${result.total} 件中 ${from} 〜 ${to} 件目を表示`
					: `${result.total} 件中 ${result.issues.length} 件を表示`}
			</p>
			<ul className="issue-cards">
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} />
				))}
			</ul>
		</>
	);
}
