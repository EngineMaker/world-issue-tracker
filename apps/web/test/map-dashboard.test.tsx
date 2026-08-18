/**
 * 複数の Issue を 1 枚の地図で見比べる画面（#113）のテスト。
 *
 * #63 で入った地図は 1 件の位置を示すだけで、「この地域に何が集まっているか」
 * を読む場所が無かった。ここで作るのは `/map` の独立した画面で、
 * 複数地点のプロット・パン・ズーム・絞り込みを見る。
 *
 * 見るのは 4 つ。
 *  1. 複数地点を収める視界の計算（`lib/map-view.ts`）。ここがずれると
 *     「地図は出るが Issue が画面の外にある」という壊れ方をする
 *  2. `IssuesMap` が全件のマーカーを、それぞれ正しい位置に描くか
 *  3. `/map` ページが絞り込みとズームを URL で持ち回るか
 *  4. ヘッダーから辿れるか
 */

// 表示言語を Cookie から読むため、Server Component を直接呼ぶこのテストには
// リクエストスコープが要る。テスト対象より先に評価させる
import "./helpers/mock-cookies";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOCALE, getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssuesMap } from "../src/app/components/IssuesMap";
import MapPage from "../src/app/map/page";
import type { PublicIssue, RawSearchParams } from "../src/lib/issues";
import {
	clampMapZoom,
	fitViewToIssues,
	MAP_VIEW_HEIGHT,
	MAP_VIEW_WIDTH,
	projectToView,
} from "../src/lib/map-view";

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
const originalTileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL;

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
});

const TEMPLATE = "https://tiles.example.com/{z}/{x}/{y}.png";

/** 東京・大阪・札幌。離れた 3 点で、視界の計算が全部を収めるかを見る */
const TOKYO = { latitude: 35.681236, longitude: 139.767125 };
const OSAKA = { latitude: 34.702485, longitude: 135.495951 };
const SAPPORO = { latitude: 43.068564, longitude: 141.350755 };

function issueAt(
	id: string,
	title: string,
	at: { latitude: number; longitude: number },
	overrides: Partial<PublicIssue> = {},
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
		...overrides,
	};
}

const THREE_CITIES = [
	issueAt("aaaa", "東京の Issue", TOKYO),
	issueAt("bbbb", "大阪の Issue", OSAKA),
	issueAt("cccc", "札幌の Issue", SAPPORO),
];

describe("複数地点を収める視界の計算", () => {
	/*
	 * この Issue の核心。1 件しか映らない地図なら #63 のままで、
	 * 「地理的な偏りが読めない」問題は解決していない。
	 * 離れた 3 点すべてが表示領域の内側に落ちることを確かめる
	 */
	it("離れた複数地点がすべて表示領域に収まる", () => {
		const view = fitViewToIssues(THREE_CITIES);

		for (const issue of THREE_CITIES) {
			const point = projectToView(issue.latitude, issue.longitude, view);
			expect(point.x, `${issue.title} が左にはみ出す`).toBeGreaterThanOrEqual(
				0,
			);
			expect(point.x, `${issue.title} が右にはみ出す`).toBeLessThanOrEqual(
				MAP_VIEW_WIDTH,
			);
			expect(point.y, `${issue.title} が上にはみ出す`).toBeGreaterThanOrEqual(
				0,
			);
			expect(point.y, `${issue.title} が下にはみ出す`).toBeLessThanOrEqual(
				MAP_VIEW_HEIGHT,
			);
		}
	});

	/*
	 * 収めるだけなら「常に世界全体を映す」で満たせてしまうが、それでは
	 * 日本の 3 件が点の塊にしか見えない。地点が散らばっている範囲に対して
	 * 適切なズームを選んでいるかを見る
	 */
	it("狭い範囲に集まっていれば近くまで寄る", () => {
		const near = [
			issueAt("a", "近い 1", TOKYO),
			issueAt("b", "近い 2", {
				latitude: TOKYO.latitude + 0.002,
				longitude: TOKYO.longitude + 0.002,
			}),
		];
		const wide = fitViewToIssues(THREE_CITIES);
		const close = fitViewToIssues(near);

		expect(close.zoom).toBeGreaterThan(wide.zoom);
	});

	/*
	 * 1 件だけ、あるいは同じ座標に複数。範囲の幅が 0 になるので、
	 * 素朴に「範囲に合わせる」と log(0) や 0 除算で壊れる。
	 * 実際に起きうる（同じ場所に 2 件起票される）
	 */
	it("地点が 1 つでも同じ座標でもズームが有限に収まる", () => {
		for (const issues of [
			[issueAt("a", "1 件だけ", TOKYO)],
			[issueAt("a", "同じ場所 1", TOKYO), issueAt("b", "同じ場所 2", TOKYO)],
		]) {
			const view = fitViewToIssues(issues);
			expect(Number.isFinite(view.zoom), "ズームが有限でない").toBe(true);
			expect(Number.isFinite(view.centerLatitude)).toBe(true);
			expect(Number.isFinite(view.centerLongitude)).toBe(true);

			const point = projectToView(TOKYO.latitude, TOKYO.longitude, view);
			expect(point.x).toBeCloseTo(MAP_VIEW_WIDTH / 2, 6);
			expect(point.y).toBeCloseTo(MAP_VIEW_HEIGHT / 2, 6);
		}
	});

	/*
	 * 0 件。絞り込みの結果として実際に起きる。中心もズームも決めようが
	 * 無いので既定値へ倒すが、NaN を返すと地図全体が壊れる
	 */
	/*
	 * 1 件だけのときの縮尺。「どの縮尺が最適か」に正解は無いので値そのものは
	 * 縛らないが、**建物しか見えないところまで寄り切る**のは困る
	 * （周りに何があるかが分からず、地図として役に立たない）。
	 * 広がりが 0 のときに「収まる最大のズーム」を計算すると上限に張り付く
	 * ので、実際に起こりうる間違いを範囲で押さえる
	 */
	it("1 件だけのとき極端な縮尺にならない", () => {
		const view = fitViewToIssues([issueAt("a", "1 件だけ", TOKYO)]);

		// 上限（建物が見える縮尺）に張り付いていないこと
		expect(view.zoom, "寄りすぎて周りが見えない").toBeLessThan(16);
		// 街の様子が分かる程度には寄っていること
		expect(view.zoom, "引きすぎて点にしか見えない").toBeGreaterThanOrEqual(10);
	});

	it("0 件でも壊れない", () => {
		const view = fitViewToIssues([]);
		expect(Number.isFinite(view.zoom)).toBe(true);
		expect(Number.isFinite(view.centerLatitude)).toBe(true);
		expect(Number.isFinite(view.centerLongitude)).toBe(true);
	});

	/*
	 * 極点の Issue は `CreateIssueSchema` 上そのまま起票できる。
	 * Web Mercator は極で発散するので、視界の計算がそこで壊れないか
	 */
	it("極点を含んでも視界が有限に収まる", () => {
		const view = fitViewToIssues([
			issueAt("a", "北極", { latitude: 90, longitude: 0 }),
			issueAt("b", "南極", { latitude: -90, longitude: 0 }),
		]);
		expect(Number.isFinite(view.zoom)).toBe(true);
		expect(Number.isFinite(view.centerLatitude)).toBe(true);
	});

	/*
	 * ズームは URL から来る（利用者が手で編集できる）。範囲外の値を
	 * そのまま使うと存在しないタイルを要求し、地図が真っ白になる
	 */
	it("URL から来たズームを実在する範囲へ収める", () => {
		expect(clampMapZoom(99)).toBeLessThanOrEqual(18);
		expect(clampMapZoom(-5)).toBeGreaterThanOrEqual(0);
		expect(clampMapZoom(Number.NaN)).not.toBeNaN();
		expect(clampMapZoom(5)).toBe(5);
		// 小数のズームはタイル番号にならないので整数へ倒す
		expect(Number.isInteger(clampMapZoom(5.7))).toBe(true);
	});
});

describe("IssuesMap", () => {
	/*
	 * **ここで見られることと、見られないこと（#118）。**
	 *
	 * #113 の頃はラスタタイルを `<img>` で並べていたので、描いた HTML を
	 * 読めばマーカーの位置もタイルの番号も検査できた。#118 で MapLibre へ
	 * 移ると地図の中身は WebGL のキャンバスになり、`bun test`（DOM 無し・
	 * 描画エンジン無し）からは一切見えない。`useEffect` も走らない。
	 *
	 * **見えなくなった分の検証は捨てず、`map-options.test.ts` へ移した。**
	 * 「MapLibre に何を渡すか」を値として検査する形で、マーカーの件数・
	 * 座標・行き先・帰属表示・配信元が未設定なら作らないこと、を見ている。
	 *
	 * ここに残すのは**サーバー側の描画で決まる部分**だけ。地図が読み込まれる
	 * 前・JS が無効・WebGL が使えない環境で、画面がどう見えるかにあたる。
	 */
	it("地図を置く箱と帰属表示を描く", () => {
		const html = renderToStaticMarkup(
			<IssuesMap
				issues={THREE_CITIES}
				tileUrlTemplate={TEMPLATE}
				attribution="© OpenStreetMap contributors"
			/>,
		);

		// MapLibre が描画先にする箱。CSS が寸法を与えているので、
		// これが無いと地図の場所そのものが確保されない
		expect(html).toMatch(/class="issues-map-view"/);
		expect(html).toContain("OpenStreetMap contributors");
	});

	/*
	 * 添える件数は、地図に載せた Issue の数と一致すること。
	 * 渡された総数と別の数を出すと、画面の内容と食い違う
	 */
	it("件数の表示が地図に載せた Issue の数と一致する", () => {
		const html = renderToStaticMarkup(
			<IssuesMap issues={THREE_CITIES} tileUrlTemplate={TEMPLATE} />,
		);

		const caption = html.match(/class="issues-map-attribution">([^<]*)/)?.[1];
		expect(caption, "件数の表示が無い").toBeDefined();
		expect(caption).toContain(String(THREE_CITIES.length));
	});

	/*
	 * #63 から続く判断を引き継ぐ。配信元が決まっていないのに適当な既定値で
	 * タイルを取りに行くと、規約違反のトラフィックを出す。
	 * ここは箱ごと出さない（出すと空の枠だけが残って壊れて見える）
	 */
	it("配信元が未設定なら地図を描かない", () => {
		const html = renderToStaticMarkup(
			<IssuesMap issues={THREE_CITIES} tileUrlTemplate={null} />,
		);
		expect(html).toBe("");
	});

	/*
	 * 判別できない配信元も同じ扱い。「たぶんラスタ」と決め打つと、
	 * 打ち間違えた人が真っ白な地図の原因を掴めない
	 */
	it("判別できない配信元でも地図を描かない", () => {
		const html = renderToStaticMarkup(
			<IssuesMap
				issues={THREE_CITIES}
				tileUrlTemplate="https://tiles.example.com/"
			/>,
		);
		expect(html).toBe("");
	});

	/*
	 * タイトルは利用者が自由に書ける。サーバー側の描画に混ざる経路が
	 * 無いことを見る（マーカーのラベルは `textContent` で入れるので、
	 * こちらの HTML には現れない）
	 */
	it("タイトルを属性へそのまま埋め込まない", () => {
		const html = renderToStaticMarkup(
			<IssuesMap
				issues={[issueAt("x", '"><script>alert(1)</script>', TOKYO)]}
				tileUrlTemplate={TEMPLATE}
			/>,
		);
		expect(html).not.toContain("<script>");
	});
});

describe("/map ページ", () => {
	function stubListFetch(issues: PublicIssue[]) {
		return (async () =>
			Response.json({
				data: issues,
				total: issues.length,
			})) as unknown as typeof globalThis.fetch;
	}

	/*
	 * ページが地図に何件渡しているか。
	 *
	 * #113 の頃はマーカーが HTML に出ていたので数えられたが、MapLibre では
	 * 地図の中身が WebGL のキャンバスになり見えない（#118）。**取得した
	 * Issue が地図へ渡っているか**を、ページの描画から確かめられる範囲で見る。
	 *
	 * 実際に MapLibre へ何を渡すかは `map-options.test.ts` が
	 * 値として検査している（件数・座標・行き先）
	 */
	it("取得した Issue を地図へ渡す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({ searchParams: Promise.resolve({}) });
		const html = renderToStaticMarkup(element);

		// 地図の箱が出ていること（配信元があるのに出ないなら、
		// 地図が丸ごと落ちている）
		expect(html).toMatch(/class="issues-map-view"/);
		// 添える件数が取得件数と一致すること。ここが 0 なら、地図には
		// 箱だけあって Issue が渡っていない
		const caption = html.match(/class="issues-map-attribution">([^<]*)/)?.[1];
		expect(caption).toContain(String(THREE_CITIES.length));
	});

	/*
	 * 受け入れ条件の「カテゴリまたはスコープで絞り込める」。
	 * 条件が API へ渡っていなければ、フォームだけあって効かない状態になる
	 */
	it("絞り込みの条件を API へ渡す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;

		const requested: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			requested.push(typeof input === "string" ? input : input.toString());
			return Response.json({ data: [], total: 0 });
		}) as unknown as typeof globalThis.fetch;

		await MapPage({
			searchParams: Promise.resolve({
				scope: "national",
				category: "道路・交通",
			}),
		});

		expect(requested[0]).toContain("scope=national");
		expect(requested[0]).toContain(encodeURIComponent("道路・交通"));
	});

	/*
	 * 受け入れ条件の「パン・ズームができる」。ズームは URL に載るので、
	 * 別のズームへ移る導線が画面に無ければ操作できない
	 */
	it("ズームを変える導線がある", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({ searchParams: Promise.resolve({}) });
		const html = renderToStaticMarkup(element);

		expect(html).toMatch(/href="\/map\?[^"]*zoom=/);
	});

	/*
	 * 受け入れ条件の「カテゴリまたはスコープで絞り込める」を、**利用者が
	 * 実際に踏む経路で**確かめる。
	 *
	 * 条件をクエリに直接書いて開けば絞り込みは効くが、画面の絞り込み
	 * フォームを押したときにどこへ行くかは別の話。`IssueFilterForm` は
	 * 一覧ページ用に作られていて、送信先が `/issues` に固定されていた。
	 * そのまま置くと**押した瞬間に一覧へ飛ばされ、地図の絞り込みが
	 * 成立しない**（テストが URL 直打ちだけを見ていると素通りする）
	 */
	it("絞り込みフォームの送信先が地図のままである", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({ searchParams: Promise.resolve({}) });
		const html = renderToStaticMarkup(element);

		const action = html.match(/<form[^>]*action="([^"]*)"/)?.[1];
		expect(action, "絞り込みフォームが見つからない").toBeDefined();
		expect(action, "絞り込むと一覧へ飛ばされる").toBe("/map");
	});

	/*
	 * 「条件をすべて解除」も同じ。地図で絞り込んだ状態から解除すると
	 * 一覧へ飛ぶのでは、地図に戻る手段が無い
	 */
	it("条件の解除も地図に留まる", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({
			searchParams: Promise.resolve({ scope: "national" }),
		});
		const html = renderToStaticMarkup(element);

		// 条件が付いているときだけ出る導線。地図側を指していること
		expect(html).toContain('href="/map"');
	});

	/*
	 * ここから下は「パン・ズームができる」を、**操作の結果まで**見る。
	 *
	 * レビューで、この受け入れ条件を担保していたのが「`zoom=` を含む href が
	 * どこかにある」だけだったことが分かった。それだけだと以下が全部すり抜ける:
	 *  - URL の zoom/lat/lng を読み捨てて常に自動の視界を出す
	 *  - パンの移動量が 0（押しても動かない）
	 *  - 拡大と縮小のリンクが逆
	 *  - 緯度経度の丸めが無く、極を越えたり経度が ±180 を出たりする
	 *
	 * どれも「地図は出るしリンクもある」ので、目視でも気付きにくい
	 */

	/** ページを描いて、操作リンクの href をラベルで引けるようにする */
	async function renderControls(params: RawSearchParams = {}) {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({ searchParams: Promise.resolve(params) });
		const html = renderToStaticMarkup(element);

		const links = new Map<string, URL>();
		for (const [, href, label] of html.matchAll(
			// クエリの付かない `/map`（「全体を表示」）も拾う必要がある
			/<a[^>]*href="(\/map(?:\?[^"]*)?)"[^>]*>([^<]*)<\/a>/g,
		)) {
			// `renderToStaticMarkup` は & を実体参照にする。URL として読む前に戻す
			links.set(label, new URL(href.replaceAll("&amp;", "&"), "https://x"));
		}
		return links;
	}

	const labels = getUiMessages(DEFAULT_LOCALE).mapPage;

	/*
	 * URL の zoom / lat / lng を読み捨てていないこと。
	 *
	 * 読み捨てると、**共有された URL を開いた人が別の場所を見る**。
	 * リンクだけを見るテストではこれが素通りする（リンクは正しく組み立て
	 * られるのに、開いた先で反映されない状態になる）。
	 *
	 * #113 の頃はタイルの番号から確かめていたが、MapLibre では地図の中身が
	 * 見えない（#118）。ページが**視界を組み立てる過程**を、パンのリンクが
	 * どこを起点にしているかで見る。指定した中心を無視して自動の視界を
	 * 使っていれば、パンの行き先も自動の視界を起点にした値になる
	 */
	it("URL のズームと中心を読み捨てない", async () => {
		const links = await renderControls({
			zoom: "12",
			lat: String(TOKYO.latitude),
			lng: String(TOKYO.longitude),
		});

		// 拡大は指定した 12 の 1 段上。自動の視界（3 都市が入る z5 前後）を
		// 使っていれば、ここは 6 前後になる
		expect(
			Number(links.get(labels.zoomIn)?.searchParams.get("zoom")),
			"URL のズームが読まれていない",
		).toBe(13);

		// パンの起点が指定した中心であること。自動の視界の中心
		// （3 都市の重心 = 東京より西・北寄り）からだとずれる
		const north = links.get(labels.panNorth);
		expect(
			Number(north?.searchParams.get("lng")),
			"URL の中心が読まれていない",
		).toBeCloseTo(TOKYO.longitude, 3);
		expect(
			Number(north?.searchParams.get("lat")),
			"北へ動かした緯度が中心から離れすぎている",
		).toBeGreaterThan(TOKYO.latitude);
	});

	it("拡大は寄り、縮小は引く（向きを取り違えない）", async () => {
		const links = await renderControls({ zoom: "8", lat: "35", lng: "139" });

		const zoomIn = links.get(labels.zoomIn);
		const zoomOut = links.get(labels.zoomOut);
		expect(zoomIn, "拡大のリンクが無い").toBeDefined();
		expect(zoomOut, "縮小のリンクが無い").toBeDefined();

		expect(Number(zoomIn?.searchParams.get("zoom")), "拡大で寄らない").toBe(9);
		expect(Number(zoomOut?.searchParams.get("zoom")), "縮小で引かない").toBe(7);
	});

	it("パンの各向きが実際にその向きへ動かす", async () => {
		const links = await renderControls({ zoom: "8", lat: "35", lng: "139" });

		const at = (label: string) => {
			const url = links.get(label);
			expect(url, `${label} のリンクが無い`).toBeDefined();
			return {
				lat: Number(url?.searchParams.get("lat")),
				lng: Number(url?.searchParams.get("lng")),
			};
		};

		// 押しても動かない（移動量 0）なら、ここで全部 35/139 のままになる
		expect(at(labels.panNorth).lat, "北へ押しても北に行かない").toBeGreaterThan(
			35,
		);
		expect(at(labels.panSouth).lat, "南へ押しても南に行かない").toBeLessThan(
			35,
		);
		expect(at(labels.panEast).lng, "東へ押しても東に行かない").toBeGreaterThan(
			139,
		);
		expect(at(labels.panWest).lng, "西へ押しても西に行かない").toBeLessThan(
			139,
		);

		// 向きを変えても縮尺は変わらない
		for (const label of [
			labels.panNorth,
			labels.panSouth,
			labels.panEast,
			labels.panWest,
		]) {
			expect(Number(links.get(label)?.searchParams.get("zoom"))).toBe(8);
		}
	});

	/*
	 * 端でのパン。緯度は極を越えられず、経度は東西につながっている。
	 * 丸めが無いと `lat=120` のような存在しない座標や、±180 を出た経度が
	 * URL に載り、その先で地図が壊れる
	 */
	it("端まで動かしても緯度経度が実在する範囲に収まる", async () => {
		for (const [lat, lng] of [
			["84", "179"],
			["-84", "-179"],
		] as const) {
			const links = await renderControls({ zoom: "3", lat, lng });

			for (const label of [
				labels.panNorth,
				labels.panSouth,
				labels.panEast,
				labels.panWest,
			]) {
				const url = links.get(label);
				const nextLat = Number(url?.searchParams.get("lat"));
				const nextLng = Number(url?.searchParams.get("lng"));
				expect(nextLat, `${label} で緯度が極を越えた`).toBeLessThanOrEqual(90);
				expect(nextLat, `${label} で緯度が極を越えた`).toBeGreaterThanOrEqual(
					-90,
				);
				expect(nextLng, `${label} で経度がはみ出した`).toBeLessThanOrEqual(180);
				expect(nextLng, `${label} で経度がはみ出した`).toBeGreaterThanOrEqual(
					-180,
				);
			}
		}
	});

	/*
	 * ズームの端。上限を超えると存在しないタイルを要求して地図が真っ白になる
	 */
	it("ズームの端を越えない", async () => {
		const top = await renderControls({ zoom: "18", lat: "35", lng: "139" });
		expect(
			Number(top.get(labels.zoomIn)?.searchParams.get("zoom")),
		).toBeLessThanOrEqual(18);

		const bottom = await renderControls({ zoom: "0", lat: "35", lng: "139" });
		expect(
			Number(bottom.get(labels.zoomOut)?.searchParams.get("zoom")),
		).toBeGreaterThanOrEqual(0);
	});

	/*
	 * 動かしすぎて何も見えなくなったときの逃げ道。視界を URL から落として
	 * 全件が収まる範囲へ戻す。ここが視界を持ったままだと戻れない
	 */
	it("「全体を表示」は視界の指定を落とす", async () => {
		const links = await renderControls({ zoom: "16", lat: "0", lng: "0" });
		const reset = links.get(labels.resetView);

		expect(reset, "全体を表示のリンクが無い").toBeDefined();
		expect(reset?.searchParams.get("zoom"), "視界が残っている").toBeNull();
		expect(reset?.searchParams.get("lat")).toBeNull();
		expect(reset?.searchParams.get("lng")).toBeNull();
	});

	/*
	 * 操作しても絞り込みが外れないこと。外れると、絞り込んだ状態で
	 * 地図を動かした瞬間に全件へ戻る
	 */
	it("パン・ズームしても絞り込みが外れない", async () => {
		const links = await renderControls({
			zoom: "8",
			lat: "35",
			lng: "139",
			scope: "national",
		});

		// 「条件をすべて解除」は絞り込みを落とすのが役目なので対象外。
		// 見るのは地図を動かす操作だけ
		for (const label of [
			labels.zoomIn,
			labels.zoomOut,
			labels.panNorth,
			labels.panSouth,
			labels.panEast,
			labels.panWest,
			labels.resetView,
		]) {
			expect(
				links.get(label)?.searchParams.get("scope"),
				`${label} を押すと絞り込みが外れる`,
			).toBe("national");
		}
	});

	it("配信元が未設定でも画面自体は壊れない", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		delete process.env.NEXT_PUBLIC_MAP_TILE_URL;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({ searchParams: Promise.resolve({}) });
		const html = renderToStaticMarkup(element);

		expect(html).not.toContain("<img");
		// 地図が出せなくても Issue が何件あるかは伝わる
		expect(html).toContain("東京の Issue");
	});

	/*
	 * 取得に失敗したときに 0 件と同じ見た目にすると、「この地域に
	 * Issue が無い」と誤読させる。失敗は失敗として出す
	 */
	it("取得に失敗したら地図ではなくその旨を出す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = (async () =>
			new Response("boom", {
				status: 500,
			})) as unknown as typeof globalThis.fetch;

		const element = await MapPage({ searchParams: Promise.resolve({}) });
		const html = renderToStaticMarkup(element);

		expect(html).not.toMatch(/class="issues-map-marker"/);
	});
});

describe("CSS と視界の計算の寸法が一致している", () => {
	/*
	 * 表示領域の寸法は 2 箇所にある。`lib/map-view.ts` の定数は
	 * 「全件が収まる初期ズーム」の計算に使われ（`fitZoom`）、実際の箱の
	 * 大きさは CSS が決める。
	 *
	 * #113 の頃は tsx がマーカーの px を算出していたので、ずれると
	 * 「地図は出るのにマーカーが実際の場所からずれる」壊れ方だった。
	 * #118 で MapLibre へ移り、マーカーの位置はライブラリが決めるように
	 * なったので、その壊れ方は消えた。**代わりに残る食い違いは初期ズーム**で、
	 * 定数が実寸より大きいと「全件が収まる」計算が甘くなり、
	 * **端の Issue が最初から画面の外にいる**状態で開く。
	 *
	 * これは「地図は出るし、それらしく見える」ので目視では気付きにくい
	 * （画面の外にあるものは、無いのと区別が付かない）。
	 */
	const css = readFileSync(
		join(import.meta.dir, "../src/app/globals.css"),
		"utf8",
	);

	function declaration(selector: string, property: string): string | null {
		const rule = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
		if (!rule?.[1]) return null;
		const found = rule[1].match(
			new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`),
		);
		return found?.[1]?.trim() ?? null;
	}

	it("表示領域の寸法が lib/map-view.ts の定数と一致する", () => {
		// 幅は上限として指定している（狭い画面では地図の方を狭くする）。
		// 初期ズームの計算はこの上限を前提にしているので、両者が一致する
		expect(declaration(".issues-map-view", "max-width")).toBe(
			`${MAP_VIEW_WIDTH}px`,
		);
		expect(declaration(".issues-map-view", "height")).toBe(
			`${MAP_VIEW_HEIGHT}px`,
		);
	});

	/*
	 * 箱に大きさが無いと、MapLibre は 0x0 のキャンバスを作って
	 * **何も見えない**（例外は出ないので、テストもエラーにならない）。
	 * 詳細ページの地図も同じ形なので、両方見る
	 */
	it("地図の箱に大きさが指定されている", () => {
		expect(
			declaration(".issue-map-view", "width"),
			"詳細ページの地図に幅が無い",
		).not.toBeNull();
		expect(
			declaration(".issue-map-view", "height"),
			"詳細ページの地図に高さが無い",
		).not.toBeNull();
	});
});

describe("ヘッダーの導線", () => {
	/*
	 * 受け入れ条件の「ヘッダーから辿れる」。URL を知っている人しか
	 * 行けない画面は、無いのとほぼ同じ。
	 *
	 * `Header` は Clerk の Client Component を含み、`renderToStaticMarkup` では
	 * リクエストスコープが無くて描画できない。既存の `layout-integrity.test.tsx`
	 * と同じく、部品の側をソースとして読む形で見る。
	 *
	 * ソースに文字列があるかだけでは「書いたつもり」を拾えないので、
	 * 文言が辞書から来ていること（両言語に定義があること）まで併せて見る
	 */
	const headerSource = readFileSync(
		join(import.meta.dir, "../src/app/components/Header.tsx"),
		"utf8",
	);

	it("地図へのリンクがある", () => {
		expect(headerSource, "ヘッダに /map への導線が無い").toContain(
			'href="/map"',
		);
	});

	it("リンクの文言が辞書から来ている（翻訳漏れにならない）", () => {
		expect(headerSource).toContain("messages.header.map");
		for (const locale of ["ja", "en"] as const) {
			const label = getUiMessages(locale).header.map;
			expect(typeof label, `${locale} の header.map が文字列でない`).toBe(
				"string",
			);
			expect(label.length, `${locale} の header.map が空`).toBeGreaterThan(0);
		}
	});
});
