/**
 * 起票者による Issue 本文の編集（#143）のテスト。
 *
 * 通信部分（`lib/issue-status.ts` の `updateIssue`）と、それを画面に繋いだ
 * `EditIssueForm` の描画・結線の両方を見る。
 *
 * この Issue の症状は「API は本文の部分更新を受けているのに、画面から送るのは
 * `status` だけで、投稿後にタイトル・説明・スコープ・カテゴリを直せない」こと
 * だった。個々の関数が正しくても、詳細ページが編集の導線を出していなければ
 * 症状は消えない。そのため描画とソース上の結線まで確かめる（web に DOM テスト
 * 基盤が無く、`renderToStaticMarkup` はクリックも `useEffect` も走らせないため、
 * `issue-delete.test.tsx` と同じくソース上の確認で経路の存在を担保する）。
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUiMessages, Locale } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";

// `EditIssueForm` は Client Component で `@clerk/nextjs` の `useAuth` と
// `next/navigation` の `useRouter` を呼ぶ。実物はブラウザの Provider を
// 前提にしていて `renderToStaticMarkup` では動かないため、使うぶんだけ
// 差し替える（`issue-delete.test.tsx` と同じ形）。
mock.module("@clerk/nextjs", () => ({
	useAuth: () => ({
		isLoaded: true,
		isSignedIn: true,
		getToken: async () => "tok_test",
	}),
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

mock.module("next/navigation", () => ({
	useRouter: () => ({
		push: () => {},
		refresh: () => {},
	}),
}));

// 静的 import は巻き上げられて `mock.module` より先に解決されるため、
// テスト対象は動的 import で読み込む。
const { updateIssue, EditIssueError } = await import("../src/lib/issue-status");
const { EditIssueForm } = await import("../src/app/components/EditIssueForm");

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

/** PATCH の成功レスポンス。API は更新後の Issue 1 件をそのまま返す。 */
const updatedIssue = {
	id: "issue-1",
	title: "駅前の街灯が切れている（続報あり）",
	description: "夜道が暗くて危ない。市役所に連絡済み。",
	scope: "municipality",
	status: "open",
	latitude: 35.68,
	longitude: 139.76,
	category: "防犯・安全",
	created_at: "2026-08-01 12:00:00.000",
	updated_at: "2026-08-02 09:30:00.000",
};

const sampleChanges = {
	title: "駅前の街灯が切れている（続報あり）",
	description: "夜道が暗くて危ない。市役所に連絡済み。",
	scope: "municipality" as const,
	category: "防犯・安全",
};

describe("updateIssue", () => {
	it("PATCH /issues/:id に本文の変更をまとめて送る", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json(updatedIssue));

		const issue = await updateIssue("issue-1", sampleChanges, "tok_abc", {
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
		// 送った本文がそのまま body に載ること。ステータス変更と違い、
		// 編集フォームで確定させた 4 項目を丸ごと送る
		expect(JSON.parse(init.body)).toEqual(sampleChanges);
		// API が返した更新後の Issue を返すこと
		expect(issue.title).toBe(updatedIssue.title);
		expect(issue.scope).toBe("municipality");
	});

	// カテゴリを未設定へ戻す編集では null を送る（空文字は `min(1)` で 400 になる）
	it("category に null を送れる（未設定へ戻す）", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(
			Response.json({ ...updatedIssue, category: null }),
		);

		await updateIssue(
			"issue-1",
			{ ...sampleChanges, category: null },
			"tok_abc",
			{ fetchImpl: fetch },
		);

		const init = calls[0].init as { body: string };
		expect(JSON.parse(init.body).category).toBeNull();
	});

	it("ID をパスに埋める前にエンコードする", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(Response.json(updatedIssue));

		await updateIssue("../health", sampleChanges, "tok_abc", {
			fetchImpl: fetch,
		});

		expect(calls[0].url).toBe("https://api.example.com/issues/..%2Fhealth");
	});

	// 未ログインなら API を叩いても 401 が返るだけ。往復せず 401 で投げる
	it("トークンが無ければ API を呼ばず 401 のエラーを投げる", async () => {
		const { fetch, calls } = stubFetch(Response.json(updatedIssue));

		let caught: unknown;
		try {
			await updateIssue("issue-1", sampleChanges, null, { fetchImpl: fetch });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(EditIssueError);
		expect((caught as EditIssueError).status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	// 403（他人の Issue）・404（既に削除済み）は status を保って投げ、
	// 画面側が文言を選べるようにする
	it("API が失敗を返したら status 付きの EditIssueError を投げる", async () => {
		for (const status of [401, 403, 404, 500]) {
			const { fetch } = stubFetch(new Response(null, { status }));

			let caught: unknown;
			try {
				await updateIssue("issue-1", sampleChanges, "tok_abc", {
					fetchImpl: fetch,
				});
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(EditIssueError);
			expect((caught as EditIssueError).status).toBe(status);
		}
	});

	it("通信が落ちたら EditIssueError（status: null）を投げる", async () => {
		let caught: unknown;
		await withSilencedError(async () => {
			try {
				await updateIssue("issue-1", sampleChanges, "tok_abc", {
					fetchImpl: (() => {
						throw new Error("network down");
					}) as unknown as typeof globalThis.fetch,
				});
			} catch (err) {
				caught = err;
			}
		});

		expect(caught).toBeInstanceOf(EditIssueError);
		expect((caught as EditIssueError).status).toBeNull();
	});

	// 200 が返っても中身が Issue の形でなければ、成功として扱わない。
	// 画面が保存できていない値を「保存された」と表示し続けるのを防ぐ
	it("レスポンスの形が違えばエラーにする", async () => {
		const { fetch } = stubFetch(Response.json({ unexpected: true }));

		expect(
			updateIssue("issue-1", sampleChanges, "tok_abc", { fetchImpl: fetch }),
		).rejects.toThrow(EditIssueError);
	});
});

/**
 * 編集フォームの描画（`EditIssueForm`）。
 *
 * この部品は「起票者だと確定しているとき」にしか `IssueStatusSection` から
 * 描画されない。`renderToStaticMarkup` はクリックを走らせないので、ここで
 * 見えるのは欄を開く前の状態。「内容を編集」ボタンが出て、まだ入力欄は
 * 出ていないことを確かめる（削除ボタンの `countDeleteButtons` と同じ考え方）。
 */
describe("Issue の編集フォーム", () => {
	function render(locale?: (typeof Locale.options)[number]): string {
		return renderToStaticMarkup(
			<EditIssueForm
				issueId="issue-1"
				initialTitle="駅前の街灯が切れている"
				initialDescription="夜道が暗くて危ない"
				initialScope="community"
				initialCategory="防犯・安全"
				locale={locale}
			/>,
		);
	}

	/** 描画結果に出ている「内容を編集」ボタンの数。 */
	function countEditButtons(
		markup: string,
		locale: "ja" | "en" = "ja",
	): number {
		const label = getUiMessages(locale).issueDetail.edit;
		return markup.split(`>${label}</button>`).length - 1;
	}

	it("編集を開くボタンを出す", () => {
		expect(countEditButtons(render())).toBe(1);
	});

	// 欄は押してから開く。最初から入力欄が出ていると、所有者向け操作が
	// 常に広がって見える（削除・ステータス変更と同じ作法）
	it("押す前は入力欄を出さない", () => {
		const html = render();
		expect(html).not.toContain("<input");
		expect(html).not.toContain("<textarea");
		expect(html).not.toContain("<select");
	});

	it("見出しは常に出す（ページ側が id で結線を確かめる）", () => {
		expect(render()).toContain('id="issue-edit-heading"');
	});

	it("英語で描画すると英語のボタンが出る", () => {
		// 辞書にあるだけで画面が日本語のままなら意味が無い（i18n.test.tsx と同じ観点）
		const markup = render("en");

		expect(countEditButtons(markup, "en")).toBe(1);
		expect(countEditButtons(markup, "ja")).toBe(0);
	});

	it("ja / en の両方に文言がある", () => {
		for (const locale of Locale.options) {
			const { issueDetail } = getUiMessages(locale);
			for (const text of [
				issueDetail.editHeading,
				issueDetail.edit,
				issueDetail.editSave,
				issueDetail.editSaving,
				issueDetail.editCancel,
				issueDetail.editUpdated,
				issueDetail.editFailed,
				issueDetail.editInvalid,
				issueDetail.editSignInRequired,
			]) {
				expect(text.length).toBeGreaterThan(0);
			}
		}
	});
});

/**
 * 画面と API の結線（ソース上の確認）。
 *
 * `renderToStaticMarkup` は初期描画の文字列しか出さず、`useEffect` も
 * クリックも走らない。そのため「ボタンは出ているが押しても何も起きない」
 * 「起票者判定を通らず誰にでも編集フォームが出る」を描画結果からは
 * 見分けられない（削除 #144 と同じ制約。web に DOM テスト基盤が無い）。
 *
 * どちらも起きるとこの Issue が未解決の状態に戻る（直したつもりで直らない／
 * 起票者以外に編集フォームが出る）のにテストは緑のままになる。そこで、せめて
 * 経路がソース上に在ることを確かめる。実装の書き方を変えたらここも直す必要が
 * あるが、黙って経路が消えるよりは、書き換えのたびに目を通す方がよい。
 */
describe("画面と API の結線（ソース上の確認）", () => {
	const formSource = readFileSync(
		join(import.meta.dir, "../src/app/components/EditIssueForm.tsx"),
		"utf8",
	);
	const sectionSource = readFileSync(
		join(import.meta.dir, "../src/app/components/StatusControl.tsx"),
		"utf8",
	);
	const pageSource = readFileSync(
		join(import.meta.dir, "../src/app/issues/[id]/page.tsx"),
		"utf8",
	);

	it("編集フォームは起票者と確定したときだけ描画する", () => {
		// ここが崩れると、判定前や起票者以外にも編集フォームが出る
		expect(sectionSource).toMatch(/isOwner && \(\s*<EditIssueForm/);
	});

	it("起票者判定を編集側で叩き直さない（/viewer は 1 回）", () => {
		// 編集の導線は StatusControl の起票者判定を土台に共有する（#143 の依存メモ）。
		// `EditIssueForm` が自前で `/viewer`（fetchViewerRelation）を呼ぶと二重になる
		expect(formSource).not.toContain("fetchViewerRelation");
	});

	it("保存はフォームの送信で handleSubmit を呼ぶ", () => {
		expect(formSource).toContain("onSubmit={handleSubmit}");
		expect(formSource).toContain('type="submit"');
	});

	it("handleSubmit が API の updateIssue を呼ぶ", () => {
		// ここが消えると、画面は保存できたように見えても DB は変わらない
		expect(formSource).toMatch(/await updateIssue\(issueId,/);
	});

	it("保存に成功したら詳細ページを取り直す", () => {
		// これが無いと、保存しても表示中の本文（Server Component の値）が古いまま
		expect(formSource).toContain("router.refresh()");
	});

	it("ページが編集フォームに本文の初期値を渡す", () => {
		// IssueStatusSection 経由で title / description / scope / category を渡していないと、
		// 起票者判定は通っても編集フォームに現在の値が入らない。
		// `title=` などは IssueMap 等でも使われるため、渡し先を
		// IssueStatusSection のブロックに絞って見る
		const match = pageSource.match(/<IssueStatusSection[\s\S]*?\/>/);
		expect(match).not.toBeNull();
		const jsx = match?.[0] ?? "";
		for (const prop of ["title=", "description=", "scope=", "category="]) {
			expect(jsx).toContain(prop);
		}
	});
});
