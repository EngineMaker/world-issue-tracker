import { clerkMiddleware } from "@hono/clerk-auth";
import type { Context, Next } from "hono";

/**
 * 認証が必要なルートにだけ差す Clerk ミドルウェア。
 *
 * `clerkMiddleware()` を `app.use()` で全ルートに適用すると、Clerk のキーが
 * 欠けている環境では公開エンドポイント（`/`, `/health`, `GET /issues`）まで
 * 500 になる。`@hono/clerk-auth` はキーが無いと即座に throw するためで、
 * 「wrangler secret の設定漏れで、ログイン不要で読めるはずの一覧と地図が全滅する」
 * という壊れ方をする。ヘルスチェックまで落ちるので監視から見ると DB 障害と
 * 区別がつかない。
 *
 * そこで適用範囲を書き込み系に絞ったうえで、ここで例外を受け止める。
 * 認証情報が入っていない状態で先へ進めるので、後段の `requireAuth` が 401 を返す
 * （書き込みが素通りすることはない）。設定不備を 401 として隠すことになるため、
 * `console.error` で必ずログに残す。
 *
 * この形なら、将来 GET で認証情報を任意利用したくなったときも、そのルートに
 * これを差すだけで済む（キー不在時は「未ログイン扱い」で公開部分が生き残る）。
 */
export function clerkAuth() {
	const middleware = clerkMiddleware();

	return async function withClerk(c: Context, next: Next) {
		try {
			return await middleware(c, next);
		} catch (err) {
			// 握り潰してよいのは Clerk 側の失敗（キー不足、問い合わせ失敗）だけ。
			// どちらも「認証情報を取得できなかった」＝未認証として扱う。
			//
			// この try は `middleware(c, next)` 全体、つまり `next()` の先まで
			// 囲んでいる。現在の Hono では後段（ミドルウェア・ハンドラとも）の例外は
			// compose が先に捕まえて onError に回すため、実測ではここに届かない。
			// それでもガードを置いているのは、ここが握り潰す側だから。前提が崩れて
			// 素通りすると、後段の障害が「未認証で続行」に化けて 200 で消える。
			//
			// `clerkMiddleware` は認証が済んだ時点で `c.set("clerkAuth", fn)` して
			// から `next()` を呼ぶので、それが入っていれば Clerk 由来ではない。
			if (typeof c.get("clerkAuth") === "function") {
				throw err;
			}

			console.error("Clerk middleware failed; continuing unauthenticated", err);
			await next();
		}
	};
}
