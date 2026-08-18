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
 * MapLibre のワーカーの置き場所。
 *
 * `scripts/copy-map-worker.ts` が `public/maplibre/` へ複製したものを指す。
 * ワーカーは同じディレクトリの `maplibre-gl-shared.mjs` を相対で import するため、
 * 2 つは必ず同じ場所に置かれている必要がある。
 */
const MAP_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";

/** スタイルの中でベースマップのソースに付ける名前（`lib/map-style.ts` と揃える）。 */
const BASEMAP_SOURCE_ID = "basemap";

/**
 * タイルの読み込みが止まったとみなすまでの時間。
 *
 * 実測では数百 ms で読み終わる。長めに取っているのは、遅い回線を
 * 異常として報告しないため。
 */
const STALL_TIMEOUT_MS = 15_000;

/**
 * ワーカーの置き場所を設定済みか。
 *
 * `setWorkerUrl` もグローバルへの設定なので、登録と同じく 1 回で済ませる。
 */
let workerUrlConfigured = false;

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

		// **ワーカーの置き場所を明示する。**
		//
		// MapLibre は自分のモジュールの隣に `maplibre-gl-worker.mjs` がある前提で
		// URL を組み立てるが、バンドラはファイル名にハッシュを付けて別の場所へ
		// 置くため、その URL は 404 になる。
		//
		// **バンドラに解決させる方法（`new URL(..., import.meta.url)`）では足りない。**
		// ワーカー自体はハッシュ付きで出力されるが、その中にある
		// `import "./maplibre-gl-shared.mjs"` までは解決されず、依存が 404 になる。
		//
		// そのため `scripts/copy-map-worker.ts` がワーカーと依存を素のまま
		// `public/maplibre/` へ複製し、そこを指す（`dev` と `build` の前に走る）。
		//
		// **起動に失敗しても MapLibre の `error` には乗らない。** ワーカーが無いまま
		// 地図は生成され、タイルを 1 枚も処理できずに描画が一度も走らない
		// （canvas は完全に空のまま、背景レイヤの色すら出ない）。#127 はこれだった。
		if (!workerUrlConfigured) {
			maplibre.setWorkerUrl(MAP_WORKER_URL);
			workerUrlConfigured = true;
		}

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
		//
		// **どこで失敗したかまで出す理由。** `error` だけでは
		// 「Failed to fetch」のような一行しか残らず、どのソースの・どの URL が
		// 落ちたのかが分からない。PMTiles は 1 つの URL に Range で何度も
		// 取りに行くので、失敗した資源を特定できないと配信元の設定と
		// スタイルの誤りを切り分けられない。
		map.on("error", (event) => {
			const error = event.error;
			// AJAXError は status / url を持つ。それ以外は message だけのことが多い
			const detail: Record<string, unknown> = {
				message: error?.message ?? String(error),
			};
			// `sourceId` はタイル読み込みの失敗にだけ付く。型には出ていないので
			// 取り出せたときだけ載せる
			const sourceId = (event as unknown as Record<string, unknown>).sourceId;
			if (typeof sourceId === "string") detail.sourceId = sourceId;
			for (const key of ["status", "statusText", "url"] as const) {
				const value = (
					error as unknown as Record<string, unknown> | undefined
				)?.[key];
				if (value !== undefined) detail[key] = value;
			}
			console.error("[map] 読み込みに失敗しました", detail, error);
		});

		// **エラーが出ないまま地図が白いことがある。**
		//
		// #127 がそれだった。ワーカーが起動できないと MapLibre は例外も
		// `error` イベントも出さず、タイルを 1 枚も処理しないまま静かに止まる。
		// 何も出ないので「正常に描けている」と見分けがつかない。
		//
		// 一定時間たってもソースが読み終わらなければ、それを知らせる。
		// 正常なときは何も出さない（毎回ログが並ぶと、本当の異常が埋もれる）。
		const stallTimer = setTimeout(() => {
			if (
				map.getSource(BASEMAP_SOURCE_ID) &&
				!map.isSourceLoaded(BASEMAP_SOURCE_ID)
			) {
				console.error(
					`[map] ${STALL_TIMEOUT_MS / 1000} 秒たってもタイルを読み終えていません。` +
						"ワーカー（/maplibre/maplibre-gl-worker.mjs とその依存）が読めているか、" +
						"配信元とその CORS 設定を確認してください（#127）",
				);
			}
		}, STALL_TIMEOUT_MS);
		map.once("idle", () => clearTimeout(stallTimer));

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

		return {
			// 破棄したあとに検知が走ると、消えた地図を「止まっている」と
			// 誤って報告することになる。タイマーも一緒に止める
			remove: () => {
				clearTimeout(stallTimer);
				map.remove();
			},
			getView,
		};
	} catch (error) {
		// WebGL が使えない、スタイルが読めないなど。地図が出ないだけに留める。
		// ただし黙って消さない。原因が分からないまま「白い地図」だけが
		// 残ると、配信元の設定ミスと端末の非対応を区別できない
		console.error("[map] 生成に失敗しました", error);
		return null;
	}
}
