/**
 * MapLibre に渡す地図の設定を組み立てる（#118）。
 *
 * **なぜ描画から切り離すか。** MapLibre は WebGL とブラウザの DOM を要求し、
 * `bun test`（DOM 無し・実描画エンジン無し）では 1 ピクセルも描けない。
 * 組み立てを `useEffect` の中に書いてしまうと、**地図に関する判断が
 * まるごとテストの外へ出る**。その状態で壊れる形は
 *
 *  - 中心を [緯度, 経度] の順で渡してしまう（MapLibre は [経度, 緯度]）
 *    → 地図は出るが、日本の Issue がインド洋に出る
 *  - マーカーを 1 件しか置いていない、あるいは 1 箇所に重ねている
 *  - 帰属表示を渡し忘れる（配信元の利用条件に違反する）
 *  - ズームが URL の値と食い違う
 *
 * のどれも「地図そのものは描かれる」ので、目視でも気付きにくい。
 * 判断をここへ寄せて、値として検査できる形にしている。
 *
 * ここが返すのは**値だけ**で、DOM も MapLibre も触らない。実際に地図を
 * 作る手続きは `lib/maplibre.ts`、スタイルの組み立ては `lib/map-style.ts`。
 */

import type { PublicIssue } from "./issues";
import { MAP_ZOOM } from "./map";
import { canRenderMap, type MapStyle, resolveMapStyle } from "./map-style";
import { MAX_MAP_ZOOM, type MapView, MIN_MAP_ZOOM } from "./map-view";

/** 地図に置く 1 件の点。DOM を作る前の、値としてのマーカー。 */
export type PlottedMarker = {
	/** 詳細ページの id。マーカーを押したときの行き先に使う */
	id: string;
	/** 読み上げ用のラベル。要素の textContent に入れる（属性へ埋めない） */
	label: string;
	latitude: number;
	longitude: number;
};

/** MapLibre に渡す設定のうち、こちらが決める分。 */
export type MapOptions = {
	/** 組み立てたスタイル、またはスタイル JSON の URL */
	style: MapStyle | string;
	/** [経度, 緯度]。**MapLibre はこの順**（GeoJSON に合わせている） */
	center: [number, number];
	zoom: number;
	minZoom: number;
	maxZoom: number;
	/** 触って動かせるか */
	interactive: boolean;
	markers: PlottedMarker[];
};

/**
 * Issue 詳細（1 件）の地図の設定。
 *
 * 動かせないようにしているのは、この画面で必要なのが「1 件がどこか」を
 * 示すことだけだから。触れると勝手に動く地図は、周囲を確認したい人の邪魔になる。
 *
 * 地図を出せないときは null（配信元が未設定・判別できない値）。
 * これは #63 から続く判断で、#118 の受け入れ条件にも入っている。
 */
export function buildDetailMapOptions(
	issue: { latitude: number; longitude: number },
	tileUrlTemplate: string | null,
	attribution: string | null,
): MapOptions | null {
	if (!canRenderMap(tileUrlTemplate)) return null;
	const style = resolveMapStyle(tileUrlTemplate, attribution);
	if (!style) return null;

	return {
		style,
		// MapLibre は [経度, 緯度]。緯度経度の順で書くのが自然な日本語の
		// 感覚と逆なので、取り違えるとまったく別の場所が出る
		center: [issue.longitude, issue.latitude],
		zoom: MAP_ZOOM,
		minZoom: MIN_MAP_ZOOM,
		maxZoom: MAX_MAP_ZOOM,
		interactive: false,
		// 1 件の位置を指すマーカーは呼び出し側が置く（既定のピンでよく、
		// 押しても行き先が無い — すでにその Issue のページにいる）
		markers: [],
	};
}

/**
 * `/map`（複数地点）の地図の設定。
 *
 * 視界は呼び出し側が渡す。URL のクエリ（zoom / lat / lng）を反映した値か、
 * 全件が収まるよう自動で決めた値かは、ページ側が決めている。
 *
 * **全件をマーカーにする。** #113 の頃は表示領域に入る分だけを描いていたが、
 * それは `<img>` を並べる方式で「見えない要素がキーボードの順路に挟まる」
 * のを避けるためだった。MapLibre は画面外のマーカーを自分で隠すので、
 * 絞り込む必要が無い。むしろ絞り込むと、地図をドラッグして画面外から
 * 入ってきた Issue のマーカーが出てこなくなる。
 */
export function buildIssuesMapOptions(
	issues: readonly PublicIssue[],
	view: MapView,
	tileUrlTemplate: string | null,
	attribution: string | null,
): MapOptions | null {
	if (!canRenderMap(tileUrlTemplate)) return null;
	const style = resolveMapStyle(tileUrlTemplate, attribution);
	if (!style) return null;

	return {
		style,
		center: [view.centerLongitude, view.centerLatitude],
		zoom: view.zoom,
		// URL から来るズームと同じ範囲に閉じる。片方だけ広いと、地図では
		// 寄れるのに URL にすると戻される、という食い違いが出る
		minZoom: MIN_MAP_ZOOM,
		maxZoom: MAX_MAP_ZOOM,
		interactive: true,
		markers: issues.map((issue) => ({
			id: issue.id,
			label: issue.title,
			latitude: issue.latitude,
			longitude: issue.longitude,
		})),
	};
}
