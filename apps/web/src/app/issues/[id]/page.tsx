import {
	getAuthorLabel,
	getUiMessages,
	ISSUE_SCOPE_LABELS,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
	formatCreatedAt,
	toDateTimeTooltip,
	toIsoDateTime,
} from "../../../lib/datetime";
import { fetchHelpOffers } from "../../../lib/help-offers";
import { fetchComments, fetchIssue, issuePhotoUrl } from "../../../lib/issues";
import { getLocale } from "../../../lib/locale";
import {
	resolveTileAttribution,
	resolveTileUrlTemplate,
} from "../../../lib/map";
import { fetchReactions } from "../../../lib/reactions";
import { CommentSection } from "../../components/CommentSection";
import { HelpOfferButton } from "../../components/HelpOfferButton";
import { IssueMap } from "../../components/IssueMap";
import { ReactionButton } from "../../components/ReactionButton";
import { IssueStatusSection } from "../../components/StatusControl";
import { StatusPill } from "../../components/StatusPill";

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

	const [result, commentsResult, offers, reactions] = await Promise.all([
		fetchIssue(id),
		fetchComments(id),
		fetchHelpOffers(id),
		fetchReactions(id),
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
				<div className="error-block">
					<p className="block-message">{messages.issueDetail.retryLater}</p>
					<p className="block-detail">{result.error}</p>
				</div>
				<p className="page-nav">
					<Link href="/issues">{messages.issueDetail.backToList}</Link>
				</p>
			</main>
		);
	}

	const { issue } = result;
	const scope = scopeLabels[issue.scope];
	// 起票者の表示（#67）。同じ画面のメタ情報と「詳細」の 2 箇所に出るので、
	// 値を一度だけ組み立てて両方で使う（片方だけ規則が変わるのを防ぐ）。
	const authorLabel = getAuthorLabel(
		{ isAnonymous: issue.is_anonymous, displayName: issue.display_name },
		locale,
	);

	return (
		<main>
			<h1>{issue.title}</h1>

			{/*
			  スコープとステータスは enum の生値（`community` / `open`）のままだと
			  読み手に伝わらない。ラベルは packages/shared に一本化している
			*/}
			<p className="issue-meta">
				{/*
				  ステータスはピルで出す（#95）。一覧と同じ部品を使うことで、
				  一覧から詳細へ移っても同じ Issue が同じ見た目で続く
				*/}
				<StatusPill status={issue.status} locale={locale} />
				{/*
				  スコープはピル、カテゴリは `#` 付きのタグ（B4）。一覧と同じ形にする。
				  リンクで繋がった 2 画面で同じ Issue が別の見た目になると、
				  同じものだと分からなくなる（#59 と同じ理由）
				*/}
				<span className="scope-pill">{scope.label}</span>
				{issue.category ? (
					<span className="issue-tag">#{issue.category}</span>
				) : null}
				<time
					className="issue-meta-item"
					dateTime={toIsoDateTime(issue.created_at)}
					title={toDateTimeTooltip(issue.created_at, locale)}
				>
					{formatCreatedAt(issue.created_at, locale)}
				</time>
				{" / "}
				<span>{authorLabel}</span>
			</p>

			{/*
			  写真（#65）。説明より前に置く。「壊れた街灯」「伸びた草」の
			  ような物理世界の困りごとは、写真 1 枚が文章 10 行より状況を
			  伝える。読み手が最初に見る位置が写真であるべき。

			  写真が無い Issue では何も出さない。場所は下の「詳細」に
			  地図（#63）があり、そちらが代役を務める
			*/}
			{issue.has_photo && (
				<section>
					<h2>{messages.issueDetail.photoHeading}</h2>
					{/* biome-ignore lint/performance/noImgElement: 配信元（API Worker）は環境変数で差し替わるため next/image の remotePatterns に列挙できず、Workers 上での変換コストに見合う利得も無い（理由は IssueMap と同じ）。寸法を属性で固定しないのは、写真の縦横比が投稿ごとに違うため — CSS で最大幅だけ決め、比率は画像に従わせる */}
					<img
						className="issue-photo"
						src={issuePhotoUrl(issue.id)}
						alt={messages.issueDetail.photoAlt(issue.title)}
					/>
				</section>
			)}

			<section>
				<h2>{messages.issueDetail.descriptionHeading}</h2>
				{/*
				  投稿は textarea への入力なので改行が意味を持つ。
				  既定の `white-space` だと改行が潰れて 1 段落に見える。
				  本文そのものは投稿された言語のまま出す（翻訳は #66）
				*/}
				<p className="issue-description">{issue.description}</p>
			</section>

			{/*
			  「私も困っている」（#112）は本文のすぐ下、ステータス変更や
			  「手伝います」より前に置く。読み終えた直後に、最も心理的コストの
			  低い意思表示から順に並ぶようにする（反応 → 手伝います → コメント）。

			  詳細ページは API にトークンを渡していないので `viewer_reacted` は
			  常に false で返る（Clerk のセッションは Cookie で、別オリジンの
			  API には届かない）。「自分が反応済みか」はブラウザ側で
			  `ReactionButton` が取り直す。件数だけは JS の実行前から読める
			*/}
			{/*
			  配下の Client Component に issue 単位の key を付ける理由（#142）。
			  これらは初期値を props から `useState(initial…)` で受けて内部 state に
			  持つ。詳細→詳細のクライアントソフト遷移（/issues/A → /issues/B）では、
			  同じ位置の同じ型のインスタンスが再マウントされず保持されるため、
			  key が無いと A の件数・コメント・選択中ステータスを B の画面に
			  持ち越してしまう。id を含む key にすると、id が変わった時点で React が
			  別インスタンスとして作り直し、B の props から初期化し直す。
			  現状は詳細→詳細のリンクがまだ無いが、#70 等で入った瞬間に踏むため
			  先に塞いでおく（reaction / help-offer / status / comment の 4 つ）。

			  この 4 つは `<main>` の直接の子（兄弟）なので、素の `issue.id` を
			  そのまま key にすると 4 兄弟が同一 key になり、React が「同じ key の
			  兄弟が複数」と警告する（まさに狙っている A→B 遷移で出る）。
			  コンポーネントごとの接頭辞で兄弟間の一意性を保ちつつ、id の変化で
			  key が変わるようにする。
			*/}
			<ReactionButton
				key={`reaction-${issue.id}`}
				issueId={issue.id}
				initialSummary={reactions.ok ? reactions.summary : null}
				locale={locale}
			/>

			<section>
				<h2>{messages.issueDetail.detailsHeading}</h2>
				{/*
				  項目名と値の対（#95）。以前はクラスが無く、ブラウザ既定の
				  `dd` の字下げだけで対になっていることを示していた。
				  幅があるときは項目名を左の列に置いて、対応を横並びで見せる
				*/}
				<dl className="detail-list">
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
					<dd>
						<StatusPill status={issue.status} locale={locale} />
					</dd>

					<dt>{messages.issueDetail.category}</dt>
					<dd>{issue.category ?? messages.issueDetail.categoryUnset}</dd>

					{/*
					  起票者（#88 / #67）。匿名を選んだ人は「匿名の方」のまま、
					  名乗っている人は Clerk の表示名が出る。上のメタ情報と
					  同じ値を出しており、同じ画面の 2 箇所で食い違わない
					*/}
					<dt>{messages.issueDetail.author}</dt>
					<dd>{authorLabel}</dd>

					<dt>{messages.issueDetail.location}</dt>
					{/*
					  地図を出しても座標の数値は消さない（#63）。タイル配信元が
					  落ちていたり未設定だったりすると地図は出ないが、そのときに
					  位置情報まで失われるのは避けたい。
					  ここで桁を加工しないのも同じ理由で、受け取った値をそのまま出す。
					  丸めるのは API 側の責務（#124。保存も公開も 3 桁）で、画面が
					  独自に丸めると「地図のピン」と「数値」が別の地点を指す。

					  位置を出さずに起票された Issue（#124）は座標が null で届く。
					  地図も座標も出さず、書いた人の選択として伝える。「未設定」と
					  書くと入れ忘れに読め、周りが場所を尋ねる流れになってしまう
					*/}
					<dd>
						{issue.latitude === null || issue.longitude === null ? (
							messages.issueDetail.locationUnset
						) : (
							<>
								<IssueMap
									latitude={issue.latitude}
									longitude={issue.longitude}
									title={issue.title}
									tileUrlTemplate={resolveTileUrlTemplate()}
									attribution={resolveTileAttribution()}
									locale={locale}
								/>
								{messages.issueDetail.coordinates(
									issue.latitude,
									issue.longitude,
								)}
								{/*
								  ピンが実際の場所とずれることを断る。断りが無いと、
								  ピンの指す建物が現場だと読まれる
								*/}
								<span className="field-hint">
									{messages.issueDetail.coordinatesApproximate}
								</span>
							</>
						)}
					</dd>

					<dt>{messages.issueDetail.createdAt}</dt>
					<dd>
						<time
							dateTime={toIsoDateTime(issue.created_at)}
							title={toDateTimeTooltip(issue.created_at, locale)}
						>
							{formatCreatedAt(issue.created_at, locale)}
						</time>
					</dd>

					<dt>{messages.issueDetail.updatedAt}</dt>
					<dd>
						<time
							dateTime={toIsoDateTime(issue.updated_at)}
							title={toDateTimeTooltip(issue.updated_at, locale)}
						>
							{formatCreatedAt(issue.updated_at, locale)}
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
				key={`status-${issue.id}`}
				issueId={issue.id}
				status={issue.status}
				title={issue.title}
				description={issue.description}
				scope={issue.scope}
				category={issue.category}
				locale={locale}
			/>

			{/*
			  「手伝います」はコメントより前に置く。読み終えた直後が一番
			  動き出しやすく、議論を読み進めた先に置くと埋もれる
			*/}
			<HelpOfferButton
				key={`help-offer-${issue.id}`}
				issueId={issue.id}
				initialSummary={offers.ok ? offers.summary : null}
				locale={locale}
			/>

			<CommentSection
				key={`comments-${issue.id}`}
				issueId={issue.id}
				initialResult={commentsResult}
				locale={locale}
			/>

			{/* 読み終えたときに行き止まりにしない */}
			<p className="page-nav">
				<Link href="/issues">{messages.issueDetail.backToList}</Link>
				<Link href="/issues/new">{messages.issueDetail.writeIssue}</Link>
			</p>
		</main>
	);
}
