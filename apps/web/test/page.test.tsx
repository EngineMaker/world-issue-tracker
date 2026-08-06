import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueCreated } from "../src/app/components/IssueCreated";
import { IssueFilterForm } from "../src/app/components/IssueFilterForm";
import { formatCreatedAt, IssueList } from "../src/app/components/IssueList";
import { IssuePagination } from "../src/app/components/IssuePagination";
import { MyIssueList } from "../src/app/components/MyIssueList";
import IssuesPage from "../src/app/issues/page";
import Home from "../src/app/page";
import {
	DEFAULT_ISSUE_FILTERS,
	type FetchIssuesResult,
	type FetchMyIssuesResult,
	type IssueFilters,
	parseIssueFilters,
	type RawSearchParams,
} from "../src/lib/issues";

const sampleIssue = {
	id: "ebbcf9d7680ad57cedeeb513a90d461f",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "infrastructure",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-01 12:00:00.000",
} as const;

/**
 * Server Component を呼び出して静的 HTML にする。
 *
 * ページングの検証以外は limit / offset に関心が無いので、
 * 省略時は 1 ページ目（先頭 20 件）とみなす。
 */
function render(
	result:
		| (Omit<Extract<FetchIssuesResult, { ok: true }>, "limit" | "offset"> & {
				limit?: number;
				offset?: number;
		  })
		| Extract<FetchIssuesResult, { ok: false }>,
) {
	const filled: FetchIssuesResult = result.ok
		? { ...result, limit: result.limit ?? 20, offset: result.offset ?? 0 }
		: result;
	return renderToStaticMarkup(IssueList({ result: filled }));
}

describe("IssueList", () => {
	it("Issue のタイトル・スコープ・ステータス・作成日時を表示する", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 1,
		});

		expect(html).toContain("駅前の街灯が切れている");
		expect(html).toContain("community");
		expect(html).toContain("open");
		// `dateTime` 属性ではなく、画面に見えるテキストとして日時が出ていること。
		// 属性値だけを見ると、表示から日時が消えても気付けない
		const visibleText = html.replace(/<[^>]*>/g, "");
		expect(visibleText).toContain("2026-08-01 12:00 UTC");
	});

	it("表示件数と総件数を取り違えずに出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			// 全 42 件のうち 1 件だけ受け取っている状況。
			// limit を総件数より大きくして、ページ分割されていない状態にする
			total: 42,
			limit: 100,
		});

		expect(html).toContain("42 件中 1 件を表示");
	});

	// 複数ページに分かれているときは、何件目を見ているかまで出す。
	// ページを送っても「N 件中 M 件」のままだと、どこにいるのか分からない
	it("複数ページに分かれているときは表示中の範囲を出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 42,
			limit: 20,
			offset: 20,
		});

		expect(html).toContain("42 件中 21 〜 21 件目を表示");
	});

	// 1 ページ目とそれ以降で様式が変わると、ページを送った瞬間に
	// 表記が切り替わって見える
	it("複数ページの 1 ページ目でも範囲の様式で出す", () => {
		const html = render({
			ok: true,
			issues: [sampleIssue],
			total: 42,
			limit: 20,
			offset: 0,
		});

		expect(html).toContain("42 件中 1 〜 1 件目を表示");
	});

	it("複数件をすべて表示する", () => {
		const html = render({
			ok: true,
			issues: [
				sampleIssue,
				{
					...sampleIssue,
					id: "c5a2e9b38fda7955d1f82377881a646b",
					title: "ゴミ集積所があふれている",
				},
			],
			total: 2,
		});

		expect(html).toContain("駅前の街灯が切れている");
		expect(html).toContain("ゴミ集積所があふれている");
	});

	it("1 件も無いときは空であることを伝える文言を出す", () => {
		const html = render({ ok: true, issues: [], total: 0 });

		expect(html).toContain("まだ Issue がありません");
		// 白い画面にならないこと（何らかのテキストが出ている）
		expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
	});

	it("取得に失敗したときはエラーを伝える文言を出す", () => {
		const html = render({ ok: false, error: "接続できませんでした" });

		expect(html).toContain("Issue を取得できませんでした");
		expect(html.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
	});

	it("失敗時に「まだ Issue がありません」とは出さない（空と混同させない）", () => {
		const html = render({ ok: false, error: "接続できませんでした" });

		expect(html).not.toContain("まだ Issue がありません");
	});

	it("Issue の本文を HTML としてではなくテキストとして出す", () => {
		const html = render({
			ok: true,
			issues: [
				{
					...sampleIssue,
					title: "<script>alert(1)</script>",
					description: "<img src=x onerror=alert(1)>",
				},
			],
			total: 1,
		});

		// タグとして解釈される形では出さず、エスケープされた文字列として出す
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("formatCreatedAt", () => {
	it("API の値を UTC として読む（実行環境のタイムゾーンでずらさない）", () => {
		// JST として解釈されると 2026-08-01 03:00 になってしまう
		expect(formatCreatedAt("2026-08-01 12:00:00.000")).toBe(
			"2026-08-01 12:00 UTC",
		);
	});

	it("秒精度の値（DEFAULT で入った古い行）も読める", () => {
		expect(formatCreatedAt("2026-08-01 12:00:00")).toBe("2026-08-01 12:00 UTC");
	});

	it("想定外の書式なら Invalid Date ではなく元の値を返す", () => {
		expect(formatCreatedAt("not a date")).toBe("not a date");
	});
});

/**
 * 自分の Issue 一覧（Issue #68）。
 *
 * 「1 件も無い」「サインインが必要」「取得に失敗」を取り違えると、
 * 起票済みの人に「まだ投稿がありません」と見せることになる。
 * この 3 つの描き分けが主題。
 */
describe("MyIssueList", () => {
	const renderMine = (result: FetchMyIssuesResult) =>
		renderToStaticMarkup(MyIssueList({ result }));

	it("自分が起票した Issue を表示する", () => {
		const html = renderMine({ ok: true, issues: [sampleIssue], total: 1 });

		expect(html).toContain("駅前の街灯が切れている");
	});

	it("1 件も無いときは、まだ起票していないことを伝える", () => {
		const html = renderMine({ ok: true, issues: [], total: 0 });

		expect(html).toContain("まだ Issue を起票していません");
		// 行き止まりにしない（起票画面への導線がある）
		expect(html).toContain("/issues/new");
	});

	it("未サインインならサインインを促し、取得失敗とは別の文言を出す", () => {
		const html = renderMine({
			ok: false,
			error: "サインインが必要です",
			unauthorized: true,
		});

		expect(html).toContain("サインイン");
		// 「時間をおいて再度お試しください」はサインインでは直らない案内なので出さない
		expect(html).not.toContain("時間をおいて");
	});

	it("未サインインを「まだ起票していません」と混同しない", () => {
		const html = renderMine({
			ok: false,
			error: "サインインが必要です",
			unauthorized: true,
		});

		expect(html).not.toContain("まだ Issue を起票していません");
	});

	it("取得に失敗したときはエラーを伝え、サインインの案内にはしない", () => {
		const html = renderMine({
			ok: false,
			error: "API が 500 を返しました",
			unauthorized: false,
		});

		expect(html).toContain("Issue を取得できませんでした");
		expect(html).not.toContain("まだ Issue を起票していません");
	});

	it("Issue の本文を HTML としてではなくテキストとして出す", () => {
		const html = renderMine({
			ok: true,
			issues: [
				{
					...sampleIssue,
					title: "<script>alert(1)</script>",
					description: "<img src=x onerror=alert(1)>",
				},
			],
			total: 1,
		});

		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;script&gt;");
	});
});

/**
 * 起票完了時の導線（Issue #68 の本題）。
 *
 * 「起票しました（ID: xxx）」と ID を出すだけだと、起票者は自分の投稿を
 * 後から辿れない。完了の表示から自分の一覧へ繋がっていることを見る。
 */
describe("IssueCreated", () => {
	it("起票した ID を出す", () => {
		const html = renderToStaticMarkup(IssueCreated({ id: "abc123" }));

		expect(html).toContain("abc123");
	});

	it("自分が起票した Issue の一覧への導線を出す", () => {
		const html = renderToStaticMarkup(IssueCreated({ id: "abc123" }));

		expect(html).toContain('href="/my-issues"');
		// リンクの文言が空だと、あることに気付けない
		expect(html).toContain("自分が起票した Issue");
	});
});

/**
 * トップページが実際に API を呼んで結果を描画しているかを見る。
 *
 * `fetchIssues` と `IssueList` が個別に正しくても、`page.tsx` が両者を
 * 繋いでいなければ Issue #30 の「API を一度も呼んでいない」状態に逆戻りする。
 * その結線だけは、ページを実際に描画してみないと確認できない。
 */
describe("トップページ", () => {
	/** `globalThis.fetch` を差し替えてページを描画する。呼ばれた URL を返す。 */
	async function renderHome(response: Response) {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(typeof input === "string" ? input : input.toString());
			return response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const html = renderToStaticMarkup(await Home());
			return { html, calls };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("API を呼び、返ってきた Issue を描画する", async () => {
		const { html, calls } = await renderHome(
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		// API を呼んでいること（呼ばずに空を出す実装だとここで落ちる）
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/issues");
		// 返ってきた内容が実際に描画されていること
		expect(html).toContain("駅前の街灯が切れている");
		expect(html).not.toContain("まだ Issue がありません");
	});

	it("API が 0 件を返したら空の案内を出す", async () => {
		const { html } = await renderHome(
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("まだ Issue がありません");
	});

	it("API が落ちていたらエラーの案内を出す", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderHome(new Response("boom", { status: 500 }));

			expect(html).toContain("Issue を取得できませんでした");
			expect(html).not.toContain("まだ Issue がありません");
		} finally {
			console.error = originalError;
		}
	});
});

describe("IssueFilterForm", () => {
	function renderForm(filters: IssueFilters = DEFAULT_ISSUE_FILTERS) {
		return renderToStaticMarkup(IssueFilterForm({ filters }));
	}

	// GET フォームでなければ、送信しても URL に条件が載らない。
	// `searchParams` で状態を持つ設計そのものが成立しなくなる
	it("GET メソッドで /issues に送るフォームである", () => {
		const html = renderForm();

		expect(html).toContain('method="get"');
		expect(html).toContain('action="/issues"');
	});

	it("スコープの選択肢を表示ラベルで出す", () => {
		const html = renderForm();

		// 生の enum 値ではなく、トップページの説明と同じ日本語ラベルで出す
		expect(html).toContain('value="municipality"');
		expect(html).toContain("自治体");
		expect(html).toContain("コミュニティ");
	});

	it("ステータスの選択肢を表示ラベルで出す", () => {
		const html = renderForm();

		expect(html).toContain('value="in_progress"');
		expect(html).toContain("対応中");
	});

	it("並べ替えの選択肢を出す", () => {
		const html = renderForm();

		expect(html).toContain('value="oldest"');
		expect(html).toContain("古い順");
		expect(html).toContain("新しい順");
	});

	it("カテゴリの候補を起票フォームと同じ一覧から出す", () => {
		const html = renderForm();

		expect(html).toContain("道路・交通");
		expect(html).toContain("衛生・ごみ");
	});

	it("入力欄の name が API のクエリ名と一致している", () => {
		const html = renderForm();

		for (const name of ["q", "scope", "status", "category", "sort"]) {
			expect(html).toContain(`name="${name}"`);
		}
	});

	// フォームに offset を含めると、条件を変えたときに前のページ位置が
	// 残り「絞り込んだのに空に見える」状態になる
	it("offset をフォームに含めない（条件変更で 1 ページ目に戻る）", () => {
		const html = renderForm({ ...DEFAULT_ISSUE_FILTERS, offset: 40 });

		expect(html).not.toContain('name="offset"');
	});

	it("いま適用されている条件を入力欄の初期値として復元する", () => {
		const html = renderForm({
			scope: "national",
			status: "resolved",
			category: "道路・交通",
			q: "街灯",
			sort: "oldest",
			offset: 0,
		});

		// 再送信したときに条件が消えないこと
		expect(html).toContain('value="街灯"');
		expect(html).toMatch(/<option value="national"[^>]*selected/);
		expect(html).toMatch(/<option value="resolved"[^>]*selected/);
		expect(html).toMatch(/<option value="oldest"[^>]*selected/);
	});

	it("条件が付いているときだけ解除の導線を出す", () => {
		expect(renderForm()).not.toContain("条件をすべて解除");
		expect(renderForm({ ...DEFAULT_ISSUE_FILTERS, scope: "global" })).toContain(
			"条件をすべて解除",
		);
	});
});

describe("IssuePagination", () => {
	function renderPagination({
		filters = DEFAULT_ISSUE_FILTERS,
		total,
		limit = 20,
		offset = 0,
	}: {
		filters?: IssueFilters;
		total: number;
		limit?: number;
		offset?: number;
	}) {
		// 1 ページに収まるときは null を返す。`renderToStaticMarkup` は
		// null をそのまま受け取って空文字を返すので、そのまま渡してよい
		return renderToStaticMarkup(
			IssuePagination({ filters, total, limit, offset }),
		);
	}

	it("1 ページに収まるならページ送りを出さない", () => {
		expect(renderPagination({ total: 20, limit: 20 })).toBe("");
		expect(renderPagination({ total: 3, limit: 20 })).toBe("");
	});

	it("次のページがあればリンクを出す", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 0 });

		expect(html).toContain("次のページ");
		expect(html).toContain('href="/issues?offset=20"');
	});

	it("先頭ページでは「前のページ」をリンクにしない", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 0 });

		// リンクとして出ていたら、押しても同じページに戻るだけの導線になる
		expect(html).not.toContain('href="/issues?offset=-20"');
		expect(html).not.toMatch(/<a[^>]*>前のページ<\/a>/);
	});

	it("最終ページでは「次のページ」をリンクにしない", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 40 });

		expect(html).not.toMatch(/<a[^>]*>次のページ<\/a>/);
		expect(html).toMatch(/<a[^>]*>前のページ<\/a>/);
	});

	// 総件数が limit の倍数ちょうどのとき、最終ページの次は必ず空になる。
	// 境界の判定を 1 つずらすと、ここだけリンクが出て空ページに飛ぶ
	it("総件数が limit の倍数ちょうどでも、最終ページに「次のページ」を出さない", () => {
		const html = renderPagination({ total: 40, limit: 20, offset: 20 });

		expect(html).toContain("2 / 2 ページ");
		expect(html).not.toMatch(/<a[^>]*>次のページ<\/a>/);
		expect(html).not.toContain("offset=40");
	});

	it("倍数ちょうどの手前のページには「次のページ」を出す", () => {
		const html = renderPagination({ total: 40, limit: 20, offset: 0 });

		expect(html).toMatch(/<a[^>]*>次のページ<\/a>/);
		expect(html).toContain('href="/issues?offset=20"');
	});

	it("いま何ページ目かを出す", () => {
		const html = renderPagination({ total: 45, limit: 20, offset: 20 });

		expect(html).toContain("2 / 3 ページ");
	});

	// ページを送った瞬間に絞り込みが外れると、一覧としては使い物にならない
	it("ページ送りのリンクが絞り込み条件を引き継ぐ", () => {
		const html = renderPagination({
			filters: parseIssueFilters({
				scope: "global",
				q: "街灯",
				sort: "oldest",
			}),
			total: 45,
			limit: 20,
			offset: 0,
		});

		const href = html.match(/href="([^"]*offset=20[^"]*)"/)?.[1];
		expect(href).toBeDefined();
		const url = new URL(
			(href ?? "").replaceAll("&amp;", "&"),
			"https://x.test",
		);
		expect(url.searchParams.get("scope")).toBe("global");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("sort")).toBe("oldest");
	});
});

/**
 * 一覧ページが searchParams を実際に読んで API に渡しているかを見る。
 *
 * `parseIssueFilters` と `fetchIssues` が個別に正しくても、`page.tsx` が
 * 両者を繋いでいなければ「フィルタ UI はあるのに何も絞られない」状態になる。
 * その結線はページを描画してみないと確認できない。
 */
describe("Issue 一覧ページ", () => {
	async function renderIssuesPage(
		searchParams: RawSearchParams,
		response: Response,
	) {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(typeof input === "string" ? input : input.toString());
			return response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const html = renderToStaticMarkup(
				await IssuesPage({ searchParams: Promise.resolve(searchParams) }),
			);
			return { html, calls };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("URL の絞り込み条件を API のクエリに渡す", async () => {
		const { calls } = await renderIssuesPage(
			{
				scope: "municipality",
				status: "open",
				category: "道路・交通",
				q: "街灯",
				sort: "oldest",
				offset: "20",
			},
			Response.json({ data: [], total: 0, limit: 20, offset: 20 }),
		);

		expect(calls).toHaveLength(1);
		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBe("municipality");
		expect(url.searchParams.get("status")).toBe("open");
		expect(url.searchParams.get("category")).toBe("道路・交通");
		expect(url.searchParams.get("q")).toBe("街灯");
		expect(url.searchParams.get("sort")).toBe("oldest");
		expect(url.searchParams.get("offset")).toBe("20");
	});

	it("条件が無ければ絞り込み無しで取得する", async () => {
		const { calls, html } = await renderIssuesPage(
			{},
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBeNull();
		expect(url.searchParams.get("q")).toBeNull();
		expect(html).toContain("駅前の街灯が切れている");
	});

	it("絞り込みフォームを表示する", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("絞り込み・並べ替え");
		expect(html).toContain('name="scope"');
		expect(html).toContain('name="q"');
	});

	// 「投稿が 1 件も無い」と「条件に合わなかった」は原因も次の行動も違う
	it("絞り込みで 0 件になったときは条件のせいだと伝える", async () => {
		const { html } = await renderIssuesPage(
			{ q: "見つからない語" },
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("条件に合う Issue はありませんでした");
		expect(html).not.toContain("まだ Issue がありません");
	});

	it("条件無しで 0 件なら、まだ投稿が無いことを伝える", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [], total: 0, limit: 20, offset: 0 }),
		);

		expect(html).toContain("まだ Issue がありません");
		expect(html).not.toContain("条件に合う Issue はありませんでした");
	});

	it("総件数が 1 ページを超えるならページ送りを出す", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [sampleIssue], total: 45, limit: 20, offset: 0 }),
		);

		expect(html).toContain("次のページ");
		expect(html).toContain("1 / 3 ページ");
	});

	it("1 ページに収まるならページ送りを出さない", async () => {
		const { html } = await renderIssuesPage(
			{},
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		expect(html).not.toContain("次のページ");
	});

	it("2 ページ目では表示中の範囲を出す", async () => {
		const { html } = await renderIssuesPage(
			{ offset: "20" },
			Response.json({ data: [sampleIssue], total: 45, limit: 20, offset: 20 }),
		);

		expect(html).toContain("45 件中 21 〜 21 件目を表示");
	});

	// URL は手で編集できる。壊れた値で 500 を返さず、既定の一覧として成立させる
	it("壊れたクエリでもエラーにせず既定の一覧を出す", async () => {
		const { html, calls } = await renderIssuesPage(
			{ scope: "galactic", offset: "-1", sort: "random" },
			Response.json({ data: [sampleIssue], total: 1, limit: 20, offset: 0 }),
		);

		const url = new URL(calls[0] ?? "");
		expect(url.searchParams.get("scope")).toBeNull();
		expect(url.searchParams.get("sort")).toBeNull();
		expect(url.searchParams.get("offset")).toBeNull();
		expect(html).toContain("駅前の街灯が切れている");
	});

	it("API が落ちていてもフォームは出す（条件を変えて再試行できる）", async () => {
		const originalError = console.error;
		console.error = () => {};
		try {
			const { html } = await renderIssuesPage(
				{ q: "街灯" },
				new Response("boom", { status: 500 }),
			);

			expect(html).toContain("Issue を取得できませんでした");
			expect(html).toContain("絞り込み・並べ替え");
		} finally {
			console.error = originalError;
		}
	});
});
