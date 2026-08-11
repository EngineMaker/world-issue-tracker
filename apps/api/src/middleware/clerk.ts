import { clerkMiddleware } from "@hono/clerk-auth";
import { clerkKeyKind } from "@world-issue-tracker/shared";
import type { Context, Next } from "hono";

/**
 * 開発用インスタンスのキーで動いていることをログに残す（#98）。
 *
 * web 側は本番ビルドの手前で検査して落とせる（`apps/web/scripts/check-clerk-keys.ts`）
 * が、API のキーは Workers Secrets にあり、ビルド時にはまだ存在しない。
 * デプロイを止める形にはできないので、実行時に気付ける形にする。
 *
 * ステータスを変えたりリクエストを止めたりはしない。開発用キーでも認証自体は
 * 成立しており、ここで 500 にすると「上限に達したら止まる」を「今すぐ全部止まる」に
 * 悪化させるだけだから。目的は、Observability のログを見たときに
 * 設定の食い違いが分かることに限る。
 *
 * リクエストごとに出すとログが埋まるので、Worker のインスタンスごとに 1 回だけ。
 * キーが変わればワーカーが入れ替わるので、切り替え後は再び評価される。
 */
let warnedKeyKind: string | null = null;

function warnOnDevelopmentKeys(c: Context): void {
	// 種別ごとに 1 回。secret と publishable で食い違っている場合も
	// それぞれの組み合わせで一度は出る。
	const secretKind = clerkKeyKind(c.env?.CLERK_SECRET_KEY);
	const publishableKind = clerkKeyKind(c.env?.CLERK_PUBLISHABLE_KEY);
	if (secretKind !== "development" && publishableKind !== "development") {
		return;
	}

	const signature = `${secretKind}:${publishableKind}`;
	if (warnedKeyKind === signature) {
		return;
	}
	warnedKeyKind = signature;

	console.warn(
		"Clerk is running with development instance keys (#98): " +
			`CLERK_SECRET_KEY=${secretKind ?? "unset/unknown"}, ` +
			`CLERK_PUBLISHABLE_KEY=${publishableKind ?? "unset/unknown"}. ` +
			"Development instances have Clerk-side user limits and will stop " +
			"accepting sign-ins once reached. Switch both api and web to pk_live_/sk_live_ keys.",
	);
}

/**
 * キー種別の警告だけを行うミドルウェア（#98）。`app.use()` で全リクエストに差す。
 *
 * `clerkAuth()` の中ではなくここに切り出しているのは、`clerkAuth()` が
 * 書き込み系のルートにしか差さっていないため。閲覧者しか来ていない期間や、
 * 公開 GET だけを処理して入れ替わった Worker インスタンスでは警告が一度も出ない。
 * 「開発用キーで動いている」という最も知りたい状況が、最もログに出にくくなる。
 *
 * ここでは `clerkMiddleware` を呼ばない。呼ぶとキー不在時に公開エンドポイントまで
 * 500 になる（`clerkAuth()` の説明にあるとおり）。env の文字列を見るだけなので、
 * 認証の経路にも可用性にも影響しない。
 */
export function clerkKeyKindWarning() {
	return async function withClerkKeyWarning(c: Context, next: Next) {
		warnOnDevelopmentKeys(c);
		await next();
	};
}

/** テスト用。Worker インスタンスをまたいだ状態を持ち越さないためのリセット。 */
export function resetClerkKeyWarning(): void {
	warnedKeyKind = null;
}

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
