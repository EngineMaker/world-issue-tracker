import { getUiMessages } from "@world-issue-tracker/shared";
import Link from "next/link";
import {
	buildIssueQueryString,
	fetchIssues,
	type IssueFilters,
	locatedIssues,
	parseIssueFilters,
	type RawSearchParams,
} from "../../lib/issues";
import { getLocale } from "../../lib/locale";
import { resolveTileAttribution, resolveTileUrlTemplate } from "../../lib/map";
import {
	clampMapZoom,
	fitViewToIssues,
	MAX_MAP_ZOOM,
	type MapView,
	MIN_MAP_ZOOM,
} from "../../lib/map-view";
import { IssueFilterForm } from "../components/IssueFilterForm";
import { IssuesMap } from "../components/IssuesMap";

/**
 * 地図ダッシュボード（#113）。
 *
 * 一覧（時系列）とは別に、複数の Issue を 1 枚の地図で見比べる画面。
 * 「この地域に何が集まっているか」は一覧を上から読んでも分からない。
 *
 * **独立した画面にしている理由**（Issue のコメントの指示）。トップページは
 * フェーズ B で構成を整えたばかりで、そこへ地図を足すと再設計になる。
 * 一覧ページには絞り込みとページ送りが既にあり、地図を足すと主役が分散する。
 *
 * **パン・ズームを URL に載せている理由**は `IssuesMap.tsx` に書いた。
 * 一覧ページと同じく、状態を URL が持つので共有・ブックマーク・戻るが効く。
 *
 * 取得件数を一覧より多くしているのは、地図の目的が「偏りを読む」ことだから。
 * 20 件ずつページを送りながら地図を見ても、地理的な分布は掴めない。
 */

/**
 * 地図に載せる最大件数。API 側の上限（100）に合わせている。
 *
 * これを超える分は地図に出ない。件数が増えたら「表示範囲内だけを
 * 取りに行く」形へ変える必要があるが、本番が 4 件の現状では過剰なので
 * まず上限まで一度に取る（ヒートマップと同じく、件数が増えてから判断する）。
 */
const MAP_ISSUE_LIMIT = 100;

/**
 * パンで 1 回に動く距離。表示領域のおよそ半分。
 *
 * ズームによって「画面の半分」が指す緯度経度の幅は変わるので、
 * ズーム 0 での幅を基準にして 2 の冪で割る。
 */
function panStep(zoom: number): number {
	// ズーム 0 では世界の横幅が 360 度。表示領域が世界の何割かに応じて
	// 動く幅が決まるが、細かく合わせるより「押すと半画面ぶん動く」と
	// 分かる方が操作しやすいので、素朴に 2 の冪で割った値を使う
	return 180 / 2 ** zoom;
}

/** 緯度は極を越えられない。越える指定は端で止める */
function clampLatitude(latitude: number): number {
	return Math.min(85, Math.max(-85, latitude));
}

/** 経度は東西につながっているので、はみ出した分は反対側へ回す */
function wrapLongitude(longitude: number): number {
	return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * URL のクエリから視界を読む。
 *
 * `zoom` / `lat` / `lng` が揃っていなければ null を返し、呼び出し側が
 * 「Issue が全部収まる視界」を自動で決める。初めて開いたときに
 * 適当な場所を映さないため。
 *
 * 値は利用者が手で編集できるので、範囲外や数値でないものは捨てる。
 */
function parseViewParams(params: RawSearchParams): MapView | null {
	const read = (key: string): number | null => {
		const raw = params[key];
		const single = Array.isArray(raw) ? raw[0] : raw;
		if (typeof single !== "string") return null;
		const value = Number(single);
		return Number.isFinite(value) ? value : null;
	};

	const zoom = read("zoom");
	const latitude = read("lat");
	const longitude = read("lng");
	if (zoom === null || latitude === null || longitude === null) {
		return null;
	}

	return {
		zoom: clampMapZoom(zoom),
		centerLatitude: clampLatitude(latitude),
		centerLongitude: wrapLongitude(longitude),
	};
}

/** 絞り込み条件と視界を載せた `/map` の URL を組み立てる */
function buildMapHref(filters: IssueFilters, view: MapView | null): string {
	const params = new URLSearchParams(buildIssueQueryString(filters));
	// 地図はページを送らないので、一覧用の offset は落とす
	params.delete("offset");
	if (view) {
		params.set("zoom", String(view.zoom));
		// 桁を落とす。緯度経度を丸めずに載せると URL が読めない長さになり、
		// 押すたびに末尾の桁だけが変わって履歴が汚れる
		params.set("lat", view.centerLatitude.toFixed(4));
		params.set("lng", view.centerLongitude.toFixed(4));
	}
	const query = params.toString();
	return query ? `/map?${query}` : "/map";
}

export default async function MapPage({
	searchParams,
}: {
	searchParams: Promise<RawSearchParams>;
}) {
	const locale = await getLocale();
	const messages = getUiMessages(locale);
	const params = await searchParams;

	// 絞り込みは一覧と同じ仕組みを使う。同じ条件が同じクエリ名で効くので、
	// 一覧と地図を行き来しても条件が保たれる
	const filters = parseIssueFilters(params);
	const result = await fetchIssues({ limit: MAP_ISSUE_LIMIT, filters });

	const tileUrlTemplate = resolveTileUrlTemplate();
	const attribution = resolveTileAttribution();

	const issues = result.ok ? result.issues : [];
	/*
	 * 地図に載せられるのは座標を持つ Issue だけ（#124）。
	 *
	 * 位置を出さずに起票された Issue は座標が null で、そのまま
	 * `fitViewToIssues` や `IssuesMap` へ渡すと図法の計算に null が入って
	 * NaN になる。**1 件のせいで地図全体が描けなくなる**ので、ここで絞る。
	 *
	 * 絞った分は無かったことにせず、下の一覧の後に件数を出す。
	 * 黙って落とすと、地図の上の点が「条件に合う Issue の全部」だと読まれる。
	 */
	const plotted = locatedIssues(issues);
	const withoutLocationCount = issues.length - plotted.length;
	// URL に視界が載っていなければ、取得した Issue が全部収まる範囲を選ぶ。
	// 初めて開いた人が、いきなり何も映っていない海を見ることがないように
	const view = parseViewParams(params) ?? fitViewToIssues(plotted);

	const step = panStep(view.zoom);
	const moved = (dLat: number, dLng: number): MapView => ({
		zoom: view.zoom,
		centerLatitude: clampLatitude(view.centerLatitude + dLat),
		centerLongitude: wrapLongitude(view.centerLongitude + dLng),
	});

	return (
		<main>
			<h1>{messages.mapPage.heading}</h1>
			<p className="section-lead">{messages.mapPage.lead}</p>

			{/*
			  絞り込みは一覧と同じ部品を使う。送信先だけ地図に向ける
			  （既定のままだと、絞り込んだ瞬間に一覧へ飛ばされる）
			*/}
			<IssueFilterForm filters={filters} locale={locale} action="/map" />

			{result.ok ? (
				<>
					{tileUrlTemplate ? (
						<IssuesMap
							issues={plotted}
							tileUrlTemplate={tileUrlTemplate}
							attribution={attribution}
							view={view}
							locale={locale}
						/>
					) : (
						// 配信元が未設定のときは地図を出さない（#63 と同じ判断）。
						// ただし画面ごと空にはせず、理由と代わりの導線を出す
						<p className="map-notice">{messages.mapPage.tilesUnavailable}</p>
					)}

					{/*
					  パン・ズームの操作。リンクなので JS を配らずに動き、
					  「いま見ている場所」がそのまま URL になる
					*/}
					<nav className="map-controls" aria-label={messages.mapPage.panLabel}>
						<span className="map-controls-label">
							{messages.mapPage.zoomLabel}
						</span>
						<Link
							href={buildMapHref(filters, {
								...view,
								zoom: clampMapZoom(view.zoom + 1),
							})}
							aria-disabled={view.zoom >= MAX_MAP_ZOOM}
						>
							{messages.mapPage.zoomIn}
						</Link>
						<Link
							href={buildMapHref(filters, {
								...view,
								zoom: clampMapZoom(view.zoom - 1),
							})}
							aria-disabled={view.zoom <= MIN_MAP_ZOOM}
						>
							{messages.mapPage.zoomOut}
						</Link>

						<span className="map-controls-label">
							{messages.mapPage.panLabel}
						</span>
						<Link href={buildMapHref(filters, moved(step / 2, 0))}>
							{messages.mapPage.panNorth}
						</Link>
						<Link href={buildMapHref(filters, moved(-step / 2, 0))}>
							{messages.mapPage.panSouth}
						</Link>
						<Link href={buildMapHref(filters, moved(0, -step))}>
							{messages.mapPage.panWest}
						</Link>
						<Link href={buildMapHref(filters, moved(0, step))}>
							{messages.mapPage.panEast}
						</Link>

						{/*
						  動かしすぎて Issue が 1 件も映らなくなったときの逃げ道。
						  視界を URL から落とすと、全件が収まる範囲へ戻る
						*/}
						<Link href={buildMapHref(filters, null)}>
							{messages.mapPage.resetView}
						</Link>
					</nav>

					{/*
					  地図の下に一覧を添える。地図が読めない状況（配信元の障害、
					  スクリーンリーダー）でも、どこに何があるかを文字で読めるようにする
					*/}
					<section>
						<h2>{messages.mapPage.listHeading}</h2>
						{plotted.length === 0 ? (
							<p className="map-notice">{messages.mapPage.noIssues}</p>
						) : (
							<ul className="map-issue-list">
								{plotted.map((issue) => (
									<li key={issue.id}>
										<Link href={`/issues/${issue.id}`}>{issue.title}</Link>
									</li>
								))}
							</ul>
						)}
						{/*
						  地図に出ていない Issue があることを伝える（#124）。
						  件数だけ出して、読むには一覧へ行けばよいと分かるようにする
						*/}
						{withoutLocationCount > 0 && (
							<p className="map-notice">
								{messages.mapPage.withoutLocation(withoutLocationCount)}
							</p>
						)}
					</section>
				</>
			) : (
				// 取得に失敗したときに 0 件と同じ見た目にすると、
				// 「この地域に Issue が無い」と誤読させる
				<p className="map-notice">{messages.mapPage.fetchFailed}</p>
			)}

			<p className="page-nav">
				<Link href="/issues">{messages.mapPage.backToList}</Link>
				<Link href="/">{messages.mapPage.backToHome}</Link>
			</p>
		</main>
	);
}
