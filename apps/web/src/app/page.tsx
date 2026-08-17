import {
	getUiMessages,
	ISSUE_SCOPE_LABELS,
	IssueScope,
	IssueStatus,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { fetchIssues } from "../lib/issues";
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
	const result = await fetchIssues();

	return (
		<main>
			{/*
			  ヒーロー（Issue #95、見本は #94）。
			  文字を絵の上に重ねず隣に置いている。重ねると絵ごとに読みやすさが
			  変わり、差し替えのたびに文字色や影の調整が要る。
			*/}
			<section className="hero">
				<div className="hero-body">
					{/* サイト名は Header が出しているので、ここはページ固有の見出しにする */}
					<h1 className="hero-heading">{messages.home.heading}</h1>
					<p className="hero-lead">{messages.home.aboutBody1}</p>
					<p className="hero-actions">
						<Link className="button-link" href="/issues/new">
							{messages.home.writeIssue}
						</Link>
						<Link href="/issues">{messages.home.viewIssues}</Link>
					</p>
				</div>
				{/*
				  絵の置き場所。#94 は素材写真をここに置くと決めたが、素材そのものは
				  まだ選定されていない（ライセンス一覧が要る）。写真が入るまでの間も
				  ヒーローが成立するよう、外部素材に依存しないインライン SVG を置く。
				  内容を持たない装飾なので、読み上げからは外す。
				*/}
				<div className="hero-figure" aria-hidden="true">
					{/*
					  `aria-hidden` の中なので `<title>` は読まれない。
					  装飾に説明を付けても読み上げが冗長になるだけなので置かない
					*/}
					<svg
						className="hero-figure-art"
						viewBox="0 0 160 120"
						role="presentation"
					>
						{/* 地平線。個人から世界までが同じ地続きにあることを面で示す */}
						<circle className="hero-art-sun" cx="118" cy="34" r="18" />
						<path
							className="hero-art-ground"
							d="M0 84 C 30 70, 60 92, 90 78 S 140 70, 160 82 L160 120 L0 120 Z"
						/>
						{/* 直っていく道筋。左から右へ、印が満ちていく */}
						<g className="hero-art-steps">
							<circle cx="24" cy="60" r="6" />
							<circle cx="52" cy="52" r="6" />
							<circle cx="80" cy="44" r="6" />
							<circle cx="108" cy="36" r="6" />
						</g>
						<path className="hero-art-path" d="M24 60 L52 52 L80 44 L108 36" />
					</svg>
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
				  スコープの階段（#94）。段が上がるほど右に寄る形で、
				  個人と世界が同じ物差しの上にあることを示す。
				  字下げの量は CSS が `--depth` から算出する
				*/}
				<ol className="scopes">
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
		</main>
	);
}
