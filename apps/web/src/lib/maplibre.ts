/**
 * MapLibre GL JS の生成を 1 箇所に閉じ込める（#118）。
 *
 * **なぜラッパを挟むか。**
 *
 * 1. **PMTiles のプロトコル登録がプロセスに 1 回で済む。** `pmtiles://` は
 *    MapLibre のグローバルに登録する形なので、部品ごとに登録すると
 *    二重登録になる。ここで 1 回だけ行う
 * 2. **動的 import で初期表示から外す。** MapLibre は数百 KB あり、
 *    静的に import すると地図を見ない利用者にも配られる。地図を描く
 *    ときだけ取りに行く
 * 3. **取り込み口が 1 つになる。** 部品側が `maplibre-gl` を直接
 *    import しないので、依存の差し替えや初期化の変更がここに閉じる
 *
 * MapLibre は WebGL を要求するので `bun test`（DOM 無し）では動かない。
 * **検証できる部分をここから外に出してある**（スタイルの組み立ては
 * `lib/map-style.ts`、渡す設定は `lib/map-options.ts`、視界の計算は
 * `lib/map-view.ts`）。ここに残るのはライブラリを呼ぶ手続きだけで、
 * 判断を含む処理を置かないようにしている。
 */

import type { MapStyle } from "./map-style";

/** 地図に置く 1 件のマーカー。 */
export type MapMarker = {
	longitude: number;
	latitude: number;
	/**
	 * マーカーとして置く DOM 要素。指定しなければ MapLibre の既定のピン。
	 * 一覧の地図はリンクを置くのでこちらを使う（点が光るだけでは
	 * 「何が起きているか」まで辿れない）
	 */
	element?: HTMLElement;
};

/** 生成した地図のうち、呼び出し側が使う操作だけを表に出す。 */
export type MapHandle = {
	/** 破棄する。React の cleanup から呼ぶ */
	remove: () => void;
	/** いまの中心とズーム。`onMoveEnd` の中で読む */
	getView: () => { latitude: number; longitude: number; zoom: number };
};

export type CreateMapOptions = {
	container: HTMLElement;
	/** 組み立てたスタイル、またはスタイル JSON の URL（`lib/map-style.ts`） */
	style: MapStyle | string;
	/** [経度, 緯度]。MapLibre はこの順（GeoJSON に合わせている） */
	center: [number, number];
	zoom: number;
	/** 触って動かせるか。1 件を示すだけの地図では切る */
	interactive?: boolean;
	/** 1 件だけ置く場合。複数なら `markers` を使う */
	marker?: MapMarker;
	markers?: readonly MapMarker[];
	/** ズームの下限・上限。URL から来る値と揃える */
	minZoom?: number;
	maxZoom?: number;
	/** 操作が終わったときに呼ぶ。`/map` が URL を同期するのに使う */
	onMoveEnd?: (view: {
		latitude: number;
		longitude: number;
		zoom: number;
	}) => void;
};

/**
 * PMTiles のプロトコルを登録済みか。
 *
 * MapLibre の `addProtocol` はグローバルへの登録で、同じ名前で 2 回呼ぶと
 * 後の登録が前を上書きする。部品が複数あっても 1 回で済ませる
 */
let protocolRegistered = false;

/**
 * 地図を作る。
 *
 * 失敗しても例外を投げずに null を返す。WebGL が使えない環境（古い端末、
 * ソフトウェア描画を切っている設定）は実在し、そこで例外を投げると
 * **地図が出ないだけで済むはずが、詳細ページ全体が壊れる**。
 * 呼び出し側は地図の箱と帰属表示を既に描いているので、null でも
 * 画面としては成立する。
 */
export async function createMap(
	options: CreateMapOptions,
): Promise<MapHandle | null> {
	try {
		const maplibre = await import("maplibre-gl");

		// `pmtiles://` は PMTiles を使うときだけ要るが、スタイルの中身を
		// 見て分岐するより、常に登録しておく方が単純で副作用も無い
		// （そのプロトコルの URL が現れなければ呼ばれない）
		if (!protocolRegistered) {
			const { Protocol } = await import("pmtiles");
			maplibre.addProtocol("pmtiles", new Protocol().tile);
			protocolRegistered = true;
		}

		const map = new maplibre.Map({
			container: options.container,
			// 型は MapLibre の `StyleSpecification`。こちらは必要な部分だけを
			// 持つ形（`MapStyle`）で組み立てているので、ここで受け渡す
			style: options.style as never,
			center: options.center,
			zoom: options.zoom,
			interactive: options.interactive ?? true,
			minZoom: options.minZoom,
			maxZoom: options.maxZoom,
			// 帰属表示は隠さないことが配信元の利用条件に含まれる。
			// 折りたたませない（既定は狭い画面で畳まれる）
			attributionControl: { compact: false },
		});

		// **MapLibre の失敗は例外では飛んでこない。** スタイルやタイルの
		// 読み込みに失敗しても `error` イベントとして通知されるだけなので、
		// 下の try/catch（コンストラクタしか守れない）には届かない。
		// 購読しないと「地図は白いがコンソールに何も出ない」状態になり、
		// 配信元・CORS・スタイルのどれが原因かを切り分ける手がかりが消える。
		map.on("error", (event) => {
			console.error("[map] 読み込みに失敗しました", event.error ?? event);
		});

		if (options.interactive !== false) {
			// 拡大・縮小のボタン。ドラッグとホイールだけだと、
			// タッチ端末以外のポインタ操作で縮尺を変えづらい
			map.addControl(new maplibre.NavigationControl({ showCompass: false }));
		}

		const all = options.markers ?? (options.marker ? [options.marker] : []);
		for (const marker of all) {
			new maplibre.Marker(
				marker.element ? { element: marker.element } : undefined,
			)
				.setLngLat([marker.longitude, marker.latitude])
				.addTo(map);
		}

		const getView = () => {
			const center = map.getCenter();
			return {
				latitude: center.lat,
				longitude: center.lng,
				zoom: map.getZoom(),
			};
		};

		if (options.onMoveEnd) {
			const handler = options.onMoveEnd;
			map.on("moveend", () => handler(getView()));
		}

		return { remove: () => map.remove(), getView };
	} catch (error) {
		// WebGL が使えない、スタイルが読めないなど。地図が出ないだけに留める。
		// ただし黙って消さない。原因が分からないまま「白い地図」だけが
		// 残ると、配信元の設定ミスと端末の非対応を区別できない
		console.error("[map] 生成に失敗しました", error);
		return null;
	}
}
