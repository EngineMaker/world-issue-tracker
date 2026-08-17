import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HelpOfferSummary } from "../src/lib/help-offers";

/**
 * `HelpOfferButton` は Client Component で `@clerk/nextjs` の `useAuth` を呼ぶ。
 * 実物はブラウザの Provider を前提にしていて `renderToStaticMarkup` では動かないため、
 * フックとサインインボタンだけを差し替える。
 *
 * ここで固定したいのは Clerk の挙動ではなく「ログイン状態と表明状態の組み合わせで
 * 何が画面に出るか」なので、モックは認証状態を表す値を返すだけの最小のものにする。
 *
 * `mock.module` はモジュール解決より前に評価される必要があるため、
 * テスト対象の import は `beforeAll` の後（動的 import）で行う。
 */
type AuthState = { isLoaded: boolean; isSignedIn: boolean };

/** 現在のテストが「どういうログイン状態か」。各テストから差し替える。 */
let authState: AuthState = { isLoaded: true, isSignedIn: true };

mock.module("@clerk/nextjs", () => ({
	useAuth: () => ({
		...authState,
		// 描画だけを見るテストなのでトークンは使われない
		getToken: async () => "tok_test",
	}),
	// 実物はモーダルを開くボタンを描く。中身（children）が消えていないことを
	// 見たいので、そのまま出すだけのラッパーにする
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

// 静的 import ではなく await import にしているのは、上の `mock.module` が
// 評価されてからテスト対象を読み込ませるため。静的 import は巻き上げられて
// モックの登録より先に解決され、実物の Clerk が読み込まれてしまう。
const { HelpOfferButton, shortUserId } = await import(
	"../src/app/components/HelpOfferButton"
);

const VIEWER = "user_2viewerabcdefgh";
const OTHER = "user_2otherabcdefgh";

function offer(userId: string, id = `offer_${userId}`) {
	return { id, user_id: userId, created_at: "2026-08-01 12:00:00.000" };
}

/**
 * 与えた状態でボタンを描き、静的 HTML を返す。
 *
 * `IssueList` のテスト（`page.test.tsx`）はコンポーネントを関数として直接
 * 呼んでいるが、こちらは `useState` を使う Client Component なので同じ形にできない
 * （フックは React が要素として描画する過程でしか呼べない）。JSX で渡す。
 */
function render(
	summary: HelpOfferSummary | null,
	auth: AuthState = { isLoaded: true, isSignedIn: true },
) {
	authState = auth;
	return renderToStaticMarkup(
		<HelpOfferButton issueId="issue-1" initialSummary={summary} />,
	);
}

/** タグを落として、画面に見えるテキストだけを取り出す。 */
function visibleText(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

const emptySummary: HelpOfferSummary = {
	offers: [],
	total: 0,
	viewerOffered: false,
	viewerUserId: null,
};

describe("HelpOfferButton", () => {
	describe("ボタンの文言", () => {
		it("未表明なら「手伝います」を出す", () => {
			const text = visibleText(render(emptySummary));

			expect(text).toContain("手伝います");
			expect(text).not.toContain("表明を取り消す");
		});

		it("表明済みなら「表明を取り消す」を出す", () => {
			// ここを取り違えると、表明済みの人が押しても取り消せない
			// （あるいはその逆）ことになる
			const text = visibleText(
				render({
					offers: [offer(VIEWER)],
					total: 1,
					viewerOffered: true,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("表明を取り消す");
			// 「手伝います」が別の文（説明文など）に残っていないこと
			expect(text).not.toContain(">手伝います<");
		});

		it("表明済みなら、その旨を文章でも示す", () => {
			const text = visibleText(
				render({
					offers: [offer(VIEWER)],
					total: 1,
					viewerOffered: true,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("あなたはこの Issue に手を挙げています");
		});
	});

	describe("件数の表示", () => {
		it("0 件なら誰も居ないことを伝える", () => {
			const text = visibleText(render(emptySummary));

			expect(text).toContain("まだ誰も手を挙げていません");
		});

		it("件数をそのまま出す", () => {
			const text = visibleText(
				render({
					offers: [offer(VIEWER), offer(OTHER)],
					total: 2,
					viewerOffered: true,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("2 人");
		});
	});

	describe("表明した人の一覧", () => {
		it("自分の表明は「あなた」と出す", () => {
			// `viewer_user_id` を API に足したのは、一覧の中のどれが自分かを
			// 示すため。ここが繋がっていないと足した意味が無い
			const text = visibleText(
				render({
					offers: [offer(VIEWER)],
					total: 1,
					viewerOffered: true,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("あなた");
			// 自分の分が ID 表示になっていないこと
			expect(text).not.toContain("2viewera");
		});

		it("他人の表明は ID を短くして出す", () => {
			const text = visibleText(
				render({
					offers: [offer(OTHER)],
					total: 1,
					viewerOffered: false,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("参加者");
			// Clerk の内部 ID をそのまま画面に出さない
			expect(text).not.toContain(OTHER);
		});

		it("自分と他人が混ざっていても取り違えない", () => {
			const text = visibleText(
				render({
					offers: [offer(OTHER), offer(VIEWER)],
					total: 2,
					viewerOffered: true,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("あなた");
			expect(text).toContain("参加者");
		});

		it("表明が無ければ一覧の見出しごと出さない", () => {
			const text = visibleText(render(emptySummary));

			expect(text).not.toContain("表明した人");
		});
	});

	describe("未ログイン", () => {
		it("ボタンは見せるが、ログインが必要だと伝える", () => {
			// 何ができる場所か分からないままログインを求めない、という
			// 起票フォームと同じ方針
			const text = visibleText(
				render(emptySummary, { isLoaded: true, isSignedIn: false }),
			);

			expect(text).toContain("手伝います");
			expect(text).toContain("ログインが必要です");
		});
	});

	describe("Clerk の読み込み中", () => {
		it("ボタンを押せない状態にする", () => {
			// 読み込み前に押されると、トークンが取れないまま送信して
			// 401 のエラー表示になる
			const html = render(emptySummary, { isLoaded: false, isSignedIn: false });

			expect(html).toContain("disabled");
		});
	});

	describe("表明を取得できなかったとき", () => {
		it("ボタンを出さず、取得できなかったことを伝える", () => {
			// 件数も表明済みかも分からない状態でボタンを出すと、
			// 押した結果がどちらに転ぶか利用者に予測できない
			const html = render(null);
			const text = visibleText(html);

			expect(text).toContain("取得できませんでした");
			expect(html).not.toContain("<button");
		});
	});
});

describe("shortUserId", () => {
	it("`user_` 接頭辞を落として短くする", () => {
		expect(shortUserId("user_2abcdefghijklmnop")).toBe("参加者 2abcdefg");
	});

	it("接頭辞が無くても落ちない", () => {
		expect(shortUserId("abcdefghijk")).toBe("参加者 abcdefgh");
	});

	it("8 文字より短い ID でもそのまま出す", () => {
		expect(shortUserId("user_abc")).toBe("参加者 abc");
	});
});
