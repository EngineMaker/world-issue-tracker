import { describe, expect, it, mock } from "bun:test";
import { getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactionSummary } from "../src/lib/reactions";

/**
 * `ReactionButton` は Client Component で `@clerk/nextjs` の `useAuth` を呼ぶ。
 * 実物はブラウザの Provider を前提にしていて `renderToStaticMarkup` では動かないため、
 * フックとサインインボタンだけを差し替える（`help-offer-button.test.tsx` と同じ）。
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
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

// 静的 import ではなく await import にしているのは、上の `mock.module` が
// 評価されてからテスト対象を読み込ませるため。
const { ReactionButton } = await import("../src/app/components/ReactionButton");

function render(
	summary: ReactionSummary | null,
	auth: AuthState = { isLoaded: true, isSignedIn: true },
) {
	authState = auth;
	return renderToStaticMarkup(
		<ReactionButton issueId="issue-1" initialSummary={summary} />,
	);
}

/** タグを落として、画面に見えるテキストだけを取り出す。 */
function visibleText(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

const emptySummary: ReactionSummary = { total: 0, viewerReacted: false };

describe("ReactionButton", () => {
	describe("ボタンの文言", () => {
		it("未反応なら「私も困っている」を出す", () => {
			const text = visibleText(render(emptySummary));

			expect(text).toContain("私も困っている");
			expect(text).not.toContain("反応を取り消す");
		});

		it("反応済みなら「反応を取り消す」を出す", () => {
			// ここを取り違えると、反応済みの人が押しても取り消せない
			// （あるいはその逆）ことになる
			const text = visibleText(render({ total: 1, viewerReacted: true }));

			expect(text).toContain("反応を取り消す");
		});

		it("反応済みなら、その旨を文章でも示す", () => {
			// ボタンの文言だけだと「取り消せる ＝ 自分は押している」を
			// 読み取る必要がある。受け入れ条件の「自分が押したかどうかが
			// 画面から分かる」を満たすため、状態そのものも文章で出す
			const text = visibleText(render({ total: 3, viewerReacted: true }));

			expect(text).toContain("あなたはこの Issue に反応しています");
		});
	});

	describe("件数の表示", () => {
		it("0 件なら誰も居ないことを伝える", () => {
			const text = visibleText(render(emptySummary));

			expect(text).toContain("まだ誰も反応していません");
		});

		it("件数をそのまま出す", () => {
			// 「何人が同じことで困っているか」がこの機能の唯一の情報なので、
			// 数がそのまま出ることを見る
			const text = visibleText(render({ total: 12, viewerReacted: false }));

			expect(text).toContain("12");
		});
	});

	// #112 の中心的な決定。誰が押したかは画面にも出さない。
	//
	// API が返さないので出しようが無いが、将来 `user_id` を足す変更が
	// あったときに、画面側にも見張りがある状態にしておく。
	describe("反応した人", () => {
		it("反応した人の一覧を出さない", () => {
			const html = render({ total: 5, viewerReacted: true });

			// 「手伝います」にはある見出し（`offerersHeading`）に相当するものが
			// こちらには無い
			expect(html).not.toContain("<h3");
			expect(html).not.toContain("<ul");
			expect(html).not.toContain("<li");
		});
	});

	// 「手伝います」と同じ画面に並ぶので、言葉で意味の違いが伝わること（#112 の 2）。
	describe("「手伝います」との区別", () => {
		it("見出しが「困っている人」になっている", () => {
			const text = visibleText(render(emptySummary));

			expect(text).toContain("困っている人");
		});

		it("「手伝います」の見出しと同じ言葉になっていない", () => {
			// 両方が同じ見出しだと、同じ画面に並んだときに区別が付かない。
			// 「動く人」と「困っている人」の対であることを固定する
			const messages = getUiMessages("ja");

			expect(messages.reaction.heading).not.toBe(messages.helpOffer.heading);
			expect(messages.reaction.react).not.toBe(messages.helpOffer.offer);
		});

		it("見出しの id が「手伝います」と衝突しない", () => {
			// 同じページに両方が出る。`aria-labelledby` が指す id が重複すると、
			// 読み上げがどちらの見出しを読むか定まらない
			const html = render(emptySummary);

			expect(html).toContain('id="reactions-heading"');
			expect(html).not.toContain('id="help-offers-heading"');
		});
	});

	describe("未ログイン", () => {
		it("ボタンは見せるが、ログインが必要だと伝える", () => {
			const text = visibleText(
				render(emptySummary, { isLoaded: true, isSignedIn: false }),
			);

			expect(text).toContain("私も困っている");
			expect(text).toContain("ログインが必要です");
		});
	});

	describe("Clerk の読み込み中", () => {
		it("ボタンを押せない状態にする", () => {
			// 読み込みが終わる前に押せてしまうと、トークンが取れずに
			// 「ログインが必要です」と言われる。ログインしているのに
			const html = render(emptySummary, {
				isLoaded: false,
				isSignedIn: false,
			});

			expect(html).toContain("disabled");
		});
	});

	describe("反応を取得できなかったとき", () => {
		it("ボタンを出さず、取得できなかったことを伝える", () => {
			// 件数が分からない状態でボタンだけ出すと、押した結果が
			// 正しいのかどうかも分からない
			const html = render(null);

			expect(visibleText(html)).toContain("反応を取得できませんでした");
			expect(html).not.toContain("<button");
		});
	});
});

describe("反応の文言", () => {
	it("ja / en の両方に揃っている", () => {
		// 型が `Record<Locale, UiMessages>` なので片方だけだと `check` が
		// 落ちるが、値が空文字でも型は通る。実際に文言が入っていることを見る
		for (const locale of ["ja", "en"] as const) {
			const { reaction } = getUiMessages(locale);

			expect(reaction.heading.length).toBeGreaterThan(0);
			expect(reaction.react.length).toBeGreaterThan(0);
			expect(reaction.withdraw.length).toBeGreaterThan(0);
			expect(reaction.none.length).toBeGreaterThan(0);
			expect(reaction.count(3)).toContain("3");
			expect(reaction.cardCount(3)).toContain("3");
		}
	});

	it("ja と en で別の言語になっている", () => {
		// 片方をコピーしただけだと、ロケールを切り替えても文言が変わらない
		expect(getUiMessages("ja").reaction.react).not.toBe(
			getUiMessages("en").reaction.react,
		);
	});

	it("「いいね」を使っていない", () => {
		// 困りごとに親指を立てるのは意味が合わない（#112 の決定 1）。
		// 語彙が「共感の表明」から「評価」へ滑ると、この機能の意味が変わる
		for (const locale of ["ja", "en"] as const) {
			const serialized = JSON.stringify(
				getUiMessages(locale).reaction,
				(_key, value) => (typeof value === "function" ? value(1) : value),
			);

			expect(serialized).not.toContain("いいね");
			expect(serialized.toLowerCase()).not.toContain("like");
		}
	});
});
