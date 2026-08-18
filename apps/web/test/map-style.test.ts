/**
 * MapLibre のスタイル組み立て（#118）のテスト。
 *
 * `#113`（PR #117）まで、地図はラスタタイルを `<img>` で並べて描いていた。
 * `#115` で本番の配信元を選ぼうとした結果、**ラスタタイルのまま使える
 * 選択肢が無かった**（OSM 公式はポリシー上ブラウザから直接叩けず、
 * 無料枠のある商用サービスはいずれも商用利用不可）。残ったのが
 * Protomaps を自前配信する道で、これはベクタタイル（PMTiles）である。
 *
 * そこで描画を MapLibre GL JS へ移す。MapLibre は「スタイル」という
 * JSON を食って地図を描くので、**環境変数の 1 本の URL から
 * そのスタイルをどう組み立てるか**がこの差し替えの中心になる。
 *
 * 組み立てを純粋な関数に切り出しているのは、地図そのものが WebGL を要求し
 * `bun test`（DOM 無し）では描けないため。**描けない部分を理由に
 * 何も検証しない状態にはしない。** スタイルが間違っていれば地図は
 * 「出るが真っ白」「別の場所が出る」という壊れ方をするので、
 * ここが実質的な検証点になる。
 */

import { describe, expect, it } from "bun:test";
import {
	buildMapStyle,
	classifyTileSource,
	PMTILES_PROTOCOL,
} from "../src/lib/map-style";
import { buildViewQuery } from "../src/lib/map-view";

const PMTILES_URL = "https://tiles.example.com/japan.pmtiles";
const STYLE_JSON_URL = "https://tiles.example.com/style.json";
const RASTER_TEMPLATE = "https://tile.example.com/{z}/{x}/{y}.png";
const ATTRIBUTION = "© OpenStreetMap contributors";

describe("配信元の種類を見分ける", () => {
	/*
	 * `#115` の結論である Protomaps は PMTiles を配る。MapLibre から見ると
	 * `pmtiles://` プロトコルを登録して初めて読める形式なので、
	 * 素の URL と同じ扱いにはできない
	 */
	it("拡張子 .pmtiles は PMTiles として扱う", () => {
		expect(classifyTileSource(PMTILES_URL)).toBe("pmtiles");
	});

	/*
	 * 配信元がスタイル JSON ごと配っている場合（Protomaps の
	 * basemaps や商用サービスの多く）は、こちらで組み立てず
	 * そのまま渡すのが正しい。勝手に組み立てると配信元が意図した
	 * 配色やラベルが全部落ちる
	 */
	it("拡張子 .json はスタイル JSON として扱う", () => {
		expect(classifyTileSource(STYLE_JSON_URL)).toBe("style");
	});

	/*
	 * `{z}/{x}/{y}` の形は #63 から使ってきたラスタタイルのテンプレート。
	 * `.env.local.example` が開発用に OSM の公開タイルを案内しており、
	 * 既に手元で設定している人がいる。ベクタへ移ったからといって
	 * その設定を黙って壊さない（MapLibre はラスタも描ける）
	 */
	it("{z}/{x}/{y} を含む URL はラスタタイルとして扱う", () => {
		expect(classifyTileSource(RASTER_TEMPLATE)).toBe("raster");
	});

	/*
	 * クエリ文字列が付いた URL は実在する（API キーを載せる配信元）。
	 * 拡張子の判定がクエリで壊れると、PMTiles をラスタと誤認して
	 * 「地図が真っ白」になる
	 */
	it("クエリ文字列が付いていても拡張子で判定できる", () => {
		expect(classifyTileSource(`${PMTILES_URL}?v=2`)).toBe("pmtiles");
		expect(classifyTileSource(`${STYLE_JSON_URL}?key=abc`)).toBe("style");
	});

	/*
	 * 判定できない値を「たぶんラスタ」と決め打つと、設定を打ち間違えた人が
	 * 真っ白な地図を見て原因を掴めない。分からないものは分からないと返し、
	 * 呼び出し側が地図を出さない側へ倒せるようにする
	 */
	it("どれとも判別できない値は unknown を返す", () => {
		expect(classifyTileSource("https://tiles.example.com/tiles")).toBe(
			"unknown",
		);
		expect(classifyTileSource("")).toBe("unknown");
	});
});

describe("スタイルの組み立て", () => {
	/*
	 * PMTiles は `pmtiles://` を前に付けた URL で参照する。この接頭辞が
	 * 無いと MapLibre は素の HTTP リクエストとしてアーカイブ全体を
	 * 取りに行き、地図が出ない（PMTiles は Range リクエストで
	 * 部分取得する形式なので、プロトコルの登録が要る）
	 */
	it("PMTiles はソースの URL に pmtiles:// を付ける", () => {
		const style = buildMapStyle(PMTILES_URL, ATTRIBUTION);
		expect(style).not.toBeNull();

		const source = style?.sources.basemap;
		expect(source?.url).toBe(`${PMTILES_PROTOCOL}//${PMTILES_URL}`);
	});

	/*
	 * PMTiles（Protomaps）が配るのはベクタタイル。`type: "raster"` で
	 * 読むと、ベクタのバイナリを画像として解釈しようとして何も描けない
	 */
	it("PMTiles はベクタソースとして読む", () => {
		const style = buildMapStyle(PMTILES_URL, ATTRIBUTION);
		expect(style?.sources.basemap?.type).toBe("vector");
	});

	/*
	 * ベクタタイルは「タイルの中身をどう描くか」を全部スタイルが決める。
	 * レイヤが 1 枚も無ければ、タイルは取れているのに画面は真っ白になる。
	 * 少なくとも背景・陸地・水域・道路が要る（そこまで無いと
	 * 「地図らしい絵」にならない）
	 */
	it("PMTiles には描画レイヤが付く（真っ白にならない）", () => {
		const style = buildMapStyle(PMTILES_URL, ATTRIBUTION);
		const layers = style?.layers ?? [];

		expect(layers.length).toBeGreaterThan(1);
		// 背景以外のレイヤは、必ずソースを指していなければ何も描かない
		for (const layer of layers) {
			if (layer.type === "background") continue;
			expect(layer.source, `${layer.id} がソースを指していない`).toBe(
				"basemap",
			);
			expect(
				layer["source-layer"],
				`${layer.id} が source-layer を指していない`,
			).toBeTruthy();
		}
	});

	/*
	 * レイヤ ID は MapLibre の中で一意でなければならない。重複すると
	 * スタイルの読み込みそのものが失敗する（地図が出ない）
	 */
	it("レイヤ ID が重複しない", () => {
		const layers = buildMapStyle(PMTILES_URL, ATTRIBUTION)?.layers ?? [];
		const ids = layers.map((layer) => layer.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	/*
	 * 従来のラスタ設定でも地図が出ること。`.env.local.example` の案内で
	 * OSM を設定している手元の環境を壊さない
	 */
	it("ラスタテンプレートはラスタソースとして読む", () => {
		const style = buildMapStyle(RASTER_TEMPLATE, ATTRIBUTION);
		expect(style?.sources.basemap?.type).toBe("raster");
		expect(style?.sources.basemap?.tiles).toEqual([RASTER_TEMPLATE]);
		// ラスタは 1 枚のレイヤで全面を覆う
		expect(style?.layers.some((layer) => layer.type === "raster")).toBe(true);
	});

	/*
	 * 帰属表示は配信元の利用条件。MapLibre はソースの `attribution` を
	 * 読んで地図の隅に出すので、そこへ渡す必要がある。
	 * ここが抜けると規約違反になる（#63 から一貫した要件）
	 */
	it("帰属表示をソースへ渡す", () => {
		for (const url of [PMTILES_URL, RASTER_TEMPLATE]) {
			const style = buildMapStyle(url, ATTRIBUTION);
			expect(style?.sources.basemap?.attribution, `${url} で帰属が落ちた`).toBe(
				ATTRIBUTION,
			);
		}
	});

	/*
	 * スタイル JSON はこちらで組み立てない。組み立ててしまうと配信元が
	 * 用意した内容を捨てることになる。null を返して「URL をそのまま
	 * MapLibre に渡せ」と呼び出し側へ伝える
	 */
	it("スタイル JSON の URL は組み立てず null を返す", () => {
		expect(buildMapStyle(STYLE_JSON_URL, ATTRIBUTION)).toBeNull();
	});

	/*
	 * 未設定のときに地図を出さないのは #63 から続く判断で、この Issue でも
	 * 維持することが受け入れ条件に入っている。組み立て側でも null を返し、
	 * 「適当な既定の配信元」を焼き込まない
	 */
	it("未設定・判別できない値ではスタイルを組み立てない", () => {
		expect(buildMapStyle(null, ATTRIBUTION)).toBeNull();
		expect(buildMapStyle("", ATTRIBUTION)).toBeNull();
		expect(buildMapStyle("https://tiles.example.com/tiles", ATTRIBUTION)).toBe(
			null,
		);
	});

	/*
	 * 帰属表示が未設定でも地図自体は描ける（自前配信で帰属が不要な
	 * 場合がある）。`attribution: null` を文字列 "null" として
	 * 埋め込まないことを見る
	 */
	it("帰属表示が無くてもスタイルは成立する", () => {
		const style = buildMapStyle(PMTILES_URL, null);
		expect(style).not.toBeNull();
		expect(style?.sources.basemap?.attribution).toBeUndefined();
	});
});

/**
 * URL への視界の反映（#118）。
 *
 * MapLibre へ移るとドラッグとホイールで地図が動くが、それだけだと
 * 「いま見ている場所」を人に渡せない。**URL で共有・ブックマークできる
 * 性質を失わないこと**が #118 の受け入れ条件なので、動かし終えたときに
 * URL を書き換える。その組み立てをここで見る。
 *
 * 組み立てが壊れる形は「地図は動くが URL が変わらない」「動かすたびに
 * 絞り込みが外れる」で、どちらも地図そのものは正しく描かれるため
 * 目視では気付きにくい。
 */
describe("視界を URL のクエリへ載せる", () => {
	const view = {
		centerLatitude: 35.681236,
		centerLongitude: 139.767125,
		zoom: 12,
	};

	it("中心とズームをクエリに載せる", () => {
		const query = new URLSearchParams(
			buildViewQuery(new URLSearchParams(), view),
		);
		expect(query.get("zoom")).toBe("12");
		expect(Number(query.get("lat"))).toBeCloseTo(35.681236, 3);
		expect(Number(query.get("lng"))).toBeCloseTo(139.767125, 3);
	});

	/*
	 * 地図を動かすたびに絞り込みが外れると、絞り込んだ状態で少し
	 * ドラッグした瞬間に全件へ戻る。ページ側のリンク（`map-controls`）は
	 * 既にこれを守っているので、ドラッグ経由でだけ外れる状態を作らない
	 */
	it("絞り込みの条件を落とさない", () => {
		const query = new URLSearchParams(
			buildViewQuery(
				new URLSearchParams({ scope: "national", category: "道路・交通" }),
				view,
			),
		);
		expect(query.get("scope")).toBe("national");
		expect(query.get("category")).toBe("道路・交通");
	});

	/*
	 * 地図はページを送らない。一覧から `offset` を引き継いだまま
	 * 地図を動かすと、意味の無いクエリが URL に残り続ける
	 * （ページ側の `buildMapHref` と同じ扱いに揃える）
	 */
	it("一覧用のページ送りは落とす", () => {
		const query = new URLSearchParams(
			buildViewQuery(new URLSearchParams({ offset: "40" }), view),
		);
		expect(query.get("offset")).toBeNull();
	});

	/*
	 * 既に視界が載っている URL から動かしたとき、古い値が残ると
	 * `lat` が 2 つ並んだ URL になり、どちらが読まれるか分からなくなる
	 */
	it("前の視界を積み増さず置き換える", () => {
		const query = new URLSearchParams(
			buildViewQuery(
				new URLSearchParams({ zoom: "3", lat: "0", lng: "0" }),
				view,
			),
		);
		expect(query.getAll("lat").length).toBe(1);
		expect(query.getAll("zoom").length).toBe(1);
		expect(query.get("zoom")).toBe("12");
	});

	/*
	 * 桁を落とさずに載せると URL が読めない長さになり、ドラッグの
	 * たびに末尾の桁だけが変わる（ページ側の `buildMapHref` と同じ理由）
	 */
	it("緯度経度の桁を落とす", () => {
		const query = new URLSearchParams(
			buildViewQuery(new URLSearchParams(), {
				centerLatitude: 35.68123612345,
				centerLongitude: 139.76712598765,
				zoom: 12,
			}),
		);
		expect(query.get("lat")).toBe("35.6812");
		expect(query.get("lng")).toBe("139.7671");
	});
});
