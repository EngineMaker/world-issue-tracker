import { createClerkClient } from "@clerk/backend";

/**
 * Clerk のユーザーから表示名を引く仕組み（#108）。
 *
 * 「手伝います」の表明者を画面に出すために使う。それまで画面は Clerk の
 * User ID の先頭 8 文字を並べていたが、人に見せる情報として意味を持たなかった。
 *
 * このリポジトリで Worker のランタイムから外部 HTTP を叩く最初の場所になる。
 * そのため「取れなかったとき何が起きるか」を、取れたときと同じくらい
 * 明示的に決めてある（`fetchDisplayNames` の戻り値の説明を参照）。
 *
 * キャッシュ層は入れていない（#108 では任意とされている）。ただし呼び出し元の
 * `GET /issues/:id/help-offers` は無認証で叩ける公開エンドポイントなので、
 * 同じ Issue を連打されるとその回数だけ Clerk への問い合わせが増える。
 * Clerk のレート制限を使い切ると、表示名だけでなく認証（JWKS の取得）まで
 * 巻き添えになりうる。表示名を KV にキャッシュすると、この増幅と
 * 一覧のレイテンシの両方が同時に収まる。人数や閲覧数が増えたら足すこと。
 */

/**
 * `getUserList` が 1 回で受け取れる `userId` の件数。
 *
 * Clerk のドキュメントが `userId` フィルタの上限を 100 としている
 * （`limit` 自体の上限は 500 だが、ID 指定はこちらに縛られる）。
 * 表明の一覧はページングが無く全件返すので、これを超える場合は分割する。
 * 1 人ずつ問い合わせる形にはしない（レート制限は本番インスタンスで
 * 1000 リクエスト / 10 秒しかなく、人数分の往復はすぐ上限に触れる）。
 */
export const CLERK_USER_LIST_CHUNK_SIZE = 100;

/**
 * `fetchDisplayNames` が読む Clerk のユーザー表現。
 *
 * 実物の `User` そのままではなく、必要な 4 つのプロパティだけを要求する形に
 * している。ここで読む以上のものを受け取らないことを型で示すため
 * （表示名以外の内部情報をうっかり呼び出し側へ流さない）。
 */
type ClerkUserLike = {
	id: string;
	firstName: string | null;
	lastName: string | null;
	username: string | null;
};

/**
 * ユーザー 1 人分の表示名を組み立てる。名前が一つも無ければ null。
 *
 * Clerk は表示名を必須にしていない。`first_name` / `last_name` / `username` が
 * すべて空のアカウントは普通に存在するので、その場合は「名前が無い」ことを
 * null で表し、画面側の文言（`helpOffer.unnamedOfferer`）に委ねる。
 * ここで ID にフォールバックしないのは、それが #108 で消したかった表示だから。
 *
 * メールアドレスは使わない。表明者は Issue を見る誰にでも見えるので、
 * 本人が表示名として設定していない連絡先を公開することになる。
 */
export function toDisplayName(user: ClerkUserLike): string | null {
	const fullName = [user.firstName, user.lastName]
		.filter((part): part is string => part !== null && part.trim() !== "")
		.join(" ");

	if (fullName !== "") {
		return fullName;
	}
	const username = user.username?.trim();
	return username ? username : null;
}

/** 配列を `size` 件ずつに切り分ける。 */
function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/**
 * Clerk クライアントのうち、この機能が使う部分。
 *
 * テストから差し替えるために型で切り出している。実物の `createClerkClient()`
 * の戻り値はこれを満たす。
 */
export type UserListClient = {
	users: {
		getUserList: (params: {
			userId: string[];
			limit: number;
		}) => Promise<{ data: ClerkUserLike[] }>;
	};
};

export type FetchDisplayNamesOptions = {
	/** テストから差し替えるための Clerk クライアント。通常は省略する。 */
	client?: UserListClient;
};

/**
 * User ID の一覧に対応する表示名を、まとめて引く。
 *
 * **失敗しても throw しない。** 引けなかった ID は結果の Map に載らないだけで、
 * 呼び出し側は「表示名が無い人」と同じ扱いをすればよい。
 *
 * これは意図した設計で、表示名は「あると嬉しい」情報でしかない。Clerk が
 * 落ちている / キーが設定されていない / レート制限に触れた、といった理由で
 * 困りごとの画面そのものが見えなくなるのは本末転倒なので、外部 API は
 * 落ちるものとして扱う。失敗は握り潰さずログには必ず残す。
 *
 * 分割した問い合わせのうち一部だけが失敗した場合は、成功した分の表示名は
 * そのまま返す（全部捨てると、1 チャンクの失敗で 100 人分の名前が消える）。
 */
export async function fetchDisplayNames(
	secretKey: string | undefined,
	userIds: string[],
	{ client }: FetchDisplayNamesOptions = {},
): Promise<Map<string, string>> {
	const names = new Map<string, string>();

	// 重複した ID を送らない。同じ人が複数の表明を持つことは現状の
	// UNIQUE 制約では起きないが、呼び出し側の都合に依存させない。
	const uniqueIds = [...new Set(userIds)];
	if (uniqueIds.length === 0) {
		return names;
	}

	// キーが無ければ問い合わせようがない。ここで作ると `createClerkClient` が
	// throw するので、その手前で「表示名なし」に倒す（公開エンドポイントを
	// Secret の設定漏れで落とさない方針は `middleware/clerk.ts` と同じ）。
	if (!client && !secretKey) {
		console.error("CLERK_SECRET_KEY is not set; skipping display name lookup");
		return names;
	}

	let clerk: UserListClient;
	try {
		clerk = client ?? createClerkClient({ secretKey });
	} catch (err) {
		console.error("Failed to create Clerk client for display names", err);
		return names;
	}

	// チャンクは順に処理する。並列にすると人数が多いときに一気に
	// リクエストを撃つことになり、レート制限（1000 req / 10 秒）に近づく。
	// 表明の一覧は数十件の想定なので、実際には 1 チャンクで済むことがほとんど。
	//
	// なお `getUserList` は 1 回の呼び出しで Clerk へ HTTP を 2 本出す
	// （`GET /users` と、使わない `totalCount` のための `GET /users/count`。
	// `@clerk/backend@2.33.0` の `UserApi.getUserList` がそう実装している）。
	// レート制限の見積もりはこの 2 倍で考えること。
	for (const ids of chunk(uniqueIds, CLERK_USER_LIST_CHUNK_SIZE)) {
		try {
			const { data } = await clerk.users.getUserList({
				userId: ids,
				limit: ids.length,
			});

			for (const user of data) {
				const displayName = toDisplayName(user);
				if (displayName) {
					names.set(user.id, displayName);
				}
			}
		} catch (err) {
			// このチャンクだけを諦める。残りは引き続き試す。
			console.error("Failed to fetch display names from Clerk", err);
		}
	}

	return names;
}
