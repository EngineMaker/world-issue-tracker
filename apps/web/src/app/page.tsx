import {
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	IssueStatus,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { DEFAULT_ISSUE_FILTERS, fetchIssues } from "../lib/issues";
import { getLocale } from "../lib/locale";
import { IssueList } from "./components/IssueList";
import { StatusPill } from "./components/StatusPill";

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
	/*
	 * 一覧と、解決の実例（B5）を並行して取る。
	 *
	 * 解決済みは 1 件だけ。帯に置くのは「実際に直った」ことを示す証拠で、
	 * 一覧として眺めさせる場所ではない。件数を増やすと、下にある
	 * 「最近の Issue」と役割が重なる。
	 */
	const [result, solved] = await Promise.all([
		fetchIssues(),
		fetchIssues({
			limit: 1,
			filters: { ...DEFAULT_ISSUE_FILTERS, status: "resolved" },
		}),
	]);
	// 取得に失敗したときは帯ごと出さない。トップページの主役は一覧なので、
	// 補助的な帯のために「取得できませんでした」を出す価値が無い
	const solvedIssue = solved.ok ? solved.issues[0] : undefined;

	return (
		<main>
			{/*
			  ヒーロー（Issue #95、見本は #94）。

			  以前は右にベクター画像を置いた 2 列だったが、B2 で絵を削除した。
			  意味を持たない装飾で、字を大きくするための幅を奪っていたため
			  （経緯は globals.css の .hero を参照）。
			*/}
			<section className="hero">
				<div className="hero-body">
					{/*
					  サイト名は Header が出しているので、ここはページ固有の見出しにする。

					  アイブロウ（B1）は見出しの一部として h1 の中に置く。外に出すと
					  読み上げが「個人から世界まで」と「地球のバグを、みんなで直す。」を
					  別々の要素として読み、繋がりが消える。見た目の大きさは CSS が分ける
					*/}
					<h1 className="hero-heading">
						<span className="hero-eyebrow">{messages.home.headingEyebrow}</span>
						{messages.home.heading}
					</h1>
					<p className="hero-lead">{messages.home.aboutBody1}</p>
					<p className="hero-actions">
						<Link className="button-link" href="/issues/new">
							{messages.home.writeIssue}
						</Link>
						<Link href="/issues">{messages.home.viewIssues}</Link>
					</p>
				</div>
			</section>

			<section>
				<h2>{messages.home.aboutHeading}</h2>
				<p>{messages.home.aboutBody2}</p>
			</section>

			<nav aria-label={messages.home.actionsLabel}>
				<h2>{messages.home.actionsHeading}</h2>
				<ul className="actions">
					<li>
						<Link className="action-card" href="/issues">
							<span className="action-card-title">
								{messages.home.viewIssues}
							</span>
							<span className="action-card-hint">
								{messages.home.viewIssuesHint}
							</span>
						</Link>
					</li>
					<li>
						<Link className="action-card" href="/issues/new">
							<span className="action-card-title">
								{messages.home.writeIssue}
							</span>
							<span className="action-card-hint">
								{messages.home.writeIssueHint}
							</span>
						</Link>
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
				{/*
				  スコープのバー（B3）。段が上がるほど**幅が広がる**形で、
				  個人と世界が同じ物差しの上にあることを示す。

				  以前は段が上がるほど右に字下げする形だったが、それだと
				  スコープが広がるほど行が短くなり、意味と見た目が逆行していた
				  （世界＝いちばん広いはずのものが、いちばん細い行になる）。

				  幅は CSS が `--depth`（0 起点の段目）と `--steps`（総段数）から
				  算出する。段数を CSS に書かないのは、スコープが増えたときに
				  直し忘れて階段が途切れるのを防ぐため（#94 からの方針）
				*/}
				<ol
					className="scopes"
					style={
						{ "--steps": IssueScope.options.length } as React.CSSProperties
					}
				>
					{IssueScope.options.map((scope, index) => (
						<li key={scope} style={{ "--depth": index } as React.CSSProperties}>
							<span className="scope-name">{scopeLabels[scope].label}</span>
							<span className="scope-description">
								{scopeLabels[scope].description}
							</span>
						</li>
					))}
				</ol>
			</section>

			<section>
				<h2>{messages.home.statusesHeading}</h2>
				<p>{messages.home.statusesBody}</p>
				{/*
				  段階の流れ（A6）。矢印は「前の段階から続いてくる線」なので、
				  自分より前ではなく**後ろのピルと同じ塊**に入れる。
				  こうすると折り返しは必ず「矢印＋ピル」の手前で起き、
				  行末に矢印だけが取り残されない（詳細は globals.css の .status-step）。

				  矢印は順序を目で見せるためだけの記号で、同じ情報は ol の
				  並び順が既に持っている。読み上げに「右矢印」が挟まると
				  段階の名前が続けて読めなくなるので `aria-hidden` で外す
				*/}
				<ol className="statuses">
					{IssueStatus.options.map((status, index) => (
						<li className="status-step" key={status}>
							{index > 0 ? (
								<span className="status-arrow" aria-hidden="true">
									→
								</span>
							) : null}
							<StatusPill status={status} locale={locale} />
						</li>
					))}
				</ol>
			</section>

			{/*
			  解決の実例（B5）。ページ全体が同じ明度で続いているので、
			  濃緑の帯を 1 つだけ入れて面のコントラストを作る。

			  中身は実際に解決した Issue を API から取って出す。事例を文言として
			  書かないのは、書いた瞬間に「実在しない事例」になるため
			  （指示書も、見本の草刈りの事例を架空だとして使用を禁じている）。
			  解決済みがまだ無いうちは、空状態として「最初の解決を待っています」を出す。

			  帯だけ全幅にしたいが、main には左右の余白がある。負のマージンで
			  外へ広げると横スクロールの原因になるので、CSS 側で対処している
			*/}
			<section className="solved-band">
				<h2>{messages.home.solvedHeading}</h2>
				{solvedIssue ? (
					<>
						{/* 3 ビート（投稿された → 誰かが動いた → 解決した） */}
						<p className="solved-flow">{messages.home.solvedFlow}</p>
						<Link className="solved-issue" href={`/issues/${solvedIssue.id}`}>
							<span className="solved-issue-title">{solvedIssue.title}</span>
							<span className="solved-issue-meta">
								{scopeLabels[solvedIssue.scope].label}
							</span>
						</Link>
						<p className="solved-actions">
							<Link href="/issues?status=resolved">
								{messages.home.solvedViewAll}
							</Link>
						</p>
					</>
				) : (
					<p className="solved-actions">
						{messages.home.solvedEmpty}{" "}
						<Link href="/issues/new">{messages.home.solvedEmptyAction}</Link>
					</p>
				)}
			</section>
		</main>
	);
}
