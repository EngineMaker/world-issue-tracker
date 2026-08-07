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

import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueMap } from "../src/app/components/IssueMap";
import IssueDetailPage from "../src/app/issues/[id]/page";
import {
	latitudeToTileY,
	longitudeToTileX,
	MAP_ZOOM,
	resolveTileUrlTemplate,
	TILE_SIZE,
	tileUrl,
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

	it("テンプレートの {z}/{x}/{y} を実際の値で置き換える", () => {
		expect(tileUrl(TEMPLATE, 3, 5, 7)).toBe(
			"https://tiles.example.com/7/3/5.png",
		);
	});

	it("{s} を含むテンプレートでも実在するサブドメインに解決する", () => {
		const url = tileUrl(
			"https://{s}.tiles.example.com/{z}/{x}/{y}.png",
			3,
			5,
			7,
		);
		expect(url).toMatch(/^https:\/\/[abc]\.tiles\.example\.com\/7\/3\/5\.png$/);
	});
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
	it("配信元が設定されていればタイル画像を並べる", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={TEMPLATE}
				attribution="© OpenStreetMap contributors"
			/>,
		);

		// 中心タイルが含まれていること（別の場所を表示していない証拠）
		expect(html).toContain(`/${MAP_ZOOM}/29105/12903.png`);
		// 1 枚だけでは中心の周りが切れるので、上下左右も並べる
		expect(html).toContain(`/${MAP_ZOOM}/29104/12903.png`);
		expect(html).toContain(`/${MAP_ZOOM}/29106/12903.png`);
		expect(html).toContain(`/${MAP_ZOOM}/29105/12902.png`);
		expect(html).toContain(`/${MAP_ZOOM}/29105/12904.png`);
	});

	/*
	 * 3x3 で並べる以上、地図の端にある地点では周囲のタイルが世界の外へ
	 * はみ出す。存在しないタイル（負の番号や 2^zoom 以上）を要求すると
	 * 404 が並び、地図が虫食いになるうえ配信元に無駄な負荷をかける。
	 * 緯度経度の両端はスキーマ上そのまま起票できる値なので、実際に起きうる
	 */
	it("世界の端にある地点でも存在しないタイルを要求しない", () => {
		const max = 2 ** MAP_ZOOM;

		for (const [latitude, longitude] of [
			[90, 180],
			[-90, -180],
			[0, 180],
			[0, -180],
			[85.05, 0],
			[-85.05, 0],
		] as const) {
			const html = renderToStaticMarkup(
				<IssueMap
					latitude={latitude}
					longitude={longitude}
					title="世界の端"
					tileUrlTemplate={TEMPLATE}
					attribution={null}
				/>,
			);

			const where = `(${latitude}, ${longitude})`;
			expect(html, `${where} で URL に Infinity/NaN が入った`).not.toMatch(
				/Infinity|NaN/,
			);

			for (const [, x, y] of html.matchAll(
				/tiles\.example\.com\/\d+\/(-?\d+)\/(-?\d+)\.png/g,
			)) {
				expect(Number(x), `${where} で x が範囲外`).toBeGreaterThanOrEqual(0);
				expect(Number(x), `${where} で x が範囲外`).toBeLessThan(max);
				expect(Number(y), `${where} で y が範囲外`).toBeGreaterThanOrEqual(0);
				expect(Number(y), `${where} で y が範囲外`).toBeLessThan(max);
			}
		}
	});

	/*
	 * マーカーが実際に Issue の地点を指しているかを見る。
	 *
	 * どのタイルを取るか（URL）が正しくても、タイル群をずらす量が間違っていれば
	 * 「地図は出るが指している場所が違う」という、見た目では気付きにくい
	 * 壊れ方をする。ここを押さえないとオフセットの符号を反転しても、
	 * `TILE_RADIUS` の項を落としても、`transform` ごと消してもテストが通る。
	 *
	 * マーカーは CSS で表示領域の中央（VIEW_SIZE/2）に固定されているので、
	 * 「地点がビュー内のどこに描かれるか」を HTML の transform から逆算し、
	 * それが中央と一致することを確かめる。期待値を直接書かずに
	 * 不変条件（地点はマーカーの真下に来る）を検証している
	 */
	it("地点がマーカーの位置に来るようタイルをずらす", () => {
		const viewSize = TILE_SIZE * 2;

		for (const [latitude, longitude] of [
			[TOKYO.latitude, TOKYO.longitude],
			[0, 0],
			[-33.8688, 151.2093],
			[51.5074, -0.1278],
		] as const) {
			const html = renderToStaticMarkup(
				<IssueMap
					latitude={latitude}
					longitude={longitude}
					title="位置の確認"
					tileUrlTemplate={TEMPLATE}
					attribution={null}
				/>,
			);

			const where = `(${latitude}, ${longitude})`;
			const moved = html.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
			expect(moved, `${where} で transform が出ていない`).not.toBeNull();

			const [offsetX, offsetY] = [Number(moved?.[1]), Number(moved?.[2])];

			// タイル群の中で地点が置かれる位置（左上のタイルの左上からの px）。
			// 3x3 の中央タイルなので、そのタイルの小数部に 1 枚分を足す
			const tileX = longitudeToTileX(longitude, MAP_ZOOM);
			const tileY = latitudeToTileY(latitude, MAP_ZOOM);
			const withinTilesX = (tileX - Math.floor(tileX) + 1) * TILE_SIZE;
			const withinTilesY = (tileY - Math.floor(tileY) + 1) * TILE_SIZE;

			// ずらした後、地点はビューの中央（＝マーカーの位置）に来るはず
			expect(withinTilesX + offsetX, `${where} で地点が横にずれた`).toBeCloseTo(
				viewSize / 2,
				6,
			);
			expect(withinTilesY + offsetY, `${where} で地点が縦にずれた`).toBeCloseTo(
				viewSize / 2,
				6,
			);
		}
	});

	/*
	 * ずらした結果、3x3 のタイルがビューを隙間なく覆っているか。
	 * オフセットが大きすぎるとタイルの外側（背景）が見えて地図が欠ける
	 */
	it("ずらしてもタイルがビュー全体を覆う", () => {
		const viewSize = TILE_SIZE * 2;
		const tilesSize = TILE_SIZE * 3;

		for (const [latitude, longitude] of [
			[TOKYO.latitude, TOKYO.longitude],
			[0, 0],
			[-33.8688, 151.2093],
		] as const) {
			const html = renderToStaticMarkup(
				<IssueMap
					latitude={latitude}
					longitude={longitude}
					title="被覆の確認"
					tileUrlTemplate={TEMPLATE}
					attribution={null}
				/>,
			);

			const moved = html.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
			const [offsetX, offsetY] = [Number(moved?.[1]), Number(moved?.[2])];
			const where = `(${latitude}, ${longitude})`;

			// タイル群の左上がビューの左上より右/下に来ると、そこに隙間ができる
			expect(offsetX, `${where} で左に隙間`).toBeLessThanOrEqual(0);
			expect(offsetY, `${where} で上に隙間`).toBeLessThanOrEqual(0);
			// 逆にずらしすぎると右/下が足りなくなる
			expect(offsetX + tilesSize, `${where} で右に隙間`).toBeGreaterThanOrEqual(
				viewSize,
			);
			expect(offsetY + tilesSize, `${where} で下に隙間`).toBeGreaterThanOrEqual(
				viewSize,
			);
		}
	});

	/*
	 * クラス名は境界付きで照合する。`toContain("issue-map-marker")` だと
	 * `issue-map-markerX` のような綴り違いも通ってしまい、CSS が当たらず
	 * マーカーが消えている状態を見逃す（クラス名は CSS 側と対で意味を持つ）
	 */
	it("Issue の地点を指すマーカーを重ねる", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={TEMPLATE}
				attribution={null}
			/>,
		);
		expect(html).toMatch(/class="[^"]*\bissue-map-marker\b[^"]*"/);
	});

	/*
	 * OSM の利用規約は attribution を隠さず表示することを求めている。
	 * 設定した文言が画面に出ることを確かめる
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

	it("配信元が未設定なら地図を描かない（壊れた画像を並べない）", () => {
		const html = renderToStaticMarkup(
			<IssueMap
				latitude={TOKYO.latitude}
				longitude={TOKYO.longitude}
				title="駅前の街灯が切れている"
				tileUrlTemplate={null}
				attribution={null}
			/>,
		);
		expect(html).not.toContain("<img");
	});

	/*
	 * タイル画像の alt を空にしているのは、地図の情報が隣接する座標の
	 * 数値で読めるため（画像 1 枚ごとに読み上げても意味を成さない）。
	 * 代わりに地図全体へラベルを付ける
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

		expect(html).toContain(`/${MAP_ZOOM}/29105/12903.png`);
		expect(html).toContain("issue-map-marker");
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
