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
import { getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssuesMap } from "../src/app/components/IssuesMap";
import MapPage from "../src/app/map/page";
import type { PublicIssue } from "../src/lib/issues";
import { TILE_SIZE } from "../src/lib/map";
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
	 * 全件がマーカーとして出るか。1 件でも落ちれば「見比べる」が成立しない
	 */
	it("渡した Issue の数だけマーカーを描く", () => {
		const html = renderToStaticMarkup(
			<IssuesMap issues={THREE_CITIES} tileUrlTemplate={TEMPLATE} />,
		);

		const markers = [...html.matchAll(/class="[^"]*\bissues-map-marker\b/g)];
		expect(markers.length).toBe(THREE_CITIES.length);
	});

	/*
	 * マーカーが「ある」だけでは足りない。全部が同じ場所に重なっていても
	 * 数は合う。それぞれが別の位置に、正しい相対関係で置かれているかを見る。
	 * 札幌は東京より北（＝上）、大阪は東京より西（＝左）
	 */
	it("マーカーを地点ごとの位置に置く", () => {
		const html = renderToStaticMarkup(
			<IssuesMap issues={THREE_CITIES} tileUrlTemplate={TEMPLATE} />,
		);

		const placed = [
			...html.matchAll(/left:\s*([\d.-]+)px;\s*top:\s*([\d.-]+)px/g),
		];
		expect(placed.length).toBe(THREE_CITIES.length);

		const [tokyo, osaka, sapporo] = placed.map((m) => ({
			x: Number(m[1]),
			y: Number(m[2]),
		}));
		if (!tokyo || !osaka || !sapporo) throw new Error("位置が読めない");

		// 大阪は東京より西
		expect(osaka.x).toBeLessThan(tokyo.x);
		// 札幌は東京より北 = 画面では上 = y が小さい
		expect(sapporo.y).toBeLessThan(tokyo.y);
		// 大阪は東京より南 = 画面では下
		expect(osaka.y).toBeGreaterThan(tokyo.y);
	});

	/*
	 * 地図から Issue へ辿れないと、点が光るだけで終わる
	 */
	it("マーカーから Issue の詳細へ辿れる", () => {
		const html = renderToStaticMarkup(
			<IssuesMap issues={THREE_CITIES} tileUrlTemplate={TEMPLATE} />,
		);
		for (const issue of THREE_CITIES) {
			expect(html).toContain(`/issues/${issue.id}`);
		}
	});

	/*
	 * #63 と同じ判断を引き継ぐ。配信元が決まっていないのに適当な既定値で
	 * タイルを取りに行くと、規約違反のトラフィックを出す
	 */
	it("配信元が未設定なら地図を描かない", () => {
		const html = renderToStaticMarkup(
			<IssuesMap issues={THREE_CITIES} tileUrlTemplate={null} />,
		);
		expect(html).not.toContain("<img");
	});

	it("タイトルを属性へそのまま埋め込まない", () => {
		const html = renderToStaticMarkup(
			<IssuesMap
				issues={[issueAt("x", '"><script>alert(1)</script>', TOKYO)]}
				tileUrlTemplate={TEMPLATE}
			/>,
		);
		expect(html).not.toContain("<script>");
	});

	/*
	 * 世界の端をまたぐ視界では、タイル番号が世界の外へ出る。
	 * 存在しない番号を要求すると 404 が並んで地図が虫食いになる
	 */
	it("存在しないタイルを要求しない", () => {
		const html = renderToStaticMarkup(
			<IssuesMap
				issues={[
					issueAt("a", "端 1", { latitude: 85, longitude: 179.9 }),
					issueAt("b", "端 2", { latitude: -85, longitude: -179.9 }),
				]}
				tileUrlTemplate={TEMPLATE}
			/>,
		);

		expect(html).not.toMatch(/Infinity|NaN/);
		for (const [, z, x, y] of html.matchAll(
			/tiles\.example\.com\/(\d+)\/(-?\d+)\/(-?\d+)\.png/g,
		)) {
			const max = 2 ** Number(z);
			expect(Number(x)).toBeGreaterThanOrEqual(0);
			expect(Number(x)).toBeLessThan(max);
			expect(Number(y)).toBeGreaterThanOrEqual(0);
			expect(Number(y)).toBeLessThan(max);
		}
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

	it("複数の Issue を 1 枚の地図に出す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		process.env.NEXT_PUBLIC_MAP_TILE_URL = TEMPLATE;
		globalThis.fetch = stubListFetch(THREE_CITIES);

		const element = await MapPage({ searchParams: Promise.resolve({}) });
		const html = renderToStaticMarkup(element);

		const markers = [...html.matchAll(/class="[^"]*\bissues-map-marker\b/g)];
		expect(markers.length).toBe(THREE_CITIES.length);
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

		expect(html).not.toMatch(/class="[^"]*\bissues-map-marker\b/);
	});
});

describe("CSS と座標計算の寸法が一致している", () => {
	/*
	 * 表示領域の寸法は 2 箇所にある。tsx は `lib/map-view.ts` の定数を使って
	 * 地点の px を算出し、実際の箱の大きさは CSS が決める。**この 2 つが
	 * ずれると、地図は出るのにマーカーが実際の場所からずれる**という、
	 * 見た目では気付きにくい壊れ方をする（マーカーは常に「それらしい」
	 * 場所に出るため、ずれていても違和感が無い）。
	 *
	 * インライン style で渡していた頃はずれようが無かったが、
	 * 定数のインライン style を禁じる検査（#86）に合わせて CSS へ移した
	 * ので、対応をここで縛る
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
		expect(declaration(".issues-map-view", "width")).toBe(
			`${MAP_VIEW_WIDTH}px`,
		);
		expect(declaration(".issues-map-view", "height")).toBe(
			`${MAP_VIEW_HEIGHT}px`,
		);
	});

	it("空白タイルの寸法がタイル 1 枚と一致する", () => {
		expect(declaration(".issues-map-blank", "width")).toBe(`${TILE_SIZE}px`);
		expect(declaration(".issues-map-blank", "height")).toBe(`${TILE_SIZE}px`);
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
