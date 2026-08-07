import {
	COMMENT_BODY_MAX_LENGTH,
	CreateCommentSchema,
} from "@world-issue-tracker/shared";
import { API_BASE_URL } from "./api";

/**
 * 公開 GET が返すコメント 1 件の形。
 *
 * API 側の `PUBLIC_COMMENT_COLUMNS`（`apps/api/src/routes/comments.ts`）に対応する。
 * `user_id` のような内部フィールドは公開レスポンスに含まれないため、ここにも無い。
 */
export type PublicComment = {
	id: string;
	issue_id: string;
	body: string;
	created_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * `unknown` を `PublicComment` として検証する。合わなければ null。
 *
 * API とはネットワーク越しなので型注釈だけでは形を保証できない
 * （`lib/issues.ts` の `parsePublicIssue` と同じ方針）。
 */
export function parsePublicComment(value: unknown): PublicComment | null {
	if (!isRecord(value)) return null;

	const { id, issue_id, body, created_at } = value;

	if (typeof id !== "string") return null;
	if (typeof issue_id !== "string") return null;
	if (typeof body !== "string") return null;
	if (typeof created_at !== "string") return null;

	return { id, issue_id, body, created_at };
}

/** `GET /issues/:id/comments` のレスポンスを検証する。合わなければ null。 */
export function parseListCommentsResponse(
	value: unknown,
): { comments: PublicComment[]; total: number } | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.data)) return null;
	if (typeof value.total !== "number") return null;

	const comments: PublicComment[] = [];
	for (const item of value.data) {
		const comment = parsePublicComment(item);
		// 1 件でも形が違えば全体を失敗にする。一部だけ欠けた会話を
		// 「これで全部です」という顔で見せない（一覧と同じ判断）
		if (!comment) return null;
		comments.push(comment);
	}

	return { comments, total: value.total };
}

/**
 * コメント取得の結果。
 *
 * 失敗しても throw せず値として返す。詳細ページ側で「コメント 0 件」と
 * 「取得できなかった」を別の表示にし分けられるようにするため。
 */
export type FetchCommentsResult =
	| { ok: true; comments: PublicComment[]; total: number }
	| { ok: false; error: string };

/** コメント本文の最大長。画面の `maxLength` と文字数表示に使う。 */
export const COMMENT_MAX_LENGTH = COMMENT_BODY_MAX_LENGTH;

/**
 * 投稿前にコメント本文を検証する。
 *
 * 制約は `packages/shared` の `CreateCommentSchema` 一本に寄せており、
 * ここで最大長や空判定を書き直していない。スキーマが変われば追随する。
 *
 * 送信可能なら trim 済みの本文を返す。API 側も同じスキーマで trim するので、
 * ここで整えた値と保存される値は一致する。
 */
export type ValidateCommentResult =
	| { success: true; body: string }
	| { success: false; error: string };

export function validateCommentBody(body: string): ValidateCommentResult {
	const parsed = CreateCommentSchema.safeParse({ body });

	if (parsed.success) {
		return { success: true, body: parsed.data.body };
	}

	// フィールドは `body` ひとつなので、最初のメッセージをそのまま出せば足りる。
	// zod の英語メッセージをそのまま見せると意味が伝わりにくいため、
	// 空・超過という 2 通りの原因を日本語に置き換える
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return { success: false, error: "コメントを入力してください。" };
	}
	return {
		success: false,
		error: `コメントは ${COMMENT_MAX_LENGTH} 文字以内で入力してください（現在 ${trimmed.length} 文字）。`,
	};
}

/** `postComment` が投稿に失敗したときに投げるエラー。 */
export class PostCommentError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "PostCommentError";
		this.status = status;
	}
}

/**
 * API のエラーレスポンスから、利用者に見せるメッセージを組み立てる。
 *
 * `POST /issues/:id/comments` は Zod の `flatten()` した結果か、
 * 文字列の `error` を返す（`apps/api/src/routes/comments.ts`）。
 * 形が違う場合はステータスから定型文にフォールバックする。
 */
function messageFromErrorBody(body: unknown, status: number): string {
	const error = (body as { error?: unknown } | null)?.error;

	if (typeof error === "string") {
		// API が返す文言は英語なので、利用者向けの日本語に置き換える。
		// 想定外の値はそのまま出さず、ステータス由来の定型文に落とす
		if (error === "Issue not found") {
			return "この Issue は見つかりませんでした。削除された可能性があります。";
		}
		if (error === "Unauthorized") {
			return "ログインが必要です。サインインし直してから送信してください。";
		}
		if (error === "Forbidden") {
			return "この操作は許可されていません。";
		}
	}

	if (error && typeof error === "object") {
		const { fieldErrors, formErrors } = error as {
			fieldErrors?: Record<string, string[]>;
			formErrors?: string[];
		};
		const messages = [
			...(formErrors ?? []),
			...Object.values(fieldErrors ?? {}).flat(),
		];
		if (messages.length > 0) {
			return messages.join(" / ");
		}
	}

	if (status === 401) {
		return "ログインが必要です。サインインし直してから送信してください。";
	}
	if (status === 404) {
		return "この Issue は見つかりませんでした。削除された可能性があります。";
	}
	return `コメントの投稿に失敗しました (HTTP ${status})`;
}

/**
 * `postComment` がテストから差し替えを受け付ける `fetch` の型。
 *
 * `typeof globalThis.fetch` にはしていない。この関数を検証するテストは
 * `apps/api/test/node/` にあり（web にテストランナーが無いため）、
 * そちらは Workers の型定義を読み込む。Workers の `fetch` は `input` に
 * `Request<unknown, CfProperties>` まで受ける広い型なので、
 * 素直なモック関数を渡すと引数の反変で型が合わなくなる。
 * ここで実際に使う分（URL 文字列と init）だけに絞っておけば、
 * 本物の `fetch` もモックもどちらも代入できる。
 */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * コメントを投稿する。
 *
 * Web と API は別オリジンなので Clerk のセッション Cookie は届かない。
 * `useAuth().getToken()` で取ったトークンを `Authorization: Bearer` で渡す
 * （`createIssue` と同じ経路。API 側は Bearer があれば Origin 検証を免除する）。
 */
export async function postComment(
	issueId: string,
	body: string,
	token: string | null,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<PublicComment> {
	if (!token) {
		throw new PostCommentError(
			"ログインが必要です。サインインしてから送信してください。",
			401,
		);
	}

	let response: Response;
	try {
		response = await fetchImpl(
			`${API_BASE_URL}/issues/${encodeURIComponent(issueId)}/comments`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ body }),
			},
		);
	} catch {
		// fetch が reject するのは通信そのものが成立しなかった場合
		// （オフライン、DNS 解決失敗、CORS で遮断など）
		throw new PostCommentError(
			"API に接続できませんでした。ネットワーク接続を確認してください。",
			null,
		);
	}

	if (!response.ok) {
		// エラー本文が JSON とは限らない（Workers が返す 5xx など）
		const errorBody = await response.json().catch(() => null);
		throw new PostCommentError(
			messageFromErrorBody(errorBody, response.status),
			response.status,
		);
	}

	const created = parsePublicComment(await response.json().catch(() => null));
	if (!created) {
		// 投稿自体は成功しているが、返ってきた形が想定と違う。
		// 壊れた値を一覧に挿し込むより、再読み込みを促す方が安全
		throw new PostCommentError(
			"投稿はできましたが、応答の形式が想定と異なります。画面を再読み込みしてください。",
			response.status,
		);
	}
	return created;
}
