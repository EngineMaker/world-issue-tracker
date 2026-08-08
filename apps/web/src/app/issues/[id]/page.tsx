import {
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchHelpOffers } from "../../../lib/help-offers";
import { fetchComments, fetchIssue } from "../../../lib/issues";
import { getLocale } from "../../../lib/locale";
import {
	resolveTileAttribution,
	resolveTileUrlTemplate,
} from "../../../lib/map";
import { CommentSection } from "../../components/CommentSection";
import { HelpOfferButton } from "../../components/HelpOfferButton";
import { formatCreatedAt } from "../../components/IssueList";
import { IssueMap } from "../../components/IssueMap";
import { IssueStatusSection } from "../../components/StatusControl";

/**
 * Issue 詳細ページ。
 *
 * 1 件の Issue に固有の URL を与える画面。ここが無いと Issue を
 * 第三者に見せる手段が無く、コメントや「手伝います」を置く場所も無い。
 * その場所として、コメント欄（#60）と「手伝います」（#61）を置いている。
 *
 * 一覧と同じく Server Component として取得する（理由は app/page.tsx）。
 * Issue 本体・コメント・表明の 3 つは互いに独立なので並行に投げる。
 *
 * 表明にトークンを渡していないので `viewer_offered` は常に false になる
 * （Clerk のセッションは Cookie で、別オリジンの API には届かない）。
 * 「自分が表明済みか」はブラウザ側で `HelpOfferButton` が取り直す。
 * 件数と表明者だけは JS の実行前から読めるようにするため、ここで取る。
 *
 * 配下の Client Component にはロケールを props で渡す（Issue #82）。
 * Cookie は `next/headers` の `cookies()` からしか読めず、それは
 * Server Component 側の API なので、境界を跨ぐときは値として渡す。
 */
export default async function IssueDetailPage({
	params,
}: {
	// Next.js 15 では `params` が Promise になったため await して受け取る
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const locale = await getLocale();
	const messages = getUiMessages(locale);
	const scopeLabels = ISSUE_SCOPE_LABELS[locale];
	const statusLabels = ISSUE_STATUS_LABELS[locale];

	const [result, commentsResult, offers] = await Promise.all([
		fetchIssue(id),
		fetchComments(id),
		fetchHelpOffers(id),
	]);

	// 存在しない ID は 404。取得に失敗しただけのときは 404 にしない
	// （実在する Issue に「存在しません」と表示してしまうため）
	if (!result.ok && result.notFound) {
		notFound();
	}

	if (!result.ok) {
		return (
			<main>
				<h1>{messages.issueDetail.unavailableHeading}</h1>
				<div style={{ color: "#b00", padding: "0.5rem 0" }}>
					<p style={{ margin: "0 0 0.25rem" }}>
						{messages.issueDetail.retryLater}
					</p>
					<p style={{ margin: 0, fontSize: "0.85rem" }}>{result.error}</p>
				</div>
				<p>
					<Link href="/issues">{messages.issueDetail.backToList}</Link>
				</p>
			</main>
		);
	}

	const { issue } = result;
	const scope = scopeLabels[issue.scope];

	return (
		<main>
			<h1>{issue.title}</h1>

			{/*
			  スコープとステータスは enum の生値（`community` / `open`）のままだと
			  読み手に伝わらない。ラベルは packages/shared に一本化している
			*/}
			<p style={{ color: "#666", fontSize: "0.9rem" }}>
				<span>{scope.label}</span>
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

			<section>
				<h2>{messages.issueDetail.descriptionHeading}</h2>
				{/*
				  投稿は textarea への入力なので改行が意味を持つ。
				  既定の `white-space` だと改行が潰れて 1 段落に見える。
				  本文そのものは投稿された言語のまま出す（翻訳は #66）
				*/}
				<p style={{ whiteSpace: "pre-wrap" }}>{issue.description}</p>
			</section>

			<section>
				<h2>{messages.issueDetail.detailsHeading}</h2>
				<dl>
					<dt>{messages.issueDetail.scope}</dt>
					<dd>
						{scope.label} — {scope.description}
					</dd>

					{/*
					  ここは JS の実行前から読める静的な表示として残す。
					  変更の操作 UI は後段の `IssueStatusSection`（Client Component）で、
					  起票者かどうかを確かめてから出す
					*/}
					<dt>{messages.issueDetail.status}</dt>
					<dd>{statusLabels[issue.status]}</dd>

					<dt>{messages.issueDetail.category}</dt>
					<dd>{issue.category ?? messages.issueDetail.categoryUnset}</dd>

					<dt>{messages.issueDetail.location}</dt>
					{/*
					  地図を出しても座標の数値は消さない（#63）。タイル配信元が
					  落ちていたり未設定だったりすると地図は出ないが、そのときに
					  位置情報まで失われるのは避けたい。
					  桁を丸めると別の地点を指すため、受け取った値を加工しない
					*/}
					<dd>
						<IssueMap
							latitude={issue.latitude}
							longitude={issue.longitude}
							title={issue.title}
							tileUrlTemplate={resolveTileUrlTemplate()}
							attribution={resolveTileAttribution()}
							locale={locale}
						/>
						{messages.issueDetail.coordinates(issue.latitude, issue.longitude)}
					</dd>

					<dt>{messages.issueDetail.createdAt}</dt>
					<dd>
						<time dateTime={issue.created_at}>
							{formatCreatedAt(issue.created_at)}
						</time>
					</dd>

					<dt>{messages.issueDetail.updatedAt}</dt>
					<dd>
						<time dateTime={issue.updated_at}>
							{formatCreatedAt(issue.updated_at)}
						</time>
					</dd>
				</dl>
			</section>

			{/*
			  ステータスの変更（#62）。起票者だけが操作できるが、その判定には
			  Clerk のトークンが要るため、Client Component 側で確かめる
			  （このページは API へトークンを渡していない）。
			  「手伝います」より前に置いているのは、状態を進めるのが起票者本人の
			  操作で、Issue 本文を読み終えた直後に続く流れになるため
			*/}
			<IssueStatusSection
				issueId={issue.id}
				status={issue.status}
				locale={locale}
			/>

			{/*
			  「手伝います」はコメントより前に置く。読み終えた直後が一番
			  動き出しやすく、議論を読み進めた先に置くと埋もれる
			*/}
			<HelpOfferButton
				issueId={issue.id}
				initialSummary={offers.ok ? offers.summary : null}
				locale={locale}
			/>

			<CommentSection
				issueId={issue.id}
				initialResult={commentsResult}
				locale={locale}
			/>

			{/* 読み終えたときに行き止まりにしない */}
			<p>
				<Link href="/issues">{messages.issueDetail.backToList}</Link>
				{" / "}
				<Link href="/issues/new">{messages.issueDetail.writeIssue}</Link>
			</p>
		</main>
	);
}
