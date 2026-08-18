/**
 * 自分のコメントの削除（#99）。
 *
 * この Issue の要点は「取り消せないことが、書くことのハードルを上げる」。
 * 消せること自体は API のテスト（`apps/api/test/comments.test.ts`）が
 * 見ているので、こちらは **削除ボタンが誰に見えるか** を押さえる。
 *
 * ここが崩れると、他人のコメントに削除ボタンが出る（押しても API が 403 で
 * 弾くが、消せるように見せて失敗させるのは出さないより悪い）か、
 * 自分のコメントにも出ない（この Issue が直そうとした状態のまま）。
 */

import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUiMessages, Locale } from "@world-issue-tracker/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { type PublicComment, parsePublicComment } from "../src/lib/comments";

// `CommentSection` は Client Component で `@clerk/nextjs` の `useAuth` を呼ぶ。
// 実物はブラウザの Provider を前提にしていて `renderToStaticMarkup` では
// 動かないため、フックとサインインボタンだけを差し替える
// （`author-display.test.tsx` と同じ形）。
mock.module("@clerk/nextjs", () => ({
	useAuth: () => ({
		isLoaded: true,
		isSignedIn: true,
		getToken: async () => "tok_test",
	}),
	SignInButton: ({ children }: { children: React.ReactNode }) => children,
}));

// 静的 import は巻き上げられて `mock.module` より先に解決されるため、
// テスト対象は動的 import で読み込む。
const { CommentSection } = await import("../src/app/components/CommentSection");

const ISSUE_ID = "ebbcf9d7680ad57cedeeb513a90d461f";

const commentResponse = {
	id: "c1",
	issue_id: ISSUE_ID,
	body: "近所でも同じことが起きています",
	created_at: "2026-08-01 12:30:00.000",
	is_anonymous: false,
	display_name: "花子 山田",
	viewer_is_author: false,
};

function comment(overrides: Record<string, unknown>): PublicComment {
	const parsed = parsePublicComment({ ...commentResponse, ...overrides });
	if (!parsed) throw new Error("サンプルがパースできない");
	return parsed;
}

function renderComments(
	comments: PublicComment[],
	locale?: (typeof Locale.options)[number],
): string {
	return renderToStaticMarkup(
		<CommentSection
			issueId={ISSUE_ID}
			initialResult={{ ok: true, comments, total: comments.length }}
			locale={locale}
		/>,
	);
}

/**
 * 描画結果に出ている削除ボタンの数。
 *
 * 文言そのものではなくボタンとして数える。「削除」という語は確認の
 * 問いかけにも出るため、文字列を数えると実際より多く見える。
 */
function countDeleteButtons(
	markup: string,
	locale: "ja" | "en" = "ja",
): number {
	const label = getUiMessages(locale).comments.delete;
	return markup.split(`>${label}</button>`).length - 1;
}

describe("コメントの削除ボタン", () => {
	it("自分のコメントには出る", () => {
		const markup = renderComments([comment({ viewer_is_author: true })]);

		expect(countDeleteButtons(markup)).toBe(1);
	});

	it("他人のコメントには出ない", () => {
		// 生の `user_id` は公開されないので、判定できるのは API が返す
		// `viewer_is_author` だけ。ここを取り違えると他人の発言に
		// 削除ボタンが並ぶ
		const markup = renderComments([comment({ viewer_is_author: false })]);

		expect(countDeleteButtons(markup)).toBe(0);
	});

	it("自分のものだけに出る（混在した一覧）", () => {
		const markup = renderComments([
			comment({ id: "a", viewer_is_author: false }),
			comment({ id: "b", viewer_is_author: true }),
			comment({ id: "c", viewer_is_author: false }),
		]);

		expect(countDeleteButtons(markup)).toBe(1);
	});

	it("押す前は確認の文言を出さない", () => {
		// 確認は押してから同じカードの中に出る。最初から出ていると、
		// 何もしていないのに消そうとしているように見える
		const markup = renderComments([comment({ viewer_is_author: true })]);

		expect(markup).not.toContain(getUiMessages("ja").comments.deleteConfirm);
	});

	it("ja / en の両方に文言がある", () => {
		for (const locale of Locale.options) {
			const { comments } = getUiMessages(locale);
			for (const text of [
				comments.delete,
				comments.deleteConfirm,
				comments.deleteConfirmYes,
				comments.deleteConfirmCancel,
				comments.deleting,
				comments.deleteFailed,
				comments.deleteSignInRequired,
			]) {
				expect(text.length).toBeGreaterThan(0);
			}
		}
	});

	it("英語で描画すると英語のボタンが出る", () => {
		// 辞書にあるだけで画面が日本語のままなら意味が無い（i18n.test.tsx と同じ観点）
		const markup = renderComments([comment({ viewer_is_author: true })], "en");

		expect(countDeleteButtons(markup, "en")).toBe(1);
		expect(countDeleteButtons(markup, "ja")).toBe(0);
	});
});

/**
 * 画面と API の結線。
 *
 * 本来はボタンを押して `deleteComment` が呼ばれることを確かめたいが、
 * web にはクリックや `useEffect` を走らせられるテスト基盤が無い
 * （DOM 環境も testing-library も依存に無い）。`renderToStaticMarkup` は
 * 初期描画の文字列しか出さないので、**「ボタンは出ているが押しても何も
 * 起きない」「取り直しが消えている」を描画結果からは見分けられない。**
 *
 * どちらも起きると Issue #99 が未解決の状態に戻る（消したつもりで消えて
 * いない／自分のコメントにも削除ボタンが出ない）のに、テストは緑のままに
 * なる。実際にレビューで作った変異体（`deleteComment` の呼び出しを消す、
 * `useEffect` を丸ごと無効化する）は web の 777 件すべてを通過した。
 *
 * そこで、せめて経路がソース上に在ることを確かめる。`style-coverage.test.tsx`
 * が「値が正しいか」ではなく「そもそも書かれているか」を静的に見ているのと
 * 同じ考え方。実装の書き方を変えたらここも直す必要があるが、**黙って経路が
 * 消えるよりは、書き換えのたびに目を通す方がよい。**
 */
describe("画面と API の結線（ソース上の確認）", () => {
	const source = readFileSync(
		join(import.meta.dir, "../src/app/components/CommentSection.tsx"),
		"utf8",
	);

	it("削除の確定ボタンが handleDelete を呼ぶ", () => {
		expect(source).toContain("onClick={() => handleDelete(comment.id)}");
	});

	it("handleDelete が API の deleteComment を呼ぶ", () => {
		// ここが消えると、画面上はカードが減るのに DB には残る
		expect(source).toMatch(/await deleteComment\(\s*issueId,\s*commentId,/);
	});

	it("削除に成功した後に手元の一覧から取り除く", () => {
		expect(source).toMatch(
			/current\.filter\(\(comment\) => comment\.id !== commentId\)/,
		);
	});

	it("マウント後に viewer_is_author を取り直す", () => {
		// 詳細ページ（Server Component）はトークンを渡さないため、SSR の一覧は
		// 全件 false で返る。この取り直しが本番で削除ボタンが出る唯一の経路
		expect(source).toContain("useEffect(");
		expect(source).toMatch(/fetchComments\(issueId, \{\s*token:/);
		expect(source).toMatch(/applyViewerFlags\(current, result\.comments\)/);
	});
});
