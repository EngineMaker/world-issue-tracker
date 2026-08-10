import Link from "next/link";

const lifecycle = [
	{ label: "Open", className: "design-status-open" },
	{ label: "Triaged", className: "design-status-triaged" },
	{ label: "In Progress", className: "design-status-progress" },
	{ label: "Review", className: "design-status-review" },
	{ label: "Resolved", className: "design-status-resolved" },
	{ label: "Closed", className: "design-status-closed" },
] as const;

const tokenRows = [
	{
		name: "--shadow-card",
		value: "0 8px 24px rgba(28, 36, 32, 0.08)",
		rationale:
			"一覧カード、詳細の情報パネル、空の状態の浮き。border だけだった面に奥行きを足す。",
	},
	{
		name: "--shadow-button",
		value: "0 4px 16px rgba(26, 127, 90, 0.18)",
		rationale:
			"主要操作の押し心地。hover と focus-visible の差を色だけにしない。",
	},
	{
		name: "--radius-sm / --radius-md / --radius-lg",
		value: "4px / 8px / 12px",
		rationale:
			"入力・ボタン・カードの角を 3 段階に整理。現在の 4px / 6px 混在を解消する。",
	},
	{
		name: "--surface-muted / --surface-accent / --sun-soft",
		value: "薄い面の段階 + 暖色アクセント",
		rationale:
			"トップのヒーロー、空の状態、補助パネルの面を分け、暗く事務的になりすぎるのを防ぐ。",
	},
	{
		name: "--leading-tight / --leading-snug / --leading-normal",
		value: "1.2 / 1.4 / 1.6",
		rationale:
			"見出し・補助情報・本文の読み味を分ける。いまの一律 1.6 から役割で使い分ける。",
	},
	{
		name: "--transition-fast / --transition-base",
		value: "160ms / 240ms",
		rationale: "リンク、ボタン、カードの状態変化を瞬間切り替えにしない。",
	},
] as const;

const materialRows = [
	{
		asset: "ヒーロー図版（SVG）",
		source: "apps/web/src/app/design-direction/page.tsx のインライン SVG",
		license: "このリポジトリの MIT License",
		scope: "トップページ見本のヒーロー差し込み位置の表現のみ",
	},
	{
		asset: "空の状態・スコープ・状態の図形",
		source: "同上（CSS とインライン SVG）",
		license: "このリポジトリの MIT License",
		scope: "見本ページ内のみ",
	},
	{
		asset: "外部素材写真",
		source: "未導入",
		license: "外部素材なし（#95 で導入時に購入先と範囲を追記）",
		scope:
			"この Issue では未使用。ヒーロー 1 箇所に限って採用する方針だけ確定。",
	},
] as const;

function HeroIllustration() {
	return (
		<svg
			viewBox="0 0 320 220"
			className="design-hero-illustration"
			role="img"
			aria-label="道具を持ち寄って直している様子のイラスト"
		>
			<title>道具を持ち寄って直している様子のイラスト</title>
			<rect
				className="design-art-sun-soft"
				x="24"
				y="20"
				width="272"
				height="180"
				rx="24"
			/>
			<circle className="design-art-sun" cx="84" cy="72" r="28" />
			<path
				className="design-art-accent"
				d="M42 176c24-34 50-52 78-52 18 0 34 7 49 22 12-10 26-15 42-15 34 0 61 17 81 45"
			/>
			<path className="design-art-line" d="M46 170h236" />
			<rect
				className="design-art-surface"
				x="120"
				y="76"
				width="64"
				height="70"
				rx="14"
			/>
			<rect
				className="design-art-accent-soft"
				x="132"
				y="88"
				width="40"
				height="46"
				rx="10"
			/>
			<path className="design-art-accent" d="M144 108h16M152 100v16" />
			<circle className="design-art-ink" cx="88" cy="144" r="18" />
			<path className="design-art-surface-stroke" d="M88 126v36M70 144h36" />
			<circle className="design-art-accent" cx="226" cy="134" r="20" />
			<path className="design-art-surface-stroke" d="M216 134l8 8 14-18" />
		</svg>
	);
}

function MockStatusFlow() {
	return (
		<ol className="design-status-flow" aria-label="Issue の進み方">
			{lifecycle.map((item) => (
				<li key={item.label} className={item.className}>
					<span aria-hidden="true">●</span>
					{item.label}
				</li>
			))}
		</ol>
	);
}

function MockIssueCard({
	title,
	body,
	meta,
}: {
	title: string;
	body: string;
	meta: string;
}) {
	return (
		<article className="design-mock-card">
			<div className="design-mock-meta-row">
				<span className="design-scope-pill">近隣・コミュニティ</span>
				<span className="design-status-pill design-status-progress">
					<span aria-hidden="true">●</span>
					対応中
				</span>
			</div>
			<h4>{title}</h4>
			<p>{body}</p>
			<p className="design-mock-meta">{meta}</p>
		</article>
	);
}

export default function DesignDirectionPage() {
	return (
		<main className="design-direction-page">
			<section className="design-direction-hero">
				<div className="design-direction-copy">
					<p className="design-kicker">
						Design direction / EngineMaker/world-issue-tracker#94
					</p>
					<h1>「直せそうだ」と思える明るさを持つ見本</h1>
					<p className="design-lead">
						既存の緑（<code>--accent</code>）を主役に育てつつ、 Issue Tracker
						の分かりやすさは残し、表情はもう少し親しみやすくする。 このページは
						#95
						の実装前に合意した見本を、リポジトリ内で参照できる形に写したもの。
					</p>
					<div className="design-action-row">
						<a href="#design-mockups" className="design-button-primary">
							4 つの見本を見る
						</a>
						<a href="#design-tokens" className="design-button-secondary">
							追加トークンの根拠を見る
						</a>
					</div>
					<dl className="design-decision-list">
						<div>
							<dt>方向</dt>
							<dd>
								blame ではなく
								fix。暗さより「追跡され、直る見込み」が伝わる画面。
							</dd>
						</div>
						<div>
							<dt>親しみやすさ</dt>
							<dd>
								16 進 ID は出さず、等幅は座標や URL
								など本当に機械的な値だけに絞る。
							</dd>
						</div>
						<div>
							<dt>素材</dt>
							<dd>
								外部素材はトップのヒーロー 1
								箇所だけ。詳細では投稿写真と競合させない。
							</dd>
						</div>
					</dl>
				</div>
				<div className="design-hero-panel">
					<div className="design-hero-art-frame">
						<HeroIllustration />
					</div>
					<p className="design-hero-note">
						実装時の素材選定基準: 「困っている場面」ではなく「直している場面」、
						人の顔が主役でないもの、日本以外の風景にも差し替えやすいもの。
					</p>
				</div>
			</section>

			<section id="design-mockups" className="design-section">
				<div className="design-section-heading">
					<p className="design-kicker">Approved mockups</p>
					<h2>3 画面以上の見本</h2>
					<p>
						トップページ、Issue 一覧、Issue 詳細（写真あり / なし）の 4
						パターンを残し、 以後の実装はこの方向を正として進める。
					</p>
				</div>
				<div className="design-screen-grid">
					<article className="design-screen">
						<header className="design-screen-header">
							<p className="design-screen-kicker">Top page</p>
							<h3>トップページ</h3>
							<p>
								写真の上に文字を重ねず、隣に置く。最初に「何を直せるサービスか」を読ませる。
							</p>
						</header>
						<div className="design-screen-body design-home-mock">
							<div className="design-home-copy">
								<span className="design-band">
									Community fixes, world scale
								</span>
								<h4>地球のバグを、みんなで見つけて、みんなで直す</h4>
								<p>
									困りごとは不満のまま積まず、追跡できる Issue として並べる。
									個人の一歩から自治体・世界スコープまで、同じ画面で見渡せる。
								</p>
								<div className="design-action-row">
									<span className="design-button-primary">Issue を起票</span>
									<span className="design-button-secondary">
										困りごとを見る
									</span>
								</div>
							</div>
							<div className="design-photo-card">
								<HeroIllustration />
							</div>
							<div className="design-home-rail">
								<MockStatusFlow />
								<MockIssueCard
									title="商店街のベンチが壊れて座れない"
									body="支え木が外れたままで、待ち合わせの人が立ったままになっている。"
									meta="2 時間前 / 3 人が手伝います"
								/>
							</div>
						</div>
					</article>

					<article className="design-screen">
						<header className="design-screen-header">
							<p className="design-screen-kicker">Issue list</p>
							<h3>Issue 一覧</h3>
							<p>
								絞り込み、結果件数、カードの情報密度を整理し、スクロールしても進み具合を見失わない。
							</p>
						</header>
						<div className="design-screen-body">
							<div className="design-filter-panel">
								<div className="design-filter-row">
									<span className="design-input-chip">キーワード</span>
									<span className="design-input-chip">スコープ</span>
									<span className="design-input-chip">状態</span>
								</div>
								<p className="design-filter-summary">
									24 件の困りごと / 条件に合うものを 8 件表示
								</p>
							</div>
							<div className="design-stack">
								<MockIssueCard
									title="川沿い遊歩道の照明が夜に切れたまま"
									body="写真と説明が同時に目に入り、次に何をすればよいかが分かるカードを目指す。"
									meta="3 時間前 / コメント 4 件"
								/>
								<MockIssueCard
									title="保育園前の横断歩道で車が止まりにくい"
									body="日時は UTC の記録ではなく “2 時間前” のような人間の時間感覚で出す。"
									meta="1 週間前 / 手伝います 12 件"
								/>
							</div>
							<div className="design-empty-card">
								<p className="design-empty-title">検索結果 0 件</p>
								<p>
									条件を狭めすぎています。フィルタを 1 つ外すと近い Issue
									が見つかる可能性があります。
								</p>
								<span className="design-button-secondary">条件をクリア</span>
							</div>
						</div>
					</article>

					<article className="design-screen">
						<header className="design-screen-header">
							<p className="design-screen-kicker">Issue detail / with photo</p>
							<h3>Issue 詳細（写真あり）</h3>
							<p>
								写真は主役だが、説明を押しのけない。最初の視界で状況と本文が同時に入る高さに抑える。
							</p>
						</header>
						<div className="design-screen-body design-detail-layout">
							<div className="design-photo-stack">
								<div className="design-photo-card design-photo-card-tall">
									<HeroIllustration />
								</div>
								<p className="design-photo-caption">
									投稿写真は詳細ページの主役。飾り写真はここに足さない。
								</p>
							</div>
							<div className="design-stack">
								<div className="design-detail-header">
									<span className="design-scope-pill">自治体</span>
									<span className="design-status-pill design-status-review">
										<span aria-hidden="true">●</span>
										レビュー中
									</span>
									<p className="design-mock-meta">
										2 時間前 / コメント 6 件 / 手伝います 3 件
									</p>
								</div>
								<div className="design-detail-panel">
									<h4>写真と説明が同時に目に入る配置</h4>
									<p>
										写真は横長かつ最大高を持つ面として扱い、その下に説明・状態操作・コメント導線を素直に積む。
									</p>
									<div className="design-action-row">
										<span className="design-button-primary">手伝います</span>
										<span className="design-button-secondary">
											コメントする
										</span>
									</div>
								</div>
								<MockStatusFlow />
							</div>
						</div>
					</article>

					<article className="design-screen">
						<header className="design-screen-header">
							<p className="design-screen-kicker">
								Issue detail / without photo
							</p>
							<h3>Issue 詳細（写真なし）</h3>
							<p>
								写真がない場合は地図・本文・行動導線を主役にし、情報が足りない感じに見せない。
							</p>
						</header>
						<div className="design-screen-body design-detail-layout">
							<div className="design-map-card">
								<div className="design-map-grid" aria-hidden="true">
									<span />
									<span />
									<span />
									<span />
									<span className="design-map-marker" />
									<span />
									<span />
									<span />
									<span />
								</div>
								<p className="design-mock-meta">35.681236, 139.767125</p>
							</div>
							<div className="design-stack">
								<div className="design-detail-panel">
									<h4>コメント 0 件でも行き止まりにしない</h4>
									<p>
										「まだコメントなし」を終点にせず、最初の一歩が何かを短く添える。
										送信中はボタン文言だけでなく、ボタン自身の面と影も変えて反応を返す。
									</p>
								</div>
								<div className="design-empty-card">
									<p className="design-empty-title">まだコメントなし</p>
									<p>
										現場の状況、困っている時間帯、すでに試したことを書くと次の人が動きやすい。
									</p>
									<span className="design-button-secondary">
										最初のコメントを書く
									</span>
								</div>
							</div>
						</div>
					</article>
				</div>
			</section>

			<section className="design-section">
				<div className="design-section-heading">
					<p className="design-kicker">Empty and loading</p>
					<h2>空の状態と待ち時間</h2>
					<p>
						文言を変えるだけで終わらせず、次に何をすればよいかを面で案内する。
					</p>
				</div>
				<div className="design-state-grid">
					<div className="design-empty-card">
						<p className="design-empty-title">Issue 0 件</p>
						<p>
							最初の 1
							件が基準になる。場所、写真、カテゴリがそろうと次の投稿がしやすい。
						</p>
						<span className="design-button-primary">最初の Issue を起票</span>
					</div>
					<div className="design-empty-card design-empty-card-warm">
						<p className="design-empty-title">検索結果 0 件</p>
						<p>
							近いカテゴリ、近いスコープ、期限を広げる、の順で戻れるようにする。
						</p>
						<span className="design-button-secondary">条件を広げる</span>
					</div>
					<div className="design-loading-card">
						<div className="design-skeleton design-skeleton-wide" />
						<div className="design-skeleton" />
						<div className="design-skeleton" />
						<div className="design-skeleton-pill" />
						<p className="design-mock-meta">
							読み込み中は骨組みを先に見せ、ボタンは押せない面として残す。
						</p>
					</div>
				</div>
			</section>

			<section id="design-tokens" className="design-section">
				<div className="design-section-heading">
					<p className="design-kicker">Token decisions</p>
					<h2>追加トークンと根拠</h2>
					<p>
						見本の値を基準にし、実装はそれに合わせる。既存値を変えるのは
						<code>--text-heading-site</code> を <code>1.0625rem</code> に下げる
						1 箇所だけ。
					</p>
				</div>
				<div className="design-token-table-wrap">
					<table className="design-token-table">
						<thead>
							<tr>
								<th scope="col">トークン</th>
								<th scope="col">値</th>
								<th scope="col">見本での役割</th>
							</tr>
						</thead>
						<tbody>
							{tokenRows.map((row) => (
								<tr key={row.name}>
									<th scope="row">{row.name}</th>
									<td>{row.value}</td>
									<td>{row.rationale}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<div className="design-heading-decision">
					<h3>見出しの段階</h3>
					<p>
						5 段階には畳まず、見出し専用に 3 段階を残す。
						<code>--text-heading-page</code> /{" "}
						<code>--text-heading-section</code> /
						<code>--text-heading-site</code>{" "}
						を持ち、サイト名だけは本文より大きい必要がないため
						<code>1.2rem</code> から <code>1.0625rem</code> へ下げる。
					</p>
				</div>
			</section>

			<section className="design-section">
				<div className="design-section-heading">
					<p className="design-kicker">Materials and license</p>
					<h2>素材の一覧とライセンス</h2>
					<p>
						この Issue
						では外部素材をコミットせず、見本の再現に必要な図版だけをリポジトリ内で持つ。
					</p>
				</div>
				<div className="design-token-table-wrap">
					<table className="design-token-table">
						<thead>
							<tr>
								<th scope="col">素材</th>
								<th scope="col">出典</th>
								<th scope="col">ライセンス</th>
								<th scope="col">利用範囲</th>
							</tr>
						</thead>
						<tbody>
							{materialRows.map((row) => (
								<tr key={row.asset}>
									<th scope="row">{row.asset}</th>
									<td>{row.source}</td>
									<td>{row.license}</td>
									<td>{row.scope}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="design-footnote">
					#95
					で実装に入る際は、ヒーロー用の外部写真を導入するならこの表に購入先・ライセンス範囲・最適化後の配信サイズを追記する。
				</p>
			</section>

			<p className="design-back-link">
				<Link href="/">サイトに戻る</Link>
			</p>
		</main>
	);
}
