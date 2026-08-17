import { describe, expect, it, vi } from "vitest";
import {
	CLERK_USER_LIST_CHUNK_SIZE,
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
});
