import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getUiMessages } from "@world-issue-tracker/shared";

/**
 * `NewIssueForm`（起票フォーム）の**ハンドラ配線**を実際に踏むテスト（Issue #138）。
 *
 * これまでの web コンポーネントテストは `renderToStaticMarkup`（SSR で静的 HTML に
 * 落とすだけ）で、onSubmit / onClick の中身が一度も実行されていなかった。
 * そのため `handleSubmit` の分岐（バリデーション → 写真処理中ガード → 送信 →
 * 送信後の初期化）を壊しても CI が緑のまま通っていた。ここでは happy-dom を
 * 登録した DOM 環境（`test/helpers/register-dom.ts`）の上で `@testing-library`
 * が本物のクリック・入力・送信イベントを発火させ、配線を通す。
 *
 * 純粋関数（`validateIssueForm` / `createIssue`）は別テストで検証済みなので、
 * ここで見るのは「どの関数を・どういう分岐で呼ぶか」という配線そのもの。
 */

type AuthState = { isLoaded: boolean; isSignedIn: boolean };

/** 現在のテストが「どういうログイン状態か」。各テストから差し替える。 */
let authState: AuthState = { isLoaded: true, isSignedIn: true };

// `useAuth` は実物がブラウザの Provider を前提にしていて DOM だけでは動かないため、
// フックとサインインボタンだけを差し替える（`reaction-button.test.tsx` と同じ）。
mock.module("@clerk/nextjs", () => ({
	useAuth: () => ({
		...authState,
		getToken: async () => "tok_test",
	}),
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

/**
 * `resizeImageFile` を差し替える（`@/lib/photo`）。
 *
 * 実物はブラウザの `createImageBitmap` / canvas を使うため happy-dom では
 * 動かない。加えて「写真処理中ガード」を踏むには、縮小を**保留させて**
 * `photo.status` を `"processing"` のまま留める必要がある。テストごとに
 * 挙動を差し替えられるよう、実装を変数に持たせる。
 */
type ResizeResult =
	| { ok: true; file: File }
	| { ok: false; reason: "too-large" | "unreadable" };
let resizeImpl: (file: File) => Promise<ResizeResult> = async (file) => ({
	ok: true,
	file,
});
mock.module("@/lib/photo", () => ({
	resizeImageFile: (file: File) => resizeImpl(file),
	createThumbnailFile: async () => null,
}));

// 静的 import ではなく await import にしているのは、上の `mock.module` が
// 評価されてからテスト対象を読み込ませるため（既存テストと同じ作法）。
const { NewIssueForm } = await import("../src/app/components/NewIssueForm");

const messages = getUiMessages("ja");

/** `createIssue` が投げる POST を捕まえる。実ネットワークへは出さない。 */
let fetchCalls: Array<{ url: string }> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
	fetchCalls = [];
	authState = { isLoaded: true, isSignedIn: true };
	resizeImpl = async (file) => ({ ok: true, file });
	globalThis.fetch = (async (url: string | URL) => {
		fetchCalls.push({ url: String(url) });
		return new Response(JSON.stringify({ id: "issue-xyz" }), { status: 200 });
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	cleanup();
	globalThis.fetch = originalFetch;
});

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
	await user.type(
		screen.getByLabelText(messages.newIssue.title),
		"困りごとの題",
	);
	await user.type(
		screen.getByLabelText(messages.newIssue.description),
		"本文の説明",
	);
}

describe("NewIssueForm の起票ハンドラ", () => {
	it("送信で createIssue が呼ばれ、成功表示が出て、フォームが初期化される", async () => {
		const user = userEvent.setup();
		render(<NewIssueForm locale="ja" />);

		await fillRequired(user);
		await user.click(
			screen.getByRole("button", { name: messages.newIssue.submit }),
		);

		// Issue 作成 API へ 1 回だけ POST される
		await waitFor(() => expect(fetchCalls.length).toBe(1));
		expect(fetchCalls[0].url).toContain("/issues");

		// 成功表示（`IssueCreated`）が、作成された ID を伴って出る
		await waitFor(() => expect(screen.getByText(/issue-xyz/)).toBeDefined());

		// 題の欄が初期化されている。残ると次の起票に前の入力が持ち越される
		const title = screen.getByLabelText(
			messages.newIssue.title,
		) as HTMLInputElement;
		expect(title.value).toBe("");
	});

	it("空のまま送信するとバリデーションで止まり、createIssue を呼ばない", async () => {
		const user = userEvent.setup();
		render(<NewIssueForm locale="ja" />);

		await user.click(
			screen.getByRole("button", { name: messages.newIssue.submit }),
		);

		// 不正な入力をネットワークへ出さない
		expect(fetchCalls.length).toBe(0);
		// 送信エラーが表示される。
		// `toBeNull()`（およびその否定）は happy-dom の要素に対して
		// 期待どおり働かない場合があるため、件数で見る
		await waitFor(() =>
			expect(document.querySelectorAll(".text-danger").length).toBeGreaterThan(
				0,
			),
		);
	});

	it("写真の処理中に送信しても createIssue を呼ばず、準備中を伝える", async () => {
		const user = userEvent.setup();
		render(<NewIssueForm locale="ja" />);

		await fillRequired(user);

		// 縮小を保留させ、`photo.status` を "processing" のまま留める
		resizeImpl = () => new Promise<ResizeResult>(() => {});
		const input = document.getElementById("photo") as HTMLInputElement;
		const file = new File(["x"], "p.jpg", { type: "image/jpeg" });
		await user.upload(input, file);

		await user.click(
			screen.getByRole("button", { name: messages.newIssue.submit }),
		);

		// 写真の付かない Issue を黙って作らない
		expect(fetchCalls.length).toBe(0);
		await waitFor(() =>
			expect(screen.getByText(messages.newIssue.photoNotReady)).toBeDefined(),
		);
	});

	it("写真を添付した起票が成功すると、写真プレビューがクリアされる", async () => {
		const user = userEvent.setup();
		render(<NewIssueForm locale="ja" />);

		await fillRequired(user);

		// 写真を選び、ready 状態（プレビュー＋「写真を外す」）になるまで待つ
		const input = document.getElementById("photo") as HTMLInputElement;
		await user.upload(input, new File(["x"], "p.jpg", { type: "image/jpeg" }));
		await waitFor(() =>
			expect(
				screen.queryAllByText(messages.newIssue.photoRemove).length,
			).toBeGreaterThan(0),
		);

		await user.click(
			screen.getByRole("button", { name: messages.newIssue.submit }),
		);

		await waitFor(() => expect(fetchCalls.length).toBe(1));
		await waitFor(() => expect(screen.getByText(/issue-xyz/)).toBeDefined());

		// 送信成功後、写真プレビューが消えている（`clearPhoto()`）。
		// 残ると次の起票に前の写真が持ち越される（Issue #138 が名指しした退行）
		expect(screen.queryAllByText(messages.newIssue.photoRemove).length).toBe(0);
	});
});
