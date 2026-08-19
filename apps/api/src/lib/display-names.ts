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
 * 表示名は KV にキャッシュする（#135）。呼び出し元は無認証で叩ける公開
 * エンドポイント（`GET /issues/:id/help-offers`、`GET /issues`、`GET /issues/:id`、
 * `GET /issues/:id/comments`）なので、キャッシュが無いと連打されるだけで、その
 * 回数だけ Clerk への問い合わせが増える。Clerk のレート制限はインスタンス単位で
 * グローバルなため、使い切ると表示名だけでなく認証（JWKS の取得）まで巻き添えに
 * なり、閲覧しかしていない第三者が全ユーザーのログインを止められる。一度引いた
 * 表示名を User ID ごとに KV へ載せることで、同じ人への問い合わせが繰り返され
 * なくなり、この増幅と一覧のレイテンシの両方が同時に収まる（キャッシュの詳細は
 * `DISPLAY_NAME_CACHE_*` を参照）。キャッシュキーは User ID なので、経路をまたいで
 * 同じ人の表示名を共有する。
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
 * KV キャッシュのキーに付ける接頭辞（#135）。
 *
 * `display-name:<Clerk User ID>` の形で載せる。将来この namespace を別用途と
 * 共有しても、キーがぶつからないように名前空間を切っておく。
 */
export const DISPLAY_NAME_CACHE_KEY_PREFIX = "display-name:";

/**
 * 表示名をキャッシュに残す秒数（#135）。
 *
 * 短くすると Clerk 側での表示名の変更が早く反映されるが、増幅を抑える効果は
 * 薄れる。長くすると増幅は抑えられるが、名前を変えても古い表示が残る。
 * 表示名は頻繁には変わらない一方、攻撃の増幅を止めるのが主目的なので、
 * 1 時間に寄せる。KV の `expirationTtl` は最小 60 秒なのでその制約も満たす。
 */
export const DISPLAY_NAME_CACHE_TTL_SECONDS = 3600;

/**
 * 「Clerk に問い合わせたが表示名が無かった」ことを表すキャッシュ値（#135）。
 *
 * 名前が付いているユーザーはその表示名そのもの（非空文字列）を載せる。一方で
 * 「名前を設定していない」「Clerk に存在しない（削除済み等）」ユーザーを
 * キャッシュしないと、そういう表明者ばかりの Issue を連打されたときに毎回
 * Clerk を叩いてしまい、増幅が消えない。空文字列を「解決済みだが名前は無い」
 * の印として載せ、次からは Clerk に問い合わせない（ネガティブキャッシュ）。
 */
const DISPLAY_NAME_CACHE_NONE = "";

/** User ID から KV のキーを作る。 */
function cacheKey(userId: string): string {
	return `${DISPLAY_NAME_CACHE_KEY_PREFIX}${userId}`;
}

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
	/**
	 * 表示名を載せる KV（#135）。省略・未設定なら毎回 Clerk へ問い合わせる
	 * （従来どおり動くが増幅は止まらない）。呼び出し側は `c.env.DISPLAY_NAME_CACHE`
	 * を渡す。バインディングが無い環境（設定漏れ）では `undefined` が渡るため、
	 * ここではオプショナルにして「キャッシュ無しでも成立する」形にしている。
	 */
	cache?: KVNamespace;
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
	{ client, cache }: FetchDisplayNamesOptions = {},
): Promise<Map<string, string>> {
	const names = new Map<string, string>();

	// 重複した ID を送らない。同じ人が複数の表明を持つことは現状の
	// UNIQUE 制約では起きないが、呼び出し側の都合に依存させない。
	const uniqueIds = [...new Set(userIds)];
	if (uniqueIds.length === 0) {
		return names;
	}

	// まず KV を引く（#135）。ここで解決できた ID は Clerk に問い合わせない。
	// これが増幅を止める本体で、同じ Issue を連打されてもキャッシュに載っている
	// 限り Clerk への往復は発生しない。キャッシュに無い ID だけを次の Clerk 問い
	// 合わせに回す。
	const missingIds = await readFromCache(cache, uniqueIds, names);

	// すべてキャッシュで解決できたなら、Clerk クライアントを作る必要も無い。
	// キーの設定漏れやレート制限の影響もここでは受けない。
	if (missingIds.length === 0) {
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
	for (const ids of chunk(missingIds, CLERK_USER_LIST_CHUNK_SIZE)) {
		try {
			const { data } = await clerk.users.getUserList({
				userId: ids,
				limit: ids.length,
			});

			// このチャンクで問い合わせた ID を、いったんすべて「名前なし」に置く。
			// Clerk が返さなかった ID（存在しない・削除済み）も、この後まとめて
			// ネガティブキャッシュに載せるため（載せないと、そういう ID を含む
			// Issue の連打で毎回 Clerk を叩くことになり、増幅が残る）。
			const resolved = new Map<string, string | null>(
				ids.map((id) => [id, null]),
			);
			for (const user of data) {
				resolved.set(user.id, toDisplayName(user));
			}

			for (const [id, displayName] of resolved) {
				if (displayName) {
					names.set(id, displayName);
				}
			}

			// 引けた分だけキャッシュに載せる。失敗した（catch に落ちた）チャンクは
			// ここに来ないので、障害を「名前なし」として焼き付けてしまうことはない
			// （次回リトライできる）。
			await writeToCache(cache, resolved);
		} catch (err) {
			// このチャンクだけを諦める。残りは引き続き試す。
			console.error("Failed to fetch display names from Clerk", err);
		}
	}

	return names;
}

/**
 * KV から表示名を引き、解決できなかった User ID の一覧を返す（#135）。
 *
 * ヒットした ID のうち名前があるものは `names` に載せる。名前が無い印
 * （`DISPLAY_NAME_CACHE_NONE`）だったものは「解決済みだが名前は無い」として
 * 何も載せずに黙って落とす（呼び出し側は Map に無い ID を「名前なし」と
 * 同じ扱いにする）。キャッシュ自体が無い／読めない場合は、全 ID を
 * 「未解決」として返し、従来どおり Clerk へ回す。
 */
async function readFromCache(
	cache: KVNamespace | undefined,
	uniqueIds: string[],
	names: Map<string, string>,
): Promise<string[]> {
	if (!cache) {
		return uniqueIds;
	}

	const missing: string[] = [];
	await Promise.all(
		uniqueIds.map(async (id) => {
			let cached: string | null;
			try {
				cached = await cache.get(cacheKey(id));
			} catch (err) {
				// KV が読めなくても表示名は「あると嬉しい」程度の情報でしかない。
				// Clerk 問い合わせにフォールバックする（増幅は一時的に戻るが、
				// 一覧そのものは返る）。
				console.error("Failed to read display name cache", err);
				missing.push(id);
				return;
			}

			if (cached === null) {
				// キャッシュミス。Clerk に問い合わせる。
				missing.push(id);
			} else if (cached !== DISPLAY_NAME_CACHE_NONE) {
				// ヒット（名前あり）。
				names.set(id, cached);
			}
			// `DISPLAY_NAME_CACHE_NONE` はネガティブヒット。何もしない
			// （Map に載せず、Clerk にも問い合わせない）。
		}),
	);
	return missing;
}

/**
 * Clerk から引けた表示名を KV に載せる（#135）。
 *
 * 名前があるものはその表示名を、無いものはネガティブの印を載せる。どちらも
 * 同じ TTL で失効させる。書き込みに失敗しても throw しない（キャッシュは
 * 最適化であって、無くても一覧は成立する）。
 */
async function writeToCache(
	cache: KVNamespace | undefined,
	resolved: Map<string, string | null>,
): Promise<void> {
	if (!cache) {
		return;
	}

	await Promise.all(
		[...resolved].map(async ([id, displayName]) => {
			try {
				await cache.put(cacheKey(id), displayName ?? DISPLAY_NAME_CACHE_NONE, {
					expirationTtl: DISPLAY_NAME_CACHE_TTL_SECONDS,
				});
			} catch (err) {
				console.error("Failed to write display name cache", err);
			}
		}),
	);
}
