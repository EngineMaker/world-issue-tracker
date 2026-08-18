/**
 * 複数の Issue を 1 枚の地図に収めるための視界の計算（#113）。
 *
 * `lib/map.ts` は「1 件がどこか」を示すための座標変換で、ズームが固定
 * （`MAP_ZOOM = 15`）だった。こちらは散らばった複数地点を対象にするので、
 * 中心とズームを地点の広がりから決める必要がある。
 *
 * 地図ライブラリを使っていない理由は `IssuesMap.tsx` の冒頭に書いた。
 *
 * `lib/map.ts` と同じく、ここには描画に関わらない純粋な計算だけを置く。
 * 視界の計算を間違えると「地図は出るが Issue が画面の外にある」という、
 * 一見それらしく見えるのに何も読み取れない壊れ方をするため、
 * 独立してテストできる形にしている。
 */

import { latitudeToTileY, longitudeToTileX, TILE_SIZE } from "./map";

/** 地図の表示領域（px）。横長にしているのは、東西に広がる日本列島を収めるため。 */
export const MAP_VIEW_WIDTH = 960;
export const MAP_VIEW_HEIGHT = 600;

/**
 * ズームの下限と上限。
 *
 * 下限 0 は世界全体が 1 枚のタイルに収まる縮尺。上限 18 は建物が見える程度で、
 * 一般的なラスタタイル配信元が用意している最大に合わせている。これより
 * 寄ると存在しないタイルを要求して地図が真っ白になる。
 */
export const MIN_MAP_ZOOM = 0;
export const MAX_MAP_ZOOM = 18;

/**
 * 地点が 1 つ、または全部が同じ座標のときに使うズーム。
 *
 * 広がりが 0 なので「収まる最大のズーム」を計算すると上限に張り付き、
 * 建物しか見えない絵になる。街の様子が分かる程度に引いておく。
 */
const SINGLE_POINT_ZOOM = 13;

/** 0 件のときに映す場所。世界全体を出しても点が無いので、既定は日本周辺。 */
const FALLBACK_VIEW: MapView = {
	centerLatitude: 36,
	centerLongitude: 138,
	zoom: 4,
};

/** 地図の視界。どこを中心に、どの縮尺で映すか。 */
export type MapView = {
	centerLatitude: number;
	centerLongitude: number;
	zoom: number;
};

/** 視界の計算に必要な最小限の形。`PublicIssue` はこれを満たす。 */
type Located = { latitude: number; longitude: number };

/**
 * ズームを実在する範囲の整数へ収める。
 *
 * ズームは URL のクエリから来る（利用者が手で編集できるし、古い
 * ブックマークからも来る）。`zoom=99` をそのまま使うと存在しない
 * タイル番号を組み立てて地図が真っ白になるので、ここで閉じる。
 *
 * 小数を整数へ倒すのは、ラスタタイルが整数のズームにしか存在しないため。
 * NaN は既定へ倒す（`Math.round(NaN)` は NaN のままなので明示的に弾く）。
 */
export function clampMapZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return FALLBACK_VIEW.zoom;
	return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, Math.round(zoom)));
}

/**
 * 渡された地点がすべて収まる視界を求める。
 *
 * タイル座標（Web Mercator）の空間で範囲を取る。緯度をそのまま平均すると
 * 高緯度ほど中心がずれるため、図法を通した後の値で計算する必要がある。
 *
 * ズームは「地点の広がりが表示領域に収まる最大」を選ぶ。1 段階ごとに
 * 縮尺が 2 倍になるので、対数から求めて切り捨てる。
 */
export function fitViewToIssues(issues: readonly Located[]): MapView {
	if (issues.length === 0) return FALLBACK_VIEW;

	// ズーム 0（世界が 1 枚のタイル）を基準に範囲を取る。この空間での
	// 距離はズームに依らないので、後から縮尺だけを掛ければよい
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for (const issue of issues) {
		const x = longitudeToTileX(issue.longitude, 0);
		// `latitudeToTileY` が極を図法の限界へ丸めてくれるので、
		// 極点の Issue（スキーマ上そのまま起票できる）でも発散しない
		const y = latitudeToTileY(issue.latitude, 0);
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}

	const centerX = (minX + maxX) / 2;
	const centerY = (minY + maxY) / 2;

	// 広がりが 0（1 件だけ、または全部同じ座標）なら対数が発散する。
	// 収まるズームという概念が無いので、決め打ちの縮尺を使う
	const spanX = maxX - minX;
	const spanY = maxY - minY;
	const zoom =
		spanX <= 0 && spanY <= 0 ? SINGLE_POINT_ZOOM : fitZoom(spanX, spanY);

	return {
		centerLatitude: tileYToLatitude(centerY, 0),
		centerLongitude: tileXToLongitude(centerX, 0),
		zoom,
	};
}

/**
 * ズーム 0 での広がり（タイル数）から、表示領域に収まる最大のズームを求める。
 *
 * ズームが 1 上がるとタイル座標は 2 倍になるので、必要な px は
 * `span * TILE_SIZE * 2^zoom`。これが表示領域以下になる最大の zoom を取る。
 *
 * 端に寄り切った地点がマーカーごと切れないよう、表示領域を少し狭く見積もる。
 */
function fitZoom(spanX: number, spanY: number): number {
	/** マーカーが端で切れないための余白（px、片側）。 */
	const PADDING = 48;
	const usableWidth = Math.max(1, MAP_VIEW_WIDTH - PADDING * 2);
	const usableHeight = Math.max(1, MAP_VIEW_HEIGHT - PADDING * 2);

	// 片方の広がりが 0 でも、もう片方で決まる。両方 0 の場合は
	// 呼び出し側が既に弾いている
	const zoomX =
		spanX > 0
			? Math.log2(usableWidth / (spanX * TILE_SIZE))
			: Number.POSITIVE_INFINITY;
	const zoomY =
		spanY > 0
			? Math.log2(usableHeight / (spanY * TILE_SIZE))
			: Number.POSITIVE_INFINITY;

	// 縦横のどちらもはみ出さないよう、厳しい方に合わせる
	const zoom = Math.min(zoomX, zoomY);
	// 両方 Infinity にはならないが、片方だけなら min が有限になる。
	// 念のため `clampMapZoom` が NaN/Infinity を既定へ倒す
	return clampMapZoom(Math.floor(zoom));
}

/**
 * 緯度経度を、表示領域の中の px 座標へ写す。
 *
 * 視界の中心が表示領域の中央に来るようにした上での相対位置。
 * 戻り値が表示領域の外（負や幅より大きい）になることはあり得る
 * （パンして視界を動かせば、映っていない地点が出る）。
 */
export function projectToView(
	latitude: number,
	longitude: number,
	view: MapView,
): { x: number; y: number } {
	const centerX = longitudeToTileX(view.centerLongitude, view.zoom);
	const centerY = latitudeToTileY(view.centerLatitude, view.zoom);
	const pointX = longitudeToTileX(longitude, view.zoom);
	const pointY = latitudeToTileY(latitude, view.zoom);

	return {
		x: MAP_VIEW_WIDTH / 2 + (pointX - centerX) * TILE_SIZE,
		y: MAP_VIEW_HEIGHT / 2 + (pointY - centerY) * TILE_SIZE,
	};
}

/**
 * タイル座標 X を経度へ戻す。`longitudeToTileX` の逆。
 *
 * 中心を求めるのに、タイル座標の空間で平均を取ってから緯度経度へ
 * 戻す必要があるため（緯度をそのまま平均すると図法の歪みで中心がずれる）。
 */
export function tileXToLongitude(x: number, zoom: number): number {
	return (x / 2 ** zoom) * 360 - 180;
}

/** タイル座標 Y を緯度へ戻す。`latitudeToTileY` の逆（Web Mercator）。 */
export function tileYToLatitude(y: number, zoom: number): number {
	const n = Math.PI - 2 * Math.PI * (y / 2 ** zoom);
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
