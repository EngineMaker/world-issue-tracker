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
	authenticatedMachineObject,
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
 * 現在のテストが「どの種類のトークンでリクエストするか」。
 *
 * 実物の `clerkMiddleware` は `acceptsToken: "any"` で認証するため、
 * ブラウザのセッション以外（OAuth トークン / API キー / M2M トークン）でも
 * auth オブジェクトが返る。種別ごとに `userId` の有無が違い、それが
 * `requireAuth` の判定に直結するため、モックでも区別できるようにしている。
 */
export type MockTokenType = "session_token" | "oauth_token" | "api_key";

/**
 * 現在のテストが「誰としてリクエストするか」。
 * `null` なら未認証。テストから `setMockUserId()` で切り替える。
 */
let mockUserId: string | null = null;

/** 認証済みのとき、どの種別のトークンとして扱うか。 */
let mockTokenType: MockTokenType = "session_token";

let lastAuthSource: AuthSource = "none";

export function setMockUserId(
	userId: string | null,
	tokenType: MockTokenType = "session_token",
): void {
	mockUserId = userId;
	mockTokenType = tokenType;
	// 認証経路の記録も一緒に落とす。前のテストの値が残っていると、
	// 「実は一度も呼ばれていない」ケースを取り違える。
	lastAuthSource = "none";
}

export function getLastAuthSource(): AuthSource {
	return lastAuthSource;
}

/**
 * 表示名の取得（#108）で使う Clerk のユーザー像。
 *
 * 実物の `User` はプロパティが数十個あるが、`toDisplayName` が読むのは
 * この 4 つだけなので、モックもそこに絞る。
 */
export type MockClerkUser = {
	id: string;
	firstName: string | null;
	lastName: string | null;
	username: string | null;
};

/** Clerk 側に存在することにするユーザー。テストから `setMockClerkUsers()` で入れる。 */
let mockClerkUsers: MockClerkUser[] = [];

/** `getUserList` が投げる例外。null なら正常に応答する。 */
let mockUserListError: Error | null = null;

/**
 * `getUserList` が実際に呼ばれたときの引数の記録。
 *
 * 「1 人ずつ問い合わせていないか」「100 件ずつに分割しているか」を
 * テストから確かめるために残す。回数と、各回に渡した ID の数の両方が要る
 * （まとめ方の退行は、結果だけを見ていても現れない）。
 */
let userListCalls: string[][] = [];

export function setMockClerkUsers(users: MockClerkUser[]): void {
	mockClerkUsers = users;
}

/** `getUserList` を必ず失敗させる。Clerk 障害時の挙動を見るために使う。 */
export function setMockUserListError(error: Error | null): void {
	mockUserListError = error;
}

export function getUserListCalls(): string[][] {
	return userListCalls;
}

/** 表示名まわりのモック状態をすべて初期化する。テストの `beforeEach` から呼ぶ。 */
export function resetMockClerkUsers(): void {
	mockClerkUsers = [];
	mockUserListError = null;
	userListCalls = [];
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
 * `authenticatedMachineObject` に渡す検証結果。
 *
 * 実物は `APIKey` / `IdPOAuthAccessToken` クラスのインスタンスを渡すが、
 * `authenticatedMachineObject` が読むのはプロパティだけなので、
 * ここでは同じ形のプレーンオブジェクトを組み立てる。
 * `userId` を決めているのは実質 `subject` で、そこから先の組み立て
 * （`user_` 始まりなら `userId` に入る等）は実物のロジックが動く。
 */
type MachineVerificationResult = Parameters<
	typeof authenticatedMachineObject
>[2];

/**
 * マシントークン（OAuth トークン / API キー）の auth オブジェクトを組み立てる。
 *
 * 実物の Clerk は `acceptsToken: "any"` の下でこれらをそのまま `getAuth(c)` の
 * 戻り値として返す。`subject` がユーザー ID なら `userId` が埋まるため、
 * `userId` の有無しか見ない認可はこれを素通しさせてしまう。
 */
function buildMachineAuthObject(
	tokenType: Exclude<MockTokenType, "session_token">,
	userId: string,
) {
	// 実物のクラスインスタンスの代わりに、読まれるプロパティだけを持つ値を渡す。
	// 型の担保は実物の `authenticatedMachineObject` のシグネチャで行う。
	const verificationResult = {
		id: `${tokenType === "api_key" ? "ak" : "oat"}_mock`,
		subject: userId,
		scopes: ["profile"],
		claims: null,
		name: "mock machine token",
		clientId: "client_mock",
	} as unknown as MachineVerificationResult;

	return authenticatedMachineObject(
		tokenType,
		"mock-machine-token",
		verificationResult,
	);
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
			// 表示名の取得（#108）。実物と同じく `userId` の配列でまとめて引く。
			//
			// 渡された ID を記録してから、`mockClerkUsers` のうち該当するものだけを
			// 返す。存在しない ID を黙って埋めないのは実物と同じ挙動
			// （Clerk は知らないユーザーを返さない）。
			users: {
				getUserList: async ({ userId }: { userId: string[] }) => {
					userListCalls.push([...userId]);

					if (mockUserListError) {
						throw mockUserListError;
					}

					const requested = new Set(userId);
					return {
						data: mockClerkUsers.filter((user) => requested.has(user.id)),
					};
				},
			},
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
					toAuth: () => {
						if (!mockUserId) {
							return signedOutAuthObject();
						}
						if (mockTokenType === "session_token") {
							return signedInAuthObject(
								{},
								"mock-session-token",
								buildSessionClaims(mockUserId),
							);
						}
						return buildMachineAuthObject(mockTokenType, mockUserId);
					},
				};
			},
		}),
	};
}
