/**
 * 本文の編集（Issue #143）のテスト。
 *
 * この Issue の症状は「API（`PATCH /issues/:id`）は所有者限定でタイトル・説明・
 * スコープ・カテゴリの部分更新を受け付けているのに、Web からはステータスしか
 * 送っておらず、内容を直す導線がどの画面にも無い」ことだった。
 *
 * 通信部分（`lib/issue-edit.ts`）・入力の検証（`lib/api.ts` の
 * `validateIssueEdit`）・画面に繋いだ `EditIssueForm` の描画の 3 つを見る。
 * どれか 1 つが正しくても、導線として繋がっていなければ症状は消えない。
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

type AuthState = { isLoaded: boolean; isSignedIn: boolean };

/** 現在のテストが「どういうログイン状態か」。各テストから差し替える。 */
let authState: AuthState = { isLoaded: true, isSignedIn: true };

// `issue-status.test.tsx` と同じ理由で、Clerk のフックだけを差し替える。
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
const { validateIssueEdit } = await import("../src/lib/api");
const { updateIssueContent, IssueEditError } = await import(
	"../src/lib/issue-edit"
);
const { EditIssueForm } = await import("../src/app/components/EditIssueForm");
const { getUiMessages } = await import("@world-issue-tracker/shared");

const MESSAGES = getUiMessages("ja");

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

/** タグを落として、画面に見えるテキストだけを取り出す。 */
function visibleText(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

/** PATCH の成功レスポンス。API は更新後の Issue 1 件をそのまま返す。 */
const updatedIssue = {
	id: "issue-1",
	title: "駅前の街灯が切れている（追記）",
	description: "夜道が暗くて危ない。先週も転びかけた人がいた",
	scope: "municipality",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "防犯・安全",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-02 09:30:00.000",
};

describe("validateIssueEdit", () => {
	const base = {
		title: "駅前の街灯が切れている",
		description: "夜道が暗くて危ない",
		scope: "community",
		category: "防犯・安全",
	};

	it("4 項目を検証して UpdateIssue を返す", () => {
		const result = validateIssueEdit(base);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({
			title: "駅前の街灯が切れている",
			description: "夜道が暗くて危ない",
			scope: "community",
			category: "防犯・安全",
		});
	});

	// 空欄のカテゴリは「外す」。undefined（変更しない）に倒すと、一度付けた
	// カテゴリを画面から二度と外せなくなる
	it("カテゴリの空欄は null にして送る（＝カテゴリを外す）", () => {
		const result = validateIssueEdit({ ...base, category: "  " });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.category).toBeNull();
	});

	// 本文を空にする編集は通さない。詳細ページからタイトル・説明が消える
	it("タイトルが空ならそのフィールドのエラーにする", () => {
		const result = validateIssueEdit({ ...base, title: "   " });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.title).toBeDefined();
	});

	it("説明が空ならそのフィールドのエラーにする", () => {
		const result = validateIssueEdit({ ...base, description: "" });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.description).toBeDefined();
	});

	// 制約（最大長）はスキーマ一本に寄せている。ここを通ることでスキーマの
	// 制約が編集経路にも効いていることを確かめる
	it("タイトルが 200 文字を超えればエラーにする", () => {
		const result = validateIssueEdit({ ...base, title: "あ".repeat(201) });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.title).toBeDefined();
	});

	// スコープの enum 外は弾く。select の値なので通常は起きないが、
	// 検証がスキーマを通っていることの確認
	it("スコープが enum 外ならエラーにする", () => {
		const result = validateIssueEdit({ ...base, scope: "galaxy" });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.fieldErrors.scope).toBeDefined();
	});
});

describe("updateIssueContent", () => {
	it("PATCH /issues/:id に本文 4 項目を送る（status は送らない）", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json(updatedIssue));

		const issue = await updateIssueContent(
			"issue-1",
			{
				title: "駅前の街灯が切れている（追記）",
				description: "夜道が暗くて危ない。先週も転びかけた人がいた",
				scope: "municipality",
				category: "防犯・安全",
			},
			"tok_abc",
			{ fetchImpl: fetch },
		);

		expect(calls[0].url).toBe("https://api.example.com/issues/issue-1");
		const init = calls[0].init as {
			method: string;
			headers: Record<string, string>;
			body: string;
		};
		expect(init.method).toBe("PATCH");
		expect(init.headers.Authorization).toBe("Bearer tok_abc");
		expect(init.headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(init.body);
		expect(body).toEqual({
			title: "駅前の街灯が切れている（追記）",
			description: "夜道が暗くて危ない。先週も転びかけた人がいた",
			scope: "municipality",
			category: "防犯・安全",
		});
		// ステータスを巻き込まないこと。ステータスは別 UI が扱う
		expect(body).not.toHaveProperty("status");
		expect(issue.title).toBe("駅前の街灯が切れている（追記）");
	});

	// カテゴリを外す更新（null）が、そのまま body に載ること
	it("カテゴリの null をそのまま送る", async () => {
		const { fetch, calls } = stubFetch(
			Response.json({ ...updatedIssue, category: null }),
		);

		await updateIssueContent(
			"issue-1",
			{
				title: "t",
				description: "d",
				scope: "personal",
				category: null,
			},
			"tok_abc",
			{ fetchImpl: fetch },
		);

		const init = calls[0].init as { body: string };
		expect(JSON.parse(init.body).category).toBeNull();
	});

	it("トークンが無ければ API を呼ばず 401 のエラーを投げる", async () => {
		const { fetch, calls } = stubFetch(Response.json({}));

		expect(
			updateIssueContent(
				"issue-1",
				{ title: "t", description: "d", scope: "personal", category: null },
				null,
				{ fetchImpl: fetch },
			),
		).rejects.toThrow(IssueEditError);
		expect(calls).toHaveLength(0);
	});

	it("403 は「あなたの Issue ではない」と伝える", async () => {
		const { fetch } = stubFetch(
			Response.json({ error: "Forbidden" }, { status: 403 }),
		);

		let caught: unknown;
		try {
			await updateIssueContent(
				"issue-1",
				{ title: "t", description: "d", scope: "personal", category: null },
				"tok_abc",
				{ fetchImpl: fetch },
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(IssueEditError);
		expect((caught as InstanceType<typeof IssueEditError>).status).toBe(403);
		expect((caught as InstanceType<typeof IssueEditError>).message).toContain(
			"起票した人だけ",
		);
	});

	it("401 はログインし直しを促す", async () => {
		const { fetch } = stubFetch(
			Response.json({ error: "Unauthorized" }, { status: 401 }),
		);

		let caught: unknown;
		try {
			await updateIssueContent(
				"issue-1",
				{ title: "t", description: "d", scope: "personal", category: null },
				"tok_abc",
				{ fetchImpl: fetch },
			);
		} catch (err) {
			caught = err;
		}

		expect((caught as InstanceType<typeof IssueEditError>).status).toBe(401);
		expect((caught as InstanceType<typeof IssueEditError>).message).toContain(
			"ログイン",
		);
	});

	// 200 が返ったのに中身が想定と違う場合、成功として扱うと
	// 画面が古い内容を新しい値として表示し続ける
	it("レスポンスの形が違えばエラーにする", async () => {
		const { fetch } = stubFetch(Response.json({ unexpected: true }));

		expect(
			updateIssueContent(
				"issue-1",
				{ title: "t", description: "d", scope: "personal", category: null },
				"tok_abc",
				{ fetchImpl: fetch },
			),
		).rejects.toThrow(IssueEditError);
	});
});

describe("EditIssueForm", () => {
	const initial = {
		title: "駅前の街灯が切れている",
		description: "夜道が暗くて危ない",
		scope: "community",
		category: "防犯・安全",
	};

	function render(viewerIsOwner: boolean) {
		authState = { isLoaded: true, isSignedIn: true };
		return renderToStaticMarkup(
			<EditIssueForm
				issueId="issue-1"
				viewerIsOwner={viewerIsOwner}
				initial={initial}
			/>,
		);
	}

	// 起票者以外には編集 UI を一切出さない。API 側の `WHERE ... AND user_id = ?`
	// が本体の保護で、これは表示の話（`StatusControl` と同じ整理）
	it("起票者以外には何も描かない", () => {
		expect(render(false)).toBe("");
	});

	// この Issue の主眼。起票者には内容を直す入口が出ること
	it("起票者には編集の入口を出す", () => {
		const html = render(true);

		expect(html).toContain("<button");
		expect(visibleText(html)).toContain(MESSAGES.issueEdit.edit);
	});

	it("見出しを出す（ページ側が結線を確かめられるように）", () => {
		expect(render(true)).toContain('id="issue-edit-heading"');
	});

	// 入口を開く前は、入力欄はまだ出さない（起票者が本文を読み直すときに
	// 編集欄が被さらないため）。押して初めてフォームが開く
	it("入口を開く前は入力欄を出さない", () => {
		const html = render(true);

		expect(html).not.toContain("<textarea");
		expect(html).not.toContain("<select");
	});
});

/**
 * 起票者判定を共有していること（Issue #143 / #144 の「依存・土台の共有」）。
 *
 * 編集は `IssueStatusSection` が一度だけ行う `/viewer` 判定を共有する。
 * `renderToStaticMarkup` は `useEffect` を実行しないので、ここで見えるのは
 * 判定が付く前（loading）の描画。まだ起票者か分からない段階で編集の入口を
 * 出すと、起票者以外の画面に一瞬出て消えることになる。
 */
describe("IssueStatusSection と編集の結線", () => {
	async function render(
		auth: AuthState = { isLoaded: true, isSignedIn: true },
	) {
		authState = auth;
		const { IssueStatusSection } = await import(
			"../src/app/components/StatusControl"
		);
		return renderToStaticMarkup(
			<IssueStatusSection
				issueId="issue-1"
				status="open"
				editInitialValues={{
					title: "t",
					description: "d",
					scope: "community",
					category: "",
				}}
			/>,
		);
	}

	// 判定が付く前は編集の入口を出さない（起票者以外に見せない）
	it("判定が付く前は編集の入口を出さない", async () => {
		const html = await render();

		expect(visibleText(html)).not.toContain(MESSAGES.issueEdit.edit);
	});

	it("未ログインでも編集の入口を出さない", async () => {
		const html = await render({ isLoaded: true, isSignedIn: false });

		expect(visibleText(html)).not.toContain(MESSAGES.issueEdit.edit);
	});
});
