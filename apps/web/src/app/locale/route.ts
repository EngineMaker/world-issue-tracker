import { parseLocale } from "@world-issue-tracker/shared";
import { type NextRequest, NextResponse } from "next/server";
import { LOCALE_COOKIE_NAME, LOCALE_COOKIE_OPTIONS } from "../../lib/locale";

/**
 * 表示言語の切り替え（Issue #82）。
 *
 * `GET /locale?lang=en&next=/issues` で Cookie を書いて元のページへ戻す。
 *
 * Route Handler にしている理由:
 * - **リロードしても選択が保たれる。** Client Component の state に持つと
 *   リロードで消える。Server Component が大半のこの画面では、そもそも
 *   クライアントの state をサーバー側の描画に反映できない
 * - **JS 無効でも切り替わる。** 切り替え UI は素の `<a>` なので、
 *   ブラウザが普通に GET して Cookie が付き、リダイレクトで戻る。
 *   フォームや `onClick` にすると JS の実行が前提になる
 *
 * URL のパス（`/en/issues`）にしなかったのは、全ページを `[locale]` の下へ
 * 移す大きな改変になるため。Issue #82 の範囲（文言の外部化と切り替え）に対して
 * 影響範囲が釣り合わない。Cookie なら既存の経路をそのまま使える。
 *
 * 代わりに失うのは「URL を渡せば相手にも同じ言語で見える」ことだが、
 * 読み手が自分の言語で読めることの方が要るという判断（MVP は 2 言語）。
 */
export function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;

	// 未知の値は既定ロケールに倒れる。Cookie に何でも書けるようにしない
	const locale = parseLocale(searchParams.get("lang"));

	const response = NextResponse.redirect(
		new URL(safeNextPath(searchParams.get("next")), request.nextUrl.origin),
	);
	response.cookies.set(LOCALE_COOKIE_NAME, locale, LOCALE_COOKIE_OPTIONS);
	return response;
}

/**
 * 戻り先のパスを検証する。
 *
 * `next` はクエリ文字列なので誰でも好きな値を入れられる。そのまま
 * `new URL(next, origin)` に渡すと `next=https://evil.example` で
 * 別サイトへリダイレクトさせられる（オープンリダイレクト）。
 *
 * 自サイト内の絶対パスだけを通す。`//evil.example` はスキーム相対 URL として
 * 外部を指すため、`/` 始まりでも 2 文字目が `/` のものは弾く。
 * 判定に通らなければトップへ戻す（切り替えたのに何も起きない状態は作らない）。
 */
function safeNextPath(next: string | null): string {
	if (!next) return "/";
	if (!next.startsWith("/")) return "/";
	if (next.startsWith("//")) return "/";
	// `/\evil.example` をブラウザが `//` と解釈する実装があるため合わせて弾く
	if (next.startsWith("/\\")) return "/";
	return next;
}
