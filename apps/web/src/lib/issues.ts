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

/**
 * この module が使う範囲だけを表した `fetch` の型。
 *
 * `typeof globalThis.fetch` にしてはいけない。テストは `apps/api` の
 * vitest から動く（web にテストランナーが無いため）が、api の
 * `tsconfig.json` は `types: ["@cloudflare/workers-types"]` を指定していて、
 * そこでは `globalThis.fetch` と `RequestInit` が Workers 版に差し替わる。
 * Workers の `RequestInit` に `cache` は無いため、web 単体では通る
 * `{ cache: "no-store" }` が api 側の `tsc --noEmit` でだけ型エラーになる。
 *
 * 実行環境（ブラウザ / Node / Workers）ではなく、この module が
 * 呼び出す形そのものを型にすることで、どちらの型検査でも同じ意味になる。
 */
type FetchLike = (
	url: string,
	init: { cache: "no-store" },
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

/**
 * 実行環境の `fetch`。差し替えない場合の既定値。
 *
 * `const defaultFetch = globalThis.fetch` と書いて module のロード時に
 * 束縛してはいけない。`apps/web/test/page.test.tsx` は Server Component を
 * 描画する前に `globalThis.fetch` を差し替えるが、束縛済みだとその差し替えが
 * 届かず、テストが実物の API へ通信しに行ってしまう。
 * 呼ぶ瞬間に読むことで、差し替えが効く。
 *
 * キャストしているのは、上の `FetchLike` の理由と同じく
 * `globalThis.fetch` の型が型検査する側の設定に左右されるため。
 * 実行時に動くのはブラウザまたは Node（Next.js の Server Component）の
 * `fetch` で、どちらも `cache` を受け付けるため挙動は変わらない。
 */
const defaultFetch: FetchLike = (url, init) =>
	(globalThis.fetch as unknown as FetchLike)(url, init);

type FetchIssuesOptions = {
	/** 取得件数。API 側の上限は 100。 */
	limit?: number;
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * API から Issue 一覧を取得する。
 *
 * Server Component から呼ぶことを前提にしている（サーバー間通信なので
 * ブラウザの CORS を経由しない）。
 */
export async function fetchIssues({
	limit = 20,
	fetchImpl = defaultFetch,
}: FetchIssuesOptions = {}): Promise<FetchIssuesResult> {
	const url = `${resolveApiBaseUrl()}/issues?limit=${limit}`;

	try {
		// 投稿された Issue が次のアクセスで見えるよう、キャッシュしない
		const res = await fetchImpl(url, { cache: "no-store" });

		if (!res.ok) {
			return { ok: false, error: `API が ${res.status} を返しました` };
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
		console.error("GET /issues に失敗", err);
		return { ok: false, error: "API に接続できませんでした" };
	}
}

/**
 * Issue 1 件の取得結果。
 *
 * 一覧（`FetchIssuesResult`）と違い、失敗を `notFound` で二分している。
 * 「その ID の Issue は存在しない」と「取得できなかった」は利用者が取るべき
 * 行動が違う（URL を疑う / 時間をおく）ため、呼び出し側で描き分けられるようにする。
 * 一時的な障害を 404 として扱うと、実在する Issue に対して
 * 「存在しません」と嘘の断定を出してしまう。
 */
export type FetchIssueResult =
	| { ok: true; issue: PublicIssue }
	| { ok: false; notFound: true }
	| { ok: false; notFound: false; error: string };

type FetchIssueOptions = {
	/** テストから差し替えるための `fetch`。通常は省略する。 */
	fetchImpl?: FetchLike;
};

/**
 * API から Issue を 1 件取得する。
 *
 * `fetchIssues` と同じく Server Component から呼ぶ前提で、失敗しても
 * throw せず値で返す。
 */
export async function fetchIssue(
	id: string,
	{ fetchImpl = defaultFetch }: FetchIssueOptions = {},
): Promise<FetchIssueResult> {
	// ID はパスセグメントに入るため、必ずエンコードする。
	// `..` やスラッシュを含む値をそのまま連結すると、別のエンドポイントを
	// 叩かせられる（`/issues/../health` が `/health` に潰れる）
	const url = `${resolveApiBaseUrl()}/issues/${encodeURIComponent(id)}`;

	try {
		// 起票直後や更新直後に開いても最新が見えるよう、キャッシュしない
		const res = await fetchImpl(url, { cache: "no-store" });

		if (res.status === 404) {
			return { ok: false, notFound: true };
		}
		if (!res.ok) {
			return {
				ok: false,
				notFound: false,
				error: `API が ${res.status} を返しました`,
			};
		}

		const issue = parsePublicIssue(await res.json());
		if (!issue) {
			return {
				ok: false,
				notFound: false,
				error: "API のレスポンス形式が想定と異なります",
			};
		}

		return { ok: true, issue };
	} catch (err) {
		console.error(`GET /issues/${id} に失敗`, err);
		return {
			ok: false,
			notFound: false,
			error: "API に接続できませんでした",
		};
	}
}
