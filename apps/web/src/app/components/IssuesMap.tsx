import {
	DEFAULT_LOCALE,
	getUiMessages,
	type Locale,
} from "@world-issue-tracker/shared";
import Link from "next/link";
import type { PublicIssue } from "../../lib/issues";
import {
	latitudeToTileY,
	longitudeToTileX,
	TILE_SIZE,
	tileUrl,
} from "../../lib/map";
import {
	fitViewToIssues,
	MAP_VIEW_HEIGHT,
	MAP_VIEW_WIDTH,
	type MapView,
	projectToView,
} from "../../lib/map-view";

/**
 * 複数の Issue を 1 枚の地図にプロットする（#113）。
 *
 * `IssueMap` は 1 件の位置を示す部品で、ズームが固定・地点が中央に 1 つ、
 * という前提で書かれている。ここは前提が違う（地点が複数・散らばりに応じて
 * 縮尺が変わる・中心が地点と一致しない）ので、共有せず別の部品にしている。
 * 座標変換そのものは `lib/map.ts` を共有する。
 *
 * **地図ライブラリを使っていない理由。** Issue #113 のコメントは
 * MapLibre GL JS の導入を決めているが、この作業環境では新しい依存を
 * 追加できない（`node_modules` が共有のシンボリックリンクで、`bun add` が
 * 他の作業を壊す）。依存の追加は Issue にコメントして人へ引き継いだうえで、
 * ここでは #63 と同じラスタタイルを `<img>` で並べる方式を複数地点へ
 * 広げている。受け入れ条件（複数プロット・パン・ズーム・絞り込み）は
 * この方式でも満たせる。
 *
 * MapLibre へ移す際にこのファイルは丸ごと置き換わる。座標計算を
 * `lib/map-view.ts` に分けてあるので、置き換えの範囲はここに閉じる。
 *
 * **パン・ズームを URL で持つ理由。** ドラッグとホイールで動かすには
 * Client Component と状態管理が要る。URL に中心とズームを載せる形なら
 * Server Component のまま動き、「いま見ている場所」がそのまま共有・
 * ブックマークできる（一覧の絞り込みが `searchParams` を使っているのと
 * 同じ考え方 — `app/issues/page.tsx` のコメント参照）。
 *
 * タイルに `next/image` ではなく `<img>` を使う理由は `IssueMap.tsx` と同じ。
 */

/**
 * 表示領域を覆うのに要るタイルの枚数（一辺）。
 *
 * 表示領域より 2 枚多く並べる。中心がタイルの境界からずれる分（最大 1 枚）と、
 * 端で切れないための 1 枚。足りないと地図の縁に背景が覗く。
 */
function tileCount(size: number): number {
	return Math.ceil(size / TILE_SIZE) + 2;
}

export function IssuesMap({
	issues,
	tileUrlTemplate,
	attribution = null,
	view,
	locale = DEFAULT_LOCALE,
}: {
	issues: readonly PublicIssue[];
	/** タイル配信元。未設定（null）なら地図を描かない。 */
	tileUrlTemplate: string | null;
	/** 配信元が要求する帰属表示。無ければ null。 */
	attribution?: string | null;
	/**
	 * 映す範囲。省略時は渡された Issue が全部収まるよう自動で決める。
	 * ページ側は URL のパン・ズームを反映した視界を渡す。
	 */
	view?: MapView;
	locale?: Locale;
}) {
	// 配信元が決まっていないときは何も描かない（#63 と同じ判断）。
	// 適当な既定値でタイルを取りに行くと規約違反のトラフィックを出す。
	// 呼び出し側が Issue の一覧を別に出しているので、情報は失われない
	if (!tileUrlTemplate) {
		return null;
	}

	const resolved = view ?? fitViewToIssues(issues);
	const messages = getUiMessages(locale);

	// 表示領域の中心が乗っているタイル。ここを基準に周囲を並べる
	const centerX = longitudeToTileX(resolved.centerLongitude, resolved.zoom);
	const centerY = latitudeToTileY(resolved.centerLatitude, resolved.zoom);

	const columns = tileCount(MAP_VIEW_WIDTH);
	const rows = tileCount(MAP_VIEW_HEIGHT);

	// タイル群の左上のタイル番号。中心のタイルから半分ずつ戻る
	const originTileX = Math.floor(centerX) - Math.floor(columns / 2);
	const originTileY = Math.floor(centerY) - Math.floor(rows / 2);

	// タイル群をずらす量。視界の中心が表示領域の中央に来るようにする
	const offsetX = MAP_VIEW_WIDTH / 2 - (centerX - originTileX) * TILE_SIZE;
	const offsetY = MAP_VIEW_HEIGHT / 2 - (centerY - originTileY) * TILE_SIZE;

	/** このズームで世界を覆うタイルの枚数（一辺）。番号はこの範囲にしか無い。 */
	const worldTiles = 2 ** resolved.zoom;

	/*
	 * 表示領域の中に入る Issue だけを先に選ぶ。
	 *
	 * 外にあるものを `overflow: hidden` で隠すだけだと、要素は残るので
	 * キーボード操作の順番に見えないリンクが挟まる。件数の表示も
	 * 「地図に見えている数」と食い違う
	 */
	const visible = issues
		.map((issue) => ({
			issue,
			point: projectToView(issue.latitude, issue.longitude, resolved),
		}))
		.filter(
			({ point }) =>
				point.x >= 0 &&
				point.x <= MAP_VIEW_WIDTH &&
				point.y >= 0 &&
				point.y <= MAP_VIEW_HEIGHT,
		);
	const plotted = visible.length;

	return (
		<figure className="issues-map">
			{/*
			  表示領域の寸法は CSS に置いている（`--map-view-width` /
			  `--map-view-height`）。`lib/map-view.ts` の定数と対で意味を持つので、
			  片方だけ変えると地点の位置がずれる。CSS 側の値が定数と一致することは
			  `map-dashboard.test.tsx` が突き合わせている
			*/}
			<div className="issues-map-view">
				<div
					className="issues-map-tiles"
					style={{ transform: `translate(${offsetX}px, ${offsetY}px)` }}
					aria-hidden="true"
				>
					{Array.from({ length: rows }, (_, row) => (
						<div className="issues-map-row" key={`row-${originTileY + row}`}>
							{Array.from({ length: columns }, (_, column) => {
								// 世界は東西につながっているので、東端の先は西端に戻る
								const x =
									(((originTileX + column) % worldTiles) + worldTiles) %
									worldTiles;
								const y = originTileY + row;

								// 南北はつながっていない。上端・下端より外にはタイルが
								// 存在しないので、要求せず空白を置く（404 が並ぶのを防ぐ）
								if (y < 0 || y >= worldTiles) {
									return (
										<div
											key={`blank-${originTileX + column}`}
											className="issues-map-blank"
										/>
									);
								}

								return (
									// biome-ignore lint/performance/noImgElement: next/image はこの用途に合わない（理由はファイル冒頭）
									<img
										key={`${x},${y}`}
										src={tileUrl(tileUrlTemplate, x, y, resolved.zoom)}
										alt=""
										width={TILE_SIZE}
										height={TILE_SIZE}
										loading="lazy"
										referrerPolicy="no-referrer"
										draggable={false}
									/>
								);
							})}
						</div>
					))}
				</div>

				{/*
				  マーカーはタイルとは別の層に置く。タイル側の `transform` に
				  乗せると、ずらす量の計算を二重に持つことになる。
				  ここでは緯度経度から表示領域内の px を直接求めて置く
				*/}
				<ul className="issues-map-markers">
					{visible.map(({ issue, point }) => {
						return (
							<li key={issue.id}>
								{/*
								  マーカーそのものをリンクにする。点が光るだけでは
								  「何が起きているか」まで辿れない
								*/}
								<Link
									className="issues-map-marker"
									href={`/issues/${issue.id}`}
									style={{ left: `${point.x}px`, top: `${point.y}px` }}
								>
									{/*
									  マーカーは見た目としては点だが、読み上げには
									  何の Issue かが要る。視覚的には隠して文字だけ残す
									*/}
									<span className="visually-hidden">{issue.title}</span>
								</Link>
							</li>
						);
					})}
				</ul>
			</div>

			{/*
			  帰属表示は隠さないことがタイル配信元の利用条件に含まれる。
			  併せて、いま何件が地図に乗っているかを添える。地図の外にある
			  Issue は描かれないので、一覧の件数と食い違うことがある
			*/}
			<figcaption className="issues-map-attribution">
				{messages.mapPage.plotted(plotted)}
				{attribution ? ` — ${attribution}` : null}
			</figcaption>
		</figure>
	);
}
