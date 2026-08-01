/**
 * Clerk のモック。
 *
 * `@hono/clerk-auth` 全体を差し替えるのではなく、その内部が使う
 * `@clerk/backend` の `createClerkClient` だけを差し替える。
 *
 * こうすると `clerkMiddleware` の本体（シークレットキーの存在チェック、
 * `c.set("clerkAuth", ...)` への格納、`getAuth` がそこから取り出す流れ）は
 * 実物が動く。`app.use(clerkMiddleware())` を消す・`getAuth` の戻り値の形が
 * 変わる、といった退行がテストに現れる。
 *
 * モックするのはネットワークに出る `authenticateRequest` の一点だけで、
 * その戻り値も実物の `signedInAuthObject` / `signedOutAuthObject` で組み立てる。
 * Clerk 側で AuthObject の形が変わればここが型エラーになる。
 *
 * 注意 1: このモックが `@hono/clerk-auth` の内部 import にまで届くのは、
 * `vitest.config.ts` で `server.deps.inline` に `@hono/clerk-auth` を
 * 指定しているため。指定が無いと外部依存としてバンドル外で解決され、
 * モックが素通りする。
 *
 * 注意 2: 実物の `clerkMiddleware` は `createClerkClient` を呼ぶ「前」に
 * キーの存在を検査して throw する。そこはモックの手前なので、キーが無い環境では
 * 認証を通る全リクエストが 500 になる。テスト用のキーは `vitest.config.ts` で
 * バインドしている。
 */

import {
	signedInAuthObject,
	signedOutAuthObject,
} from "@clerk/backend/internal";
import { vi } from "vitest";

/**
 * `signedInAuthObject` が受け取るセッションクレームの型。
 *
 * 実物のシグネチャから引くことで、Clerk 側で形が変われば
 * ここが型エラーになる（`@clerk/types` を直接の依存にせずに済む）。
 */
type SessionClaims = Parameters<typeof signedInAuthObject>[2];

/**
 * 直近のリクエストで Clerk が資格情報をどこから読もうとしたか。
 *
 * 実物の Clerk は `Authorization: Bearer` があればそれを使い、無ければ
 * Cookie にフォールバックする。この違いは CSRF の成否に直結する
 * （Cookie はブラウザが自動送信するが、Bearer はしない）ため、
 * モックでもリクエストを見て同じ区別を再現し、テストから観測できるようにする。
 */
export type AuthSource = "bearer" | "cookie" | "none";

/**
 * 現在のテストが「誰としてリクエストするか」。
 * `null` なら未認証。テストから `setMockUserId()` で切り替える。
 */
let mockUserId: string | null = null;

let lastAuthSource: AuthSource = "none";

export function setMockUserId(userId: string | null): void {
	mockUserId = userId;
	// 認証経路の記録も一緒に落とす。前のテストの値が残っていると、
	// 「実は一度も呼ばれていない」ケースを取り違える。
	lastAuthSource = "none";
}

export function getLastAuthSource(): AuthSource {
	return lastAuthSource;
}

/** 実物と同じ優先順位で、リクエストがどの経路の資格情報を持つかを判定する。 */
function detectAuthSource(request: Request): AuthSource {
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith("Bearer ")) {
		return "bearer";
	}
	if (request.headers.get("Cookie")) {
		return "cookie";
	}
	return "none";
}

/**
 * トークンの発行時刻（固定値）。
 * 署名検証も有効期限チェックも走らない経路なので、実時刻に依存させない。
 */
const MOCK_ISSUED_AT = 1_700_000_000;

/**
 * 検証済みトークンから取り出されたことになるセッションクレーム。
 *
 * `signedInAuthObject` はこれを解釈して `userId` などを組み立てるので、
 * テストが「誰か」を決めているのは実質この `sub` だけになる。
 * 署名検証は `authenticateRequest` ごと差し替えているため走らない。
 */
function buildSessionClaims(userId: string): SessionClaims {
	// `satisfies` で実物の JwtPayload に縛る。Clerk 側で必須クレームが増減すれば
	// ここがコンパイルエラーになり、モックが実物から乖離したことに気づける。
	return {
		__raw: "mock-session-token",
		sub: userId,
		sid: "sess_mock",
		iss: "https://mock.clerk.accounts.dev",
		nbf: MOCK_ISSUED_AT,
		iat: MOCK_ISSUED_AT,
		exp: MOCK_ISSUED_AT + 3600,
		v: 2,
	} satisfies SessionClaims;
}

/**
 * `authenticateRequest` の戻り値のうち、`clerkMiddleware` が実際に見る部分。
 *
 * `toAuth()` の戻り値まで厳密に書くと `@clerk/types` への参照が
 * 型宣言に漏れて `tsc` が portable でないと言うため、そこは緩く受ける。
 * 形の担保は `buildSessionClaims` の `satisfies` と、
 * 実物の `signedInAuthObject` / `signedOutAuthObject` を通すことで行っている。
 */
type MockRequestState = {
	status: "signed-in" | "signed-out";
	headers: undefined;
	toAuth: () => unknown;
};

/**
 * `vi.mock("@clerk/backend", ...)` に渡すファクトリ。
 *
 * `vi.mock` はファイル先頭に巻き上げられ、import した束縛をまだ参照できない。
 * そのため各テストファイル側では、ファクトリ内で動的 import して呼ぶ形にしている。
 */
export async function clerkBackendMockFactory(): Promise<
	Record<string, unknown>
> {
	const actual =
		await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");

	return {
		...actual,
		createClerkClient: () => ({
			// 実物と同じく Request を受け取る。中身を見ずに握り潰すと、
			// リクエストの内容で認証結果が変わる退行を一切検出できなくなる。
			authenticateRequest: async (
				request: Request,
			): Promise<MockRequestState> => {
				lastAuthSource = detectAuthSource(request);

				return {
					status: mockUserId ? "signed-in" : "signed-out",
					// handshake ではないので追加ヘッダは無い（実物もこの場合 undefined を返す）
					headers: undefined,
					toAuth: () =>
						mockUserId
							? signedInAuthObject(
									{},
									"mock-session-token",
									buildSessionClaims(mockUserId),
								)
							: signedOutAuthObject(),
				};
			},
		}),
	};
}
