/**
 * MapLibre GL JS に渡すスタイルの組み立て（#118）。
 *
 * `#113` まで地図はラスタタイルを `<img>` で並べて描いていた。`#115` で
 * 本番の配信元を選ぼうとした結果、**ラスタタイルのまま使える選択肢が
 * 無かった**（OSM 公式はポリシーが独自 User-Agent を要求するがブラウザの
 * `<img>` には設定できず、無料枠のある商用サービスはいずれも商用利用不可）。
 * 残ったのが Protomaps を自前配信する道で、これはベクタタイル（PMTiles）
 * である。そのため描画を MapLibre へ移した。
 *
 * MapLibre は「スタイル」という JSON を食って地図を描く。環境変数として
 * 持っているのは URL 1 本なので、そこからスタイルを組み立てるのがここの役目。
 *
 * **描画から切り離して純粋な関数にしている理由。** 地図そのものは WebGL を
 * 要求するので `bun test`（DOM 無し）では描けない。描けないことを理由に
 * 何も検証しない状態にすると、スタイルの間違い（＝地図が真っ白、別の場所が
 * 出る、帰属が落ちる）が誰にも見つからないまま本番へ出る。組み立てを
 * ここへ寄せることで、実質的な部分をテストできる形にしている。
 */

/** PMTiles を MapLibre から参照するときの接頭辞。`pmtiles.Protocol` が受け取る */
export const PMTILES_PROTOCOL = "pmtiles:";

/**
 * 設定された URL が何を指しているか。
 *
 * - `pmtiles` — PMTiles のアーカイブ（`#115` が選んだ Protomaps の配信形式）
 * - `style`  — MapLibre のスタイル JSON。配信元が用意したものをそのまま使う
 * - `raster` — 従来のラスタタイルのテンプレート（`{z}/{x}/{y}`）
 * - `unknown` — 判別できない。地図を出さない側へ倒す
 */
export type TileSourceKind = "pmtiles" | "style" | "raster" | "unknown";

/** MapLibre のソース定義のうち、ここで組み立てる分だけを表す形。 */
export type MapStyleSource = {
	type: "vector" | "raster";
	/** PMTiles / TileJSON を 1 本の URL で指す場合 */
	url?: string;
	/** ラスタタイルのテンプレートを直接並べる場合 */
	tiles?: readonly string[];
	tileSize?: number;
	maxzoom?: number;
	/** 配信元が要求する帰属表示。MapLibre が地図の隅に出す */
	attribution?: string;
};

/** MapLibre のレイヤ定義のうち、ここで組み立てる分だけを表す形。 */
export type MapStyleLayer = {
	id: string;
	type: "background" | "fill" | "line" | "raster";
	source?: string;
	"source-layer"?: string;
	filter?: unknown[];
	paint?: Record<string, unknown>;
};

/** 組み立てたスタイル。MapLibre の `StyleSpecification` の部分集合。 */
export type MapStyle = {
	version: 8;
	sources: Record<string, MapStyleSource | undefined>;
	layers: MapStyleLayer[];
};

/** スタイルの中でベースマップのソースに付ける名前。レイヤから参照する */
const SOURCE_ID = "basemap";

/**
 * 設定された URL が何を指しているかを見分ける。
 *
 * 拡張子で判定するのは、URL の形からしか判断できないため（配信元へ
 * 問い合わせて確かめる余地は描画の前には無い）。クエリ文字列を落として
 * から見るのは、API キーを載せる配信元があるため。`?key=...` が付いた
 * だけで PMTiles をラスタと誤認すると、地図が真っ白になる。
 *
 * 判別できない値を「たぶんラスタ」と決め打たない。打ち間違えた人が
 * 真っ白な地図の原因を掴めなくなるより、地図を出さない方が分かりやすい。
 */
export function classifyTileSource(url: string): TileSourceKind {
	// `{z}` などを含む値は URL として解釈できないので、素朴に切る。
	// `new URL()` に通すとテンプレートの `{}` で例外になる
	const withoutQuery = url.split(/[?#]/)[0] ?? "";

	if (withoutQuery.endsWith(".pmtiles")) return "pmtiles";
	if (withoutQuery.endsWith(".json")) return "style";
	// タイル座標のテンプレート。`{s}` を使う配信元もあるが、
	// 必須なのは z/x/y の 3 つ
	if (
		withoutQuery.includes("{z}") &&
		withoutQuery.includes("{x}") &&
		withoutQuery.includes("{y}")
	) {
		return "raster";
	}
	return "unknown";
}

/**
 * 設定された URL と帰属表示から、MapLibre のスタイルを組み立てる。
 *
 * `null` を返すのは次の場合で、いずれも「こちらでスタイルを作らない」を意味する:
 *
 * - 未設定（`#63` から続く「配信元が無ければ地図を出さない」の維持）
 * - 判別できない値
 * - **スタイル JSON の URL** — この場合だけは呼び出し側が URL をそのまま
 *   MapLibre へ渡す。配信元が用意した配色やラベルを、こちらの素朴な
 *   組み立てで捨ててしまわないため（`resolveMapStyle` が振り分ける）
 */
export function buildMapStyle(
	url: string | null,
	attribution: string | null,
): MapStyle | null {
	if (!url) return null;

	const kind = classifyTileSource(url);
	const source = buildSource(kind, url, attribution);
	if (!source) return null;

	return {
		version: 8,
		sources: { [SOURCE_ID]: source },
		layers: kind === "raster" ? RASTER_LAYERS : VECTOR_LAYERS,
	};
}

/** 種類ごとのソース定義。組み立てない種類（`style` / `unknown`）は null */
function buildSource(
	kind: TileSourceKind,
	url: string,
	attribution: string | null,
): MapStyleSource | null {
	// 帰属が未設定なら、キーごと落とす。`attribution: null` を渡すと
	// MapLibre が文字列として扱い、地図の隅に "null" が出る
	const withAttribution = attribution ? { attribution } : {};

	switch (kind) {
		case "pmtiles":
			return {
				type: "vector",
				// PMTiles は Range リクエストで部分取得する形式で、素の HTTP
				// として取りに行くとアーカイブ全体を落とそうとして地図が出ない。
				// `pmtiles://` を前に付けて、登録したプロトコルへ回す
				url: `${PMTILES_PROTOCOL}//${url}`,
				...withAttribution,
			};
		case "raster":
			return {
				type: "raster",
				tiles: [url],
				tileSize: 256,
				...withAttribution,
			};
		default:
			return null;
	}
}

/**
 * ベクタタイルの描画レイヤ。
 *
 * ベクタタイルは「タイルの中身をどう描くか」を全部スタイルが決める。
 * レイヤが 1 枚も無ければ、タイルは取れているのに画面は真っ白になる。
 *
 * `source-layer` の名前は Protomaps の basemap スキーマに従う
 * （https://docs.protomaps.com/basemaps/layers）。
 *
 * **ラベル（地名・道路名）を入れていない理由。** テキストの描画には
 * グリフ（フォント）の配信元が別に要る。それも自前で用意しないと
 * 文字が 1 つも出ないうえ、外部の配信元を焼き込むと `#115` で避けたのと
 * 同じ「規約の分からない依存」を作ることになる。この Issue の受け入れ条件は
 * 「地図が MapLibre で描かれていること」なので、まず地形だけで成立させる。
 * ラベルは PMTiles の準備（`#115`）でグリフの置き場が決まってから足せる。
 *
 * 色は `globals.css` のトークンに合わせず直値で書いている。MapLibre は
 * WebGL で描くので CSS 変数を読めない（`var(--...)` を渡しても解決されない）。
 */
const VECTOR_LAYERS: MapStyleLayer[] = [
	{
		id: "background",
		type: "background",
		paint: { "background-color": "#f5f3ee" },
	},
	{
		id: "earth",
		type: "fill",
		source: SOURCE_ID,
		"source-layer": "earth",
		paint: { "fill-color": "#eae7df" },
	},
	{
		id: "landuse",
		type: "fill",
		source: SOURCE_ID,
		"source-layer": "landuse",
		paint: { "fill-color": "#e3e8dd" },
	},
	{
		id: "water",
		type: "fill",
		source: SOURCE_ID,
		"source-layer": "water",
		paint: { "fill-color": "#b9d4e8" },
	},
	{
		id: "buildings",
		type: "fill",
		source: SOURCE_ID,
		"source-layer": "buildings",
		paint: { "fill-color": "#dcd8d0" },
	},
	{
		// 細い道と幹線を同じ太さで描くと、街の骨格が読めない絵になる。
		// 種類で 2 枚に分ける
		id: "roads-minor",
		type: "line",
		source: SOURCE_ID,
		"source-layer": "roads",
		filter: ["!=", ["get", "kind"], "highway"],
		paint: { "line-color": "#ffffff", "line-width": 1 },
	},
	{
		id: "roads-major",
		type: "line",
		source: SOURCE_ID,
		"source-layer": "roads",
		filter: ["==", ["get", "kind"], "highway"],
		paint: { "line-color": "#ffd9a0", "line-width": 2 },
	},
	{
		id: "boundaries",
		type: "line",
		source: SOURCE_ID,
		"source-layer": "boundaries",
		paint: { "line-color": "#9c9c9c", "line-dasharray": [3, 2] },
	},
];

/** ラスタタイルは配信元が絵として完成させているので、1 枚で全面を覆う */
const RASTER_LAYERS: MapStyleLayer[] = [
	{ id: "basemap-raster", type: "raster", source: SOURCE_ID },
];

/**
 * MapLibre の `style` オプションへそのまま渡せる値を返す。
 *
 * スタイル JSON の URL は文字列のまま渡す（MapLibre が取りに行く）。
 * それ以外は組み立てたオブジェクトを渡す。地図を出せないときは null。
 */
export function resolveMapStyle(
	url: string | null,
	attribution: string | null,
): MapStyle | string | null {
	if (!url) return null;
	if (classifyTileSource(url) === "style") return url;
	return buildMapStyle(url, attribution);
}

/**
 * 設定された値で地図を描けるか。
 *
 * 「配信元が未設定なら地図を出さない」（`#63` から続く判断で、`#118` の
 * 受け入れ条件にも入っている）を、判別できない値まで広げたもの。
 * 呼び出し側は描画の前にこれで分岐する。
 */
export function canRenderMap(url: string | null): boolean {
	return url !== null && classifyTileSource(url) !== "unknown";
}
