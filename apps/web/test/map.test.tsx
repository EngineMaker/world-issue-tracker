/**
 * Issue の位置を地図で示す機能（#63）のテスト。
 *
 * 起票フォームは緯度経度を必須にしているのに、それを地図で見せる画面が
 * 無かった。入力の手間だけ払わせて何も返していない状態で、ここで解消する。
 *
 * 見るのは 3 つ。
 *  1. 座標 → タイル座標の変換（`lib/map.ts`）。ここがずれると別の場所を指す
 *  2. `IssueMap` が実際にタイルとマーカーを描くか
 *  3. 詳細ページが地図を出しつつ、座標の数値も残しているか
 *     （地図が読めない状況で位置情報を失わせないため — Issue のコメント参照）
 */

// 表示言語を Cookie から読むため（Issue #82）、Server Component を直接呼ぶ
// このテストにはリクエストスコープが要る。テスト対象より先に評価させる
import "./helpers/mock-cookies";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueMap } from "../src/app/components/IssueMap";
import IssueDetailPage from "../src/app/issues/[id]/page";
import {
	latitudeToTileY,
	longitudeToTileX,
	resolveTileUrlTemplate,
} from "../src/lib/map";

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
const originalTileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL;
const originalTileAttribution = process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION;

function restoreEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv("NEXT_PUBLIC_API_URL", originalApiUrl);
	restoreEnv("NEXT_PUBLIC_MAP_TILE_URL", originalTileUrl);
	restoreEnv("NEXT_PUBLIC_MAP_TILE_ATTRIBUTION", originalTileAttribution);
});

const TOKYO = { latitude: 35.681236, longitude: 139.767125 };

const TEMPLATE = "https://tiles.example.com/{z}/{x}/{y}.png";

const sampleIssue = {
	id: "ebbcf9d7680ad57cedeeb513a90d461f",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "open",
	latitude: TOKYO.latitude,
	longitude: TOKYO.longitude,
	category: "infrastructure",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-02 09:30:00.000",
};

/** 詳細ページが必要とする 3 本の GET に、それぞれ既定の応答を返す `fetch` の代役。 */
function stubDetailFetch() {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("/comments")) {
			return Response.json({ comments: [] });
		}
		if (url.includes("/help-offers")) {
			return Response.json({ count: 0, offers: [], viewer_offered: false });
		}
		return Response.json(sampleIssue);
	}) as unknown as typeof globalThis.fetch;
}

describe("タイル座標の変換", () => {
	/*
	 * Web Mercator の基準点。ズーム 0 ではタイルが 1 枚しか無いので、
	 * 世界の中心（経度 0 / 緯度 0）はそのタイルのちょうど真ん中に来る。
	 * ここがずれていれば変換式そのものが間違っている。
	 */
	it("ズーム 0 では緯度経度 0 がタイルの中心になる", () => {
		expect(longitudeToTileX(0, 0)).toBeCloseTo(0.5, 10);
		expect(latitudeToTileY(0, 0)).toBeCloseTo(0.5, 10);
	});

	it("経度は -180〜180 をタイルの端から端へ線形に写す", () => {
		expect(longitudeToTileX(-180, 2)).toBeCloseTo(0, 10);
		expect(longitudeToTileX(180, 2)).toBeCloseTo(4, 10);
		expect(longitudeToTileX(90, 2)).toBeCloseTo(3, 10);
	});

	/*
	 * 緯度は線形ではない（メルカトル図法）。線形に実装してしまう間違いを
	 * 検出したいので、線形なら 1.0 になる緯度 45 度を突く。
	 */
	it("緯度はメルカトル図法で写す（線形ではない）", () => {
		const y = latitudeToTileY(45, 2);
		// 線形に写すと (90-45)/180 * 4 = 1.0 になるが、
		// メルカトルでは 1.4389（= (1 - ln(tan45°+sec45°)/π) / 2 * 4）
		expect(y).toBeCloseTo(1.4389, 4);
		expect(y).not.toBeCloseTo(1, 1);
	});

	/*
	 * 実際の地点で、既知の値と突き合わせる。東京駅（35.681236, 139.767125）は
	 * OSM Wiki の Slippy map tilenames の式でズーム 15 の
	 * x=29105, y=12903 のタイルに載る（小数部を含めて 29105.914 / 12903.318）。
	 * 式の符号や 2 の冪の取り違えは、この 1 件で落ちる。
	 *
	 * 小数部まで見ているのは、タイル内の位置がマーカーの置き場所を決めるため。
	 * 整数部だけ合っていても、小数部がずれるとマーカーが最大 1 タイル分
	 * （ズーム 15 で数百 m）別の場所を指す
	 */
	it("東京駅の座標が既知のタイル番号に落ちる", () => {
		expect(longitudeToTileX(TOKYO.longitude, 15)).toBeCloseTo(29105.914, 3);
		expect(latitudeToTileY(TOKYO.latitude, 15)).toBeCloseTo(12903.318, 3);
	});

	it("南半球・西半球でも符号を取り違えない", () => {
		// シドニー（-33.8688, 151.2093）は北緯側より下、東経側
		expect(latitudeToTileY(-33.8688, 8)).toBeGreaterThan(128);
		expect(longitudeToTileX(151.2093, 8)).toBeGreaterThan(128);
		// リオデジャネイロ（-22.9068, -43.1729）は西経側
		expect(longitudeToTileX(-43.1729, 8)).toBeLessThan(128);
	});

	/*
	 * 緯度の両端。`CreateIssueSchema` は -90〜90 をちょうど許すので、
	 * 極点の Issue は実際に起票できる。しかし Web Mercator の式は
	 * tan(±90°) が発散するため、素直に計算すると y が Infinity や
	 * 桁外れの負値になり、URL に "Infinity" が埋まった壊れたリクエストになる。
	 * 地図が描けるタイルの範囲へ収める必要がある
	 */
	it("極点でもタイル座標が有限の範囲に収まる", () => {
		const max = 2 ** 15;
		for (const latitude of [90, -90, 89.9999, -89.9999]) {
			const y = latitudeToTileY(latitude, 15);
			expect(Number.isFinite(y), `緯度 ${latitude} で y が有限でない`).toBe(
				true,
			);
			expect(y, `緯度 ${latitude} で y が下にはみ出す`).toBeGreaterThanOrEqual(
				0,
			);
			expect(y, `緯度 ${latitude} で y が上にはみ出す`).toBeLessThanOrEqual(
				max,
			);
		}
	});

	/*
	 * タイル URL の組み立ては #118 で MapLibre へ渡した（テンプレートを
	 * どう埋めるかはライブラリの領分）。ここに残るのは座標変換だけで、
	 * これは `lib/map-view.ts` が「全件が収まる視界」を求めるのに使う。
	 * サーバー側で決める必要があるのでブラウザの MapLibre には頼めない
	 */
});

describe("タイル配信元の設定", () => {
	/*
	 * OSM の公開タイルサーバーは利用規約で本番利用が制限されている
	 * （operations.osmfoundation.org/policies/tiles/）。既定値として
	 * 焼き込むと、設定を忘れたまま本番が規約違反のトラフィックを出す。
	 * 「設定が無ければ地図を出さない」を選んでいる
	 */
	it("環境変数が無いときは配信元を勝手に決めない", () => {
		delete process.env.NEXT_PUBLIC_MAP_TILE_URL;
		expect(resolveTileUrlTemplate()).toBeNull();
	});

	it("空文字や空白だけの設定は未設定として扱う", () => {
		process.env.NEXT_PUBLIC_MAP_TILE_URL = "   ";
		expect(resolveTileUrlTemplate()).toBeNull();
	});

	it("設定されていればその値を使う", () => {
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		expect(resolveTileUrlTemplate()).toBe(TEMPLATE);
	});
});

describe("IssueMap", () => {
	/*
	 * **ここで見られることと、見られないこと（#118）。**
	 *
	 * #63 の頃はラスタタイルを `<img>` で並べていたので、描いた HTML を
	 * 読めばタイルの番号もマーカーのずれも検査できた。#118 で MapLibre へ
	 * 移ると地図の中身は WebGL のキャンバスになり、`bun test`（DOM 無し・
	 * 描画エンジン無し）からは一切見えない。`useEffect` も走らない。
	 *
	 * **見えなくなった分の検証は捨てず、`map-options.test.ts` へ移した。**
	 * 「MapLibre に何を渡すか」を値として検査する形で、中心の座標
	 * （[経度, 緯度] の順を取り違えていないか）・縮尺・帰属表示・
	 * 配信元が未設定なら作らないこと、を見ている。
	 *
	 * ここに残すのは**サーバー側の描画で決まる部分**だけ。地図が読み込まれる
	 * 前・JS が無効・WebGL が使えない環境で、画面がどう見えるかにあたる。
	 */
	it("地図を置く箱を描く", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={TEMPLATE}
				attribution="© OpenStreetMap contributors"
			/>,
		);

		// MapLibre が描画先にする箱。CSS が寸法を与えているので、
		// これが無いと地図の場所そのものが確保されない。
		// クラス名は境界付きで照合する（`issue-map-viewX` のような
		// 綴り違いだと CSS が当たらず、箱の大きさが 0 になる）
		expect(html).toMatch(/class="[^"]*\bissue-map-view\b[^"]*"/);
	});

	/*
	 * OSM の利用規約は attribution を隠さず表示することを求めている。
	 * MapLibre 自身も地図の隅に出すが、**地図が読み込めなかったときに
	 * それごと消える**ので、こちらでも地図の直下に置く
	 */
	it("attribution を画面に出す", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={TEMPLATE}
				attribution="© OpenStreetMap contributors"
			/>,
		);
		expect(html).toContain("OpenStreetMap contributors");
	});

	/*
	 * 配信元が未設定なら地図の箱ごと出さない。#63 から続く判断で、
	 * #118 の受け入れ条件にも入っている。箱だけ残すと、空の枠が
	 * 壊れて見えるうえに場所も取る
	 */
	it("配信元が未設定なら地図を描かない", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={null}
				attribution={null}
			/>,
		);
		expect(html).toBe("");
	});

	/*
	 * 判別できない配信元も同じ扱い。「たぶんラスタ」と決め打つと、
	 * 打ち間違えた人が真っ白な地図の原因を掴めない
	 */
	it("判別できない配信元でも地図を描かない", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate="https://tiles.example.com/"
				attribution={null}
			/>,
		);
		expect(html).toBe("");
	});

	/*
	 * 地図の中身（WebGL のキャンバス）は読み上げに使える内容を持たない。
	 * 全体を 1 つの画像として扱い、何の場所かをラベルで伝える。
	 * 座標の数値は呼び出し側（詳細ページの dl）に残っている
	 */
	it("スクリーンリーダー向けに地図全体のラベルを持つ", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={TEMPLATE}
				attribution={null}
			/>,
		);
		expect(html).toContain('role="img"');
		expect(html).toMatch(/aria-label="[^"]*駅前の街灯が切れている/);
	});

	it("タイトルを属性へそのまま埋め込まない（HTML として解釈させない）", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title={'"><script>alert(1)</script>'}
				tileUrlTemplate={TEMPLATE}
				attribution={null}
			/>,
		);
		expect(html).not.toContain("<script>");
	});
});

describe("詳細ページの地図", () => {
	it("配信元が設定されていれば地図を描く", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubDetailFetch();

		const element = await IssueDetailPage({
			params: Promise.resolve({ id: sampleIssue.id }),
		});
		const html = renderToStaticMarkup(element);

		// MapLibre が描画先にする箱。中身は WebGL のキャンバスなので
		// ここからは見えない（何を渡しているかは `map-options.test.ts`）
		expect(html).toMatch(/class="[^"]*\bissue-map-view\b[^"]*"/);
		// 何の場所を指しているかがラベルとして出ていること
		expect(html).toMatch(/aria-label="[^"]*駅前の街灯が切れている/);
	});

	it("配信元が未設定なら地図の箱ごと出さない", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		delete process.env.NEXT_PUBLIC_MAP_TILE_URL;
		globalThis.fetch = stubDetailFetch();

		const element = await IssueDetailPage({
			params: Promise.resolve({ id: sampleIssue.id }),
		});
		const html = renderToStaticMarkup(element);

		expect(html).not.toContain("issue-map-view");
	});

	/*
	 * #118 の受け入れ条件。MapLibre は Client Component を要求するが、
	 * **その境界を地図の部品に閉じ込める**こと。
	 *
	 * ページに `use client` が付くと、詳細ページの中身（Issue 本文、
	 * コメント、座標の dl）まで全部クライアントへ配られ、サーバー側で
	 * 描く意味が消える。同じ理由で、ページが MapLibre を直接 import
	 * するのも駄目（境界がページまで上がる）。
	 *
	 * ソースを読む形にしているのは、`renderToStaticMarkup` では
	 * Server / Client の区別が結果に現れないため（どちらも同じ HTML を出す）。
	 */
	it("詳細ページ自体は Client Component になっていない", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/app/issues/[id]/page.tsx"),
			"utf8",
		);

		expect(
			source.trimStart().startsWith('"use client"'),
			"詳細ページ全体が Client Component になっている",
		).toBe(false);
		expect(
			source,
			"ページが MapLibre を直接読み込んでいる（境界がページまで上がる）",
		).not.toContain("maplibre-gl");
	});

	/*
	 * 地図の部品の側は Client Component であること。MapLibre は WebGL で
	 * 描くのでブラウザでの実行が要る。付け忘れると、サーバー側で
	 * `document` を触って落ちる
	 */
	it("地図の部品は Client Component になっている", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/app/components/IssueMap.tsx"),
			"utf8",
		);
		expect(source.trimStart().startsWith('"use client"')).toBe(true);
	});

	/*
	 * Issue のコメントで明示された要件。地図が読み込めなくても座標の数値は
	 * 残す。地図に置き換えて数値を消すと、タイル配信元が落ちたときに
	 * 位置情報が完全に失われる
	 */
	it("地図を出しても座標の数値を消さない", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubDetailFetch();

		const element = await IssueDetailPage({
			params: Promise.resolve({ id: sampleIssue.id }),
		});
		const html = renderToStaticMarkup(element);

		expect(html).toContain(String(TOKYO.latitude));
		expect(html).toContain(String(TOKYO.longitude));
	});

	it("配信元が未設定でも座標の数値は表示する", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		delete process.env.NEXT_PUBLIC_MAP_TILE_URL;
		globalThis.fetch = stubDetailFetch();

		const element = await IssueDetailPage({
			params: Promise.resolve({ id: sampleIssue.id }),
		});
		const html = renderToStaticMarkup(element);

		expect(html).toContain(String(TOKYO.latitude));
		expect(html).toContain(String(TOKYO.longitude));
	});
});
