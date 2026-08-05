import {
	DEFAULT_LOCALE,
	getIssueScopeLabel,
	getIssueStatusLabel,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchComments, fetchIssue } from "../../../lib/issues";
import { CommentSection } from "../../components/CommentSection";
import { formatCreatedAt } from "../../components/IssueList";

/**
 * Issue 詳細ページ。
 *
 * コメント機能（#60）を置く場所として必要になったため、
 * Issue 1 件の表示とコメント欄をここにまとめている。
 *
 * Issue 本体とコメントはどちらも Server Component 側で取得する
 * （一覧ページと同じ方針。サーバー間通信なので CORS を経由しない）。
 * 2 つのリクエストは互いに独立なので並行に投げる。
 */
export default async function IssueDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	const [issueResult, commentsResult] = await Promise.all([
		fetchIssue(id),
		fetchComments(id),
	]);

	// 存在しない Issue は Next.js の 404 に落とす。
	// 取得失敗（API 障害など）は 404 にせず、下でエラーとして表示する
	if (!issueResult.ok && issueResult.notFound) {
		notFound();
	}

	if (!issueResult.ok) {
		return (
			<main>
				<h1>Issue を表示できません</h1>
				<p style={{ color: "#b00" }}>
					Issue を取得できませんでした。時間をおいて再度お試しください。
				</p>
				<p style={{ color: "#b00", fontSize: "0.85rem" }}>
					{issueResult.error}
				</p>
				<p>
					<Link href="/issues">Issue 一覧へ戻る</Link>
				</p>
			</main>
		);
	}

	const { issue } = issueResult;
	const scope = getIssueScopeLabel(issue.scope, DEFAULT_LOCALE);

	return (
		<main style={{ padding: "1rem", maxWidth: "40rem" }}>
			<h1>{issue.title}</h1>

			<p style={{ color: "#666", fontSize: "0.85rem" }}>
				<span title={scope.description}>{scope.label}</span>
				{" / "}
				<span>{getIssueStatusLabel(issue.status, DEFAULT_LOCALE)}</span>
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

			{/* 改行を含む説明をそのまま読めるようにする */}
			<p style={{ whiteSpace: "pre-wrap" }}>{issue.description}</p>

			<p style={{ color: "#666", fontSize: "0.85rem" }}>
				場所: {issue.latitude}, {issue.longitude}
			</p>

			<CommentSection issueId={issue.id} initialResult={commentsResult} />

			<p>
				<Link href="/issues">Issue 一覧へ戻る</Link>
				{" / "}
				<Link href="/">トップへ戻る</Link>
			</p>
		</main>
	);
}
