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

	/**
	 * この投稿者を匿名として扱うか（#67）。
	 *
	 * コメント自体に匿名で投稿する経路は無いが、**匿名で立てられた Issue の
	 * 起票者本人**のコメントだけ真になる。匿名で書いた人が自分の Issue に
	 * 追記した瞬間だけ実名が出ると、その Issue で選んだ匿名が崩れるため。
	 */
	is_anonymous: boolean;

	/**
	 * 投稿者の表示名（#67）。
	 *
	 * API が Clerk Backend API から引いた値。生の `user_id` は返らない。
	 * `null` の意味は `lib/issues.ts` の `PublicIssue.display_name` と同じ。
	 */
	display_name: string | null;

	/**
	 * このコメントを書いたのが閲覧者本人か（#99）。
	 *
	 * 削除ボタンを出す条件。生の `user_id` は公開されないので、画面が
	 * 「自分のコメントか」を知る手段はこの値だけになる。
	 *
	 * トークンを付けずに取得したときは常に false で返る。詳細ページの
	 * サーバー側描画がまさにそれなので、ログイン済みの閲覧者に対しては
	 * `CommentSection` がブラウザ側で取り直す。
	 */
	viewer_is_author: boolean;
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

	const {
		id,
		issue_id,
		body,
		created_at,
		is_anonymous,
		display_name,
		viewer_is_author,
	} = value;

	if (typeof id !== "string") return null;
	if (typeof issue_id !== "string") return null;
	if (typeof body !== "string") return null;
	if (typeof created_at !== "string") return null;

	// `is_anonymous` / `display_name`（#67）は欠けていても弾かない。
	// これらを返さない古い API に対してコメント欄ごと失敗させると、
	// 投稿者名という付加的な情報のために会話そのものが読めなくなる。
	//
	// 倒す先は安全側（匿名）にする。「名乗っている」に倒すと、名乗る
	// つもりのなかった人の名前を出しにいくことになり、取り返しが付かない
	// （`parsePublicIssue` の `is_anonymous` と同じ判断）。
	// 型が違う値は「無い」ではなく形の不一致として弾く。
	if (is_anonymous !== undefined && typeof is_anonymous !== "boolean") {
		return null;
	}
	if (
		display_name !== undefined &&
		display_name !== null &&
		typeof display_name !== "string"
	) {
		return null;
	}

	// `viewer_is_author`（#99）も欠けていても弾かない。理由は上と同じで、
	// 削除ボタンという付加的な機能のために会話が読めなくなってはいけない。
	//
	// 倒す先は false（自分のものではない）。true に倒すと、他人のコメントに
	// 削除ボタンが出る。押しても API が 403 で弾くので消えはしないが、
	// 消せるように見せて失敗させるのは、出さないより悪い。
	if (viewer_is_author !== undefined && typeof viewer_is_author !== "boolean") {
		return null;
	}

	return {
		id,
		issue_id,
		body,
		created_at,
		is_anonymous: is_anonymous ?? true,
		display_name: display_name ?? null,
		viewer_is_author: viewer_is_author ?? false,
	};
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
			return "ログインが必要です。ログインし直してから送信してください。";
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
		return "ログインが必要です。ログインし直してから送信してください。";
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
			"ログインが必要です。ログインしてから送信してください。",
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

/**
 * `deleteComment` が削除に失敗したときに投げるエラー（#99）。
 *
 * `message` は開発者が状況を読めるようにするためのもので、**画面には出さない**。
 * 表示する文言は `status` を見て `CommentSection` が `packages/shared` の
 * 辞書から選ぶ（`PostCommentError` は日本語の `message` をそのまま出しており、
 * そこだけロケールに追随できていない。同じ作りを増やさない）。
 */
export class DeleteCommentError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.name = "DeleteCommentError";
		this.status = status;
	}
}

/**
 * 自分のコメントを削除する（#99）。
 *
 * 消せるのは自分のコメントだけで、他人のものは API が 403 で弾く。画面も
 * `viewer_is_author` が真のコメントにしか削除ボタンを出さないが、
 * 判定を画面だけに置くと、DOM をいじれば誰の分でも呼べてしまう。
 *
 * 投稿と同じく `Authorization: Bearer` でトークンを渡す（別オリジンなので
 * Clerk のセッション Cookie は届かない）。
 *
 * 成功しても返す値は無い。API は 204 を返し、消えたという事実以外に
 * 画面が使う情報が無いため。
 */
export async function deleteComment(
	issueId: string,
	commentId: string,
	token: string | null,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<void> {
	if (!token) {
		throw new DeleteCommentError("トークンが無い（未ログイン）", 401);
	}

	let response: Response;
	try {
		response = await fetchImpl(
			`${API_BASE_URL}/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			},
		);
	} catch {
		// `postComment` と同じく、通信そのものが成立しなかった場合
		throw new DeleteCommentError("API に接続できなかった", null);
	}

	if (!response.ok) {
		throw new DeleteCommentError(
			`API が ${response.status} を返した`,
			response.status,
		);
	}
}

/**
 * 取り直した一覧から「自分のコメントか」だけを手元の一覧へ写す（#99）。
 *
 * 詳細ページ（Server Component）はトークンを渡せないので、最初に描画される
 * 一覧は `viewer_is_author` が全件 false になっている。ブラウザ側で取り直して
 * 埋め直すのだが、そこで一覧を丸ごと差し替えてはいけない。取り直しが返るまでの
 * 間に投稿されたコメントは手元にしか無く、置き換えると書いた直後に消える。
 *
 * 取り直しの目的は削除ボタンの出し分けだけなので、写すのもその 1 項目に限る。
 * 真になったものだけを反映し、false へ戻すことはしない。手元で true なのは
 * 「自分が今このブラウザで投稿した」場合だけで、それが取り直しの結果
 * （投稿が届く前の一覧かもしれない）で覆されるのは正しくない。
 */
export function applyViewerFlags(
	current: PublicComment[],
	fetched: PublicComment[],
): PublicComment[] {
	const authored = new Set(
		fetched.filter((comment) => comment.viewer_is_author).map((c) => c.id),
	);

	return current.map((comment) =>
		!comment.viewer_is_author && authored.has(comment.id)
			? { ...comment, viewer_is_author: true }
			: comment,
	);
}
