import { getAuth } from "@hono/clerk-auth";
import type { Context, Next } from "hono";

/**
 * Clerk の認証結果がコンテキストに載っているか。
 *
 * `clerkMiddleware` は `c.set("clerkAuth", fn)` に「関数」を入れ、`getAuth` は
 * それを `c.get("clerkAuth")(options)` と即座に呼ぶ。つまり Clerk が
 * 初期化に失敗して何も入っていない状態で `getAuth` を呼ぶと、未認証を表す
 * `undefined` ではなく TypeError になる。
 *
 * `clerkAuth()`（middleware/clerk.ts）はキー不在時に例外を握って未認証のまま
 * 先へ進めるので、その状態でここが落ちないよう `getAuth` の手前で確認する。
 */
function hasClerkAuth(c: Context): boolean {
	return typeof c.get("clerkAuth") === "function";
}

/**
 * 書き込みを許可する Clerk のトークン種別。
 *
 * `clerkMiddleware()` は `acceptsToken: "any"` で認証するため、ブラウザの
 * セッション以外（OAuth トークン / API キー / M2M トークン）でも auth
 * オブジェクトが返る。しかも OAuth トークンと API キーは `userId` を持つ
 * （`oauth_token` は常に、`api_key` は `subject` が `user_` 始まりのとき）。
 *
 * この API はトークンのスコープを一切見ていないので、`userId` の有無だけで
 * 通すと「プロフィール読み取りだけ」のつもりで許可されたサードパーティの
 * OAuth トークンで Issue を作成・改変・削除できてしまう。
 * 加えてこれらは Bearer ヘッダで来るため `requireAllowedOrigin` の Origin
 * 検証も免除され、ここが唯一の関門になる。
 *
 * そのため現状はセッショントークンだけを受け入れる。将来 API クライアント
 * 向けにマシントークンを受け入れるなら、種別ごとに許可する操作とスコープを
 * 明示的にマッピングしたうえでここを広げること。
 *
 * `@hono/clerk-auth@3.1.0` では `acceptsToken` が `clerkMiddleware` に
 * ハードコードされていて外から絞れない（型でも `Omit` で除外されている）ため、
 * 入口ではなくこの認可側で弾いている。`getAuth(c, { acceptsToken })` も効かない。
 * 型の上では受け付けるが、ミドルウェアが `c.set` するクロージャは渡された
 * options を `toAuth()` にしか流さず、`acceptsToken` は "any" で上書きされる。
 */
const ALLOWED_TOKEN_TYPE = "session_token";

export async function requireAuth(c: Context, next: Next) {
	// Clerk が初期化されていない状態で `getAuth` を呼ぶと TypeError になるため、
	// トークン種別を見る前にコンテキストの有無を確認する（順序を入れ替えないこと）
	const auth = hasClerkAuth(c) ? getAuth(c) : undefined;
	// `userId` の検査は冗長に見えるが外せない。未認証時に返る
	// `signedOutAuthObject()` も `tokenType` は "session_token" で、
	// 違いは `userId` が null であることだけ。両方を見る必要がある。
	if (auth?.tokenType !== ALLOWED_TOKEN_TYPE || !auth.userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
}
