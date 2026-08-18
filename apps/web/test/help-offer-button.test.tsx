import { describe, expect, it, mock } from "bun:test";
import { AUTHOR_LABELS, getUiMessages } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMENTS_SECTION_ID } from "../src/app/components/CommentSection";
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
const { HelpOfferButton } = await import(
	"../src/app/components/HelpOfferButton"
);

const VIEWER = "user_2viewerabcdefgh";
const OTHER = "user_2otherabcdefgh";

function offer(
	userId: string,
	displayName: string | null = null,
	id = `offer_${userId}`,
) {
	return {
		id,
		user_id: userId,
		created_at: "2026-08-01 12:00:00.000",
		display_name: displayName,
	};
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
	locale: "ja" | "en" = "ja",
) {
	authState = auth;
	return renderToStaticMarkup(
		<HelpOfferButton
			issueId="issue-1"
			initialSummary={summary}
			locale={locale}
		/>,
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

		it("他人の表明は Clerk の表示名で出す", () => {
			const text = visibleText(
				render({
					offers: [offer(OTHER, "山田 花子")],
					total: 1,
					viewerOffered: false,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("山田 花子");
			// Clerk の内部 ID は画面に出さない（#108）
			expect(text).not.toContain(OTHER);
			// ID の断片で出す旧実装に戻っていないこと
			expect(text).not.toContain("2otherab");
		});

		// 「名乗ったが Clerk に名前が無い」と「匿名を選んだ」は別の状態で、
		// 同じ言葉で書くと本人の意思を取り違える（#108）
		it("表示名が無い人は匿名とは別の文言で出す", () => {
			const text = visibleText(
				render({
					offers: [offer(OTHER, null)],
					total: 1,
					viewerOffered: false,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("名前未設定の方");
			expect(text).not.toContain("匿名の方");
			expect(text).not.toContain(OTHER);
			expect(text).not.toContain("2otherab");
		});

		it("自分と他人が混ざっていても取り違えない", () => {
			const text = visibleText(
				render({
					offers: [offer(OTHER, "山田 花子"), offer(VIEWER, "自分の名前")],
					total: 2,
					viewerOffered: true,
					viewerUserId: VIEWER,
				}),
			);

			expect(text).toContain("あなた");
			expect(text).toContain("山田 花子");
			// 自分の分は表示名が取れていても「あなた」のまま
			expect(text).not.toContain("自分の名前");
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

// 表示名が無い表明者の文言（#108）。匿名の起票者と同じ言葉になっていないことを、
// 画面の描画とは別に、文言の定義そのものでも押さえる。
// 片方だけを直したときに気付けるよう、ja / en の両方を見る。
describe("表示名が無い表明者の文言", () => {
	it("匿名の起票者とは別の文言になっている", () => {
		for (const locale of ["ja", "en"] as const) {
			const unnamed = getUiMessages(locale).helpOffer.unnamedOfferer;

			expect(unnamed).not.toBe("");
			expect(unnamed).not.toBe(AUTHOR_LABELS[locale].anonymous);
		}
	});
});

/**
 * 手を挙げた後の導線（#114）。
 *
 * `#61` でボタンが入り `#108` で名前も出るようになったが、表明した後に
 * 起票者と表明者が話を進める場所が示されていなかった。押すと
 * 「あなたはこの Issue に手を挙げています」と出てそこで止まる。
 *
 * 閉じた場（DM）は作らないと決めたので（Issue #114 の方針）、
 * 既にすぐ下にあるコメント欄へ進む導線を出すのがこの Issue の範囲。
 * 「導線が出るか」ではなく「押した人がコメント欄へ行けるか」を見たいので、
 * リンク先（アンカー）まで確かめる。
 */
describe("手を挙げた後の導線", () => {
	const offeredSummary: HelpOfferSummary = {
		offers: [offer(VIEWER)],
		total: 1,
		viewerOffered: true,
		viewerUserId: VIEWER,
	};

	it("表明済みなら、コメント欄へ進む導線を出す", () => {
		const html = render(offeredSummary);

		expect(visibleText(html)).toContain(getUiMessages("ja").helpOffer.nextStep);
	});

	it("導線はコメント欄へのリンクになっている", () => {
		// 文言だけ出して行き先が無いと、結局「次に何をすればいいか分からない」
		// ままになる。詳細ページのコメント欄に付けた id を指す。
		//
		// アンカー名は直書きせず、行き先側が公開している定数から組み立てる。
		// リテラルで書くと、定数を変えてリンクとアンカーが揃って追随した
		// （＝壊れていない）ときにもここだけが落ちる。
		// 「リンク先が実在するか」は issue-detail.test.tsx が別に見ている
		const html = render(offeredSummary);

		expect(html).toContain(`href="#${COMMENTS_SECTION_ID}"`);
	});

	it("未表明なら導線を出さない", () => {
		// 手を挙げる前に「どう手伝えるか書いてみましょう」と出ると、
		// 押す前から次の話をされることになり、ボタンの意味がぼやける
		const text = visibleText(render(emptySummary));

		expect(text).not.toContain(getUiMessages("ja").helpOffer.nextStep);
	});

	// 受け入れ条件の「導線の文言が ja / en 両方にある」。辞書にキーがあることは
	// i18n.test.tsx が見ているので、ここでは**英語ロケールで描いたら英語で出るか**を見る。
	// props のロケールを配線し忘れると、辞書に英語があっても画面は日本語のままになる
	it("英語ロケールでは導線も英語で出る", () => {
		const en = getUiMessages("en");
		const text = visibleText(
			render(offeredSummary, { isLoaded: true, isSignedIn: true }, "en"),
		);

		expect(text).toContain(en.helpOffer.nextStep);
		expect(text).toContain(en.helpOffer.nextStepLink);
		expect(text).not.toContain(getUiMessages("ja").helpOffer.nextStep);
		// 導線の周辺に日本語が残っていないこと
		expect(text).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
	});
});
