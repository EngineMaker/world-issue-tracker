/**
 * ステータス変更（Issue #62）のテスト。
 *
 * 通信部分（`lib/issue-status.ts`）と、それを画面に繋いだ
 * `StatusControl` の描画の両方を見る。
 *
 * この Issue の症状は「6 つの状態を画面で説明しておきながら、
 * どこからも変えられない」ことだった。個々の関数が正しくても、
 * 詳細ページが操作 UI を出していなければ症状は消えない。
 * そのため最後に詳細ページを実際に描画して、UI が繋がっていることまで見る。
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	DEFAULT_LOCALE,
	ISSUE_STATUS_LABELS,
	IssueStatus,
} from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";

const STATUS_LABELS = ISSUE_STATUS_LABELS[DEFAULT_LOCALE];

type AuthState = { isLoaded: boolean; isSignedIn: boolean };

/** 現在のテストが「どういうログイン状態か」。各テストから差し替える。 */
let authState: AuthState = { isLoaded: true, isSignedIn: true };

// `HelpOfferButton` のテストと同じ理由で、Clerk のフックだけを差し替える。
// 実物はブラウザの Provider を前提にしていて `renderToStaticMarkup` では動かない。
mock.module("@clerk/nextjs", () => ({
	useAuth: () => ({
		...authState,
		getToken: async () => "tok_test",
	}),
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

// 静的 import は巻き上げられて `mock.module` より先に解決されるため、
// テスト対象は動的 import で読み込む。
const {
	fetchViewerRelation,
	parseViewerRelation,
	updateIssueStatus,
	IssueStatusError,
} = await import("../src/lib/issue-status");
const { IssueStatusSection, StatusControl, StatusUnavailable } = await import(
	"../src/app/components/StatusControl"
);

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
	if (originalApiUrl === undefined) {
		delete process.env.NEXT_PUBLIC_API_URL;
	} else {
		process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
	}
});

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

/** タグを落として、画面に見えるテキストだけを取り出す。 */
function visibleText(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

describe("parseViewerRelation", () => {
	it("viewer_is_owner を読み取る", () => {
		expect(parseViewerRelation({ viewer_is_owner: true })).toEqual({
			viewerIsOwner: true,
		});
		expect(parseViewerRelation({ viewer_is_owner: false })).toEqual({
			viewerIsOwner: false,
		});
	});

	// 欠けたレスポンスを false として黙って通すと、起票者に操作 UI が
	// 出なくなる（＝ Issue #62 の症状がそのまま残る）。
	// 形が違えば取得ごと失敗にして、画面側で区別できるようにする。
	it("viewer_is_owner が無ければ null", () => {
		expect(parseViewerRelation({})).toBeNull();
		expect(parseViewerRelation({ viewer_is_owner: "true" })).toBeNull();
		expect(parseViewerRelation(null)).toBeNull();
	});
});

describe("fetchViewerRelation", () => {
	it("GET /issues/:id/viewer を呼び、トークンを Authorization に載せる", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ viewer_is_owner: true }),
		);

		const result = await fetchViewerRelation("issue-1", {
			token: "tok_abc",
			fetchImpl: fetch,
		});

		expect(result).toEqual({ ok: true, viewerIsOwner: true });
		expect(calls[0].url).toBe("https://api.example.com/issues/issue-1/viewer");
		const init = calls[0].init as { headers: Record<string, string> };
		expect(init.headers.Authorization).toBe("Bearer tok_abc");
	});

	it("ID をパスに埋める前にエンコードする", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ viewer_is_owner: false }),
		);

		await fetchViewerRelation("../health", {
			token: "tok_abc",
			fetchImpl: fetch,
		});

		expect(calls[0].url).toBe(
			"https://api.example.com/issues/..%2Fhealth/viewer",
		);
	});

	// 未ログインなら答えは false で確定しているので、API を叩かない。
	it("トークンが無ければ API を呼ばず false を返す", async () => {
		const { fetch, calls } = stubFetch(
			Response.json({ viewer_is_owner: true }),
		);

		const result = await fetchViewerRelation("issue-1", {
			token: null,
			fetchImpl: fetch,
		});

		expect(result).toEqual({ ok: true, viewerIsOwner: false });
		expect(calls).toHaveLength(0);
	});

	it("API が失敗を返したら ok:false", async () => {
		const { fetch } = stubFetch(new Response("", { status: 500 }));

		const result = await fetchViewerRelation("issue-1", {
			token: "tok_abc",
			fetchImpl: fetch,
		});

		expect(result.ok).toBe(false);
	});

	it("通信が落ちたら ok:false（throw しない）", async () => {
		const result = await withSilencedError(() =>
			fetchViewerRelation("issue-1", {
				token: "tok_abc",
				fetchImpl: (() => {
					throw new Error("network down");
				}) as unknown as typeof globalThis.fetch,
			}),
		);

		expect(result.ok).toBe(false);
	});
});

/** PATCH の成功レスポンス。API は更新後の Issue 1 件をそのまま返す。 */
const updatedIssue = {
	id: "issue-1",
	title: "駅前の街灯が切れている",
	description: "夜道が暗くて危ない",
	scope: "community",
	status: "resolved",
	latitude: 35.68,
	longitude: 139.76,
	category: "infrastructure",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-02 09:30:00.000",
};

describe("updateIssueStatus", () => {
	it("PATCH /issues/:id に status だけを送る", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ ...updatedIssue, status: "resolved" }),
		);

		const issue = await updateIssueStatus("issue-1", "resolved", "tok_abc", {
			fetchImpl: fetch,
		});

		expect(calls[0].url).toBe("https://api.example.com/issues/issue-1");
		const init = calls[0].init as {
			method: string;
			headers: Record<string, string>;
			body: string;
		};
		expect(init.method).toBe("PATCH");
		expect(init.headers.Authorization).toBe("Bearer tok_abc");
		expect(init.headers["Content-Type"]).toBe("application/json");
		// タイトルや説明を巻き込まないこと。ステータス以外を送ると、
		// 画面が持っている古い値で本文を上書きしてしまう
		expect(JSON.parse(init.body)).toEqual({ status: "resolved" });
		expect(issue.status).toBe("resolved");
	});

	it("トークンが無ければ API を呼ばず 401 のエラーを投げる", async () => {
		const { fetch, calls } = stubFetch(Response.json({}));

		expect(
			updateIssueStatus("issue-1", "resolved", null, { fetchImpl: fetch }),
		).rejects.toThrow(IssueStatusError);
		expect(calls).toHaveLength(0);
	});

	it("403 は「あなたの Issue ではない」と伝える", async () => {
		const { fetch } = stubFetch(
			Response.json({ error: "Forbidden" }, { status: 403 }),
		);

		let caught: unknown;
		try {
			await updateIssueStatus("issue-1", "resolved", "tok_abc", {
				fetchImpl: fetch,
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(IssueStatusError);
		expect((caught as IssueStatusError).status).toBe(403);
		expect((caught as IssueStatusError).message).toContain("起票した人だけ");
	});

	it("401 はログインし直しを促す", async () => {
		const { fetch } = stubFetch(
			Response.json({ error: "Unauthorized" }, { status: 401 }),
		);

		let caught: unknown;
		try {
			await updateIssueStatus("issue-1", "resolved", "tok_abc", {
				fetchImpl: fetch,
			});
		} catch (err) {
			caught = err;
		}

		expect((caught as IssueStatusError).status).toBe(401);
		expect((caught as IssueStatusError).message).toContain("ログイン");
	});

	// 200 が返ったのに中身が想定と違う場合、成功として扱うと
	// 画面が古いステータスを新しい値として表示し続ける
	it("レスポンスの形が違えばエラーにする", async () => {
		const { fetch } = stubFetch(Response.json({ unexpected: true }));

		expect(
			updateIssueStatus("issue-1", "resolved", "tok_abc", { fetchImpl: fetch }),
		).rejects.toThrow(IssueStatusError);
	});
});

describe("StatusControl", () => {
	function render(
		props: Partial<{
			issueId: string;
			initialStatus: string;
			viewerIsOwner: boolean;
		}> = {},
	) {
		authState = { isLoaded: true, isSignedIn: true };
		return renderToStaticMarkup(
			<StatusControl
				issueId={props.issueId ?? "issue-1"}
				initialStatus={
					(props.initialStatus ?? "open") as typeof IssueStatus._type
				}
				viewerIsOwner={props.viewerIsOwner ?? true}
			/>,
		);
	}

	it("起票者には 6 つの状態すべてを選択肢として出す", () => {
		const html = render({ viewerIsOwner: true });

		for (const status of IssueStatus.options) {
			// value と、読み手に見えるラベルの両方
			expect(html).toContain(`value="${status}"`);
			expect(visibleText(html)).toContain(STATUS_LABELS[status]);
		}
	});

	it("起票者には更新ボタンを出す", () => {
		const html = render({ viewerIsOwner: true });

		expect(html).toContain("<button");
		expect(visibleText(html)).toContain("ステータスを更新");
	});

	// 起票者以外には操作 UI を出さない（Issue #62 のコメントで決めた方針）。
	// API 側の `WHERE ... AND user_id = ?` が本体の保護で、これは表示の話。
	it("起票者以外には選択肢もボタンも出さない", () => {
		const html = render({ viewerIsOwner: false });

		expect(html).not.toContain("<select");
		expect(html).not.toContain("<button");
	});

	it("起票者以外にも現在のステータスは見える", () => {
		const html = render({ viewerIsOwner: false, initialStatus: "in_progress" });

		expect(visibleText(html)).toContain(STATUS_LABELS.in_progress);
	});

	it("選択欄の初期値は現在のステータス", () => {
		const html = render({ viewerIsOwner: true, initialStatus: "review" });

		// React の SSR は `defaultValue` を `<select>` ではなく
		// 該当 `<option>` の `selected` として出す
		expect(html).toMatch(/<option[^>]*value="review"[^>]*selected/);
	});
});

/**
 * 判定を取得する側（`IssueStatusSection`）のテスト。
 *
 * `StatusControl` は `viewerIsOwner` を props で受け取るだけなので、
 * 「誰に操作 UI を見せるか」を実際に決めているのはこちら。
 * ここを検証しないと、判定が付く前や取得に失敗したときに操作 UI を
 * 出してしまう実装に退行しても、テストが通り続ける（レビューの変異体で確認）。
 *
 * `renderToStaticMarkup` は `useEffect` を実行しないため、ここで見えるのは
 * 判定が付く前（loading）の描画。ブラウザではこの後に `useEffect` が走って
 * `ready` / `failed` のどちらかに移る。
 */
describe("IssueStatusSection", () => {
	function render(auth: AuthState = { isLoaded: true, isSignedIn: true }) {
		authState = auth;
		return renderToStaticMarkup(
			<IssueStatusSection
				issueId="issue-1"
				status="open"
				title="駅前の街灯が切れている"
				description="夜道が暗くて危ない"
				scope="community"
				category="infrastructure"
			/>,
		);
	}

	// 判定が付くまでは操作 UI を出さない。
	// 「まだ分からない」を「あなたが起票者だ」に倒すと、起票者以外の画面に
	// 一瞬だけボタンが出て消える（押せたように見えて 403 になる）。
	it("判定が付く前は選択肢もボタンも出さない", () => {
		const html = render();

		expect(html).not.toContain("<select");
		expect(html).not.toContain("<button");
	});

	// 操作できない段階でも、現在の状態は読めること
	it("判定が付く前でも現在のステータスは見える", () => {
		const html = render();

		expect(visibleText(html)).toContain(STATUS_LABELS.open);
	});

	it("未ログインでも操作 UI を出さない", () => {
		const html = render({ isLoaded: true, isSignedIn: false });

		expect(html).not.toContain("<select");
		expect(html).not.toContain("<button");
	});

	// 見出しは常に出す。ページ側のテストがこの id で結線を確かめている
	it("ステータスの見出しを出す", () => {
		expect(render()).toContain('id="issue-status-heading"');
	});
});

/**
 * 判定に失敗したときの表示。
 *
 * `useEffect` の結果でしか到達しない分岐なので、`IssueStatusSection` から
 * 切り出して直接描画できるようにしてある。
 */
describe("StatusUnavailable", () => {
	// 「取得に失敗した」を「あなたが起票者だ」に倒さないこと。
	// 倒すと、変えられない人にボタンを見せることになる
	it("操作 UI を出さない", () => {
		const html = renderToStaticMarkup(<StatusUnavailable status="open" />);

		expect(html).not.toContain("<select");
		expect(html).not.toContain("<button");
	});

	// 黙って隠すと、起票者は「なぜ変えられないのか」が分からない
	it("確認できなかったことを伝え、再読み込みを促す", () => {
		const text = visibleText(
			renderToStaticMarkup(<StatusUnavailable status="open" />),
		);

		expect(text).toContain("確認できませんでした");
		expect(text).toContain("再読み込み");
	});

	it("現在のステータスは見える", () => {
		const text = visibleText(
			renderToStaticMarkup(<StatusUnavailable status="resolved" />),
		);

		expect(text).toContain(STATUS_LABELS.resolved);
	});
});
