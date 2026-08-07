import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchHelpOffers } from "../../../lib/help-offers";
import { fetchComments, fetchIssue } from "../../../lib/issues";
import { CommentSection } from "../../components/CommentSection";
import { HelpOfferButton } from "../../components/HelpOfferButton";
import { formatCreatedAt } from "../../components/IssueList";
import { IssueStatusSection } from "../../components/StatusControl";

const SCOPE_LABELS = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
const STATUS_LABELS = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

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
 */
export default async function IssueDetailPage({
	params,
}: {
	// Next.js 15 では `params` が Promise になったため await して受け取る
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
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
				<h1>Issue を表示できませんでした</h1>
				<div style={{ color: "#b00", padding: "0.5rem 0" }}>
					<p style={{ margin: "0 0 0.25rem" }}>
						時間をおいて再度お試しください。
					</p>
					<p style={{ margin: 0, fontSize: "0.85rem" }}>{result.error}</p>
				</div>
				<p>
					<Link href="/issues">Issue 一覧へ戻る</Link>
				</p>
			</main>
		);
	}

	const { issue } = result;
	const scope = SCOPE_LABELS[issue.scope];

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

			<section>
				<h2>説明</h2>
				{/*
				  投稿は textarea への入力なので改行が意味を持つ。
				  既定の `white-space` だと改行が潰れて 1 段落に見える
				*/}
				<p style={{ whiteSpace: "pre-wrap" }}>{issue.description}</p>
			</section>

			<section>
				<h2>詳細</h2>
				<dl>
					<dt>スコープ</dt>
					<dd>
						{scope.label} — {scope.description}
					</dd>

					{/*
					  ここは JS の実行前から読める静的な表示として残す。
					  変更の操作 UI は後段の `IssueStatusSection`（Client Component）で、
					  起票者かどうかを確かめてから出す
					*/}
					<dt>ステータス</dt>
					<dd>{STATUS_LABELS[issue.status]}</dd>

					<dt>カテゴリ</dt>
					<dd>{issue.category ?? "未設定"}</dd>

					<dt>場所</dt>
					{/*
					  地図 UI は未導入（MVP の別項目）なので、座標をそのまま出す。
					  桁を丸めると別の地点を指すため、受け取った値を加工しない
					*/}
					<dd>
						緯度 {issue.latitude} / 経度 {issue.longitude}
					</dd>

					<dt>作成日時</dt>
					<dd>
						<time dateTime={issue.created_at}>
							{formatCreatedAt(issue.created_at)}
						</time>
					</dd>

					<dt>最終更新</dt>
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
			<IssueStatusSection issueId={issue.id} status={issue.status} />

			{/*
			  「手伝います」はコメントより前に置く。読み終えた直後が一番
			  動き出しやすく、議論を読み進めた先に置くと埋もれる
			*/}
			<HelpOfferButton
				issueId={issue.id}
				initialSummary={offers.ok ? offers.summary : null}
			/>

			<CommentSection issueId={issue.id} initialResult={commentsResult} />

			{/* 読み終えたときに行き止まりにしない */}
			<p>
				<Link href="/issues">Issue 一覧へ戻る</Link>
				{" / "}
				<Link href="/issues/new">Issue を書く</Link>
			</p>
		</main>
	);
}
