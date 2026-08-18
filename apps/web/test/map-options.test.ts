/**
 * MapLibre へ渡す地図の設定（#118）のテスト。
 *
 * **なぜここが検証点になるか。** #113 まで地図はラスタタイルを `<img>` で
 * 並べて描いていたので、描いた HTML を読めばマーカーの位置もタイルの
 * 番号も検査できた。#118 で MapLibre へ移ると、地図の中身は WebGL の
 * キャンバスになり、`bun test`（DOM 無し・描画エンジン無し）からは
 * 一切見えなくなる。
 *
 * **見えないことを理由に検証をやめると、以下が全部素通りする**（どれも
 * 「地図そのものは描かれる」ので目視でも気付きにくい）:
 *
 *  - 中心を [緯度, 経度] の順で渡す（MapLibre は [経度, 緯度]）
 *    → 東京の Issue がインド洋に出る
 *  - マーカーを 1 件しか置かない／全部同じ場所に重ねる
 *  - 帰属表示を渡し忘れる（配信元の利用条件に違反する）
 *  - 配信元が未設定なのに地図を作りに行く
 *
 * そこで**判断を含む部分を描画の外へ出し**（`lib/map-options.ts`）、
 * 「MapLibre に何を渡すか」を値として検査する。#113 のテストが HTML に対して
 * 見ていた不変条件を、そのままこちらへ移している。
 */

import { describe, expect, it } from "bun:test";
import type { PublicIssue } from "../src/lib/issues";
import { MAP_ZOOM } from "../src/lib/map";
import {
	buildDetailMapOptions,
	buildIssuesMapOptions,
} from "../src/lib/map-options";
import { MAX_MAP_ZOOM, MIN_MAP_ZOOM } from "../src/lib/map-view";

const TEMPLATE = "https://tiles.example.com/{z}/{x}/{y}.png";
const PMTILES = "https://tiles.example.com/japan.pmtiles";
const ATTRIBUTION = "© OpenStreetMap contributors";

/** 東京・大阪・札幌。離れた 3 点で、複数地点の扱いを見る */
const TOKYO = { latitude: 35.681236, longitude: 139.767125 };
const OSAKA = { latitude: 34.702485, longitude: 135.495951 };
const SAPPORO = { latitude: 43.068564, longitude: 141.350755 };

function issueAt(
	id: string,
	title: string,
	at: { latitude: number; longitude: number },
): PublicIssue {
	return {
		id,
		title,
		description: "説明",
		scope: "community",
		status: "open",
		latitude: at.latitude,
		longitude: at.longitude,
		category: "道路・交通",
		created_at: "2026-08-01 12:00:00.000",
		updated_at: "2026-08-01 12:00:00.000",
		has_photo: false,
		is_anonymous: true,
	};
}

const THREE_CITIES = [
	issueAt("aaaa", "東京の Issue", TOKYO),
	issueAt("bbbb", "大阪の Issue", OSAKA),
	issueAt("cccc", "札幌の Issue", SAPPORO),
];

const TOKYO_VIEW = {
	centerLatitude: TOKYO.latitude,
	centerLongitude: TOKYO.longitude,
	zoom: 12,
};

describe("Issue 詳細（1 件）の地図", () => {
	/*
	 * MapLibre の `center` は **[経度, 緯度]** の順（GeoJSON に合わせている）。
	 * 日本語で「緯度経度」と言う順とは逆なので、取り違えが起きやすい。
	 * 取り違えても地図は普通に描かれ、**まったく別の場所が映るだけ**なので、
	 * 開発中に東京の Issue を見ていて気付けるとは限らない
	 * （35.68, 139.76 を逆にするとインド洋の沖に出る）
	 */
	it("中心を [経度, 緯度] の順で渡す", () => {
		const options = buildDetailMapOptions(TOKYO, TEMPLATE, ATTRIBUTION);
		expect(options?.center).toEqual([TOKYO.longitude, TOKYO.latitude]);
	});

	/*
	 * #63 から続く縮尺。「その建物の前の通りが分かる」程度で、
	 * 街灯やごみ集積所のような近隣スコープの困りごとを指すのに合う
	 */
	it("1 件を示すのに適した縮尺を使う", () => {
		expect(buildDetailMapOptions(TOKYO, TEMPLATE, ATTRIBUTION)?.zoom).toBe(
			MAP_ZOOM,
		);
	});

	/*
	 * この画面で必要なのは「1 件がどこか」を示すことだけ。触れると
	 * 勝手に動く地図は、周囲を確認したい人の邪魔になる
	 */
	it("動かせないようにする", () => {
		expect(
			buildDetailMapOptions(TOKYO, TEMPLATE, ATTRIBUTION)?.interactive,
		).toBe(false);
	});

	/*
	 * 配信元が未設定なら地図を作りに行かない。#63 から続く判断で、
	 * #118 の受け入れ条件にも入っている。適当な既定値を焼き込むと、
	 * 設定を忘れたまま本番へ出たときに規約違反のトラフィックを出し続ける
	 */
	it("配信元が未設定なら設定を返さない", () => {
		expect(buildDetailMapOptions(TOKYO, null, ATTRIBUTION)).toBeNull();
		expect(buildDetailMapOptions(TOKYO, "", ATTRIBUTION)).toBeNull();
	});

	/*
	 * 判別できない値も同じ扱い。「たぶんラスタ」と決め打つと、打ち間違えた人が
	 * 真っ白な地図の原因を掴めない
	 */
	it("判別できない配信元でも設定を返さない", () => {
		expect(
			buildDetailMapOptions(TOKYO, "https://tiles.example.com/", ATTRIBUTION),
		).toBeNull();
	});

	/*
	 * 帰属表示は配信元の利用条件。MapLibre はスタイルのソースに書かれた
	 * `attribution` を読んで地図の隅に出すので、そこまで届いていること
	 */
	it("帰属表示がスタイルまで届く", () => {
		const style = buildDetailMapOptions(TOKYO, PMTILES, ATTRIBUTION)?.style;
		expect(typeof style, "スタイルが組み立てられていない").toBe("object");
		if (typeof style === "object") {
			expect(style?.sources.basemap?.attribution).toBe(ATTRIBUTION);
		}
	});
});

describe("/map（複数地点）の地図", () => {
	/*
	 * 全件がマーカーになるか。1 件でも落ちれば「見比べる」が成立しない。
	 * #113 のテストが HTML のマーカー数で見ていたものと同じ不変条件
	 */
	it("渡した Issue の数だけマーカーを置く", () => {
		const options = buildIssuesMapOptions(
			THREE_CITIES,
			TOKYO_VIEW,
			TEMPLATE,
			ATTRIBUTION,
		);
		expect(options?.markers.length).toBe(THREE_CITIES.length);
	});

	/*
	 * マーカーが「ある」だけでは足りない。全部が同じ座標でも数は合う。
	 * それぞれが実際の地点を指しているか、相対関係まで見る。
	 * 札幌は東京より北、大阪は東京より西かつ南
	 */
	it("マーカーが地点ごとの座標を指す", () => {
		const markers =
			buildIssuesMapOptions(THREE_CITIES, TOKYO_VIEW, TEMPLATE, ATTRIBUTION)
				?.markers ?? [];

		const byId = new Map(markers.map((marker) => [marker.id, marker]));
		const tokyo = byId.get("aaaa");
		const osaka = byId.get("bbbb");
		const sapporo = byId.get("cccc");
		expect(tokyo, "東京のマーカーが無い").toBeDefined();
		expect(osaka, "大阪のマーカーが無い").toBeDefined();
		expect(sapporo, "札幌のマーカーが無い").toBeDefined();

		// 座標がそのまま渡っていること（丸めや取り違えが無い）
		expect(tokyo?.latitude).toBeCloseTo(TOKYO.latitude, 6);
		expect(tokyo?.longitude).toBeCloseTo(TOKYO.longitude, 6);

		// 相対関係。全部同じ座標を渡す実装だとここで落ちる
		expect(
			Number(osaka?.longitude),
			"大阪が東京より西になっていない",
		).toBeLessThan(TOKYO.longitude);
		expect(
			Number(sapporo?.latitude),
			"札幌が東京より北になっていない",
		).toBeGreaterThan(TOKYO.latitude);
		expect(
			Number(osaka?.latitude),
			"大阪が東京より南になっていない",
		).toBeLessThan(TOKYO.latitude);
	});

	/*
	 * マーカーから Issue へ辿れないと、点が光るだけで終わる。
	 * 行き先の id と読み上げ用のラベルが揃っていること
	 */
	it("マーカーから Issue の詳細へ辿れる", () => {
		const markers =
			buildIssuesMapOptions(THREE_CITIES, TOKYO_VIEW, TEMPLATE, ATTRIBUTION)
				?.markers ?? [];

		for (const issue of THREE_CITIES) {
			const marker = markers.find((m) => m.id === issue.id);
			expect(marker, `${issue.title} のマーカーが無い`).toBeDefined();
			expect(marker?.label, `${issue.title} のラベルが無い`).toBe(issue.title);
		}
	});

	/*
	 * 視界（中心・ズーム）は URL のクエリから来る。読み捨てて常に
	 * 自動の視界を出すと、共有された URL を開いた人が別の場所を見る
	 */
	it("渡された視界をそのまま使う", () => {
		const options = buildIssuesMapOptions(
			THREE_CITIES,
			TOKYO_VIEW,
			TEMPLATE,
			ATTRIBUTION,
		);
		expect(options?.center).toEqual([TOKYO.longitude, TOKYO.latitude]);
		expect(options?.zoom).toBe(12);
	});

	/*
	 * ズームの範囲を URL 側と揃える。片方だけ広いと、地図では寄れるのに
	 * URL にすると戻される、という食い違いが出る
	 */
	it("ズームの範囲が URL 側の上下限と揃っている", () => {
		const options = buildIssuesMapOptions(
			THREE_CITIES,
			TOKYO_VIEW,
			TEMPLATE,
			ATTRIBUTION,
		);
		expect(options?.minZoom).toBe(MIN_MAP_ZOOM);
		expect(options?.maxZoom).toBe(MAX_MAP_ZOOM);
	});

	/*
	 * #113 と変わった点。あちらは表示領域に入る Issue だけを描いていたが、
	 * それは `<img>` を並べる方式で「見えない要素がキーボードの順路に
	 * 挟まる」のを避けるためだった。MapLibre は画面外のマーカーを
	 * 自分で隠すので、こちらで絞ると**ドラッグして画面外から入ってきた
	 * Issue のマーカーが出てこない**（地図が動く方式では退行になる）
	 */
	it("視界の外にある Issue もマーカーとして渡す", () => {
		// 東京へ大きく寄った視界。札幌は初期表示では画面の外にある
		const options = buildIssuesMapOptions(
			THREE_CITIES,
			{ ...TOKYO_VIEW, zoom: 14 },
			TEMPLATE,
			ATTRIBUTION,
		);
		expect(options?.markers.map((m) => m.id)).toContain("cccc");
	});

	it("触って動かせる", () => {
		expect(
			buildIssuesMapOptions(THREE_CITIES, TOKYO_VIEW, TEMPLATE, ATTRIBUTION)
				?.interactive,
		).toBe(true);
	});

	it("配信元が未設定なら設定を返さない", () => {
		expect(
			buildIssuesMapOptions(THREE_CITIES, TOKYO_VIEW, null, ATTRIBUTION),
		).toBeNull();
	});

	/*
	 * 0 件でも地図そのものは出す（絞り込みで 0 件になることがある）。
	 * 地図ごと消えると「絞り込んだ結果が無い」のか「地図が壊れた」のか
	 * 区別が付かない
	 */
	it("0 件でも地図の設定は返す", () => {
		const options = buildIssuesMapOptions(
			[],
			TOKYO_VIEW,
			TEMPLATE,
			ATTRIBUTION,
		);
		expect(options).not.toBeNull();
		expect(options?.markers).toEqual([]);
	});

	/*
	 * 世界の端にある Issue でも、座標が有限のまま渡ること。
	 * `CreateIssueSchema` は緯度 ±90 をそのまま許すので実際に起票できる。
	 * NaN や Infinity が混じると MapLibre がその 1 件で例外を投げ、
	 * **地図全体が出なくなる**（#113 のテストが「存在しないタイルを
	 * 要求しない」で見ていたのと同じ性質の壊れ方）
	 */
	it("世界の端にある Issue でも座標が有限のまま渡る", () => {
		const edges = [
			issueAt("n", "北の端", { latitude: 90, longitude: 180 }),
			issueAt("s", "南の端", { latitude: -90, longitude: -180 }),
		];
		const options = buildIssuesMapOptions(
			edges,
			TOKYO_VIEW,
			TEMPLATE,
			ATTRIBUTION,
		);

		for (const marker of options?.markers ?? []) {
			expect(
				Number.isFinite(marker.latitude),
				`${marker.label} の緯度が有限でない`,
			).toBe(true);
			expect(
				Number.isFinite(marker.longitude),
				`${marker.label} の経度が有限でない`,
			).toBe(true);
		}
	});

	/*
	 * タイトルは利用者が自由に書ける。マーカーのラベルへ**値として**
	 * 渡っていること（HTML の断片として組み立てていない）。
	 * 部品側は `textContent` に入れるので、値のまま渡っていれば
	 * 要素として解釈されない
	 */
	it("タイトルを加工せずラベルとして渡す", () => {
		const nasty = '"><script>alert(1)</script>';
		const options = buildIssuesMapOptions(
			[issueAt("x", nasty, TOKYO)],
			TOKYO_VIEW,
			TEMPLATE,
			ATTRIBUTION,
		);
		expect(options?.markers[0]?.label).toBe(nasty);
	});
});
