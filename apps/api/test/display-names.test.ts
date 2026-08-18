import { describe, expect, it, vi } from "vitest";
import {
	CLERK_USER_LIST_CHUNK_SIZE,
	DISPLAY_NAME_CACHE_KEY_PREFIX,
	DISPLAY_NAME_CACHE_TTL_SECONDS,
	fetchDisplayNames,
	toDisplayName,
	type UserListClient,
} from "../src/lib/display-names";

/**
 * 表示名の取得（#108）を、ルート経由ではなく直接確かめるテスト。
 *
 * `help-offers.test.ts` は実際の一覧を通して見ているが、そちらは表明者が
 * 数人しかいないので、100 件ごとの分割のような「人数が増えて初めて効く」
 * 経路には一度も入らない。分割は方針として明示的に要求されている
 * （1 人ずつ問い合わせるとレート制限に触れる）ので、ここで直接見る。
 */

type Call = { userId: string[]; limit: number };

/**
 * 呼び出しを記録するだけの Clerk クライアント。
 *
 * `users` に渡した ID のうち存在することにするものを `known` で決める。
 * 実物と同じく、知らない ID は返さない。
 */
function stubClient(
	known: string[] = [],
	options: { failAfter?: number } = {},
): { client: UserListClient; calls: Call[] } {
	const calls: Call[] = [];
	const knownIds = new Set(known);

	const client: UserListClient = {
		users: {
			getUserList: async ({ userId, limit }) => {
				calls.push({ userId: [...userId], limit });

				if (
					options.failAfter !== undefined &&
					calls.length > options.failAfter
				) {
					throw new Error("Clerk is down");
				}

				return {
					data: userId
						.filter((id) => knownIds.has(id))
						.map((id) => ({
							id,
							firstName: `name-${id}`,
							lastName: null,
							username: null,
						})),
				};
			},
		},
	};

	return { client, calls };
}

function userIds(count: number, prefix = "user_"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** KV のキー。実装（`cacheKey`）と同じ組み立てを、テスト側からも見えるように再現する。 */
function cacheKey(userId: string): string {
	return `${DISPLAY_NAME_CACHE_KEY_PREFIX}${userId}`;
}

type Put = { key: string; value: string; ttl: number | undefined };

/**
 * `KVNamespace` の代役。表示名キャッシュ（#135）の検証に必要な `get` / `put` /
 * `delete` だけを持つ。書き込みは `puts` に記録し、TTL の指定まで見られるようにする。
 *
 * miniflare の実 KV ではなくこのスタブを使うのは、キャッシュヒット時に Clerk へ
 * 問い合わせが飛ばないこと・失敗時にキャッシュへ焼き付けないことを、
 * 往復回数まで含めて決定的に確かめたいため（実 KV でも動くが観測点が減る）。
 */
function fakeCache(initial: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initial));
	const puts: Put[] = [];

	const cache = {
		get: async (key: string): Promise<string | null> =>
			store.has(key) ? (store.get(key) as string) : null,
		put: async (
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		): Promise<void> => {
			store.set(key, value);
			puts.push({ key, value, ttl: options?.expirationTtl });
		},
		delete: async (key: string): Promise<void> => {
			store.delete(key);
		},
	} as unknown as KVNamespace;

	return { cache, store, puts };
}

/**
 * 渡された ID を記録し、`users` に含まれる ID だけをそのプロパティどおりに返す
 * Clerk クライアント。名前が無いユーザー（`firstName` 等がすべて null）も表現できる。
 * `stubClient` は必ず `firstName` に値を入れてしまうので、ネガティブキャッシュの
 * 検証にはこちらを使う。
 */
function usersClient(
	users: {
		id: string;
		firstName?: string | null;
		lastName?: string | null;
		username?: string | null;
	}[],
): { client: UserListClient; calls: string[][] } {
	const calls: string[][] = [];
	const byId = new Map(users.map((u) => [u.id, u]));

	const client: UserListClient = {
		users: {
			getUserList: async ({ userId }) => {
				calls.push([...userId]);
				return {
					data: userId
						.filter((id) => byId.has(id))
						.map((id) => {
							const u = byId.get(id) as (typeof users)[number];
							return {
								id,
								firstName: u.firstName ?? null,
								lastName: u.lastName ?? null,
								username: u.username ?? null,
							};
						}),
				};
			},
		},
	};

	return { client, calls };
}

describe("toDisplayName", () => {
	it("姓名を繋げて返す", () => {
		expect(
			toDisplayName({
				id: "user_1",
				firstName: "花子",
				lastName: "山田",
				username: "hanako",
			}),
		).toBe("花子 山田");
	});

	it("片方だけでも返す", () => {
		expect(
			toDisplayName({
				id: "user_1",
				firstName: "花子",
				lastName: null,
				username: null,
			}),
		).toBe("花子");
		expect(
			toDisplayName({
				id: "user_1",
				firstName: null,
				lastName: "山田",
				username: null,
			}),
		).toBe("山田");
	});

	it("姓名が無ければ username を使う", () => {
		expect(
			toDisplayName({
				id: "user_1",
				firstName: null,
				lastName: null,
				username: "hanako",
			}),
		).toBe("hanako");
	});

	// Clerk は表示名を必須にしていない。ここで ID にフォールバックすると
	// #108 で消したかった「ID の断片」の表示が復活する。
	it("何も無ければ null", () => {
		expect(
			toDisplayName({
				id: "user_1",
				firstName: null,
				lastName: null,
				username: null,
			}),
		).toBeNull();
	});

	// 空白だけの名前は「設定されている」とは扱わない（画面に空欄が並ぶため）
	it("空白だけの値は名前として扱わない", () => {
		expect(
			toDisplayName({
				id: "user_1",
				firstName: "  ",
				lastName: "",
				username: " ",
			}),
		).toBeNull();
	});
});

describe("fetchDisplayNames", () => {
	it("引けた表示名を User ID から引ける Map で返す", async () => {
		const { client } = stubClient(["user_0", "user_1"]);

		const names = await fetchDisplayNames("sk_test", ["user_0", "user_1"], {
			client,
		});

		expect(names.get("user_0")).toBe("name-user_0");
		expect(names.get("user_1")).toBe("name-user_1");
	});

	it("Clerk が知らない ID は載せない", async () => {
		const { client } = stubClient(["user_0"]);

		const names = await fetchDisplayNames("sk_test", ["user_0", "user_1"], {
			client,
		});

		expect(names.has("user_1")).toBe(false);
		expect(names.size).toBe(1);
	});

	it("ID が無ければ問い合わせない", async () => {
		const { client, calls } = stubClient();

		const names = await fetchDisplayNames("sk_test", [], { client });

		expect(names.size).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("重複した ID は 1 回だけ送る", async () => {
		const { client, calls } = stubClient(["user_0"]);

		await fetchDisplayNames("sk_test", ["user_0", "user_0", "user_0"], {
			client,
		});

		expect(calls.map((call) => call.userId)).toEqual([["user_0"]]);
	});

	// 方針 1。表明の一覧はページングが無く全件返すので、100 件を超えることは
	// 起こりうる。1 人ずつ問い合わせる形にすると本番のレート制限
	// （1000 リクエスト / 10 秒）にすぐ触れる。
	describe("まとめ方", () => {
		// 定数をリテラルで固定する。この 100 は Clerk 側が決めている
		// `userId` フィルタの上限で、こちらの都合で動かせる値ではない。
		//
		// 以下の分割のテストはどれも `CLERK_USER_LIST_CHUNK_SIZE` を基準に
		// 件数を作るので、定数を書き換えられても「その値どおりに分割している」
		// としか言えず、値が実際の上限と合っているかは見ていない。
		// 上限を超えて送ると Clerk 側が弾き、表示名が丸ごと出なくなる。
		it("Clerk の上限（100）に合わせてある", () => {
			expect(CLERK_USER_LIST_CHUNK_SIZE).toBe(100);
		});

		it("上限ちょうどなら 1 回で送る", async () => {
			const ids = userIds(CLERK_USER_LIST_CHUNK_SIZE);
			const { client, calls } = stubClient(ids);

			await fetchDisplayNames("sk_test", ids, { client });

			expect(calls.map((call) => call.userId.length)).toEqual([
				CLERK_USER_LIST_CHUNK_SIZE,
			]);
		});

		it("上限を超えたら上限ごとに分割する", async () => {
			const ids = userIds(CLERK_USER_LIST_CHUNK_SIZE + 1);
			const { client, calls } = stubClient(ids);

			const names = await fetchDisplayNames("sk_test", ids, { client });

			// 1 人ずつでも、まとめて 1 回でもなく、上限ごとに分かれること
			expect(calls.map((call) => call.userId.length)).toEqual([
				CLERK_USER_LIST_CHUNK_SIZE,
				1,
			]);
			// 分割しても全員分の名前が揃う（境界で取りこぼさない）
			expect(names.size).toBe(ids.length);
		});

		it("3 チャンクに跨っても全員分を返す", async () => {
			const ids = userIds(CLERK_USER_LIST_CHUNK_SIZE * 2 + 5);
			const { client, calls } = stubClient(ids);

			const names = await fetchDisplayNames("sk_test", ids, { client });

			expect(calls.map((call) => call.userId.length)).toEqual([
				CLERK_USER_LIST_CHUNK_SIZE,
				CLERK_USER_LIST_CHUNK_SIZE,
				5,
			]);
			expect(names.size).toBe(ids.length);
		});

		// `limit` を省くと Clerk は既定で先頭 10 件しか返さない
		// （`@clerk/backend` の Deserializer の説明）。11 人目以降の表示名が
		// 黙って落ちるので、送った ID の数を必ず渡す。
		it("送った ID の数を limit に渡す", async () => {
			const ids = userIds(CLERK_USER_LIST_CHUNK_SIZE + 3);
			const { client, calls } = stubClient(ids);

			await fetchDisplayNames("sk_test", ids, { client });

			for (const call of calls) {
				expect(call.limit).toBe(call.userId.length);
			}
		});
	});

	// 方針 2（最重要）。表示名は「あると嬉しい」情報でしかない。
	describe("失敗したとき", () => {
		it("問い合わせが失敗しても throw せず、空の Map を返す", async () => {
			const { client } = stubClient([], { failAfter: 0 });

			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				const names = await fetchDisplayNames("sk_test", ["user_0"], {
					client,
				});

				expect(names.size).toBe(0);
				// 失敗を黙って捨てていないこと
				expect(consoleError).toHaveBeenCalled();
			} finally {
				consoleError.mockRestore();
			}
		});

		// 1 チャンクの失敗で 100 人分の名前をまとめて捨てない
		it("一部のチャンクが失敗しても、成功した分は返す", async () => {
			const ids = userIds(CLERK_USER_LIST_CHUNK_SIZE + 1);
			const { client } = stubClient(ids, { failAfter: 1 });

			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				const names = await fetchDisplayNames("sk_test", ids, { client });

				expect(names.size).toBe(CLERK_USER_LIST_CHUNK_SIZE);
				expect(names.get("user_0")).toBe("name-user_0");
			} finally {
				consoleError.mockRestore();
			}
		});

		it("シークレットキーが無ければ問い合わせずに空を返す", async () => {
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				const names = await fetchDisplayNames(undefined, ["user_0"]);

				expect(names.size).toBe(0);
				expect(consoleError).toHaveBeenCalled();
			} finally {
				consoleError.mockRestore();
			}
		});
	});

	// #135。無認証で叩ける公開エンドポイントが表示名のたびに Clerk を叩くと、
	// 連打でレート制限を使い切り、認証まで巻き添えにできる。KV に載せて、
	// 同じ表明者への問い合わせが繰り返されないようにする。
	describe("KV キャッシュ", () => {
		it("キャッシュにあれば Clerk に問い合わせず、そこから返す", async () => {
			const { cache } = fakeCache({ [cacheKey("user_0")]: "花子 山田" });
			const { client, calls } = usersClient([
				{ id: "user_0", firstName: "別の名前" },
			]);

			const names = await fetchDisplayNames("sk_test", ["user_0"], {
				client,
				cache,
			});

			// キャッシュの値がそのまま返る（Clerk の値は使わない）
			expect(names.get("user_0")).toBe("花子 山田");
			// 増幅の本体。ここが 0 であることが「連打しても Clerk に届かない」根拠
			expect(calls).toHaveLength(0);
		});

		it("引けた表示名を TTL 付きでキャッシュに書く", async () => {
			const { cache, store, puts } = fakeCache();
			const { client } = usersClient([{ id: "user_0", firstName: "花子" }]);

			const names = await fetchDisplayNames("sk_test", ["user_0"], {
				client,
				cache,
			});

			expect(names.get("user_0")).toBe("花子");
			expect(store.get(cacheKey("user_0"))).toBe("花子");
			// 失効させずに焼き付けると、名前を変えても古い表示が残り続ける
			expect(puts).toHaveLength(1);
			expect(puts[0]?.ttl).toBe(DISPLAY_NAME_CACHE_TTL_SECONDS);
		});

		// 名前を設定していないユーザーばかりの Issue を連打されても Clerk を叩かない
		// ように、「名前は無い」もキャッシュする（ネガティブキャッシュ）。
		it("名前が無いユーザーもキャッシュし、次は Clerk に問い合わせない", async () => {
			const { cache, store } = fakeCache();
			// Clerk には存在するが表示名がひとつも無いユーザー
			const { client, calls } = usersClient([{ id: "user_0" }]);

			const first = await fetchDisplayNames("sk_test", ["user_0"], {
				client,
				cache,
			});
			expect(first.has("user_0")).toBe(false);
			// 「解決済みだが名前は無い」の印（空文字列）が載っていること
			expect(store.get(cacheKey("user_0"))).toBe("");

			const second = await fetchDisplayNames("sk_test", ["user_0"], {
				client,
				cache,
			});
			expect(second.has("user_0")).toBe(false);
			// 2 回目はキャッシュで解決し、Clerk に届いていない
			expect(calls).toHaveLength(1);
		});

		// Clerk が知らない ID（削除済み等）も同じ理由でネガティブキャッシュする。
		it("Clerk が返さない ID もネガティブキャッシュする", async () => {
			const { cache, store } = fakeCache();
			const { client, calls } = usersClient([]); // 誰も知らない

			await fetchDisplayNames("sk_test", ["user_0"], { client, cache });

			expect(store.get(cacheKey("user_0"))).toBe("");

			await fetchDisplayNames("sk_test", ["user_0"], { client, cache });
			expect(calls).toHaveLength(1);
		});

		// 最重要。障害を「名前なし」として焼き付けると、TTL の間ずっと名前が
		// 出なくなる。失敗したチャンクはキャッシュに載せず、次回リトライできること。
		it("Clerk の問い合わせが失敗したらキャッシュに書かない", async () => {
			const { cache, store } = fakeCache();
			const failing: UserListClient = {
				users: {
					getUserList: async () => {
						throw new Error("Clerk is down");
					},
				},
			};

			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				const names = await fetchDisplayNames("sk_test", ["user_0"], {
					client: failing,
					cache,
				});

				expect(names.size).toBe(0);
				// 障害を焼き付けていないこと。次に Clerk が復活すれば引き直せる
				expect(store.size).toBe(0);
				expect(consoleError).toHaveBeenCalled();
			} finally {
				consoleError.mockRestore();
			}
		});

		it("一部だけキャッシュにあるなら、足りない分だけ Clerk に問い合わせる", async () => {
			const { cache } = fakeCache({ [cacheKey("user_0")]: "既存の名前" });
			const { client, calls } = usersClient([
				{ id: "user_1", firstName: "新しい名前" },
			]);

			const names = await fetchDisplayNames("sk_test", ["user_0", "user_1"], {
				client,
				cache,
			});

			expect(names.get("user_0")).toBe("既存の名前");
			expect(names.get("user_1")).toBe("新しい名前");
			// ミスした user_1 だけを問い合わせている（user_0 は投げていない）
			expect(calls).toEqual([["user_1"]]);
		});

		// キャッシュが読めない/書けないことで一覧が落ちてはいけない。
		// Clerk へフォールバックして、表示名そのものは返ること。
		it("KV が壊れていても Clerk へフォールバックして返す", async () => {
			const brokenCache = {
				get: async () => {
					throw new Error("KV get failed");
				},
				put: async () => {
					throw new Error("KV put failed");
				},
			} as unknown as KVNamespace;
			const { client, calls } = usersClient([
				{ id: "user_0", firstName: "花子" },
			]);

			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				const names = await fetchDisplayNames("sk_test", ["user_0"], {
					client,
					cache: brokenCache,
				});

				expect(names.get("user_0")).toBe("花子");
				// 読めなかったので Clerk に回している
				expect(calls).toHaveLength(1);
				expect(consoleError).toHaveBeenCalled();
			} finally {
				consoleError.mockRestore();
			}
		});
	});
});
