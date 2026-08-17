import {
	DEFAULT_LOCALE,
	getIssueAnonymityLabel,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import type { FetchIssuesResult, PublicIssue } from "../../lib/issues";
import { EmptyState } from "./EmptyState";
import { StatusPill } from "./StatusPill";

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
			{/*
			  タイトルと説明は利用者が投稿した文章なので、そのまま出す。
			  投稿本文の翻訳は Issue #66（LLM 翻訳）の担当
			*/}
			<p className="issue-card-description">{issue.description}</p>
			{/*
			  補助情報（Issue #95）。以前は「/」で繋いだ 1 行だったが、
			  狭い画面では区切り文字の位置で折り返して読めなくなっていた。
			  項目ごとの要素にして CSS（.issue-meta）が並べる形にすると、
			  日本語と英語で語の長さが変わっても項目の単位で折り返す。

			  ステータスだけはピル（StatusPill）で出す。一覧を眺めたときに
			  どこまで進んでいるかが読み取れることが #94 の狙い
			*/}
			<p className="issue-meta">
				<StatusPill status={issue.status} locale={locale} />
				<span className="issue-meta-item">{scopes[issue.scope].label}</span>
				{issue.category ? (
					<span className="issue-meta-item">{issue.category}</span>
				) : null}
				<time className="issue-meta-item" dateTime={issue.created_at}>
					{formatCreatedAt(issue.created_at)}
				</time>
				{/*
				  起票者が名乗っているかどうか（#88）。実際の表示名はまだ出せない
				  （#67 で取得する）が、匿名かどうかの区別だけは一覧の時点で分かる
				  ようにしておく。何も出さないと「全員匿名」と「全員名乗っている」の
				  どちらの世界なのかが画面から読み取れない
				*/}
				{" / "}
				<span>{getIssueAnonymityLabel(issue.is_anonymous, locale)}</span>
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
			<div className="error-block">
				<p className="block-message">{messages.issueList.fetchFailed}</p>
				{/*
				  API が返したエラーの文言は翻訳していない（Issue #82 の範囲外）。
				  上の一文で何が起きたかは伝わるので、詳細は原文のまま出す
				*/}
				<p className="block-detail">{result.error}</p>
			</div>
		);
	}

	if (result.issues.length === 0) {
		/*
		 * 0 件（#95）。以前は本文と同じ 1 行だけで、取得に失敗したのか
		 * 本当に無いのかが見分けにくかった。面を持たせたうえで、
		 * 空のときにこそ次の一歩（起票する）を出す
		 */
		return (
			<EmptyState
				message={messages.issueList.empty}
				action={
					<Link href="/issues/new">{messages.issueList.emptyAction}</Link>
				}
			/>
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
					? messages.issueList.rangeSummary(result.total, from, to)
					: messages.issueList.countSummary(result.total, result.issues.length)}
			</p>
			<ul className="issue-cards">
				{result.issues.map((issue) => (
					<IssueCard key={issue.id} issue={issue} locale={locale} />
				))}
			</ul>
		</>
	);
}
