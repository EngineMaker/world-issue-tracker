import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueStatus,
} from "@world-issue-tracker/shared";
import Link from "next/link";

export default function Home() {
	const scopeLabels = ISSUE_SCOPE_LABELS[DEFAULT_LOCALE];
	const statusLabels = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

	return (
		<main>
			{/* サイト名は Header が出しているので、ここはページ固有の見出しにする */}
			<h1>地球のバグを、みんなで可視化して、みんなで直す</h1>

			<section>
				<h2>これは何をするサービス？</h2>
				<p>
					身の回りの困りごとを「Issue」として投稿して、みんなで見えるようにする場所です。
					近所の壊れた街灯から、国の制度の問題まで、大きさを問わず扱います。
				</p>
				<p>
					投稿された Issue には誰でもコメントでき、
					「手伝います」と手を挙げることで解決に向けて動き出します。
					犯人を探すのではなく、直すことが目的です。
				</p>
			</section>

			<nav aria-label="主な操作">
				<h2>まずはここから</h2>
				<ul className="actions">
					<li>
						<Link href="/issues">Issue を見る</Link>
						<span> — 投稿された困りごとを一覧で読む。ログインは不要です</span>
					</li>
					<li>
						<Link href="/issues/new">Issue を書く</Link>
						<span> — 困っていることを投稿する。投稿にはログインが必要です</span>
					</li>
				</ul>
			</nav>

			<section>
				<h2>Issue の大きさ（スコープ）</h2>
				<p>
					個人の悩みも世界の課題も、地続きにつながっています。 Issue
					は次の5段階のどれかに位置づけて投稿します。
				</p>
				<ol className="scopes">
					{IssueScope.options.map((scope) => (
						<li key={scope}>
							<strong>{scopeLabels[scope].label}</strong>
							<span> — {scopeLabels[scope].description}</span>
						</li>
					))}
				</ol>
			</section>

			<section>
				<h2>Issue が解決するまで</h2>
				<p>投稿された Issue は、次の順に状態が変わっていきます。</p>
				<ol className="statuses">
					{IssueStatus.options.map((status) => (
						<li key={status}>{statusLabels[status]}</li>
					))}
				</ol>
			</section>
		</main>
	);
}
