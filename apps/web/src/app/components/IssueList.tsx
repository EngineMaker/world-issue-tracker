import {
	DEFAULT_LOCALE,
	getAuthorLabel,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import {
	formatCreatedAt,
	toDateTimeTooltip,
	toIsoDateTime,
} from "../../lib/datetime";
import {
	type FetchIssuesResult,
	issuePhotoThumbnailUrl,
	type PublicIssue,
} from "../../lib/issues";
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
 * 日時の整形は `lib/datetime` に移した（A5）。
 *
 * 元はこのファイルに置いていたが、詳細ページ・コメント欄からも
 * 名前で参照されていて、一覧の部品がその置き場になっていた。
 * ここから再輸出しているのは、既存の import を壊さないため。
 */
export { formatCreatedAt } from "../../lib/datetime";

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
	const messages = getUiMessages(locale);

	return (
		<li className="issue-card">
			{/*
			  写真（#125）。本番の利用者から「画像がまったくないので殺風景に
			  見える」という感想が届いたのがきっかけ。写真の機能自体は #65 で
			  入っていて、8 件中 4 件が写真を持っていたのに、**一覧に出して
			  いなかった**。最初に見る画面が文字だけになっていた。

			  タイトルより前に置く。「扇風機が汚い」「草が伸びている」の
			  ような困りごとは、文章より写真の方が状況が早く伝わる。

			  読むのは原寸ではなくサムネイル（`issuePhotoThumbnailUrl`）。
			  一覧は 20 件並ぶので、詳細ページと同じ画像を指すと表示 1 回で
			  数 MB になる。

			  `loading="lazy"` は、20 件のうち画面に入っていない分を先に
			  読みに行かせないため。サムネイルにしてもなお、一覧の初回表示で
			  20 枚を取りに行く必要は無い。

			  `alt` は空にする。詳細ページ（.issue-photo）は「◯◯ の様子」と
			  名乗るが、あちらは写真が主役の画面で、周りに同じ情報を持つ
			  文字が無い。一覧では真下の見出しが同じタイトルを持っており、
			  代替テキストもそのタイトルから機械的に作った文字列でしかない。
			  そのまま出すと読み上げが「◯◯ の様子（画像）」「◯◯（リンク）」と
			  1 件につき 2 回タイトルを読むことになり、20 件並ぶ画面では
			  読み進める邪魔にしかならない。隣接するテキストが同じ内容を
			  伝えているときは空にするのが定石（レビューで指摘）
			*/}
			{issue.has_photo ? (
				// biome-ignore lint/performance/noImgElement: 配信元（API Worker）は環境変数で差し替わるため next/image の remotePatterns に列挙できない（理由は詳細ページと同じ）。寸法を属性で固定しないのは写真の縦横比が投稿ごとに違うため — 表示枠は CSS が持ち、はみ出す分は object-fit で切る
				<img
					className="issue-card-photo"
					src={issuePhotoThumbnailUrl(issue.id)}
					alt=""
					loading="lazy"
					decoding="async"
				/>
			) : null}
			{/*
			  写真の隣に積む本文。写真の有無で左の列が消えるだけになるよう、
			  文章側はひとまとまりにしておく（`li` の直下に並べたままだと
			  写真と横並びにしたとき h3・説明・補助情報が別々の列に散る）
			*/}
			<div className="issue-card-body">
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
					{/*
				  スコープもピルで出す（B4）。以前は素のテキストで、同じ
				  「その Issue がどこに属するか」を示す情報なのに、ステータスだけが
				  ピルでスコープは地の文という不揃いな並びだった
				*/}
					<span className="scope-pill">{scopes[issue.scope].label}</span>
					{/*
				  カテゴリは `#` を付けてタグとして見せる（B4）。ピルにしないのは、
				  ステータスとスコープが「決められた選択肢のどれか」なのに対して、
				  カテゴリは自由入力だから。同じ形にすると区別が付かなくなる
				*/}
					{issue.category ? (
						<span className="issue-tag">#{issue.category}</span>
					) : null}
					{/*
				  読む人向けの文字列は相対表記（A5）。機械可読な値は
				  `dateTime` に ISO 8601 で残し、人が読める正確な日時は
				  `title` に入れる（相対表記だけだと何月何日か確かめられない）
				*/}
					<time
						className="issue-meta-item"
						dateTime={toIsoDateTime(issue.created_at)}
						title={toDateTimeTooltip(issue.created_at, locale)}
					>
						{formatCreatedAt(issue.created_at, locale)}
					</time>
					{/*
				  起票者（#88 / #67）。匿名を選んだ人は「匿名の方」、名乗って
				  いる人は Clerk の表示名。名前が引けなかった人には匿名とは
				  別の文言が出る（出し分けは `getAuthorLabel` に寄せてあり、
				  一覧・詳細・コメントで同じ規則になる）。

				  誰が困っているのか分からない相手を「手伝います」と支援するのは
				  難しい。とはいえ実名表示が常に正しいわけでもないので、
				  匿名を選んだ人の名前はここに出ない
				*/}
					{" / "}
					<span>
						{getAuthorLabel(
							{
								isAnonymous: issue.is_anonymous,
								displayName: issue.display_name,
							},
							locale,
						)}
					</span>
					{/*
				  「私も困っている」の件数（#112）。0 件のときは出さない。
				  時系列に並んだだけの一覧に「どれが多くの人に効いているか」という
				  重みを付けるのが狙いで、0 は重みを持たないうえ、全件に「0」が
				  並ぶと数のある行が埋もれる。

				  誰が押したかは出さない（API がそもそも返さない）。ここに出るのは
				  数だけで、一覧から個人が読み取れることはない
				*/}
					{issue.reaction_count > 0 ? (
						<span className="issue-meta-item">
							{messages.reaction.cardCount(issue.reaction_count)}
						</span>
					) : null}
				</p>
			</div>
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
