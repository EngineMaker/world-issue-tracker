import {
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueStatus,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { fetchIssues } from "../lib/issues";
import { getLocale } from "../lib/locale";
import { IssueList } from "./components/IssueList";

/**
 * トップページ。
 *
 * Server Component として API を呼んでいる。Client Component にしなかった理由:
 * - サーバー間通信になるためブラウザの CORS 設定に依存しない
 * - JS が無効でも、読み込み前でも Issue が見える（初回表示にローディングが挟まらない）
 * - App Router の素直な形。将来のフィルタも `searchParams` で実現できる
 *
 * 表示言語も Server Component 側で決める（Issue #82）。Cookie から読むので、
 * クライアントの JS を待たずに切り替え後の言語で描かれる。
 */
export default async function Home() {
	const locale = await getLocale();
	const messages = getUiMessages(locale);
	const scopeLabels = ISSUE_SCOPE_LABELS[locale];
	const statusLabels = ISSUE_STATUS_LABELS[locale];
	const result = await fetchIssues();

	return (
		<main>
			{/* サイト名は Header が出しているので、ここはページ固有の見出しにする */}
			<h1>{messages.home.heading}</h1>

			<section>
				<h2>{messages.home.aboutHeading}</h2>
				<p>{messages.home.aboutBody1}</p>
				<p>{messages.home.aboutBody2}</p>
			</section>

			<nav aria-label={messages.home.actionsLabel}>
				<h2>{messages.home.actionsHeading}</h2>
				<ul className="actions">
					<li>
						<Link href="/issues">{messages.home.viewIssues}</Link>
						<span>{messages.home.viewIssuesHint}</span>
					</li>
					<li>
						<Link href="/issues/new">{messages.home.writeIssue}</Link>
						<span>{messages.home.writeIssueHint}</span>
					</li>
				</ul>
			</nav>

			<section>
				<h2>{messages.home.recentHeading}</h2>
				<IssueList result={result} locale={locale} />
				<p>
					<Link href="/issues">{messages.home.viewAll}</Link>
				</p>
			</section>

			<section>
				<h2>{messages.home.scopesHeading}</h2>
				<p>{messages.home.scopesBody}</p>
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
				<h2>{messages.home.statusesHeading}</h2>
				<p>{messages.home.statusesBody}</p>
				<ol className="statuses">
					{IssueStatus.options.map((status) => (
						<li key={status}>{statusLabels[status]}</li>
					))}
				</ol>
			</section>
		</main>
	);
}
