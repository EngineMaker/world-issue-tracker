import {
	DEFAULT_LOCALE,
	type Locale,
	parseLocale,
} from "@world-issue-tracker/shared";
import { cookies } from "next/headers";

/**
 * 表示言語を保持する Cookie の名前（Issue #82）。
 *
 * 切り替え（`/locale` の Route Handler）と読み出し（Server Component）の
 * 両方から参照するので、綴りを一箇所に固定する。
 */
export const LOCALE_COOKIE_NAME = "locale";

/**
 * Cookie の保持期間（秒）。1 年。
 *
 * セッション Cookie にすると、ブラウザを閉じた時点で日本語へ戻る。
 * 「リロードしても選択が保たれる」は満たすが、明日開いたら元に戻っている
 * ことになり、日本語を読めない利用者にとっては切り替えていないのと大差ない。
 */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * 切り替え後の Cookie に付ける属性。
 *
 * `httpOnly` は付けない。表示言語は秘密ではなく、将来クライアント側から
 * 読みたくなったときに読めた方がよい。`sameSite=lax` にしているのは、
 * 外部サイトからのリンクで飛んできたときにも選択が効くようにするため
 * （`strict` だと初回の遷移で Cookie が送られず、一瞬日本語で描画される）。
 */
export const LOCALE_COOKIE_OPTIONS = {
	path: "/",
	maxAge: LOCALE_COOKIE_MAX_AGE,
	sameSite: "lax",
} as const;

/**
 * リクエストの Cookie から表示言語を読む。
 *
 * `cookies()` を読むページは動的レンダリングになる。表示言語がリクエストごとに
 * 違う以上、静的化してはいけない画面でもある（`/my-issues` が `auth()` を
 * 読んでいるのと同じ事情）。
 *
 * Cookie は利用者が手で書き換えられるので、値の検証は `parseLocale` に任せる。
 * 未知の値なら既定ロケールに倒れるだけで、画面は落ちない。
 */
export async function getLocale(): Promise<Locale> {
	const store = await cookies();
	return parseLocale(store.get(LOCALE_COOKIE_NAME)?.value);
}

/** ロケールを省略できる呼び出し口のための既定値 */
export { DEFAULT_LOCALE };
