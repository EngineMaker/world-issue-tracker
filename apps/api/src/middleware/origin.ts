import type { Context, Next } from "hono";

/**
 * Origin 検証を免除する、副作用の無いメソッド。
 *
 * `OPTIONS` は実際にはここまで来ない（先に登録された `hono/cors` がプリフライトを
 * 204 で返して短絡させる）。cors を外した場合にプリフライトが 403 になるのを
 * 防ぐための備えとして残してある。
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `Authorization: Bearer <token>` の形（トークン部が空でないもの）にだけ一致する。 */
const BEARER_TOKEN_RE = /^Bearer\s+\S/;

/**
 * リクエストが `Authorization` ヘッダで Bearer トークンを運んでいるか。
 *
 * `@clerk/backend` の `parseAuthorizationHeader` はスキーム無しの裸トークンも
 * 受け付けるが、ここでは意図的に `Bearer <token>` だけを認めている。
 * 裸トークンまで認めると `Authorization: "Bearer "` のような値が
 * 「`Bearer` という名前の裸トークン」と解釈され、中身の無いヘッダひとつで
 * Origin 検証を免除できてしまうため。
 *
 * この判定はこちらの方が Clerk より狭い。狭い側にズレた場合に起きるのは
 * 「Clerk は認証を通すが Origin 検証も要求される」であって、防御が緩む向きの
 * 食い違いは生じない。
 */
function hasAuthorizationToken(c: Context): boolean {
	return BEARER_TOKEN_RE.test(c.req.header("Authorization") ?? "");
}

/**
 * 書き込み系リクエストの `Origin` ヘッダを許可リストと照合する。
 *
 * Clerk は `Authorization` ヘッダが無ければ Cookie (`__session`) 経路で認証する。
 * この経路には Origin 照合も `Sec-Fetch-Site` チェックも無いため、何もしないと
 * 悪意あるサイトからログイン中ユーザーの権限で書き込みができてしまう。
 * CORS は「レスポンスをスクリプトに読ませない」仕組みであって、simple request
 * （`text/plain` など）の送信自体は止めないので、サーバー側で明示的に弾く。
 *
 * `hono/csrf` は Content-Type が form 系のときしか検証しないため使っていない。
 * ここでは Content-Type によらず、書き込み系はすべて Origin を必須にしている。
 */
export function requireAllowedOrigin(allowedOrigins: readonly string[]) {
	return async function checkOrigin(c: Context, next: Next) {
		if (SAFE_METHODS.has(c.req.method)) {
			return next();
		}

		// Bearer トークンは攻撃者のサイトからは付けられない（Cookie と違って
		// ブラウザが自動送信しないうえ、付けるとプリフライトが必須になる）ため、
		// CSRF の経路にならない。API クライアントからの利用を塞がないよう、
		// この場合は Origin を問わない。
		if (hasAuthorizationToken(c)) {
			return next();
		}

		const origin = c.req.header("Origin");
		if (!origin || !allowedOrigins.includes(origin)) {
			return c.json({ error: "Forbidden" }, 403);
		}

		return next();
	};
}
