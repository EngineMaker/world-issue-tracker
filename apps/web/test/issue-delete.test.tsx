/**
 * 起票者による Issue 自体の削除（#144）。
 *
 * API 側（`DELETE /issues/:id`）は所有者限定の物理削除を写真・サムネイルの
 * 後始末込みで実装済みだったが、そこへ到達する導線が画面に無かった。
 * この Issue の要点は「起票者が自分の投稿を取り下げられない」ことなので、
 * 通信部分（`lib/issue-status.ts` の `deleteIssue`）と、**削除ボタンが誰に
 * 見えるか**（`DeleteIssueButton`）の両方を押さえる。
 *
 * 消せること自体は API のテスト（`apps/api/test/issues.test.ts`）が見ている。
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUiMessages, Locale } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";

// `DeleteIssueButton` は Client Component で `@clerk/nextjs` の `useAuth` と
// `next/navigation` の `useRouter` を呼ぶ。実物はブラウザの Provider を
// 前提にしていて `renderToStaticMarkup` では動かないため、使うぶんだけ
// 差し替える（`issue-status.test.tsx` と同じ形）。
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
const { deleteIssue, DeleteIssueError } = await import(
	"../src/lib/issue-status"
);
const { DeleteIssueButton } = await import(
	"../src/app/components/DeleteIssueButton"
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

describe("deleteIssue", () => {
	it("DELETE /issues/:id を呼び、トークンを Authorization に載せる", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		// API は削除した Issue を 200 で返すが、成功なら中身は使わない
		const { fetch, calls } = stubFetch(new Response(null, { status: 200 }));

		await deleteIssue("issue-1", "tok_abc", { fetchImpl: fetch });

		expect(calls[0].url).toBe("https://api.example.com/issues/issue-1");
		const init = calls[0].init as {
			method: string;
			headers: Record<string, string>;
		};
		expect(init.method).toBe("DELETE");
		expect(init.headers.Authorization).toBe("Bearer tok_abc");
	});

	it("ID をパスに埋める前にエンコードする", async () => {
		process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
		const { fetch, calls } = stubFetch(new Response(null, { status: 200 }));

		await deleteIssue("../health", "tok_abc", { fetchImpl: fetch });

		expect(calls[0].url).toBe("https://api.example.com/issues/..%2Fhealth");
	});

	// 未ログインなら API を叩いても 401 が返るだけ。往復せず 401 で投げる
	it("トークンが無ければ API を呼ばず 401 のエラーを投げる", async () => {
		const { fetch, calls } = stubFetch(new Response(null, { status: 200 }));

		let caught: unknown;
		try {
			await deleteIssue("issue-1", null, { fetchImpl: fetch });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(DeleteIssueError);
		expect((caught as DeleteIssueError).status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	// 403（他人の Issue）・404（既に削除済み）は status を保って投げ、
	// 画面側が文言を選べるようにする
	it("API が失敗を返したら status 付きの DeleteIssueError を投げる", async () => {
		for (const status of [401, 403, 404, 500]) {
			const { fetch } = stubFetch(new Response(null, { status }));

			let caught: unknown;
			try {
				await deleteIssue("issue-1", "tok_abc", { fetchImpl: fetch });
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(DeleteIssueError);
			expect((caught as DeleteIssueError).status).toBe(status);
		}
	});

	it("通信が落ちたら DeleteIssueError（status: null）を投げる", async () => {
		let caught: unknown;
		await withSilencedError(async () => {
			try {
				await deleteIssue("issue-1", "tok_abc", {
					fetchImpl: (() => {
						throw new Error("network down");
					}) as unknown as typeof globalThis.fetch,
				});
			} catch (err) {
				caught = err;
			}
		});

		expect(caught).toBeInstanceOf(DeleteIssueError);
		expect((caught as DeleteIssueError).status).toBeNull();
	});

	it("成功（2xx）なら例外を投げない", async () => {
		const { fetch } = stubFetch(new Response(null, { status: 200 }));

		expect(
			deleteIssue("issue-1", "tok_abc", { fetchImpl: fetch }),
		).resolves.toBeUndefined();
	});
});

/**
 * 削除ボタンの描画（`DeleteIssueButton`）。
 *
 * この部品は「起票者だと確定しているとき」にしか `IssueStatusSection` から
 * 描画されない。ここでは部品を直接描画して、初期状態でボタンと文言が
 * 正しく出ることを見る（コメント削除の `countDeleteButtons` と同じ考え方）。
 */
describe("Issue の削除ボタン", () => {
	/** 描画結果に出ている「削除」ボタンの数（確認前のもの）。 */
	function countDeleteButtons(
		markup: string,
		locale: "ja" | "en" = "ja",
	): number {
		const label = getUiMessages(locale).issueDetail.delete;
		return markup.split(`>${label}</button>`).length - 1;
	}

	function render(locale?: (typeof Locale.options)[number]): string {
		return renderToStaticMarkup(
			<DeleteIssueButton issueId="issue-1" locale={locale} />,
		);
	}

	it("削除ボタンを出す", () => {
		expect(countDeleteButtons(render())).toBe(1);
	});

	// 確認は押してから同じ場所に出る。最初から出ていると、何もしていないのに
	// 消そうとしているように見える（コメント削除と同じ作法）
	it("押す前は確認の文言を出さない", () => {
		expect(render()).not.toContain(
			getUiMessages("ja").issueDetail.deleteConfirm,
		);
	});

	it("英語で描画すると英語のボタンが出る", () => {
		// 辞書にあるだけで画面が日本語のままなら意味が無い（i18n.test.tsx と同じ観点）
		const markup = render("en");

		expect(countDeleteButtons(markup, "en")).toBe(1);
		expect(countDeleteButtons(markup, "ja")).toBe(0);
	});

	it("ja / en の両方に文言がある", () => {
		for (const locale of Locale.options) {
			const { issueDetail } = getUiMessages(locale);
			for (const text of [
				issueDetail.delete,
				issueDetail.deleteConfirm,
				issueDetail.deleteConfirmYes,
				issueDetail.deleteConfirmCancel,
				issueDetail.deleting,
				issueDetail.deleteFailed,
				issueDetail.deleteSignInRequired,
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
 * 「起票者判定を通らず誰にでも削除ボタンが出る」を描画結果からは
 * 見分けられない（コメント削除 #99 と同じ制約。web に DOM テスト基盤が無い）。
 *
 * どちらも起きるとこの Issue が未解決の状態に戻る（消したつもりで消えない／
 * 起票者以外に削除ボタンが出る）のにテストは緑のままになる。そこで、せめて
 * 経路がソース上に在ることを確かめる。実装の書き方を変えたらここも直す必要が
 * あるが、黙って経路が消えるよりは、書き換えのたびに目を通す方がよい。
 */
describe("画面と API の結線（ソース上の確認）", () => {
	const buttonSource = readFileSync(
		join(import.meta.dir, "../src/app/components/DeleteIssueButton.tsx"),
		"utf8",
	);
	const sectionSource = readFileSync(
		join(import.meta.dir, "../src/app/components/StatusControl.tsx"),
		"utf8",
	);

	it("削除ボタンは起票者と確定したときだけ描画する", () => {
		// ここが崩れると、判定前や起票者以外にも削除ボタンが出る
		expect(sectionSource).toMatch(
			/isOwner && <DeleteIssueButton issueId=\{issueId\}/,
		);
	});

	it("起票者判定を削除側で叩き直さない（/viewer は 1 回）", () => {
		// 削除の導線は StatusControl の起票者判定を土台に共有する（#144 の依存メモ）。
		// `DeleteIssueButton` が自前で `/viewer`（fetchViewerRelation）を呼ぶと二重になる
		expect(buttonSource).not.toContain("fetchViewerRelation");
	});

	it("確定ボタンが handleDelete を呼ぶ", () => {
		expect(buttonSource).toContain("onClick={handleDelete}");
	});

	it("handleDelete が API の deleteIssue を呼ぶ", () => {
		// ここが消えると、画面は一覧へ遷移するのに DB には残る
		expect(buttonSource).toMatch(/await deleteIssue\(issueId,/);
	});

	it("削除に成功したら一覧へ戻す", () => {
		expect(buttonSource).toContain('router.push("/issues")');
	});
});
