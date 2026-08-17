/**
 * Issue 詳細ページ（`/issues/[id]`）のテスト。
 *
 * 取得ロジック（`fetchIssue`）と、それを画面に繋いだ結果の両方を見る。
 * 個別に正しくてもページが両者を繋いでいなければ、Issue #58 の
 * 「個別 Issue に固有の URL が無い」状態は解消しない。
 * その結線はページを実際に描画してみないと確認できない。
 */

// 表示言語を Cookie から読むため（Issue #82）、Server Component を直接呼ぶ
// このテストにはリクエストスコープが要る。テスト対象より先に評価させる
import "./helpers/mock-cookies";
import { afterEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_LOCALE,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueList } from "../src/app/components/IssueList";
import IssueDetailPage from "../src/app/issues/[id]/page";
import { formatCreatedAt, toIsoDateTime } from "../src/lib/datetime";
import { fetchIssue } from "../src/lib/issues";

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
	if (originalApiUrl === undefined) {
		delete process.env.NEXT_PUBLIC_API_URL;
	} else {
		process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
	}
});

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
	updated_at: "2026-08-02 09:30:00.000",
};

const sampleComment = {
	id: "0b1b2c3d4e5f60718293a4b5c6d7e8f9",
	issue_id: sampleIssue.id,
	body: "同じ場所で先週も転びそうになりました",
	created_at: "2026-08-02 09:30:00.000",
};

/** 指定のレスポンスを返す `fetch` の代役。呼ばれた URL と init を記録する。 */
function stubFetch(response: Response | (() => Promise<Response>)) {
	const calls: { url: string; init: unknown }[] = [];
	const fn = async (input: string | URL | Request, init?: unknown) => {
		calls.push({
			url: typeof input === "string" ? input : input.toString(),
			init,
		});
		return typeof response === "function" ? response() : response;
	};
	return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

/** `console.error` を黙らせる。失敗系のテストがログを撒き散らさないように。 */
async function withSilencedError<T>(fn: () => Promise<T>): Promise<T> {
	const original = console.error;
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.error = original;
	}
}

describe("fetchIssue", () => {
	it("GET /issues/:id を呼び、1 件の Issue を返す", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json(sampleIssue));

		const result = await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			`https://api.example.com/issues/${sampleIssue.id}`,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.issue.title).toBe("駅前の街灯が切れている");
	});

	// ID はパスセグメントに埋まる。素朴に連結すると `..` で別のエンドポイントを
	// 叩かせられる（`/issues/../health` は `/health` に潰れる）
	it("ID をエスケープして 1 セグメントに閉じる", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ error: "Issue not found" }, { status: 404 }),
		);

		await fetchIssue("../health", { fetchImpl: fetch });

		expect(calls[0]?.url).toBe("https://api.example.com/issues/..%2Fhealth");
	});

	// 詳細ページは 404 だけを `notFound()` に繋ぐ。一時的な障害まで
	// 404 にすると、実在する Issue に「存在しません」と嘘の断定を出してしまう
	it("404 は notFound として、他の失敗と区別して返す", async () => {
		const { fetch } = stubFetch(
			Response.json({ error: "Issue not found" }, { status: 404 }),
		);

		const result = await fetchIssue("missing", { fetchImpl: fetch });

		expect(result).toEqual({ ok: false, notFound: true });
	});

	it("500 は notFound にしない", async () => {
		const { fetch } = stubFetch(new Response("boom", { status: 500 }));

		const result = await fetchIssue("abc", { fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok || result.notFound) throw new Error("失敗として返らなかった");
		expect(result.error).toContain("500");
	});

	it("ネットワークエラーでも throw せず失敗を返す", async () => {
		const { fetch } = stubFetch(async () => {
			throw new TypeError("fetch failed");
		});

		const result = await withSilencedError(() =>
			fetchIssue("abc", { fetchImpl: fetch }),
		);

		expect(result.ok).toBe(false);
		if (result.ok || result.notFound) throw new Error("失敗として返らなかった");
		// 生の例外メッセージは画面に出さない
		expect(result.error).not.toContain("fetch failed");
	});

	// 200 でも中身が Issue の形とは限らない（プロキシの差し込み、デプロイのズレ）
	it("レスポンスの形が想定と違えば失敗として扱う", async () => {
		const { fetch } = stubFetch(Response.json({ id: 123 }));

		const result = await fetchIssue("abc", { fetchImpl: fetch });

		expect(result.ok).toBe(false);
		if (result.ok || result.notFound) throw new Error("失敗として返らなかった");
		expect(result.error).toContain("想定と異なります");
	});

	// 起票直後に開いても最新が見えるように、一覧と同じくキャッシュしない
	it("キャッシュせずに取得する", async () => {
		const { fetch, calls } = stubFetch(Response.json(sampleIssue));

		await fetchIssue(sampleIssue.id, { fetchImpl: fetch });

		expect(calls[0]?.init).toMatchObject({ cache: "no-store" });
	});
});

describe("詳細ページ", () => {
	/**
	 * `globalThis.fetch` を差し替えてページを描画する。
	 *
	 * ページは Issue 本体・コメント（#60）・表明（#61）の 3 本を投げるので、
	 * URL で振り分ける。`comments` / `helpOffers` を省いたときは空を返す。
	 * Issue 本体の描画だけを見たいテストに、他の指定を毎回書かせないため。
	 *
	 * 振り分けを既定へ落とさず URL ごとに返し分けているのは、同じ `Response` を
	 * 2 回返すと 2 度目が `Body already used` で落ちるため。
	 *
	 * 呼ばれた URL も返し、「そもそも API を呼んでいない」実装を拾えるようにする。
	 */
	async function renderDetail(
		id: string,
		response: Response,
		comments?: Response,
		helpOffers?: Response,
	) {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push(url);
			if (url.endsWith("/comments")) {
				return comments ?? Response.json({ data: [], total: 0 });
			}
			if (url.endsWith("/help-offers")) {
				return (
					helpOffers ??
					Response.json({
						data: [],
						total: 0,
						viewer_offered: false,
						viewer_user_id: null,
					})
				);
			}
			return response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const html = renderToStaticMarkup(
				await IssueDetailPage({ params: Promise.resolve({ id }) }),
			);
			return { html, calls };
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("API を呼び、返ってきた Issue を描画する", async () => {
		const { html, calls } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		// URL の id を使って API を呼んでいること
		// （呼ばずに固定の内容を出す実装だとここで落ちる）。
		// Issue 本体・コメント（#60）・表明（#61）で 3 本投げるので、
		// 本体側を名指しで見る
		expect(calls).toHaveLength(3);
		const issueCalls = calls.filter(
			(url) => !url.endsWith("/comments") && !url.endsWith("/help-offers"),
		);
		expect(issueCalls).toHaveLength(1);
		expect(issueCalls[0]).toContain(`/issues/${sampleIssue.id}`);
		expect(html).toContain("駅前の街灯が切れている");
		expect(html).toContain("夜道が暗くて危ない");
	});

	// Issue #58 が求めている表示項目。タグを剥がした「実際に読める文字」で見る。
	// 属性値だけを見ると、画面から消えても気付けない
	it.each([
		["説明", "夜道が暗くて危ない"],
		["カテゴリ", "infrastructure"],
		["緯度", "35.68"],
		["経度", "139.76"],
	])("%s を表示する", async (_label, expected) => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		expect(html.replace(/<[^>]*>/g, "")).toContain(expected);
	});

	// スコープとステータスは enum の生値のままだと読み手に伝わらない。
	// ラベルは packages/shared に一本化されている
	it("スコープとステータスを日本語ラベルで出す", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);
		const text = html.replace(/<[^>]*>/g, "");

		// 期待値は shared の定数から引く。ここに文言を直書きすると、
		// ラベルを変えたときにテストだけが古い文言を守り続ける
		expect(text).toContain(ISSUE_SCOPE_LABELS[DEFAULT_LOCALE].community.label);
		expect(text).toContain(ISSUE_STATUS_LABELS[DEFAULT_LOCALE].open);
		// enum の生値がそのまま出ていないこと（ラベル化されていることの確認）
		expect(text).not.toContain("community");
	});

	// 日時の整形を独自に書くと 9 時間ずれる（理由は lib/datetime.ts）。
	// 一覧と同じ関数を通っていることを、値として確かめる。
	//
	// 期待値は `formatCreatedAt` から引く（A5）。表示は相対表記になったので、
	// 文字列を直書きすると実行日によって落ちる
	it("作成日時を一覧と同じ整形で表示する", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);
		const text = html.replace(/<[^>]*>/g, "");

		expect(text).toContain(
			formatCreatedAt(sampleIssue.created_at, DEFAULT_LOCALE),
		);
		// UTC の生表記に戻っていないこと
		expect(text).not.toContain("2026-08-01 12:00 UTC");
	});

	// 表示が相対表記になったぶん、正確な時刻は `<time datetime>` だけが持つ（A5）。
	// API の生の値は ISO 8601 ではないので、そのまま入れていないことを見る
	it("正確な時刻を dateTime 属性に ISO 8601 で残す", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		expect(html).toContain(
			`dateTime="${toIsoDateTime(sampleIssue.created_at)}"`,
		);
		// 空白区切りの生の値（ISO 8601 として無効）が属性に残っていないこと
		expect(html).not.toContain(`dateTime="${sampleIssue.created_at}"`);
	});

	// Issue #62: 6 状態を説明しておきながら画面から変える手段が無く、
	// すべての Issue が永久に `open` に留まっていた。
	// 個々の部品（`StatusControl` / `updateIssueStatus`）が正しくても、
	// ページがそれを置いていなければ症状は消えないので、ここで結線を見る。
	it("ステータス欄を描画する（#62 の操作 UI の置き場）", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		// 見出しが出ていること。`StatusControl` は起票者かどうかが定まるまで
		// 操作 UI を出さないので、サーバー側の描画で見えるのはここまで
		expect(html).toContain('id="issue-status-heading"');
		expect(html.replace(/<[^>]*>/g, "")).toContain("ステータス");
	});

	it("投稿内容を HTML としてではなくテキストとして出す", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json({
				...sampleIssue,
				title: "<script>alert(1)</script>",
				description: "<img src=x onerror=alert(1)>",
			}),
		);

		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;script&gt;");
	});

	// 存在しない ID は 404。Next の `notFound()` は例外を投げて
	// not-found 画面に切り替えるため、描画は完了せず throw になる
	it("存在しない ID では notFound() を呼ぶ", async () => {
		const notFound = renderDetail(
			"missing",
			Response.json({ error: "Issue not found" }, { status: 404 }),
		);

		await expect(notFound).rejects.toThrow();
	});

	// ここが 404 になると、API の一時的な不調が
	// 「この Issue は存在しません」という嘘の断定になる
	it("取得に失敗しただけのときは 404 にせずエラーを伝える", async () => {
		const { html } = await withSilencedError(() =>
			renderDetail(sampleIssue.id, new Response("boom", { status: 500 })),
		);

		expect(html).toContain("Issue を表示できませんでした");
		expect(html).not.toContain("存在しません");
	});

	/**
	 * 「手伝います」（Issue #61）の結線。
	 *
	 * `HelpOfferButton` は Client Component で Clerk の `useAuth` を呼ぶため、
	 * ここでは描画結果ではなく「ページが表明を取りに行き、その結果を
	 * 渡していること」を見る。ボタン自体の表示は
	 * `help-offer-button.test.tsx` が担当する。
	 *
	 * これが無いと、ページから `<HelpOfferButton />` を外しても
	 * どのテストも落ちない（実際に外して確認した）。
	 */
	it("表明を取りに行き、件数を画面に渡す", async () => {
		const { html, calls } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
			undefined,
			Response.json({
				data: [],
				total: 3,
				viewer_offered: false,
				viewer_user_id: null,
			}),
		);

		// 表明を取りに行っていること
		expect(calls.some((url) => url.endsWith("/help-offers"))).toBe(true);
		// 取ってきた件数が画面に反映されていること
		// （取得しても渡していない実装だとここで落ちる）
		expect(html).toContain("3 人が「手伝います」と表明しています。");
	});

	it("読み終えたときに行き止まりにしない（一覧への導線がある）", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		expect(html).toContain('href="/issues"');
	});

	/**
	 * コメント欄（Issue #60）の結線。
	 *
	 * `fetchComments` / `CommentSection` が個別に正しくても、ページが
	 * それらを繋いでいなければコメントは画面に出ない。
	 * 結線の確認は、ページを実際に描画してみないとできない。
	 */
	it("Issue の内容とコメントをどちらも描画する", async () => {
		const { html, calls } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
			Response.json({ data: [sampleComment], total: 1 }),
		);

		// コメントを取りに行っていること
		expect(calls.some((url) => url.endsWith("/comments"))).toBe(true);

		expect(html).toContain("駅前の街灯が切れている");
		// コメント本文が実際に画面へ出ていること
		expect(html).toContain("同じ場所で先週も転びそうになりました");
	});

	it("コメント投稿の入口を出す（未ログインでも欄自体は見える）", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		// 「みんなで直す」の装置が画面上に存在すること（Issue #60 の主眼）
		expect(html).toContain("コメント");
		expect(html).toContain("コメントする");
	});

	it("コメントが 0 件なら、その旨を伝えて投稿を促す", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
		);

		expect(html).toContain("まだコメントがありません");
	});

	it("コメントの取得に失敗したら、0 件と混同させない文言を出す", async () => {
		const { html } = await withSilencedError(() =>
			renderDetail(
				sampleIssue.id,
				Response.json(sampleIssue),
				new Response("boom", { status: 500 }),
			),
		);

		expect(html).toContain("コメントを取得できませんでした");
		expect(html).not.toContain("まだコメントがありません");
	});

	it("コメント本文を HTML としてではなくテキストとして出す", async () => {
		const { html } = await renderDetail(
			sampleIssue.id,
			Response.json(sampleIssue),
			Response.json({
				data: [{ ...sampleComment, body: "<img src=x onerror=alert(1)>" }],
				total: 1,
			}),
		);

		expect(html).not.toContain("<img ");
		expect(html).toContain("&lt;img");
	});
});

describe("一覧から詳細への導線", () => {
	// これが無いと、詳細ページを作っても一覧からは辿り着けない
	it("一覧の各 Issue が詳細ページへリンクする", () => {
		const html = renderToStaticMarkup(
			IssueList({
				result: { ok: true, issues: [sampleIssue], total: 1 },
			}),
		);

		expect(html).toContain(`href="/issues/${sampleIssue.id}"`);
		// リンクのテキストがタイトルであること（空リンクになっていない）
		expect(html).toMatch(
			new RegExp(
				`href="/issues/${sampleIssue.id}"[^>]*>駅前の街灯が切れている`,
			),
		);
	});

	// 一覧と詳細はリンクで繋がっている。同じ Issue のスコープ・ステータスが
	// 片方では `community` / `open`、もう片方では「コミュニティ / 受付」だと
	// 別物に見える。詳細側の文言は上の「スコープとステータスを日本語ラベルで
	// 出す」で押さえているので、ここでは一覧側が同じ定数を使っていることを見る
	it("一覧も詳細と同じ表示ラベルを使う", () => {
		const text = renderToStaticMarkup(
			IssueList({
				result: { ok: true, issues: [sampleIssue], total: 1 },
			}),
		).replace(/<[^>]*>/g, "");

		expect(text).toContain(ISSUE_SCOPE_LABELS[DEFAULT_LOCALE].community.label);
		expect(text).toContain(ISSUE_STATUS_LABELS[DEFAULT_LOCALE].open);
		expect(text).not.toContain("community");
	});
});
