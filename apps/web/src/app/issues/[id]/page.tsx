import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchIssue } from "../../../lib/issues";
import { formatCreatedAt } from "../../components/IssueList";

const SCOPE_LABELS = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
const STATUS_LABELS = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

/**
 * Issue 詳細ページ。
 *
 * 1 件の Issue に固有の URL を与える画面。ここが無いと Issue を
 * 第三者に見せる手段が無く、コメントや「手伝います」を置く場所も無い。
 *
 * 一覧と同じく Server Component として取得する（理由は app/page.tsx）。
 */
export default async function IssueDetailPage({
	params,
}: {
	// Next.js 15 では `params` が Promise になったため await して受け取る
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const result = await fetchIssue(id);

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

			{/* 読み終えたときに行き止まりにしない */}
			<p>
				<Link href="/issues">Issue 一覧へ戻る</Link>
				{" / "}
				<Link href="/issues/new">Issue を書く</Link>
			</p>
		</main>
	);
}
