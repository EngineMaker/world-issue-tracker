import type {
	IssueScope as IssueScopeType,
	IssueStatus as IssueStatusType,
} from "@world-issue-tracker/shared";
import { IssueScope, IssueStatus } from "@world-issue-tracker/shared";

/**
 * 公開 GET が返す Issue 1 件の形。
 *
 * API 側の `PUBLIC_ISSUE_COLUMNS`（`apps/api/src/routes/issues.ts`）に対応する。
 * `user_id` のような内部フィールドは公開レスポンスに含まれないため、ここにも無い。
 */
export type PublicIssue = {
	/** `TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))` なので文字列。 */
	id: string;
	title: string;
	description: string;
	scope: IssueScopeType;
	status: IssueStatusType;
	latitude: number;
	longitude: number;
	category: string | null;
	created_at: string;
	updated_at: string;
};

const SCOPES: readonly string[] = IssueScope.options;
const STATUSES: readonly string[] = IssueStatus.options;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * `unknown` を `PublicIssue` として検証する。合わなければ null。
 *
 * API とはネットワーク越しなので、型注釈だけでは形を保証できない。
 * 想定外の値（デプロイのズレ、プロキシの差し込み）が描画まで届かないよう、
 * 受け取った直後にここで弾く。
 */
export function parsePublicIssue(value: unknown): PublicIssue | null {
	if (!isRecord(value)) return null;

	const {
		id,
		title,
		description,
		scope,
		status,
		latitude,
		longitude,
		category,
		created_at,
		updated_at,
	} = value;

	if (typeof id !== "string") return null;
	if (typeof title !== "string") return null;
	if (typeof description !== "string") return null;
	if (typeof scope !== "string" || !SCOPES.includes(scope)) return null;
	if (typeof status !== "string" || !STATUSES.includes(status)) return null;
	// `typeof` だけだと NaN / Infinity を通してしまう。地図に渡したときに
	// 壊れるので、有限な数値であることまで確かめる
	if (typeof latitude !== "number" || !Number.isFinite(latitude)) return null;
	if (typeof longitude !== "number" || !Number.isFinite(longitude)) return null;
	if (category !== null && typeof category !== "string") return null;
	if (typeof created_at !== "string") return null;
	if (typeof updated_at !== "string") return null;

	return {
		id,
		title,
		description,
		scope: scope as IssueScopeType,
		status: status as IssueStatusType,
		latitude,
		longitude,
		category,
		created_at,
		updated_at,
	};
}

/** `GET /issues` のレスポンスを検証する。合わなければ null。 */
export function parseListIssuesResponse(
	value: unknown,
): { issues: PublicIssue[]; total: number } | null {
	if (!isRecord(value)) return null;
	if (!Array.isArray(value.data)) return null;
	if (typeof value.total !== "number") return null;

	const issues: PublicIssue[] = [];
	for (const item of value.data) {
		const issue = parsePublicIssue(item);
		// 1 件でも形が違えば全体を失敗にする。一部だけ欠けた一覧を
		// 「これで全部です」という顔で見せない
		if (!issue) return null;
		issues.push(issue);
	}

	return { issues, total: value.total };
}

/**
 * `NEXT_PUBLIC_API_URL` 未設定時の既定値。
 *
 * ローカル開発の API（`bun dev` で起動する wrangler）を指す。本番 URL ではなく
 * ローカルを既定にしているのは、CI やデプロイで環境変数を渡し忘れたときに
 * 「本番 API に繋がって一見動く」よりも「繋がらず失敗が見える」方が設定漏れに
 * 気付けるため。
 *
 * 本番で値を渡す経路は `.github/workflows/deploy.yml` のビルド時の一本だけ。
 * `apps/web/wrangler.jsonc` の `vars` にも同じ値があるが、そちらは届かない
 * （理由は `resolveApiBaseUrl` のコメント）。
 */
const DEFAULT_API_BASE_URL = "http://localhost:8787";

/**
 * API のベース URL を解決する。末尾のスラッシュは取り除く。
 *
 * `process.env.NEXT_PUBLIC_API_URL` は Next.js が **ビルド時に静的置換する**。
 * Client Component だけでなく Server Component のバンドルでも置換され、
 * 生成物からは `process.env` の参照そのものが消える。したがって実行時に
 * Worker の `env` を渡しても読む側が居ない（`wrangler.jsonc` の `vars` が
 * Server Component に届かないのはこのため）。
 *
 * 置換の対象になるのは静的に書かれた参照だけなので、`process.env[key]` の
 * ような動的アクセスにしてはいけない（置換されず undefined になる）。
 *
 * 実行時に読む形へ変えたい場合は `@opennextjs/cloudflare` の
 * `getCloudflareContext().env` を使う。今は必要が無いのでビルド時の一本に絞っている。
 */
export function resolveApiBaseUrl(): string {
	const configured = process.env.NEXT_PUBLIC_API_URL;
	const base = configured?.trim() ? configured.trim() : DEFAULT_API_BASE_URL;
	return base.replace(/\/+$/, "");
}

/**
 * Issue 一覧の取得結果。
 *
 * 取得に失敗しても throw せず、失敗を値として返す。ページ側で
 * 「0 件」と「取得できなかった」を別の表示にし分けられるようにするため。
 */
export type FetchIssuesResult =
	| { ok: true; issues: PublicIssue[]; total: number }
	| { ok: false; error: string };

type FetchIssuesOptions = {
	/** 取得件数。API 側の上限は 100。 */
	limit?: number;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: typeof globalThis.fetch;
};

/**
 * 一覧エンドポイントを叩いて結果を組み立てる。
 * 公開一覧（`/issues`）と自分の一覧（`/issues/mine`）で共有する。
 *
 * `token` があれば `Authorization: Bearer` を付ける。Web と API は別オリジンで
 * Clerk の Cookie が届かないため、認証が要る経路はこのヘッダが唯一の手段になる。
 */
async function fetchIssueList(
	path: string,
	{
		limit,
		token,
		fetchImpl,
	}: { limit: number; token?: string; fetchImpl: typeof globalThis.fetch },
): Promise<FetchIssuesResult & { unauthorized?: boolean }> {
	const url = `${resolveApiBaseUrl()}${path}?limit=${limit}`;

	try {
		// 投稿された Issue が次のアクセスで見えるよう、キャッシュしない
		const res = await fetchImpl(url, {
			cache: "no-store",
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		});

		if (!res.ok) {
			return {
				ok: false,
				error: `API が ${res.status} を返しました`,
				// 401 だけは「サインインし直せば直る」ので呼び出し側に区別させる
				unauthorized: res.status === 401,
			};
		}

		// 想定外の形（プロキシの HTML エラーページ等）でも throw させない
		const parsed = parseListIssuesResponse(await res.json());
		if (!parsed) {
			return { ok: false, error: "API のレスポンス形式が想定と異なります" };
		}

		return { ok: true, issues: parsed.issues, total: parsed.total };
	} catch (err) {
		// API が落ちている / 名前解決できない / JSON として壊れている。
		// 生の例外メッセージ（`fetch failed` など）は画面に出さず、
		// 切り分けに要る情報はサーバーのログに残す
		console.error(`GET ${path} に失敗`, err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/**
 * API から Issue 一覧を取得する。
 *
 * Server Component から呼ぶことを前提にしている（サーバー間通信なので
 * ブラウザの CORS を経由しない）。
 */
export async function fetchIssues({
	limit = 20,
	fetchImpl = globalThis.fetch,
}: FetchIssuesOptions = {}): Promise<FetchIssuesResult> {
	const result = await fetchIssueList("/issues", { limit, fetchImpl });
	// 公開エンドポイントなので `unauthorized` は意味を持たない。
	// 呼び出し側の型に余計な分岐を持ち込まないよう落とす。
	const { unauthorized: _unauthorized, ...rest } = result;
	return rest;
}

/**
 * 自分が起票した Issue の取得結果。
 *
 * 失敗のうち「サインインが必要」だけは、利用者が自分で解消できる。
 * 「時間をおいて再度お試しください」と同じ扱いにすると直しようがないため、
 * `unauthorized` で区別して呼び出し側が案内を変えられるようにする。
 */
export type FetchMyIssuesResult =
	| { ok: true; issues: PublicIssue[]; total: number }
	| { ok: false; error: string; unauthorized: boolean };

type FetchMyIssuesOptions = {
	/**
	 * Clerk のセッショントークン。
	 * 未サインインなら null（`auth().getToken()` がそのまま null を返す）。
	 */
	token: string | null;
	/** 取得件数。API 側の上限は 100。 */
	limit?: number;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: typeof globalThis.fetch;
};

/**
 * API から「自分が起票した Issue」の一覧を取得する（`GET /issues/mine`）。
 *
 * 絞り込みの条件はトークンに紐づく userId ひとつで、こちらから誰の分かを
 * 指定する余地は無い（API 側も同じ）。
 */
export async function fetchMyIssues({
	token,
	limit = 20,
	fetchImpl = globalThis.fetch,
}: FetchMyIssuesOptions): Promise<FetchMyIssuesResult> {
	// トークンが無いなら API を呼んでも 401 が返るだけ。
	// 往復せずにその場で未認証として返す。
	if (!token) {
		return {
			ok: false,
			error: "サインインが必要です",
			unauthorized: true,
		};
	}

	const result = await fetchIssueList("/issues/mine", {
		limit,
		token,
		fetchImpl,
	});
	if (result.ok) {
		return result;
	}
	return {
		ok: false,
		error: result.error,
		unauthorized: result.unauthorized ?? false,
	};
}
