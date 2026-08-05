import {
	DEFAULT_LOCALE,
	getIssueScopeLabel,
	getIssueStatusLabel,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchHelpOffers } from "../../../lib/help-offers";
import { fetchIssue } from "../../../lib/issues";
import { HelpOfferButton } from "../../components/HelpOfferButton";
import { formatCreatedAt } from "../../components/IssueList";

/**
 * Issue 詳細ページ。
 *
 * 「手伝います」ボタン（#61）を置く器として、必要最小限の表示を用意している。
 * 詳細ページそのものの本来の要件は #58 にあり、そちらで一覧からの導線や
 * 起票後の遷移まで含めて整えられる想定。ここはボタンが載る場所を作るのが目的で、
 * #58 が入ったら統合される。
 *
 * 一覧・トップと同じく Server Component として取得する（理由は app/page.tsx）。
 */
export default async function IssueDetailPage({
	params,
}: {
	// Next.js 15 では `params` が Promise になっている
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const result = await fetchIssue(id);

	if (!result.ok && result.notFound) {
		// 存在しない Issue は Next.js の 404 に載せる。
		// 「取得できませんでした」の画面を出すと、リンク切れなのか障害なのかが
		// 読み手にも検索エンジンにも区別できない
		notFound();
	}

	if (!result.ok) {
		return (
			<main>
				<h1>Issue を取得できませんでした</h1>
				<p style={{ color: "#b00" }}>{result.error}</p>
				<p>
					<Link href="/issues">Issue 一覧へ戻る</Link>
				</p>
			</main>
		);
	}

	const { issue } = result;
	const scope = getIssueScopeLabel(issue.scope, DEFAULT_LOCALE);
	const status = getIssueStatusLabel(issue.status, DEFAULT_LOCALE);

	// 表明の初期値をサーバー側で取っておく。
	//
	// トークンを渡していないので `viewer_offered` は常に false になる
	// （Clerk のセッションは Cookie で、別オリジンの API には届かない）。
	// 「自分が表明済みか」はブラウザ側で `HelpOfferButton` が取り直す。
	// 件数と表明者だけは JS の実行前から読めるようにするため、ここで取る。
	const offers = await fetchHelpOffers(issue.id);

	return (
		<main>
			<h1>{issue.title}</h1>

			<dl>
				<dt>ステータス</dt>
				<dd>{status}</dd>

				<dt>スコープ</dt>
				<dd>
					{scope.label} — {scope.description}
				</dd>

				{issue.category && (
					<>
						<dt>カテゴリ</dt>
						<dd>{issue.category}</dd>
					</>
				)}

				<dt>起票日時</dt>
				<dd>
					<time dateTime={issue.created_at}>
						{formatCreatedAt(issue.created_at)}
					</time>
				</dd>

				<dt>場所</dt>
				<dd>
					緯度 {issue.latitude} / 経度 {issue.longitude}
				</dd>
			</dl>

			<section>
				<h2>説明</h2>
				{/* 改行を保つ。API は本文をそのまま保存しているため、
				    段落分けが潰れると起票者が書いた形と変わってしまう */}
				<p style={{ whiteSpace: "pre-wrap" }}>{issue.description}</p>
			</section>

			<HelpOfferButton
				issueId={issue.id}
				initialSummary={offers.ok ? offers.summary : null}
			/>

			<p>
				<Link href="/issues">Issue 一覧へ戻る</Link>
				{" / "}
				<Link href="/">トップへ戻る</Link>
			</p>
		</main>
	);
}
